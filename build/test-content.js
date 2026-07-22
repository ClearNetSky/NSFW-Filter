// E2E-тест content.js на реальном DOM в headless Chrome.
// Стабим chrome.* и решаем "NSFW" по признаку в URL, затем проверяем,
// что нужное скрыто, а безопасное показано.
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = require('path').join(__dirname, '..');

const PAGE = `<!DOCTYPE html><html><head><style>
  .bg-nsfw { width: 200px; height: 200px; background-image: url('https://example.com/NSFW-bg.jpg'); }
  .bg-safe { width: 200px; height: 200px; background-image: url('https://example.com/safe-bg.jpg'); }
  .pseudo-nsfw { width: 200px; height: 200px; }
  .pseudo-nsfw::before { content: ''; display: block; width: 100px; height: 100px;
                         background-image: url('https://example.com/NSFW-pseudo.jpg'); }
</style></head><body>
  <img id="img-nsfw" src="https://example.com/NSFW-photo.jpg" width="300" height="300">
  <img id="img-safe" src="https://example.com/kitten.jpg" width="300" height="300">
  <img id="img-tiny" src="https://example.com/NSFW-tiny.jpg" width="16" height="16">
  <img id="img-svg" src="https://example.com/logo.svg" width="300" height="300">
  <img id="img-lazy" data-src="https://example.com/NSFW-lazy.jpg" width="300" height="300">
  <video id="vid-nsfw" poster="https://example.com/NSFW-poster.jpg" width="300" height="200"></video>
  <video id="vid-safe" poster="https://example.com/safe-poster.jpg" width="300" height="200"></video>
  <div id="bg-nsfw" class="bg-nsfw"></div>
  <div id="bg-safe" class="bg-safe"></div>
  <div id="bg-inline" style="width:200px;height:200px;background-image:url('https://example.com/NSFW-inline.jpg')"></div>
  <div id="pseudo" class="pseudo-nsfw"></div>
  <div id="host-open"></div>
  <div id="host-closed"></div>
</body></html>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 3000 }); // всё в зоне видимости IO

  const mainWorld = fs.readFileSync(EXT + '/content/main-world.js', 'utf8');
  const content = fs.readFileSync(EXT + '/content/content.js', 'utf8');

  // Стаб chrome.* + MAIN-world патч attachShadow (как делает manifest)
  await page.evaluateOnNewDocument(`
    window.__predictions = [];
    window.chrome = {
      runtime: {
        sendMessage: (msg) => {
          if (msg && msg.type === 'GET_SETTINGS') {
            return Promise.resolve({ enabled: true, sensitivity: 50,
              categories: { porn: true, sexy: true, hentai: true } });
          }
          if (msg && typeof msg.url === 'string') {
            window.__predictions.push(msg.url);
            return Promise.resolve({ result: msg.url.includes('NSFW'), url: msg.url });
          }
          return Promise.resolve(null);
        },
        onMessage: { addListener: () => {} },
        getURL: (p) => 'chrome-extension://test/' + p
      }
    };
    ${mainWorld}
  `);

  // Через файл, а не setContent: evaluateOnNewDocument применяется
  // только при реальной навигации
  const pagePath = __dirname + '/test-page.html';
  fs.writeFileSync(pagePath, PAGE);
  await page.goto(require('url').pathToFileURL(pagePath).href, { waitUntil: 'domcontentloaded' });

  // Shadow DOM: открытый и закрытый (закрытый должен стать открытым из-за патча)
  await page.evaluate(() => {
    const open = document.getElementById('host-open').attachShadow({ mode: 'open' });
    open.innerHTML = '<img id="sh-nsfw" src="https://example.com/NSFW-shadow.jpg" width="300" height="300">';
    const closed = document.getElementById('host-closed').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<img id="sh-closed" src="https://example.com/NSFW-closed.jpg" width="300" height="300">';
  });

  await page.evaluate(content);
  await new Promise(r => setTimeout(r, 2500)); // IO + вердикты + rescan

  const result = await page.evaluate(() => {
    const st = (id) => document.getElementById(id)?.dataset.nsfwFilterStatus;
    const shadowStatus = (hostId, imgId) => {
      const sr = document.getElementById(hostId).shadowRoot;
      return sr ? sr.getElementById(imgId)?.dataset.nsfwFilterStatus : 'NO_SHADOW_ACCESS';
    };
    return {
      imgNsfw: st('img-nsfw'),
      imgSafe: st('img-safe'),
      imgTiny: st('img-tiny'),
      imgSvg: st('img-svg'),
      imgLazy: st('img-lazy'),
      vidNsfw: st('vid-nsfw'),
      vidSafe: st('vid-safe'),
      bgNsfw: document.getElementById('bg-nsfw').dataset.nsfwBgStatus,
      bgSafe: document.getElementById('bg-safe').dataset.nsfwBgStatus,
      bgInline: document.getElementById('bg-inline').dataset.nsfwBgStatus,
      pseudo: document.getElementById('pseudo').dataset.nsfwPseudoBlocked,
      shadowOpen: shadowStatus('host-open', 'sh-nsfw'),
      shadowClosed: shadowStatus('host-closed', 'sh-closed'),
      nsfwImgVisibility: getComputedStyle(document.getElementById('img-nsfw')).visibility,
      safeImgOpacity: getComputedStyle(document.getElementById('img-safe')).opacity,
      predictionCount: window.__predictions.length
    };
  });

  const checks = [
    ['NSFW image blocked', result.imgNsfw === 'nsfw'],
    ['NSFW image visually hidden', result.nsfwImgVisibility === 'hidden'],
    ['Safe image shown', result.imgSafe === 'sfw'],
    ['Safe image opacity 1', result.safeImgOpacity === '1'],
    ['Tiny image skipped', result.imgTiny === 'sfw'],
    ['SVG skipped', result.imgSvg === 'sfw'],
    ['Lazy data-src classified', result.imgLazy === 'nsfw'],
    ['NSFW video poster blocked', result.vidNsfw === 'nsfw'],
    ['Safe video poster shown', result.vidSafe === 'sfw'],
    ['NSFW CSS background blocked', result.bgNsfw === 'nsfw'],
    ['Safe CSS background allowed', result.bgSafe === 'sfw'],
    ['NSFW inline background blocked', result.bgInline === 'nsfw'],
    ['NSFW ::before blocked', result.pseudo === 'before'],
    ['Open shadow DOM image blocked', result.shadowOpen === 'nsfw'],
    ['Closed shadow DOM image blocked', result.shadowClosed === 'nsfw']
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log('---');
  console.log('predictions requested:', result.predictionCount);
  console.log(failed === 0 ? '=== ALL CONTENT TESTS PASSED ===' : `=== ${failed} FAILURES ===`);
  console.log('raw:', JSON.stringify(result));

  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
