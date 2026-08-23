// Same as _webkit-poker.mjs but through the SHELL at /poker, so the iframe
// wiring is exercised too: src, box size, and the inner document contents.
import { createRequire } from 'node:module';
const require = createRequire('D:/Рабочий стол/ShinyLuck/package.json');
const { webkit, devices } = require('playwright');
const OUT = 'C:/TEMP/claude/D---------------ShinyLuck/9db58a06-8fc5-40d7-8783-23f4785eb2dd/scratchpad/shots';
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 300)));
page.on('requestfailed', r => console.log('  [FAILED]', r.url().slice(0, 110), r.failure()?.errorText));
page.on('response', r => { if (r.status() >= 400) console.log('  [HTTP ' + r.status() + ']', r.url().slice(0, 110)); });
page.on('frameattached', f => console.log('  [frame attached]'));
page.on('framenavigated', f => console.log('  [frame ->]', f.url().slice(0, 90)));

console.log('--- the shell at /poker, iPhone WebKit ---');
await page.goto('https://shinyluck.win/poker', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(25000);
const r = await page.evaluate(() => {
  const f = document.getElementById('poker-frame');
  const cs = f ? getComputedStyle(f) : null;
  const bx = f ? f.getBoundingClientRect() : null;
  let inner = null;
  try {
    const d = f.contentDocument;
    inner = { url: f.contentWindow.location.href.slice(0, 90),
      rootLen: (d.getElementById('root')?.innerHTML || '').length,
      bodyLen: (d.body?.innerText || '').replace(/\s+/g,' ').length,
      text: (d.body?.innerText || '').replace(/\s+/g,' ').slice(0, 120),
      loaderOn: !!d.querySelector('.loader2'),
      hasLobbyApp: typeof f.contentWindow.LobbyApp };
  } catch (e) { inner = 'unreadable: ' + e.message; }
  return { src: f?.getAttribute('src'), target: f?.dataset.target,
    box: bx ? { w: Math.round(bx.width), h: Math.round(bx.height) } : null,
    display: cs?.display, visibility: cs?.visibility, inner };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: `${OUT}/wk-shell-poker.png` });
await b.close();
