/* Real Chromium integration test. Uses an isolated temporary profile and a local HTTP server. */
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  let context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-lazy-tabs-test-'));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/target')) requests.push(req.url);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/') {
      res.end(`<!doctype html><html><body><h1>Local test fixture</h1>
        <a id="managed" href="http://localhost:${server.address().port}/target?x=1&y=%E4%B8%AD#part">Managed target 中文</a><br>
        <a id="other" href="http://127.0.0.1:${server.address().port}/target-other">Unmanaged target</a>
        <script>document.addEventListener('contextmenu', e => {
          window.capturedContextUrl = e.target.closest('a')?.href;
        });</script></body></html>`);
    } else res.end('<!doctype html><title>Loaded target</title><h1>Target loaded</h1>');
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const fixture = `http://localhost:${server.address().port}/`;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' }),
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      viewport: { width: 1280, height: 800 }
    });
    const options = await context.newPage();
    await options.goto(base + 'options.html');
    await options.locator('#save').waitFor({state:'visible'});
    await options.waitForFunction(() => !document.querySelector('#save').disabled);
    await options.locator('#domains').fill('localhost');
    await options.locator('#save').click();
    await options.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
    const page = await context.newPage();
    await page.goto(fixture);
    await page.bringToFront();
    // Confirm the actual injected content script sees the persisted configuration.
    await delay(150);
    await page.locator('#managed').click({button:'right'});
    const captured = await page.evaluate(() => window.capturedContextUrl);
    assert.ok(captured.startsWith(base + 'park.html#'), 'native contextmenu event exposes the parked href before default handling');
    await page.keyboard.press('Escape');
    await delay(20);
    assert.equal(await page.locator('#managed').getAttribute('href'), fixture + 'target?x=1&y=%E4%B8%AD#part');
    assert.equal(requests.length, 0);
    results.push('Trusted right-click synchronously exposes parked URL; DOM link restored; no target request');

    // Headless Chromium has no native context-menu UI. Create a background tab with the
    // exact URL captured by the trusted contextmenu event; separately test native Ctrl/middle clicks.
    const waiting = context.waitForEvent('page');
    const created = await options.evaluate(url => chrome.tabs.create({url,active:false}), captured);
    const parked = await waiting;
    await parked.waitForURL(base + 'park.html#**');
    await delay(2000);
    assert.equal(requests.length, 0, 'target must have zero requests while backgrounded');
    // Some headless builds report all documents as visible; tab.active is the authoritative second guard.
    assert.equal(await parked.evaluate(async () => (await chrome.tabs.getCurrent()).active), false);
    results.push('Background tab with exact context-menu URL: target requests = 0 after 2 seconds');
    await options.evaluate(id => chrome.tabs.update(id,{active:true}), created.id);
    await parked.waitForURL('**/target?**');
    assert.equal(requests.length, 1);
    assert.equal(new URL(parked.url()).hash, '#part');
    assert.equal(new URL(parked.url()).search, '?x=1&y=%E4%B8%AD');
    results.push('Activation loads target once and preserves query/hash');
    await parked.close();

    async function backgroundClick(clickOptions) {
      await page.bringToFront();
      const count = requests.length;
      const next = context.waitForEvent('page');
      await page.locator('#managed').click(clickOptions);
      const child = await next;
      await child.waitForURL(base + 'park.html#**');
      await delay(400);
      assert.equal(requests.length, count);
      return child;
    }
    let child = await backgroundClick({modifiers:[process.platform === 'darwin' ? 'Meta' : 'Control']});
    await child.close();
    child = await backgroundClick({button:'middle'});
    await child.close();
    results.push('Real native Ctrl-click and middle-click keep target request count unchanged');

    const batch = [];
    const beforeBatch = requests.length;
    for (let i=0;i<10;i++) batch.push(await backgroundClick({button:'middle'}));
    await delay(1000);
    assert.equal(requests.length,beforeBatch);
    for (const tab of batch) await tab.close();
    results.push('10 background target tabs: zero new target requests');

    await page.bringToFront();
    await page.locator('#managed').click({button:'right',modifiers:['Alt']});
    assert.equal(await page.evaluate(() => window.capturedContextUrl), fixture + 'target?x=1&y=%E4%B8%AD#part');
    await page.keyboard.press('Escape');
    results.push('Alt-right-click preserves original target');

    const next = context.waitForEvent('page');
    const count = requests.length;
    await page.locator('#other').click({button:'middle'});
    const other = await next;
    await other.waitForURL('**/target-other');
    assert.equal(requests.length,count+1);
    await other.close();
    results.push('Unmanaged domain loads normally in background');

    await page.bringToFront();
    await page.locator('#managed').click();
    await page.waitForURL('**/target?**');
    results.push('Ordinary left click navigates normally');

    await options.bringToFront();
    await options.locator('#domains').fill('linux.do');
    await options.locator('#save').click();
    await options.screenshot({path:path.join(root,'artifacts','settings.png'),fullPage:true});
    const report={date:new Date().toISOString(),browser:context.browser()?.version(),targetRequests:requests,results,
      limitation:'Headless tests inspect the trusted contextmenu href and create a background tab from that exact URL. The OS native context-menu item itself is not clicked.'};
    fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
    fs.writeFileSync(path.join(root,'artifacts','browser-test-results.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally {
    await context?.close();
    await new Promise(resolve=>server.close(resolve));
    // This is the freshly created temporary test profile, never the user's browser profile.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('domain-lazy-tabs-test-'))
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
