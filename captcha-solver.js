const axios = require('axios');
const FormData = require('form-data');

async function solveRecaptchaWithAudio(page, openaiKey, logFn) {
  if (!openaiKey) return { success: false, message: 'OpenAI API key not configured' };

  try {
    logFn('[Captcha] Starting AUDIO challenge method');
    const pageUrl = page.url();
    logFn(`[Captcha] Current URL: ${pageUrl.substring(0, 100)}`);

    if (pageUrl.includes('google.com/sorry')) {
      const sorryPageInfo = await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        return {
          hasPlay: bodyText.includes('Press PLAY') || bodyText.includes('PLAY'),
          hasEnterHear: bodyText.includes('Enter what you hear'),
          hasUnusualTraffic: bodyText.includes('unusual traffic')
        };
      }).catch(() => ({}));

      if (sorryPageInfo.hasPlay || sorryPageInfo.hasEnterHear) {
        logFn('[Captcha] Built-in audio captcha detected on sorry page');
        return await solveGoogleSorryAudio(page, openaiKey, logFn);
      }
    }

    logFn('[Captcha] Waiting for reCAPTCHA widget...');
    let recaptchaFrame = null;
    const maxWaitMs = 30000;
    const pollInterval = 2000;
    const waitStart = Date.now();
    let bareBlockDetected = false;

    while (Date.now() - waitStart < maxWaitMs) {
      const currentFrames = page.frames();
      recaptchaFrame = currentFrames.find(f => {
        const url = f.url();
        return url.includes('google.com/recaptcha/api2/anchor') ||
               url.includes('google.com/recaptcha/enterprise/anchor') ||
               url.includes('recaptcha/api2/anchor') ||
               url.includes('recaptcha/enterprise/anchor');
      });

      if (recaptchaFrame) break;

      const pageCheck = await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        return {
          hasPlay: bodyText.includes('Press PLAY') || bodyText.includes('Enter what you hear'),
          hasUnusualTraffic: bodyText.includes('unusual traffic'),
          hasAutomated: bodyText.includes('automated queries'),
          hasTryLater: bodyText.includes('Try again later'),
          hasRecaptchaDiv: !!document.querySelector('.g-recaptcha, [data-sitekey], #recaptcha'),
          hasIframes: document.querySelectorAll('iframe').length
        };
      }).catch(() => ({}));

      if (pageCheck.hasPlay) {
        return await solveGoogleSorryAudio(page, openaiKey, logFn);
      }

      if (!pageCheck.hasRecaptchaDiv && !pageCheck.hasIframes &&
          (pageCheck.hasUnusualTraffic || pageCheck.hasAutomated || pageCheck.hasTryLater)) {
        bareBlockDetected = true;
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    if (bareBlockDetected) {
      return { success: false, message: 'Google hard block: no captcha on sorry page', googleBlocked: true, needNewProxy: true };
    }

    if (!recaptchaFrame) recaptchaFrame = page.mainFrame();

    logFn('[Captcha] Clicking checkbox...');
    let clicked = false;
    await new Promise(r => setTimeout(r, 2000));

    if (recaptchaFrame && recaptchaFrame !== page.mainFrame()) {
      try {
        await recaptchaFrame.waitForSelector('.recaptcha-checkbox-border, #recaptcha-anchor', { timeout: 5000 });
        const checkboxHandle = await recaptchaFrame.$('.recaptcha-checkbox-border');
        if (checkboxHandle) {
          const box = await checkboxHandle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            clicked = true;
          } else {
            await recaptchaFrame.click('.recaptcha-checkbox-border');
            clicked = true;
          }
        }
      } catch (e) {}
    }

    if (!clicked) {
      const allFrames = page.frames();
      for (const frame of allFrames) {
        if (frame.url().includes('recaptcha') && frame.url().includes('anchor')) {
          try {
            const jsClicked = await frame.evaluate(() => {
              const el = document.querySelector('.recaptcha-checkbox-border, #recaptcha-anchor, [role="checkbox"]');
              if (el) { el.click(); return true; }
              return false;
            });
            if (jsClicked) { clicked = true; recaptchaFrame = frame; break; }
          } catch (e) {}
        }
      }
    }

    if (!clicked) return { success: false, message: 'Checkbox not clickable' };

    await new Promise(r => setTimeout(r, 4000));

    const checkmark = await recaptchaFrame.$('.recaptcha-checkbox-checked');
    if (checkmark) {
      const tokenPopulated = await page.evaluate(() => {
        const ta = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
        return ta && ta.value && ta.value.length > 100;
      });
      if (tokenPopulated) return { success: true, method: 'no-challenge' };
      await new Promise(r => setTimeout(r, 3000));
      const tokenNow = await page.evaluate(() => {
        const ta = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
        return ta && ta.value && ta.value.length > 100;
      });
      if (tokenNow) return { success: true, method: 'no-challenge' };
    }

    logFn('[Captcha] Switching to AUDIO challenge...');
    await new Promise(r => setTimeout(r, 1000));

    const updatedFrames = page.frames();
    let challengeFrame = updatedFrames.find(f =>
      f.url().includes('bframe') && f.url().includes('recaptcha')
    );
    if (!challengeFrame) challengeFrame = page.mainFrame();

    let audioClicked = false;
    for (const selector of ['.rc-button-audio', '#recaptcha-audio-button', 'button.rc-button-audio']) {
      try {
        await challengeFrame.waitForSelector(selector, { visible: true, timeout: 3000 });
        await challengeFrame.click(selector);
        audioClicked = true;
        break;
      } catch (e) {}
    }

    if (!audioClicked) {
      for (const frame of page.frames()) {
        try {
          const btn = await frame.$('.rc-button-audio');
          if (btn) { await btn.click(); audioClicked = true; break; }
        } catch (e) {}
      }
    }

    if (!audioClicked) return { success: false, message: 'Audio button not found' };

    await new Promise(r => setTimeout(r, 3000));

    for (const frame of page.frames()) {
      if (frame.url().includes('recaptcha')) {
        try {
          const blocked = await frame.evaluate(() => {
            const els = document.querySelectorAll('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text');
            let text = '';
            els.forEach(el => { text += ' ' + (el.textContent || ''); });
            return text.toLowerCase().includes('automated queries');
          });
          if (blocked) {
            return { success: false, message: 'Google blocked: automated queries', googleBlocked: true, needNewProxy: true };
          }
        } catch (e) {}
      }
    }

    const maxAudioRetries = 3;
    let cleanedTranscription = '';

    for (let attempt = 1; attempt <= maxAudioRetries; attempt++) {
      logFn(`[Captcha] Audio attempt ${attempt}/${maxAudioRetries}`);

      const currentFrames = page.frames();
      challengeFrame = currentFrames.find(f => f.url().includes('bframe')) || challengeFrame;

      let audioUrl = null;
      for (const selector of ['.rc-audiochallenge-tdownload-link', 'a[href*="payload"]']) {
        try {
          await challengeFrame.waitForSelector(selector, { timeout: 3000 });
          audioUrl = await challengeFrame.evaluate((sel) => {
            const link = document.querySelector(sel);
            return link ? (link.href || link.src) : null;
          }, selector);
          if (audioUrl) break;
        } catch (e) {}
      }

      if (!audioUrl) {
        try {
          audioUrl = await challengeFrame.evaluate(() => {
            const audio = document.querySelector('audio source, audio');
            return audio ? (audio.src || audio.getAttribute('src')) : null;
          });
        } catch (e) {}
      }

      if (!audioUrl) {
        try { await challengeFrame.click('.rc-button-audio'); await new Promise(r => setTimeout(r, 2000)); } catch (e) {}
        continue;
      }

      const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const audioBuffer = Buffer.from(audioResponse.data);

      const formData = new FormData();
      formData.append('model', 'whisper-1');
      formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
      formData.append('language', 'en');

      const whisperResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
        headers: { 'Authorization': `Bearer ${openaiKey}`, ...formData.getHeaders() },
        timeout: 30000
      });

      const transcription = whisperResponse.data.text?.trim();
      if (!transcription) {
        try { await challengeFrame.click('#recaptcha-reload-button, .rc-button-reload'); await new Promise(r => setTimeout(r, 2000)); } catch (e) {}
        continue;
      }

      cleanedTranscription = transcription.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const words = cleanedTranscription.split(' ');
      if (words.length > 10) cleanedTranscription = words.slice(0, 8).join(' ');

      logFn(`[Captcha] Transcription: "${cleanedTranscription}"`);

      try { await challengeFrame.evaluate(() => { const i = document.querySelector('#audio-response'); if (i) i.value = ''; }); } catch (e) {}
      await challengeFrame.waitForSelector('#audio-response', { timeout: 5000 });
      await challengeFrame.type('#audio-response', cleanedTranscription, { delay: 30 });
      await challengeFrame.click('#recaptcha-verify-button');
      await new Promise(r => setTimeout(r, 4000));

      const currentUrl = page.url();
      if (currentUrl.includes('google.com/search') && !currentUrl.includes('sorry')) {
        return { success: true, method: 'audio-whisper', transcription: cleanedTranscription };
      }

      try { await challengeFrame.click('#recaptcha-reload-button, .rc-button-reload'); await new Promise(r => setTimeout(r, 3000)); } catch (e) {}
    }

    try {
      const solved = await recaptchaFrame.$('.recaptcha-checkbox-checked');
      if (solved) return { success: true, method: 'audio-whisper', transcription: cleanedTranscription };
    } catch (e) {
      const finalUrl = page.url();
      if (!finalUrl.includes('sorry') && !finalUrl.includes('captcha')) {
        return { success: true, method: 'audio-whisper-navigation' };
      }
    }

    return { success: false, message: 'Verification failed' };
  } catch (error) {
    if (error.message.includes('detached') || error.message.includes('destroyed') || error.message.includes('navigation')) {
      try {
        const finalUrl = page.url();
        if (!finalUrl.includes('sorry') && !finalUrl.includes('captcha')) {
          return { success: true, method: 'audio-whisper-navigation' };
        }
      } catch (e) {}
    }
    return { success: false, message: error.message };
  }
}

