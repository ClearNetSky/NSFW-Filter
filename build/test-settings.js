// E2E-тест реакции content-скрипта на смену настроек в headless Chrome.
// Гоняется через `npm test`. Проверяет:
//  1. смена чувствительности при включённом фильтре пересканирует страницу;
//  2. ранее заблокированный ИНЛАЙНОВЫЙ фон восстанавливается, став безопасным;
//  3. shadow-CSS не дублируется при переоценке.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.join(__dirname, '..');

// chrome.* стаб: вердикт задаётся сценарием через window.__verdict
function stub(getSettings) {
  return `
    window.__reqCount = 0;
    window.__verdict = null;          // функция (url, n) => boolean
    window.__settingsListener = null;
    window.chrome = {
      runtime: {
        sendMessage: (msg) => {
          if (msg && msg.type === 'GET_SETTINGS') return Promise.resolve(${getSettings});
          if (msg && typeof msg.url === 'string') {
            window.__reqCount++;
            const v = window.__verdict ? window.__verdict(msg.url, window.__reqCount) : false;
            return Promise.resolve({ result: v, url: msg.url });
          }
          return Promise.resolve(null);
        },
        onMessage: { addListener: (fn) => { window.__settingsListener = fn; } },
        getURL: (p) => 'chrome-extension://test/' + p
      }
    };
  `;
}

async function loadPage(browser, html, getSettings, verdictFn) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1000 });
  await page.evaluateOnNewDocument(stub(getSettings));
  const p = path.join(__dirname, '_settings-test-page.html');
  fs.writeFileSync(p, html);
  await page.goto(pathToFileURL(p).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(`window.__verdict = ${verdictFn}`);
  return page;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const content = fs.readFileSync(EXT + '/content/content.js', 'utf8');
  const checks = [];

  // ── Тест 1: смена чувствительности пересканирует ──────────────
  {
    const page = await loadPage(
      browser,
      '<img id="i" src="https://example.com/borderline.jpg" width="300" height="300">',
      '{ enabled: true, sensitivity: 20, categories:{porn:true,sexy:true,hentai:true} }',
      '(url, n) => n >= 2'  // 1й запрос safe, далее nsfw
    );
    await page.evaluate(content);
    await new Promise(r => setTimeout(r, 700));
    const before = await page.evaluate(() => ({ s: document.getElementById('i').dataset.nsfwFilterStatus, r: window.__reqCount }));
    await page.evaluate(() => window.__settingsListener({ type: 'SETTINGS_UPDATED',
      settings: { enabled: true, sensitivity: 90, categories:{porn:true,sexy:true,hentai:true} } }));
    await new Promise(r => setTimeout(r, 700));
    const after = await page.evaluate(() => ({ s: document.getElementById('i').dataset.nsfwFilterStatus, r: window.__reqCount }));
    checks.push(['sensitivity change triggers re-scan', after.r > before.r]);
    checks.push(['image re-blocked with stricter threshold', before.s === 'sfw' && after.s === 'nsfw']);
    await page.close();
  }

  // ── Тест 2: восстановление инлайнового фона + без дублей shadow CSS ──
  {
    const page = await loadPage(
      browser,
      '<div id="bg" style="width:200px;height:200px;background-image:url(https://example.com/pic.jpg)"></div><div id="host"></div>',
      '{ enabled: true, sensitivity: 90, categories:{porn:true,sexy:true,hentai:true} }',
      '(url, n) => n < 2'  // 1й nsfw (блок), далее safe (восстановить)
    );
    await page.evaluate(() => document.getElementById('host').attachShadow({ mode: 'open' }));
    await page.evaluate(content);
    await new Promise(r => setTimeout(r, 700));
    const before = await page.evaluate(() => ({
      st: document.getElementById('bg').dataset.nsfwBgStatus,
      img: document.getElementById('bg').style.backgroundImage,
      sh: document.getElementById('host').shadowRoot.querySelectorAll('style').length
    }));
    await page.evaluate(() => window.__settingsListener({ type: 'SETTINGS_UPDATED',
      settings: { enabled: true, sensitivity: 30, categories:{porn:true,sexy:true,hentai:true} } }));
    await new Promise(r => setTimeout(r, 900));
    const after = await page.evaluate(() => ({
      st: document.getElementById('bg').dataset.nsfwBgStatus,
      img: document.getElementById('bg').style.backgroundImage,
      sh: document.getElementById('host').shadowRoot.querySelectorAll('style').length
    }));
    checks.push(['inline background blocked initially', before.st === 'nsfw' && before.img === 'none']);
    checks.push(['inline background restored when safe', after.st === 'sfw' && after.img.includes('pic.jpg')]);
    checks.push(['shadow CSS not duplicated', before.sh === 1 && after.sh === 1]);
    await page.close();
  }

  let failed = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; }
  console.log(failed === 0 ? '=== ALL SETTINGS TESTS PASSED ===' : `=== ${failed} FAILURES ===`);
  try { fs.unlinkSync(path.join(__dirname, '_settings-test-page.html')); } catch {}
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
