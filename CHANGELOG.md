# Changelog

## v2.3.5 — Deep Audit: Multi-tab Dedup & Permission Cleanup

### Исправлено
- **Дедупликация между вкладками могла показать непроверенную картинку.**
  Когда один и тот же URL запрашивался из нескольких вкладок, он классифицировался
  один раз, а очередь загрузки хранила данные только ПЕРВОЙ вкладки. Если та
  уходила на другую страницу во время загрузки, отклонялись ВСЕ ожидающие — и в
  ещё открытых вкладках картинка показывалась по fail-open. Теперь отмена по
  навигации срабатывает только когда ждёт ровно одна вкладка (та, что и ушла)
- **Убрано лишнее разрешение `tabs`.** При наличии `<all_urls>` в host_permissions
  доступ к `tab.url` есть и без него, поэтому `tabs` было избыточным — но добавляло
  пугающее предупреждение «Читать историю посещений» при установке. Меньше
  разрешений — проще проверка в Chrome Web Store и выше доверие пользователей

### Проверено, признано приемлемым (без изменений)
- Жизненный цикл MV3 service worker: обрыв на лету обрабатывается fail-open +
  таймаут 30с; коллизии `requestId` практически невозможны
- `dispose()` модели при переключении во время инференса: заканчивается штатной
  ошибкой (перехватывается), редкий случай — добавление отложенного dispose внесло
  бы больше риска, чем пользы
- `getComputedStyle`/`getBoundingClientRect` в скане фонов: цикл только на чтение,
  один пересчёт layout — без thrash

---

## v2.3.4 — Settings Re-scan & Background Restore

### Исправлено
- **Смена чувствительности/модели «ничего не делала» до перезагрузки.**
  Обработчик `SETTINGS_UPDATED` в content-скрипте имел только ветки
  «выключить» и «включить»; когда фильтр оставался включённым, а менялся
  порог, уже помеченные картинки на странице не переоценивались. Теперь при
  изменении чувствительности или модели страница пересканируется с новым
  порогом (background параллельно чистит кэш вердиктов)
- **Ставший безопасным фон оставался скрытым.** При блокировке ИНЛАЙНОВОГО
  `background-image` мы затирали его значением `none`, теряя исходный URL, а
  `removeProperty` его не возвращал. Теперь URL сохраняется и восстанавливается
  из dataset. Тот же баг чинится и в пути выключения фильтра
- **Дублирование `<style>` в Shadow DOM.** Повторная инъекция shadow-CSS при
  переоценке плодила бы копии в каждом shadow root; теперь инъекция только при
  реальном включении фильтра

### Тесты
- **`build/test-settings.js`** — E2E-проверки реакции на смену настроек
  (перескан по чувствительности, восстановление инлайнового фона, отсутствие
  дублей shadow-CSS). Добавлено в `npm test`

---

## v2.3.3 — WebGPU Warm-up Fix

### Критическое (производительность)
- **Warm-up ВСЕГДА проваливался на WebGPU → все пользователи молча
  откатывались на WebGL.** Прогрев прогонял `model.classify()` по голому
  `<canvas>` без rendering-контекста, а WebGPU-бэкенд TF.js для такого canvas
  падает в `copyExternalImageToTexture` («canvas without rendering context»).
  Логика деградации считала это признаком нерабочего GPU и переключалась на
  WebGL — терялось главное преимущество WebGPU-архитектуры (v2.0).
  Реальная классификация при этом работала: она использует `ImageBitmap`,
  ломался только warm-up-проба.
  Теперь warm-up прогревается на `ImageBitmap` — ровно на том типе, что идёт
  в проде, так что и compile-cache пайплайнов совпадает, и WebGPU принимает
  источник. В логах исчезает `CopyExternalImageToTexture ... will return early`.

---

## v2.3.2 — Full Audit: Critical Fixes & Regression Tests

Полный аудит всех слоёв расширения. Найденные проблемы подтверждены
воспроизводящими тестами и исправлены.

### Критическое
- **Бесконечный цикл вешал расширение целиком.** `flushBuffered()` перебирал
  массив `buffered` через `for...of`, а `dispatchPredict` при незагруженной
  модели возвращал элементы обратно в тот же массив — итератор перечитывает
  `length` на каждом шаге, поэтому цикл не завершался никогда. Offscreen-документ
  зависал намертво, классификация полностью останавливалась. Срабатывало, если
  первая попытка загрузки модели провалилась, а запросы уже поступили.
  Теперь буфер снимается снимком (`splice`) до диспатча
- **Повторные попытки загрузки модели не разбирали буфер** — после успешного
  retry накопленные запросы оставались висеть до failsafe-таймаута (20с).
  `flushBuffered()` вызывается при успешной загрузке
- **Буфер рос без ограничений**, если модель не поднималась вообще — добавлен
  кап в 500 записей с fail-open ответом для вытесненных

### Важное
- **Риск «страницы без картинок» навсегда** — CSS прячет изображения с
  document_start, а настройки читаются асинхронно; если service worker не
  ответит (крэш/перезагрузка), картинки не появлялись бы никогда. Добавлен
  backstop-таймаут 4с, снимающий прячущий CSS
