// Background Service Worker — NSFW Filter v8.2
// Routes prediction requests: content.js → offscreen.js
// Manages offscreen document lifecycle, stats, and tab tracking
// Architecture matches reference extension (3-layer, no sandbox)

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// ═══════════════════════════════════════════════════════════════
// PENDING REQUESTS — requestId → sendResponse callback
// ═══════════════════════════════════════════════════════════════

const pendingRequests = new Map();
let requestCounter = 0;

// Failsafe: если offscreen не ответил за 30с (крэш, перезагрузка модели),
// отвечаем fail-open и чистим запись — иначе Map растёт бесконечно
const PENDING_TIMEOUT = 30000;

function addPendingRequest(requestId, sendResponse, url) {
  const timer = setTimeout(() => {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pendingRequests.delete(requestId);
      try { pending.respond({ result: false, url, message: 'Prediction timeout' }); } catch {}
    }
  }, PENDING_TIMEOUT);
  pendingRequests.set(requestId, { respond: sendResponse, timer });
}

function resolvePendingRequest(requestId, payload) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  try { pending.respond(payload); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// OFFSCREEN DOCUMENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (contexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_SCRAPING'],
    justification: 'NSFW image classification using TensorFlow.js with WebGPU'
  });

  try {
    await creatingOffscreen;
  } finally {
    // Сбрасываем и при ошибке — иначе все последующие вызовы будут
    // ждать тот же rejected promise и падать вечно
    creatingOffscreen = null;
  }

  // Send initial settings + persisted verdicts to offscreen
  const settings = await readSettings();
  const stored = await chrome.storage.local.get(VERDICT_CACHE_KEY);
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_INIT',
    settings,
    verdicts: stored[VERDICT_CACHE_KEY] ?? []
  }).catch(() => {});

  console.log('NSFW Filter: Offscreen document created (WebGPU, no sandbox)');
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS & STATS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// PERSISTENT VERDICT CACHE — offscreen не имеет доступа к chrome.storage,
// поэтому шлёт вердикты сюда. Формат: массив пар [ключ, boolean],
// новые в конце; при переполнении отбрасываются старейшие
// ═══════════════════════════════════════════════════════════════

const VERDICT_CACHE_KEY = 'verdictCache';
const VERDICT_CACHE_MAX = 3000;

// Последовательная запись — параллельные merge теряли бы вердикты
let verdictWriteChain = Promise.resolve();

function persistVerdicts(entries) {
  verdictWriteChain = verdictWriteChain.then(async () => {
    const result = await chrome.storage.local.get(VERDICT_CACHE_KEY);
    const map = new Map(result[VERDICT_CACHE_KEY] ?? []);
    for (const [key, verdict] of entries) {
      map.delete(key); // переставляем в конец (свежее)
      map.set(key, verdict === true);
    }
    let merged = [...map.entries()];
    if (merged.length > VERDICT_CACHE_MAX) {
      merged = merged.slice(merged.length - VERDICT_CACHE_MAX);
    }
    await chrome.storage.local.set({ [VERDICT_CACHE_KEY]: merged });
  }).catch(() => {});
}

async function readSettings() {
  const result = await chrome.storage.local.get(['enabled', 'sensitivity', 'categories', 'trainedModel']);
  return {
    enabled: result.enabled !== false,
    sensitivity: result.sensitivity ?? 50,
    categories: result.categories ?? { porn: true, sexy: true, hentai: true },
    trainedModel: result.trainedModel ?? 'MobileNet_v2'
  };
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    enabled: true,
    sensitivity: 50,
    categories: { porn: true, sexy: true, hentai: true },
    trainedModel: 'MobileNet_v2',
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
  await ensureOffscreenDocument();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenDocument();
});

// Start offscreen immediately on SW startup
ensureOffscreenDocument().catch(console.error);

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Prediction result from offscreen → forward to content script
  if (message.type === 'PREDICTION_RESULT') {
    const { requestId, result, url, error } = message;
    resolvePendingRequest(requestId, { result, url, message: error || '' });
    return;
  }

  // Fresh verdicts from offscreen → persist to storage
  if (message.type === 'PERSIST_VERDICTS') {
    if (Array.isArray(message.entries) && message.entries.length > 0) {
      persistVerdicts(message.entries);
    }
    return;
  }

  // Settings request from content script
  if (message.type === 'GET_SETTINGS') {
    readSettings().then(sendResponse);
    return true;
  }

  // Stats update from content script
  if (message.type === 'UPDATE_STATS') {
    updateStats(message.blocked, message.scanned, sender.tab?.id);
    sendResponse({ success: true });
    return false;
  }

  // Settings updated from popup — forward to offscreen.
  // Персистентный кэш вердиктов инвалидируем: чувствительность/модель
  // изменились, старые вердикты могли стать неверными
  if (message.type === 'SETTINGS_UPDATED') {
    chrome.storage.local.remove(VERDICT_CACHE_KEY).catch(() => {});
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_SETTINGS_UPDATED',
      settings: message.settings
    }).catch(() => {});
    return;
  }
  if (message.type === 'SIGN_CONNECT') return;

  // Prediction request from content script — forward to offscreen
  // Content script sends: { url: "https://..." }
  if (message.url && typeof message.url === 'string') {
    const requestId = `${Date.now()}-${++requestCounter}`;
    const tabIdUrl = {
      tabId: sender.tab?.id ?? 999999,
      tabUrl: sender.tab?.url ?? ''
    };

    addPendingRequest(requestId, sendResponse, message.url);

    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({
        type: 'OFFSCREEN_PREDICT',
        url: message.url,
        requestId,
        tabIdUrl
      }))
      .catch(err => {
        resolvePendingRequest(requestId, {
          result: false,
          url: message.url,
          message: err.message
        });
      });

    return true; // Keep channel open for async response
  }
});

// ═══════════════════════════════════════════════════════════════
// STATISTICS & BADGE
// ═══════════════════════════════════════════════════════════════

const tabBlockCounts = new Map();

// Последовательная запись статистики: параллельные get→set из разных
// вкладок теряли обновления (оба читают старое значение)
let statsWriteChain = Promise.resolve();

function updateStats(blocked, scanned, tabId) {
  statsWriteChain = statsWriteChain.then(async () => {
    const result = await chrome.storage.local.get('stats');
    const stats = result.stats ?? { blocked: 0, scanned: 0 };
    stats.blocked += blocked;
    stats.scanned += scanned;
    await chrome.storage.local.set({ stats });
  }).catch(() => {});

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

// ═══════════════════════════════════════════════════════════════
// TAB LIFECYCLE — forward to offscreen for queue management
// ═══════════════════════════════════════════════════════════════

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    tabBlockCounts.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_TAB_UPDATE',
      tabIdUrl: { tabId: tab.id, tabUrl: tab.url || '' }
    }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlockCounts.delete(tabId);
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_TAB_REMOVE',
    tabId
  }).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_TAB_ADD',
    tabIdUrl: { tabId: tab.id, tabUrl: tab.url || '' }
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_TAB_ACTIVATE',
    tabId: activeInfo.tabId
  }).catch(() => {});
});

