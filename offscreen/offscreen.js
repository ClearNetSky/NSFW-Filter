// Offscreen Document — Direct TF.js inference with WebGPU
// No sandbox needed: WebGPU doesn't require unsafe-eval
// Architecture: content.js → background.js → offscreen.js (3 layers, like reference)
//
// Features:
// - WebGPU backend (GPU acceleration without eval)
// - CPU fallback if WebGPU unavailable
// - LRU cache shared across all tabs
// - LoadingQueue (100 concurrent) → PredictionQueue (1 sequential)
// - Request deduplication (same URL → single prediction)
// - MobileNet v2 (default, 224px) + InceptionV3 (optional, 299px)

'use strict';

// ═══════════════════════════════════════════════════════════════
// SETTINGS (pushed from service worker via OFFSCREEN_INIT)
// ═══════════════════════════════════════════════════════════════

let settings = {
  sensitivity: 50,
  categories: { porn: true, sexy: true, hentai: true },
  trainedModel: 'MobileNet_v2' // 'MobileNet_v2' | 'InceptionV3'
};

let totalBlocked = 0;

// ═══════════════════════════════════════════════════════════════
// LRU CACHE — shared across all tabs
// ═══════════════════════════════════════════════════════════════

class LRUCache {
  constructor(maxSize) {
    this.MAX = maxSize;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (item !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }

  has(key) {
    return this.cache.has(key);
  }

  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.MAX) {
      // Evict oldest entry
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, val);
  }

  clear() {
    this.cache.clear();
  }
}

const cache = new LRUCache(500);

// ═══════════════════════════════════════════════════════════════
// CONCURRENT QUEUE — generic queue with concurrency control
// ═══════════════════════════════════════════════════════════════

class ConcurrentQueue {
  constructor({ concurrency, timeout, onProcess, onSuccess, onFailure, onDone }) {
    this.concurrency = concurrency;
    this.timeout = timeout;
    this.onProcess = onProcess;
    this.onSuccess = onSuccess;
    this.onFailure = onFailure;
    this.onDone = onDone;
    this.queue = [];
    this.active = 0;
  }

  add(item) {
    this.queue.push(item);
    this._drain();
  }

  _drain() {
    while (this.queue.length > 0 && this.active < this.concurrency) {
      const item = this.queue.shift();
      this.active++;

      const callback = (err, result) => {
        this.active--;
        if (err) {
          this.onFailure(err);
        } else {
          this.onSuccess(result);
        }
        if (this.onDone) this.onDone(item);
        this._drain();
      };

      this.onProcess(item, callback);
    }
  }

  clear() {
    this.queue = [];
  }
}

// ═══════════════════════════════════════════════════════════════
// MODEL & CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

let model = null;
let modelSize = 224; // MobileNet=224, InceptionV3=299
let loadAttempts = 0;
const FILTER_LIST = new Set(['Hentai', 'Porn', 'Sexy']);

// Request deduplication: URL → array of [{resolve, reject}]
const requestMap = new Map();

// Tab tracking
const currentTabIdUrls = new Map();
let activeTabId = null;

// ═══════════════════════════════════════════════════════════════
// LOADING QUEUE — loads images from URLs (100 concurrent, 5s timeout)
// Uses fetch() + blob to bypass CORS restrictions (host_permissions)
// ═══════════════════════════════════════════════════════════════

const loadingQueue = new ConcurrentQueue({
  concurrency: 100,
  timeout: 0,
  onProcess: ({ url, tabIdUrl }, callback) => {
    // Skip if tab navigated away
    if (tabIdUrl && tabIdUrl.tabId !== null) {
      const currentUrl = currentTabIdUrls.get(tabIdUrl.tabId);
      if (currentUrl !== undefined && currentUrl !== tabIdUrl.tabUrl) {
        callback({ url, error: new Error('Tab navigated away') });
        return;
      }
    }

    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; callback({ url, error: new Error('Image load timeout') }); }
    }, 3000);

    // Data URLs: load directly (no fetch needed)
    if (url.startsWith('data:')) {
      const image = new Image(modelSize, modelSize);
      image.onload = () => {
        if (!done) { done = true; clearTimeout(timer); callback(null, { url, image, tabIdUrl }); }
      };
      image.onerror = () => {
        if (!done) { done = true; clearTimeout(timer); callback({ url, error: new Error('Data URL load failed') }); }
      };
      image.src = url;
      return;
    }

    // HTTP URLs: fetch as blob to bypass CORS, then load into Image
    fetch(url, { mode: 'cors', credentials: 'omit' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        const image = new Image(modelSize, modelSize);
        image.onload = () => {
          URL.revokeObjectURL(blobUrl);
          if (!done) { done = true; clearTimeout(timer); callback(null, { url, image, tabIdUrl }); }
        };
        image.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          if (!done) { done = true; clearTimeout(timer); callback({ url, error: new Error('Blob image load failed') }); }
        };
        image.src = blobUrl;
      })
      .catch(err => {
        if (!done) { done = true; clearTimeout(timer); callback({ url, error: err }); }
      });
  },
  onSuccess: ({ url, image, tabIdUrl }) => {
    if (!requestMap.has(url)) return;
    predictionQueue.add({ url, image, tabIdUrl });
  },
  onFailure: ({ url, error }) => {
    if (!requestMap.has(url)) return;
    cache.set(url, false);
    const waiters = requestMap.get(url);
    if (waiters) {
      for (const { reject } of waiters) reject(error);
    }
    requestMap.delete(url);
  }
});