async function solveGoogleSorryAudio(page, openaiKey, logFn) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const blocked = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('automated queries') || text.includes('unusual traffic from your computer');
      }).catch(() => false);

      if (blocked) return { success: false, googleBlocked: true, needNewProxy: true, message: 'IP blocked by Google' };

      const playClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if (btn.textContent.trim().toUpperCase().includes('PLAY')) { btn.click(); return true; }
        }
        const inputs = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"]'));
        for (const inp of inputs) {
          if ((inp.value || '').toUpperCase().includes('PLAY')) { inp.click(); return true; }
        }
        return false;
      });

      if (!playClicked) continue;

      await new Promise(r => setTimeout(r, 3000));

      let audioUrl = await page.evaluate(() => {
        const audio = document.querySelector('audio');
        if (audio) { const source = audio.querySelector('source'); return source ? source.src : audio.src; }
        const links = Array.from(document.querySelectorAll('a[href*="payload"], a[href*="audio"]'));
        return links.length > 0 ? links[0].href : null;
      });

      if (!audioUrl) continue;

      const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const audioBuffer = Buffer.from(audioResponse.data);

      const formData = new FormData();
      formData.append('model', 'whisper-1');
      formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
      formData.append('language', 'en');

      const whisperResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
        headers: { 'Authorization': `Bearer ${openaiKey}`, ...formData.getHeaders() },
        timeout: 30000
      });

      const transcription = whisperResponse.data.text?.trim();
      if (!transcription) continue;

      let cleaned = transcription.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const words = cleaned.split(' ');
      if (words.length > 10) cleaned = words.slice(0, 8).join(' ');

      const inputInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        for (const inp of inputs) {
          const p = (inp.placeholder || '').toLowerCase();
          const l = (inp.getAttribute('aria-label') || '').toLowerCase();
          const id = (inp.id || '').toLowerCase();
          if (p.includes('hear') || p.includes('type') || l.includes('hear') || l.includes('response') ||
              id.includes('audio') || id.includes('response') || id.includes('answer')) {
            inp.focus(); inp.value = '';
            return { found: true, selector: inp.id ? `#${inp.id}` : null };
          }
        }
        for (const inp of inputs) {
          const rect = inp.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 10) { inp.focus(); inp.value = ''; return { found: true, selector: null }; }
        }
        return { found: false };
      });

      if (!inputInfo.found) continue;

      if (inputInfo.selector) {
        await page.type(inputInfo.selector, cleaned, { delay: 30 });
      } else {
        await page.keyboard.type(cleaned, { delay: 30 });
      }

      await new Promise(r => setTimeout(r, 500));

      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || btn.value || '').trim().toUpperCase();
          if (text.includes('VERIFY') || text === 'SUBMIT') { btn.click(); return; }
        }
        const form = document.querySelector('form');
        if (form) form.submit();
      });

      await new Promise(r => setTimeout(r, 5000));

      const newUrl = page.url();
      if (!newUrl.includes('sorry') && !newUrl.includes('captcha')) {
        return { success: true, method: 'sorry-audio-whisper', transcription: cleaned };
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      if (err.message.includes('detached') || err.message.includes('navigation')) {
        const url = page.url();
        if (!url.includes('sorry') && !url.includes('captcha')) {
          return { success: true, method: 'sorry-audio-whisper' };
        }
      }
    }
  }

  return { success: false, message: 'Sorry page audio captcha failed' };
}

