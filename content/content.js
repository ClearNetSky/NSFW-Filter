// NSFW Filter Content Script — v7.0
// Централизованная модель через offscreen document (загружается один раз)
// 5-классовая система NSFWJS: Drawing, Hentai, Neutral, Porn, Sexy
// v7.0: opacity-hide pending images, scan ALL, dark mode popup

(async function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // КОНФИГУРАЦИЯ
  // ═══════════════════════════════════════════════════════════════
  
  let settings = {
    enabled: true,
    sensitivity: 50,
    categories: { porn: true, sexy: true, hentai: true }
  };

  // ═══════════════════════════════════════════════════════════════
  // ПРОПУСК БЕЗОПАСНЫХ ПАТТЕРНОВ
  // ═══════════════════════════════════════════════════════════════
  // SVG, data:image/svg, 1x1 трекинг-пиксели, иконки расширений

  const SAFE_URL_PATTERNS = [
    /\.svg(\?|$)/i,                         // SVG файлы
    /^data:image\/svg/i,                     // SVG data URL
    /^chrome-extension:\/\//i,               // Ресурсы расширений
    /^moz-extension:\/\//i,                  // Firefox расширения
    /favicon/i,                              // Фавиконы
    /\/icons?\//i,                           // Папки иконок
    /\.(gif)(\?|$)/i,                        // GIF (обычно анимации/иконки)
    /^data:image\/gif;base64,.{0,200}$/i,    // Крошечные GIF (трекеры)
    /\/sprite[s]?[\-_\.]/i,                  // CSS спрайты
    /badge|logo|avatar/i,                    // Значки, логотипы
  ];

  function isSafeUrl(url) {
    if (!url) return false;
    return SAFE_URL_PATTERNS.some(pattern => pattern.test(url));
  }

  // Проверка: трекинг-пиксель (1x1, 2x2 и т.д.)
  function isTrackingPixel(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return (w <= 3 && h <= 3);
  }

  // Параметры производительности
  const CONFIG = {
    MIN_IMAGE_SIZE: 50,          // Минимальный размер изображения (px)
    MAX_CONCURRENT: 6,           // Параллельных классификаций одновременно
    RESIZE_TARGET: 299,          // Размер для модели (299x299)
    JPEG_QUALITY: 0.7,           // Качество JPEG (ниже = быстрее передача)
    STATS_DEBOUNCE: 2000,        // Частота отправки статистики (мс)
    SCAN_DEBOUNCE: 50,           // Дебаунс сканирования DOM (мс)
    BATCH_SIZE: 8,               // Размер пакета для одновременной обработки
  };

  // ═══════════════════════════════════════════════════════════════
  // CSS INJECTION — скрываем изображения до завершения классификации
  // ═══════════════════════════════════════════════════════════════
  // Новые изображения получают opacity:0 (белый фон) до проверки.
  // Если безопасно → opacity восстанавливается. Если NSFW → placeholder.
  // Пользователь НИКОГДА не увидит NSFW: картинка скрыта до вердикта.

  function injectScanningCSS() {
    if (document.getElementById('nsfw-filter-styles')) return;
    const style = document.createElement('style');
    style.id = 'nsfw-filter-styles';
    style.textContent = `
      .nsfw-pending {
        opacity: 0 !important;
        transition: opacity 0.15s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Инжектируем CSS как можно раньше
  injectScanningCSS();

  // ═══════════════════════════════════════════════════════════════
  // СОСТОЯНИЕ
  // ═══════════════════════════════════════════════════════════════

  let processedImages = new WeakSet();
  let activeTasks = 0;
  let imageQueue = [];          // Очередь изображений с приоритетами
  let isProcessingQueue = false;
  let scanDebounceTimer = null;

  // Кэш результатов классификации по URL — избегаем повторной классификации
  // одного и того же изображения (например, тот же URL в нескольких <img>)
  const classificationCache = new Map();
  const CACHE_MAX_SIZE = 500;   // Максимум записей в кэше

  function getCachedResult(url) {
    if (!url || url.startsWith('data:')) return null;
    return classificationCache.get(url) || null;
  }

  function cacheResult(url, result) {
    if (!url || url.startsWith('data:')) return;
    // Очищаем кэш при переполнении (LRU-подобное — удаляем старые)
    if (classificationCache.size >= CACHE_MAX_SIZE) {
      const firstKey = classificationCache.keys().next().value;
      classificationCache.delete(firstKey);
    }
    classificationCache.set(url, result);
  }

  // Переиспользуемый canvas для конвертации
  let sharedCanvas = null;
  let sharedCtx = null;

  function getSharedCanvas() {
    if (!sharedCanvas) {
      sharedCanvas = document.createElement('canvas');
      sharedCanvas.width = CONFIG.RESIZE_TARGET;
      sharedCanvas.height = CONFIG.RESIZE_TARGET;
      sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: false });
    }
    return { canvas: sharedCanvas, ctx: sharedCtx };
  }

  // ═══════════════════════════════════════════════════════════════
  // КЛАССИФИКАЦИЯ ЧЕРЕЗ BACKGROUND (модель в offscreen document)
  // ═══════════════════════════════════════════════════════════════

  const MAX_RETRIES = 2;
  const RETRY_DELAY = 1000; // мс

  async function classifyImage(imageDataUrl) {
    let lastError;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CLASSIFY_IMAGE',
          imageDataUrl
        });
        if (response && response.success) return response.predictions;
        throw new Error(response?.error || 'Classification failed');
      } catch (error) {
        lastError = error;
        const msg = error.message || '';
        
        // Ошибки связи с SW — retry с задержкой
        const isDisconnect = msg.includes('disconnected') ||
          msg.includes('Receiving end does not exist') ||
          msg.includes('Extension context invalidated') ||
          msg.includes('message port closed');
        
        if (isDisconnect && attempt < MAX_RETRIES) {
          console.debug(`NSFW Filter: SW disconnected, retry ${attempt + 1}/${MAX_RETRIES}...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  // ═══════════════════════════════════════════════════════════════
  // ОПТИМИЗИРОВАННАЯ КОНВЕРТАЦИЯ ИЗОБРАЖЕНИЙ
  // ═══════════════════════════════════════════════════════════════

  // Уменьшаем изображение до 299x299 и конвертируем в data URL
  // Это критически важно: модели нужно 299x299, нет смысла передавать 4K
  function imageToOptimizedDataUrl(img) {
    const { canvas, ctx } = getSharedCanvas();
    
    // Очищаем и рисуем с масштабированием до 299x299
    ctx.clearRect(0, 0, CONFIG.RESIZE_TARGET, CONFIG.RESIZE_TARGET);
    ctx.drawImage(img, 0, 0, CONFIG.RESIZE_TARGET, CONFIG.RESIZE_TARGET);
    
    try {
      return canvas.toDataURL('image/jpeg', CONFIG.JPEG_QUALITY);
    } catch (e) {
      // Canvas is tainted by cross-origin image — cannot export
      // This happens when images are served from different domains (e.g., Google Images)
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // СИСТЕМА ОЧЕРЕДЕЙ — СКАНИРОВАНИЕ ВСЕХ ИЗОБРАЖЕНИЙ
  // ═══════════════════════════════════════════════════════════════
  // Все изображения обрабатываются в порядке появления в DOM.
  // Предварительное размытие (blur) скрывает контент до классификации.
  // IntersectionObserver убран — ВСЕ изображения сканируются сразу.

  function enqueueImage(img) {
    imageQueue.push({ img });
    drainQueue();
  }

  async function drainQueue() {
    if (isProcessingQueue) return;
    if (imageQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (imageQueue.length > 0 && activeTasks < CONFIG.MAX_CONCURRENT) {
      const batch = [];
      
      // Берём до BATCH_SIZE изображений
      while (batch.length < CONFIG.BATCH_SIZE && imageQueue.length > 0 && activeTasks + batch.length < CONFIG.MAX_CONCURRENT) {
        const item = imageQueue.shift();
        if (item && item.img && item.img.isConnected && !processedImages.has(item.img) && item.img.dataset.nsfwBlocked !== 'true') {
          batch.push(item.img);
        }
      }
      
      if (batch.length === 0) break;
      
      // Запускаем все изображения пакета параллельно
      for (const img of batch) {
        activeTasks++;
        processImage(img).finally(() => {
          activeTasks--;
          // Запускаем следующие из очереди
          if (imageQueue.length > 0 && activeTasks < CONFIG.MAX_CONCURRENT) {
            drainQueue();
          }
        });
      }
    }
    
    isProcessingQueue = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // ОБРАБОТКА ИЗОБРАЖЕНИЙ
  // ═══════════════════════════════════════════════════════════════

  async function processImage(img) {
    if (!settings.enabled) return;
    if (processedImages.has(img)) return;
    if (img.dataset.nsfwBlocked === 'true') return;
    
    // Проверяем размер
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < CONFIG.MIN_IMAGE_SIZE || h < CONFIG.MIN_IMAGE_SIZE) return;
    
    processedImages.add(img);
    
    try {
      // Проверяем кэш результатов по URL
      const imgUrl = img.src;
      const cached = getCachedResult(imgUrl);
      if (cached) {
        if (cached.shouldBlock) {
          blockImage(img, cached.reason, cached.category);
          updateStats(1, 1);
        } else {
          img.classList.remove('nsfw-pending'); // Безопасно: показываем
          updateStats(0, 1);
        }
        return;
      }

      // Оптимизированная конвертация: уменьшаем до 299x299
      let imageDataUrl = imageToOptimizedDataUrl(img);
      
      // If canvas is tainted (cross-origin image), try re-fetching with CORS
      if (!imageDataUrl && img.src && (img.src.startsWith('http://') || img.src.startsWith('https://'))) {
        imageDataUrl = await fetchImageAsDataUrl(img.src);
      }
      
      if (!imageDataUrl) {
        // Cannot convert image — показываем и пропускаем
        img.classList.remove('nsfw-pending');
        return;
      }
      
      const predictions = await classifyImage(imageDataUrl);
      
      if (predictions) {
        const result = analyzeResults(predictions);
        
        // Кэшируем результат по URL
        cacheResult(imgUrl, result);
        
        if (result.shouldBlock) {
          blockImage(img, result.reason, result.category);
          updateStats(1, 1);
        } else {
          img.classList.remove('nsfw-pending'); // Безопасно: показываем
          updateStats(0, 1);
        }
      } else {
        img.classList.remove('nsfw-pending'); // Нет результатов: показываем
      }
    } catch (error) {
      // Не блокируем при ошибке, но убираем из обработанных для повторной попытки
      processedImages.delete(img);
      img.classList.remove('nsfw-pending'); // Ошибка: показываем
      console.debug('NSFW Filter: Process error', error.message);
    }
  }

  // Fetch cross-origin image as data URL via background service worker
  // Background SW не подчиняется CORS-политике страницы,
  // поэтому может загрузить изображения с любого домена (DuckDuckGo, Bing и т.д.)
  async function fetchImageAsDataUrl(url) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE',
        url
      });
      if (response && response.success) return response.dataUrl;
      return null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 5-КЛАССОВАЯ СИСТЕМА КЛАССИФИКАЦИИ NSFWJS
  // ═══════════════════════════════════════════════════════════════
  //
  // Классы NSFWJS:
  //   Drawing  — безопасные рисунки/иллюстрации (включая аниме)
  //   Hentai   — хентай, порнографические рисунки
  //   Neutral  — безопасный нейтральный контент
  //   Porn     — порнография, сексуальные акты
  //   Sexy     — откровенный контент, не порнография
  //
  // Логика: Drawing и Neutral = БЕЗОПАСНО
  //         Porn, Sexy, Hentai = потенциально NSFW (зависит от настроек)
  //
  // Алгоритм:
  // 1. Собираем баллы для каждого класса
  // 2. Если "безопасные" классы (Drawing + Neutral) доминируют → пропускаем
  // 3. Если NSFW-классы превышают порог → блокируем
  // 4. Используем комбинированный скоринг для лучшей точности

  function analyzeResults(predictions) {
    // Порог чувствительности: sensitivity 0 → threshold 1.0, sensitivity 100 → threshold 0.0
    const threshold = 1 - (settings.sensitivity / 100);
    
    // Собираем вероятности по классам
    const scores = {
      drawing: 0,
      hentai: 0,
      neutral: 0,
      porn: 0,
      sexy: 0
    };
    
    for (const pred of predictions) {
      const cls = pred.className.toLowerCase();
      if (cls in scores) {
        scores[cls] = pred.probability;
      }
    }
    
    // Суммарный "безопасный" скор
    const safeScore = scores.drawing + scores.neutral;
    
    // Суммарный NSFW скор
    const nsfwScore = scores.porn + scores.hentai + scores.sexy;
    
    // Быстрый выход: если безопасные классы доминируют (>75%), не блокируем
    if (safeScore > 0.75 && nsfwScore < 0.25) {
      return { shouldBlock: false, reason: '', category: '', score: 0 };
    }
    
    let shouldBlock = false;
    let reason = '';
    let category = '';
    let maxScore = 0;
    
    // Проверяем PORN
    if (settings.categories.porn && scores.porn >= threshold) {
      shouldBlock = true;
      if (scores.porn > maxScore) {
        maxScore = scores.porn;
        reason = 'Porn';
        category = 'porn';
      }
    }
    
    // Проверяем HENTAI
    // Учитываем разницу между Drawing и Hentai:
    // если Drawing-скор высокий, повышаем порог для Hentai
    if (settings.categories.hentai) {
      let hentaiThreshold = threshold;
      // Если Drawing тоже высок, нужна бóльшая уверенность для Hentai
      if (scores.drawing > 0.3) {
        hentaiThreshold = Math.min(threshold + 0.15, 0.95);
      }
      if (scores.hentai >= hentaiThreshold) {
        shouldBlock = true;
        if (scores.hentai > maxScore) {
          maxScore = scores.hentai;
          reason = 'Hentai';
          category = 'hentai';
        }
      }
    }
    
    // Проверяем SEXY
    // Sexy — менее серьёзная категория, повышаем порог
    if (settings.categories.sexy) {
      const sexyThreshold = Math.min(threshold + 0.15, 0.95);
      // Если Neutral высок, ещё больше повышаем порог
      if (scores.neutral > 0.3) {
        const adjustedThreshold = Math.min(sexyThreshold + 0.1, 0.95);
        if (scores.sexy >= adjustedThreshold) {
          shouldBlock = true;
          if (scores.sexy > maxScore) {
            maxScore = scores.sexy;
            reason = 'Sexy';
            category = 'sexy';
          }
        }
      } else if (scores.sexy >= sexyThreshold) {
        shouldBlock = true;
        if (scores.sexy > maxScore) {
          maxScore = scores.sexy;
          reason = 'Sexy';
          category = 'sexy';
        }
      }
    }
    
    // Дополнительная проверка: комбинированный NSFW-скор
    // Если по отдельности не дотягивают, но вместе — явно NSFW
    if (!shouldBlock && nsfwScore > 0.7 && safeScore < 0.3) {
      // Определяем доминирующую категорию
      if (scores.porn >= scores.hentai && scores.porn >= scores.sexy && settings.categories.porn) {
        shouldBlock = true;
        maxScore = scores.porn;
        reason = 'Porn';
        category = 'porn';
      } else if (scores.hentai >= scores.porn && scores.hentai >= scores.sexy && settings.categories.hentai) {
        shouldBlock = true;
        maxScore = scores.hentai;
        reason = 'Hentai';
        category = 'hentai';
      } else if (settings.categories.sexy) {
        shouldBlock = true;
        maxScore = scores.sexy;
        reason = 'Sexy';
        category = 'sexy';
      }
    }
    
    return { shouldBlock, reason, category, score: maxScore };
  }

  // ═══════════════════════════════════════════════════════════════
  // БЛОКИРОВКА ИЗОБРАЖЕНИЙ
  // ═══════════════════════════════════════════════════════════════

  // Кэш для placeholder разных размеров
  const placeholderCache = new Map();

  function getPlaceholderDataUrl(width, height) {
    // Округляем до сетки 50px для лучшего кэширования
    const cw = Math.round(width / 50) * 50 || 100;
    const ch = Math.round(height / 50) * 50 || 100;
    const key = `${cw}x${ch}`;
    
    if (placeholderCache.has(key)) {
      return placeholderCache.get(key);
    }
    
    // SVG placeholder — в 50-100x легче чем PNG canvas
    // Адаптивный: щит + текст "NSFW" масштабируются под любой размер
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">
      <rect width="100%" height="100%" fill="#f0f0f0"/>
      <g transform="translate(${cw/2},${ch/2})" opacity="0.3">
        <path d="M0 ${-ch*0.12} L${cw*0.1} ${-ch*0.06} L${cw*0.1} ${ch*0.06} Q0 ${ch*0.15} 0 ${ch*0.15} Q0 ${ch*0.15} ${-cw*0.1} ${ch*0.06} L${-cw*0.1} ${-ch*0.06} Z" fill="#999"/>
        <text y="${ch*0.2}" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(10, Math.min(cw,ch)*0.07)}" fill="#999" font-weight="600">NSFW</text>
      </g>
    </svg>`;
    
    const dataUrl = 'data:image/svg+xml,' + encodeURIComponent(svg);
    placeholderCache.set(key, dataUrl);
    
    return dataUrl;
  }

  function blockImage(img, reason, category) {
    // Снимаем pending-скрытие
    img.classList.remove('nsfw-pending');
    
    img.dataset.nsfwOriginalSrc = img.src;
    img.dataset.nsfwBlocked = 'true';
    img.dataset.nsfwReason = reason;
    img.dataset.nsfwCategory = category;
    
    const w = img.naturalWidth || img.width || 200;
    const h = img.naturalHeight || img.height || 200;
    
    img.src = getPlaceholderDataUrl(w, h);
    img.style.filter = 'none';
    img.style.opacity = '1';
    
    console.log(`NSFW Filter: Blocked [${category}] (${reason})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // СТАТИСТИКА (с дебаунсингом)
  // ═══════════════════════════════════════════════════════════════

  let statsBuffer = { blocked: 0, scanned: 0 };
  let statsTimeout = null;

  function updateStats(blocked, scanned) {
    statsBuffer.blocked += blocked;
    statsBuffer.scanned += scanned;

    if (!statsTimeout) {
      statsTimeout = setTimeout(() => {
        chrome.runtime.sendMessage({
          type: 'UPDATE_STATS',
          blocked: statsBuffer.blocked,
          scanned: statsBuffer.scanned
        }).catch(() => {});
        
        statsBuffer = { blocked: 0, scanned: 0 };
        statsTimeout = null;
      }, CONFIG.STATS_DEBOUNCE);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ОБРАБОТКА DOM
  // ═══════════════════════════════════════════════════════════════

  async function fetchSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response) {
        settings = response;
      }
    } catch (error) {
      console.error('NSFW Filter: Failed to fetch settings', error);
    }
  }

  function handleImage(img) {
    if (!settings.enabled) return;
    if (processedImages.has(img)) return;
    if (img.dataset.nsfwBlocked === 'true') return;
    
    // Пропускаем безопасные URL (SVG, favicon, иконки и т.д.)
    if (isSafeUrl(img.src)) {
      processedImages.add(img);
      return;
    }
    
    // Пропускаем трекинг-пиксели
    if (isTrackingPixel(img)) {
      processedImages.add(img);
      return;
    }
    
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < CONFIG.MIN_IMAGE_SIZE && h < CONFIG.MIN_IMAGE_SIZE) return;

    // Скрываем изображение до завершения проверки (opacity: 0)
    img.classList.add('nsfw-pending');

    if (img.complete && img.naturalWidth > 0) {
      enqueueImage(img);
    } else {
      img.addEventListener('load', () => {
        if (!processedImages.has(img)) enqueueImage(img);
      }, { once: true });
    }
  }

  // Дебаунсированное сканирование страницы
  function scanPage() {
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(() => {
      const images = document.querySelectorAll('img');
      for (let i = 0; i < images.length; i++) {
        handleImage(images[i]);
      }
      // Сканируем CSS background-image
      scanBackgroundImages();
      // Сканируем <video> poster
      scanVideoPoster();
    }, CONFIG.SCAN_DEBOUNCE);
  }

  // Сканирование без дебаунса (для первого запуска)
  function scanPageImmediate() {
    const images = document.querySelectorAll('img');
    for (let i = 0; i < images.length; i++) {
      handleImage(images[i]);
    }
    // Сканируем CSS background-image
    scanBackgroundImages();
    // Сканируем <video> poster
    scanVideoPoster();
  }

  // ═══════════════════════════════════════════════════════════════
  // CSS BACKGROUND-IMAGE СКАНИРОВАНИЕ
  // ═══════════════════════════════════════════════════════════════

  const processedBgElements = new WeakSet();
  const bgUrlRegex = /url\(["']?(https?:\/\/[^"')]+)["']?\)/i;

  function scanBackgroundImages() {
    if (!settings.enabled) return;
    
    // Сканируем элементы с inline style background-image
    const candidates = document.querySelectorAll('[style*="background"]');
    for (const el of candidates) {
      handleBackgroundImage(el);
    }
    
    // Сканируем распространённые контейнеры (div, span, a) с computed background
    // Ограничиваем для производительности — только видимые элементы разумного размера
    const containers = document.querySelectorAll('div[class], a[class], span[class]');
    for (const el of containers) {
      if (!processedBgElements.has(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= CONFIG.MIN_IMAGE_SIZE && rect.height >= CONFIG.MIN_IMAGE_SIZE) {
          const computed = getComputedStyle(el);
          if (computed.backgroundImage && computed.backgroundImage !== 'none') {
            handleBackgroundImage(el);
          }
        }
      }
    }
  }

  function handleBackgroundImage(el) {
    if (processedBgElements.has(el)) return;
    if (el.dataset.nsfwBgBlocked === 'true') return;
    
    const style = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
    if (!style || style === 'none') return;
    
    const match = style.match(bgUrlRegex);
    if (!match) return;
    
    const url = match[1];
    if (!url) return;
    
    processedBgElements.add(el);
    
    // Проверяем кэш
    const cached = getCachedResult(url);
    if (cached) {
      if (cached.shouldBlock) {
        blockBackgroundElement(el, cached.reason, cached.category);
        updateStats(1, 1);
      } else {
        updateStats(0, 1);
      }
      return;
    }
    
    // Загружаем и классифицируем
    activeTasks++;
    (async () => {
      try {
        const imageDataUrl = await fetchImageAsDataUrl(url);
        if (!imageDataUrl) return;
        
        const predictions = await classifyImage(imageDataUrl);
        if (predictions) {
          const result = analyzeResults(predictions);
          cacheResult(url, result);
          
          if (result.shouldBlock) {
            blockBackgroundElement(el, result.reason, result.category);
            updateStats(1, 1);
          } else {
            updateStats(0, 1);
          }
        }
      } catch (error) {
        processedBgElements.delete(el);
        console.debug('NSFW Filter: Background image error', error.message);
      } finally {
        activeTasks--;
        if (imageQueue.length > 0) drainQueue();
      }
    })();
  }

  function blockBackgroundElement(el, reason, category) {
    el.dataset.nsfwBgOriginal = el.style.backgroundImage || '';
    el.dataset.nsfwBgBlocked = 'true';
    el.dataset.nsfwReason = reason;
    el.dataset.nsfwCategory = category;
    
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = '#f5f5f5';
    
    console.log(`NSFW Filter: Blocked background [${category}] (${reason})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // VIDEO POSTER СКАНИРОВАНИЕ
  // ═══════════════════════════════════════════════════════════════

  const processedVideos = new WeakSet();

  function scanVideoPoster() {
    if (!settings.enabled) return;
    
    const videos = document.querySelectorAll('video[poster]');
    for (const video of videos) {
      handleVideoPoster(video);
    }
  }

  function handleVideoPoster(video) {
    if (processedVideos.has(video)) return;
    if (video.dataset.nsfwPosterBlocked === 'true') return;
    
    const posterUrl = video.poster;
    if (!posterUrl || (!posterUrl.startsWith('http://') && !posterUrl.startsWith('https://'))) return;
    
    const rect = video.getBoundingClientRect();
    if (rect.width < CONFIG.MIN_IMAGE_SIZE || rect.height < CONFIG.MIN_IMAGE_SIZE) return;
    
    processedVideos.add(video);
    
    // Проверяем кэш
    const cached = getCachedResult(posterUrl);
    if (cached) {
      if (cached.shouldBlock) {
        blockVideoPoster(video, cached.reason, cached.category);
        updateStats(1, 1);
      } else {
        updateStats(0, 1);
      }
      return;
    }
    
    activeTasks++;
    (async () => {
      try {
        const imageDataUrl = await fetchImageAsDataUrl(posterUrl);
        if (!imageDataUrl) return;
        
        const predictions = await classifyImage(imageDataUrl);
        if (predictions) {
          const result = analyzeResults(predictions);
          cacheResult(posterUrl, result);
          
          if (result.shouldBlock) {
            blockVideoPoster(video, result.reason, result.category);
            updateStats(1, 1);
          } else {
            updateStats(0, 1);
          }
        }
      } catch (error) {
        processedVideos.delete(video);
        console.debug('NSFW Filter: Video poster error', error.message);
      } finally {
        activeTasks--;
        if (imageQueue.length > 0) drainQueue();
      }
    })();
  }

  function blockVideoPoster(video, reason, category) {
    video.dataset.nsfwPosterOriginal = video.poster;
    video.dataset.nsfwPosterBlocked = 'true';
    video.dataset.nsfwReason = reason;
    video.dataset.nsfwCategory = category;
    
    video.removeAttribute('poster');
    video.style.backgroundColor = '#f5f5f5';
    
    console.log(`NSFW Filter: Blocked video poster [${category}] (${reason})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // MUTATION OBSERVER (оптимизированный)
  // ═══════════════════════════════════════════════════════════════

  let mutationBatch = [];
  let mutationTimer = null;

  function processMutationBatch() {
    const batch = mutationBatch;
    mutationBatch = [];
    mutationTimer = null;
    
    for (const img of batch) {
      if (img.isConnected) handleImage(img);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
    
    let needsBgScan = false;
    let needsVideoScan = false;
    
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === 'IMG') {
          mutationBatch.push(node);
        } else if (node.nodeName === 'VIDEO' && node.poster) {
          needsVideoScan = true;
        } else if (node.querySelectorAll) {
          const imgs = node.querySelectorAll('img');
          for (let i = 0; i < imgs.length; i++) {
            mutationBatch.push(imgs[i]);
          }
          // Проверяем элементы с background-image
          if (node.style && node.style.backgroundImage && node.style.backgroundImage !== 'none') {
            needsBgScan = true;
          }
          if (node.querySelectorAll('[style*="background"]').length > 0) {
            needsBgScan = true;
          }
          if (node.querySelectorAll('video[poster]').length > 0) {
            needsVideoScan = true;
          }
        }
      }
      
      if (mutation.type === 'attributes' && mutation.target.nodeName === 'IMG') {
        const img = mutation.target;
        const attr = mutation.attributeName;
        if (img.dataset.nsfwBlocked !== 'true' && attr === 'src') {
          processedImages.delete(img);
          mutationBatch.push(img);
        }
        // Lazy-load: data-src, data-lazy-src, data-original, srcset → скоро сменится src
        if (['data-src', 'data-lazy-src', 'data-original', 'srcset'].includes(attr)) {
          if (!processedImages.has(img)) {
            mutationBatch.push(img);
          }
        }
      }
      
      // Отслеживаем изменения style (background-image)
      if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
        const el = mutation.target;
        if (el.style.backgroundImage && el.style.backgroundImage !== 'none') {
          needsBgScan = true;
        }
      }
    }
    
    // Батчим обработку мутаций
    if (mutationBatch.length > 0 && !mutationTimer) {
      mutationTimer = setTimeout(processMutationBatch, 16); // ~1 frame
    }
    
    // Запускаем сканирование background-image и video poster с дебаунсом
    if (needsBgScan) {
      clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(() => {
        scanBackgroundImages();
      }, CONFIG.SCAN_DEBOUNCE);
    }
    if (needsVideoScan) {
      setTimeout(scanVideoPoster, CONFIG.SCAN_DEBOUNCE);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // НАСТРОЙКИ
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SETTINGS_UPDATED') {
      const wasEnabled = settings.enabled;
      settings = message.settings;
      
      if (!settings.enabled) {
        // Разблокируем все изображения
        document.querySelectorAll('img[data-nsfw-blocked="true"]').forEach(img => {
          if (img.dataset.nsfwOriginalSrc) {
            img.src = img.dataset.nsfwOriginalSrc;
            delete img.dataset.nsfwBlocked;
            delete img.dataset.nsfwOriginalSrc;
            delete img.dataset.nsfwReason;
            delete img.dataset.nsfwCategory;
            processedImages.delete(img);
          }
        });
        // Разблокируем CSS background-image
        document.querySelectorAll('[data-nsfw-bg-blocked="true"]').forEach(el => {
          if (el.dataset.nsfwBgOriginal) {
            el.style.backgroundImage = el.dataset.nsfwBgOriginal;
            el.style.backgroundColor = '';
          }
          delete el.dataset.nsfwBgBlocked;
          delete el.dataset.nsfwBgOriginal;
          delete el.dataset.nsfwReason;
          delete el.dataset.nsfwCategory;
          processedBgElements.delete(el);
        });
        // Разблокируем video poster
        document.querySelectorAll('video[data-nsfw-poster-blocked="true"]').forEach(video => {
          if (video.dataset.nsfwPosterOriginal) {
            video.poster = video.dataset.nsfwPosterOriginal;
            video.style.backgroundColor = '';
          }
          delete video.dataset.nsfwPosterBlocked;
          delete video.dataset.nsfwPosterOriginal;
          delete video.dataset.nsfwReason;
          delete video.dataset.nsfwCategory;
          processedVideos.delete(video);
        });
      } else {
        // Перепроверяем с новыми настройками
        processedImages = new WeakSet();
        imageQueue = [];
        placeholderCache.clear();
        classificationCache.clear(); // Сбрасываем кэш при смене настроек
        scanPageImmediate();
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ИНИЦИАЛИЗАЦИЯ
  // ═══════════════════════════════════════════════════════════════

  async function init() {
    await fetchSettings();
    if (!settings.enabled) return;
    
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'srcset']
    });
    
    // Приоритизируем видимые изображения при первом скане
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scanPageImmediate);
    } else {
      scanPageImmediate();
    }
    
    window.addEventListener('load', scanPage);
    
    // Пересканируем при скролле (для ленивой загрузки)
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scanPage();
      }, 300);
    }, { passive: true });
    
    console.log('NSFW Filter v7.0: Initialized (opacity-hide, scan all images)');
  }

  init();
})();
