require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { startDownload } = require('./downloader');
const sessionMgr = require('./session-manager');
const { sendEmail } = require('./mailer');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Authentication
const { router: authRouter, authenticateUser, optionalAuthenticate } = require('./auth');
app.use('/api/auth', authRouter);


// ─── In-memory stores ────────────────────────────────────────────────────────
const jobs = new Map();
const uploadJobs = new Map(); // Track upload progress
const ipUsage = new Map();

const adminConfig = {
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123'
};

// Boot with pre-configured cookies from .env if present
if (process.env.RECU_COOKIES) {
  sessionMgr.setManualCookies(process.env.RECU_COOKIES);
}

const FREE_FULL_LIMIT = 1;
const FREE_FULL_MAX_SECS = 15 * 60;
const FREE_CLIP_LIMIT = 1;
const FREE_CLIP_MAX_SECS = 5 * 60;
const PRICE_USD = process.env.PRICE_USD || '4.99';
const BYPASS_CODE = process.env.BYPASS_CODE || 'EKKOFREE';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getIP = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
const adminToken = () => Buffer.from(adminConfig.adminPassword).toString('base64');

function broadcast(job) {
  if (!job.clients) return;

  // Log to history immediately when job completes so it shows up on refresh
  if (job.status === 'complete' && !job.historyLogged && job.userId) {
    job.historyLogged = true;
    try {
      const db = require('./db');
      db.prepare('INSERT INTO history (id, user_id, video_url, is_clip, duration, clip_start, clip_end) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(job.id, job.userId, job.url, job.clipMode ? 1 : 0, job.duration || null, job.clipStart || null, job.clipEnd || null);
        
      // Trigger auto-upload in the background if API keys exist
      try {
        const setting1 = db.prepare("SELECT value FROM settings WHERE key = 'upload_api_key'").get();
        const apiKey1 = setting1 ? setting1.value : null;
        const setting2 = db.prepare("SELECT value FROM settings WHERE key = 'upload_api_key_2'").get();
        const apiKey2 = setting2 ? setting2.value : null;
        
        if (apiKey1 || apiKey2) {
           console.log(`[Server] Auto-uploading job ${job.id} to cloud...`);
           uploadJobs.set(job.id, { status: 'uploading', progress: 0, error: null });
           const promises = [];
           const fp = path.join(__dirname, 'tmp_jobs', job.id, 'output.mp4');
           if (apiKey1) promises.push(uploadVideoToCloud(job.id, fp, apiKey1).catch(e => { console.error('DoodAPI auto-upload error:', e.message); throw e; }));
           if (apiKey2) promises.push(uploadToKrakenFiles(job.id, fp, apiKey2).catch(e => { console.error('KrakenFiles auto-upload error:', e.message); throw e; }));
           
           Promise.all(promises).then(() => {
               uploadJobs.set(job.id, { status: 'complete' });
               console.log(`[Server] Auto-upload completed for job ${job.id}`);
           }).catch(err => {
               uploadJobs.set(job.id, { status: 'error', error: err.message });
           });
        }
      } catch (upErr) {
        console.error('[Server] Failed to trigger auto-upload:', upErr);
      }
        
      if (job.notifyEmail && job.userEmail) {
        const msgSetting = db.prepare("SELECT value FROM settings WHERE key = 'success_email_msg'").get();
        const successMsg = msgSetting?.value || "Your requested video has been successfully downloaded by Ekkoscope.";
        sendEmail(job.userEmail, 'Your Video Download is Ready!', `${successMsg}\n\nVideo URL: ${job.url}\n\nYou can access it from your dashboard.`);
      }
    } catch (e) {
      console.error('Failed to log history/send email:', e);
    }
  }

  const payload = JSON.stringify({
    status: job.status, progress: job.progress,
    eta: job.eta, chunksStolen: job.chunksStolen || 0, error: job.error || null
  });
  job.clients.forEach(send => send(payload));
}

// Log session events to console
sessionMgr.on('updated', () => console.log('[Session] ✅ Cookies refreshed — all downloads will use new session.'));
sessionMgr.on('error', (msg) => console.error('[Session] ❌ Refresh error:', msg));
sessionMgr.on('status', (s) => console.log('[Session] Status:', s));

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/free-tier', (req, res) => {
  const usage = ipUsage.get(getIP(req)) || { fullCount: 0, clipCount: 0 };
  
  let downloadStartMsg = "Your video will be downloaded in a few minutes. You can wait or provide an email for notification.";
  try {
    const db = require('./db');
    const s = db.prepare("SELECT value FROM settings WHERE key = 'download_start_msg'").get();
    if (s && s.value) downloadStartMsg = s.value;
  } catch(e) {}
  
  res.json({
    fullRemaining: Math.max(0, FREE_FULL_LIMIT - usage.fullCount),
    clipRemaining: Math.max(0, FREE_CLIP_LIMIT - usage.clipCount),
    freeFullMaxMin: FREE_FULL_MAX_SECS / 60,
    freeClipMaxMin: FREE_CLIP_MAX_SECS / 60,
    downloadStartMsg
  });
});

