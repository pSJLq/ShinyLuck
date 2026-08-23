// Repro rig for HANDOFF §26 · "poker frame is blank for some players".
// Runs the poker lobby in Playwright WebKit (closest thing to iOS Safari we
// have) and prints every console line, page error and failed request.
//   npx playwright install webkit   (once)
//   node test/_webkit-poker.mjs
// Reproduce the friend's blank poker page: WebKit, iPhone viewport, exactly the
// URL the shell puts in the iframe. Every console line and failed request is
// reported — a blank page always has a reason, it just is not on screen.
import { createRequire } from 'node:module';
const require = createRequire('D:/Рабочий стол/ShinyLuck/package.json');
const { webkit, devices } = require('playwright');
const OUT = 'C:/TEMP/claude/D---------------ShinyLuck/9db58a06-8fc5-40d7-8783-23f4785eb2dd/scratchpad/shots';
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
page.on('console', m => console.log('  [' + m.type() + ']', m.text().slice(0, 300)));
page.on('pageerror', e => console.log('  [PAGEERROR]', String(e).slice(0, 400)));
page.on('requestfailed', r => console.log('  [FAILED]', r.url().split('/').slice(-1)[0], r.failure()?.errorText));
page.on('response', r => { if (r.status() >= 400) console.log('  [HTTP ' + r.status() + ']', r.url()); });

console.log('--- poker lobby, as the shell frames it ---');
await page.goto('https://shinyluck.win/poker/lobby.html?embed=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => ({
  rootHTML: (document.getElementById('root')?.innerHTML || '').length,
  bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  hasLobbyApp: typeof window.LobbyApp,
  hasSP: !!window.SP,
  hasReact: typeof window.React,
  scripts: [...document.querySelectorAll('script[src]')].map(s => s.src.split('/').pop()),
}));
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: `${OUT}/wk-poker.png`, fullPage: false });
await b.close();
