'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const base = 'chrome-extension://test-extension/park.html';
const clone = value => JSON.parse(JSON.stringify(value));
const parked = number => base + '#' + encodeURIComponent(JSON.stringify({ v: 1, url: `https://linux.do/t/${number}`, title: `Topic ${number}` }));

function harness(preferences = {}) {
  let config = { enabled: true, domains: ['linux.do'], mode: 'preload', preloadLimit: 3, ...preferences };
  let session = {};
  let context;
  let events;
  let failSave = false;
  const tabs = new Map([[1, { id: 1, url: 'https://linux.do/latest', active: true }]]);
  const requests = [];
  const reloads = [];
  const ready = new Set();
  const event = () => ({ listeners: [], addListener(cb) { this.listeners.push(cb); }, emit(...args) { return this.listeners.map(cb => cb(...args)); } });
  function navigate(id, url) {
    const tab = tabs.get(id);
    if (!tab) throw new Error('Tab removed');
    tab.url = url;
    delete tab.pendingUrl;
    ready.delete(id);
    requests.push({ id, url });
    events.updated.emit(id, { url, status: 'loading' }, clone(tab));
  }
  function start() {
    events = Object.fromEntries(['created', 'removed', 'updated', 'replaced', 'message', 'startup', 'installed', 'storage'].map(name => [name, event()]));
    const chrome = {
      runtime: { id: 'test-extension', getURL: file => `chrome-extension://test-extension/${file}`,
        onMessage: events.message, onStartup: events.startup, onInstalled: events.installed,
        async sendMessage(grant) {
          if (!ready.has(grant.tabId)) throw new Error('No receiver');
          const saved = session.queueState?.entries[grant.tabId];
          assert.equal(saved?.kind, grant.kind, 'permission must be saved before navigation');
          if (grant.kind === 'auto' || tabs.get(grant.tabId)?.active) navigate(grant.tabId, grant.url);
          return { ok: true };
        },
      },
      tabs: {
        onCreated: events.created, onRemoved: events.removed, onUpdated: events.updated, onReplaced: events.replaced,
        query: async () => [...tabs.values()].reverse().map(clone),
        get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return clone(tabs.get(id)); },
        reload: async id => { const tab = tabs.get(id); tab.discarded = false; reloads.push(id); },
      },
      storage: {
        onChanged: events.storage,
        local: { get: async defaults => ({ ...defaults, ...config }) },
        session: { get: async () => clone(session), set: async value => {
          if (failSave) { failSave = false; throw new Error('Simulated storage failure'); }
          session = clone(value);
        } },
      },
    };
    context = vm.createContext({ URL, chrome, importScripts(name) { vm.runInContext(source(name), context); } });
    vm.runInContext(source('background.js'), context);
  }
  async function flush() {
    for (let i = 0; i < 100; i++) {
      const current = vm.runInContext('work', context);
      await current;
      if (current === vm.runInContext('work', context)) return;
    }
    throw new Error('Worker did not settle');
  }
  start();
  return {
    tabs, requests, reloads,
    state: () => clone(session.queueState),
    create(number, active = false) {
      const id = number + 100;
      const tab = { id, url: parked(number), active };
      tabs.set(id, tab);
      events.created.emit(clone(tab));
      return id;
    },
    async ready(id, activate = false, overrides = {}) {
      ready.add(id);
      if (activate) { for (const tab of tabs.values()) tab.active = tab.id === id; }
      const tab = tabs.get(id);
      const sender = { id: 'test-extension', url: tab.url, tab: clone(tab), ...overrides };
      const reply = await new Promise(resolve => events.message.emit({ type: activate ? 'park-activate' : 'park-ready', tabId: id }, sender, resolve));
      if (reply.admitted) {
        const saved = session.queueState.entries[id];
        assert.equal(saved.kind, reply.kind);
        if (reply.kind === 'auto' || tab.active) navigate(id, reply.url);
      }
      await flush();
      return reply;
    },
    async close(id) { tabs.delete(id); ready.delete(id); events.removed.emit(id, { isWindowClosing: false }); await flush(); },
    async move(id, url) { navigate(id, url); await flush(); },
    discard(id) { tabs.get(id).discarded = true; ready.delete(id); },
    async configure(value) {
      config = { ...config, ...value };
      events.storage.emit(Object.fromEntries(Object.keys(value).map(key => [key, { newValue: value[key] }])), 'local');
      await flush();
    },
    async restart() { await flush(); start(); },
    failNextSave() { failSave = true; },
    flush,
  };
}

test('ten rapidly created tabs reserve the first three in creation order, independent of tab-strip order', async () => {
  const h = harness();
  const ids = Array.from({ length: 10 }, (_, index) => h.create(index + 1));
  await h.flush();
  await Promise.all(ids.map(id => h.ready(id)));
  assert.deepEqual(h.requests.map(item => item.id).sort(), ids.slice(0, 3));
  assert.equal(Object.values(h.state().entries).filter(entry => entry.kind === 'auto').length, 3);
  assert.equal(h.state().entries[1], undefined, 'source homepage is never counted');
});

