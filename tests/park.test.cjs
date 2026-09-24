'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shared = fs.readFileSync(path.join(__dirname, '../extension/shared.js'), 'utf8');
const park = fs.readFileSync(path.join(__dirname, '../extension/park.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ visibility = 'hidden', active = false, hash, getCurrent, automatic = false, sendMessage } = {}) {
  const listeners = new Map();
  const navigations = [];
  const elements = Object.fromEntries(['title', 'message', 'destination', 'open'].map(id => [id, {
    textContent: '', hidden: true, addEventListener(name, cb) { listeners.set('button:' + name, cb); },
  }]));
  let activeTab = active;
  const document = {
    visibilityState: visibility,
    querySelector(selector) { return elements[selector.slice(1)]; },
    addEventListener(name, cb) { listeners.set(name, cb); },
  };
  const context = vm.createContext({
    URL, document,
    location: { hash: hash ?? '#' + encodeURIComponent(JSON.stringify({ v: 1, url: 'https://linux.do/t/42#post-2', title: '<b>Title</b>' })),
      replace(url) { navigations.push(url); } },
    window: { addEventListener(name, cb) { listeners.set(name, cb); } },
    chrome: { runtime: {
      id: 'test-extension',
      sendMessage: sendMessage || (async request => ({ ok: true, admitted: automatic || request.type === 'park-activate',
        kind: automatic ? 'auto' : 'manual', url: 'https://linux.do/t/42#post-2' })),
      onMessage: { addListener(cb) { listeners.set('runtimeMessage', cb); } },
    }, tabs: {
      getCurrent: getCurrent || (async () => ({ id: 42, active: activeTab })),
      onActivated: { addListener(cb) { listeners.set('onActivated', cb); } },
    } },
  });
  vm.runInContext(shared, context);
  vm.runInContext(park, context);
  await tick();
  return { document, elements, navigations,
    setActive(value) { activeTab = value; },
    async emit(name) { listeners.get(name)?.(); await tick(); },
    async grant(value) { listeners.get('runtimeMessage')?.(value, { id: 'test-extension' }, () => {}); await tick(); },
  };
}

test('background placeholder performs no target navigation and only renders text', async () => {
  const h = await harness();
  assert.deepEqual(h.navigations, []);
  assert.equal(h.elements.title.textContent, '<b>Title</b>');
  assert.equal(h.elements.destination.textContent, 'https://linux.do/t/42#post-2');
  await h.emit('pageshow');
  await h.emit('onActivated');
  assert.deepEqual(h.navigations, []);
});

test('activation navigates exactly once and preserves the destination fragment', async () => {
  const h = await harness();
  h.document.visibilityState = 'visible';
  h.setActive(true);
  await h.emit('visibilitychange');
  await h.emit('focus');
  await h.emit('onActivated');
  assert.deepEqual(h.navigations, ['https://linux.do/t/42#post-2']);
});

test('visible placeholder still waits if Chrome says the tab is inactive', async () => {
  const h = await harness({ visibility: 'visible', active: false });
  assert.deepEqual(h.navigations, []);
  h.setActive(true);
  await h.emit('onActivated');
  assert.equal(h.navigations.length, 1);
});

test('switching away while the active-tab check is pending prevents navigation', async () => {
  let finish;
  const h = await harness({ visibility: 'visible', getCurrent: () => new Promise(resolve => { finish = resolve; }) });
  h.document.visibilityState = 'hidden';
  finish({ id: 42, active: true });
  await tick();
  assert.deepEqual(h.navigations, []);
});

test('automatic grant can load a background page without requiring activation', async () => {
  const h = await harness({ automatic: true });
  assert.deepEqual(h.navigations, ['https://linux.do/t/42#post-2']);
});

test('queue broadcast grants only the matching tab and destination', async () => {
  const h = await harness();
  await h.grant({ type: 'queue-grant', tabId: 99, url: 'https://linux.do/t/42#post-2', kind: 'auto' });
  await h.grant({ type: 'queue-grant', tabId: 42, url: 'https://linux.do/t/wrong', kind: 'auto' });
  assert.deepEqual(h.navigations, []);
  await h.grant({ type: 'queue-grant', tabId: 42, url: 'https://linux.do/t/42#post-2', kind: 'auto' });
  assert.deepEqual(h.navigations, ['https://linux.do/t/42#post-2']);
});

test('manual broadcast never navigates an inactive page', async () => {
  const h = await harness();
  await h.grant({ type: 'queue-grant', tabId: 42, url: 'https://linux.do/t/42#post-2', kind: 'manual' });
  assert.deepEqual(h.navigations, []);
});

test('activation during the initial pending registration is retried after the waiting reply', async () => {
  let finish;
  const h = await harness({ sendMessage: request => request.type === 'park-ready'
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ ok: true, admitted: true, kind: 'manual', url: 'https://linux.do/t/42#post-2' }) });
  h.document.visibilityState = 'visible';
  h.setActive(true);
  await h.emit('visibilitychange');
  finish({ ok: true, admitted: false });
  await tick();
  assert.deepEqual(h.navigations, ['https://linux.do/t/42#post-2']);
});

test('invalid destination data leaves the retry button hidden and never navigates', async () => {
  const h = await harness({ visibility: 'visible', active: true,
    hash: '#' + encodeURIComponent(JSON.stringify({ v: 1, url: 'javascript:alert(1)' })) });
  assert.deepEqual(h.navigations, []);
  assert.equal(h.elements.open.hidden, true);
  assert.equal(h.elements.title.textContent, '链接无效');
});

test('active-tab API failure remains on the local page and offers manual retry', async () => {
  const h = await harness({ visibility: 'visible', getCurrent: async () => { throw new Error('context unavailable'); } });
  assert.deepEqual(h.navigations, []);
  assert.match(h.elements.message.textContent, /重试/);
});