app.post('/api/start', optionalAuthenticate, async (req, res) => {
  const { url, clipMode, clipStart, clipEnd, bypassCode, notifyEmail } = req.body;
  const ip = getIP(req);

  if (!url) return res.status(400).json({ error: 'Video URL is required.' });
  if (!url.includes('recu.me')) return res.status(400).json({ error: 'Please enter a valid recu.me video URL.' });

  const clipDuration = clipMode ? (clipEnd - clipStart) : null;
  const usage = ipUsage.get(ip) || { fullCount: 0, clipCount: 0 };
  const bypassed = bypassCode === BYPASS_CODE;

  if (!bypassed) {
    if (clipMode) {
      if (clipDuration > FREE_CLIP_MAX_SECS)
        return res.status(402).json({ error: 'paywall', message: `Free clips limited to ${FREE_CLIP_MAX_SECS / 60} min.` });
      if (usage.clipCount >= FREE_CLIP_LIMIT)
        return res.status(402).json({ error: 'paywall', message: 'Free clip tier exhausted.' });
    } else {
      if (usage.fullCount >= FREE_FULL_LIMIT)
        return res.status(402).json({ error: 'paywall', message: 'Free download tier exhausted.' });
    }
  }

  if (!bypassed) {
    if (clipMode) usage.clipCount++; else usage.fullCount++;
    ipUsage.set(ip, usage);
  }

  const jobId = uuidv4();
  
  let gifDuration = 3;
  try {
    const db = require('./db');
    const s = db.prepare("SELECT value FROM settings WHERE key = 'gif_duration'").get();
    if (s && s.value) gifDuration = parseInt(s.value, 10);
  } catch(e) {}

  const job = {
    id: jobId, status: 'queued', progress: 0, eta: null,
    filePath: null, error: null, clients: [],
    clipMode: !!clipMode, clipStart: clipStart || 0,
    clipEnd: clipEnd || null, url, startTime: Date.now(), chunksStolen: 0,
    userId: req.user ? req.user.id : null,
    notifyEmail: !!notifyEmail,
    userEmail: req.user ? req.user.email : null,
    gifDuration: gifDuration
  };
  jobs.set(jobId, job);

  const handleJobError = (job, err, broadcast) => {
    job.status = 'error';
    job.error = err.message;
    broadcast(job);
    
    // Auto-add to backlog for authenticated users
    if (job.userId && !job.isBacklogRetry) {
      try {
        const db = require('./db');
        const backlogId = uuidv4();
        db.prepare(`
          INSERT INTO backlog (id, user_id, video_url, is_clip, clip_start, clip_end, notify_email, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(backlogId, job.userId, job.url, job.clipMode ? 1 : 0, job.clipStart || null, job.clipEnd || null, job.notifyEmail ? 1 : 0);
        console.log(`[Server] Job ${job.id} failed, automatically added to backlog as ${backlogId}`);
      } catch (e) {
        console.error('[Server] Failed to auto-add to backlog:', e);
      }
    }
  };

  // Pass session manager so downloader always has latest cookies
  startDownload(job, sessionMgr, broadcast).catch(async err => {
    // If 403/401 error → force cookie refresh and retry once
    if (err.message.includes('403') || err.message.includes('401') || err.message.includes('expired')) {
      console.log('[Server] Auth error detected, forcing session refresh and retrying...');
      job.status = 'refreshing_session';
      job.error = null;
      broadcast(job);
      try {
        await sessionMgr.forceRefresh();
        await startDownload(job, sessionMgr, broadcast);
      } catch (retryErr) {
        handleJobError(job, retryErr, broadcast);
      }
    } else {
      handleJobError(job, err, broadcast);
    }
  });

  res.json({ jobId });
});

app.post('/api/backlog/add', authenticateUser, (req, res) => {
  const { url, clipMode, clipStart, clipEnd } = req.body;
  if (!url) return res.status(400).json({ error: 'Video URL is required.' });

  try {
    const db = require('./db');
    const id = uuidv4();
    db.prepare(`
      INSERT INTO backlog (id, user_id, video_url, is_clip, clip_start, clip_end, notify_email)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(id, req.user.id, url, clipMode ? 1 : 0, clipStart || null, clipEnd || null);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add to backlog' });
  }
});

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send('Job not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent proxy buffering
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${payload}\n\n`);
  job.clients.push(send);
  send(JSON.stringify({ status: job.status, progress: job.progress, eta: job.eta, chunksStolen: job.chunksStolen, error: job.error }));
  req.on('close', () => { job.clients = job.clients.filter(c => c !== send); });
});

app.get('/api/download/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const filePath = path.join(__dirname, 'tmp_jobs', jobId, 'output.mp4');
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or has expired.');
  }

  // Fetch from DB to know if it's clip or full for the filename
  let clipMode = false;
  let videoUrl = 'video';
  try {
    const db = require('./db');
    const hist = db.prepare('SELECT is_clip, video_url FROM history WHERE id = ?').get(jobId);
    if (hist) {
      clipMode = hist.is_clip;
      if (hist.video_url) {
        // extract e.g. "username_video_123" from recu.me/username/video/123/play
        const match = hist.video_url.match(/recu\.me\/([^\/]+)\/video\/([^\/]+)/);
        if (match) videoUrl = `${match[1]}_${match[2]}`;
      }
    }
  } catch(e) {}

  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
  const filename = `${videoUrl}_${clipMode ? 'clip' : 'full'}_${dateStr}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

app.get('/api/thumbnail/:jobId', (req, res) => {
  let filePath = path.join(__dirname, 'tmp_jobs', req.params.jobId, 'thumb.gif');
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'tmp_jobs', req.params.jobId, 'thumb.jpg');
  }
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Thumbnail not found');
  }
});

app.get('/api/upload-status/:jobId', authenticateUser, (req, res) => {
  const upJob = uploadJobs.get(req.params.jobId);
  if (!upJob) return res.status(404).json({ error: 'Not uploading' });
  res.json(upJob);
});

async function uploadVideoToCloud(jobId, filePath, apiKey) {
  const fetch = require('node-fetch');
  const FormData = require('form-data');
  const db = require('./db');
  
  const serverRes = await fetch(`https://doodapi.com/api/upload/server?key=${apiKey}`);
  const serverData = await serverRes.json();
  if (!serverData.result) throw new Error('Failed to get upload server');

  const uploadUrl = serverData.result + '?' + new URLSearchParams({ api_key: apiKey }).toString();
  const form = new FormData();
  form.append('api_key', apiKey);
  const fileStream = fs.createReadStream(filePath);
  form.append('file', fileStream);

  const headers = form.getHeaders();
  headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  
  const https = require('https');
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

  uploadJobs.set(jobId, { status: 'uploading', progress: 0, url: null, error: null });

  const util = require('util');
  const getLength = util.promisify(form.getLength).bind(form);
  let totalLength = 0;
  try { totalLength = await getLength(); headers['Content-Length'] = totalLength; } catch (e) {}

  const { Transform } = require('stream');
  let uploadedBytes = 0;
  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      uploadedBytes += chunk.length;
      if (totalLength) {
        const pct = Math.round((uploadedBytes / totalLength) * 100);
        uploadJobs.set(jobId, { status: 'uploading', progress: pct });
      }
      callback(null, chunk);
    }
  });

  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form.pipe(progressStream), headers: headers, agent: agent });
  const textData = await uploadRes.text();
  const uploadData = JSON.parse(textData);

  if (uploadData.result && uploadData.result.length > 0) {
    const downloadedUrl = uploadData.result[0].download_url;
    db.prepare('UPDATE history SET uploaded_url = ? WHERE id = ?').run(downloadedUrl, jobId);
    return downloadedUrl;
  } else {
    throw new Error('Upload failed remotely');
  }
}

