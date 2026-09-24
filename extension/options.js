'use strict';
const enabled = document.querySelector('#enabled');
const domains = document.querySelector('#domains');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
chrome.storage.local.get(DomainLazyTabs.defaults).then(config => {
  enabled.checked = config.enabled;
  domains.value = config.domains.join('\n');
  save.disabled = false;
}).catch(() => { status.textContent = '读取失败，请重新打开设置。'; });
save.addEventListener('click', async () => {
  try {
    const list = [...new Set(domains.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(DomainLazyTabs.normalizeDomain))];
    await chrome.storage.local.set({ enabled: enabled.checked, domains: list });
    domains.value = list.join('\n');
    status.textContent = '已保存，对之后打开的链接生效。';
  } catch (error) { status.textContent = error.message || '保存失败。'; }
});
