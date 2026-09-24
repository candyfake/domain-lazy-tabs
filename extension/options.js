'use strict';
const enabled = document.querySelector('#enabled');
const domains = document.querySelector('#domains');
const mode = document.querySelector('#mode');
const preloadLimit = document.querySelector('#preloadLimit');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
chrome.storage.local.get(DomainLazyTabs.defaults).then(config => {
  config = DomainLazyTabs.normalizeConfig(config);
  enabled.checked = config.enabled;
  domains.value = config.domains.join('\n');
  mode.value = config.mode;
  preloadLimit.value = config.preloadLimit;
  preloadLimit.disabled = mode.value !== 'preload';
  save.disabled = false;
}).catch(() => { status.textContent = '读取失败，请重新打开设置。'; });
mode.addEventListener('change', () => { preloadLimit.disabled = mode.value !== 'preload'; });
save.addEventListener('click', async () => {
  try {
    const list = [...new Set(domains.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(DomainLazyTabs.normalizeDomain))];
    const limit = Number(preloadLimit.value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('自动预加载名额须为 1–10 的整数。');
    await chrome.storage.local.set({ enabled: enabled.checked, domains: list, mode: mode.value, preloadLimit: limit });
    domains.value = list.join('\n');
    status.textContent = '已保存。减少名额不会关闭或卸载已有网页。';
  } catch (error) { status.textContent = error.message || '保存失败。'; }
});