async function uploadToKrakenFiles(jobId, filePath, apiKey) {
  const fetch = require('node-fetch');
  const FormData = require('form-data');
  const db = require('./db');
  
  const serverRes = await fetch('https://krakenfiles.com/api/server/available', {
    headers: { 'Accept': 'application/json' }
  });
  const serverData = await serverRes.json();
  if (serverData.status !== 200 || !serverData.data.url) throw new Error('Failed to get KrakenFiles upload server');

  const uploadUrl = serverData.data.url;
  const serverAccessToken = serverData.data.serverAccessToken;

  const form = new FormData();
  form.append('serverAccessToken', serverAccessToken);
  const fileStream = fs.createReadStream(filePath);
  form.append('file', fileStream);

  const headers = form.getHeaders();
  headers['X-AUTH-TOKEN'] = apiKey;

  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form, headers: headers });
  const uploadData = await uploadRes.json();

  if (uploadData.status === 200 && uploadData.data.url) {
    const downloadedUrl = uploadData.data.url;
    db.prepare('UPDATE history SET uploaded_url_2 = ? WHERE id = ?').run(downloadedUrl, jobId);
    return downloadedUrl;
  } else {
    throw new Error(uploadData.data?.message || 'KrakenFiles Upload failed remotely');
  }
}

