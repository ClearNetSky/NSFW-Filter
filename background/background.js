// Background Service Worker для NSFW Filter
// Управляет offscreen document (модель загружается один раз)
// Маршрутизирует запросы классификации от content scripts

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER KEEPALIVE
// ═══════════════════════════════════════════════════════════════
// Chrome убивает idle SW через 30 секунд.
// Поддерживаем SW активным пока идут классификации.

let activeClassifications = 0;
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    // Простой self-ping для сброса idle timeout Chrome
    if (activeClassifications > 0) {
      chrome.runtime.getPlatformInfo(() => {});
    } else {
      stopKeepAlive();
    }
  }, 25000); // Каждые 25 секунд (timeout = 30s)
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

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
    stats: { blocked: 0, scanned: 0 },
    whitelist: []
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
      updateStats(message.blocked, message.scanned, sender.tab?.id);
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

    case 'WHITELIST_CURRENT':
      whitelistDomain(message.domain)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async
  }
});

// Маршрутизация классификации в offscreen document
async function handleClassify(message) {
  activeClassifications++;
  startKeepAlive();
  
  try {
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'CLASSIFY_IMAGE',
      imageDataUrl: message.imageDataUrl
    });

    return response;
  } finally {
    activeClassifications--;
    if (activeClassifications <= 0) {
      activeClassifications = 0;
      stopKeepAlive();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// СТАТИСТИКА, НАСТРОЙКИ И BADGE
// ═══════════════════════════════════════════════════════════════

// Счётчик блокировок по вкладкам (для badge)
const tabBlockCounts = new Map();

async function updateStats(blocked, scanned, tabId) {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats ?? { blocked: 0, scanned: 0 };
  stats.blocked += blocked;
  stats.scanned += scanned;
  await chrome.storage.local.set({ stats });
  
  // Обновляем badge на иконке расширения
  if (tabId && blocked > 0) {
    const current = tabBlockCounts.get(tabId) || 0;
    const newCount = current + blocked;
    tabBlockCounts.set(tabId, newCount);
    updateBadge(tabId, newCount);
  }
}

function updateBadge(tabId, count) {
  if (count > 0) {
    const text = count > 99 ? '99+' : count.toString();
    chrome.action.setBadgeText({ text, tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e53935', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// Очищаем badge при навигации
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabBlockCounts.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlockCounts.delete(tabId);
});

async function getSettings() {
  const result = await chrome.storage.local.get(['enabled', 'sensitivity', 'categories', 'whitelist']);
  return {
    enabled: result.enabled !== false,
    sensitivity: result.sensitivity ?? 50,
    categories: result.categories ?? { porn: true, sexy: true, hentai: true },
    whitelist: result.whitelist ?? []
  };
}

// ═══════════════════════════════════════════════════════════════
// WHITELIST
// ═══════════════════════════════════════════════════════════════

async function whitelistDomain(domain) {
  const result = await chrome.storage.local.get('whitelist');
  const whitelist = result.whitelist ?? [];
  const clean = domain.trim().toLowerCase();
  if (!clean) return { success: false, error: 'Empty domain' };
  if (!whitelist.includes(clean)) {
    whitelist.push(clean);
    await chrome.storage.local.set({ whitelist });
  }
  // Уведомляем все вкладки об обновлении
  await broadcastSettings();
  return { success: true };
}

async function broadcastSettings() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_UPDATED',
        settings
      }).catch(() => {});
    }
  }
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

    // Конвертируем blob → base64 data URL (chunked для производительности)
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    
    // Chunk-based encoding — в 10-20x быстрее чем посимвольный String.fromCharCode
    const chunkSize = 8192;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode.apply(null, chunk));
    }
    const base64 = btoa(chunks.join(''));
    const dataUrl = `data:${blob.type};base64,${base64}`;

    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