// ═══════════════════════════════════════════════════════════════
// PREDICTION QUEUE — classifies images (1 concurrent, CPU-bound)
// ═══════════════════════════════════════════════════════════════

const predictionQueue = new ConcurrentQueue({
  concurrency: 1,
  timeout: 0,
  onProcess: ({ url, image, tabIdUrl }, callback) => {
    if (!requestMap.has(url)) {
      callback({ url, error: new Error('Request cancelled') });
      return;
    }

    predictImage(image, url)
      .then(result => callback(null, { url, result }))
      .catch(error => callback({ url, error }));
  },
  onSuccess: ({ url, result }) => {
    if (!requestMap.has(url)) return;

    if (result) totalBlocked++;
    cache.set(url, result);

    const waiters = requestMap.get(url);
    if (waiters) {
      for (const { resolve } of waiters) resolve(result);
    }
    requestMap.delete(url);
  },
  onFailure: ({ url, error }) => {
    if (!requestMap.has(url)) return;
    cache.set(url, false);
    const waiters = requestMap.get(url);
    if (waiters) {
      for (const { reject } of waiters) reject(error);
    }
    requestMap.delete(url);
  }
});

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
    return false;
  }

  const categories = settings.categories || { porn: true, sexy: true, hentai: true };
  let shouldBlock = false;

  // Проверяем PORN
  if (categories.porn && scores.porn >= threshold) {
    shouldBlock = true;
  }

  // Проверяем HENTAI
  // Учитываем разницу между Drawing и Hentai:
  // если Drawing-скор высокий, повышаем порог для Hentai
  if (categories.hentai) {
    let hentaiThreshold = threshold;
    if (scores.drawing > 0.3) {
      hentaiThreshold = Math.min(threshold + 0.15, 0.95);
    }
    if (scores.hentai >= hentaiThreshold) {
      shouldBlock = true;
    }
  }

  // Проверяем SEXY
  // Sexy — менее серьёзная категория, повышаем порог
  if (categories.sexy) {
    const sexyThreshold = Math.min(threshold + 0.15, 0.95);
    if (scores.neutral > 0.3) {
      const adjustedThreshold = Math.min(sexyThreshold + 0.1, 0.95);
      if (scores.sexy >= adjustedThreshold) {
        shouldBlock = true;
      }
    } else if (scores.sexy >= sexyThreshold) {
      shouldBlock = true;
    }
  }

  // Дополнительная проверка: комбинированный NSFW-скор
  // Если по отдельности не дотягивают, но вместе — явно NSFW
  if (!shouldBlock && nsfwScore > 0.7 && safeScore < 0.3) {
    if ((scores.porn >= scores.hentai && scores.porn >= scores.sexy && categories.porn) ||
        (scores.hentai >= scores.porn && scores.hentai >= scores.sexy && categories.hentai) ||
        categories.sexy) {
      shouldBlock = true;
    }
  }

  return shouldBlock;
}

