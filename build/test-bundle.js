// End-to-end тест собранного бандла: запускать после КАЖДОЙ сборки!
//   node test-bundle.js
// Проверяет: регистрацию бэкендов, загрузку обеих моделей,
// классификацию (chained ops!), сумму вероятностей.

const fs = require('fs');
const path = require('path');

// Браузерные заглушки для Node
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = {
  createElement: () => ({ getContext: () => null, style: {} }),
  documentElement: {},
  addEventListener: () => {}
};

// fetch → локальные файлы моделей (ext://путь → ../путь)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const m = String(url).match(/^ext:\/\/(.*)$/);
  if (!m) return realFetch(url);
  const p = path.join(__dirname, '..', m[1]);
  const buf = fs.readFileSync(p);
  return new Response(buf, {
    status: 200,
    headers: { 'Content-Type': p.endsWith('.json') ? 'application/json' : 'application/octet-stream' }
  });
};

require('../lib/tfjs-nsfwjs-webgpu.min.js');

(async () => {
  let failed = false;

  // 1. Бэкенды зарегистрированы (webgpu виден только при navigator.gpu — не проверяем)
  for (const b of ['webgl', 'wasm', 'cpu']) {
    const ok = tf.findBackendFactory(b) != null;
    console.log(`backend ${b} registered: ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failed = true;
  }
  if (typeof setWasmPaths !== 'function') {
    console.log('setWasmPaths exposed: FAIL');
    failed = true;
  }

  await tf.setBackend('cpu');
  await tf.ready();

  // 2. Обе модели: загрузка + классификация
  for (const { name, dir, size } of [
    { name: 'MobileNet_v2', dir: 'ext://models/', size: 224 },
    { name: 'InceptionV3', dir: 'ext://models/inceptionv3/', size: 299 }
  ]) {
    try {
      const model = await nsfwjs.load(dir, { size });
      const img = tf.randomUniform([size, size, 3], 0, 255, 'int32');
      const preds = await model.classify(img, 5);
      img.dispose();
      const sum = preds.reduce((s, p) => s + p.probability, 0);
      const sane = sum > 0.99 && sum < 1.01 && preds.length === 5;
      console.log(`${name}: classify ${sane ? 'OK' : 'FAIL'} (sum=${sum.toFixed(3)})`);
      if (!sane) failed = true;
    } catch (e) {
      console.log(`${name}: FAIL — ${e.message}`);
      failed = true;
    }
  }

  console.log(failed ? '=== BUNDLE TEST FAILED ===' : '=== BUNDLE TEST PASSED ===');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