async function solveTurnstileOnPage(page, antiCaptchaKey, logFn) {
  if (!antiCaptchaKey) return { success: false, message: 'Anti-Captcha API key not configured' };

  logFn('[Captcha] Detecting Turnstile on page...');

  const turnstileInfo = await page.evaluate(() => {
    const widget = document.querySelector('.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"]');
    if (!widget) return { found: false };
    let sitekey = widget.getAttribute('data-sitekey');
    if (!sitekey) { const p = widget.closest('[data-sitekey]'); if (p) sitekey = p.getAttribute('data-sitekey'); }
    if (!sitekey) {
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      if (iframe) { const m = (iframe.src || '').match(/[?&]k=([^&]+)/); if (m) sitekey = m[1]; }
    }
    if (!sitekey) {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) { const m = (s.textContent || '').match(/sitekey['":\s]+['"]?(0x[A-Za-z0-9_-]+)/); if (m) { sitekey = m[1]; break; } }
    }
    return { found: !!sitekey, sitekey, url: window.location.href };
  }).catch(() => ({ found: false }));

  if (!turnstileInfo.found || !turnstileInfo.sitekey) {
    return { success: false, message: 'Turnstile sitekey not found' };
  }

  logFn(`[Captcha] Turnstile sitekey: ${turnstileInfo.sitekey.substring(0, 15)}...`);

  const apiUrl = 'https://api.anti-captcha.com';

  const taskRes = await axios.post(`${apiUrl}/createTask`, {
    clientKey: antiCaptchaKey,
    task: { type: 'TurnstileTaskProxyless', websiteURL: turnstileInfo.url, websiteKey: turnstileInfo.sitekey }
  }, { timeout: 30000 });

  if (taskRes.data.errorId !== 0) {
    return { success: false, message: taskRes.data.errorDescription || 'Task creation failed' };
  }

  const taskId = taskRes.data.taskId;
  logFn(`[Captcha] Task created: ${taskId}`);

  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    const resultRes = await axios.post(`${apiUrl}/getTaskResult`, { clientKey: antiCaptchaKey, taskId }, { timeout: 10000 });
    if (resultRes.data.errorId !== 0) return { success: false, message: resultRes.data.errorDescription };
    if (resultRes.data.status === 'ready') {
      const token = resultRes.data.solution?.token;
      if (!token) return { success: false, message: 'No token in solution' };

      logFn(`[Captcha] Got token (${token.length} chars), injecting...`);

      await page.evaluate((captchaToken) => {
        document.querySelectorAll('[name="cf-turnstile-response"], .cf-turnstile input[type="hidden"]').forEach(el => { el.value = captchaToken; });
        if (typeof window.turnstile !== 'undefined') {
          document.querySelectorAll('.cf-turnstile').forEach(w => {
            const cb = w.getAttribute('data-callback');
            if (cb && typeof window[cb] === 'function') window[cb](captchaToken);
          });
        }
        ['onTurnstileSuccess', 'turnstileCallback', 'cfCallback', 'onCaptchaSuccess', 'captchaCallback', 'verifyCaptcha'].forEach(name => {
          if (typeof window[name] === 'function') try { window[name](captchaToken); } catch (e) {}
        });
        const form = document.querySelector('form');
        if (form) {
          let inp = form.querySelector('[name="cf-turnstile-response"]');
          if (!inp) { inp = document.createElement('input'); inp.type = 'hidden'; inp.name = 'cf-turnstile-response'; form.appendChild(inp); }
          inp.value = captchaToken;
        }
      }, token);

      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) {
          const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
          if (btn) btn.click(); else form.submit();
        }
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 5000));

      const title = await page.title().catch(() => '');
      const blocked = title.toLowerCase().includes('prove') || title.toLowerCase().includes('humanity');
      if (blocked) return { success: false, message: 'Still on challenge page' };

      return { success: true, method: 'turnstile-anti-captcha' };
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  return { success: false, message: 'Captcha solving timeout' };
}

module.exports = { solveRecaptchaWithAudio, solveTurnstileOnPage };
