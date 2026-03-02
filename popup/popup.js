// Элементы управления
const enableFilter = document.getElementById('enableFilter');
const sensitivity = document.getElementById('sensitivity');
const sensitivityValue = document.getElementById('sensitivityValue');
const blockedCount = document.getElementById('blockedCount');
const scannedCount = document.getElementById('scannedCount');
const resetStats = document.getElementById('resetStats');
const showBankDetails = document.getElementById('showBankDetails');
const bankDetails = document.getElementById('bankDetails');
const languageToggle = document.getElementById('languageToggle');
const whitelistCurrent = document.getElementById('whitelistCurrent');
const whitelistStatus = document.getElementById('whitelistStatus');
const whitelistList = document.getElementById('whitelistList');

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
    'stats'
  ]);

  // Установка значений
  enableFilter.checked = result.enabled !== false;
  sensitivity.value = result.sensitivity ?? 50;
  sensitivityValue.textContent = `${sensitivity.value}%`;
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
  const result = await chrome.storage.local.get('whitelist');
  const settings = {
    enabled: enableFilter.checked,
    sensitivity: parseInt(sensitivity.value),
    // Все категории всегда включены
    categories: {
      porn: true,
      sexy: true,
      hentai: true
    },
    whitelist: result.whitelist ?? []
  };

  await chrome.storage.local.set(settings);

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

// Обновление цветной полоски слайдера
function updateSliderTrack() {
  const val = sensitivity.value;
  sensitivity.style.background = `linear-gradient(to right, #667eea 0%, #764ba2 ${val}%, #e0e0e0 ${val}%)`;
}

sensitivity.addEventListener('input', () => {
  sensitivityValue.textContent = `${sensitivity.value}%`;
  updateSliderTrack();
});

sensitivity.addEventListener('change', saveSettings);

resetStats.addEventListener('click', async () => {
  await chrome.storage.local.set({
    stats: { blocked: 0, scanned: 0 }
  });
  blockedCount.textContent = '0';
  scannedCount.textContent = '0';
});

// Показать/скрыть банковские реквизиты
showBankDetails.addEventListener('click', () => {
  bankDetails.classList.toggle('hidden');
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
  if (changes.whitelist) {
    renderWhitelist(changes.whitelist.newValue || []);
  }
});

// ═══════════════════════════════════════════════════════════════
// WHITELIST
// ═══════════════════════════════════════════════════════════════

// Whitelist текущего сайта
whitelistCurrent.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.url) return;
  
  try {
    const url = new URL(tabs[0].url);
    const domain = url.hostname;
    if (!domain) return;
    
    const response = await chrome.runtime.sendMessage({
      type: 'WHITELIST_CURRENT',
      domain
    });
    
    if (response?.success) {
      whitelistStatus.textContent = `✓ ${domain}`;
      whitelistStatus.classList.remove('hidden');
      setTimeout(() => whitelistStatus.classList.add('hidden'), 3000);
      loadWhitelist();
    }
  } catch (e) {
    console.error('Whitelist error:', e);
  }
});

async function loadWhitelist() {
  const result = await chrome.storage.local.get('whitelist');
  renderWhitelist(result.whitelist || []);
}

async function renderWhitelist(list) {
  const currentLang = await getCurrentLanguage();
  
  whitelistList.innerHTML = '';
  if (list.length === 0) return;
  
  for (const domain of list) {
    const item = document.createElement('div');
    item.className = 'whitelist-item';
    
    const domainSpan = document.createElement('span');
    domainSpan.className = 'domain';
    domainSpan.textContent = domain;
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'whitelist-remove';
    removeBtn.textContent = '×';
    removeBtn.title = currentLang === 'ru' ? 'Удалить' : 'Remove';
    removeBtn.addEventListener('click', async () => {
      const result = await chrome.storage.local.get('whitelist');
      const wl = (result.whitelist || []).filter(d => d !== domain);
      await chrome.storage.local.set({ whitelist: wl });
      
      // Broadcast updated settings
      const settings = {
        enabled: enableFilter.checked,
        sensitivity: parseInt(sensitivity.value),
        categories: { porn: true, sexy: true, hentai: true },
        whitelist: wl
      };
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
        }
      }
      
      loadWhitelist();
    });
    
    item.appendChild(domainSpan);
    item.appendChild(removeBtn);
    whitelistList.appendChild(item);
  }
}

// Инициализация
loadI18nMessages();
loadSettings();
loadWhitelist();