app.post('/api/upload/:jobId', authenticateUser, async (req, res) => {
  const jobId = req.params.jobId;
  const filePath = path.join(__dirname, 'tmp_jobs', jobId, 'output.mp4');

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or has expired.' });
  if (uploadJobs.has(jobId) && uploadJobs.get(jobId).status !== 'error') return res.json({ status: 'started' });

  try {
    const db = require('./db');
    const hist = db.prepare('SELECT * FROM history WHERE id = ? AND user_id = ?').get(jobId, req.user.id);
    if (!hist) return res.status(403).json({ error: 'Forbidden' });
    const setting1 = db.prepare("SELECT value FROM settings WHERE key = 'upload_api_key'").get();
    const apiKey1 = setting1 ? setting1.value : null;
    const setting2 = db.prepare("SELECT value FROM settings WHERE key = 'upload_api_key_2'").get();
    const apiKey2 = setting2 ? setting2.value : null;
    
    if (!apiKey1 && !apiKey2) return res.status(400).json({ error: 'No API keys configured by admin.' });

    res.json({ status: 'started' }); 

    uploadJobs.set(jobId, { status: 'uploading', progress: 0, error: null });

    const promises = [];
    if (apiKey1) promises.push(uploadVideoToCloud(jobId, filePath, apiKey1).catch(e => { throw new Error('DoodAPI: ' + e.message); }));
    if (apiKey2) promises.push(uploadToKrakenFiles(jobId, filePath, apiKey2).catch(e => { throw new Error('KrakenFiles: ' + e.message); }));

    Promise.all(promises).then(() => {
        uploadJobs.set(jobId, { status: 'complete' });
    }).catch(err => {
        uploadJobs.set(jobId, { status: 'error', error: err.message });
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/history', authenticateUser, (req, res) => {
  try {
    const db = require('./db');
    const history = db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    const backlog = db.prepare("SELECT * FROM backlog WHERE user_id = ? AND status IN ('pending', 'retrying') ORDER BY created_at DESC").all(req.user.id);
    
    // Find active jobs for this user from memory
    const activeUserJobs = [];
    for (const [id, job] of jobs.entries()) {
      if (job.userId === req.user.id && job.status !== 'complete' && job.status !== 'error') {
        activeUserJobs.push({
          id: job.id, status: job.status, progress: job.progress, eta: job.eta,
          url: job.url, clipMode: job.clipMode, startTime: job.startTime,
          chunksStolen: job.chunksStolen
        });
      }
    }
    
    const msgSetting = db.prepare("SELECT value FROM settings WHERE key = 'failed_download_msg'").get();
    const failedMsg = msgSetting?.value || "The download failed now but will resume shortly and we will let you know when your video is ready. You can provide an email for notification.";
    
    res.json({ history, backlog, activeJobs: activeUserJobs, failedMsg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});


// ─── Admin ────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === adminConfig.adminPassword) {
    res.json({ token: adminToken() });
  } else {
    res.status(401).json({ error: 'Wrong password.' });
  }
});

app.post('/api/admin/credentials', (req, res) => {
  if (req.body.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  if (req.body.email && req.body.password) {
    sessionMgr.setCredentials(req.body.email, req.body.password);
  }
  if (req.body.cookies) {
    sessionMgr.setManualCookies(req.body.cookies);
  }
  res.json({ success: true });
});

// Force session refresh endpoint
app.post('/api/admin/refresh-session', async (req, res) => {
  if (req.body.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await sessionMgr.forceRefresh();
    res.json({ success: true, status: sessionMgr.getStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/status', (req, res) => {
  if (req.query.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const sess = sessionMgr.getStatus();
  res.json({
    session: sess,
    activeJobs: Array.from(jobs.values()).map(j => ({
      id: j.id, status: j.status, progress: j.progress,
      url: j.url, clipMode: j.clipMode, chunksStolen: j.chunksStolen
    })),
    totalIPs: ipUsage.size,
    bypassCode: BYPASS_CODE,
    priceUSD: PRICE_USD
  });
});

app.get('/api/admin/settings', (req, res) => {
  if (req.query.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const db = require('./db');
  const getSetting = (k) => { const s = db.prepare("SELECT value FROM settings WHERE key = ?").get(k); return s ? s.value : ''; };
  
  res.json({ 
    upload_api_key: getSetting('upload_api_key'),
    upload_api_key_2: getSetting('upload_api_key_2'),
    retry_interval: getSetting('retry_interval') || '15',
    smtp_host: getSetting('smtp_host'),
    smtp_port: getSetting('smtp_port'),
    smtp_user: getSetting('smtp_user'),
    smtp_pass: getSetting('smtp_pass'),
    failed_download_msg: getSetting('failed_download_msg'),
    download_start_msg: getSetting('download_start_msg'),
    success_email_msg: getSetting('success_email_msg'),
    gif_duration: getSetting('gif_duration') || '3',
    seek_interval: getSetting('seek_interval') || '500',
    buffer_margin: getSetting('buffer_margin') || '8',
    seek_offset: getSetting('seek_offset') || '2'
  });
});

app.post('/api/admin/settings', (req, res) => {
  if (req.body.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const db = require('./db');
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  
  const update = (k, v) => { if (v !== undefined) stmt.run(k, v); };
  update('upload_api_key', req.body.upload_api_key);
  update('upload_api_key_2', req.body.upload_api_key_2);
  update('retry_interval', req.body.retry_interval);
  update('smtp_host', req.body.smtp_host);
  update('smtp_port', req.body.smtp_port);
  update('smtp_user', req.body.smtp_user);
  update('smtp_pass', req.body.smtp_pass);
  update('failed_download_msg', req.body.failed_download_msg);
  update('download_start_msg', req.body.download_start_msg);
  update('success_email_msg', req.body.success_email_msg);
  update('gif_duration', req.body.gif_duration);
  update('seek_interval', req.body.seek_interval);
  update('buffer_margin', req.body.buffer_margin);
  update('seek_offset', req.body.seek_offset);
  
  res.json({ success: true });
});

app.get('/api/admin/backlog/export', (req, res) => {
  if (req.query.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const db = require('./db');
  const items = db.prepare("SELECT b.*, u.email FROM backlog b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC").all();
  
  let csv = 'ID,User_Email,Video_URL,Status,Created_At\n';
  items.forEach(i => {
    csv += `"${i.id}","${i.email}","${i.video_url}","${i.status}","${i.created_at}"\n`;
  });
  
  res.setHeader('Content-Disposition', 'attachment; filename="failed_backlog.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

app.get('/api/admin/backlog', (req, res) => {
  if (req.query.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const db = require('./db');
  const items = db.prepare("SELECT b.*, u.email FROM backlog b JOIN users u ON b.user_id = u.id ORDER BY b.created_at DESC").all();
  res.json({ backlog: items });
});

app.get('/api/admin/analytics', (req, res) => {
  if (req.query.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const db = require('./db');
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
  const totalDownloads = db.prepare("SELECT COUNT(*) as count FROM history").get().count;
  const byUser = db.prepare("SELECT u.email, COUNT(h.id) as count FROM users u JOIN history h ON u.id = h.user_id GROUP BY u.id").all();
  const byDay = db.prepare("SELECT date(created_at) as date, COUNT(*) as count FROM history GROUP BY date(created_at) ORDER BY date DESC LIMIT 30").all();
  
  res.json({ totalUsers, totalDownloads, byUser, byDay });
});

app.post('/api/admin/backlog/fulfill', (req, res) => {
  if (req.body.token !== adminToken()) return res.status(401).json({ error: 'Unauthorized' });
  const { id, cloudUrl1, cloudUrl2, isLocal } = req.body;
  const db = require('./db');
  const item = db.prepare('SELECT * FROM backlog WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  try {
    db.prepare("UPDATE backlog SET status = 'completed' WHERE id = ?").run(id);
    db.prepare('INSERT OR IGNORE INTO history (id, user_id, video_url, is_clip, clip_start, clip_end) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.id, item.user_id, item.video_url, item.is_clip ? 1 : 0, item.clip_start || null, item.clip_end || null);
    
    if (cloudUrl1) db.prepare('UPDATE history SET uploaded_url = ? WHERE id = ?').run(cloudUrl1, item.id);
    if (cloudUrl2) db.prepare('UPDATE history SET uploaded_url_2 = ? WHERE id = ?').run(cloudUrl2, item.id);
    
    if (item.notify_email) {
       const u = db.prepare('SELECT email FROM users WHERE id = ?').get(item.user_id);
       if (u && u.email) {
          const { sendEmail } = require('./mailer');
          let extraTxt = '\n\nYou can access it from your dashboard.';
          if (cloudUrl1 || cloudUrl2) {
              extraTxt = `\n\nCloud Links:\n`;
              if (cloudUrl1) extraTxt += `${cloudUrl1}\n`;
              if (cloudUrl2) extraTxt += `${cloudUrl2}\n`;
          }
          sendEmail(u.email, 'Your Video Download is Ready!', `Your requested video has been successfully downloaded by Ekkoscope.\n\nVideo URL: ${item.video_url}${extraTxt}`);
       }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 24-Hour Cleanup Routine ──────────────────────────────────────────────────
setInterval(() => {
  try {
    const tmpDir = path.join(__dirname, 'tmp_jobs');
    if (!fs.existsSync(tmpDir)) return;
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    fs.readdirSync(tmpDir).forEach(folder => {
      const folderPath = path.join(tmpDir, folder);
      const stats = fs.statSync(folderPath);
      if (now - stats.mtimeMs > maxAge) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`[Cleanup] Deleted expired job folder: ${folder}`);
      }
    });
    
    // Also clean up old jobs from memory map
    for (const [id, job] of jobs.entries()) {
      if (job.status === 'complete' || job.status === 'error') {
        if (now - job.startTime > maxAge) jobs.delete(id);
      }
    }
  } catch (err) {
    console.error('[Cleanup Error]', err);
  }
}, 60 * 60 * 1000); // Run every hour

// ─── Background Backlog Worker ────────────────────────────────────────────────
let backlogTimer = null;

async function processBacklog() {
  try {
    const db = require('./db');
    // Fetch interval in minutes, default 15
    const intervalStr = db.prepare("SELECT value FROM settings WHERE key = 'retry_interval'").get()?.value;
    const intervalMin = parseInt(intervalStr, 10) || 15;
    
    // Process 1 pending item
    const item = db.prepare("SELECT b.*, u.email FROM backlog b JOIN users u ON b.user_id = u.id WHERE b.status = 'pending' LIMIT 1").get();
    
    if (item) {
      console.log(`[Backlog Worker] Retrying job ${item.id} for ${item.email}`);
      db.prepare("UPDATE backlog SET status = 'retrying' WHERE id = ?").run(item.id);
      
      const gifDurationStr = db.prepare("SELECT value FROM settings WHERE key = 'gif_duration'").get()?.value;
      const gifDuration = parseInt(gifDurationStr, 10) || 3;
      
      const jobId = item.id;
      const job = {
        id: jobId, status: 'queued', progress: 0, eta: null,
        filePath: null, error: null, clients: [],
        clipMode: !!item.is_clip, clipStart: item.clip_start || 0,
        clipEnd: item.clip_end || null, url: item.video_url, startTime: Date.now(), chunksStolen: 0,
        userId: item.user_id,
        // Override broadcast to hook into completion
        isBacklogRetry: true,
        backlogId: item.id,
        notifyEmail: item.notify_email,
        userEmail: item.email,
        gifDuration: gifDuration
      };
      
      jobs.set(jobId, job);
      
      try {
        await startDownload(job, sessionMgr, async (j) => {
          if (j.status === 'complete' && !j.backlogHandled) {
            j.backlogHandled = true;
            db.prepare("UPDATE backlog SET status = 'completed' WHERE id = ?").run(j.backlogId);
            db.prepare('INSERT INTO history (id, user_id, video_url, is_clip, clip_start, clip_end) VALUES (?, ?, ?, ?, ?, ?)').run(j.id, j.userId, j.url, j.clipMode ? 1 : 0, j.clipStart || null, j.clipEnd || null);
            
            const setting1 = db.prepare("SELECT value FROM settings WHERE key = 'upload_api_key'").get();
            const apiKey1 = setting1 ? setting1.value : null;
            const setting2 = db.prepare("SELECT value FROM settings WHERE key = 'upload_api_key_2'").get();
            const apiKey2 = setting2 ? setting2.value : null;
            
            let cloudUrls = [];
            if (apiKey1) {
               try {
                  console.log(`[Backlog Worker] Starting DoodAPI cloud upload for ${j.id}`);
                  cloudUrls.push(await uploadVideoToCloud(j.id, j.filePath, apiKey1));
               } catch (e) {
                  console.error(`[Backlog Worker] DoodAPI Upload failed:`, e.message);
               }
            }
            if (apiKey2) {
               try {
                  console.log(`[Backlog Worker] Starting KrakenFiles cloud upload for ${j.id}`);
                  cloudUrls.push(await uploadToKrakenFiles(j.id, j.filePath, apiKey2));
               } catch (e) {
                  console.error(`[Backlog Worker] KrakenFiles Upload failed:`, e.message);
               }
            }

            if (j.notifyEmail) {
              const { sendEmail } = require('./mailer');
              let extraTxt = '';
              if (cloudUrls.length > 0) extraTxt = `\n\nCloud Links:\n` + cloudUrls.join('\n');
              else extraTxt = `\n\nYou can access it from your dashboard.`;
              sendEmail(j.userEmail, 'Your Video Download is Ready!', `Your requested video has been successfully downloaded by Ekkoscope.\n\nVideo URL: ${j.url}${extraTxt}`);
            }
          } else if (j.status === 'error' && !j.backlogHandled) {
            j.backlogHandled = true;
            db.prepare("UPDATE backlog SET status = 'pending' WHERE id = ?").run(j.backlogId);
          }
        });
      } catch (err) {
        db.prepare("UPDATE backlog SET status = 'pending' WHERE id = ?").run(item.id);
      }
    }
    
    backlogTimer = setTimeout(processBacklog, intervalMin * 60 * 1000);
  } catch (err) {
    console.error('[Backlog Worker Error]', err);
    backlogTimer = setTimeout(processBacklog, 15 * 60 * 1000); // 15 min fallback
  }
}

// Start worker slightly after boot
setTimeout(processBacklog, 10000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Ekkoscope Web Platform running at http://localhost:${PORT}`);
  console.log(`🔑 Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`🧪 Bypass code: ${BYPASS_CODE}`);
  console.log(`🍪 Session status: ${sessionMgr.getStatus().cookiesSet ? '✅ Cookies loaded' : '⚠️  No cookies — visit admin panel'}\n`);
});
