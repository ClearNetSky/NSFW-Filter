// Background Service Worker — NSFW Filter v8.0
// Routes prediction requests: content.js → offscreen.js
// Manages offscreen document lifecycle, stats, and tab tracking
// Architecture matches reference extension (3-layer, no sandbox)

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const STORAGE_KEY = 'nsfw-filter-settings';

// ═══════════════════════════════════════════════════════════════
// PENDING REQUESTS — requestId → sendResponse callback
// ═══════════════════════════════════════════════════════════════

const pendingRequests = new Map();
let requestCounter = 0;

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

  await creatingOffscreen;
  creatingOffscreen = null;

  // Send initial settings to offscreen
  const settings = await readSettings();
  const stats = await readStats();
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_INIT',
    settings,
    totalBlocked: stats.blocked || 0
  }).catch(() => {});

  console.log('NSFW Filter: Offscreen document created (WebGPU, no sandbox)');
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS & STATS
// ═══════════════════════════════════════════════════════════════

async function readSettings() {
  const result = await chrome.storage.local.get(['enabled', 'sensitivity', 'categories', 'trainedModel']);
  return {
    enabled: result.enabled !== false,
    sensitivity: result.sensitivity ?? 50,
    categories: result.categories ?? { porn: true, sexy: true, hentai: true },
    trainedModel: result.trainedModel ?? 'MobileNet_v2'
  };
}

async function readStats() {
  const result = await chrome.storage.local.get('stats');
  return result.stats ?? { blocked: 0, scanned: 0 };
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
  // Stats update from offscreen (it can't access chrome.storage)
  if (message.type === 'OFFSCREEN_TOTAL_BLOCKED') {
    chrome.storage.local.get('stats').then(result => {
      const stats = result.stats ?? { blocked: 0, scanned: 0 };
      stats.blocked = message.totalBlocked;
      chrome.storage.local.set({ stats });
    });
    return;
  }

  // Prediction result from offscreen → forward to content script
  if (message.type === 'PREDICTION_RESULT') {
    const { requestId, result, url, error } = message;
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pendingRequests.delete(requestId);
      pending({ result, url, message: error || '' });
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

  // Settings updated from popup — forward to offscreen
  if (message.type === 'SETTINGS_UPDATED') {
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

    pendingRequests.set(requestId, sendResponse);

    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({
        type: 'OFFSCREEN_PREDICT',
        url: message.url,
        requestId,
        tabIdUrl
      }))
      .catch(err => {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          pendingRequests.delete(requestId);
          pending({ result: false, url: message.url, message: err.message });
        }
      });

    return true; // Keep channel open for async response
  }
});

// ═══════════════════════════════════════════════════════════════
// STATISTICS & BADGE
// ═══════════════════════════════════════════════════════════════

const tabBlockCounts = new Map();

async function updateStats(blocked, scanned, tabId) {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats ?? { blocked: 0, scanned: 0 };
  stats.blocked += blocked;
  stats.scanned += scanned;
  await chrome.storage.local.set({ stats });

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

// When popup disconnects (settings changed), clear offscreen cache
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {
    readSettings().then(settings => {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CLEAR_CACHE',
        settings
      }).catch(() => {});
    });
  });
});
