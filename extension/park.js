(function () {
  'use strict';
  const data = DomainLazyTabs.parseParkHash(location.hash);
  const title = document.querySelector('#title');
  const message = document.querySelector('#message');
  const destination = document.querySelector('#destination');
  const open = document.querySelector('#open');
  let navigating = false;
  if (!data) {
    title.textContent = '链接无效';
    message.textContent = '请回到来源网页重新打开链接。';
    return;
  }
  document.title = '待查看 · ' + (data.title || new URL(data.url).hostname);
  title.textContent = data.title || '等待查看';
  destination.textContent = data.url;
  open.hidden = false;
  async function activate() {
    if (navigating || document.visibilityState !== 'visible') return;
    try {
      const tab = await chrome.tabs.getCurrent();
      // getCurrent and reading active do not require the broad "tabs" permission.
      if (!tab?.active || document.visibilityState !== 'visible' || navigating) return;
      navigating = true;
      message.textContent = '正在打开原网页…';
      location.replace(data.url);
    } catch {
      message.textContent = '未能自动打开，请点击下面的按钮重试。';
    }
  }
  document.addEventListener('visibilitychange', activate);
  window.addEventListener('focus', activate);
  window.addEventListener('pageshow', activate);
  chrome.tabs.onActivated.addListener(() => { void activate(); });
  open.addEventListener('click', activate);
  void activate();
})();
