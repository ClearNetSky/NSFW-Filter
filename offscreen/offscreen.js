// Offscreen Document — мост между Service Worker и Sandbox
// Модель загружается ОДИН РАЗ и переиспользуется для всех вкладок
// Архитектура: content.js → background.js → offscreen.js → sandbox iframe

const sandboxIframe = document.getElementById('sandbox');
let isSandboxReady = false;
let isModelReady = false;
let pendingRequests = new Map();
let requestIdCounter = 0;

// ═══════════════════════════════════════════════════════════════
// КОММУНИКАЦИЯ С SANDBOX IFRAME
// ═══════════════════════════════════════════════════════════════

window.addEventListener('message', (event) => {
  if (event.source !== sandboxIframe?.contentWindow) return;

  const data = event.data;

  switch (data.type) {
    case 'SANDBOX_READY':
      isSandboxReady = true;
      console.log('NSFW Offscreen: Sandbox ready');
      break;

    case 'PRELOAD_RESULT':
      if (data.success) {
        isModelReady = true;
        console.log('NSFW Offscreen: Model loaded (persistent)');
      }
      resolvePending(data.id, data);
      break;

    case 'CLASSIFY_RESULT':
      resolvePending(data.id, data);
      break;

    case 'CONTEXT_LOST':
      // WebGL контекст потерян — модель нужно будет перезагрузить
      isModelReady = false;
      modelLoadPromise = null;
      console.warn('NSFW Offscreen: WebGL context lost in sandbox');
      break;

    case 'CONTEXT_RECOVERED':
      // WebGL контекст восстановлен, модель перезагружена в sandbox
      isModelReady = true;
      modelLoadPromise = null;
      console.log('NSFW Offscreen: WebGL context recovered, model reloaded');
      break;
  }
});

function resolvePending(id, data) {
  const pending = pendingRequests.get(id);
  if (pending) {
    pending.resolve(data);
    pendingRequests.delete(id);
  }
}

function sendToSandbox(type, data = {}) {
  return new Promise((resolve, reject) => {
    if (!sandboxIframe?.contentWindow) {
      reject(new Error('Sandbox not available'));
      return;
    }

    const id = ++requestIdCounter;
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Sandbox request timeout'));
      }
    }, 30000); // 30s для загрузки модели

    pendingRequests.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });

    sandboxIframe.contentWindow.postMessage({ type, id, ...data }, '*');
  });
}

// ═══════════════════════════════════════════════════════════════
// УПРАВЛЕНИЕ МОДЕЛЬЮ
// ═══════════════════════════════════════════════════════════════

async function waitForSandbox() {
  if (isSandboxReady) return true;

  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (isSandboxReady) {
        clearInterval(check);
        resolve(true);
      }
    }, 50);
    setTimeout(() => {
      clearInterval(check);
      resolve(false);
    }, 10000);
  });
}

let modelLoadPromise = null;

async function ensureModelReady() {
  if (isModelReady) return true;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    const ready = await waitForSandbox();
    if (!ready) {
      modelLoadPromise = null;
      return false;
    }

    try {
      const response = await sendToSandbox('PRELOAD_MODEL');
      if (response && response.success) {
        isModelReady = true;
        return true;
      }
    } catch (error) {
      console.error('NSFW Offscreen: Model preload failed', error);
    }
    modelLoadPromise = null;
    return false;
  })();

  return modelLoadPromise;
}

// ═══════════════════════════════════════════════════════════════
// КЛАССИФИКАЦИЯ
// ═══════════════════════════════════════════════════════════════

async function classifyImage(imageDataUrl) {
  const modelReady = await ensureModelReady();
  if (!modelReady) throw new Error('Model not available');

  const response = await sendToSandbox('CLASSIFY_IMAGE', { imageDataUrl });
  if (response && response.success) {
    return response.predictions;
  }
  throw new Error(response?.error || 'Classification failed');
}

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТКА СООБЩЕНИЙ ОТ SERVICE WORKER
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Обрабатываем только сообщения адресованные offscreen
  if (message.target !== 'offscreen') return;

  if (message.type === 'CLASSIFY_IMAGE') {
    classifyImage(message.imageDataUrl)
      .then(predictions => sendResponse({ success: true, predictions }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // async
  }

  if (message.type === 'PRELOAD_MODEL') {
    ensureModelReady()
      .then(ready => sendResponse({ success: ready }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // async
  }

  if (message.type === 'PING') {
    sendResponse({ ready: isModelReady, sandboxReady: isSandboxReady });
    return;
  }
});

// Начинаем загрузку модели сразу при создании offscreen document
ensureModelReady();
