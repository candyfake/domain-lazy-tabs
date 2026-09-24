/* Event-driven queue. No polling, page discarding, or service-worker keepalive. */
'use strict';
importScripts('shared.js');

const api = DomainLazyTabs;
const parkBase = chrome.runtime.getURL('park.html');
let state;
let config;
let work = Promise.resolve();
const createdTabs = [];

function parkedData(url) {
  if (typeof url !== 'string' || !url.startsWith(parkBase + '#')) return null;
  return api.parseParkHash(url.slice(parkBase.length));
}
function freshState() { return { version: 1, nextOrder: 1, births: {}, entries: {} }; }
function scopeFor(url) {
  return config.domains.filter(domain => api.matches(url, [domain])).sort((a, b) => b.length - a.length)[0] || null;
}
async function initialize() {
  if (state) return;
  const [saved, preferences] = await Promise.all([
    chrome.storage.session.get('queueState'),
    chrome.storage.local.get(api.defaults),
  ]);
  const value = saved.queueState;
  state = value?.version === 1 && value.entries && value.births && Number.isSafeInteger(value.nextOrder) ? value : freshState();
  config = api.normalizeConfig(preferences);
}
function birth(tabId) {
  if (!state.births[tabId]) state.births[tabId] = state.nextOrder++;
  return state.births[tabId];
}
function forget(tabId) {
  delete state.entries[tabId];
  delete state.births[tabId];
}
function reconcile(tabs) {
  const live = new Set(tabs.map(tab => String(tab.id)));
  for (const id of Object.keys(state.births)) if (!live.has(id)) forget(id);
  for (const id of Object.keys(state.entries)) if (!live.has(id)) forget(id);
  for (const tab of tabs) {
    const current = tab.pendingUrl || tab.url;
    const data = parkedData(current);
    let entry = state.entries[tab.id];
    if (data) {
      if (!entry || entry.url !== data.url) {
        const scope = scopeFor(data.url);
        entry = state.entries[tab.id] = {
          tabId: tab.id, url: data.url, title: data.title, scope,
          order: birth(tab.id), kind: null, ready: false,
        };
      }
      if (entry.kind === 'auto' && (!config.enabled || config.mode !== 'preload' || !api.matches(entry.url, config.domains))) {
        entry.kind = null;
      }
    } else if (entry) {
      // A started target keeps its slot through reloads and same-site navigation.
      // A queued tab navigated elsewhere must never later be redirected by the queue.
      if (!entry.kind || !entry.scope || (current && !api.matches(current, [entry.scope]))) {
        delete state.entries[tab.id];
      } else if (current) {
        entry.ready = false;
      }
    }
  }
}
function allocate(tabs) {
  if (!config.enabled || config.mode !== 'preload') return;
  let occupied = Object.values(state.entries).filter(entry => entry.kind === 'auto').length;
  const current = new Map(tabs.map(tab => [tab.id, tab]));
  const queued = Object.values(state.entries).filter(entry => !entry.kind).sort((a, b) => a.order - b.order);
  for (const entry of queued) {
    if (occupied >= config.preloadLimit) break;
    const tab = current.get(entry.tabId);
    if (!tab || !parkedData(tab.pendingUrl || tab.url) || !api.matches(entry.url, config.domains)) continue;
    entry.kind = 'auto';
    entry.scope ||= scopeFor(entry.url);
    occupied++;
  }
}
async function deliver(skipTabId) {
  for (const entry of Object.values(state.entries)) {
    if (!entry.kind || entry.tabId === skipTabId) continue;
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      if (parkedData(tab.pendingUrl || tab.url)?.url !== entry.url) continue;
      if (tab.discarded && entry.kind === 'auto') {
        // Wake only the local placeholder; it will register before visiting the target.
        await chrome.tabs.reload(entry.tabId);
        continue;
      }
      if (!entry.ready) continue;
      // Extension-page messages are sent through runtime, not tabs.sendMessage.
      // Each local waiting page accepts only its own id and original destination.
      await chrome.runtime.sendMessage({ type: 'queue-grant', tabId: entry.tabId, url: entry.url, kind: entry.kind });
    } catch {
      // A newly-created or discarded local page may not have a receiver yet.
      // Its ready/pageshow event will retry. Keep the reservation to avoid over-issuing.
    }
  }
}
function enqueue(action = async () => ({})) {
  const task = work.then(async () => {
    await initialize();
    const details = await action();
    const tabs = await chrome.tabs.query({});
    // Flush creation events before inspecting the tab strip: tab-strip order can
    // differ from creation order when Chrome inserts each child next to its opener.
    const pendingBirths = createdTabs.slice();
    for (const tabId of pendingBirths) birth(tabId);
    reconcile(tabs);
    let reply = { ok: true };
    if (details.message) {
      const { message, sender } = details;
      const tabId = sender.tab?.id ?? message.tabId;
      const tab = tabs.find(item => item.id === tabId);
      const entry = state.entries[tabId];
      const senderData = parkedData(sender.url);
      if (sender.id !== chrome.runtime.id || !senderData || !entry ||
          senderData.url !== entry.url || parkedData(tab?.pendingUrl || tab?.url)?.url !== entry.url ||
          (sender.tab && message.tabId !== sender.tab.id)) return { ok: false };
      entry.ready = true;
      if (message.type === 'park-activate' && tab.active && !entry.kind) entry.kind = 'manual';
      details.skipTabId = tabId;
      reply = { ok: true, tabId };
    }
    allocate(tabs);
    // Reservation is durable BEFORE any page is told to navigate.
    await chrome.storage.session.set({ queueState: state });
    createdTabs.splice(0, pendingBirths.length);
    if (reply.tabId != null) {
      const entry = state.entries[reply.tabId];
      reply = { ok: true, admitted: !!entry?.kind, url: entry?.url, kind: entry?.kind || null };
    }
    await deliver(details.skipTabId);
    return reply;
  });
  work = task.catch(() => {
    // Re-read durable state after API/storage failure; never admit using unsaved state.
    state = undefined;
    config = undefined;
  });
  return task;
}
function run(action) { void enqueue(action).catch(() => {}); }

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['park-ready', 'park-activate'].includes(message?.type)) return false;
  enqueue(async () => ({ message, sender })).then(respond, () => respond({ ok: false }));
  return true;
});
chrome.tabs.onCreated.addListener(tab => { createdTabs.push(tab.id); run(); });
chrome.tabs.onRemoved.addListener(tabId => run(async () => { forget(tabId); return {}; }));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'loading' || change.discarded === false) run();
});
chrome.tabs.onReplaced.addListener((added, removed) => run(async () => {
  const entry = state.entries[removed];
  const order = state.births[removed];
  forget(removed);
  if (order) state.births[added] = order;
  if (entry) state.entries[added] = { ...entry, tabId: added };
  return {};
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(api.defaults).some(key => key in changes)) return;
  run(async () => { config = api.normalizeConfig(await chrome.storage.local.get(api.defaults)); return {}; });
});
chrome.runtime.onStartup.addListener(() => run());
chrome.runtime.onInstalled.addListener(() => run());
