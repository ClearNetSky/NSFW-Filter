// Background Service Worker для NSFW Filter
// Управляет offscreen document (модель загружается один раз)
// Маршрутизирует запросы классификации от content scripts

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// ═══════════════════════════════════════════════════════════════
// OFFSCREEN DOCUMENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  // Проверяем, существует ли уже offscreen document
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (contexts.length > 0) return;

  // Предотвращаем параллельное создание
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['IFRAME_SCRIPTING'],
    justification: 'NSFW image classification using TensorFlow.js in sandboxed iframe'
  });

  await creatingOffscreen;
  creatingOffscreen = null;

  console.log('NSFW Filter: Offscreen document created (model loads once)');
}

// ═══════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    enabled: true,
    sensitivity: 50,
    categories: { porn: true, sexy: true, hentai: true },
    stats: { blocked: 0, scanned: 0 }
  };

  const existing = await chrome.storage.local.get(Object.keys(defaults));
  const toSet = {};

  for (const key of Object.keys(defaults)) {
    if (existing[key] === undefined) {
      toSet[key] = defaults[key];
    }
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  console.log('NSFW Filter: Installed');

  // Создаём offscreen document и начинаем загрузку модели
  await ensureOffscreenDocument();
});

// Создаём offscreen при запуске браузера
chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenDocument();
});

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТКА СООБЩЕНИЙ
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Пропускаем сообщения для offscreen document
  if (message.target === 'offscreen') return;

  switch (message.type) {
    case 'CLASSIFY_IMAGE':
      handleClassify(message)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async

    case 'UPDATE_STATS':
      updateStats(message.blocked, message.scanned);
      sendResponse({ success: true });
      return false;

    case 'GET_SETTINGS':
      getSettings().then(sendResponse);
      return true; // async

    case 'FETCH_IMAGE':
      fetchImageAsDataUrl(message.url)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async
  }
});

// Маршрутизация классификации в offscreen document
async function handleClassify(message) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'CLASSIFY_IMAGE',
    imageDataUrl: message.imageDataUrl
  });

  return response;
}

// ═══════════════════════════════════════════════════════════════
// СТАТИСТИКА И НАСТРОЙКИ
// ═══════════════════════════════════════════════════════════════

async function updateStats(blocked, scanned) {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats ?? { blocked: 0, scanned: 0 };
  stats.blocked += blocked;
  stats.scanned += scanned;
  await chrome.storage.local.set({ stats });
}

async function getSettings() {
  const result = await chrome.storage.local.get(['enabled', 'sensitivity', 'categories']);
  return {
    enabled: result.enabled !== false,
    sensitivity: result.sensitivity ?? 50,
    categories: result.categories ?? { porn: true, sexy: true, hentai: true }
  };
}

// ═══════════════════════════════════════════════════════════════
// ПРОКСИ-ЗАГРУЗКА ИЗОБРАЖЕНИЙ (обходит CORS)
// ═══════════════════════════════════════════════════════════════
// Service worker не подчиняется CORS-политике страницы,
// поэтому может загрузить изображение с любого домена.

async function fetchImageAsDataUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };

    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return { success: false, error: 'Not an image' };

    // Конвертируем blob → base64 data URL
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:${blob.type};base64,${base64}`;

    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
