'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shared = fs.readFileSync(path.join(__dirname, '../extension/shared.js'), 'utf8');
const park = fs.readFileSync(path.join(__dirname, '../extension/park.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ visibility = 'hidden', active = false, hash, getCurrent } = {}) {
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
    chrome: { tabs: {
      getCurrent: getCurrent || (async () => ({ active: activeTab })),
      onActivated: { addListener(cb) { listeners.set('onActivated', cb); } },
    } },
  });
  vm.runInContext(shared, context);
  vm.runInContext(park, context);
  await tick();
  return { document, elements, navigations,
    setActive(value) { activeTab = value; },
    async emit(name) { listeners.get(name)?.(); await tick(); },
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
  finish({ active: true });
  await tick();
  assert.deepEqual(h.navigations, []);
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
