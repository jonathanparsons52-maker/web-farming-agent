const puppeteer = require('puppeteer-core');
const axios = require('axios');
const gmailService = require('./gmail-service');

const MAX_ROTATIONS_PER_SUCCESS = 20;

const FINGERPRINT_RESOLUTIONS = ['1920_1080', '1366_768', '1536_864', '1440_900', '1280_720', '1600_900', '1680_1050'];
const FINGERPRINT_WEBGL = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
];
const FINGERPRINT_UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
];
const FINGERPRINT_LANGUAGES = [['en-US', 'en'], ['en-GB', 'en'], ['en-CA', 'en']];
const FINGERPRINT_TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

const ADJECTIVES = ['Quick', 'Happy', 'Brave', 'Cool', 'Wild', 'Calm', 'Bold', 'Keen', 'Nice', 'True', 'Fair', 'Warm', 'Wise', 'Free', 'Fast'];
const NOUNS = ['Panda', 'Eagle', 'Tiger', 'Whale', 'Otter', 'Raven', 'Falcon', 'Wolf', 'Bear', 'Fox', 'Lynx', 'Owl', 'Hawk', 'Viper', 'Moose'];

function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateFingerprint() {
  const resolution = randomChoice(FINGERPRINT_RESOLUTIONS);
  const webgl = randomChoice(FINGERPRINT_WEBGL);
  return {
    ua: randomChoice(FINGERPRINT_UA),
    automatic_timezone: '0',
    timezone: randomChoice(FINGERPRINT_TIMEZONES),
    language: randomChoice(FINGERPRINT_LANGUAGES),
    platform: 'Win32',
    resolution,
    canvas: '1',
    webgl: '3',
    webgl_vendor: webgl.vendor,
    webgl_renderer: webgl.renderer,
    audio: '1',
    media_devices: '1',
    client_rects: '1',
    device_name_switch: '1',
    scan_port_type: '0',
    hardware_concurrency: String(Math.floor(Math.random() * 3) * 2 + 4),
    device_memory: String([4, 8, 16][Math.floor(Math.random() * 3)])
  };
}

async function clickButtonByText(page, textPatterns, logFn) {
  const EXCLUDE = ['sso', 'apple', 'google sign'];
  const candidates = [];

  const allButtons = await page.$$('button');
  for (const handle of allButtons) {
    try {
      const text = await page.evaluate(el => (el.textContent || '').trim(), handle);
      const lower = text.toLowerCase();
      if (EXCLUDE.some(ex => lower.includes(ex))) continue;
      let matched = false;
      for (const pattern of textPatterns) {
        if (lower === pattern || lower.includes(pattern)) { matched = true; break; }
      }
      if (!matched) continue;
      const box = await handle.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;
      candidates.push({ handle, text, box });
    } catch (e) {}
  }

  if (candidates.length > 0) {
    const target = candidates[candidates.length - 1];
    logFn(`     Clicking "${target.text}"...`);
    await page.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }), target.handle);
    await delay(500);
    const newBox = await target.handle.boundingBox();
    if (newBox) {
      await page.mouse.click(newBox.x + newBox.width / 2, newBox.y + newBox.height / 2);
    } else {
      await target.handle.click();
    }
    return true;
  }

  const patterns = textPatterns.map(p => p.toLowerCase());
  const shadowResult = await page.evaluate((pats, excludes) => {
    function deepFindButtons(root, results) {
      if (!root) return;
      const children = root.children || root.childNodes || [];
      for (const child of children) {
        if (child.tagName === 'BUTTON') {
          const text = (child.textContent || '').trim().toLowerCase();
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({ el: child, text, x: rect.x, y: rect.y, w: rect.width, h: rect.height });
          }
        }
        if (child.shadowRoot) deepFindButtons(child.shadowRoot, results);
        deepFindButtons(child, results);
      }
    }
    const results = [];
    deepFindButtons(document.body, results);
    const matched = results.filter(r => {
      if (excludes.some(ex => r.text.includes(ex))) return false;
      return pats.some(p => r.text === p || r.text.includes(p));
    });
    if (matched.length === 0) return { found: 0 };
    const target = matched[matched.length - 1];
    target.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = target.el.getBoundingClientRect();
    return { found: matched.length, text: target.text, cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) };
  }, patterns, EXCLUDE);

  if (shadowResult && shadowResult.found > 0) {
    logFn(`     Clicking "${shadowResult.text}" via Shadow DOM...`);
    await delay(500);
    await page.mouse.click(shadowResult.cx, shadowResult.cy);
    return true;
  }

  return false;
}

class CreationService {
  constructor() {
    this.running = false;
    this.cancelRequested = false;
    this.targetCount = 0;
    this.successCount = 0;
    this.failedCount = 0;
    this.rotationCount = 0;
    this.logs = [];
    this.currentProfileIds = new Set();
    this.createdAccounts = [];
    this._lockedProxies = new Set();
    this.concurrency = 1;
    this.visible = true;
    this.creationPassword = 'Crumpet1312';
    this.authUsername = '';
    this._adsPowerRequest = null;
    this._captchaSolver = null;
    this._logFn = null;
    this._browsers = null;
    this._loadData = null;
  }

  init({ adsPowerRequest, captchaSolver, logFn, browsers, loadData }) {
    this._adsPowerRequest = adsPowerRequest;
    this._captchaSolver = captchaSolver;
    this._logFn = logFn;
    this._browsers = browsers;
    this._loadData = loadData;
  }

