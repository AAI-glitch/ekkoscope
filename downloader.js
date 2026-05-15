const puppeteer = require('puppeteer');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const TMP_DIR   = path.join(__dirname, 'tmp_jobs');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const REMOTE_DEBUG_URL = 'http://localhost:9222';

// ─── Connect to real browser via remote debugging ─────────────────────────────
async function connectToRealBrowser() {
  // Use Node's built-in http to fetch CDP endpoint info
  const wsUrl = await new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:9222/json/version', { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.webSocketDebuggerUrl);
        } catch(e) { reject(new Error('Invalid CDP response')); }
      });
    });
    req.on('error', () => reject(new Error(
      'Browser not running on port 9222. Make sure you ran launch-browser.bat and Brave is open.'
    )));
    req.on('timeout', () => { req.destroy(); reject(new Error('Browser connection timed out.')); });
  });

  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
  return browser;
}

// ─── Read PTS timestamp from raw .ts binary ───────────────────────────────────
function readPTS(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  for (let i = 0; i < data.length - 20; i += 188) {
    if (data[i] !== 0x47) continue;
    if (!(data[i + 1] & 0x40)) continue;
    let afc = (data[i + 3] & 0x30) >> 4;
    let off  = i + 4;
    if (afc === 2 || afc === 3) off += 1 + data[i + 4];
    if (off >= i + 188) continue;
    if (data[off] === 0 && data[off+1] === 0 && data[off+2] === 1) {
      const streamId = data[off+3];
      if (streamId >= 0xE0 && streamId <= 0xEF) {
        const ptsDtsFlags = data[off+7] >> 6;
        if (ptsDtsFlags >= 2) {
          const p   = off + 9;
          const top = (data[p]   & 0x0E) >> 1;
          const mid = (data[p+1] << 7) | ((data[p+2] & 0xFE) >> 1);
          const bot = (data[p+3] << 7) | ((data[p+4] & 0xFE) >> 1);
          return ((top * 1073741824) + (mid * 32768) + bot) / 90000;
        }
      }
    }
  }
  return null;
}

