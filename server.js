'use strict';

require('dotenv').config();

const express = require('express');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');
const QRCode    = require('qrcode');
const pino      = require('pino');
const path      = require('path');
const fs        = require('fs');

// ── Config ────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT       || '3001', 10);
const API_SECRET = process.env.API_SECRET          || '';
const SESS_DIR   = path.join(__dirname, 'sessions');
const logger     = pino({ level: process.env.LOG_LEVEL || 'silent' });

if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────────
let sock            = null;
let qrDataUrl       = null;
let connStatus      = 'disconnected';
// statuses: disconnected | connecting | qr_ready | connected | logged_out
let connPhone       = null;
let connName        = null;
let lastConnectedAt = null;
let reconnectTimer  = null;

// ── WhatsApp Connection ───────────────────────────────────────────
async function startSocket() {
  clearTimeout(reconnectTimer);

  const { state, saveCreds } = await useMultiFileAuthState(SESS_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  connStatus = 'connecting';
  console.log('[WA] Connecting…');

  sock = makeWASocket({
    version,
    auth:                           state,
    printQRInTerminal:              false,
    logger,
    generateHighQualityLinkPreview: false,
    syncFullHistory:                false,
    markOnlineOnConnect:            false,
  });

  // ── Connection events ─────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      connStatus = 'qr_ready';
      qrDataUrl  = await QRCode.toDataURL(qr);
      console.log('[WA] QR ready — waiting for scan');
    }

    if (connection === 'close') {
      const err      = lastDisconnect?.error;
      const code     = err instanceof Boom ? err.output.statusCode : 0;
      const loggedOut = code === DisconnectReason.loggedOut;

      connStatus  = loggedOut ? 'logged_out' : 'disconnected';
      connPhone   = null;
      connName    = null;
      qrDataUrl   = null;
      sock        = null;

      console.log('[WA] Closed — code:', code, loggedOut ? '(logged out)' : '(reconnecting…)');

      if (!loggedOut) {
        reconnectTimer = setTimeout(startSocket, 4000);
      }
    }

    if (connection === 'open') {
      connStatus      = 'connected';
      qrDataUrl       = null;
      connPhone       = sock.user?.id?.split(':')[0] ?? null;
      connName        = sock.user?.name               ?? null;
      lastConnectedAt = new Date().toISOString();
      console.log('[WA] Connected —', connPhone, connName);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Express App ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health — no auth
app.get('/health', (_req, res) => res.json({ ok: true, status: connStatus }));

// Auth middleware for all /api/* routes
app.use('/api', (req, res, next) => {
  if (!API_SECRET) return next();
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /api/status
app.get('/api/status', (_req, res) => {
  res.json({
    status:          connStatus,
    phone:           connPhone,
    name:            connName,
    lastConnectedAt,
    hasQr:           !!qrDataUrl,
  });
});

// GET /api/qr
app.get('/api/qr', (_req, res) => {
  if (!qrDataUrl) {
    return res.status(404).json({ error: 'No QR available', status: connStatus });
  }
  res.json({ qr: qrDataUrl, status: connStatus });
});

// POST /api/send   { phone, message }
app.post('/api/send', async (req, res) => {
  if (connStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'Not connected', status: connStatus });
  }
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }
  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: String(message) });
    res.json({ success: true });
  } catch (e) {
    console.error('[WA] Send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/send-image   { phone, imageUrl, caption }
app.post('/api/send-image', async (req, res) => {
  if (connStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'Not connected', status: connStatus });
  }
  const { phone, imageUrl, caption = '' } = req.body;
  if (!phone || !imageUrl) {
    return res.status(400).json({ error: 'phone and imageUrl are required' });
  }
  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { image: { url: imageUrl }, caption: String(caption) });
    res.json({ success: true });
  } catch (e) {
    console.error('[WA] Image send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/logout   — قطع الاتصال ومسح الجلسة
app.post('/api/logout', async (_req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock = null;
    }
    // مسح ملفات الجلسة
    if (fs.existsSync(SESS_DIR)) {
      for (const f of fs.readdirSync(SESS_DIR)) {
        fs.rmSync(path.join(SESS_DIR, f), { recursive: true, force: true });
      }
    }
    connStatus      = 'disconnected';
    connPhone       = null;
    connName        = null;
    qrDataUrl       = null;
    lastConnectedAt = null;

    // إعادة الاتصال للحصول على QR جديد
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(startSocket, 800);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin UI (صفحة واحدة، محمية بكلمة المرور/المفتاح نفسه) ─────────
// لا تعتمد على Laravel أو أي شيء خارجي — هذا التطبيق يخدم نفسه بنفسه،
// فيصير النشر عبر Passenger أبسط (تطبيق Node واحد مستقل بالكامل).
app.get('/', (_req, res) => {
  res.type('html').send(ADMIN_HTML);
});

const ADMIN_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>إدارة واتساب — Card4Us</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,Segoe UI,Arial;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}
  .wrap{max-width:460px;margin:40px auto}
  h1{font-size:19px;margin:0 0 20px;text-align:center}
  .card{background:#1e293b;border-radius:14px;padding:22px;margin-bottom:16px;border:1px solid #334155}
  input{width:100%;padding:11px;border-radius:9px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:10px}
  button{width:100%;padding:11px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-weight:bold;cursor:pointer;font-size:14px}
  button.secondary{background:#334155}
  button.danger{background:#dc2626}
  .row{display:flex;gap:8px}
  .row button{flex:1}
  .status{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .dot{width:12px;height:12px;border-radius:50%;background:#64748b}
  .dot.connected{background:#22c55e;box-shadow:0 0 8px #22c55e}
  .dot.need_scan{background:#f59e0b}
  .dot.connecting{background:#38bdf8}
  .dot.logged_out,.dot.disconnected{background:#ef4444}
  .label{font-size:13px;color:#94a3b8}
  .val{font-weight:bold}
  #qrBox{text-align:center;margin-top:14px}
  #qrBox img{max-width:220px;border-radius:10px;background:#fff;padding:8px}
  .hint{font-size:12px;color:#64748b;margin-top:10px;line-height:1.7}
  #err{color:#fca5a5;font-size:13px;margin-bottom:10px;display:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>📱 إدارة خدمة واتساب — الدعم</h1>

  <div class="card" id="loginCard">
    <div id="err"></div>
    <input id="secret" type="password" placeholder="المفتاح السري (API_SECRET)">
    <button onclick="login()">دخول</button>
  </div>

  <div class="card" id="mainCard" style="display:none;">
    <div class="status">
      <span class="dot" id="dot"></span>
      <div>
        <div class="label">الحالة</div>
        <div class="val" id="statusText">—</div>
      </div>
    </div>
    <div class="label">الرقم المتصل</div>
    <div class="val" id="phoneText" style="margin-bottom:10px;">—</div>
    <div class="label">آخر اتصال</div>
    <div class="val" id="lastText" style="margin-bottom:10px;font-size:12px;">—</div>

    <div id="qrBox" style="display:none;">
      <img id="qrImg" alt="QR">
      <div class="hint">افتح واتساب على جوالك ← الأجهزة المرتبطة ← ربط جهاز ← امسح الكود</div>
    </div>

    <div class="row" style="margin-top:14px;">
      <button class="secondary" onclick="refresh()">تحديث</button>
      <button class="danger" onclick="logoutSession()">تسجيل خروج / جلسة جديدة</button>
    </div>
  </div>
</div>

<script>
let SECRET = sessionStorage.getItem('wa_admin_secret') || '';
let timer = null;

function showErr(msg) {
  const e = document.getElementById('err');
  e.textContent = msg; e.style.display = msg ? 'block' : 'none';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers||{}), 'x-api-secret': SECRET, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) { sessionStorage.removeItem('wa_admin_secret'); SECRET=''; showLogin(); throw new Error('unauthorized'); }
  return res.json();
}

function showLogin() {
  document.getElementById('loginCard').style.display = 'block';
  document.getElementById('mainCard').style.display = 'none';
  if (timer) clearInterval(timer);
}

async function login() {
  SECRET = document.getElementById('secret').value.trim();
  showErr('');
  try {
    await api('/api/status');
    sessionStorage.setItem('wa_admin_secret', SECRET);
    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('mainCard').style.display = 'block';
    refresh();
    timer = setInterval(refresh, 4000);
  } catch (e) {
    showErr('مفتاح غير صحيح أو تعذر الاتصال.');
  }
}

async function refresh() {
  try {
    const s = await api('/api/status');
    document.getElementById('dot').className = 'dot ' + s.status;
    const labels = { connected:'متصل ✅', need_scan:'بانتظار مسح QR', qr_ready:'بانتظار مسح QR',
                      connecting:'جارٍ الاتصال…', disconnected:'غير متصل', logged_out:'تم تسجيل الخروج' };
    document.getElementById('statusText').textContent = labels[s.status] || s.status;
    document.getElementById('phoneText').textContent = s.phone || '—';
    document.getElementById('lastText').textContent = s.lastConnectedAt ? new Date(s.lastConnectedAt).toLocaleString('ar-SA') : '—';

    const qrBox = document.getElementById('qrBox');
    if (s.hasQr && s.status !== 'connected') {
      const q = await api('/api/qr');
      if (q.qr) { document.getElementById('qrImg').src = q.qr; qrBox.style.display = 'block'; }
    } else {
      qrBox.style.display = 'none';
    }
  } catch (e) { /* unauthorized handled in api() */ }
}

async function logoutSession() {
  if (!confirm('تسجيل خروج الجلسة الحالية؟ بتحتاج تمسح QR من جديد.')) return;
  try { await api('/api/logout', { method: 'POST' }); refresh(); } catch (e) {}
}

if (SECRET) {
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('mainCard').style.display = 'block';
  refresh();
  timer = setInterval(refresh, 4000);
}
</script>
</body>
</html>`;

// ── Start ─────────────────────────────────────────────────────────
// ملاحظة: Passenger يدير بدء/إيقاف/إعادة تشغيل هذا الملف بنفسه (لا حاجة
// لسكربت keepalive يدوي بعد الآن)، ويمرر رقم المنفذ عبر PORT تلقائياً.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[WA Service] http://127.0.0.1:${PORT}`);
  startSocket().catch(console.error);
});
