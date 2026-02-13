// Sandbox для классификации изображений
// Работает в изолированном контексте с разрешённым unsafe-eval
// WebGL backend для GPU-ускоренной классификации
// Включает автоматическое восстановление при потере WebGL контекста

let model = null;
let modelLoadPromise = null;
let backendName = 'unknown';
let isContextLost = false;
let isRecovering = false;
let recoveryPromise = null;

// ═══════════════════════════════════════════════════════════════
// WEBGL CONTEXT LOSS RECOVERY
// ═══════════════════════════════════════════════════════════════

// Мониторинг WebGL контекста — обнаружение и восстановление
function monitorWebGLContext() {
  if (typeof tf === 'undefined' || tf.getBackend() !== 'webgl') return;

  const backend = tf.backend();
  const gl = backend?.gpgpu?.gl;
  if (!gl) return;

  const canvas = gl.canvas;
  if (!canvas || canvas.__nsfwContextMonitored) return;
  canvas.__nsfwContextMonitored = true;

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // Позволяет браузеру попытаться восстановить контекст
    isContextLost = true;
    console.warn('NSFW Sandbox: WebGL context lost — stopping classification');
    // Уведомляем offscreen document о потере контекста
    window.parent.postMessage({ type: 'CONTEXT_LOST' }, '*');
  });

  canvas.addEventListener('webglcontextrestored', () => {
    console.log('NSFW Sandbox: WebGL context restored — reinitializing...');
    recoverFromContextLoss();
  });

  console.log('NSFW Sandbox: WebGL context loss monitor active');
}

// Полное восстановление: dispose backend → переинициализация → перезагрузка модели
async function recoverFromContextLoss() {
  if (isRecovering) return recoveryPromise;
  isRecovering = true;

  recoveryPromise = (async () => {
    try {
      console.log('NSFW Sandbox: Starting recovery...');

      // Сбрасываем модель
      model = null;
      modelLoadPromise = null;

      // Диспозим старый backend и заново инициализируем
      try {
        tf.engine().reset();
      } catch (e) {
        console.warn('NSFW Sandbox: Engine reset warning:', e.message);
      }

      // Пробуем заново WebGL, если не получится — fallback на CPU
      try {
        await tf.setBackend('webgl');
        await tf.ready();
        backendName = tf.getBackend();
      } catch (e) {
        console.warn('NSFW Sandbox: WebGL recovery failed, falling back to CPU:', e.message);
        await tf.setBackend('cpu');
        await tf.ready();
        backendName = 'cpu';
      }

      // Перезагружаем модель
      model = await nsfwjs.load('../models/', { size: 299 });

      isContextLost = false;
      isRecovering = false;
      recoveryPromise = null;

      // Мониторим новый контекст
      monitorWebGLContext();

      console.log(`NSFW Sandbox: Recovery complete (backend: ${backendName})`);
      window.parent.postMessage({ type: 'CONTEXT_RECOVERED' }, '*');
      return true;
    } catch (error) {
      console.error('NSFW Sandbox: Recovery failed completely:', error);
      isRecovering = false;
      recoveryPromise = null;
      return false;
    }
  })();

  return recoveryPromise;
}

// ═══════════════════════════════════════════════════════════════
// НАСТРОЙКА WEBGL
// ═══════════════════════════════════════════════════════════════

