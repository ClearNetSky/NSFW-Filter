# 🛡️ NSFW Filter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Stars](https://img.shields.io/github/stars/AristarhUcolov/NSFW-Filter?style=social)](https://github.com/ClearNetSky/NSFW-Filter/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/AristarhUcolov/NSFW-Filter)](https://github.com/ClearNetSky/NSFW-Filter/issues)
[![GitHub Release](https://img.shields.io/github/v/release/AristarhUcolov/NSFW-Filter?include_prereleases)](https://github.com/ClearNetSky/NSFW-Filter/releases)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-brightgreen)](https://chromewebstore.google.com/detail/nsfw-filter/nojnjhlhdhfaghkgdgdcobjnoeghkopg)
[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/ClearNetSky/NSFW-Filter)

[🇷🇺 Русский](#russian) | [🇬🇧 English](#english)

---

<a name="russian"></a>
## 🇷🇺 Русская версия

### Защита от нежелательного контента

Chrome расширение для блокировки NSFW контента (порнография, хентай, откровенные изображения) в реальном времени с использованием AI на базе TensorFlow.js и NSFWJS. Использует WebGPU для GPU-ускорения без `unsafe-eval`.

## ✨ Возможности

- 🚀 **WebGPU ускорение** — GPU-ускорение без необходимости `unsafe-eval` CSP; автоматический CPU fallback
- 🔒 **Блокировка в реальном времени** — изображения проверяются при загрузке страницы
- 🎚️ **Настраиваемая чувствительность** — ползунок от 0% до 100%
- 🧠 **Выбор модели** — MobileNet v2 (быстрая, 2.6MB) или InceptionV3 (точная, 22MB)
- 🌐 **Обход CORS** — `fetch() + blob` загрузка работает на всех CDN (Google, Bing, Reddit и др.)
- 🖼️ **Google Images** — фильтрация `data:image/jpeg` миниатюр в поиске картинок
- 📊 **5-классовая классификация** — Drawing, Hentai, Neutral, Porn, Sexy
- 📈 **Статистика** — отслеживание заблокированных и проверенных изображений
- 🖥️ **Локальная обработка** — никакие данные не отправляются на сервер
- 💾 **LRU кеш** — 500 записей, общий для всех вкладок
- 🔄 **Дедупликация запросов** — один URL = одна проверка, несколько ожидающих
- 🌙 **Тёмный режим** — автоматический, следует системным настройкам
- 🌍 **Русский / English** — переключение языка в popup

## 📦 Установка

1. Скачайте или клонируйте этот репозиторий
2. Откройте Chrome → `chrome://extensions/`
3. Включите **Режим разработчика**
4. Нажмите **Загрузить распакованное расширение**
5. Выберите папку `NSFW-Filter`

## 🎮 Использование

1. Кликните на иконку расширения 🛡️ в панели инструментов Chrome
2. Используйте переключатель для включения/выключения защиты
3. Настройте чувствительность фильтра:
   - **0%** — Мягкий режим (только явно откровенные изображения)
   - **50%** — Сбалансированный режим (рекомендуется)
   - **100%** — Строгий режим (даже подозрительные изображения)
4. Выберите модель классификации
5. Наблюдайте за статистикой

## 🏗️ Архитектура

3-уровневая архитектура без sandbox:

```
content.js → background.js (Service Worker) → offscreen.js (TF.js + WebGPU)
```

1. **content.js** — сканирует изображения на странице, скрывает NSFW
2. **background.js** — маршрутизирует запросы, управляет offscreen document
3. **offscreen.js** — загружает модель, классифицирует изображения через TF.js + WebGPU

## 📁 Структура проекта

```
NSFW-Filter/
├── manifest.json              # Manifest V3 конфигурация
├── background/
│   └── background.js          # Service Worker (маршрутизация, LRU кеш)
├── offscreen/
│   ├── offscreen.html         # Offscreen document
│   └── offscreen.js           # TF.js + nsfwjs классификация (WebGPU)
├── content/
│   └── content.js             # Сканирование и скрытие изображений
├── popup/
│   ├── popup.html             # Интерфейс настроек
│   ├── popup.css              # Стили (+ тёмный режим)
│   └── popup.js               # Логика интерфейса
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── lib/
│   └── tfjs-nsfwjs-webgpu.min.js  # TF.js 4.22 + nsfwjs 4.3 бандл (1.5MB)
├── models/
│   ├── model.json             # MobileNet v2 конфигурация
│   ├── group1-shard1of1       # MobileNet v2 веса (2.6MB)
│   └── inceptionv3/           # InceptionV3 модель (22MB, 6 шардов)
├── _locales/
│   ├── en/messages.json
│   └── ru/messages.json
└── CHANGELOG.md
```

## ⚠️ Ограничения

- Модель не идеальна и может иногда ошибаться (ложные срабатывания)
- GIF и SVG изображения пропускаются
- Изображения меньше 32x32 пикселей игнорируются

## 🔒 Приватность

- Все изображения обрабатываются **локально** на вашем устройстве
- Никакие данные **не отправляются** на внешние серверы
- Расширение не собирает и не хранит личную информацию

## 🛠️ Технологии

- [TensorFlow.js 4.22](https://www.tensorflow.org/js) — машинное обучение в браузере (WebGPU backend)
- [NSFWJS 4.3](https://github.com/infinitered/nsfwjs) — модель классификации контента
- Chrome Extension Manifest V3
- esbuild — сборка бандла

## 📋 История изменений

Полная история изменений в [CHANGELOG.md](CHANGELOG.md).

## 📝 Лицензия

MIT License

## 💖 Поддержать проект

Если это расширение вам помогло, вы можете поддержать разработку:

**☕ Buy Me a Coffee:**
[buymeacoffee.com/aristarh.ucolov](https://buymeacoffee.com/aristarh.ucolov)

**💜 DonationAlerts:**
[donationalerts.com/r/aristarh_ucolov](https://www.donationalerts.com/r/aristarh_ucolov)

## 🙏 Благодарности

- [Infinite Red](https://github.com/infinitered) за NSFWJS
- Google за TensorFlow.js

---

<a name="english"></a>
## 🇬🇧 English Version

### Content Protection Extension

A Chrome extension for blocking NSFW content (pornography, hentai, explicit images) in real-time using AI powered by TensorFlow.js and NSFWJS. Uses WebGPU for GPU acceleration without `unsafe-eval`.

## ✨ Features

- 🚀 **WebGPU Acceleration** — GPU-accelerated inference without `unsafe-eval` CSP; automatic CPU fallback
- 🔒 **Real-time Blocking** — images are checked as pages load
- 🎚️ **Adjustable Sensitivity** — slider from 0% to 100%
- 🧠 **Model Selection** — MobileNet v2 (fast, 2.6MB) or InceptionV3 (accurate, 22MB)
- 🌐 **CORS Bypass** — `fetch() + blob` loading works on all CDNs (Google, Bing, Reddit, etc.)
- 🖼️ **Google Images** — filters `data:image/jpeg` thumbnails in image search
- 📊 **5-class Classification** — Drawing, Hentai, Neutral, Porn, Sexy
- 📈 **Statistics** — track blocked and scanned images
- 🖥️ **Local Processing** — no data is sent to any server
- 💾 **LRU Cache** — 500 entries shared across all tabs
- 🔄 **Request Deduplication** — one URL = one prediction, multiple waiters
- 🌙 **Dark Mode** — automatic, follows system preference
- 🌍 **Russian / English** — language toggle in popup

## 📦 Installation

1. Download or clone this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the `NSFW-Filter` folder

## 🎮 Usage

1. Click the extension icon 🛡️ in the Chrome toolbar
2. Use the toggle to enable/disable protection
3. Adjust the filter sensitivity:
   - **0%** — Soft mode (blocks only explicitly graphic images)
   - **50%** — Balanced mode (recommended)
   - **100%** — Strict mode (blocks even suspicious images)
4. Select the classification model
5. Monitor statistics

## 🏗️ Architecture

3-layer architecture without sandbox:

```
content.js → background.js (Service Worker) → offscreen.js (TF.js + WebGPU)
```

1. **content.js** — scans images on the page, hides NSFW content
2. **background.js** — routes requests, manages offscreen document
3. **offscreen.js** — loads model, classifies images via TF.js + WebGPU

## 📁 Project Structure

```
NSFW-Filter/
├── manifest.json              # Manifest V3 configuration
├── background/
│   └── background.js          # Service Worker (routing, LRU cache)
├── offscreen/
│   ├── offscreen.html         # Offscreen document
│   └── offscreen.js           # TF.js + nsfwjs classification (WebGPU)
├── content/
│   └── content.js             # Image scanning and hiding
├── popup/
│   ├── popup.html             # Settings interface
│   ├── popup.css              # Styles (+ dark mode)
│   └── popup.js               # Interface logic
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── lib/
│   └── tfjs-nsfwjs-webgpu.min.js  # TF.js 4.22 + nsfwjs 4.3 bundle (1.5MB)
├── models/
│   ├── model.json             # MobileNet v2 configuration
│   ├── group1-shard1of1       # MobileNet v2 weights (2.6MB)
│   └── inceptionv3/           # InceptionV3 model (22MB, 6 shards)
├── _locales/
│   ├── en/messages.json
│   └── ru/messages.json
└── CHANGELOG.md
```

## ⚠️ Limitations

- The model is not perfect and may sometimes make mistakes (false positives)
- GIF and SVG images are skipped
- Images smaller than 32x32 pixels are ignored

## 🔒 Privacy

- All images are processed **locally** on your device
- No data is **sent** to external servers
- The extension does not collect or store personal information

## 🛠️ Technologies

- [TensorFlow.js 4.22](https://www.tensorflow.org/js) — machine learning in the browser (WebGPU backend)
- [NSFWJS 4.3](https://github.com/infinitered/nsfwjs) — content classification model
- Chrome Extension Manifest V3
- esbuild — bundle builder

## 📋 Changelog

Full changelog in [CHANGELOG.md](CHANGELOG.md).

## 📝 License

MIT License

## 💖 Support the Project

If this extension helped you, you can support development:

**☕ Buy Me a Coffee:**
[buymeacoffee.com/aristarh.ucolov](https://buymeacoffee.com/aristarh.ucolov)

**💜 DonationAlerts:**
[donationalerts.com/r/aristarh_ucolov](https://www.donationalerts.com/r/aristarh_ucolov)

Your support helps keep the project going! 🙏

## 🙏 Acknowledgments

- [Infinite Red](https://github.com/infinitered) for NSFWJS
- Google for TensorFlow.js
