// Элементы управления
const enableFilter = document.getElementById('enableFilter');
const sensitivity = document.getElementById('sensitivity');
const sensitivityValue = document.getElementById('sensitivityValue');
const blockedCount = document.getElementById('blockedCount');
const scannedCount = document.getElementById('scannedCount');
const resetStats = document.getElementById('resetStats');
const modelSelect = document.getElementById('modelSelect');
const languageToggle = document.getElementById('languageToggle');

// Получение текущего языка
async function getCurrentLanguage() {
  const result = await chrome.storage.local.get('language');
  return result.language || (chrome.i18n.getUILanguage().startsWith('ru') ? 'ru' : 'en');
}

// Загрузка локализованных текстов
async function loadI18nMessages() {
  const currentLang = await getCurrentLanguage();
  
  // Загружаем переводы из соответствующего файла
  const messages = await fetch(chrome.runtime.getURL(`_locales/${currentLang}/messages.json`))
    .then(r => r.json());
  
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const message = messages[key]?.message;
    if (message) {
      // Для ссылок и кнопок добавляем иконки
      if (key === 'buyMeCoffee') {
        element.textContent = '☕ ' + message;
      } else if (key === 'bankTransfer') {
        element.textContent = '🏦 ' + message;
      } else {
        element.textContent = message;
      }
    }
  });
  
  // Обновляем текст кнопки смены языка
  updateLanguageButton(currentLang);
  
  // Обновляем lang атрибут
  document.documentElement.lang = currentLang;
}

// Обновление текста кнопки смены языка
async function updateLanguageButton(currentLang) {
  const messages = await fetch(chrome.runtime.getURL(`_locales/${currentLang}/messages.json`))
    .then(r => r.json());
  
  const nextLang = currentLang === 'ru' ? 'en' : 'ru';
  const nextLangKey = nextLang === 'ru' ? 'languageRussian' : 'languageEnglish';
  languageToggle.textContent = messages[nextLangKey]?.message || (nextLang === 'ru' ? '🇷🇺 Русский' : '🇬🇧 English');
}

// Загрузка настроек при открытии popup
async function loadSettings() {
  const result = await chrome.storage.local.get([
    'enabled',
    'sensitivity',
    'trainedModel',
    'stats'
  ]);

  // Установка значений
  enableFilter.checked = result.enabled !== false;
  sensitivity.value = result.sensitivity ?? 50;
  sensitivityValue.textContent = `${sensitivity.value}%`;
  modelSelect.value = result.trainedModel ?? 'MobileNet_v2';
  updateSliderTrack();

  const stats = result.stats ?? { blocked: 0, scanned: 0 };
  blockedCount.textContent = formatNumber(stats.blocked);
  scannedCount.textContent = formatNumber(stats.scanned);
}

// Форматирование чисел
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

// Сохранение настроек
async function saveSettings() {
  const settings = {
    enabled: enableFilter.checked,
    sensitivity: parseInt(sensitivity.value),
    trainedModel: modelSelect.value,
    categories: {
      porn: true,
      sexy: true,
      hentai: true
    }
  };

  await chrome.storage.local.set(settings);

  // Уведомление background → offscreen (модель + чувствительность)
  chrome.runtime.sendMessage({
    type: 'SETTINGS_UPDATED',
    settings
  }).catch(() => {});

  // Уведомление ВСЕХ content scripts об изменении настроек
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

// Обработчики событий
enableFilter.addEventListener('change', saveSettings);

// Обновление цветной полоски слайдера (--track из CSS учитывает тему)
function updateSliderTrack() {
  const val = sensitivity.value;
  sensitivity.style.background =
    `linear-gradient(to right, #6d6ff5 0%, #a855f7 ${val}%, var(--track) ${val}%)`;
}

sensitivity.addEventListener('input', () => {
  sensitivityValue.textContent = `${sensitivity.value}%`;
  updateSliderTrack();
});

sensitivity.addEventListener('change', saveSettings);
modelSelect.addEventListener('change', saveSettings);

resetStats.addEventListener('click', async () => {
  await chrome.storage.local.set({
    stats: { blocked: 0, scanned: 0 }
  });
  blockedCount.textContent = '0';
  scannedCount.textContent = '0';
});

// Переключение языка
languageToggle.addEventListener('click', async () => {
  const currentLang = await getCurrentLanguage();
  const newLang = currentLang === 'ru' ? 'en' : 'ru';
  await chrome.storage.local.set({ language: newLang });
  await loadI18nMessages();
  // Перезагружаем настройки чтобы обновить статистику
  await loadSettings();
});

// Обновление статистики в реальном времени
chrome.storage.onChanged.addListener((changes) => {
  if (changes.stats) {
    const stats = changes.stats.newValue;
    blockedCount.textContent = formatNumber(stats.blocked);
    scannedCount.textContent = formatNumber(stats.scanned);
  }
});

// Версия
document.getElementById('versionText').textContent =
  `v${chrome.runtime.getManifest().version} — WebGPU`;

// Инициализация
loadI18nMessages();
loadSettings();