test('manual eighth tab leaves all automatic slots intact; only closing an auto tab fills the next FIFO item', async () => {
  const h = harness();
  const ids = Array.from({ length: 10 }, (_, index) => h.create(index + 1));
  await h.flush();
  for (const id of ids) await h.ready(id);
  await h.ready(ids[7], true);
  assert.equal(h.state().entries[ids[7]].kind, 'manual');
  assert.equal(h.requests.length, 4);
  await h.close(ids[7]);
  assert.equal(h.requests.length, 4, 'manual closure does not create another automatic slot');
  await h.close(ids[0]);
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests.at(-1).id, ids[3]);
});

test('same-site navigation retains an automatic slot and leaving the original site releases it', async () => {
  const h = harness({ preloadLimit: 1 });
  const first = h.create(1), next = h.create(2);
  await h.flush();
  await h.ready(first); await h.ready(next);
  await h.move(first, 'https://sub.linux.do/another');
  assert.equal(h.state().entries[first].kind, 'auto');
  assert.equal(h.state().entries[next].kind, null);
  await h.move(first, 'https://example.org/');
  assert.equal(h.state().entries[first], undefined);
  assert.equal(h.state().entries[next].kind, 'auto');
  assert.equal(h.requests.at(-1).id, next);
});

test('worker restart restores reservations and closure fills exactly one slot without reloading existing targets', async () => {
  const h = harness();
  const ids = Array.from({ length: 5 }, (_, index) => h.create(index + 1));
  await h.flush();
  for (const id of ids) await h.ready(id);
  await h.restart();
  await h.close(ids[0]);
  assert.deepEqual(h.requests.map(item => item.id), [ids[0], ids[1], ids[2], ids[3]]);
  assert.equal(Object.values(h.state().entries).filter(entry => entry.kind === 'auto').length, 3);
});

test('worker restart between reservation and local-page readiness does not over-issue permits', async () => {
  const h = harness();
  const ids = Array.from({ length: 8 }, (_, index) => h.create(index + 1));
  await h.flush();
  assert.equal(h.requests.length, 0);
  await h.restart();
  for (const id of [...ids].reverse()) await h.ready(id);
  assert.deepEqual(h.requests.map(item => item.id).sort(), ids.slice(0, 3));
});

test('default lazy mode makes zero automatic requests and manual activation still works', async () => {
  const h = harness({ mode: 'lazy' });
  const ids = [h.create(1), h.create(2)];
  await h.flush();
  for (const id of ids) await h.ready(id);
  assert.equal(h.requests.length, 0);
  await h.ready(ids[1], true);
  assert.deepEqual(h.requests.map(item => item.id), [ids[1]]);
  assert.equal(h.state().entries[ids[1]].kind, 'manual');
});

test('lowering the automatic limit preserves loaded pages and waits until occupancy falls below the new limit', async () => {
  const h = harness();
  const ids = Array.from({ length: 5 }, (_, index) => h.create(index + 1));
  await h.flush();
  for (const id of ids) await h.ready(id);
  await h.configure({ preloadLimit: 1 });
  assert.equal(h.requests.length, 3);
  await h.close(ids[0]); await h.close(ids[1]);
  assert.equal(h.requests.length, 3);
  await h.close(ids[2]);
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests.at(-1).id, ids[3]);
});

test('untrusted page messages cannot obtain a navigation grant', async () => {
  const h = harness({ mode: 'lazy' });
  const id = h.create(1);
  await h.flush();
  assert.equal((await h.ready(id, true, { url: 'https://linux.do/latest' })).ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().entries[id].kind, null);
});

test('failed persistence never releases a navigation grant from unsaved state', async () => {
  const h = harness({ mode: 'lazy' });
  const id = h.create(1);
  await h.flush();
  h.failNextSave();
  const reply = await h.ready(id, true);
  assert.equal(reply.ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().entries[id].kind, null);
  await h.ready(id, true);
  assert.equal(h.requests.length, 1);
});

test('a discarded waiting page is woken locally when its turn arrives even if it never sent ready', async () => {
  const h = harness({ preloadLimit: 1 });
  const first = h.create(1), second = h.create(2);
  await h.flush();
  await h.ready(first);
  h.discard(second);
  await h.close(first);
  assert.deepEqual(h.reloads, [second]);
  assert.equal(h.requests.length, 1, 'waking a placeholder itself does not request the target');
  await h.ready(second);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests.at(-1).id, second);
});

test('switching back to lazy cancels automatic reservations whose target navigation has not begun', async () => {
  const h = harness();
  const first = h.create(1), second = h.create(2);
  await h.flush();
  await h.ready(first);
  await h.configure({ mode: 'lazy' });
  assert.equal(h.state().entries[first].kind, 'auto', 'already loaded page is not unloaded');
  assert.equal(h.state().entries[second].kind, null);
  await h.ready(second);
  assert.equal(h.requests.length, 1);
});

test('a transient initial storage failure preserves creation order when state is retried', async () => {
  const h = harness();
  h.failNextSave();
  const ids = Array.from({ length: 6 }, (_, index) => h.create(index + 1));
  await h.flush();
  for (const id of ids) await h.ready(id);
  assert.deepEqual(h.requests.map(item => item.id), ids.slice(0, 3));
});
