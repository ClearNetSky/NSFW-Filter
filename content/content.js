// NSFW Filter Content Script — v8.1
// Sends image URLs to background → offscreen for classification
// No canvas, no data URLs — just URLs (offscreen handles loading + inference)
// Images hidden with visibility:hidden until classified
// v8.1: Fixed hide mode, Google/Reddit support, lazy-load, srcset, data-src

(function() {
  'use strict';

  // Guard against extension context invalidation (reload/update)
  let contextValid = true;

  function safeSendMessage(message) {
    if (!contextValid) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(err => {
      const msg = err.message || '';
      if (msg.includes('Extension context invalidated') ||
          msg.includes('message port closed')) {
        contextValid = false;
      }
      return null;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════════

  let settings = {
    enabled: true,
    sensitivity: 50,
    categories: { porn: true, sexy: true, hentai: true }
  };

  // ═══════════════════════════════════════════════════════════════
  // SAFE URL PATTERNS — skip these entirely
  // ═══════════════════════════════════════════════════════════════

  const SAFE_URL_PATTERNS = [
    /\.svg(\?|$)/i,
    /^data:image\/svg/i,
    /^chrome-extension:\/\//i,
    /^moz-extension:\/\//i,
    /favicon/i,
    /\.(gif)(\?|$)/i,
    /^data:image\/gif;base64,.{0,200}$/i,
    /\/sprite[s]?[\-_\.]/i,
  ];

  function isSafeUrl(url) {
    if (!url || url.length === 0) return true;
    // Allow data:image URLs (Google Images thumbnails, etc.)
    if (url.startsWith('data:image/')) {
      if (/^data:image\/svg/i.test(url)) return true;
      if (/^data:image\/gif/i.test(url)) return true;
      // Skip tiny data URLs (likely 1x1 tracking pixels)
      if (url.length < 200) return true;
      return false; // Process jpeg/png/webp data URLs
    }
    if (!url.startsWith('http')) return true;
    return SAFE_URL_PATTERNS.some(pattern => pattern.test(url));
  }

  const MIN_IMAGE_SIZE = 32;

  // ═══════════════════════════════════════════════════════════════
  // CSS INJECTION — hide images before classification
  // ═══════════════════════════════════════════════════════════════

  function injectFilterCSS() {
    if (document.getElementById('nsfw-filter-styles')) return;
    const style = document.createElement('style');
    style.id = 'nsfw-filter-styles';
    style.textContent = `
      img:not([data-nsfw-filter-status]) {
        opacity: 0 !important;
      }
      img[data-nsfw-filter-status="processing"] {
        opacity: 0 !important;
      }
      img[data-nsfw-filter-status="nsfw"] {
        visibility: hidden !important;
      }
      img[data-nsfw-filter-status="sfw"] {
        opacity: 1 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  injectFilterCSS();

  // ═══════════════════════════════════════════════════════════════
  // CLASSIFICATION — send URL to background, get boolean result
  // ═══════════════════════════════════════════════════════════════

  const MAX_RETRIES = 2;
  const RETRY_DELAY = 500;

  async function requestPrediction(url) {
    if (!contextValid) return false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({ url });
        if (response && typeof response.result === 'boolean') {
          return response.result;
        }
        return false;
      } catch (error) {
        const msg = error.message || '';

        if (msg.includes('Extension context invalidated')) {
          contextValid = false;
          return false;
        }

        const isDisconnect = msg.includes('disconnected') ||
          msg.includes('Receiving end does not exist') ||
          msg.includes('message port closed');

        if (isDisconnect && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // IMAGE ANALYSIS — core function
  // ═══════════════════════════════════════════════════════════════

  function isValidImageUrl(url) {
    return url && (url.startsWith('http') || url.startsWith('data:image/'));
  }

  function getImageUrl(image) {
    // Try currentSrc first (resolved srcset/picture source)
    if (isValidImageUrl(image.currentSrc)) return image.currentSrc;
    // Try src
    if (isValidImageUrl(image.src)) return image.src;
    // Try srcset (extract first http URL)
    if (image.srcset) {
      const match = image.srcset.match(/https?:\/\/[^\s,]+/);
      if (match) return match[0];
    }
    // Try data-src (lazy loading - various frameworks)
    const lazySrc = image.dataset.src || image.dataset.lazySrc ||
                    image.dataset.original || image.dataset.originalSrc ||
                    image.getAttribute('data-lazy');
    if (isValidImageUrl(lazySrc)) return lazySrc;
    return null;
  }

  function analyzeImage(image, isSrcChange) {
    if (!settings.enabled || !contextValid) {
      // Filter disabled — mark as safe so images are visible
      if (!image.dataset.nsfwFilterStatus) image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    const imageIsNotAnalyzed = isSrcChange || image.dataset.nsfwFilterStatus === undefined;
    if (!imageIsNotAnalyzed) return;

    // Get the actual image URL (handles srcset, lazy-load, etc.)
    const url = getImageUrl(image);
    if (!url || isSafeUrl(url)) {
      image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    // Check size — but allow 0x0 (not yet rendered)
    const w = image.naturalWidth || image.width || image.offsetWidth;
    const h = image.naturalHeight || image.height || image.offsetHeight;
    if (w > 0 && w < MIN_IMAGE_SIZE && h > 0 && h < MIN_IMAGE_SIZE) {
      image.dataset.nsfwFilterStatus = 'sfw';
      return;
    }

    // Mark as processing — CSS rule hides it
    image.dataset.nsfwFilterStatus = 'processing';

    requestPrediction(url)
      .then(isNSFW => {
        if (isNSFW) {
          image.dataset.nsfwFilterStatus = 'nsfw';
          // Also set inline style in case CSS rule gets overridden
          image.style.setProperty('visibility', 'hidden', 'important');
          updateStats(1, 1);
        } else {
          showImage(image, url);
          updateStats(0, 1);
        }
      })
      .catch(() => {
        showImage(image, url);
      });
  }

  // ═══════════════════════════════════════════════════════════════
  // IMAGE SHOW — only for safe images
  // ═══════════════════════════════════════════════════════════════

  function showImage(image, url) {
    // Only show if the image URL hasn't changed since analysis started
    const currentUrl = getImageUrl(image);
    if (currentUrl === url || !currentUrl) {
      image.dataset.nsfwFilterStatus = 'sfw';
      image.style.opacity = '';
      image.style.visibility = '';
      if (image.parentNode?.nodeName === 'BODY') image.hidden = false;
    }
  }

  // Re-apply hide if external code changes the style
  function checkStyleMutation(image) {
    if (image.dataset.nsfwFilterStatus !== 'nsfw') return;
    image.style.setProperty('visibility', 'hidden', 'important');
  }

  // ═══════════════════════════════════════════════════════════════
  // STATISTICS (debounced)
  // ═══════════════════════════════════════════════════════════════

  let statsBuffer = { blocked: 0, scanned: 0 };
  let statsTimeout = null;

  function updateStats(blocked, scanned) {
    statsBuffer.blocked += blocked;
    statsBuffer.scanned += scanned;

    if (!statsTimeout) {
      statsTimeout = setTimeout(() => {
        safeSendMessage({
          type: 'UPDATE_STATS',
          blocked: statsBuffer.blocked,
          scanned: statsBuffer.scanned
        });
        statsBuffer = { blocked: 0, scanned: 0 };
        statsTimeout = null;
      }, 2000);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM WATCHER — MutationObserver
  // ═══════════════════════════════════════════════════════════════

  function findAndCheckAllImages(root) {
    if (!root || !root.getElementsByTagName) return;
    const images = root.getElementsByTagName('img');
    for (let i = 0; i < images.length; i++) {
      analyzeImage(images[i], false);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled || !contextValid) return;

    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];

      if (mutation.type === 'childList') {
        for (let j = 0; j < mutation.addedNodes.length; j++) {
          const node = mutation.addedNodes[j];
          if (node.nodeType !== 1) continue; // Only element nodes

          if (node.nodeName === 'IMG') {
            analyzeImage(node, false);
          } else if (node.getElementsByTagName) {
            findAndCheckAllImages(node);
          }
        }
      } else if (mutation.type === 'attributes' && mutation.target.nodeName === 'IMG') {
        const target = mutation.target;
        const attr = mutation.attributeName;

        if (attr === 'style') {
          checkStyleMutation(target);
        } else if (attr === 'src') {
          // src changed — re-analyze
          if (target.dataset.nsfwFilterStatus !== 'nsfw') {
            delete target.dataset.nsfwFilterStatus;
            analyzeImage(target, true);
          }
        } else if (['data-src', 'data-lazy-src', 'data-original', 'srcset'].includes(attr)) {
          // Lazy-load attribute changed — analyze if not already done
          if (!target.dataset.nsfwFilterStatus) {
            analyzeImage(target, false);
          }
        }
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SETTINGS UPDATES
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SETTINGS_UPDATED') {
      const wasEnabled = settings.enabled;
      settings = message.settings;

      if (!settings.enabled) {
        // Unblock all images — mark as sfw so CSS shows them
        document.querySelectorAll('img').forEach(img => {
          img.dataset.nsfwFilterStatus = 'sfw';
          img.style.visibility = '';
          img.style.opacity = '';
          if (img.parentNode?.nodeName === 'BODY') img.hidden = false;
        });
      } else if (!wasEnabled) {
        // Re-enable: reset all statuses and re-scan
        document.querySelectorAll('img[data-nsfw-filter-status]').forEach(img => {
          delete img.dataset.nsfwFilterStatus;
        });
        findAndCheckAllImages(document.documentElement);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  async function init() {
    if (!contextValid) return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response) settings = response;
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        contextValid = false;
        return;
      }
    }

    if (!settings.enabled) return;

    // Start observing DOM mutations
    observer.observe(document, {
      characterData: false,
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'style', 'data-src', 'data-lazy-src', 'data-original', 'srcset']
    });

    // Scan existing images
    findAndCheckAllImages(document.documentElement);

    console.log('NSFW Filter v8.1: Initialized (WebGPU, URL-based, no sandbox)');
  }

  // Run at document_start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
