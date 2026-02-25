const axios = require('axios');

const BASE = 'https://www.emailnator.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class GmailService {
  constructor() {
    this.history = [];
    this._cookies = null;
    this._xsrf = null;
    this._sessionTs = 0;
  }

  async _ensureSession() {
    const age = Date.now() - this._sessionTs;
    if (this._cookies && this._xsrf && age < 30 * 60 * 1000) return;

    const resp = await axios.get(BASE + '/', {
      headers: { 'User-Agent': UA },
      timeout: 15000
    });

    const setCookies = resp.headers['set-cookie'] || [];
    const xsrfCookie = setCookies.find(c => c.startsWith('XSRF-TOKEN='));
    if (!xsrfCookie) throw new Error('Failed to get CSRF token from emailnator');

    this._xsrf = decodeURIComponent(xsrfCookie.split('=')[1].split(';')[0]);
    this._cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    this._sessionTs = Date.now();
    console.log('[Gmail] Session refreshed');
  }

  _headers() {
    return {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': this._xsrf,
      'Cookie': this._cookies,
      'Referer': BASE + '/'
    };
  }

  async _post(path, body) {
    await this._ensureSession();
    try {
      const { data } = await axios.post(BASE + path, body, {
        headers: this._headers(),
        timeout: 20000
      });
      return data;
    } catch (err) {
      if (err.response && err.response.status === 419) {
        this._sessionTs = 0;
        await this._ensureSession();
        const { data } = await axios.post(BASE + path, body, {
          headers: this._headers(),
          timeout: 20000
        });
        return data;
      }
      throw err;
    }
  }

  async generateEmail() {
    const data = await this._post('/generate-email', {
      email: ['dotGmail']
    });

    const emails = data.email || data.emails || [];
    let email = Array.isArray(emails) ? emails[0] : emails;

    if (!email) throw new Error('API did not return an email address');

    if (email.endsWith('@googlemail.com')) {
      email = email.replace('@googlemail.com', '@gmail.com');
    }

    const entry = {
      email,
      createdAt: new Date().toISOString(),
      messageCount: 0
    };

    this.history.unshift(entry);
    console.log(`[Gmail] Generated: ${email}`);
    return { success: true, email: entry.email, createdAt: entry.createdAt };
  }

  async generateBulk(count) {
    const n = Math.min(Math.max(1, count || 1), 50);
    const results = [];
    const errors = [];

    for (let i = 0; i < n; i++) {
      try {
        const result = await this.generateEmail();
        results.push(result);
      } catch (err) {
        errors.push({ index: i, error: err.message });
      }
    }

    return { success: true, generated: results.length, failed: errors.length, results, errors };
  }

  async checkInbox(email) {
    if (!email) throw new Error('email is required');

    if (email.endsWith('@googlemail.com')) {
      email = email.replace('@googlemail.com', '@gmail.com');
    }

    const data = await this._post('/message-list', { email });

    const raw = data.messageData || data.messages || [];
    const messages = raw
      .filter(m => m.messageID !== 'ADSVPN')
      .map(m => ({
        id: m.messageID,
        from: m.from || 'unknown',
        subject: m.subject || '(no subject)',
        date: m.time || ''
      }));

    const entry = this.history.find(h => h.email === email);
    if (entry) entry.messageCount = messages.length;

    return { success: true, email, messages };
  }

  async getMessage(email, messageId) {
    if (!email || !messageId) throw new Error('email and messageId are required');

    const data = await this._post('/message-list', {
      email,
      messageID: messageId
    });

    let body = '';
    if (typeof data === 'string') {
      body = data;
    } else if (data.messageData) {
      body = typeof data.messageData === 'string' ? data.messageData : JSON.stringify(data.messageData);
    } else if (data.content || data.body || data.html) {
      body = data.content || data.body || data.html;
    } else {
      body = JSON.stringify(data);
    }

    const extracted = this._extractVerification(body);
    return { success: true, messageId, body, extracted };
  }

  _extractVerification(body) {
    const codes = [];
    const links = [];

    if (!body || typeof body !== 'string') return { codes, links };

    const codePatterns = [
      /code[:\s]*(\d{4,8})/gi,
      /pin[:\s]*(\d{4,8})/gi,
      /OTP[:\s]*(\d{4,8})/gi,
      /verification[:\s]*(\d{4,8})/gi,
      /\b(\d{6})\b/g
    ];

    const seen = new Set();
    for (const pattern of codePatterns) {
      let match;
      while ((match = pattern.exec(body)) !== null) {
        const code = match[1];
        if (!seen.has(code) && code.length >= 4 && code.length <= 8) {
          seen.add(code);
          codes.push(code);
        }
      }
    }

    const linkPattern = /https?:\/\/[^\s"'<>]+(?:verif|confirm|token|activate|validate|auth|click|redirect)[^\s"'<>]*/gi;
    let linkMatch;
    while ((linkMatch = linkPattern.exec(body)) !== null) {
      links.push(linkMatch[0].replace(/[.,;)}\]]+$/, ''));
    }

    return { codes, links };
  }

  getHistory() {
    return {
      success: true,
      emails: this.history.map(h => ({
        email: h.email,
        createdAt: h.createdAt,
        messageCount: h.messageCount
      })),
      count: this.history.length
    };
  }

  clearHistory() {
    const count = this.history.length;
    this.history = [];
    return { success: true, cleared: count };
  }
}

module.exports = new GmailService();
