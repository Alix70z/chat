# ChatWave

تطبيق محادثات فوري بواجهة عربية رسمية، تسجيل دخول، جهات اتصال، رسائل وملفات، صورة شخصية، ومكالمات صوتية/فيديو عبر WebRTC.

## التشغيل المحلي

```bash
npm install
npm start
```

ثم افتح:

```text
http://localhost:3000
```

## الأمان الحالي

- كلمات المرور تحفظ باستخدام `bcrypt` بدل SHA-256 الخام.
- الرسائل النصية تشفر قبل التخزين باستخدام `AES-256-GCM`.
- أسرار JWT والتشفير أصبحت من متغيرات البيئة بدل أن تكون ثابتة داخل الكود.
- رفع الملفات يمنع الأنواع الخطرة مثل HTML وJS وSVG والملفات التنفيذية.
- الصورة الشخصية تقبل PNG/JPG/WEBP/GIF حتى 5MB.

انسخ `.env.example` إلى `.env` في بيئة الخادم واضبط القيم:

```text
JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_SECRET=replace-with-a-different-long-random-secret
ENCRYPTION_SALT=replace-with-a-long-random-salt
CORS_ORIGIN=https://your-site.netlify.app
```

## النشر على Netlify

Netlify مناسب لنشر واجهة `public`، لكن هذا المشروع يستخدم Socket.io واتصال WebSocket مستمر، لذلك يجب تشغيل `server.js` على استضافة Node منفصلة مثل Render أو Railway أو Fly.io أو VPS.

الترتيب الجاهز:

- ملف `netlify.toml` في جذر المشروع يحدد `files` كـ base و`public` كمجلد النشر، ويوجد ملف آخر داخل `files` إذا نشرت هذا المجلد مباشرة.
- ملف `public/config.js` يحدد عنوان خادم Node الخارجي.
- ملف `public/_headers` يضيف رؤوس أمان للواجهة الثابتة.

بعد رفع الخادم، عدل `public/config.js`:

```js
window.CHATWAVE_CONFIG = {
  apiBaseUrl: "https://your-backend.example.com",
  socketUrl: "https://your-backend.example.com"
};
```

ثم انشر على Netlify. إذا كان Netlify يرى جذر المستودع مباشرة، سيقرأ `netlify.toml` الحالي. إذا نشرت مجلد `files` وحده، اجعل Publish directory هو `public`.

## أوامر مفيدة

```bash
npm run check
npm start
```