- **`OFFSCREEN_INIT` мог теряться** — сообщение уходило сразу после
  `createDocument`, до того как offscreen успевал зарегистрировать слушатель;
  тогда фильтр работал с порогом по умолчанию вместо пользовательского и без
  сохранённого кэша. Добавлен handshake `OFFSCREEN_READY`
- **Устаревшие вердикты воскресали после смены настроек** — отложенная запись
  (буфер offscreen + активная запись в background) завершалась уже после
  очистки кэша и возвращала вердикты, посчитанные со старым порогом.
  Очистка поставлена в ту же цепочку записи, буфер offscreen сбрасывается
- **Фоны после 3000-го элемента не сканировались никогда** — лимит считался по
  позиции в документе, и уже проверенные элементы съедали его целиком. Бюджет
  теперь считается по новым элементам, остаток досканируется следующей порцией
- **Утечка памяти на бесконечных лентах** — `IntersectionObserver` держит
  сильные ссылки, поэтому удалённые из DOM картинки накапливались навсегда.
  Добавлена периодическая чистка отсоединённых элементов

### Мелкое
- `chrome.action.setBadgeText/BackgroundColor` без `.catch` давали unhandled
  rejection при закрытии вкладки — засоряло лог service worker'а
- Смена модели через `OFFSCREEN_INIT` (если настройки пришли после старта
  загрузки с дефолтом) теперь корректно перезагружает нужную модель

### Тесты
- **`build/test-content.js`** — E2E-тест content-скрипта в headless Chrome на
  реальном DOM: 15 проверок (картинки, lazy-load, SVG/мелкие, постеры видео,
  CSS-фоны, `::before`, открытый и **закрытый** Shadow DOM)
- `npm test` в `build/` гоняет оба набора: бандл + content-скрипт

---

## v2.3.1 — New Icon, Popup Redesign & Store Assets

### Дизайн
- **Новая иконка** — щит с градиентом индиго→фиолет и «закрытым глазом»
  (символ скрытого контента); отрисована в 16/48/128px с прозрачным фоном
- **Полный редизайн попапа** — карточный интерфейс, единая акцентная палитра
  в тон иконке, отполированные светлая и тёмная темы (CSS-переменные),
  иконка расширения вместо эмодзи в шапке
- Фикс: цвета полоски слайдера задавались из JS старой палитрой и
  игнорировали тёмную тему — теперь через CSS-переменную `--track`

### Ассеты для Chrome Web Store (`store-assets/`)
- 3 витринных кадра 1280×800 (hero, покрытие, приватность)
- Промо-тайл 440×280
- Скриншоты попапа (light/dark, en/ru), сняты автоматически через
  headless Chrome со стабом chrome-API

---

## v2.3.0 — WASM Backend, Fast Decode & Persistent Cache

### Скорость
- **createImageBitmap с даунскейлом при декодировании** — фото декодируется
  сразу в размер модели (224/299px) вне основного потока, вместо полного
  разворачивания (4000px) и последующего сжатия в TF. Быстрее и в разы меньше
  памяти на больших фото; ImageBitmap освобождается сразу после предикта
- **Персистентный кэш вердиктов** — вердикты сохраняются в chrome.storage.local
  (до 3000 записей) и сидируются в LRU при старте: повторный заход на сайт =
  мгновенные вердикты без классификации. Инвалидация при смене настроек.
  LRU увеличен 500 → 3000
- **WASM-бэкенд (SIMD)** — третья ступень цепочки webgpu → webgl → wasm → cpu:
  на машинах без GPU классификация в разы быстрее голого CPU-бэкенда.
  Однопоточный вариант (многопоточный требует blob:-воркеры, запрещённые MV3 CSP);
  в манифест добавлен CSP `'wasm-unsafe-eval'` (JS eval по-прежнему запрещён)

### Инфраструктура
- .wasm бинарники (basic + SIMD) в lib/, пути через `setWasmPaths`
- test-bundle.js проверяет регистрацию wasm-бэкенда и экспорт setWasmPaths

---

## v2.2.1 — Model Warm-up & GPU Resilience

### Скорость
- **Прогрев модели после загрузки** — classify по пустому canvas сразу после
  load: компиляция WebGPU-пайплайнов/WebGL-шейдеров (секунды на холодном GPU)
  происходит заранее, а не на первой реальной картинке страницы. Это главная
  причина «медленного старта» по сравнению с апстримом

### Стабильность
- **Прогрев = валидация бэкенда**: бэкенд может зарегистрироваться, но зависнуть
  на первом реальном инференсе — провал прогрева (таймаут 8с) освобождает модель
  и перезагружает её на следующей ступени (webgpu → webgl → cpu)
- **Таймаут предсказания (10с)** — очередь последовательная, один зависший
  GPU-инференс заклинивал все картинки за ним навечно; теперь таймаут
  триггерит восстановление бэкенда
- **Таймаут загрузки модели (15с)** — зависшее чтение весов/загрузка в GPU
  восстанавливается через retry вместо вечного «processing»
- **Dispose старой модели при переключении** — раньше обе модели оставались
  резидентными в GPU-памяти
- Удалён неиспользуемый `FILTER_LIST`

---

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
