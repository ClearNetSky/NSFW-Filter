# Changelog

## v2.2.0 — Drawing/Hentai Detection Fix & Coverage Restore

### Classification (главное)
- **NSFW-рисунки снова блокируются** — переработана логика Hentai:
  - убран штраф «+0.15 к порогу при Drawing > 0.3», который систематически пропускал хентай-рисунки (модель делит вероятность между Drawing и Hentai, например 0.45/0.40)
  - Hentai блокируется, если он **топ-класс** предсказания и скор ≥ max(0.25, порог×0.5)
  - Hentai блокируется, если NSFW-масса (hentai+porn) перевешивает безопасную (drawing+neutral)
  - обычный порог (`hentai >= threshold`) сохранён
- Причина деградации с v2.0: дефолт сменился с InceptionV3 (299px) на MobileNet v2 (224px), у которой скоры на рисунках ниже — старый алгоритм был откалиброван под InceptionV3

### Восстановленный функционал (потерян при переписывании в v2.0)
- **Фильтрация CSS background-image** — inline-стили отслеживаются через MutationObserver, классовые фоны сканируются один раз после загрузки страницы (было в v1.6–v1.8)
- **Фильтрация постеров `<video poster>`** — постер скрыт до классификации, NSFW-видео скрывается целиком (было в v1.6–v1.8)

### Исправления
- **Критический баг: выключенный фильтр прятал все картинки** — CSS `opacity: 0` инжектился всегда, но при `enabled: false` статусы изображениям не проставлялись → страницы без картинок. Теперь CSS удаляется при выключенном фильтре
- **Сбои загрузки больше не кэшируются как «безопасно»** — временная сетевая ошибка помечала URL как SFW навсегда (LRU 500), пропуская NSFW при повторных показах
- **Failsafe-таймаут (20с)** — если модель зависла или очередь переполнена, картинка показывается (fail-open); поздний вердикт NSFW всё равно скрывает её
- **Смена модели не «подвешивает» страницы** — ожидающие запросы получают ответ fail-open вместо вечного ожидания
- **Провал загрузки модели (5 попыток)** — буферизованные запросы получают fail-open ответ вместо вечно скрытых картинок

### Улучшения
- **GIF теперь классифицируются** (первый кадр) — раньше NSFW-гифки пропускались полностью
- Таймаут загрузки изображения в offscreen: 3с → 5с (медленные соединения)

### WebGL-фолбэк (пересборка бандла)
- **Бандл пересобран с тремя бэкендами: WebGPU → WebGL → CPU** — на машинах без WebGPU (старые GPU/драйверы) классификация теперь идёт на GPU через WebGL, а не на медленном CPU
- Явные импорты `@tensorflow/tfjs-backend-webgl` и `-cpu` в entry (раньше alias на shim исключал WebGL из сборки)
- Проверка результата `tf.setBackend()` — он может вернуть `false` без исключения; раньше это не обрабатывалось
- **Восстановление после потери GPU-контекста** — при ошибках вида context lost / shader / framebuffer бэкенд и модель переинициализируются, классификация повторяется (аналог recovery-подсистемы из v1.5)
- Команда сборки сохранена в `build/package.json` (`npm run build`)
- **Фикс битой сборки**: `@tensorflow/tfjs-core` помечен `sideEffects: false`, и esbuild выкидывал регистрацию chained ops (`tensor.toFloat()` и др.) — каждое предсказание падало с «t.toFloat is not a function», фильтр молча переставал блокировать (fail-open). Теперь chained ops импортируются явно
- **`build/test-bundle.js`** — end-to-end тест бандла (бэкенды + обе модели + classify); обязателен после каждой сборки: `node test-bundle.js`

### Закрытые Shadow DOM и pseudo-элементы
- **Закрытые (closed) shadow roots теперь фильтруются** — MAIN-world скрипт патчит `attachShadow` (все roots создаются открытыми, техника Dark Reader) и шлёт событие; content script мгновенно подключает новый root. Требует Chrome 111+ (`minimum_chrome_version`)
- **::before/::after с background-image** — computed-скан проверяет pseudo-элементы; NSFW-фон блокируется CSS-правилом через атрибут `data-nsfw-pseudo-blocked` (inline-стиль pseudo-элементу выставить нельзя)
- Рефакторинг: единый `classifyBackgroundUrl()` для inline- и computed-фонов

### Viewport-приоритизация (фикс «невидимых картинок» при быстром скролле)
- **Классификация запускается только при приближении картинки к вьюпорту (±600px, IntersectionObserver)** — раньше быстрый скролл (Google Images) ставил в очередь сотни предсказаний разом, очередь росла на минуты, и видимые картинки висели с `opacity: 0`, «не обрабатываясь»
- URL берётся заново в момент запуска предсказания — lazy-загрузчик мог сменить src за время ожидания
- Failsafe-таймер стартует только с началом предсказания — вне экрана картинки не раскрываются непроверенными
- Бонус: фоновые вкладки не рендерят кадры → классификация в них не тратит GPU; при активации вкладки всё догоняет
- **Хеширование длинных ключей кэша** (FNV-1a ×2) — data URL по 10–50КБ больше не раздувают память кэша (до ~25МБ на 500 записей)
- Расширен attributeFilter: `data-original-src`, `data-lazy` (читались, но изменения не отслеживались)

