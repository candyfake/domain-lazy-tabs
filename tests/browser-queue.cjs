/* Real Chromium queue integration tests, using an isolated profile and local HTTP fixture.
 * Native middle-click is exercised. The OS context-menu item / right-click + T is not.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
  .slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
const base = `chrome-extension://${id}/`;
const requests = [];
const results = [];
const verifyDiscard = process.env.QUEUE_TEST_DISCARD === '1';
function record(message) { results.push(message); console.log('PASS: ' + message); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ''}`);
}

(async () => {
  assert.ok(manifest.background?.service_worker, 'queue integration requires a service worker');
  let context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-lazy-tabs-queue-test-'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/target/')) requests.push({ path: url.pathname, url: req.url, at: Date.now() });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') {
      const batch = /^[a-z]+$/.test(url.searchParams.get('batch')) ? url.searchParams.get('batch') : 'test';
      const links = Array.from({ length: 11 }, (_, index) => {
        const n = index + 1;
        return `<p><a id="post-${n}" href="http://localhost:${server.address().port}/target/${batch}/${n}?q=%E4%B8%AD#part">Post ${n} — ${batch}</a></p>`;
      }).join('');
      res.end(`<!doctype html><meta charset="utf-8"><title>Source homepage</title><h1>Source homepage</h1>${links}`);
    } else {
      res.end('<!doctype html><meta charset="utf-8"><title>Loaded target</title><h1>Loaded target</h1>');
    }
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const fixture = `http://localhost:${server.address().port}/`;
  const requestCount = (batch, n) => requests.filter(item => item.path === `/target/${batch}/${n}`).length;
  const batchCounts = (batch, length = 11) => Array.from({ length }, (_, index) => requestCount(batch, index + 1));
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' }),
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      viewport: { width: 1280, height: 900 }
    });
    const options = await context.newPage();
    await options.goto(base + 'options.html');
    await options.waitForFunction(() => !document.querySelector('#save').disabled);
    const source = await context.newPage();
    // Observe Chrome's tab IDs without depending on queue internals or target page permissions.
    await options.evaluate(() => {
      window.__queueTestCreatedIds = [];
      chrome.tabs.onCreated.addListener(tab => window.__queueTestCreatedIds.push(tab.id));
    });

    async function setMode(mode, batch) {
      await options.evaluate(value => chrome.storage.local.set(value), {
        enabled: true, domains: ['localhost'], mode, preloadLimit: 3
      });
      await source.goto(fixture + '?batch=' + batch);
      await source.bringToFront();
      // The storage read occurs asynchronously in the injected document-start script.
      await delay(200);
    }

    async function openPost(batch, n) {
      await source.bringToFront();
      const before = await options.evaluate(() => window.__queueTestCreatedIds.length);
      const newPage = context.waitForEvent('page');
      await source.locator('#post-' + n).click({ button: 'middle' });
      const page = await newPage;
      await options.waitForFunction(length => window.__queueTestCreatedIds.length > length, before);
      const tabId = await options.evaluate(index => window.__queueTestCreatedIds[index], before);
      await eventually(() => page.url().startsWith(base + 'park.html#') || page.url().startsWith(fixture + `target/${batch}/${n}?`), `post ${batch}/${n} opens`);
      return { page, tabId, n, batch };
    }

    async function state() {
      return options.evaluate(async () => (await chrome.storage.session.get('queueState')).queueState);
    }

    async function loaded(batch, n) {
      await eventually(() => requestCount(batch, n) === 1, `post ${batch}/${n} loads exactly once`);
    }

    async function closeTabs(tabs) {
      await source.bringToFront();
      // Remove waiting tabs first so teardown itself cannot cause extra preloads.
      await Promise.all(tabs.filter(tab => !tab.page.isClosed() && tab.page.url().startsWith(base + 'park.html#')).map(tab => tab.page.close()));
      await Promise.all(tabs.filter(tab => !tab.page.isClosed()).map(tab => tab.page.close()));
      await eventually(async () => Object.keys((await state())?.entries || {}).length === 0, 'queue becomes empty after closing the batch');
    }

    await setMode('lazy', 'lazy');
    const lazyTabs = [await openPost('lazy', 1), await openPost('lazy', 2)];
    await delay(1200);
    assert.deepEqual(batchCounts('lazy', 2), [0, 0], 'original on-demand mode makes no target requests');
    assert.equal(await lazyTabs[0].page.title(), 'Post 1 — lazy', 'parked tab preserves the original link title without a prefix');
    const favicon = await lazyTabs[0].page.locator('link[rel="icon"]').first().getAttribute('href');
    assert.ok(new URL(favicon, lazyTabs[0].page.url()).href.startsWith(base + 'icons/'), 'parked tab uses an extension icon');
    await options.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), lazyTabs[0].tabId);
    await loaded('lazy', 1);
    await lazyTabs[0].page.waitForURL('**/target/lazy/1?**');
    assert.equal(new URL(lazyTabs[0].page.url()).search, '?q=%E4%B8%AD');
    assert.equal(new URL(lazyTabs[0].page.url()).hash, '#part');
    assert.equal(requestCount('lazy', 2), 0);
    record('On-demand mode keeps both background targets at zero requests; activation opens only the chosen target and preserves query/hash.');
    record('Parked tab title is the original link text without 待查看; favicon comes from the extension.');
    await closeTabs(lazyTabs);

    await setMode('preload', 'preload');
    const tabs = [];
    for (let n = 1; n <= 10; n++) tabs.push(await openPost('preload', n));
    for (let n = 1; n <= 3; n++) await loaded('preload', n);
    await delay(1600);
    assert.deepEqual(batchCounts('preload', 10), [1, 1, 1, 0, 0, 0, 0, 0, 0, 0], 'only the first three of ten native middle-clicked posts preload');
    const initialState = await state();
    assert.equal(Object.values(initialState.entries).filter(entry => entry.kind === 'auto').length, 3);
    assert.ok(Object.values(initialState.entries).every(entry => entry.url !== source.url()), 'source homepage does not occupy a slot');
    assert.equal(await tabs[3].page.title(), 'Post 4 — preload');
    record('Ten native middle-clicks preload only posts 1–3; posts 4–10 make zero target requests; the homepage does not occupy a slot.');

    await options.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabs[7].tabId);
    await loaded('preload', 8);
    await tabs[7].page.waitForURL('**/target/preload/8?**');
    await delay(400);
    assert.deepEqual(batchCounts('preload', 10), [1, 1, 1, 0, 0, 0, 0, 1, 0, 0]);
    assert.equal(Object.values((await state()).entries).filter(entry => entry.kind === 'auto').length, 3);
    record('Activating waiting post 8 loads it immediately, leaves all three automatic posts intact, and does not consume an automatic slot.');

    await source.bringToFront();
    await tabs[0].page.close();
    await loaded('preload', 4);
    await delay(400);
    assert.deepEqual(batchCounts('preload', 10), [1, 1, 1, 1, 0, 0, 0, 1, 0, 0]);
    await tabs[7].page.close();
    await delay(1200);
    assert.equal(requestCount('preload', 5), 0, 'closing a manually loaded tab must not release an automatic slot');
    record('Closing automatic post 1 fills the slot with post 4; closing manual post 8 does not start post 5.');

    await tabs[1].page.goto(`http://127.0.0.1:${server.address().port}/unmanaged`);
    await loaded('preload', 5);
    await delay(400);
    assert.deepEqual(batchCounts('preload', 10), [1, 1, 1, 1, 1, 0, 0, 1, 0, 0]);
    record('Navigating an automatic tab outside the managed domain releases its slot and starts the next queued post.');

    // Force a genuine service-worker teardown, then wake it from an existing parked page.
    const cdp = await context.newCDPSession(options);
    const workerUrl = base + manifest.background.service_worker;
    const worker = await eventually(() => context.serviceWorkers().find(item => item.url() === workerUrl), 'background worker exists');
    await worker.evaluate(() => { globalThis.__queueIntegrationMarker = true; });
    const workerTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === workerUrl);
    assert.ok(workerTarget, 'service worker has a live DevTools target');
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    // Chromium 151 retains the Playwright Worker and reuses its targetId across
    // restarts. Verify target disappearance plus loss of an in-memory marker.
    await eventually(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === workerTarget.targetId), 'original service worker execution target stops');
    await tabs[5].page.evaluate(async () => chrome.runtime.sendMessage({ type: 'park-ready', tabId: (await chrome.tabs.getCurrent()).id }));
    const replacementWorker = await eventually(() => context.serviceWorkers().find(item => item.url() === workerUrl), 'service worker is available after wake');
    assert.equal(await replacementWorker.evaluate(() => globalThis.__queueIntegrationMarker), undefined, 'worker global state was genuinely discarded');
    tabs.push(await openPost('preload', 11));
    await delay(1200);
    assert.deepEqual(batchCounts('preload'), [1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0], 'worker restart preserves occupied slots and queue order');
    assert.equal(Object.values((await state()).entries).filter(entry => entry.kind === 'auto').length, 3);
    // Optional because tabs.discard terminates the tested Windows headless
    // Chromium 151 process. Queue unit tests separately cover discarded entries.
    if (verifyDiscard) {
      await options.evaluate(tabId => chrome.tabs.discard(tabId), tabs[5].tabId);
      assert.equal(await options.evaluate(async tabId => (await chrome.tabs.get(tabId)).discarded, tabs[5].tabId), true);
      assert.equal(requestCount('preload', 6), 0, 'discarding a waiting placeholder must not visit its target');
    }
    await tabs[2].page.close();
    await loaded('preload', 6);
    await delay(400);
    assert.equal(requestCount('preload', 7), 0);
    assert.equal(requestCount('preload', 11), 0);
    await cdp.detach();
    record('After forced service-worker shutdown/restart, all three slots remain occupied; post 11 waits, and closing post 3 starts post 6 in order.');
    if (verifyDiscard) record('A browser-discarded waiting placeholder resumes and loads its target only after an automatic slot becomes available.');
    await closeTabs(tabs);

    await setMode('preload', 'small');
    const smallTabs = [await openPost('small', 1), await openPost('small', 2)];
    await loaded('small', 1);
    await loaded('small', 2);
    await delay(300);
    assert.deepEqual(batchCounts('small', 2), [1, 1], 'fewer than three posts all preload');
    record('With fewer than three posts, both posts preload.');
    await closeTabs(smallTabs);

    const report = {
      date: new Date().toISOString(), browser: context.browser()?.version(), targetRequests: requests,
      results, discardedPlaceholderTest: verifyDiscard ? 'passed' : 'not run (opt in with QUEUE_TEST_DISCARD=1; this Windows Chromium 151 headless build terminates on tabs.discard)',
      limitation: 'An isolated headless Chromium runs real middle-clicks. This test does not operate the OS native context menu or validate right-click + T.'
    };
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'browser-queue-test-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    // Delete only the freshly generated test profile, never a user browser profile.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('domain-lazy-tabs-queue-test-')) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { console.warn('Temporary browser profile retained because Windows still has a file open: ' + profile); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
