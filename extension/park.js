(function () {
  'use strict';
  const data = DomainLazyTabs.parseParkHash(location.hash);
  const title = document.querySelector('#title');
  const message = document.querySelector('#message');
  const destination = document.querySelector('#destination');
  const open = document.querySelector('#open');
  let navigating = false;
  let tabId;
  let requesting = false;
  let retryRequested = false;
  if (!data) {
    title.textContent = '链接无效';
    message.textContent = '请回到来源网页重新打开链接。';
    return;
  }
  document.title = data.title || new URL(data.url).hostname;
  title.textContent = data.title || '等待查看';
  destination.textContent = data.url;
  open.hidden = false;
  async function acceptGrant(grant) {
    if (navigating || !grant?.admitted || grant.url !== data.url ||
        DomainLazyTabs.parseParkHash(location.hash)?.url !== data.url) return;
    if (grant.kind !== 'auto') {
      if (document.visibilityState !== 'visible') return;
      const tab = await chrome.tabs.getCurrent();
      if (!tab?.active || document.visibilityState !== 'visible' || navigating) return;
    }
    if (navigating) return;
    navigating = true;
    message.textContent = '正在打开原网页…';
    location.replace(data.url);
  }
  async function register() {
    if (navigating) return;
    if (requesting) { retryRequested = true; return; }
    requesting = true;
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id == null || navigating) return;
      tabId = tab.id;
      const active = tab.active && document.visibilityState === 'visible';
      const grant = await chrome.runtime.sendMessage({ type: active ? 'park-activate' : 'park-ready', tabId });
      if (!grant?.ok) throw new Error('Queue unavailable');
      await acceptGrant(grant);
      if (!grant.admitted) message.textContent = '切换到此标签页即打开；启用提前加载时，会在自动名额空出后依次打开。';
    } catch {
      message.textContent = '未能自动打开，请点击下面的按钮重试。';
    } finally {
      requesting = false;
      // An activation can arrive while the initial background registration awaits
      // the worker. Do not lose that activation when the first reply says wait.
      if (retryRequested) { retryRequested = false; void register(); }
    }
  }
  chrome.runtime.onMessage.addListener((grant, sender, respond) => {
    if (sender.id !== chrome.runtime.id || grant?.type !== 'queue-grant' || grant.tabId !== tabId || grant.url !== data.url) return false;
    acceptGrant({ ...grant, admitted: true }).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void register(); });
  window.addEventListener('focus', register);
  window.addEventListener('pageshow', register);
  chrome.tabs.onActivated.addListener(() => { if (document.visibilityState === 'visible') void register(); });
  open.addEventListener('click', register);
  void register();
})();
