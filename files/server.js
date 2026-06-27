const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || JWT_SECRET;
const ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'chatwave-local-development-salt';
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, ENCRYPTION_SALT, 32);
const PASSWORD_COST = Number(process.env.BCRYPT_COST || 12);
const GCM_IV_LENGTH = 12;
const LEGACY_IV_LENGTH = 16;
const MAX_TEXT_LENGTH = 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!process.env.JWT_SECRET && IS_PROD) {
  console.warn('WARNING: JWT_SECRET is not set. Sessions will reset on every server restart.');
}

if (!process.env.ENCRYPTION_SECRET && IS_PROD) {
  console.warn('WARNING: ENCRYPTION_SECRET is not set. Encrypted messages will not survive server restarts.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .map(origin => origin.replace(/\/+$/, ''))
  .filter(Boolean);

const io = socketIO(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : '*',
    credentials: false
  },
  maxHttpBufferSize: 20 * 1024 * 1024
});

// In-memory storage. Use a database before running this as a public production service.
const users = {}; // userId -> { id, username, password, avatar, avatarUrl }
const sessions = {}; // token -> userId
const messages = [];
const contacts = {}; // userId -> [friendId, ...]
const callLogs = {}; // userId -> [{...}]
const onlineUsers = {}; // userId -> socketId
const authAttempts = new Map();

function encrypt(text) {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(text), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(text) {
  try {
    if (typeof text !== 'string') return '';
    if (text.startsWith('v2:')) {
      const [, ivB64, tagB64, encryptedB64] = text.split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedB64, 'base64')),
        decipher.final()
      ]);
      return decrypted.toString('utf8');
    }

    // Legacy AES-256-CBC support for messages created by the previous version.
    const [ivHex, enc] = text.split(':');
    if (!ivHex || !enc) return '[encrypted]';
    const legacyKey = crypto.scryptSync('chatapp_enc_key', 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', legacyKey, Buffer.from(ivHex, 'hex').subarray(0, LEGACY_IV_LENGTH));
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return '[encrypted]';
  }
}

function generateUserId() {
  let id;
  do {
    id = crypto.randomInt(100000000, 1000000000).toString();
  } while (users[id]);
  return id;
}

function sanitizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    avatarUrl: user.avatarUrl || null
  };
}

function createSession(userId) {
  const token = jwt.sign({ id: userId }, JWT_SECRET, {
    expiresIn: '30d',
    issuer: 'chatwave'
  });
  sessions[token] = userId;
  return token;
}

function updateCallLog(ownerId, peerId, patch) {
  const log = (callLogs[ownerId] || []).find(item => item.with === peerId && item.status === 'calling');
  if (log) Object.assign(log, patch);
}

function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

function rateLimitAuth(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 40;
  const record = authAttempts.get(key) || { count: 0, resetAt: now + windowMs };

  if (record.resetAt <= now) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count += 1;
  authAttempts.set(key, record);

  if (record.count > maxAttempts) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  next();
}

function safeFileName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase().slice(0, 12);
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

const blockedExtensions = new Set([
  '.bat', '.cmd', '.com', '.exe', '.htm', '.html', '.js', '.mjs', '.php',
  '.ps1', '.sh', '.svg', '.vbs', '.xhtml', '.xml'
]);

function blockUnsafeFiles(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const type = String(file.mimetype || '').toLowerCase();
  if (blockedExtensions.has(ext) || type.includes('javascript') || type.includes('svg') || type.includes('html')) {
    return cb(new Error('This file type is not allowed.'));
  }
  cb(null, true);
}

function imageOnly(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  if (!allowedImageTypes.has(file.mimetype) || blockedExtensions.has(ext)) {
    return cb(new Error('Only PNG, JPG, WEBP, or GIF images are allowed.'));
  }
  cb(null, true);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, safeFileName(file.originalname))
});

const mediaUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: blockUnsafeFiles
});

const avatarUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageOnly
});

app.disable('x-powered-by');
app.use(cors({
  origin: allowedOrigins.length
    ? (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin.replace(/\/+$/, '')))
    : '*'
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), payment=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'chatwave' });
    if (sessions[token] && sessions[token] !== payload.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!users[payload.id]) return res.status(401).json({ error: 'Unauthorized' });
    sessions[token] = payload.id;
    req.userId = payload.id;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'chatwave', time: new Date().toISOString() });
});

