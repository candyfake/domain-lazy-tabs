'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/shared.js'), 'utf8'), context);
const api = context.DomainLazyTabs;

test('domain normalization accepts pasted origins, IDNs, case, and trailing dots', () => {
  assert.equal(api.normalizeDomain(' LINUX.DO '), 'linux.do');
  assert.equal(api.normalizeDomain('https://Linux.Do/'), 'linux.do');
  assert.equal(api.normalizeDomain('linux.do.'), 'linux.do');
  assert.equal(api.normalizeDomain('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
});

test('domain normalization rejects credentials, paths, queries, non-HTTP schemes, and wildcards', () => {
  for (const value of ['', '*.linux.do', 'lin ux.do', 'https://user:pass@linux.do',
    'linux.do/topic/1', 'linux.do?x=1', 'linux.do#anchor', 'linux.do:8080',
    'ftp://linux.do', '-linux.do', 'linux-.do', 'linux..do']) {
    assert.throws(() => api.normalizeDomain(value), undefined, value);
  }
});

test('matching respects domain boundaries and includes subdomains', () => {
  for (const value of ['https://linux.do/t/1', 'http://www.linux.do/t/1', 'https://deep.sub.linux.do',
    'https://LINUX.DO./t/1', 'https://linux.do:8443/t/1']) {
    assert.equal(api.matches(value, ['linux.do']), true, value);
  }
  for (const value of ['https://evillinux.do', 'https://linux.do.evil.example',
    'https://not-linux.do', 'https://example.org/?next=https://linux.do',
    'https://linux.do@evil.example', 'chrome-extension://abc/park.html']) {
    assert.equal(api.matches(value, ['linux.do']), false, value);
  }
  assert.equal(api.matches('https://linux.do', []), false);
});

test('target URLs reject executable schemes, local files, malformed URLs, and credentials', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/test.txt',
    'chrome://extensions', 'about:blank', '/relative', 'not a URL',
    'https://user:pass@linux.do/t/1']) {
    assert.equal(api.safeUrl(value), null, value);
  }
  assert.equal(api.safeUrl('https://linux.do/t/1?x=%23&y=2#post-3'), 'https://linux.do/t/1?x=%23&y=2#post-3');
});

test('parking round-trips URL query, fragment, Unicode title, and special characters', () => {
  const url = 'https://linux.do/t/%E6%B5%8B%E8%AF%95/42?x=%23&a=1&b=a%26b#post-9';
  const title = '测试 <script>alert(1)</script> & "quote"';
  const parked = api.makeParkUrl('chrome-extension://test/park.html', url, title);
  assert.ok(parked.startsWith('chrome-extension://test/park.html#'));
  const decoded = api.parseParkHash(new URL(parked).hash);
  assert.equal(decoded.url, url);
  assert.equal(decoded.title, title);
  assert.equal(api.makeParkUrl('chrome-extension://test/park.html', 'javascript:alert(1)', title), null);
});

test('park payload parsing rejects malformed or unsafe data and bounds title size', () => {
  for (const value of ['#', '#%', '#not-json', '#' + encodeURIComponent('null'),
    '#' + encodeURIComponent(JSON.stringify({ v: 2, url: 'https://linux.do' })),
    '#' + encodeURIComponent(JSON.stringify({ v: 1, url: 'javascript:alert(1)' })),
    '#' + encodeURIComponent(JSON.stringify({ v: 1, url: 'https://user@linux.do' }))]) {
    assert.equal(api.parseParkHash(value), null, value);
  }
  const value = api.parseParkHash('#' + encodeURIComponent(JSON.stringify({ v: 1, url: 'https://linux.do', title: 'x'.repeat(500) })));
  assert.equal(value.title.length, 200);
});
