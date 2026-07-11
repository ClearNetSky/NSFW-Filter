// NSFW Filter — MAIN world script (контекст страницы)
// Закрытые (closed) shadow roots недоступны content script'ам через
// element.shadowRoot. Патчим attachShadow, чтобы все shadow roots
// создавались открытыми, и шлём событие — изолированный content script
// сразу сканирует новый root. Та же техника, что у Dark Reader.
//
// Побочный эффект: страница тоже видит root открытым (сайты крайне
// редко полагаются на закрытость — обычно это просто инкапсуляция).

(function() {
  'use strict';

  if (!Element.prototype.attachShadow || Element.prototype.attachShadow.__nsfwFilterPatched) {
    return;
  }

  const originalAttachShadow = Element.prototype.attachShadow;

  function attachShadow(init) {
    const options = Object.assign({}, init, { mode: 'open' });
    const root = originalAttachShadow.call(this, options);
    try {
      // bubbles + composed: событие доходит до document даже из вложенных
      // shadow trees. Если элемент ещё не в DOM — не страшно: content
      // script найдёт root при вставке (childList) или пересканом
      this.dispatchEvent(new Event('__nsfw_filter_shadow_attached__', {
        bubbles: true,
        composed: true
      }));
    } catch (e) { /* не мешаем странице */ }
    return root;
  }

  attachShadow.__nsfwFilterPatched = true;
  Element.prototype.attachShadow = attachShadow;
})();
