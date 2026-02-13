// NSFW Filter Content Script — v3.0
// Централизованная модель через offscreen document (загружается один раз)
// 5-классовая система NSFWJS: Drawing, Hentai, Neutral, Porn, Sexy

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

  // Параметры производительности
  const CONFIG = {
    MIN_IMAGE_SIZE: 50,          // Минимальный размер изображения (px)
    MAX_CONCURRENT: 4,           // Параллельных классификаций одновременно
    RESIZE_TARGET: 299,          // Размер для модели (299x299)
    JPEG_QUALITY: 0.7,           // Качество JPEG (ниже = быстрее передача)
    STATS_DEBOUNCE: 2000,        // Частота отправки статистики (мс)
    SCAN_DEBOUNCE: 50,           // Дебаунс сканирования DOM (мс)
    VISIBILITY_CHECK: true,      // Приоритизация видимых изображений
    BATCH_SIZE: 6,               // Размер пакета для одновременной обработки
  };

  // ═══════════════════════════════════════════════════════════════
  // СОСТОЯНИЕ
  // ═══════════════════════════════════════════════════════════════

  let processedImages = new WeakSet();
  let activeTasks = 0;
  let imageQueue = [];          // Очередь изображений с приоритетами
  let isProcessingQueue = false;
  let scanDebounceTimer = null;

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

  async function classifyImage(imageDataUrl) {
    const response = await chrome.runtime.sendMessage({
      type: 'CLASSIFY_IMAGE',
      imageDataUrl
    });
    if (response && response.success) return response.predictions;
    throw new Error(response?.error || 'Classification failed');
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
  // СИСТЕМА ОЧЕРЕДЕЙ С ПРИОРИТЕТАМИ
  // ═══════════════════════════════════════════════════════════════

  function isElementVisible(el) {
    if (!CONFIG.VISIBILITY_CHECK) return true;
    
    const rect = el.getBoundingClientRect();
    const viewHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewWidth = window.innerWidth || document.documentElement.clientWidth;
    
    // Изображение в viewport или рядом (1 экран сверху/снизу)
    return (
      rect.bottom >= -viewHeight &&
      rect.top <= viewHeight * 2 &&
      rect.right >= 0 &&
      rect.left <= viewWidth
    );
  }

  function enqueueImage(img) {
    // Видимые изображения получают высокий приоритет
    const priority = isElementVisible(img) ? 0 : 1;
    imageQueue.push({ img, priority });
    
    // Сортируем: видимые сначала
    if (imageQueue.length > 1) {
      imageQueue.sort((a, b) => a.priority - b.priority);
    }
    
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
      // Оптимизированная конвертация: уменьшаем до 299x299
      let imageDataUrl = imageToOptimizedDataUrl(img);
      
      // If canvas is tainted (cross-origin image), try re-fetching with CORS
      if (!imageDataUrl && img.src && (img.src.startsWith('http://') || img.src.startsWith('https://'))) {
        imageDataUrl = await fetchImageAsDataUrl(img.src);
      }
      
      if (!imageDataUrl) {
        // Cannot convert image — skip silently
        return;
      }
      
      const predictions = await classifyImage(imageDataUrl);
      
      if (predictions) {
        const result = analyzeResults(predictions);
        
        if (result.shouldBlock) {
          blockImage(img, result.reason, result.category);
          updateStats(1, 1);
        } else {
          updateStats(0, 1);
        }
      }
    } catch (error) {
      // Не блокируем при ошибке, но убираем из обработанных для повторной попытки
      processedImages.delete(img);
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
    
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    
    // Белый фон
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, cw, ch);
    
    // Иконка щита
    ctx.fillStyle = '#ddd';
    const cx = cw / 2;
    const cy = ch / 2;
    const sz = Math.min(cw, ch) * 0.25;
    
    ctx.beginPath();
    ctx.moveTo(cx, cy - sz / 2);
    ctx.lineTo(cx + sz / 2, cy - sz / 4);
    ctx.lineTo(cx + sz / 2, cy + sz / 4);
    ctx.quadraticCurveTo(cx, cy + sz / 2, cx, cy + sz / 2);
    ctx.quadraticCurveTo(cx, cy + sz / 2, cx - sz / 2, cy + sz / 4);
    ctx.lineTo(cx - sz / 2, cy - sz / 4);
    ctx.closePath();
    ctx.fill();
    
    // Текст категории
    const fontSize = Math.max(10, Math.min(cw, ch) * 0.06);
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = '#bbb';
    ctx.textAlign = 'center';
    ctx.fillText('NSFW', cx, cy + sz / 2 + fontSize + 4);
    
    const dataUrl = canvas.toDataURL('image/png');
    placeholderCache.set(key, dataUrl);
    
    return dataUrl;
  }

  function blockImage(img, reason, category) {
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
      if (response) settings = response;
    } catch (error) {
      console.error('NSFW Filter: Failed to fetch settings', error);
    }
  }

  function handleImage(img) {
    if (!settings.enabled) return;
    if (processedImages.has(img)) return;
    if (img.dataset.nsfwBlocked === 'true') return;
    
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < CONFIG.MIN_IMAGE_SIZE && h < CONFIG.MIN_IMAGE_SIZE) return;

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
    }, CONFIG.SCAN_DEBOUNCE);
  }

  // Сканирование без дебаунса (для первого запуска)
  function scanPageImmediate() {
    const images = document.querySelectorAll('img');
    for (let i = 0; i < images.length; i++) {
      handleImage(images[i]);
    }
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
    
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === 'IMG') {
          mutationBatch.push(node);
        } else if (node.querySelectorAll) {
          const imgs = node.querySelectorAll('img');
          for (let i = 0; i < imgs.length; i++) {
            mutationBatch.push(imgs[i]);
          }
        }
      }
      
      if (mutation.type === 'attributes' && mutation.target.nodeName === 'IMG') {
        const img = mutation.target;
        if (img.dataset.nsfwBlocked !== 'true' && mutation.attributeName === 'src') {
          processedImages.delete(img);
          mutationBatch.push(img);
        }
      }
    }
    
    // Батчим обработку мутаций
    if (mutationBatch.length > 0 && !mutationTimer) {
      mutationTimer = setTimeout(processMutationBatch, 16); // ~1 frame
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // НАСТРОЙКИ
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SETTINGS_UPDATED') {
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
      } else {
        // Перепроверяем с новыми настройками
        processedImages = new WeakSet();
        imageQueue = [];
        placeholderCache.clear();
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
      attributeFilter: ['src']
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
    
    console.log('NSFW Filter v3.0: Initialized (centralized model)');
  }

  init();
})();
