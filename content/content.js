// NSFW Filter Content Script — v8.2
// Sends image URLs to background → offscreen for classification
// Images hidden with opacity:0 until classified, NSFW → visibility:hidden
// v8.2: video[poster] + CSS background-image filtering (restored from v1.8),
//       GIF classification, failsafe timeout, disabled-filter CSS fix,
//       Shadow DOM support, blob: URLs via canvas, SPA throttled rescan

(function() {
  'use strict';

  // Guard against extension context invalidation (reload/update)
  let contextValid = true;

  // Расширение перезагрузили/обновили: снимаем CSS и показываем всё
  // ожидающее классификации — иначе новые картинки повиснут с opacity: 0
  // (observer больше не сможет их обработать)
  function handleContextInvalidated() {
    if (!contextValid) return;
    contextValid = false;
    try { observer.disconnect(); } catch {}
    try { if (viewportObserver) viewportObserver.disconnect(); } catch {}
    removeFilterCSS();
    try {
      document.querySelectorAll(
        'img[data-nsfw-filter-status="processing"], video[data-nsfw-filter-status="processing"]'
      ).forEach(el => {
        el.dataset.nsfwFilterStatus = 'sfw';
        el.style.opacity = '';
      });
    } catch {}
  }

  function safeSendMessage(message) {
    if (!contextValid) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(err => {
      const msg = err.message || '';
      if (msg.includes('Extension context invalidated') ||
          msg.includes('message port closed')) {
        handleContextInvalidated();
      }
      return null;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════════

  let settings = {
    enabled: true,
    sensitivity: 50,
    categories: { porn: true, sexy: true, hentai: true }
  };

  // ═══════════════════════════════════════════════════════════════
  // SAFE URL PATTERNS — skip these entirely
  // ═══════════════════════════════════════════════════════════════

  // GIF больше не пропускаются целиком (v8.2): NSFW-гифки распространены,
  // классификатор анализирует первый кадр — этого достаточно
  const SAFE_URL_PATTERNS = [
    /\.svg(\?|$)/i,
    /^data:image\/svg/i,
    /^chrome-extension:\/\//i,
    /^moz-extension:\/\//i,
    /favicon/i,
    /\/sprite[s]?[\-_\.]/i,
  ];

  function isSafeUrl(url) {
    if (!url || url.length === 0) return true;
    // Allow data:image URLs (Google Images thumbnails, etc.)
    if (url.startsWith('data:image/')) {
      if (/^data:image\/svg/i.test(url)) return true;
      // Skip tiny data URLs (likely 1x1 tracking pixels / spacers)
      if (url.length < 200) return true;
      return false; // Process jpeg/png/webp/gif data URLs
    }
    if (!url.startsWith('http')) return true;
    return SAFE_URL_PATTERNS.some(pattern => pattern.test(url));
  }

  const MIN_IMAGE_SIZE = 32;
  const FAILSAFE_TIMEOUT = 20000; // мс: показать картинку, если вердикт не пришёл

  // ═══════════════════════════════════════════════════════════════
  // CSS INJECTION — hide images before classification
  // ═══════════════════════════════════════════════════════════════

  const FILTER_CSS = `
      img:not([data-nsfw-filter-status]),
      video[poster]:not([data-nsfw-filter-status]) {
        opacity: 0 !important;
      }
      img[data-nsfw-filter-status="processing"],
      video[data-nsfw-filter-status="processing"] {
        opacity: 0 !important;
      }
      img[data-nsfw-filter-status="nsfw"],
      video[data-nsfw-filter-status="nsfw"] {
        visibility: hidden !important;
      }
      img[data-nsfw-filter-status="sfw"],
      video[data-nsfw-filter-status="sfw"] {
        opacity: 1 !important;
      }
      [data-nsfw-pseudo-blocked~="before"]::before {
        background-image: none !important;
      }
      [data-nsfw-pseudo-blocked~="after"]::after {
        background-image: none !important;
      }
  `;

  // Стили страницы не проникают в Shadow DOM — инжектируем в каждый
  // обнаруженный shadow root отдельно
  const shadowStyles = new Set();   // <style> внутри shadow roots
  const knownShadowRoots = new Set();

  function injectFilterCSS() {
    if (document.getElementById('nsfw-filter-styles')) return;
    const style = document.createElement('style');
    style.id = 'nsfw-filter-styles';
    style.textContent = FILTER_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectShadowCSS(shadowRoot) {
    const style = document.createElement('style');
    style.textContent = FILTER_CSS;
    shadowRoot.appendChild(style);
    shadowStyles.add(style);
  }

  // Удаляет инжектированный CSS — иначе при выключенном фильтре
  // все непомеченные изображения остаются невидимыми (opacity: 0)
  function removeFilterCSS() {
    const style = document.getElementById('nsfw-filter-styles');
    if (style) style.remove();
    for (const s of shadowStyles) s.remove();
    shadowStyles.clear();
  }

  injectFilterCSS();

  // ═══════════════════════════════════════════════════════════════
  // CLASSIFICATION — send URL to background, get boolean result
  // ═══════════════════════════════════════════════════════════════

  const MAX_RETRIES = 2;
  const RETRY_DELAY = 500;

  async function requestPrediction(url) {
    if (!contextValid) return false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({ url });
        if (response && typeof response.result === 'boolean') {
          return response.result;
        }
        return false;
      } catch (error) {
        const msg = error.message || '';

        if (msg.includes('Extension context invalidated')) {
          handleContextInvalidated();
          return false;
        }

        const isDisconnect = msg.includes('disconnected') ||
          msg.includes('Receiving end does not exist') ||
          msg.includes('message port closed');

        if (isDisconnect && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // IMAGE ANALYSIS — core function
  // ═══════════════════════════════════════════════════════════════

  function isValidImageUrl(url) {
    return url && (url.startsWith('http') || url.startsWith('data:image/') ||
                   url.startsWith('blob:'));
  }

  // blob:-URL живут только в контексте страницы — offscreen document их
  // не загрузит. Рисуем на canvas здесь и отправляем data URL.
  // Blob-изображения same-origin по определению — canvas не «портится».
  function blobUrlToDataUrl(image, url) {
    return new Promise((resolve) => {
      const draw = (img) => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 299;
          canvas.height = 299;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 299, 299);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch {
          resolve(null); // tainted canvas или другой сбой — fail-open
        }
      };

      if (image.complete && image.naturalWidth > 0 && image.currentSrc === url) {
        draw(image);
        return;
      }
      const img = new Image();
      img.onload = () => draw(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function getImageUrl(image) {
    // Try currentSrc first (resolved srcset/picture source)
    if (isValidImageUrl(image.currentSrc)) return image.currentSrc;
    // Try src
    if (isValidImageUrl(image.src)) return image.src;
    // Try srcset (extract first http URL)
    if (image.srcset) {
      const match = image.srcset.match(/https?:\/\/[^\s,]+/);
      if (match) return match[0];
    }
    // Try data-src (lazy loading - various frameworks)
    const lazySrc = image.dataset.src || image.dataset.lazySrc ||
                    image.dataset.original || image.dataset.originalSrc ||
                    image.getAttribute('data-lazy');
    if (isValidImageUrl(lazySrc)) return lazySrc;
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // VIEWPORT-PRIORITIZED PREDICTION
  // Классификация запускается только когда картинка приближается к
  // вьюпорту (±600px). Иначе быстрый скролл (Google Images и т.п.)
  // ставит в очередь сотни предсказаний, и видимые картинки ждут
  // невидимые — visible-картинки висят с opacity: 0 минутами.
  // Бонус: фоновые вкладки не рендерят кадры → IO там не срабатывает →
  // ресурсы GPU не тратятся на невидимые вкладки.
  // ═══════════════════════════════════════════════════════════════

  let viewportObserver = null;

  function getViewportObserver() {
    if (viewportObserver) return viewportObserver;
    viewportObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        viewportObserver.unobserve(entry.target);
        startImagePrediction(entry.target);
      }
    }, { rootMargin: '600px' }); // запас со всех сторон: и скролл, и карусели
    return viewportObserver;
  }

  function analyzeImage(image, isSrcChange) {
    if (!settings.enabled || !contextValid) {
      // Filter disabled — mark as safe so images are visible
      if (!image.dataset.nsfwFilterStatus) image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    const imageIsNotAnalyzed = isSrcChange || image.dataset.nsfwFilterStatus === undefined;
    if (!imageIsNotAnalyzed) return;

    // Get the actual image URL (handles srcset, lazy-load, etc.)
    const url = getImageUrl(image);
    const isBlob = !!url && url.startsWith('blob:');
    if (!url || (!isBlob && isSafeUrl(url))) {
      image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    // Check size — but allow 0x0 (not yet rendered)
    const w = image.naturalWidth || image.width || image.offsetWidth;
    const h = image.naturalHeight || image.height || image.offsetHeight;
    if (w > 0 && w < MIN_IMAGE_SIZE && h > 0 && h < MIN_IMAGE_SIZE) {
      image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    // Mark as processing — CSS rule hides it. Предсказание запустится,
    // когда картинка приблизится к вьюпорту (повторный observe — no-op)
    image.dataset.nsfwFilterStatus = 'processing';
    getViewportObserver().observe(image);
  }

  // Запуск предсказания — вызывается IO, когда картинка возле вьюпорта.
  // URL берём заново: за время ожидания lazy-загрузчик мог его сменить
  function startImagePrediction(image) {
    if (image.dataset.nsfwFilterStatus !== 'processing') return;
    if (!settings.enabled || !contextValid) {
      image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    const url = getImageUrl(image);
    const isBlob = !!url && url.startsWith('blob:');
    if (!url || (!isBlob && isSafeUrl(url))) {
      image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    // Failsafe: если вердикт не пришёл за FAILSAFE_TIMEOUT (модель зависла,
    // очередь переполнена) — показываем картинку (fail-open). Если позже
    // всё же придёт вердикт NSFW, картинка будет скрыта.
    const failsafe = setTimeout(() => {
      if (image.dataset.nsfwFilterStatus === 'processing') {
        showImage(image, url);
      }
    }, FAILSAFE_TIMEOUT);

    // blob: конвертируем в data URL на месте, остальное отправляем как есть
    const prediction = isBlob
      ? blobUrlToDataUrl(image, url).then(dataUrl =>
          dataUrl ? requestPrediction(dataUrl) : false)
      : requestPrediction(url);

    prediction
      .then(isNSFW => {
        clearTimeout(failsafe);
        // Фильтр выключили, пока ждали вердикт — не блокируем
        if (isNSFW && settings.enabled) {
          image.dataset.nsfwFilterStatus = 'nsfw';
          // Also set inline style in case CSS rule gets overridden
          image.style.setProperty('visibility', 'hidden', 'important');
          updateStats(1, 1);
        } else {
          showImage(image, url);
          updateStats(0, 1);
        }
      })
      .catch(() => {
        clearTimeout(failsafe);
        showImage(image, url);
      });
  }

  // ═══════════════════════════════════════════════════════════════
  // IMAGE SHOW — only for safe images
  // ═══════════════════════════════════════════════════════════════

  function showImage(image, url) {
    // Only show if the image URL hasn't changed since analysis started
    const currentUrl = getImageUrl(image);
    if (currentUrl === url || !currentUrl) {
      image.dataset.nsfwFilterStatus = 'sfw';
      image.style.opacity = '';
      image.style.visibility = '';
      if (image.parentNode?.nodeName === 'BODY') image.hidden = false;
    }
  }

  // Re-apply hide if external code changes the style
  function checkStyleMutation(image) {
    if (image.dataset.nsfwFilterStatus !== 'nsfw') return;
    image.style.setProperty('visibility', 'hidden', 'important');
  }

  // ═══════════════════════════════════════════════════════════════
  // VIDEO POSTER — фильтрация постеров <video> (восстановлено из v1.8)
  // ═══════════════════════════════════════════════════════════════

  function analyzeVideoPoster(video, isChange) {
    if (!settings.enabled || !contextValid) {
      if (!video.dataset.nsfwFilterStatus) video.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    if (!isChange && video.dataset.nsfwFilterStatus !== undefined) return;

    const url = video.poster; // свойство всегда возвращает абсолютный URL
    if (!url || isSafeUrl(url)) {
      video.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    video.dataset.nsfwFilterStatus = 'processing';

    const failsafe = setTimeout(() => {
      if (video.dataset.nsfwFilterStatus === 'processing') {
        video.dataset.nsfwFilterStatus = 'sfw';
      }
    }, FAILSAFE_TIMEOUT);

    requestPrediction(url)
      .then(isNSFW => {
        clearTimeout(failsafe);
        if (isNSFW && settings.enabled) {
          video.dataset.nsfwFilterStatus = 'nsfw';
          video.style.setProperty('visibility', 'hidden', 'important');
          updateStats(1, 1);
        } else {
          video.dataset.nsfwFilterStatus = 'sfw';
          updateStats(0, 1);
        }
      })
      .catch(() => {
        clearTimeout(failsafe);
        video.dataset.nsfwFilterStatus = 'sfw';
      });
  }

  // ═══════════════════════════════════════════════════════════════
  // CSS BACKGROUND-IMAGE — фильтрация фонов (восстановлено из v1.8)
  // Фоны не прячутся заранее (fail-open): большинство декоративные,
  // NSFW-фон скрывается после вердикта
  // ═══════════════════════════════════════════════════════════════

  const BG_URL_REGEX = /url\(["']?([^"')]+)["']?\)/i;

  function extractBackgroundUrl(el) {
    const style = el.style.backgroundImage;
    if (!style || style === 'none') return null;
    const match = style.match(BG_URL_REGEX);
    if (!match) return null;
    try {
      return new URL(match[1], location.href).href;
    } catch {
      return null;
    }
  }

  function analyzeBackgroundElement(el) {
    if (!settings.enabled || !contextValid) return;
    if (el.nodeName === 'IMG' || el.nodeName === 'VIDEO') return;

    const url = extractBackgroundUrl(el);
    if (!url || !isValidImageUrl(url) || isSafeUrl(url)) return;

    // Уже обработан этот URL на этом элементе
    if (el.dataset.nsfwBgUrl === url) {
      // Сайт перезаписал стиль — восстанавливаем скрытие NSFW-фона
      if (el.dataset.nsfwBgStatus === 'nsfw' && el.style.backgroundImage !== 'none') {
        el.style.setProperty('background-image', 'none', 'important');
      }
      return;
    }

    // Пропускаем слишком мелкие элементы (иконки, буллеты)
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.width < MIN_IMAGE_SIZE &&
        rect.height > 0 && rect.height < MIN_IMAGE_SIZE) {
      return;
    }

    el.dataset.nsfwBgUrl = url;
    el.dataset.nsfwBgStatus = 'processing';
    classifyBackgroundUrl(el, url);
  }

  // Общий вердикт для основного фона (inline и computed)
  function classifyBackgroundUrl(el, url) {
    requestPrediction(url)
      .then(isNSFW => {
        if (isNSFW && settings.enabled) {
          el.dataset.nsfwBgStatus = 'nsfw';
          el.style.setProperty('background-image', 'none', 'important');
          updateStats(1, 1);
        } else {
          el.dataset.nsfwBgStatus = 'sfw';
          updateStats(0, 1);
        }
      })
      .catch(() => {
        el.dataset.nsfwBgStatus = 'sfw';
      });
  }

  // Извлекает NSFW-кандидатный URL из computed background-image
  // элемента или его pseudo-элемента ('::before' / '::after' / null)
  function extractComputedBgUrl(el, pseudo) {
    let bg;
    try {
      bg = getComputedStyle(el, pseudo).backgroundImage;
    } catch {
      return null;
    }
    if (!bg || bg === 'none') return null;
    const match = bg.match(BG_URL_REGEX);
    if (!match) return null;
    try {
      const url = new URL(match[1], location.href).href;
      return (isValidImageUrl(url) && !isSafeUrl(url)) ? url : null;
    } catch {
      return null;
    }
  }

  // Pseudo-элементу нельзя выставить inline-стиль — блокируем атрибутом,
  // на который в FILTER_CSS есть правило [data-nsfw-pseudo-blocked~=...]
  function classifyPseudoBackground(el, pseudo, url) {
    requestPrediction(url)
      .then(isNSFW => {
        if (isNSFW && settings.enabled) {
          const token = pseudo === '::before' ? 'before' : 'after';
          const cur = el.dataset.nsfwPseudoBlocked || '';
          if (!(' ' + cur + ' ').includes(' ' + token + ' ')) {
            el.dataset.nsfwPseudoBlocked = cur ? cur + ' ' + token : token;
          }
          updateStats(1, 1);
        } else {
          updateStats(0, 1);
        }
      })
      .catch(() => {});
  }

  // Проход по computed-фонам (классовые фоны без inline style) и
  // pseudo-элементам ::before/::after. Первый запуск после загрузки
  // страницы, далее — троттлированно по мутациям. Негативный кэш:
  // элементы без фона повторно не проверяем (SPA обычно создают новые
  // элементы, а не перекрашивают старые)
  let checkedBgElements = new WeakSet();

  function scanComputedBackgrounds() {
    if (!settings.enabled || !contextValid) return;
    const candidates = document.querySelectorAll('div[class], a[class], span[class], section[class], li[class]');
    const limit = Math.min(candidates.length, 3000);
    for (let i = 0; i < limit; i++) {
      const el = candidates[i];
      if (checkedBgElements.has(el)) continue;
      checkedBgElements.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_IMAGE_SIZE || rect.height < MIN_IMAGE_SIZE) continue;

      // Основной фон (если ещё не обработан inline-сканом)
      if (!el.dataset.nsfwBgUrl) {
        const url = extractComputedBgUrl(el, null);
        if (url) {
          el.dataset.nsfwBgUrl = url;
          el.dataset.nsfwBgStatus = 'processing';
          classifyBackgroundUrl(el, url);
        }
      }

      // ::before / ::after с background-image
      for (const pseudo of ['::before', '::after']) {
        const url = extractComputedBgUrl(el, pseudo);
        if (url) classifyPseudoBackground(el, pseudo, url);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STATISTICS (debounced)
  // ═══════════════════════════════════════════════════════════════

  let statsBuffer = { blocked: 0, scanned: 0 };
  let statsTimeout = null;

  function updateStats(blocked, scanned) {
    statsBuffer.blocked += blocked;
    statsBuffer.scanned += scanned;

    if (!statsTimeout) {
      statsTimeout = setTimeout(() => {
        safeSendMessage({
          type: 'UPDATE_STATS',
          blocked: statsBuffer.blocked,
          scanned: statsBuffer.scanned
        });
        statsBuffer = { blocked: 0, scanned: 0 };
        statsTimeout = null;
      }, 2000);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM WATCHER — MutationObserver
  // ═══════════════════════════════════════════════════════════════

  // Работает и с Element, и с Document, и с ShadowRoot
  // (у ShadowRoot нет getElementsByTagName — только querySelectorAll)
  function findAndCheckAllImages(root) {
    if (!root || !root.querySelectorAll) return;

    // querySelectorAll не включает сам корень — проверяем его отдельно
    if (root.nodeType === 1) {
      if (root.nodeName === 'IMG') {
        analyzeImage(root, false);
        return;
      }
      if (root.nodeName === 'VIDEO') {
        if (root.hasAttribute('poster')) analyzeVideoPoster(root, false);
        return;
      }
      if (root.hasAttribute('style')) analyzeBackgroundElement(root);
    }

    const images = root.querySelectorAll('img');
    for (let i = 0; i < images.length; i++) {
      analyzeImage(images[i], false);
    }
    // <video poster="..."> — фильтруем постеры
    const videos = root.querySelectorAll('video[poster]');
    for (let i = 0; i < videos.length; i++) {
      analyzeVideoPoster(videos[i], false);
    }
    // Элементы с inline background-image
    const bgElements = root.querySelectorAll('[style*="background"]');
    for (let i = 0; i < bgElements.length; i++) {
      analyzeBackgroundElement(bgElements[i]);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SHADOW DOM — сканирование и наблюдение открытых shadow roots
  // ═══════════════════════════════════════════════════════════════

  function attachShadowRoot(shadowRoot) {
    if (knownShadowRoots.has(shadowRoot)) return;
    knownShadowRoots.add(shadowRoot);
    if (settings.enabled) injectShadowCSS(shadowRoot);
    observer.observe(shadowRoot, OBSERVER_CONFIG);
    findAndCheckAllImages(shadowRoot);
    scanForShadowRoots(shadowRoot); // вложенные shadow roots
  }

  // Обходит поддерево и подключает все открытые shadow roots
  function scanForShadowRoots(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.shadowRoot) {
      attachShadowRoot(root.shadowRoot);
    }
    if (!root.querySelectorAll) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) attachShadowRoot(el.shadowRoot);
    }
  }

  // MAIN-world скрипт (main-world.js) патчит attachShadow: закрытые roots
  // становятся открытыми, и при создании диспатчится это событие.
  // Ловим его и сразу подключаем новый root (если хост уже в DOM)
  document.addEventListener('__nsfw_filter_shadow_attached__', (e) => {
    if (!settings.enabled || !contextValid) return;
    const host = e.target;
    if (host && host.nodeType === 1 && host.shadowRoot) {
      attachShadowRoot(host.shadowRoot);
    }
  }, true);

  // ═══════════════════════════════════════════════════════════════
  // THROTTLED RESCAN — для SPA: classed-фоны и поздние shadow roots
  // ═══════════════════════════════════════════════════════════════

  const RESCAN_INTERVAL = 4000;
  let rescanTimer = null;
  let lastFullRescan = 0;

  function scheduleFullRescan() {
    if (rescanTimer) return;
    const wait = Math.max(RESCAN_INTERVAL - (Date.now() - lastFullRescan), 500);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      lastFullRescan = Date.now();
      if (!settings.enabled || !contextValid) return;
      scanComputedBackgrounds();
      scanForShadowRoots(document.documentElement);
    }, wait);
  }

  const OBSERVER_CONFIG = {
    characterData: false,
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'src', 'style', 'srcset', 'poster',
      'data-src', 'data-lazy-src', 'data-original', 'data-original-src', 'data-lazy'
    ]
  };

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled || !contextValid) return;

    let addedElements = false;

    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];

      if (mutation.type === 'childList') {
        for (let j = 0; j < mutation.addedNodes.length; j++) {
          const node = mutation.addedNodes[j];
          if (node.nodeType !== 1) continue; // Only element nodes

          addedElements = true;
          findAndCheckAllImages(node); // проверяет и сам узел, и потомков

          // Открытые shadow roots в добавленном поддереве
          if (node.shadowRoot || node.firstElementChild) {
            scanForShadowRoots(node);
          }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        const attr = mutation.attributeName;

        if (target.nodeName === 'IMG') {
          if (attr === 'style') {
            checkStyleMutation(target);
          } else if (attr === 'src') {
            // src changed — re-analyze
            if (target.dataset.nsfwFilterStatus !== 'nsfw') {
              delete target.dataset.nsfwFilterStatus;
              analyzeImage(target, true);
            }
          } else if (attr !== 'style') {
            // Lazy-load атрибут (data-src, srcset и т.д.) изменился —
            // анализируем, если ещё не обработана
            if (!target.dataset.nsfwFilterStatus) {
              analyzeImage(target, false);
            }
          }
        } else if (target.nodeName === 'VIDEO') {
          if (attr === 'poster') {
            // Постер изменился — переанализируем
            if (target.dataset.nsfwFilterStatus !== 'nsfw') {
              analyzeVideoPoster(target, true);
            }
          } else if (attr === 'style') {
            checkStyleMutation(target); // повторно скрыть NSFW-видео
          }
        } else if (attr === 'style') {
          // Lazy-загрузчики ставят background-image через inline style
          analyzeBackgroundElement(target);
        }
      }
    }

    // SPA дорисовала контент — запланировать перескан classed-фонов
    // и поздних shadow roots (не чаще раза в RESCAN_INTERVAL)
    if (addedElements) scheduleFullRescan();
  });

  // ═══════════════════════════════════════════════════════════════
  // SETTINGS UPDATES
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SETTINGS_UPDATED') {
      const wasEnabled = settings.enabled;
      settings = message.settings;

      // Собираем все корни: документ + известные shadow roots
      const allRoots = [document, ...knownShadowRoots];

      if (!settings.enabled) {
        // Выключение: убираем CSS (иначе новые img будут невидимы)
        // и разблокируем всё скрытое
        removeFilterCSS();
        for (const root of allRoots) {
          root.querySelectorAll('img, video').forEach(el => {
            el.dataset.nsfwFilterStatus = 'sfw';
            el.style.visibility = '';
            el.style.opacity = '';
            if (el.parentNode?.nodeName === 'BODY') el.hidden = false;
          });
          // Восстанавливаем заблокированные фоны
          root.querySelectorAll('[data-nsfw-bg-status="nsfw"]').forEach(el => {
            el.style.removeProperty('background-image');
            delete el.dataset.nsfwBgStatus;
            delete el.dataset.nsfwBgUrl;
          });
          // И заблокированные pseudo-фоны
          root.querySelectorAll('[data-nsfw-pseudo-blocked]').forEach(el => {
            delete el.dataset.nsfwPseudoBlocked;
          });
        }
      } else if (!wasEnabled) {
        // Re-enable: reset all statuses and re-scan
        injectFilterCSS();
        for (const root of allRoots) {
          root.querySelectorAll('img[data-nsfw-filter-status], video[data-nsfw-filter-status]').forEach(el => {
            delete el.dataset.nsfwFilterStatus;
          });
          root.querySelectorAll('[data-nsfw-bg-url]').forEach(el => {
            delete el.dataset.nsfwBgStatus;
            delete el.dataset.nsfwBgUrl;
          });
        }
        for (const sr of knownShadowRoots) injectShadowCSS(sr);
        // Сбрасываем негативный кэш фонов — computed-скан пройдёт заново
        checkedBgElements = new WeakSet();
        // Если страница загрузилась с выключенным фильтром, init() вышел
        // до запуска observer — стартуем наблюдение здесь (повторный
        // observe того же target безопасен: опции просто заменяются)
        observer.observe(document, OBSERVER_CONFIG);
        findAndCheckAllImages(document.documentElement);
        for (const sr of knownShadowRoots) findAndCheckAllImages(sr);
        scanForShadowRoots(document.documentElement);
        scanComputedBackgrounds();
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  async function init() {
    if (!contextValid) {
      removeFilterCSS();
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response) settings = response;
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        handleContextInvalidated();
        return;
      }
    }

    if (!settings.enabled) {
      // Фильтр выключен: обязательно убрать CSS, иначе все картинки
      // останутся с opacity: 0 (никто не проставит им статус)
      removeFilterCSS();
      return;
    }

    // Start observing DOM mutations
    observer.observe(document, OBSERVER_CONFIG);

    // Scan existing images, video posters and inline backgrounds
    findAndCheckAllImages(document.documentElement);

    // Открытые shadow roots, созданные до инициализации
    scanForShadowRoots(document.documentElement);

    // Классовые (computed) фоны — проход после полной загрузки,
    // дальше — троттлированные пересканы по мутациям (scheduleFullRescan)
    if (document.readyState === 'complete') {
      scanComputedBackgrounds();
    } else {
      window.addEventListener('load', () => {
        setTimeout(scanComputedBackgrounds, 500);
      }, { once: true });
    }

    console.log('NSFW Filter v8.2: Initialized (WebGPU, URL-based, no sandbox)');
  }

  // Run at document_start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
