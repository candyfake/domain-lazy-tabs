/* Shared pure helpers. No dependencies and no network access. */
(function (root) {
  'use strict';
  const defaults = { enabled: true, domains: ['linux.do'], mode: 'lazy', preloadLimit: 3 };
  function normalizeConfig(value = {}) {
    return {
      enabled: value.enabled !== false,
      domains: Array.isArray(value.domains) ? value.domains.filter(domain => typeof domain === 'string') : [...defaults.domains],
      mode: value.mode === 'preload' ? 'preload' : 'lazy',
      preloadLimit: Math.max(1, Math.min(10, Math.trunc(Number(value.preloadLimit)) || defaults.preloadLimit)),
    };
  }
  function normalizeDomain(value) {
    const input = String(value).trim();
    if (!input || /[\s*]/.test(input)) throw new Error('域名不能包含空格或通配符。');
    const url = new URL(input.includes('://') ? input : 'https://' + input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('只填写域名，例如 linux.do，不要填写帖子路径或端口。');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some(p => !p || p.startsWith('-') || p.endsWith('-')))
      throw new Error('无效的域名。');
    return host;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function matches(value, domains) {
    const safe = safeUrl(value);
    if (!safe) return false;
    const host = new URL(safe).hostname.toLowerCase().replace(/\.$/, '');
    return domains.some(domain => host === domain || host.endsWith('.' + domain));
  }
  function makeParkUrl(base, url, title) {
    if (!safeUrl(url)) return null;
    return base + '#' + encodeURIComponent(JSON.stringify({ v: 1, url: safeUrl(url), title: String(title || '').slice(0, 200) }));
  }
  function parseParkHash(hash) {
    try {
      const data = JSON.parse(decodeURIComponent(hash.replace(/^#/, '')));
      const url = safeUrl(data.url);
      return data.v === 1 && url ? { url, title: String(data.title || '').slice(0, 200) } : null;
    } catch { return null; }
  }
  root.DomainLazyTabs = { defaults, normalizeConfig, normalizeDomain, safeUrl, matches, makeParkUrl, parseParkHash };
})(typeof globalThis === 'object' ? globalThis : this);