app.post('/api/register', rateLimitAuth, async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const { password } = req.body;

  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const existingUser = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existingUser) return res.status(409).json({ error: 'Username taken' });

  const id = generateUserId();
  const hashedPw = await bcrypt.hash(password, PASSWORD_COST);
  users[id] = {
    id,
    username,
    password: hashedPw,
    avatar: username[0].toUpperCase(),
    avatarUrl: null
  };
  contacts[id] = [];
  callLogs[id] = [];

  const token = createSession(id);
  res.json({ token, user: publicUser(users[id]) });
});

app.post('/api/login', rateLimitAuth, async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const { password } = req.body;
  const user = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });

  let ok = await bcrypt.compare(password || '', user.password);
  if (!ok && /^[a-f0-9]{64}$/i.test(user.password)) {
    const legacyHash = crypto.createHash('sha256').update(password || '').digest('hex');
    ok = legacyHash === user.password;
    if (ok) user.password = await bcrypt.hash(password, PASSWORD_COST);
  }

  if (!ok) return res.status(401).json({ error: 'Wrong password' });

  const token = createSession(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) delete sessions[token];
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json(publicUser(users[req.userId]));
});

app.post('/api/profile/avatar', authMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const user = users[req.userId];
    user.avatarUrl = `/uploads/${req.file.filename}`;
    const payload = publicUser(user);

    const mySocket = onlineUsers[req.userId];
    if (mySocket) io.to(mySocket).emit('profile_updated', { user: payload });

    (contacts[req.userId] || []).forEach(friendId => {
      const socketId = onlineUsers[friendId];
      if (socketId) io.to(socketId).emit('contact_updated', { user: payload });
    });

    res.json({ user: payload });
  });
});

app.post('/api/contacts/add', authMiddleware, (req, res) => {
  const friendId = String(req.body.friendId || '').trim();
  if (!users[friendId]) return res.status(404).json({ error: 'User not found' });
  if (friendId === req.userId) return res.status(400).json({ error: 'Cannot add yourself' });

  contacts[req.userId] ||= [];
  contacts[friendId] ||= [];
  const already = contacts[req.userId].includes(friendId);
  if (!already) contacts[req.userId].push(friendId);
  if (!contacts[friendId].includes(req.userId)) contacts[friendId].push(req.userId);

  res.json({ friend: publicUser(users[friendId]), already });
});

app.get('/api/contacts', authMiddleware, (req, res) => {
  const myContacts = (contacts[req.userId] || [])
    .filter(fid => users[fid])
    .map(fid => ({
      ...publicUser(users[fid]),
      online: Boolean(onlineUsers[fid])
    }));
  res.json(myContacts);
});

app.get('/api/messages/:otherId', authMiddleware, (req, res) => {
  const myId = req.userId;
  const otherId = req.params.otherId;
  if (!users[otherId]) return res.status(404).json({ error: 'User not found' });

  const convo = messages
    .filter(m => (m.from === myId && m.to === otherId) || (m.from === otherId && m.to === myId))
    .map(m => ({
      ...m,
      text: m.type === 'text' ? decrypt(m.text) : m.text
    }));
  res.json(convo);
});

app.post('/api/upload', authMiddleware, (req, res) => {
  mediaUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ url, name: req.file.originalname, mimetype: req.file.mimetype });
  });
});