// ─── Main downloader ──────────────────────────────────────────────────────────
async function startDownload(job, sessionMgr, broadcast) {
  const jobDir = path.join(TMP_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  job.status = 'launching';
  broadcast(job);

  // Connect to the user's real Brave/Chrome browser
  const browser = await connectToRealBrowser();

  const chunkBuffers = [];
  let   chunkSeq     = 0;
  let   page         = null;
  let   resumeStart  = 0;

  try {
    const statePath = path.join(jobDir, 'state.json');
    if (fs.existsSync(statePath)) {
      try {
        const stateData = JSON.parse(fs.readFileSync(statePath));
        if (stateData.resumeStart) resumeStart = stateData.resumeStart;
        if (stateData.chunkSeq) chunkSeq = stateData.chunkSeq;
        console.log(`[Downloader] Resuming job ${job.id} from ${resumeStart.toFixed(1)}s, sequence ${chunkSeq}`);
      } catch(e) {}
    }

    const existingChunks = fs.readdirSync(jobDir).filter(f => f.startsWith('chunk_') && f.endsWith('.ts'));
    for (const f of existingChunks) {
      const match = f.match(/chunk_(\d+)\.ts/);
      if (match) {
        const seq = parseInt(match[1], 10);
        const file = path.join(jobDir, f);
        try {
          const buf = fs.readFileSync(file);
          const pts = readPTS(buf);
          chunkBuffers.push({ seq, file, pts });
          chunkSeq = Math.max(chunkSeq, seq + 1);
        } catch(e) {}
      }
    }
    chunkBuffers.sort((a,b) => a.seq - b.seq);

    // ── Open a new tab (don't disturb the user's existing tabs) ──────────────
    page = await browser.newPage();

    // ── Inject Authentication Cookies ─────────────────────────────────────────
    if (sessionMgr && sessionMgr.cookies) {
      const cookieArray = sessionMgr.cookies.split(';').map(part => {
        const [name, ...rest] = part.trim().split('=');
        return { name: name?.trim(), value: rest.join('=').trim(), domain: '.recu.me' };
      }).filter(c => c.name && c.value);
      if (cookieArray.length > 0) {
        await page.setCookie(...cookieArray);
        console.log(`[Downloader] Injected ${cookieArray.length} cookies into page.`);
      }
    }

    // ── Expose a Node.js function the page can call with each chunk ───────────
    // This is the SAME approach as the extension (hook.js):
    // We hook XHR + fetch inside the page's JS context so we can intercept
    // .ts chunk ArrayBuffers BEFORE Chrome's cross-origin restrictions block CDP.
    await page.exposeFunction('__ekkoscopeChunk__', async (base64Data, url) => {
      try {
        const buf = Buffer.from(base64Data, 'base64');
        if (buf.length > 500) {
          const pts = readPTS(buf);
          const file = path.join(jobDir, `chunk_${String(chunkSeq).padStart(6, '0')}.ts`);
          fs.writeFileSync(file, buf);
          chunkBuffers.push({ seq: chunkSeq++, file, pts });
          if (chunkSeq % 5 === 0 || chunkSeq === 1) {
            console.log(`[Downloader] Chunk #${chunkSeq-1} (${(buf.length/1024).toFixed(0)}KB, PTS:${pts != null ? pts.toFixed(1)+'s' : 'n/a'})`);
          }
        }
      } catch(e) { console.error('[Chunk CB]', e.message); }
    });

    // ── Inject the EXACT same XHR hook as hook.js extension ──────────────────
    // Key: hook the 'response' GETTER (not responseType/send) so hls.js's own
    // internal reads are intercepted. Setting responseType breaks the player.
    await page.evaluateOnNewDocument(() => {
      const origOpen = window.XMLHttpRequest.prototype.open;

      window.XMLHttpRequest.prototype.open = function(method, url) {
        this._ekkoUrl = url;
        if (url && url.includes('.ts')) {
          const origGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response')?.get;
          if (origGetter) {
            Object.defineProperty(this, 'response', {
              get: function() {
                const res = origGetter.call(this);
                if (res && this.readyState === 4 && !this._ekkoStolen) {
                  this._ekkoStolen = true;
                  try {
                    if (res instanceof ArrayBuffer) {
                      const copy   = res.slice(0);
                      const bytes  = new Uint8Array(copy);
                      let binary   = '';
                      const CHUNK  = 8192;
                      for (let i = 0; i < bytes.length; i += CHUNK) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
                      }
                      window.__ekkoscopeChunk__(btoa(binary), url).catch(() => {});
                    }
                  } catch(e) {}
                }
                return res;
              },
              configurable: true
            });
          }
        }
        return origOpen.apply(this, arguments);
      };
    });

    // ── Navigate to video page ────────────────────────────────────────────────
    job.status = 'navigating';
    broadcast(job);

    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait a bit for JS to settle (avoids networkidle2 timeout on streaming pages)
    await new Promise(r => setTimeout(r, 2000));


    // Verify we're on the right page (not a login redirect)
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
      throw new Error(
        'Redirected to login page. Please log into recu.me in the browser that was launched ' +
        'by "launch-browser.bat" and try again.'
      );
    }

    // ── Check for Bot/CAPTCHA Challenge ─────────────────────────────────────────
    const isBotCheck = await page.evaluate(() => {
      return !!(
        document.querySelector('.cf-turnstile') ||
        document.querySelector('#challenge-running') ||
        document.querySelector('iframe[src*="cloudflare"]') ||
        document.querySelector('iframe[src*="challenge"]') ||
        document.querySelector('.g-recaptcha') ||
        document.querySelector('.h-captcha') ||
        document.title.toLowerCase().includes('just a moment') ||
        document.title.toLowerCase().includes('attention required')
      );
    });

    if (isBotCheck) {
      throw new Error('Manual Bot Check Required: Cloudflare or CAPTCHA challenge detected. Please solve it manually in the server browser.');
    }


    // ── Step 1: Click recu.me's play button to initialise the player ────────────────
    // The <video> element does NOT exist until after #play_button is clicked.
    job.status = 'stealing';
    broadcast(job);

    // Wait for the splash/play button to appear
    await page.waitForSelector('#play_button, .video-play-button, .video-splash-big', { timeout: 15000 })
      .catch(() => console.log('[Downloader] Play button not found, trying anyway...'));

    // Click the play button
    await page.evaluate(() => {
      const btn = document.getElementById('play_button')
        || document.querySelector('.video-play-button')
        || document.querySelector('.video-splash-big')
        || document.querySelector('[class*="play"]');
      if (btn) btn.click();
    });
    console.log('[Downloader] 🎬 Clicked play button');

    // ── Step 2: Wait for the <video> element to appear (player initialises after click) ──
    const videoEl = await page.waitForSelector('video', { timeout: 20000 }).catch(() => null);
    if (!videoEl) {
      throw new Error('Video player did not initialise after clicking play. Make sure you are logged in with a premium account in the Brave browser.');
    }

    // ── Step 3: Start playback + seek-loop to steal chunks ───────────────────
    // We do NOT set playbackRate=16 — HLS only buffers ~30s ahead, so at 16x
    // the buffer runs dry in 2s causing repeated stalls until the player dies.
    // Instead: play muted at 1x, then every tick seek to the buffer edge.
    // This keeps the player healthy while forcing continuous segment loading.
    await page.evaluate((clipMode, clipStart, resumeStart) => {
      const v = document.querySelector('video');
      if (!v) return;
      v.muted  = true;
      v.volume = 0;
      let startPos = clipMode && clipStart > 0 ? clipStart : 0;
      if (resumeStart > startPos) startPos = resumeStart;
      if (startPos > 0) v.currentTime = startPos;
      v.play().catch(() => {});
    }, job.clipMode, job.clipStart || 0, resumeStart);

    // Wait for first chunk to arrive
    await new Promise(r => setTimeout(r, 2000));

    // ── Seek-loop ─────────────────────────────────────────────────────────────
    const scrubStart   = Date.now();
    let   lastCount    = 0;
    let   stuckCounter = 0;
    const STUCK_LIMIT  = 40; // 40 × 500ms = 20s idle = done

    while (true) {
      await new Promise(r => setTimeout(r, 500));

      const state = await page.evaluate((clipMode, clipStart, clipEnd) => {
        const v = document.querySelector('video');
        if (!v) return { done: true, gone: true, currentTime: 0, duration: 0 };

        // Force jump if we are far behind the start time in clip mode
        if (clipMode && clipStart > 0 && v.currentTime < clipStart - 5) {
          v.currentTime = Math.max(0, clipStart - 2);
        }

        // Find furthest buffered end near current position
        let bufferedEnd = v.currentTime;
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= v.currentTime + 5) {
            bufferedEnd = Math.max(bufferedEnd, v.buffered.end(i));
          }
        }

        const target = clipMode ? clipEnd : v.duration;

        // Done when buffered far enough
        if (target && bufferedEnd >= target - 2) {
          // If we are doing a full download and the duration is suspiciously small (under 5 seconds), 
          // it might be a pre-roll ad, a splash screen, or metadata hasn't fully loaded yet. 
          // We should NOT consider it done.
          if (!clipMode && target < 5) {
            return { done: false, currentTime: v.currentTime, bufferedEnd, duration: v.duration };
          }
          
          v.pause();
          return { done: true, currentTime: v.currentTime, bufferedEnd, duration: v.duration };
        }

        // Seek to near buffer edge to load next segments
        if (bufferedEnd > v.currentTime + 8) {
          v.currentTime = bufferedEnd - 2;
        }

        // Resume if stalled
        if (v.paused && !v.ended) v.play().catch(() => {});

        return { done: false, currentTime: v.currentTime, bufferedEnd, duration: v.duration };
      }, job.clipMode, job.clipStart || 0, job.clipEnd || 999999);

      if (state.gone) {
        console.log(`[Downloader] ⚠️ Video element gone — player closed. Chunks: ${chunkBuffers.length}`);
        break;
      }

      if (state.done) {
        console.log(`[Downloader] ✅ Buffer done at ${state.bufferedEnd?.toFixed(1)}s / ${state.duration?.toFixed(1)}s. Chunks: ${chunkBuffers.length}`);
        break;
      }

      if (chunkBuffers.length === lastCount) {
        stuckCounter++;
        if (stuckCounter >= STUCK_LIMIT) {
          console.log(`[Downloader] ⚠️ 20s idle — stopping. Chunks: ${chunkBuffers.length}, pos: ${state.currentTime?.toFixed(1)}s, buf: ${state.bufferedEnd?.toFixed(1)}s`);
          break;
        }
      } else {
        stuckCounter = 0;
        lastCount    = chunkBuffers.length;
      }

      // Progress + ETA
      if (state.duration) {
        // Dynamic 1-hour splitting logic
        if (!job.hasSplit) {
          job.hasSplit = true;
          const targetEnd = job.clipMode && job.clipEnd ? job.clipEnd : state.duration;
          const start = job.clipMode && job.clipStart ? job.clipStart : 0;
          
          if (targetEnd - start > 3600) {
            console.log(`[Downloader] Video is > 1 hour, truncating to 1h and queuing the rest.`);
            job.clipMode = true;
            job.clipEnd = start + 3600;
            
            if (job.userId && !job.isBacklogRetry) {
              try {
                const db = require('./db');
                const { v4: uuidv4 } = require('uuid');
                
                let nextStart = start + 3600;
                let partNum = 2;
                while (nextStart < targetEnd) {
                  let nextEnd = Math.min(nextStart + 3600, targetEnd);
                  const backlogId = uuidv4();
                  db.prepare(`
                    INSERT INTO backlog (id, user_id, video_url, is_clip, clip_start, clip_end, notify_email, status)
                    VALUES (?, ?, ?, 1, ?, ?, ?, 'pending')
                  `).run(backlogId, job.userId, job.url, nextStart, nextEnd, job.notifyEmail ? 1 : 0);
                  console.log(`[Downloader] Queued backlog job for Part ${partNum} (${nextStart} to ${nextEnd})`);
                  nextStart += 3600;
                  partNum++;
                }
              } catch(e) {
                console.error('[Downloader] Failed to split into backlog jobs:', e);
              }
            }
          }
        }

        try {
          fs.writeFileSync(statePath, JSON.stringify({
            resumeStart: state.bufferedEnd > 2 ? state.bufferedEnd - 2 : 0,
            chunkSeq: chunkSeq
          }));
        } catch(e) {}

        const start   = job.clipMode ? (job.clipStart || 0) : 0;
        const end     = job.clipMode ? (job.clipEnd || state.duration) : state.duration;
        const prog    = Math.min(1, Math.max(0, (state.currentTime - start) / (end - start)));
        job.progress  = Math.round(prog * 85);
        const elapsed = (Date.now() - scrubStart) / 1000;
        job.eta       = prog > 0.02 && elapsed > 2 ? Math.round(elapsed / prog - elapsed) : null;
      }
      job.chunksStolen = chunkBuffers.length;
      broadcast(job);
    }

    // ── We have all the chunks, close the tab immediately to free RAM ──────────
    try { await page.close(); } catch(e) {}
    await browser.disconnect().catch(() => {});
    page = null;

    if (chunkBuffers.length === 0) {
      throw new Error('No video chunks captured. Make sure the video plays in the browser and the account has premium access.');
    }

    console.log(`[Downloader] Total: ${chunkBuffers.length} chunks captured`);

    // ── Filter chunks for clip mode ───────────────────────────────────────────
    job.status   = 'remuxing';
    job.progress = 88;
    broadcast(job);

    chunkBuffers.sort((a, b) => a.seq - b.seq);
    let toWrite = chunkBuffers;

    // Collect .ts file paths
    const chunkFiles = toWrite.map(c => c.file);

    // ── Remux with ffmpeg ─────────────────────────────────────────────────────
    const concatPath = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(
      concatPath,
      chunkFiles.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
    );

    const outputPath = path.join(jobDir, 'output.mp4');
    let   ffmpegCmd  = `ffmpeg -y -f concat -safe 0 -i "${concatPath}" -c copy -movflags +faststart "${outputPath}"`;

    job.progress = 95;
    broadcast(job);
    await execAsync(ffmpegCmd);

    // ── Extract exact duration ────────────────────────────────────────────────
    let videoDuration = 0;
    try {
      const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`);
      const dur = parseFloat(stdout);
      if (!isNaN(dur)) {
        job.duration = dur;
        videoDuration = dur;
      }
    } catch (e) {
      console.warn('[Downloader] Failed to extract duration:', e.message);
    }

    // ── Generate Thumbnail ────────────────────────────────────────────────────
    const thumbPath = path.join(jobDir, 'thumb.gif');
    try {
      const gifDur = job.gifDuration || 3;
      const gifStart = Math.max(0, videoDuration * 0.3); // Start roughly 30% into the video
      const filter = `fps=10,scale=250:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
      
      // Capture at normal speed
      await execAsync(`ffmpeg -v error -y -ss ${gifStart.toFixed(2)} -i "${outputPath}" -t ${gifDur} -vf "${filter}" -loop 0 "${thumbPath}"`);
    } catch(e) {
      console.warn('[Downloader] Failed to generate GIF thumbnail:', e.message);
      // Fallback to static jpg
      try {
        await execAsync(`ffmpeg -v error -y -i "${outputPath}" -vframes 1 -q:v 2 "${path.join(jobDir, 'thumb.jpg')}"`);
      } catch (err2) {}
    }

    // Cleanup .ts files
    chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    try { fs.unlinkSync(concatPath); } catch(e) {}

    job.status   = 'complete';
    job.progress = 100;
    job.eta      = 0;
    job.filePath = outputPath;
    broadcast(job);

  } catch(err) {
    if (page) { try { await page.close(); } catch(e) {} }
    if (browser) { await browser.disconnect().catch(() => {}); }
    // Intentionally keep jobDir so that the background worker can resume it later
    throw err;
  }
}

module.exports = { startDownload };
