(function () {
  'use strict';
  const api = globalThis.DomainLazyTabs;
  const parkBase = chrome.runtime.getURL('park.html');
  let config = null;
  let patched = null;

  function restore() {
    if (!patched) return;
    const { anchor, original, parked } = patched;
    // Do not overwrite a concurrent update made by the website.
    if (anchor.getAttribute('href') === parked) anchor.setAttribute('href', original);
    patched = null;
  }
  function readConfig() {
    chrome.storage.local.get(api.defaults).then(value => { config = value; }).catch(() => { config = null; });
  }
  readConfig();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.enabled || changes.domains)) { restore(); readConfig(); }
  });

  function findAnchor(event) {
    return event.composedPath().find(node => node instanceof HTMLAnchorElement && node.hasAttribute('href'));
  }
  function patch(event) {
    restore();
    if (!event.isTrusted || event.altKey || !config?.enabled) return;
    const anchor = findAnchor(event);
    if (!anchor || anchor.hasAttribute('download') || !api.matches(anchor.href, config.domains)) return;
    const original = anchor.getAttribute('href');
    const parked = api.makeParkUrl(parkBase, anchor.href, anchor.textContent.trim() || anchor.title);
    if (!parked) return;
    anchor.setAttribute('href', parked);
    patched = { anchor, original, parked };
    // Chromium caches the URL when it builds the native menu / performs the default click action.
    // Restore in the next task; never await before the default browser action.
    setTimeout(restore, 0);
  }

  // Alter only the link's URL; leave the native context menu intact.
  window.addEventListener('contextmenu', patch, true);
  window.addEventListener('click', event => {
    if (event.button === 0 && (event.ctrlKey || event.metaKey)) patch(event);
  }, true);
  window.addEventListener('auxclick', event => { if (event.button === 1) patch(event); }, true);
  window.addEventListener('pagehide', restore, true);
})();