// Настройка WebGL backend для максимальной производительности
async function setupWebGL() {
  // nsfwjs bundle включает TensorFlow.js, который экспортирует tf глобально
  if (typeof tf !== 'undefined') {
    try {
      // Принудительно выбираем WebGL backend (GPU-ускорение)
      await tf.setBackend('webgl');
      await tf.ready();
      
      backendName = tf.getBackend();
      
      // Оптимизации WebGL
      if (backendName === 'webgl') {
        const gl = tf.backend().gpgpu?.gl;
        if (gl) {
          // Отключаем неиспользуемые GL features для скорости
          gl.disable(gl.DEPTH_TEST);
          gl.disable(gl.STENCIL_TEST);
          gl.disable(gl.BLEND);
          gl.disable(gl.DITHER);
          gl.disable(gl.POLYGON_OFFSET_FILL);
          gl.disable(gl.SAMPLE_COVERAGE);
          gl.disable(gl.SCISSOR_TEST);
        }
        
        // Флаги TF.js для производительности
        tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0);
        tf.env().set('WEBGL_FORCE_F16_TEXTURES', false);
        tf.env().set('WEBGL_PACK', true);
        
        // Запускаем мониторинг контекста
        monitorWebGLContext();
        
        console.log('NSFW Sandbox: WebGL GPU acceleration active');
      }
    } catch (e) {
      console.warn('NSFW Sandbox: WebGL setup failed, falling back to CPU:', e.message);
      try {
        await tf.setBackend('cpu');
        await tf.ready();
        backendName = 'cpu';
        console.log('NSFW Sandbox: CPU backend active (fallback)');
      } catch (e2) {
        console.error('NSFW Sandbox: All backends failed:', e2.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ЗАГРУЗКА МОДЕЛИ
// ═══════════════════════════════════════════════════════════════

async function loadModel() {
  if (model) return model;
  if (modelLoadPromise) return modelLoadPromise;
  
  modelLoadPromise = (async () => {
    try {
      // Сначала настраиваем WebGL
      await setupWebGL();
      
      console.log(`NSFW Sandbox: Loading model (backend: ${backendName})...`);
      
      model = await nsfwjs.load('../models/', { size: 299 });
      console.log(`NSFW Sandbox: Model loaded (backend: ${backendName})`);
      return model;
    } catch (error) {
      console.error('NSFW Sandbox: Failed to load model', error);
      modelLoadPromise = null;
      throw error;
    }
  })();
  
  return modelLoadPromise;
}

// Проверка и восстановление перед классификацией
async function ensureReady() {
  if (isContextLost || isRecovering) {
    if (isRecovering) {
      const ok = await recoveryPromise;
      if (!ok) throw new Error('WebGL recovery failed');
    } else {
      const ok = await recoverFromContextLoss();
      if (!ok) throw new Error('WebGL recovery failed');
    }
  }
  return loadModel();
}

// ═══════════════════════════════════════════════════════════════
// КЛАССИФИКАЦИЯ
// ═══════════════════════════════════════════════════════════════

// Оптимизированная классификация: принимает ImageBitmap напрямую
async function classifyFromBitmap(bitmap) {
  const loadedModel = await ensureReady();
  if (!loadedModel) throw new Error('Model not available');
  
  // Рисуем bitmap на canvas 299x299 (размер модели)
  const canvas = new OffscreenCanvas(299, 299);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 299, 299);
  bitmap.close(); // Освобождаем память
  
  // Классифицируем
  const predictions = await loadedModel.classify(canvas, 5);
  
  // Возвращаем упрощённый формат для быстрой передачи
  return predictions.map(p => ({
    className: p.className,
    probability: p.probability
  }));
}

// Фоллбэк: классификация по data URL
async function classifyFromDataUrl(imageDataUrl) {
  const loadedModel = await ensureReady();
  if (!loadedModel) throw new Error('Model not available');
  
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const predictions = await loadedModel.classify(img, 5);
        resolve(predictions.map(p => ({
          className: p.className,
          probability: p.probability
        })));
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageDataUrl;
  });
}

// Обёртка с автоматическим retry при потере WebGL контекста
async function classifyWithRecovery(classifyFn) {
  try {
    return await classifyFn();
  } catch (error) {
    // Если ошибка связана с WebGL контекстом — пробуем восстановить и повторить
    const msg = error.message || '';
    const isContextError = isContextLost ||
      msg.includes('context lost') ||
      msg.includes('does not belong') ||
      msg.includes('INVALID_OPERATION') ||
      msg.includes('no valid shader') ||
      msg.includes('no texture bound');

    if (isContextError) {
      console.warn('NSFW Sandbox: WebGL error detected, attempting recovery...');
      isContextLost = true;
      const recovered = await recoverFromContextLoss();
      if (recovered) {
        // Повторяем классификацию после восстановления
        return await classifyFn();
      }
    }
    throw error;
  }
}

// Обработка сообщений
window.addEventListener('message', async (event) => {
  const { type, id, imageDataUrl } = event.data;
  
  if (type === 'CLASSIFY_IMAGE') {
    try {
      let predictions;
      
      // Обёртка с автоматическим восстановлением WebGL контекста
      if (event.data.bitmap) {
        const bitmap = event.data.bitmap;
        predictions = await classifyWithRecovery(() => classifyFromBitmap(bitmap));
      } else if (imageDataUrl) {
        predictions = await classifyWithRecovery(() => classifyFromDataUrl(imageDataUrl));
      } else {
        throw new Error('No image data provided');
      }
      
      window.parent.postMessage({
        type: 'CLASSIFY_RESULT',
        id,
        success: true,
        predictions
      }, '*');
    } catch (error) {
      window.parent.postMessage({
        type: 'CLASSIFY_RESULT',
        id,
        success: false,
        error: error.message
      }, '*');
    }
  }
  
  if (type === 'CLASSIFY_BATCH') {
    // Пакетная классификация
    const results = [];
    for (const item of event.data.items) {
      try {
        let predictions;
        if (item.bitmap) {
          predictions = await classifyFromBitmap(item.bitmap);
        } else {
          predictions = await classifyFromDataUrl(item.imageDataUrl);
        }
        results.push({ id: item.id, success: true, predictions });
      } catch (error) {
        results.push({ id: item.id, success: false, error: error.message });
      }
    }
    window.parent.postMessage({
      type: 'BATCH_RESULT',
      id,
      results
    }, '*');
  }
  
  if (type === 'PRELOAD_MODEL') {
    try {
      await loadModel();
      window.parent.postMessage({
        type: 'PRELOAD_RESULT',
        id,
        success: true
      }, '*');
    } catch (error) {
      window.parent.postMessage({
        type: 'PRELOAD_RESULT',
        id,
        success: false,
        error: error.message
      }, '*');
    }
  }
});

// Сообщаем о готовности и сразу загружаем модель
window.addEventListener('load', () => {
  console.log('NSFW Sandbox: Ready');
  window.parent.postMessage({ type: 'SANDBOX_READY' }, '*');
  loadModel();
});
