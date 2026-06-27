const CONFIG = window.CHATWAVE_CONFIG || {};
const API_BASE_URL = normalizeBaseUrl(CONFIG.apiBaseUrl || '');
const SOCKET_URL = normalizeBaseUrl(CONFIG.socketUrl || CONFIG.apiBaseUrl || '');

let token = localStorage.getItem('cw_token');
let currentUser = null;
let socket = null;
let currentChat = null;
let contacts = [];
let unread = {};
let typingTimer = null;
let callState = { active: false, peerId: null, callType: null, stream: null, peer: null };
let callDurationInterval = null;
let callSeconds = 0;
let pendingCall = null;
let muted = false;
let toastTimer;
let ringtoneCtx = null;

window.addEventListener('load', async () => {
  if (!token) return;

  try {
    currentUser = await api('GET', '/api/me');
    await initApp();
  } catch {
    localStorage.removeItem('cw_token');
    token = null;
  }
});

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

function assetUrl(url) {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${API_BASE_URL}${url}`;
}

function icon(name, className = 'inline-icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function switchTab(tab) {
  document.getElementById('login-form').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? '' : 'none';
  document.querySelectorAll('.tab-btn').forEach((button, index) => {
    button.classList.toggle('active', (index === 0 && tab === 'login') || (index === 1 && tab === 'register'));
  });
  setAuthError('');
}

async function login() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) return setAuthError('أكمل اسم المستخدم وكلمة المرور.');

  try {
    const res = await api('POST', '/api/login', { username, password });
    token = res.token;
    currentUser = res.user;
    localStorage.setItem('cw_token', token);
    await initApp();
  } catch (e) {
    setAuthError(e.message);
  }
}

async function register() {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!username || !password) return setAuthError('أكمل اسم المستخدم وكلمة المرور.');
  if (username.length < 3) return setAuthError('اسم المستخدم يجب أن يكون 3 أحرف على الأقل.');
  if (password.length < 8) return setAuthError('كلمة المرور يجب أن تكون 8 أحرف على الأقل.');

  try {
    const res = await api('POST', '/api/register', { username, password });
    token = res.token;
    currentUser = res.user;
    localStorage.setItem('cw_token', token);
    await initApp();
  } catch (e) {
    setAuthError(e.message);
  }
}

function setAuthError(msg) {
  document.getElementById('auth-error').textContent = msg || '';
}

async function logout() {
  try {
    if (token) await api('POST', '/api/logout');
  } catch {}
  localStorage.removeItem('cw_token');
  location.reload();
}

async function api(method, path, body) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data = {};
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) throw new Error(data.error || 'تعذر تنفيذ الطلب.');
  return data;
}

async function initApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderCurrentUser();
  connectSocket();
  await loadContacts();
  await loadCalls();
}

function renderCurrentUser() {
  setAvatar('my-avatar-icon', currentUser);
  document.getElementById('my-username-display').textContent = currentUser.username;
  document.getElementById('my-id-display').textContent = `ID: ${currentUser.id}`;
  document.getElementById('welcome-id').textContent = currentUser.id;
}

function connectSocket() {
  if (socket?.connected) return;
  if (typeof io !== 'function') {
    showToast('تعذر تحميل مكتبة الاتصال المباشر.');
    return;
  }

  socket = SOCKET_URL ? io(SOCKET_URL, { auth: { token } }) : io({ auth: { token } });

  socket.on('connect_error', () => {
    showToast('تعذر الاتصال بالخادم المباشر.');
  });

  socket.on('profile_updated', ({ user }) => {
    currentUser = user;
    renderCurrentUser();
  });

  socket.on('contact_updated', ({ user }) => {
    contacts = contacts.map(contact => contact.id === user.id ? { ...contact, ...user } : contact);
    if (currentChat?.id === user.id) {
      currentChat = { ...currentChat, ...user };
      setAvatar('peer-avatar', currentChat);
    }
    renderContactList();
    renderContactsTab();
    loadCalls();
  });

  socket.on('receive_message', msg => {
    if (currentChat && msg.from === currentChat.id) {
      appendMessage(msg, false);
      socket.emit('mark_read', { from: msg.from });
      scrollToBottom();
    } else {
      unread[msg.from] = (unread[msg.from] || 0) + 1;
      renderContactList();
      playNotif();
    }
  });

  socket.on('message_sent', msg => {
    const existing = document.querySelector(`[data-id="${msg.id}"]`);
    if (!existing) {
      appendMessage(msg, true);
      scrollToBottom();
    }
  });

  socket.on('message_error', ({ error }) => showToast(error || 'تعذر إرسال الرسالة.'));

  socket.on('messages_read', ({ by }) => {
    if (currentChat && by === currentChat.id) markAllRead();
  });

  socket.on('user_typing', ({ from }) => {
    if (currentChat && from === currentChat.id) {
      document.getElementById('typing-indicator').style.display = 'flex';
      document.getElementById('peer-status').textContent = 'يكتب الآن...';
    }
  });

  socket.on('user_stop_typing', ({ from }) => {
    if (currentChat && from === currentChat.id) {
      document.getElementById('typing-indicator').style.display = 'none';
      setPeerStatus(currentChat.online);
    }
  });

  socket.on('user_online', ({ userId }) => {
    const contact = contacts.find(item => item.id === userId);
    if (contact) {
      contact.online = true;
      renderContactList();
      renderContactsTab();
    }
    if (currentChat?.id === userId) {
      currentChat.online = true;
      setPeerStatus(true);
    }
  });

  socket.on('user_offline', ({ userId }) => {
    const contact = contacts.find(item => item.id === userId);
    if (contact) {
      contact.online = false;
      renderContactList();
      renderContactsTab();
    }
    if (currentChat?.id === userId) {
      currentChat.online = false;
      setPeerStatus(false);
    }
  });

  socket.on('incoming_call', data => {
    pendingCall = data;
    setAvatar('call-avatar-icon', {
      username: data.callerName,
      avatar: data.callerName?.[0]?.toUpperCase() || '?',
      avatarUrl: data.callerAvatarUrl
    });
    document.getElementById('call-caller-name').textContent = data.callerName;
    document.getElementById('call-type-label').textContent = data.callType === 'video' ? 'مكالمة فيديو' : 'مكالمة صوتية';
    document.getElementById('call-modal').style.display = 'flex';
    playRingtone(true);
  });

  socket.on('call_accepted', ({ by }) => {
    startCallOverlay(by, callState.callType);
    initWebRTC(by, true);
  });

  socket.on('call_rejected', () => {
    showToast('تم رفض المكالمة.');
    resetCallUI();
  });

  socket.on('call_ended', () => {
    showToast('انتهت المكالمة.');
    endCallCleanup();
  });

  socket.on('call_failed', ({ reason }) => {
    showToast(reason || 'تعذرت المكالمة.');
    resetCallUI();
  });

  socket.on('webrtc_offer', async ({ from, offer }) => {
    if (!callState.peer) await initWebRTC(from, false);
    await callState.peer.setRemoteDescription(offer);
    const answer = await callState.peer.createAnswer();
    await callState.peer.setLocalDescription(answer);
    socket.emit('webrtc_answer', { to: from, answer });
  });

  socket.on('webrtc_answer', async ({ answer }) => {
    if (callState.peer) await callState.peer.setRemoteDescription(answer);
  });

  socket.on('webrtc_ice', ({ candidate }) => {
    if (callState.peer) callState.peer.addIceCandidate(candidate).catch(() => {});
  });
}

async function loadContacts() {
  try {
    contacts = await api('GET', '/api/contacts');
    renderContactList();
    renderContactsTab();
  } catch (e) {
    showToast(e.message);
  }
}

function renderContactList() {
  const list = document.getElementById('chats-list');
  if (!contacts.length) {
    list.innerHTML = emptyState('users', 'لا توجد جهات اتصال بعد', 'أضف جهة اتصال باستخدام الرقم التعريفي.');
    return;
  }

  list.innerHTML = contacts.map(contact => {
    const count = unread[contact.id] || 0;
    return `<button class="contact-item ${currentChat?.id === contact.id ? 'active' : ''}" onclick="openChat('${contact.id}')">
      ${avatarDiv(contact, 'contact-avatar')}
      <span class="contact-details">
        <span class="contact-name">${esc(contact.username)} <span class="enc-badge">${icon('shield')} مشفر</span></span>
        <span class="contact-preview">${contact.online ? 'متصل الآن' : 'اضغط لفتح المحادثة'}</span>
      </span>
      <span class="contact-meta">${count > 0 ? `<span class="unread-badge">${count}</span>` : ''}</span>
    </button>`;
  }).join('');
}

function renderContactsTab() {
  const list = document.getElementById('contacts-list');
  if (!contacts.length) {
    list.innerHTML = emptyState('plus', 'القائمة فارغة', 'أضف الأصدقاء عبر أرقامهم التعريفية.');
    return;
  }

  list.innerHTML = contacts.map(contact => `
    <button class="contact-item" onclick="openChat('${contact.id}')">
      ${avatarDiv(contact, 'contact-avatar')}
      <span class="contact-details">
        <span class="contact-name">${esc(contact.username)}</span>
        <span class="contact-preview id-preview">ID: ${contact.id}</span>
      </span>
      <span class="presence ${contact.online ? 'online' : ''}">${contact.online ? 'متصل' : 'غير متصل'}</span>
    </button>
  `).join('');
}

function filterChats(query) {
  const needle = query.trim().toLowerCase();
  document.querySelectorAll('#chats-list .contact-item').forEach(item => {
    const name = item.querySelector('.contact-name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(needle) ? '' : 'none';
  });
}

async function openChat(userId) {
  const contact = contacts.find(item => item.id === userId);
  if (!contact) return;

  currentChat = contact;
  unread[userId] = 0;
  renderContactList();

  document.getElementById('app').classList.add('chat-open');
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('active-chat').style.display = 'flex';
  setAvatar('peer-avatar', contact);
  document.getElementById('peer-name').textContent = contact.username;
  setPeerStatus(contact.online);

  const container = document.getElementById('messages-container');
  container.innerHTML = '';

  try {
    const msgs = await api('GET', `/api/messages/${userId}`);
    let lastDate = null;
    msgs.forEach(message => {
      const date = new Date(message.timestamp).toDateString();
      if (date !== lastDate) {
        appendDateDivider(message.timestamp);
        lastDate = date;
      }
      appendMessage(message, message.from === currentUser.id);
    });
    scrollToBottom();
    socket?.emit('mark_read', { from: userId });
    document.getElementById('message-input').focus();
  } catch (e) {
    showToast(e.message);
  }
}

function backToList() {
  document.getElementById('app').classList.remove('chat-open');
}

function setPeerStatus(online) {
  const status = document.getElementById('peer-status');
  status.textContent = online ? 'متصل الآن' : 'غير متصل';
  status.className = `peer-status ${online ? 'online' : ''}`;
}

function appendMessage(msg, isOut) {
  const container = document.getElementById('messages-container');
  const div = document.createElement('div');
  div.className = `message-bubble ${isOut ? 'out' : 'in'}`;
  div.setAttribute('data-id', msg.id);

  const time = new Date(msg.timestamp).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
  let content = '';

  if (msg.type === 'text') {
    content = `<div class="message-text">${esc(msg.text)}</div>`;
  } else if (msg.type === 'image') {
    const src = assetUrl(msg.mediaUrl);
    content = `<div class="media-msg"><img src="${escAttr(src)}" alt="صورة مرسلة" onclick="window.open(this.src,'_blank','noopener')"/></div>`;
  } else if (msg.type === 'video') {
    const src = assetUrl(msg.mediaUrl);
    content = `<div class="media-msg"><video src="${escAttr(src)}" controls playsinline></video></div>`;
  } else {
    const src = assetUrl(msg.mediaUrl);
    content = `<div class="file-msg">${icon('file', 'file-icon')}<div><div class="file-msg-name">${esc(msg.fileName || 'ملف')}</div><a href="${escAttr(src)}" download target="_blank" rel="noopener">تنزيل</a></div></div>`;
  }

  const readTick = isOut ? `<span class="read-tick ${msg.read ? 'read' : ''}">✓✓</span>` : '';
  div.innerHTML = `${content}<div class="message-time">${time}${readTick}</div>`;
  container.appendChild(div);
}

function appendDateDivider(timestamp) {
  const date = new Date(timestamp);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const dateString = date.toDateString();
  const label = dateString === today
    ? 'اليوم'
    : dateString === yesterday
      ? 'أمس'
      : date.toLocaleDateString('ar-IQ', { year: 'numeric', month: 'long', day: 'numeric' });

  const div = document.createElement('div');
  div.className = 'msg-date-divider';
  div.textContent = label;
  document.getElementById('messages-container').appendChild(div);
}

function scrollToBottom() {
  const container = document.getElementById('messages-container');
  container.scrollTop = container.scrollHeight;
}

function markAllRead() {
  document.querySelectorAll('.message-bubble.out .read-tick').forEach(tick => {
    tick.classList.add('read');
  });
}

function sendMessage() {
  if (!currentChat || !socket) return;
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  socket.emit('send_message', { to: currentChat.id, text, type: 'text' });
  socket.emit('stop_typing', { to: currentChat.id });
  clearTimeout(typingTimer);
}

async function sendMedia(input) {
  if (!currentChat || !input.files[0]) return;
  const file = input.files[0];
  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast('جاري رفع الملف...');
    const res = await fetch(apiUrl('/api/upload'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل رفع الملف.');

    const type = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : 'file';

    socket.emit('send_message', {
      to: currentChat.id,
      text: file.name,
      type,
      mediaUrl: data.url,
      fileName: file.name
    });
  } catch (e) {
    showToast(e.message);
  } finally {
    input.value = '';
  }
}

async function uploadAvatar(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith('image/')) {
    input.value = '';
    return showToast('اختر صورة فقط.');
  }

  const formData = new FormData();
  formData.append('avatar', file);

  try {
    showToast('جاري تحديث الصورة...');
    const res = await fetch(apiUrl('/api/profile/avatar'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل تحديث الصورة.');
    currentUser = data.user;
    renderCurrentUser();
    showToast('تم تحديث الصورة الشخصية.');
  } catch (e) {
    showToast(e.message);
  } finally {
    input.value = '';
  }
}

function onTyping() {
  if (!currentChat || !socket) return;
  socket.emit('typing', { to: currentChat.id });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit('stop_typing', { to: currentChat.id }), 1600);
}

function openAddContact() {
  document.getElementById('add-contact-modal').style.display = 'flex';
  document.getElementById('friend-id-input').focus();
}

function closeModal() {
  document.getElementById('add-contact-modal').style.display = 'none';
  document.getElementById('call-modal').style.display = 'none';
  document.getElementById('friend-id-input').value = '';
  document.getElementById('add-contact-error').textContent = '';
}

async function addContact() {
  const friendId = document.getElementById('friend-id-input').value.trim();
  if (!/^\d{9}$/.test(friendId)) return setAddContactError('أدخل رقما صحيحا من 9 أرقام.');

  try {
    const res = await api('POST', '/api/contacts/add', { friendId });
    const exists = contacts.some(contact => contact.id === res.friend.id);
    if (!exists) contacts.push({ ...res.friend, online: false });
    renderContactList();
    renderContactsTab();
    closeModal();
    showToast(res.already ? 'جهة الاتصال موجودة مسبقا.' : `تمت إضافة ${res.friend.username}.`);
  } catch (e) {
    setAddContactError(e.message);
  }
}

function setAddContactError(msg) {
  document.getElementById('add-contact-error').textContent = msg;
}

async function loadCalls() {
  if (!currentUser) return;

  try {
    const logs = await api('GET', '/api/calls');
    const list = document.getElementById('calls-list');
    if (!logs.length) {
      list.innerHTML = emptyState('phone', 'لا يوجد سجل مكالمات', 'ستظهر المكالمات الصوتية والمرئية هنا.');
      return;
    }

    list.innerHTML = logs.slice(0, 50).map(log => {
      const contact = contacts.find(item => item.id === log.with) || { username: 'غير معروف', avatar: '?', avatarUrl: null };
      const time = new Date(log.timestamp).toLocaleString('ar-IQ', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const direction = log.direction === 'incoming' ? 'واردة' : 'صادرة';
      const statusLabels = {
        missed: 'لم تكتمل',
        answered: 'تمت الإجابة',
        rejected: 'مرفوضة',
        ended: 'انتهت',
        calling: 'قيد الاتصال'
      };
      const status = statusLabels[log.status] || 'غير معروفة';
      const statusClass = ['missed', 'rejected'].includes(log.status) ? 'missed' : log.direction;
      const callIcon = log.callType === 'video' ? 'video' : 'phone';
      return `<div class="contact-item static">
        ${avatarDiv(contact, 'contact-avatar')}
        <span class="contact-details">
          <span class="contact-name">${esc(contact.username)}</span>
          <span class="contact-preview call-direction ${statusClass}">${icon(callIcon)} ${direction} · ${status}</span>
        </span>
        <span class="contact-meta">${time}</span>
      </div>`;
    }).join('');
  } catch (e) {
    showToast(e.message);
  }
}

function startCall(callType) {
  if (!currentChat || !socket) return;
  callState = { active: true, peerId: currentChat.id, callType, stream: null, peer: null };
  socket.emit('call_user', { to: currentChat.id, callType });
  startCallOverlay(currentChat.id, callType);
  showToast('جاري الاتصال...');
}

function acceptCall() {
  if (!pendingCall) return;
  document.getElementById('call-modal').style.display = 'none';
  playRingtone(false);
  callState = { active: true, peerId: pendingCall.from, callType: pendingCall.callType, stream: null, peer: null };
  socket.emit('call_accepted', { to: pendingCall.from, callId: pendingCall.callId, callType: pendingCall.callType });
  startCallOverlay(pendingCall.from, pendingCall.callType, {
    username: pendingCall.callerName,
    avatarUrl: pendingCall.callerAvatarUrl
  });
  initWebRTC(pendingCall.from, false);
}

function rejectCall() {
  document.getElementById('call-modal').style.display = 'none';
  playRingtone(false);
  if (pendingCall) socket.emit('call_rejected', { to: pendingCall.from });
  pendingCall = null;
}

function startCallOverlay(peerId, callType, fallbackPeer) {
  const contact = contacts.find(item => item.id === peerId) || fallbackPeer || { username: 'غير معروف', avatar: '?' };
  setAvatar('call-overlay-avatar', contact);
  document.getElementById('call-overlay-name').textContent = contact.username;
  document.getElementById('call-overlay').style.display = 'flex';
  callSeconds = 0;
  document.getElementById('call-duration').textContent = '00:00';
  clearInterval(callDurationInterval);
  callDurationInterval = setInterval(() => {
    callSeconds += 1;
    const minutes = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const seconds = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('call-duration').textContent = `${minutes}:${seconds}`;
  }, 1000);
  if (callType === 'video') setupVideo();
}

async function setupVideo() {
  try {
    callState.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = callState.stream;
    localVideo.style.display = 'block';
  } catch {
    showToast('تعذر الوصول إلى الكاميرا أو الميكروفون.');
  }
}

async function initWebRTC(peerId, isInitiator) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  callState.peer = pc;

  if (callState.stream) {
    callState.stream.getTracks().forEach(track => pc.addTrack(track, callState.stream));
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callState.callType === 'video'
      });
      callState.stream = stream;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      if (callState.callType === 'video') {
        const localVideo = document.getElementById('local-video');
        localVideo.srcObject = stream;
        localVideo.style.display = 'block';
      }
    } catch {
      showToast('تعذر الوصول إلى أجهزة الاتصال.');
    }
  }

  pc.ontrack = event => {
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = event.streams[0];
    remoteVideo.style.display = 'block';
  };

  pc.onicecandidate = event => {
    if (event.candidate) socket.emit('webrtc_ice', { to: peerId, candidate: event.candidate });
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc_offer', { to: peerId, offer });
  }
}

function endCall() {
  if (callState.peerId) socket.emit('call_ended', { to: callState.peerId });
  endCallCleanup();
}

function endCallCleanup() {
  clearInterval(callDurationInterval);
  if (callState.stream) callState.stream.getTracks().forEach(track => track.stop());
  if (callState.peer) callState.peer.close();
  callState = { active: false, peerId: null, callType: null, stream: null, peer: null };
  pendingCall = null;
  muted = false;
  document.getElementById('call-overlay').style.display = 'none';
  document.getElementById('local-video').style.display = 'none';
  document.getElementById('remote-video').style.display = 'none';
  loadCalls();
}

function resetCallUI() {
  clearInterval(callDurationInterval);
  if (callState.stream) callState.stream.getTracks().forEach(track => track.stop());
  if (callState.peer) callState.peer.close();
  callState = { active: false, peerId: null, callType: null, stream: null, peer: null };
  document.getElementById('call-overlay').style.display = 'none';
  document.getElementById('local-video').style.display = 'none';
  document.getElementById('remote-video').style.display = 'none';
}

function toggleMute() {
  if (!callState.stream) return;
  muted = !muted;
  callState.stream.getAudioTracks().forEach(track => {
    track.enabled = !muted;
  });
  document.getElementById('mute-btn').classList.toggle('active', muted);
}

function toggleSpeaker() {
  showToast('اختيار السماعة يعتمد على إعدادات الجهاز والمتصفح.');
}

function showTab(tab) {
  ['chats', 'calls', 'contacts'].forEach(name => {
    document.getElementById(`tab-${name}`).style.display = name === tab ? '' : 'none';
  });

  document.querySelectorAll('.stab').forEach((button, index) => {
    button.classList.toggle('active', ['chats', 'calls', 'contacts'][index] === tab);
  });

  if (tab === 'calls') loadCalls();
}

function copyId() {
  navigator.clipboard.writeText(currentUser.id)
    .then(() => showToast('تم نسخ الرقم التعريفي.'))
    .catch(() => showToast(currentUser.id));
}

function setAvatar(id, user) {
  const element = typeof id === 'string' ? document.getElementById(id) : id;
  if (!element) return;
  element.innerHTML = avatarInner(user);
  element.classList.toggle('has-image', Boolean(user?.avatarUrl));
}

function avatarDiv(user, className) {
  const online = user?.online ? ' online' : '';
  const hasImage = user?.avatarUrl ? ' has-image' : '';
  return `<span class="${className}${online}${hasImage}">${avatarInner(user)}</span>`;
}

function avatarInner(user) {
  if (user?.avatarUrl) {
    return `<img src="${escAttr(assetUrl(user.avatarUrl))}" alt="">`;
  }
  return `<span>${esc(initialOf(user))}</span>`;
}

function initialOf(user) {
  return String(user?.avatar || user?.username?.trim()?.[0] || '?').toUpperCase();
}

function emptyState(iconName, title, text) {
  return `<div class="empty-state">${icon(iconName, 'empty-icon')}<strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escAttr(value) {
  return esc(value).replace(/`/g, '&#096;');
}

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function playRingtone(start) {
  try {
    if (start) {
      if (!ringtoneCtx) {
        ringtoneCtx = new AudioContext();
        const oscillator = ringtoneCtx.createOscillator();
        const gain = ringtoneCtx.createGain();
        oscillator.connect(gain);
        gain.connect(ringtoneCtx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(720, ringtoneCtx.currentTime);
        gain.gain.setValueAtTime(0.18, ringtoneCtx.currentTime);
        oscillator.start();
      }
    } else if (ringtoneCtx) {
      ringtoneCtx.close();
      ringtoneCtx = null;
    }
  } catch {}
}

function playNotif() {
  try {
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.frequency.setValueAtTime(900, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.25);
  } catch {}
}