  _log(msg, level = 'info') {
    const ts = new Date().toLocaleTimeString();
    const entry = { ts, message: msg, level };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    console.log(`[Creation] ${msg}`);
    if (this._logFn) this._logFn('INFO', `[Creation] ${msg}`);
  }

  getProgress() {
    return {
      running: this.running,
      targetCount: this.targetCount,
      successCount: this.successCount,
      failedCount: this.failedCount,
      attemptCount: this.successCount + this.failedCount,
      rotationCount: this.rotationCount,
      concurrency: this.concurrency,
      visible: this.visible,
      logs: this.logs.slice(-200),
      createdAccounts: this.createdAccounts
    };
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Math.min(10, parseInt(n) || 1));
    return { success: true, concurrency: this.concurrency };
  }

  setVisible(enabled) {
    this.visible = !!enabled;
    return { success: true, visible: this.visible };
  }

  async start(targetCount, password, authUsername) {
    if (this.running) return { success: false, message: 'Already running' };
    this.running = true;
    this.cancelRequested = false;
    this.targetCount = targetCount;
    this.successCount = 0;
    this.failedCount = 0;
    this.rotationCount = 0;
    this._nextSlotIdx = 0;
    this.currentProfileIds = new Set();
    this.createdAccounts = [];
    this._lockedProxies = new Set();
    this.logs = [];
    if (password) this.creationPassword = password;
    this.authUsername = authUsername || '';

    this._log(`Starting creation: target ${targetCount}, concurrency ${this.concurrency}`, 'action');
    this._runLoop().catch(e => {
      this._log(`Fatal loop error: ${e.message}`, 'error');
      this.running = false;
    });
    return { success: true, message: `Creation started (${this.concurrency} concurrent)` };
  }

  stop() {
    if (!this.running) return { success: false, message: 'Not running' };
    this.cancelRequested = true;
    return { success: true, message: 'Stop requested' };
  }

  async _createProfile(assignedProxyIdx) {
    const settings = this._loadData('settings');
    const proxies = this._loadData('proxies');

    const proxyIndex = assignedProxyIdx != null ? assignedProxyIdx : 0;
    const proxy = proxies.length > 0 ? proxies[proxyIndex % proxies.length] : null;
    const fp = generateFingerprint();
    const profileName = `WC_${Date.now()}`;

    let groupId = '0';
    try {
      const groupResult = await this._adsPowerRequest('/api/v1/group/list', 'GET', { page_size: 100 });
      const groups = groupResult.data?.data?.list || groupResult.data?.list || [];
      if (groups.length > 0) {
        groupId = groups[0].group_id || groups[0].id || '0';
      }
    } catch (e) {}

    const profileData = {
      name: profileName,
      group_id: groupId,
      domain_name: 'reddit.com',
      open_urls: ['https://www.reddit.com'],
      fingerprint_config: {
        browser_kernel_config: { version: '131', type: 'chrome' },
        ...fp
      }
    };

    if (proxy && proxy.host && proxy.port) {
      profileData.user_proxy_config = {
        proxy_soft: 'other',
        proxy_type: proxy.protocol || 'http',
        proxy_host: proxy.host,
        proxy_port: String(proxy.port),
        proxy_user: proxy.username || '',
        proxy_password: proxy.password || ''
      };
    }

    const result = await this._adsPowerRequest('/api/v1/user/create', 'POST', null, profileData);

    if (!result.success) {
      return { success: false, message: result.error || 'Failed to create profile' };
    }

    const apiData = result.data;
    this._log(`  API response: ${JSON.stringify(apiData).substring(0, 500)}`, 'info');
    let userId = null;

    if (apiData?.data?.user_id) userId = apiData.data.user_id;
    else if (apiData?.data?.id) userId = apiData.data.id;
    else if (apiData?.user_id) userId = apiData.user_id;
    else if (apiData?.id) userId = apiData.id;

    if (!userId) {
      this._log(`  No user_id in response, querying by name: ${profileName}`, 'warning');
      await delay(3000);
      const queryResult = await this._adsPowerRequest('/api/v1/user/list', 'GET', { page_size: 100 });
      if (queryResult.success && queryResult.data) {
        const list = queryResult.data?.data?.list || queryResult.data?.list || [];
        this._log(`  Found ${list.length} profiles in list`, 'info');
        const found = list.find(p =>
          (p.name || p.username || '') === profileName ||
          (p.name || '').includes(profileName)
        );
        if (found) userId = found.user_id || found.id;
      }
    }

    if (!userId) return { success: false, message: `Profile created but could not get user_id. Response: ${JSON.stringify(apiData).substring(0, 300)}` };

    return {
      success: true,
      profileId: userId,
      profileName,
      proxyIndex: proxyIndex + 1,
      proxyUsed: proxy ? `${proxy.host}:${proxy.port}` : 'none'
    };
  }

  async _openBrowser(profileId) {
    const launchArgs = this.visible ? [] : ['--window-position=-3000,-3000'];
    const result = await this._adsPowerRequest('/api/v1/browser/start', 'GET', {
      user_id: profileId,
      launch_args: JSON.stringify(launchArgs)
    });

    if (!result.success || !result.data?.data?.ws?.puppeteer) {
      return { success: false, error: result.error || 'No puppeteer WS endpoint' };
    }

    const wsEndpoint = result.data.data.ws.puppeteer;
    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
    this._browsers.set(profileId, browser);
    await delay(3000);
    const existingPages = await browser.pages();
    const page = existingPages[0] || await browser.newPage();
    try { await page.goto('about:blank', { timeout: 10000 }); } catch (e) {}
    await delay(2000);

    return { success: true, page, browser };
  }

  async _closeBrowser(profileId) {
    try {
      const browser = this._browsers.get(profileId);
      if (browser) {
        await browser.disconnect().catch(() => {});
        this._browsers.delete(profileId);
      }
    } catch (e) {}
    await this._adsPowerRequest('/api/v1/browser/stop', 'GET', { user_id: profileId });
  }

  async _deleteProfile(profileId) {
    await delay(2000);
    await this._adsPowerRequest('/api/v1/user/delete', 'POST', null, { user_ids: [profileId] });
  }

  async _cleanupProfile(profileId) {
    try {
      await this._closeBrowser(profileId);
      await delay(3000);
      await this._deleteProfile(profileId);
    } catch (e) {
      this._log(`Cleanup error for ${profileId}: ${e.message}`, 'error');
    }
  }

  async _scanForCaptcha(page) {
    return page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const url = window.location.href;
      const isGoogleSorry = url.includes('sorry') || bodyText.includes('unusual traffic') || bodyText.includes('automated queries');
      const hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"]') || !!document.querySelector('.g-recaptcha');
      const isHardBlock = isGoogleSorry && !hasRecaptcha && (bodyText.includes('systems have detected') || bodyText.includes('please try again later'));
      return { hasCaptcha: isGoogleSorry || hasRecaptcha, isHardBlock, isGoogleSorry, hasRecaptcha, url };
    }).catch(() => ({ hasCaptcha: false }));
  }

  async _solveGoogleCaptcha(page) {
    const settings = this._loadData('settings');
    const openaiKey = settings.openaiApiKey;
    if (!this._captchaSolver || !openaiKey) {
      this._log('  No captcha solver or OpenAI key available', 'error');
      return false;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      this._log(`  Captcha solve attempt ${attempt}/3...`, 'warning');
      const result = await this._captchaSolver.solveRecaptchaWithAudio(page, openaiKey, (msg) => this._log(`  ${msg}`, 'info'));
      if (result.success) {
        this._log('  Google captcha solved', 'success');
        await delay(3000);
        return true;
      }
      if (result.googleBlocked || result.needNewProxy) {
        this._log('  Google hard-blocked this IP', 'error');
        return false;
      }
      this._log(`  Solve attempt ${attempt} failed: ${result.message || 'Unknown'}`, 'error');
      if (attempt < 3) await delay(2000);
    }
    return false;
  }

  async _googleSearch(page, query) {
    this._log(`  Searching for "${query}" on Google...`, 'info');
    await page.evaluate((q) => {
      const input = document.querySelector('textarea[name="q"]') || document.querySelector('input[name="q"]');
      if (input) {
        input.focus();
        input.click();
        input.value = '';
        for (let i = 0; i < q.length; i++) {
          input.value += q[i];
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: q[i], code: 'Key' + q[i].toUpperCase() }));
        }
      }
    }, query);
    await delay(1000);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);
    await delay(3000);
  }

  async _warmUpGoogle(page) {
    this._log('  Navigating to google.com...', 'info');
    try {
      for (let navAttempt = 0; navAttempt < 3; navAttempt++) {
        try {
          await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 60000 });
          break;
        } catch (navErr) {
          const msg = navErr.message || '';
          if (msg.includes('detached') || msg.includes('destroyed') || msg.includes('closed')) {
            this._log(`  Navigation error (attempt ${navAttempt + 1}/3): ${msg} — retrying...`, 'warning');
            await delay(3000);
            const browser = this._browsers.values().next().value;
            if (browser) {
              const pages = await browser.pages();
              if (pages.length > 0) {
                page = pages[pages.length - 1];
              }
            }
            if (navAttempt === 2) throw navErr;
            continue;
          }
          throw navErr;
        }
      }
      await delay(3000);

      this._log('  Searching "google" to trigger captcha check...', 'info');
      await this._googleSearch(page, 'google');

      let scan = await this._scanForCaptcha(page);
      if (scan.hasCaptcha) {
        if (scan.isHardBlock) {
          this._log('  Google hard-blocked this IP — cannot solve', 'error');
          return { success: false, captchaFailed: true, message: 'Google hard block' };
        }
        this._log('  Google captcha detected — solving...', 'warning');
        const solved = await this._solveGoogleCaptcha(page);
        if (!solved) return { success: false, captchaFailed: true, message: 'Google captcha could not be solved' };
      }
      this._log('  Google warm-up passed', 'success');

      await this._googleSearch(page, 'reddit');

      scan = await this._scanForCaptcha(page);
      if (scan.hasCaptcha) {
        this._log('  Google captcha after reddit search — solving...', 'warning');
        if (scan.isHardBlock) return { success: false, captchaFailed: true, message: 'Google hard block after search' };
        const solved = await this._solveGoogleCaptcha(page);
        if (!solved) return { success: false, captchaFailed: true, message: 'Google captcha after search could not be solved' };
      }

      this._log('  Clicking Reddit link from Google results...', 'info');
      const clicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a')).filter(a => {
          if (!a.href || !a.href.includes('reddit.com')) return false;
          const rect = a.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const best = links.find(a => a.querySelector('h3')) || links[0];
        if (best) { best.click(); return true; }
        return false;
      });

      if (clicked) {
        await delay(5000);
        this._log('  Navigated to Reddit via Google search', 'success');
      } else {
        this._log('  No Reddit link found — navigating directly...', 'warning');
        await page.goto('https://www.reddit.com', { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
      }

      return { success: true, page };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _navigateToReddit(page) {
    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: (document.title || '').toLowerCase(),
      bodyText: (document.body?.innerText || '').substring(0, 1000).toLowerCase()
    })).catch(() => ({ url: '', title: '', bodyText: '' }));

    this._log(`  Current page: ${pageInfo.url}`, 'info');

    const isProveHumanity = pageInfo.title.includes('prove') ||
      pageInfo.bodyText.includes('prove your humanity') ||
      pageInfo.bodyText.includes('not for bots') ||
      pageInfo.bodyText.includes('complete the challenge') ||
      pageInfo.bodyText.includes('prove you') ||
      pageInfo.bodyText.includes('not a robot') ||
      pageInfo.bodyText.includes('verify you');

    if (isProveHumanity) {
      this._log('  Reddit "Prove your humanity" detected — solving Turnstile...', 'warning');
      const settings = this._loadData('settings');
      const captchaKey = settings.captchaApiKey;
      if (this._captchaSolver && captchaKey) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          this._log(`  Turnstile solve attempt ${attempt}/3...`, 'warning');
          try {
            const result = await this._captchaSolver.solveTurnstileOnPage(page, captchaKey, (msg) => this._log(`  ${msg}`, 'info'));
            if (result.success) {
              this._log('  Turnstile solved — Reddit should load now', 'success');
              await delay(5000);
              break;
            }
            this._log(`  Turnstile attempt ${attempt} failed: ${result.message || 'Unknown'}`, 'error');
          } catch (e) {
            if (e.message.includes('context was destroyed') || e.message.includes('navigation')) {
              this._log('  Page navigated during solve — captcha likely accepted', 'success');
              await delay(3000);
              break;
            }
            this._log(`  Turnstile attempt ${attempt} error: ${e.message}`, 'error');
          }
          if (attempt < 3) await delay(2000);
          if (attempt === 3) return { success: false, captchaFailed: true };
        }
      } else {
        this._log('  No Turnstile solver or API key available', 'error');
        return { success: false, captchaFailed: true };
      }
    }

    this._log('  Navigating to reddit.com/register/...', 'info');
    await page.goto('https://www.reddit.com/register/', { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);

    const regInfo = await page.evaluate(() => ({
      url: window.location.href,
      bodyText: (document.body?.innerText || '').substring(0, 500).toLowerCase()
    })).catch(() => ({ url: '', bodyText: '' }));

    if (regInfo.bodyText.includes('prove') || regInfo.bodyText.includes('not a robot') || regInfo.bodyText.includes('challenge')) {
      this._log('  Captcha on register page — solving Turnstile...', 'warning');
      const settings = this._loadData('settings');
      const captchaKey = settings.captchaApiKey;
      if (this._captchaSolver && captchaKey) {
        try {
          const result = await this._captchaSolver.solveTurnstileOnPage(page, captchaKey, (msg) => this._log(`  ${msg}`, 'info'));
          if (result.success) {
            this._log('  Register page Turnstile solved', 'success');
            await delay(5000);
          } else {
            return { success: false, captchaFailed: true };
          }
        } catch (e) {
          if (e.message.includes('context was destroyed') || e.message.includes('navigation')) {
            this._log('  Page navigated during solve — likely accepted', 'success');
            await delay(3000);
          } else {
            return { success: false, captchaFailed: true };
          }
        }
      }
    }

    const regUrl = page.url();
    this._log(`  On register page: ${regUrl}`, 'info');
    return { success: regUrl.includes('reddit.com') };
  }

  async _enterEmail(page) {
    this._log('  Generating temp email...', 'info');
    const emailResult = await gmailService.generateEmail();
    const email = (typeof emailResult === 'object' && emailResult.email) ? emailResult.email : emailResult;
    this._log(`  Email: ${email}`, 'success');

    await delay(4000);

    const emailSelectors = [
      'faceplate-text-input >>> input[name="email"]',
      'faceplate-text-input >>> input[type="email"]',
      'input[name="email"]',
      'input[type="email"]'
    ];

    let emailInput = null;
    for (const sel of emailSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { emailInput = el; break; }
      } catch (e) {}
    }

    let entered = false;
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await delay(300);
      await emailInput.type(email, { delay: 50 });
      await delay(500);
      await page.keyboard.press('Tab');
      await delay(1000);
      const val = await emailInput.evaluate(el => el.value);
      entered = val === email;
      if (!entered) {
        await page.evaluate((inp, em) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, em);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));
        }, emailInput, email);
        await delay(500);
        entered = (await emailInput.evaluate(el => el.value)) === email;
      }
    } else {
      entered = await page.evaluate((em) => {
        function deepFind(root) {
          if (!root) return null;
          const children = root.children || root.childNodes || [];
          for (const child of children) {
            if (child.tagName === 'INPUT') {
              const n = (child.name || '').toLowerCase();
              const t = (child.type || '').toLowerCase();
              if (n === 'email' || t === 'email') return child;
            }
            if (child.shadowRoot) { const f = deepFind(child.shadowRoot); if (f) return f; }
            const f = deepFind(child); if (f) return f;
          }
          return null;
        }
        const inp = deepFind(document.body);
        if (!inp) return false;
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(inp, em);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        return inp.value === em;
      }, email);
    }

    if (!entered) return { success: false, email };

    this._log('  Clicking Continue (email)...', 'info');
    await clickButtonByText(page, ['continue'], (m) => this._log(`  ${m}`, 'info'));
    await delay(3000);

    const afterClick = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      return {
        hasVerify: bodyText.includes('verify') || bodyText.includes('verification') || bodyText.includes('code'),
        hasCheckEmail: bodyText.includes('check your email') || bodyText.includes('sent') || bodyText.includes('check your inbox')
      };
    });

    if (!afterClick.hasVerify && !afterClick.hasCheckEmail) {
      await page.keyboard.press('Enter');
      await delay(3000);
    }

    return { success: true, email };
  }

  async _enterVerificationCode(page, email) {
    this._log('  Polling inbox for verification code...', 'info');
    const MAX_POLLS = 15;
    let verificationCode = null;

    for (let poll = 1; poll <= MAX_POLLS; poll++) {
      this._log(`  Inbox poll ${poll}/${MAX_POLLS}...`, 'info');
      try {
        const inbox = await gmailService.checkInbox(email);
        const messages = inbox.messages || [];

        for (const msg of messages) {
          const from = (msg.from || '').toLowerCase();
          const subject = msg.subject || '';
          if (!from.includes('reddit') && !subject.toLowerCase().includes('reddit')) continue;

          const codeMatch = subject.match(/(\d{6})/);
          if (codeMatch && codeMatch[1] !== '000000') {
            verificationCode = codeMatch[1];
            break;
          }

          try {
            const fullMsg = await gmailService.getMessage(email, msg.id);
            const bodyMatch = (fullMsg.body || '').match(/(\d{6})/);
            if (bodyMatch && bodyMatch[1] !== '000000') {
              verificationCode = bodyMatch[1];
              break;
            }
          } catch (e) {}
        }

        if (verificationCode) break;
      } catch (e) {
        this._log(`  Inbox poll error: ${e.message}`, 'error');
      }

      if (poll < MAX_POLLS) await delay(5000);
    }

    if (!verificationCode) return { success: false };

    this._log(`  Verification code: ${verificationCode}`, 'success');
    await delay(2000);

    let codeEntered = false;
    const codeSelectors = [
      'faceplate-text-input >>> input[name="code"]',
      'faceplate-text-input >>> input[type="text"]'
    ];

    for (const sel of codeSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await el.click({ clickCount: 3 });
            await el.type(verificationCode, { delay: 30 });
            const val = await page.evaluate(e => e.value, el);
            if (val === verificationCode) {
              codeEntered = true;
              break;
            }
            await page.evaluate((e, code) => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(e, code);
              e.dispatchEvent(new Event('input', { bubbles: true }));
              e.dispatchEvent(new Event('change', { bubbles: true }));
            }, el, verificationCode);
            codeEntered = true;
            break;
          }
        }
        if (codeEntered) break;
      } catch (e) {}
    }

    if (!codeEntered) return { success: false };

    await delay(1500);
    this._log('  Clicking Continue (verification)...', 'info');
    await clickButtonByText(page, ['continue', 'verify'], (m) => this._log(`  ${m}`, 'info'));
    await delay(4000);

    return { success: true };
  }

  async _enterUsernamePassword(page) {
    await delay(2000);
    const adj = randomChoice(ADJECTIVES);
    const noun = randomChoice(NOUNS);
    const suffix = Math.floor(Math.random() * 90000) + 10000;
    let username = `${adj}${noun}${suffix}`;
    this._log(`  Username: ${username}`, 'info');

    const usernameSelectors = [
      'faceplate-text-input >>> input[name="username"]',
      'input[name="username"]'
    ];

    for (const sel of usernameSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 0) {
            await el.click({ clickCount: 3 });
            await delay(200);
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await delay(200);
            await el.type(username, { delay: 40 });
            await delay(1000);

            const checkError = await page.evaluate(() => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              return bodyText.includes('already taken') || bodyText.includes('not available');
            });

            if (checkError) {
              username = `${adj}${noun}${Math.floor(Math.random() * 900000) + 100000}`;
              this._log(`  Username taken, trying: ${username}`, 'warning');
              await el.click({ clickCount: 3 });
              await delay(200);
              await page.keyboard.down('Control');
              await page.keyboard.press('a');
              await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
              await delay(200);
              await el.type(username, { delay: 40 });
              await delay(1500);
            }
            break;
          }
        }
      } catch (e) {}
    }

    const pwSelectors = [
      'faceplate-text-input >>> input[name="password"]',
      'faceplate-text-input >>> input[type="password"]',
      'input[name="password"]',
      'input[type="password"]'
    ];

    let pwEntered = false;
    for (const sel of pwSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await el.click({ clickCount: 3 });
            await el.type(this.creationPassword, { delay: 30 });
            pwEntered = true;
            break;
          }
        }
        if (pwEntered) break;
      } catch (e) {}
    }

    if (!pwEntered) {
      await page.keyboard.press('Tab');
      await delay(300);
      await page.keyboard.type(this.creationPassword, { delay: 30 });
    }

    await delay(2000);
    this._log('  Clicking Continue (username+password)...', 'info');
    await clickButtonByText(page, ['continue', 'sign up'], (m) => this._log(`  ${m}`, 'info'));
    await delay(4000);

    return { success: true, username };
  }

  async _enterBirthday(page) {
    await delay(3000);
    const MONTH = '12';
    const DAY = String(Math.floor(Math.random() * 14) + 12);
    const YEAR = String(Math.floor(Math.random() * 12) + 1990);
    this._log(`  Birthday: ${MONTH}/${DAY}/${YEAR}`, 'info');

    const values = [MONTH, DAY, YEAR];
    const dateInputSelectors = [
      'faceplate-text-input >>> input[name="month"]',
      'faceplate-text-input >>> input[name="day"]',
      'faceplate-text-input >>> input[name="year"]'
    ];

    let filled = 0;
    for (let i = 0; i < dateInputSelectors.length; i++) {
      try {
        const el = await page.$(dateInputSelectors[i]);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(values[i], { delay: 50 });
          filled++;
        }
      } catch (e) {}
    }

    if (filled < 3) {
      const jsFilled = await page.evaluate((vals) => {
        function deepFindInputs(root, results) {
          if (!root) return;
          const children = root.children || root.childNodes || [];
          for (const child of children) {
            if (child.tagName === 'INPUT' && child.type !== 'hidden') {
              const rect = child.getBoundingClientRect();
              const n = (child.name || '').toLowerCase();
              if (rect.width > 0 && rect.height > 0 && !['email', 'code', 'password', 'username'].includes(n) && child.type !== 'password') {
                results.push({ el: child, x: rect.x });
              }
            }
            if (child.shadowRoot) deepFindInputs(child.shadowRoot, results);
            deepFindInputs(child, results);
          }
        }
        const results = [];
        deepFindInputs(document.body, results);
        results.sort((a, b) => a.x - b.x);
        let count = 0;
        for (let i = 0; i < Math.min(results.length, 3); i++) {
          const inp = results[i].el;
          inp.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, vals[i]);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));
          count++;
        }
        return count;
      }, values);
      filled = Math.max(filled, jsFilled);
    }

    await delay(1500);
    this._log('  Clicking Continue (birthday)...', 'info');
    await clickButtonByText(page, ['continue'], (m) => this._log(`  ${m}`, 'info'));
    await delay(3000);
    await clickButtonByText(page, ['yes, confirm', 'yes', 'confirm', 'continue'], (m) => this._log(`  ${m}`, 'info'));
    await delay(3000);

    return { success: true };
  }

  async _selectGender(page) {
    await delay(3000);
    let clicked = await clickButtonByText(page, ['woman'], (m) => this._log(`  ${m}`, 'info'));
    if (!clicked) {
      clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent.toLowerCase().includes('woman') && b.offsetWidth > 0) {
            b.click();
            return true;
          }
        }
        return false;
      });
    }
    await delay(2000);
    return { success: true };
  }

  async _selectInterests(page) {
    await delay(3000);
    let clicked = false;

    const allBtns = await page.$$('button');
    for (const btn of allBtns) {
      try {
        const text = await page.evaluate(el => (el.textContent || '').trim(), btn);
        if (text.match(/ask\s*reddit/i)) {
          const box = await btn.boundingBox();
          if (box && box.width > 0) {
            await page.evaluate(el => el.scrollIntoView({ block: 'center' }), btn);
            await delay(300);
            const newBox = await btn.boundingBox();
            if (newBox) {
              await page.mouse.click(newBox.x + newBox.width / 2, newBox.y + newBox.height / 2);
            } else {
              await btn.click();
            }
            clicked = true;
            break;
          }
        }
      } catch (e) {}
    }

    if (!clicked) {
      const shadowClick = await page.evaluate(() => {
        function deepSearch(root, results) {
          if (!root) return;
          const children = root.children || root.childNodes || [];
          for (const child of children) {
            const tag = child.tagName;
            if (tag === 'BUTTON' || tag === 'LABEL' || tag === 'SPAN' || tag === 'DIV' || tag === 'LI' || tag === 'A') {
              const text = (child.textContent || '').trim();
              if (/ask\s*reddit/i.test(text)) {
                const rect = child.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  results.push({ el: child, cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) });
                }
              }
            }
            if (child.shadowRoot) deepSearch(child.shadowRoot, results);
            deepSearch(child, results);
          }
        }
        const results = [];
        deepSearch(document.body, results);
        if (results.length === 0) return null;
        const target = results[0];
        target.el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = target.el.getBoundingClientRect();
        return { cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) };
      });

      if (shadowClick) {
        await delay(500);
        await page.mouse.click(shadowClick.cx, shadowClick.cy);
        clicked = true;
      }
    }

    await delay(2000);
    await clickButtonByText(page, ['continue', 'next', 'done'], (m) => this._log(`  ${m}`, 'info'));
    await delay(3000);

    return { success: true };
  }

  _claimNextSlot() {
    if (this._nextSlotIdx >= this.targetCount) return null;
    return this._nextSlotIdx++;
  }

  _claimProxy() {
    const proxies = this._loadData('proxies');
    const count = Math.max(proxies.length, 1);
    for (let i = 0; i < count; i++) {
      if (!this._lockedProxies.has(i)) {
        this._lockedProxies.add(i);
        return i;
      }
    }
    return null;
  }

  _releaseProxy(idx) {
    this._lockedProxies.delete(idx);
  }

  async _runLoop() {
    const proxies = this._loadData('proxies');
    const proxyCount = Math.max(proxies.length, 1);
    const numWorkers = Math.min(this.concurrency, this.targetCount, proxyCount);
    if (numWorkers < this.concurrency) {
      this._log(`Concurrency capped to ${numWorkers} (${proxyCount} proxies available)`, 'warning');
    }
    const workers = [];
    for (let w = 0; w < numWorkers; w++) {
      if (w > 0) {
        await delay(2000);
        if (this.cancelRequested) break;
      }
      workers.push(this._workerLoop(w));
    }
    await Promise.all(workers);

    this._log(`JOB COMPLETE - Succeeded: ${this.successCount}/${this.targetCount}, Rotations: ${this.rotationCount}, Failed: ${this.failedCount}`, 'info');
    this.running = false;
  }

  async _workerLoop(workerIdx) {
    const wTag = this.concurrency > 1 ? `W${workerIdx + 1}` : '';
    while (!this.cancelRequested) {
      const slot = this._claimNextSlot();
      if (slot === null) break;
      const proxyIdx = this._claimProxy();
      if (proxyIdx === null) {
        this._log(`${wTag} No free proxy available — waiting...`, 'warning');
        await delay(5000);
        this._nextSlotIdx--;
        continue;
      }
      try {
        await this._processSlot(slot, wTag, proxyIdx);
      } finally {
        this._releaseProxy(proxyIdx);
      }
    }
  }

  async _rotateProxy(proxyIndex) {
    const proxies = this._loadData('proxies');
    const proxy = proxies[proxyIndex % Math.max(proxies.length, 1)];
    if (!proxy || !proxy.rotateToken) {
      this._log(`  No rotate token for proxy #${proxyIndex + 1} - skipping rotation`, 'warning');
      return true;
    }

    let token = proxy.rotateToken;
    if (token.includes('token=')) {
      const match = token.match(/token=([^&\s]+)/);
      if (match) token = match[1];
    }
    token = token.trim().replace(/\/$/, '');

    while (!this.cancelRequested) {
      this._log(`  Rotating proxy #${proxyIndex + 1} (${proxy.name || proxy.host})...`, 'info');
      try {
        const response = await axios.get('https://gridpanel.net/api/reboot', {
          params: { token }, timeout: 30000, validateStatus: () => true
        });
        if (response.data?.success) {
          this._log(`  Proxy rotation initiated - waiting 40s for new IP...`, 'info');
          await delay(40000);
          this._log(`  Proxy rotation complete`, 'success');
          return true;
        }
        const reason = response.data?.reason || response.data?.error || 'Unknown error';
        this._log(`  Proxy rotation failed: ${reason} - retrying in 30s...`, 'warning');
      } catch (e) {
        this._log(`  Proxy rotation error: ${e.message} - retrying in 30s...`, 'warning');
      }
      await delay(30000);
    }
    return false;
  }

  async _processSlot(slot, wTag, assignedProxyIdx) {
    const slotLabel = wTag ? `${wTag} ` : '';
    this._log(`${slotLabel}Starting slot ${slot + 1}/${this.targetCount} (proxy #${assignedProxyIdx + 1})`, 'info');

    let slotSuccess = false;
    let rotationsThisSlot = 0;

    while (!slotSuccess && rotationsThisSlot <= MAX_ROTATIONS_PER_SUCCESS && !this.cancelRequested) {
      const attemptStart = Date.now();
      const lbl = `${slotLabel}[${slot + 1}/${this.targetCount} #${rotationsThisSlot + 1}]`;

      this._log(`${lbl} STEP 0/11 - Rotating proxy #${assignedProxyIdx + 1} before creation...`, 'action');
      const rotated = await this._rotateProxy(assignedProxyIdx);
      if (!rotated) {
        this._log(`${lbl} STEP 0 CANCELLED`, 'warning');
        break;
      }
      this._log(`${lbl} STEP 0 OK - Proxy rotated`, 'success');

      this._log(`${lbl} STEP 1/11 - Creating WC profile...`, 'action');
      const createResult = await this._createProfile(assignedProxyIdx);
      if (!createResult.success) {
        this._log(`${lbl} STEP 1 FAILED - ${createResult.message}`, 'error');
        await delay(5000);
        rotationsThisSlot++;
        this.rotationCount++;
        continue;
      }

      const { profileId, profileName, proxyUsed, proxyIndex: proxyNum } = createResult;
      this.currentProfileIds.add(profileId);
      this._log(`${lbl} STEP 1 OK - ${profileId} (proxy: ${proxyUsed})`, 'success');

      this._log(`${lbl} STEP 2/11 - Opening browser...`, 'action');
      let page = null;
      try {
        const openResult = await this._openBrowser(profileId);
        if (!openResult.success) throw new Error(openResult.error);
        page = openResult.page;
        this._log(`${lbl} STEP 2 OK - Browser ready`, 'success');
      } catch (e) {
        this._log(`${lbl} STEP 2 FAILED - ${e.message}`, 'error');
        await this._cleanupProfile(profileId);
        this.currentProfileIds.delete(profileId);
        rotationsThisSlot++;
        this.rotationCount++;
        continue;
      }

      this._log(`${lbl} STEP 3/11 - Google warm-up...`, 'action');
      const warmupResult = await this._warmUpGoogle(page);
      if (!warmupResult.success) {
        this._log(`${lbl} STEP 3 FAILED - ${warmupResult.message || 'Captcha failed'}`, 'error');
        await this._cleanupProfile(profileId);
        this.currentProfileIds.delete(profileId);
        rotationsThisSlot++;
        this.rotationCount++;
        continue;
      }
      if (warmupResult.page) page = warmupResult.page;
      this._log(`${lbl} STEP 3 OK`, 'success');

      this._log(`${lbl} STEP 4/11 - Reddit navigation...`, 'action');
      let onReddit = false;
      try {
        const redditResult = await this._navigateToReddit(page);
        if (redditResult.captchaFailed) {
          this._log(`${lbl} STEP 4 FAILED - Reddit captcha`, 'error');
          await this._cleanupProfile(profileId);
          this.currentProfileIds.delete(profileId);
          rotationsThisSlot++;
          this.rotationCount++;
          continue;
        }
        onReddit = redditResult.success;
        if (!onReddit) {
          this._log(`${lbl} STEP 4 FAILED - Not on Reddit`, 'error');
          await this._cleanupProfile(profileId);
          this.currentProfileIds.delete(profileId);
          rotationsThisSlot++;
          this.rotationCount++;
          continue;
        }
      } catch (e) {
        this._log(`${lbl} STEP 4 FAILED - ${e.message}`, 'error');
        await this._cleanupProfile(profileId);
        this.currentProfileIds.delete(profileId);
        rotationsThisSlot++;
        this.rotationCount++;
        continue;
      }
      this._log(`${lbl} STEP 4 OK`, 'success');

      this._log(`${lbl} STEP 5/11 - Email entry...`, 'action');
      let emailResult;
      try {
        emailResult = await this._enterEmail(page);
      } catch (e) {
        emailResult = { success: false };
        this._log(`${lbl} STEP 5 FAILED - ${e.message}`, 'error');
      }
      if (!emailResult.success) {
        this._log(`${lbl} STEP 5 FAILED`, 'error');
        await this._cleanupProfile(profileId);
        this.currentProfileIds.delete(profileId);
        rotationsThisSlot++;
        this.rotationCount++;
        continue;
      }
      this._log(`${lbl} STEP 5 OK - ${emailResult.email}`, 'success');

      this._log(`${lbl} STEP 6/11 - Verification code...`, 'action');
      let step6Ok = false;
      try {
        const verifyResult = await this._enterVerificationCode(page, emailResult.email);
        step6Ok = verifyResult.success;
      } catch (e) {
        this._log(`${lbl} STEP 6 error: ${e.message}`, 'error');
      }
      if (!step6Ok) {
        this._log(`${lbl} STEP 6 FAILED`, 'error');
        await this._cleanupProfile(profileId);
        this.currentProfileIds.delete(profileId);
        rotationsThisSlot++;
        this.rotationCount++;
        continue;
      }
      this._log(`${lbl} STEP 6 OK`, 'success');

      this._log(`${lbl} STEP 7/11 - Username + password...`, 'action');
      let redditUsername = null;
      try {
        const upResult = await this._enterUsernamePassword(page);
        redditUsername = upResult.username || null;
        this._log(`${lbl} STEP 7 OK - ${redditUsername || 'entered'}`, 'success');
      } catch (e) {
        this._log(`${lbl} STEP 7 error: ${e.message}`, 'error');
      }

      if (redditUsername) {
        const newName = `${redditUsername}-proxy${proxyNum}${this.authUsername ? '-' + this.authUsername : ''}`;
        this._log(`${lbl} Renaming profile to ${newName}...`, 'info');
        try {
          let renameResult = await this._adsPowerRequest('/api/v1/user/update', 'POST', null, { user_id: profileId, name: newName });
          if (!renameResult.success) {
            renameResult = await this._adsPowerRequest('/api/v2/user/update', 'POST', null, { user_id: profileId, name: newName });
          }
          if (renameResult.success) {
            this._log(`${lbl} Renamed profile → ${newName}`, 'success');
          } else {
            this._log(`${lbl} Rename response: ${JSON.stringify(renameResult.data || renameResult.error).substring(0, 200)}`, 'warning');
          }
        } catch (e) {
          this._log(`${lbl} Rename failed: ${e.message}`, 'error');
        }
      } else {
        this._log(`${lbl} No reddit username captured - profile stays as ${profileName}`, 'warning');
      }

      this._log(`${lbl} STEP 8/11 - Birthday...`, 'action');
      try {
        await this._enterBirthday(page);
        this._log(`${lbl} STEP 8 OK`, 'success');
      } catch (e) {
        this._log(`${lbl} STEP 8 error: ${e.message}`, 'error');
      }

      this._log(`${lbl} STEP 9/11 - Gender...`, 'action');
      try {
        await this._selectGender(page);
        this._log(`${lbl} STEP 9 OK`, 'success');
      } catch (e) {
        this._log(`${lbl} STEP 9 error: ${e.message}`, 'error');
      }

      this._log(`${lbl} STEP 10/11 - Interests...`, 'action');
      try {
        await this._selectInterests(page);
        this._log(`${lbl} STEP 10 OK`, 'success');
      } catch (e) {
        this._log(`${lbl} STEP 10 error: ${e.message}`, 'error');
      }

      this.currentProfileIds.delete(profileId);
      const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);

      this._log(`${lbl} STEP 11/11 - Closing browser...`, 'action');
      await this._closeBrowser(profileId);

      this.createdAccounts.push({
        profileId,
        username: redditUsername || profileName,
        password: this.creationPassword,
        proxyIndex: proxyNum
      });
      this.successCount++;
      this._log(`${lbl} SUCCESS - Profile ${profileId} created (${elapsed}s)`, 'success');
      this._log(`${lbl} Progress: ${this.successCount}/${this.targetCount}`, 'info');
      slotSuccess = true;
    }

    if (!slotSuccess && !this.cancelRequested) {
      this.failedCount++;
      this._log(`${slotLabel}SLOT FAILED - Exhausted ${MAX_ROTATIONS_PER_SUCCESS} rotations for slot ${slot + 1}`, 'error');
    }
  }
}

module.exports = new CreationService();