### Аудит (стабильность, производительность, покрытие)
- **Shadow DOM** — открытые shadow roots сканируются и наблюдаются; CSS-скрытие инжектируется в каждый shadow root (стили страницы туда не проникают); вложенные shadow roots поддерживаются
- **blob:-URL** — изображения из `blob:` (SPA, видео-превью) конвертируются через canvas в data URL и классифицируются; раньше пропускались полностью
- **Инвалидация контекста** — при перезагрузке/обновлении расширения CSS снимается и «processing»-элементы показываются; раньше новые картинки на открытых страницах повисали невидимыми навсегда
- **Троттлированный перескан для SPA** (раз в 4с по мутациям) — classed-фоны (`background-image` из CSS-классов) и поздно созданные shadow roots
- **Баг: добавленный элемент с inline background не сканировался** — `querySelectorAll` не включает корневой узел; теперь корень проверяется отдельно
- **Баг: если страница загрузилась с выключенным фильтром, включение в попапе не запускало наблюдение** — observer стартовал только в init()
- **background: зависание после ошибки создания offscreen** — rejected promise не сбрасывался, и все последующие запросы падали вечно (try/finally)
- **background: таймаут ожидающих запросов (30с)** — Map не растёт бесконечно при крэше offscreen
- **background: сериализация записи статистики** — параллельные get→set из разных вкладок теряли обновления
- **offscreen: приоритет активной вкладки** — её картинки загружаются и классифицируются первыми (unshift в очереди)
- **manifest: удалён `web_accessible_resources`** — модели загружает offscreen-документ (same-origin), веб-доступ не нужен; открытые ресурсы позволяли сайтам фингерпринтить расширение
- Удалён мёртвый код: `onConnect`/`OFFSCREEN_CLEAR_CACHE` (попап не использует порты), цепочка `totalBlocked` (никто не запрашивал), неиспользуемый `STORAGE_KEY`

---

## v2.1.0 — Settings Sync & Flash Fix

### Fixes
- **Settings sync to offscreen** — sensitivity slider and model selection now properly reach the offscreen document via `OFFSCREEN_SETTINGS_UPDATED` message
- **Model hot-reload** — switching between MobileNet v2 and InceptionV3 now reloads the model without restarting the extension
- **Cache invalidation on settings change** — LRU cache clears when sensitivity changes so new threshold applies immediately
- **No NSFW flash on page load** — all images hidden with `opacity: 0` by default until classified; safe images (SVG, GIF, icons, < 32px) are revealed instantly
- **Popup → Background messaging** — popup now sends `SETTINGS_UPDATED` via `chrome.runtime.sendMessage()` in addition to `chrome.tabs.sendMessage()`, ensuring background and offscreen receive settings changes

### Improvements
- Images that are skipped (safe URL, too small) now immediately get `data-nsfw-filter-status="sfw"` instead of being left unmarked
- Filter disable/enable properly resets all image statuses for clean re-scan

---

## v2.0.0 — Major Architecture Overhaul

### Architecture
- **Removed sandbox layer** — TF.js runs directly in offscreen document (3-layer instead of 4-layer)
- **WebGPU backend** — GPU acceleration without `unsafe-eval` CSP; CPU fallback if unavailable
- **fetch() + blob image loading** — bypasses CORS restrictions on all CDNs (Google, Bing, Reddit, etc.)
- **esbuild bundle** — TF.js 4.22.0 + nsfwjs 4.3.0 in a single 1.5MB file (down from 38MB)

### Models
- **MobileNet v2** as default model (224px, 2.6MB, fast)
- **InceptionV3** as optional model (299px, 22MB, more accurate)
- Model selection in popup settings

### Classification
- **5-class algorithm** preserved (Drawing, Hentai, Neutral, Porn, Sexy)
- Drawing/Neutral score-aware threshold adjustments (reduces false positives on anime/illustrations)
- Combined NSFW score fallback (blocks when individual scores are below threshold but combined > 70%)
- Per-category enable/disable support (porn/sexy/hentai)

### Content Script
- **Google Images support** — processes `data:image/jpeg` thumbnails
- **Lazy-load support** — `data-src`, `data-lazy-src`, `data-original`, `data-lazy`, `data-actualsrc` (VK), `data-thumb-url` / `data-preview-url` (Reddit)
- **srcset / currentSrc** resolution for responsive images
- **SPA re-scan** — periodic scan for Reddit, VK, Twitter, Instagram, Facebook, TikTok, Tumblr
- **Video poster** filtering
- Smart URL filtering — skips SVG, GIF, favicons, sprites, tracking pixels
- `Extension context invalidated` error handling with graceful degradation

### Queues & Cache
- **LoadingQueue** — 100 concurrent image loads, 3s timeout
- **PredictionQueue** — 1 sequential prediction (prevents GPU contention)
- **LRU cache** — 500 entries shared across all tabs
- **Request deduplication** — same URL = single prediction, multiple waiters

### Popup
- Model selection (MobileNet v2 / InceptionV3)
- Version number in footer
- Dark mode (automatic, follows system preference)

### Performance
- Bundle size: 1.5MB (was 38MB with embedded models)
- No `unsafe-eval` needed (WebGPU doesn't require it)
- Tab lifecycle management — cancels predictions for closed/navigated tabs

---

## v1.8.0
- Opacity-hide pending images
- Removed whitelist/blur/click-to-reveal

## v1.7.0
- Whitelist, badge, SVG placeholder, memory & filtering improvements

## v1.6.0
- Performance & coverage improvements

## v1.5.1
- WebGL recovery & CORS fixes

## v1.5.0
- Initial WebGL-based filtering