app.get('/api/calls', authMiddleware, (req, res) => {
  res.json(callLogs[req.userId] || []);
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'chatwave' });
    if (!users[payload.id]) return next(new Error('Unauthorized'));
    sessions[token] = payload.id;
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', socket => {
  const userId = socket.userId;
  onlineUsers[userId] = socket.id;

  (contacts[userId] || []).forEach(friendId => {
    const friendSocket = onlineUsers[friendId];
    if (friendSocket) io.to(friendSocket).emit('user_online', { userId });
  });

  socket.on('send_message', ({ to, text, type = 'text', mediaUrl, fileName } = {}) => {
    if (!users[to]) return socket.emit('message_error', { error: 'Recipient not found' });
    if (to === userId) return socket.emit('message_error', { error: 'Cannot message yourself' });
    if (!(contacts[userId] || []).includes(to)) {
      return socket.emit('message_error', { error: 'Add this user to contacts before messaging.' });
    }

    const safeType = ['text', 'image', 'video', 'file'].includes(type) ? type : 'text';
    const plainText = String(text || '').slice(0, MAX_TEXT_LENGTH);
    if (safeType === 'text' && !plainText.trim()) return;

    const msg = {
      id: uuidv4(),
      from: userId,
      to,
      text: safeType === 'text' ? encrypt(plainText) : plainText,
      type: safeType,
      mediaUrl: mediaUrl || null,
      fileName: fileName || null,
      timestamp: Date.now(),
      read: false
    };
    messages.push(msg);

    const outgoing = {
      ...msg,
      text: safeType === 'text' ? plainText : msg.text
    };

    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('receive_message', outgoing);
    socket.emit('message_sent', outgoing);
  });

  socket.on('mark_read', ({ from } = {}) => {
    if (!users[from]) return;
    messages.forEach(message => {
      if (message.from === from && message.to === userId) message.read = true;
    });
    const senderSocket = onlineUsers[from];
    if (senderSocket) io.to(senderSocket).emit('messages_read', { by: userId });
  });

  socket.on('typing', ({ to } = {}) => {
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('user_typing', { from: userId });
  });

  socket.on('stop_typing', ({ to } = {}) => {
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('user_stop_typing', { from: userId });
  });

  socket.on('call_user', ({ to, callType } = {}) => {
    if (!users[to]) return socket.emit('call_failed', { reason: 'User not found' });
    const recipientSocket = onlineUsers[to];
    const caller = users[userId];
    const safeCallType = callType === 'video' ? 'video' : 'voice';
    const callId = uuidv4();

    if (recipientSocket) {
      io.to(recipientSocket).emit('incoming_call', {
        from: userId,
        callerName: caller.username,
        callerAvatarUrl: caller.avatarUrl || null,
        callType: safeCallType,
        callId
      });
    } else {
      socket.emit('call_failed', { reason: 'User offline' });
    }

    const log = {
      id: uuidv4(),
      with: to,
      callType: safeCallType,
      direction: 'outgoing',
      timestamp: Date.now(),
      status: recipientSocket ? 'calling' : 'missed'
    };
    callLogs[userId] ||= [];
    callLogs[userId].unshift(log);
  });

  socket.on('call_accepted', ({ to, callId, callType } = {}) => {
    const callerSocket = onlineUsers[to];
    const safeCallType = callType === 'video' ? 'video' : 'voice';
    if (callerSocket) io.to(callerSocket).emit('call_accepted', { by: userId, callId });
    updateCallLog(to, userId, { status: 'answered' });
    callLogs[userId] ||= [];
    callLogs[userId].unshift({
      id: uuidv4(),
      with: to,
      callType: safeCallType,
      direction: 'incoming',
      timestamp: Date.now(),
      status: 'answered'
    });
  });

  socket.on('call_rejected', ({ to } = {}) => {
    const callerSocket = onlineUsers[to];
    if (callerSocket) io.to(callerSocket).emit('call_rejected', { by: userId });
    updateCallLog(to, userId, { status: 'rejected' });
  });

  socket.on('call_ended', ({ to } = {}) => {
    const otherSocket = onlineUsers[to];
    if (otherSocket) io.to(otherSocket).emit('call_ended', { by: userId });
    updateCallLog(userId, to, { status: 'ended' });
    updateCallLog(to, userId, { status: 'ended' });
  });

  socket.on('webrtc_offer', ({ to, offer } = {}) => {
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('webrtc_offer', { from: userId, offer });
  });

  socket.on('webrtc_answer', ({ to, answer } = {}) => {
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('webrtc_answer', { from: userId, answer });
  });

  socket.on('webrtc_ice', ({ to, candidate } = {}) => {
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('webrtc_ice', { from: userId, candidate });
  });

  socket.on('disconnect', () => {
    if (onlineUsers[userId] === socket.id) delete onlineUsers[userId];
    (contacts[userId] || []).forEach(friendId => {
      const friendSocket = onlineUsers[friendId];
      if (friendSocket) io.to(friendSocket).emit('user_offline', { userId });
    });
  });
});

server.listen(PORT, () => {
  console.log(`ChatWave running at http://localhost:${PORT}`);
});
