'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sources = ['shared.js', 'content.js'].map(name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(initial = { enabled: true, domains: ['linux.do'] }) {
  const listeners = new Map();
  const timers = [];
  const storageListeners = [];
  let stored = initial;
  class Anchor {
    constructor(href, attrs = {}) {
      this.attrs = new Map(Object.entries({ href, ...attrs }));
      this.textContent = 'A forum topic';
      this.title = '';
    }
    get href() { return new URL(this.getAttribute('href'), 'https://linux.do/latest').href; }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    hasAttribute(name) { return this.attrs.has(name); }
  }
  const context = vm.createContext({
    URL,
    HTMLAnchorElement: Anchor,
    setTimeout(callback) { timers.push(callback); },
    window: { addEventListener(name, callback, capture) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push({ callback, capture });
    } },
    chrome: {
      runtime: { getURL: file => 'chrome-extension://test-extension/' + file },
      storage: {
        local: { get: async defaults => ({ ...defaults, ...stored }) },
        onChanged: { addListener: callback => storageListeners.push(callback) },
      },
    },
  });
  for (const source of sources) vm.runInContext(source, context);
  await tick();
  return {
    Anchor, api: context.DomainLazyTabs, listeners,
    emit(name, anchor, extra = {}) {
      const event = { isTrusted: true, altKey: false, ctrlKey: false, metaKey: false, button: 0,
        composedPath: () => [{ textContent: 'nested element' }, anchor], ...extra };
      for (const { callback } of listeners.get(name) || []) callback(event);
    },
    flushTimers() { while (timers.length) timers.shift()(); },
    async configure(value, area = 'local') {
      stored = { ...stored, ...value };
      const changes = Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }]));
      for (const callback of storageListeners) callback(changes, area);
      await tick();
    },
  };
}

test('native contextmenu is synchronously rewritten before the default action and later restored', async () => {
  const h = await harness();
  const anchor = new h.Anchor('/t/topic/42?x=1#post-4');
  h.emit('contextmenu', anchor);
  const nativeMenuURL = anchor.href; // Simulates Chromium reading href during the same event dispatch.
  assert.ok(nativeMenuURL.startsWith('chrome-extension://test-extension/park.html#'));
  assert.equal(h.api.parseParkHash(new URL(nativeMenuURL).hash).url, 'https://linux.do/t/topic/42?x=1#post-4');
  assert.equal(h.listeners.get('contextmenu')[0].capture, true);
  h.flushTimers();
  assert.equal(anchor.getAttribute('href'), '/t/topic/42?x=1#post-4');
  assert.notEqual(nativeMenuURL, anchor.href, 'the menu keeps its captured URL after DOM restoration');
});

test('ordinary left-click, Alt bypass, non-target domains, downloads, and synthetic events are untouched', async () => {
  const h = await harness();
  for (const [type, href, extra, attrs] of [
    ['click', 'https://linux.do/t/1', {}, {}],
    ['contextmenu', 'https://linux.do/t/1', { altKey: true }, {}],
    ['contextmenu', 'https://example.org/t/1', {}, {}],
    ['contextmenu', 'https://linux.do/t/1', {}, { download: '' }],
    ['contextmenu', 'https://linux.do/t/1', { isTrusted: false }, {}],
  ]) {
    const anchor = new h.Anchor(href, attrs);
    h.emit(type, anchor, extra);
    assert.equal(anchor.getAttribute('href'), href, JSON.stringify({ type, href, extra, attrs }));
    h.flushTimers();
  }
});

test('Ctrl-click, Cmd-click, and middle-click park the target without suppressing the default action', async () => {
  const h = await harness();
  for (const [type, extra] of [['click', { ctrlKey: true }], ['click', { metaKey: true }], ['auxclick', { button: 1 }]]) {
    const anchor = new h.Anchor('https://linux.do/t/1');
    h.emit(type, anchor, extra);
    assert.ok(anchor.href.startsWith('chrome-extension://'), type);
    h.flushTimers();
    assert.equal(anchor.href, 'https://linux.do/t/1');
  }
});

test('storage changes apply the enabled switch and new domains to subsequent links', async () => {
  const h = await harness();
  const oldAnchor = new h.Anchor('https://linux.do/t/1');
  h.emit('contextmenu', oldAnchor);
  await h.configure({ enabled: false });
  assert.equal(oldAnchor.href, 'https://linux.do/t/1', 'settings change restores a pending patch');
  h.emit('contextmenu', oldAnchor);
  assert.equal(oldAnchor.href, 'https://linux.do/t/1');
  await h.configure({ enabled: true, domains: ['example.org'] });
  h.emit('contextmenu', oldAnchor);
  assert.equal(oldAnchor.href, 'https://linux.do/t/1');
  const newAnchor = new h.Anchor('https://example.org/topic');
  h.emit('contextmenu', newAnchor);
  assert.ok(newAnchor.href.startsWith('chrome-extension://'));
  h.flushTimers();
});

test('restoration never overwrites a website concurrent href update', async () => {
  const h = await harness();
  const anchor = new h.Anchor('/t/original/1');
  h.emit('contextmenu', anchor);
  anchor.setAttribute('href', '/t/site-changed/2');
  h.flushTimers();
  assert.equal(anchor.getAttribute('href'), '/t/site-changed/2');
});

test('a second context menu restores the previous link, and pagehide restores the current link', async () => {
  const h = await harness();
  const first = new h.Anchor('/t/first/1');
  const second = new h.Anchor('/t/second/2');
  h.emit('contextmenu', first);
  h.emit('contextmenu', second);
  assert.equal(first.getAttribute('href'), '/t/first/1');
  assert.ok(second.href.startsWith('chrome-extension://'));
  h.emit('pagehide', second);
  assert.equal(second.getAttribute('href'), '/t/second/2');
  h.flushTimers();
});

test('context menus outside an anchor do not throw or modify anything', async () => {
  const h = await harness();
  assert.doesNotThrow(() => h.emit('contextmenu', { textContent: 'ordinary paragraph' }));
});
