const { io } = require('socket.io-client');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SocksProxyAgent } = require('socks-proxy-agent');
const captchaSolver = require('./captcha-solver');
const creationService = require('./creation-service');

const CONFIG_FILE = path.join(__dirname, 'agent-config.json');
const DATA_DIR = __dirname;

const DATA_FILES = {
  settings: path.join(DATA_DIR, 'settings.json'),
  proxies: path.join(DATA_DIR, 'proxies.json'),
  karma: path.join(DATA_DIR, 'karma_accounts.json'),
  imported: path.join(DATA_DIR, 'imported_accounts.json')
};

const DEFAULT_DATA = {
  settings: {
    apiUrl: 'http://local.adspower.net:50325',
    apiKey: '',
    captchaApiKey: '',
    openaiApiKey: '',
    gridpanelApiKey: '',
    proxyRotateLink: '',
    deepseekApiKey: '',
    deepseekPromptTemplate: '',
    grabberSubreddits: [],
    grabberPostCount: 10
  },
  proxies: [],
  karma: [],
  imported: []
};

let socket = null;
let agentConfig = null;

const browsers = new Map();
const pages = new Map();
let farmingActive = false;
let farmingStopRequested = false;

function log(level, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${message}`);
  if (socket && socket.connected) {
    socket.emit('agent:log', { level, message, timestamp: ts });
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadData(type) {
  const file = DATA_FILES[type];
  const def = DEFAULT_DATA[type];
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return Array.isArray(def) ? [...def] : { ...def };
}

function saveData(type, data) {
  const file = DATA_FILES[type];
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function collectConfig(existingUrl) {
  if (!existingUrl) {
    console.log('\n=== Web Farming Local Agent Setup ===\n');
  } else {
    console.log('\n Re-authenticating...\n');
  }
  const serverUrl = existingUrl || await prompt('Enter the hosted server URL: ');
  const username = await prompt('Enter your username: ');
  const password = await prompt('Enter your password: ');

  const cleanUrl = serverUrl.replace(/\/$/, '');
  console.log('\n Logging in...');
  try {
    const res = await axios.post(`${cleanUrl}/api/auth/login/agent`, { username, password }, { timeout: 10000 });
    if (!res.data.success || !res.data.token) {
      console.log(' Login failed: ' + (res.data.message || 'Invalid credentials'));
      return collectConfig(existingUrl);
    }
    console.log(` Logged in as ${res.data.username}\n`);
    return { serverUrl: cleanUrl, token: res.data.token, username: res.data.username };
  } catch (err) {
    console.log(' Could not connect to server: ' + err.message);
    return collectConfig(existingUrl);
  }
}

function getAdsPowerBaseUrl() {
  const settings = loadData('settings');
  return settings.apiUrl || 'http://local.adspower.net:50325';
}

async function adsPowerRequest(endpoint, method, params, data, retries = 3) {
  const settings = loadData('settings');
  const configuredUrl = settings.apiUrl || 'http://local.adspower.net:50325';
  const fallbackUrls = [
    configuredUrl,
    'http://127.0.0.1:50325',
    'http://localhost:50325'
  ];
  const uniqueUrls = [...new Set(fallbackUrls)];

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`[AdsPower] Retry ${attempt}/${retries - 1} after ${backoff}ms...`);
      await new Promise(r => setTimeout(r, backoff));
    }

    let lastErr = null;
    for (const baseUrl of uniqueUrls) {
      try {
        const axiosConfig = {
          method: method || 'GET',
          url: `${baseUrl}${endpoint}`,
          timeout: 15000
        };

        if (method === 'GET' && params && Object.keys(params).length > 0) {
          axiosConfig.params = params;
        }

        if (data && (method === 'POST' || method === 'PUT')) {
          axiosConfig.data = data;
          axiosConfig.headers = { 'Content-Type': 'application/json' };
        }

        const response = await axios(axiosConfig);
        return { success: true, data: response.data };
      } catch (err) {
        lastErr = err;
        if (err.response && err.response.status >= 400 && err.response.status < 500) {
          return { success: false, error: err.response.data?.msg || err.response.statusText, status: err.response.status };
        }
        continue;
      }
    }

    if (attempt === retries - 1) {
      return { success: false, error: lastErr?.message || 'All AdsPower connection attempts failed' };
    }
  }
  return { success: false, error: 'All AdsPower connection attempts failed' };
}

async function puppeteerConnect(wsEndpoint, userId) {
  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null
    });

    browsers.set(userId, browser);

    browser.on('disconnected', () => {
      browsers.delete(userId);
      pages.delete(userId);
      log('WARN', `Browser disconnected: ${userId}`);
    });

    log('INFO', `Puppeteer connected to browser: ${userId}`);
    return { success: true, message: 'Connected' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerDisconnect(userId) {
  try {
    const browser = browsers.get(userId);
    if (browser) {
      await browser.disconnect();
      browsers.delete(userId);
      pages.delete(userId);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getPage(userId) {
  const browser = browsers.get(userId);
  if (!browser) throw new Error('Browser not connected');

  if (pages.has(userId)) {
    const page = pages.get(userId);
    try {
      await page.evaluate(() => document.title);
      return page;
    } catch {
      pages.delete(userId);
    }
  }

  const existingPages = await browser.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await browser.newPage();
  pages.set(userId, page);
  return page;
}

async function puppeteerNavigate(userId, url, options) {
  try {
    const page = await getPage(userId);
    await page.goto(url, {
      waitUntil: options?.waitUntil || 'networkidle2',
      timeout: 300000
    });
    return { success: true, title: await page.title(), url: page.url() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerClick(userId, selector, timeout) {
  try {
    const page = await getPage(userId);
    await page.waitForSelector(selector, { timeout: timeout || 5000 });
    await page.click(selector);
    return { success: true, message: `Clicked: ${selector}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerType(userId, selector, text, options) {
  try {
    const page = await getPage(userId);
    await page.waitForSelector(selector, { timeout: options?.timeout || 5000 });
    await page.type(selector, text, options || {});
    return { success: true, message: `Typed into: ${selector}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerScript(userId, script) {
  try {
    const page = await getPage(userId);
    const result = await page.evaluate(script);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerScreenshot(userId, options) {
  try {
    const page = await getPage(userId);
    const screenshot = await page.screenshot({
      encoding: options?.format || 'base64',
      type: options?.type || 'png'
    });
    return { success: true, screenshot };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerKeyboardType(userId, text, focusScript, delay) {
  try {
    const page = await getPage(userId);
    if (focusScript) {
      await page.evaluate(focusScript);
      await new Promise(r => setTimeout(r, 300));
    }
    await page.keyboard.type(text, { delay: delay || 30 });
    return { success: true, data: { typed: text.substring(0, 100) } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerGetText(userId, selector) {
  try {
    const page = await getPage(userId);
    await page.waitForSelector(selector, { timeout: 5000 });
    const text = await page.$eval(selector, el => el.textContent);
    return { success: true, text };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function puppeteerWaitForElement(userId, selector, timeout) {
  try {
    const page = await getPage(userId);
    await page.waitForSelector(selector, { timeout: timeout || 5000 });
    return { success: true, message: `Element found: ${selector}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function openBrowserAndConnect(userId, options) {
  const openResult = await adsPowerRequest('/api/v1/browser/start', 'GET', { user_id: userId, ...(options?.headless !== undefined ? { headless: options.headless } : {}) });

  if (!openResult.success || !openResult.data?.data?.ws?.puppeteer) {
    return { success: false, error: openResult.error || 'Failed to open browser' };
  }

  const connectResult = await puppeteerConnect(openResult.data.data.ws.puppeteer, userId);
  if (!connectResult.success) {
    return { success: false, error: connectResult.error || 'Failed to connect puppeteer' };
  }

  return { success: true, data: { ws_endpoint: openResult.data.data.ws.puppeteer, connected: true } };
}

async function closeBrowserAndDisconnect(userId) {
  try { await puppeteerDisconnect(userId); } catch (e) {}
  return await adsPowerRequest('/api/v1/browser/stop', 'GET', { user_id: userId });
}

function registerHandlers() {
  socket.on('agent:adspower:status', async ({ requestId }) => {
    const result = await adsPowerRequest('/api/v1/user/list?page_size=1', 'GET');
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:queryProfiles', async ({ requestId, options }) => {
    const result = await adsPowerRequest('/api/v1/user/list', 'GET', options || {});
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:createProfile', async ({ requestId, profileData }) => {
    const result = await adsPowerRequest('/api/v1/user/create', 'POST', null, profileData);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:updateProfile', async ({ requestId, userId, updateData }) => {
    const result = await adsPowerRequest('/api/v2/user/update', 'POST', null, { user_id: userId, ...updateData });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:deleteProfiles', async ({ requestId, userIds }) => {
    const result = await adsPowerRequest('/api/v1/user/delete', 'POST', null, { user_ids: userIds });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:queryGroups', async ({ requestId }) => {
    const result = await adsPowerRequest('/api/v1/group/list', 'GET');
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:createGroup', async ({ requestId, groupName }) => {
    const result = await adsPowerRequest('/api/v1/group/create', 'POST', null, { group_name: groupName });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:openBrowser', async ({ requestId, userId, options }) => {
    const result = await adsPowerRequest('/api/v1/browser/start', 'GET', { user_id: userId, ...(options?.headless !== undefined ? { headless: options.headless } : {}) });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:openBrowserV2', async ({ requestId, userId, options }) => {
    const result = await adsPowerRequest('/api/v1/open_browser', 'POST', null, { user_id: userId, ...options });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:closeBrowser', async ({ requestId, userId }) => {
    const result = await adsPowerRequest('/api/v1/browser/stop', 'GET', { user_id: userId });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:closeBrowserV2', async ({ requestId, userId }) => {
    const result = await adsPowerRequest('/api/v2/browser-profile/stop', 'POST', null, { user_id: userId });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:checkActive', async ({ requestId, userId }) => {
    const result = await adsPowerRequest('/api/v1/browser/active', 'GET', { user_id: userId });
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:openAndConnect', async ({ requestId, userId, options }) => {
    const result = await openBrowserAndConnect(userId, options);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:closeAndDisconnect', async ({ requestId, userId }) => {
    const result = await closeBrowserAndDisconnect(userId);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:adspower:createProfileForDay1', async ({ requestId, username, group_id, proxy_index, authUsername }) => {
    try {
      const proxies = loadData('proxies');
      const proxyIndex = proxy_index || 0;

      if (proxies.length === 0) {
        socket.emit('agent:result', { requestId, success: false, error: 'No proxies available. Please add proxies first.' });
        return;
      }

      const proxy = proxies[proxyIndex % proxies.length];
      const profileName = `${username}-proxy${proxyIndex + 1}${authUsername ? '-' + authUsername : ''}`;

      let userProxyConfig = null;
      if (proxy.host && proxy.port) {
        userProxyConfig = {
          proxy_type: proxy.protocol || 'socks5',
          proxy_host: proxy.host,
          proxy_port: parseInt(proxy.port),
          proxy_user: proxy.username || '',
          proxy_password: proxy.password || '',
          proxy_soft: 'other'
        };
      }

      const chromeVersions = ['120.0.6099.109', '121.0.6167.85', '122.0.6261.94', '123.0.6312.58', '124.0.6367.91', '125.0.6422.76'];
      const chromeVersion = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
      const windowsUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

      const profileData = {
        group_id,
        name: profileName,
        fingerprint_config: {
          ua: windowsUa,
          automatic_timezone: '1',
          language: ['en-US', 'en'],
          flash: 'block',
          webrtc: 'proxy',
          canvas: '1',
          webgl_image: '1',
          webgl: '3',
          audio: '1',
          do_not_track: 'false',
          hardware_concurrency: String(Math.floor(Math.random() * 3) * 2 + 4),
          device_memory: String([4, 8, 16][Math.floor(Math.random() * 3)]),
          resolution: ['1920_1080', '1366_768', '1536_864', '1440_900', '1280_720'][Math.floor(Math.random() * 5)]
        }
      };

      if (userProxyConfig) {
        profileData.user_proxy_config = userProxyConfig;
      }

      const result = await adsPowerRequest('/api/v1/user/create', 'POST', null, profileData);

      if (!result.success) {
        socket.emit('agent:result', { requestId, success: false, error: result.error || 'Failed to create profile' });
        return;
      }

      const apiData = result.data;
      let userId = null;

      log('INFO', `[CreateProfile] API response: ${JSON.stringify(apiData).substring(0, 500)}`);

      if (apiData?.data?.user_id) userId = apiData.data.user_id;
      else if (apiData?.data?.id) userId = apiData.data.id;
      else if (apiData?.user_id) userId = apiData.user_id;
      else if (apiData?.id) userId = apiData.id;

      if (!userId) {
        log('INFO', `[CreateProfile] No user_id in response, querying by name: ${profileName}`);
        await new Promise(r => setTimeout(r, 2000));
        const queryResult = await adsPowerRequest('/api/v1/user/list', 'GET', { group_id, page_size: 100 });
        if (queryResult.success && queryResult.data) {
          const profileList = queryResult.data?.data?.list || queryResult.data?.list || [];
          log('INFO', `[CreateProfile] Found ${profileList.length} profiles in group`);
          const foundProfile = profileList.find(p =>
            (p.name || p.username || p.serial_number || '') === profileName ||
            (p.name || '').includes(profileName)
          );
          if (foundProfile) {
            userId = foundProfile.user_id || foundProfile.id;
            log('INFO', `[CreateProfile] Found profile by name: ${userId}`);
          }
        }
      }

      if (!userId) {
        socket.emit('agent:result', { requestId, success: false, error: `Profile created but could not extract user_id. API response: ${JSON.stringify(apiData).substring(0, 200)}` });
        return;
      }

      socket.emit('agent:result', {
        requestId,
        success: true,
        data: { user_id: userId, profile: apiData, proxy_used: proxyIndex + 1, proxy_name: proxy.name }
      });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });

  socket.on('agent:puppeteer:connect', async ({ requestId, wsEndpoint, userId }) => {
    const result = await puppeteerConnect(wsEndpoint, userId);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:disconnect', async ({ requestId, userId }) => {
    const result = await puppeteerDisconnect(userId);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:navigate', async ({ requestId, userId, url, options }) => {
    const result = await puppeteerNavigate(userId, url, options);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:click', async ({ requestId, userId, selector, timeout }) => {
    const result = await puppeteerClick(userId, selector, timeout);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:type', async ({ requestId, userId, selector, text, options }) => {
    const result = await puppeteerType(userId, selector, text, options);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:keyboardType', async ({ requestId, userId, text, focusScript, delay }) => {
    const result = await puppeteerKeyboardType(userId, text, focusScript, delay);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:getText', async ({ requestId, userId, selector }) => {
    const result = await puppeteerGetText(userId, selector);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:waitForElement', async ({ requestId, userId, selector, timeout }) => {
    const result = await puppeteerWaitForElement(userId, selector, timeout);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:script', async ({ requestId, userId, script }) => {
    const result = await puppeteerScript(userId, script);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:screenshot', async ({ requestId, userId, options }) => {
    const result = await puppeteerScreenshot(userId, options);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:puppeteer:connections', ({ requestId }) => {
    socket.emit('agent:result', {
      requestId,
      success: true,
      data: {
        browsers: Array.from(browsers.keys()),
        pages: Array.from(pages.keys()),
        count: browsers.size
      }
    });
  });

  socket.on('agent:data:load', ({ requestId, type }) => {
    try {
      const data = loadData(type);
      socket.emit('agent:result', { requestId, success: true, data });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });

  socket.on('agent:data:save', ({ requestId, type, data }) => {
    try {
      saveData(type, data);
      socket.emit('agent:result', { requestId, success: true });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });

  socket.on('agent:reddit:fetch', async ({ requestId, url }) => {
    const baseHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
    const proxies = loadData('proxies').filter(p => p.host && p.port);
    const shuffled = proxies.sort(() => Math.random() - 0.5);
    const attempts = [...shuffled, null];
    let lastErr = null;
    for (const proxy of attempts) {
      try {
        const axiosConfig = { headers: baseHeaders, timeout: 15000 };
        if (proxy) {
          const proxyUrl = `socks5://${proxy.username || ''}${proxy.password ? ':' + proxy.password : ''}${proxy.username ? '@' : ''}${proxy.host}:${proxy.port}`;
          const agent = new SocksProxyAgent(proxyUrl);
          axiosConfig.httpAgent = agent;
          axiosConfig.httpsAgent = agent;
        }
        const response = await axios.get(url, axiosConfig);
        socket.emit('agent:result', { requestId, success: true, data: response.data });
        return;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status === 403 || status === 429) break;
      }
    }
    const status = lastErr?.response?.status;
    socket.emit('agent:result', {
      requestId, success: false,
      error: status === 403 ? 'Blocked by Reddit (403)' : status === 429 ? 'Rate limited by Reddit (429)' : lastErr?.message,
      status
    });
  });

  socket.on('agent:captcha:handle', async ({ requestId, userId }) => {
    try {
      const page = await getPage(userId);
      const settings = loadData('settings');
      const openaiKey = settings.openaiApiKey;
      const result = await captchaSolver.solveRecaptchaWithAudio(page, openaiKey, (msg) => log('INFO', msg));
      socket.emit('agent:result', { requestId, ...result });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });

  socket.on('agent:captcha:solveTurnstile', async ({ requestId, userId }) => {
    try {
      const page = await getPage(userId);
      const settings = loadData('settings');
      const antiCaptchaKey = settings.captchaApiKey;
      const result = await captchaSolver.solveTurnstileOnPage(page, antiCaptchaKey, (msg) => log('INFO', msg));
      socket.emit('agent:result', { requestId, ...result });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });

  socket.on('agent:farming:start', async ({ requestId, config: farmConfig }) => {
    if (farmingActive) {
      socket.emit('agent:result', { requestId, success: false, error: 'Farming already running' });
      return;
    }
    farmingActive = true;
    farmingStopRequested = false;
    socket.emit('agent:result', { requestId, success: true, data: { message: 'Farming started' } });
    log('INFO', 'Farming sequence started');
    socket.emit('agent:farming:progress', { status: 'started', config: farmConfig });
  });

  socket.on('agent:farming:stop', ({ requestId }) => {
    farmingStopRequested = true;
    farmingActive = false;
    socket.emit('agent:result', { requestId, success: true });
    log('INFO', 'Farming stop requested');
    socket.emit('agent:farming:progress', { status: 'stopped' });
  });

  creationService.init({
    adsPowerRequest,
    captchaSolver,
    logFn: log,
    browsers,
    loadData
  });

  socket.on('agent:creation:start', async ({ requestId, targetCount, password }) => {
    const authUser = agentConfig?.username || '';
    const result = await creationService.start(targetCount, password, authUser);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:creation:stop', ({ requestId }) => {
    const result = creationService.stop();
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:creation:progress', ({ requestId }) => {
    socket.emit('agent:result', { requestId, success: true, data: creationService.getProgress() });
  });

  socket.on('agent:creation:setConcurrency', ({ requestId, concurrency }) => {
    const result = creationService.setConcurrency(concurrency);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:creation:setVisible', ({ requestId, visible }) => {
    const result = creationService.setVisible(visible);
    socket.emit('agent:result', { requestId, ...result });
  });

  socket.on('agent:creation:profiles', async ({ requestId }) => {
    try {
      const result = await adsPowerRequest('/api/v1/user/list', 'GET', { page_size: 100 });
      if (!result.success) {
        socket.emit('agent:result', { requestId, success: false, error: result.error });
        return;
      }
      const allProfiles = result.data?.data?.list || result.data?.list || [];
      const wcProfiles = allProfiles.filter(p => {
        const name = p.name || '';
        return name.startsWith('WC_') || name.includes('-proxy');
      });
      socket.emit('agent:result', { requestId, success: true, data: { profiles: wcProfiles, count: wcProfiles.length } });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });

  socket.on('agent:creation:deleteAll', async ({ requestId }) => {
    try {
      const result = await adsPowerRequest('/api/v1/user/list', 'GET', { page_size: 100 });
      const allProfiles = result.data?.data?.list || result.data?.list || [];
      const wcIds = allProfiles.filter(p => {
        const name = p.name || '';
        return name.startsWith('WC_') || name.includes('-proxy');
      }).map(p => p.user_id || p.id);
      if (wcIds.length === 0) {
        socket.emit('agent:result', { requestId, success: true, data: { deleted: 0 } });
        return;
      }
      await adsPowerRequest('/api/v1/user/delete', 'POST', null, { user_ids: wcIds });
      socket.emit('agent:result', { requestId, success: true, data: { deleted: wcIds.length } });
    } catch (err) {
      socket.emit('agent:result', { requestId, success: false, error: err.message });
    }
  });
}

async function reAuthenticate() {
  log('WARN', 'Token invalid or expired — re-authenticating...');
  if (socket) { socket.disconnect(); socket = null; }
  agentConfig = await collectConfig(agentConfig?.serverUrl);
  saveConfig(agentConfig);
  await connect();
}

async function connect() {
  agentConfig = loadConfig();

  if (!agentConfig || !agentConfig.serverUrl || !agentConfig.token) {
    agentConfig = await collectConfig();
    saveConfig(agentConfig);
    console.log('\nConfig saved to agent-config.json\n');
  }

  log('INFO', `Connecting to ${agentConfig.serverUrl}...`);

  socket = io(agentConfig.serverUrl, {
    auth: { token: agentConfig.token, type: 'agent' },
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    log('INFO', `Connected to server as agent (socket: ${socket.id})`);
    socket.emit('agent:register', { type: 'agent' });
    socket.emit('agent:status', { connected: true, browsersActive: browsers.size });
  });

  socket.on('agent:auth:invalid', async () => {
    await reAuthenticate();
  });

  socket.on('connect_error', async (err) => {
    if (err.message && (err.message.includes('invalid') || err.message.includes('unauthorized') || err.message.includes('401'))) {
      await reAuthenticate();
    } else {
      log('ERROR', `Connection error: ${err.message}`);
    }
  });

  socket.on('disconnect', (reason) => {
    log('WARN', `Disconnected: ${reason}`);
  });

  socket.on('reconnect', (attempt) => {
    log('INFO', `Reconnected after ${attempt} attempts`);
    socket.emit('agent:status', { connected: true, browsersActive: browsers.size });
  });

  registerHandlers();

  setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('agent:status', {
        connected: true,
        browsersActive: browsers.size,
        farming: farmingActive,
        uptime: process.uptime()
      });
    }
  }, 30000);
}

process.on('SIGINT', async () => {
  log('INFO', 'Shutting down agent...');
  for (const [userId] of browsers) {
    try { await puppeteerDisconnect(userId); } catch (e) {}
  }
  if (socket) socket.disconnect();
  process.exit(0);
});

connect().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
