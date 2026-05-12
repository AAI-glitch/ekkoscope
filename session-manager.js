/**
 * SessionManager — Auto-refreshes recu.me Cloudflare session cookies
 * using puppeteer-extra stealth plugin to silently solve CF JS challenges.
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin   = require('puppeteer-extra-plugin-stealth');
const EventEmitter    = require('events');

puppeteerExtra.use(StealthPlugin());

const SITE_URL         = 'https://recu.me';
const REFRESH_INTERVAL = 25 * 60 * 1000; // 25 min (CF clearance lasts ~30 min)
const CF_TIMEOUT       = 20 * 1000;       // max wait for CF to clear
const NAV_TIMEOUT      = 40 * 1000;

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.cookies      = '';
    this.email        = '';
    this.password     = '';
    this.lastRefresh  = null;
    this.isRefreshing = false;
    this.refreshTimer = null;
    this.status       = 'idle';
    this.failCount    = 0;
  }

  // ── Called when admin manually pastes cookies (optional) ─────────────────────
  setManualCookies(cookieStr) {
    this.cookies     = cookieStr;
    this.lastRefresh = Date.now();
    this.status      = 'ok';
    this.failCount   = 0;
    this.emit('updated', this.cookies);
  }

  // ── Called when admin sets email/password ─────────────────────────────────────
  setCredentials(email, password) {
    this.email    = email;
    this.password = password;
    this.status   = 'ok';
    console.log('[Session] Credentials saved for:', email);
    this.emit('updated', { email });
  }

  // ── Schedule next auto-refresh ──────────────────────────────────────────────
  _scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this._autoRefresh(), REFRESH_INTERVAL);
  }

  // ── Background auto-refresh using stealth Puppeteer ────────────────────────
  async _autoRefresh() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    this.status       = 'refreshing';
    this.emit('status', 'refreshing');
    console.log('[Session] Auto-refreshing Cloudflare clearance...');

    try {
      const fresh = await this._solveCFChallenge();
      if (fresh) {
        this.cookies     = fresh;
        this.lastRefresh = Date.now();
        this.status      = 'ok';
        this.failCount   = 0;
        console.log('[Session] ✅ Cookies auto-refreshed successfully.');
        this.emit('updated', this.cookies);
      } else {
        throw new Error('Empty cookie result');
      }
    } catch(e) {
      this.failCount++;
      this.status = 'failed';
      console.error(`[Session] ❌ Auto-refresh failed (attempt ${this.failCount}):`, e.message);
      this.emit('error', e.message);

      // Retry sooner on failure (every 2 min), up to 5 times
      const retryIn = this.failCount < 5 ? 2 * 60 * 1000 : REFRESH_INTERVAL;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this._autoRefresh(), retryIn);
    } finally {
      this.isRefreshing = false;
    }

    // Schedule next regular refresh regardless
    if (this.status === 'ok') this._scheduleRefresh();
  }

  // ── Launch stealthed Puppeteer, navigate to site, extract cookies ───────────
  async _solveCFChallenge() {
    const browser = await puppeteerExtra.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768',
        '--disable-gpu'
      ]
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });

      // Pre-inject existing cookies so Cloudflare sees a "returning" session
      if (this.cookies) {
        const existing = _parseCookieString(this.cookies, '.recu.me');
        if (existing.length > 0) await page.setCookie(...existing);
      }

      // Navigate to the site — stealth plugin handles the CF fingerprint check
      await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });

      // Wait for Cloudflare challenge to resolve (title changes from "Just a moment")
      const cfResolved = await page.waitForFunction(
        () => !document.title.toLowerCase().includes('just a moment') &&
              !document.title.toLowerCase().includes('attention required'),
        { timeout: CF_TIMEOUT }
      ).then(() => true).catch(() => false);

      if (!cfResolved) {
        // Still check if we got useful cookies even without full resolution
        const cookies = await page.cookies();
        const hasCF = cookies.some(c => c.name === 'cf_clearance');
        if (!hasCF) throw new Error('Cloudflare challenge not resolved — manual cookie refresh may be needed.');
      }

      // Extract all cookies as header string
      const cookies = await page.cookies();
      await browser.close();
      return cookies.map(c => `${c.name}=${c.value}`).join('; ');

    } catch(e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }

  // ── Force an immediate refresh (e.g., after a 403 download error) ───────────
  async forceRefresh() {
    if (this.isRefreshing) {
      // Wait for current refresh to finish
      return new Promise(resolve => this.once('updated', resolve));
    }
    return this._autoRefresh();
  }

  // ── Status snapshot for admin panel ─────────────────────────────────────────
  getStatus() {
    const age = this.lastRefresh ? Math.round((Date.now() - this.lastRefresh) / 1000) : null;
    const expiresIn = this.lastRefresh ? Math.max(0, Math.round((REFRESH_INTERVAL - (Date.now() - this.lastRefresh)) / 1000)) : null;
    return {
      credentialsSet: !!(this.email || this.cookies),
      emailSet:    !!this.email,
      cookiesSet:  !!this.cookies,
      email:       this.email ? this.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
      ageSecs:    age,
      expiresInSecs: expiresIn,
      failCount:  this.failCount
    };
  }
}

function _parseCookieString(str, domain) {
  return str.split(';').map(part => {
    const [name, ...rest] = part.trim().split('=');
    return { name: name?.trim(), value: rest.join('=').trim(), domain: domain || 'recu.me' };
  }).filter(c => c.name && c.value);
}

// Export a singleton
module.exports = new SessionManager();