async function predictImage(image, url) {
  if (!model) throw new Error('Model not loaded');

  const predictions = await model.classify(image, 5);
  return analyzeResults(predictions);
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — predict with cache + deduplication
// ═══════════════════════════════════════════════════════════════

function predict(url, tabIdUrl) {
  return new Promise((resolve, reject) => {
    // Check cache first
    if (cache.has(url)) {
      resolve(cache.get(url));
      return;
    }

    // Deduplication: if already loading/predicting this URL, just add another waiter
    if (requestMap.has(url)) {
      requestMap.get(url).push({ resolve, reject });
    } else {
      requestMap.set(url, [{ resolve, reject }]);
      loadingQueue.add({ url, tabIdUrl });
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// MODEL LOADING — WebGPU → CPU fallback
// ═══════════════════════════════════════════════════════════════

async function initBackend() {
  // WebGPU doesn't use eval — works within MV3 CSP
  try {
    await tf.setBackend('webgpu');
    await tf.ready();
    console.log('NSFW Offscreen: WebGPU backend active');
    return;
  } catch (e) {
    console.warn('NSFW Offscreen: WebGPU unavailable, falling back to CPU:', e.message);
  }

  // CPU fallback (always works, no CSP issues)
  await tf.setBackend('cpu');
  await tf.ready();
  console.log('NSFW Offscreen: CPU backend active (fallback)');
}

async function loadModel() {
  const trainedModel = settings.trainedModel || 'MobileNet_v2';
  const isInception = trainedModel === 'InceptionV3';
  const modelPath = chrome.runtime.getURL(isInception ? 'models/inceptionv3/' : 'models/');
  modelSize = isInception ? 299 : 224;

  console.log(`NSFW Offscreen: Loading ${trainedModel} (${modelSize}px)...`);

  try {
    // Models are Keras format (not graph) — don't specify type
    // nsfwjs auto-detects the format from model.json
    model = await nsfwjs.load(modelPath, { size: modelSize });
    console.log(`NSFW Offscreen: ${trainedModel} loaded (backend: ${tf.getBackend()})`);
  } catch (error) {
    console.error('NSFW Offscreen: Model load failed:', error);
    loadAttempts++;
    if (loadAttempts < 5) {
      setTimeout(loadModel, 200);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLING — from service worker
// ═══════════════════════════════════════════════════════════════

// Buffer predictions that arrive before model is ready
const buffered = [];

function dispatchPredict(url, requestId, tabIdUrl) {
  if (!model) {
    buffered.push({ url, requestId, tabIdUrl });
    return;
  }

  predict(url, tabIdUrl)
    .then(result => {
      chrome.runtime.sendMessage({
        type: 'PREDICTION_RESULT',
        requestId,
        result,
        url
      }).catch(() => {});
    })
    .catch(err => {
      chrome.runtime.sendMessage({
        type: 'PREDICTION_RESULT',
        requestId,
        result: false,
        url,
        error: err.message
      }).catch(() => {});
    });
}

function flushBuffered() {
  for (const { url, requestId, tabIdUrl } of buffered) {
    dispatchPredict(url, requestId, tabIdUrl);
  }
  buffered.length = 0;
}

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.type === 'OFFSCREEN_INIT') {
    Object.assign(settings, message.settings || {});
    totalBlocked = message.totalBlocked || 0;
  }

  if (message.type === 'OFFSCREEN_PREDICT') {
    const { url, requestId, tabIdUrl } = message;
    dispatchPredict(url, requestId, tabIdUrl || { tabId: null, tabUrl: '' });
  }

  if (message.type === 'OFFSCREEN_TAB_ADD' || message.type === 'OFFSCREEN_TAB_UPDATE') {
    const { tabId, tabUrl } = message.tabIdUrl || {};
    if (tabId != null) currentTabIdUrls.set(tabId, tabUrl);
  }

  if (message.type === 'OFFSCREEN_TAB_REMOVE') {
    currentTabIdUrls.delete(message.tabId);
  }

  if (message.type === 'OFFSCREEN_TAB_ACTIVATE') {
    activeTabId = message.tabId;
  }

  if (message.type === 'OFFSCREEN_SETTINGS_UPDATED') {
    const oldModel = settings.trainedModel;
    if (message.settings) Object.assign(settings, message.settings);
    // If model changed, reload it
    if (settings.trainedModel !== oldModel) {
      console.log(`NSFW Offscreen: Model changed ${oldModel} → ${settings.trainedModel}, reloading...`);
      model = null;
      cache.clear();
      requestMap.clear();
      loadingQueue.clear();
      predictionQueue.clear();
      loadModel().then(flushBuffered);
    } else {
      // Sensitivity or categories changed — clear cache so new threshold applies
      cache.clear();
    }
  }

  if (message.type === 'OFFSCREEN_CLEAR_CACHE') {
    if (message.settings) Object.assign(settings, message.settings);
    cache.clear();
    requestMap.clear();
    loadingQueue.clear();
    predictionQueue.clear();
  }

  if (message.type === 'OFFSCREEN_TOTAL_BLOCKED_REQUEST') {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_TOTAL_BLOCKED',
      totalBlocked
    }).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

tf.enableProdMode();

(async () => {
  await initBackend();
  await loadModel();
  flushBuffered();
})();
