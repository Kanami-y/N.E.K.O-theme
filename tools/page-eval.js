#!/usr/bin/env node
/*
 * page-eval.js -- run a JS expression inside a real page in headless Chrome and
 * print the JSON result.  Used instead of --dump-dom whenever the value we care
 * about is a *computed style* or other JS-only state, because --dump-dom only
 * serialises attributes and misses anything set via element.style / DOM APIs.
 *
 * Usage:
 *   node page-eval.js --url http://127.0.0.1:48911/chat \
 *                     --js  expr.js [--wait "expr"] [--port 9355]
 *
 * --js   path to a file containing ONE javascript expression (may be async IIFE)
 * --wait optional expression polled until it returns truthy before evaluating
 * Exit 0 on success, 2 on harness error.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL_ = arg('url', 'http://127.0.0.1:48911/chat');
const JS_FILE = arg('js', '');
const WAIT = arg('wait', '');
const PORT = parseInt(arg('port', '9355'), 10);
/* Browser discovery: Chrome++ portable layout puts chrome.exe under
 * "Program Files\Chrome\App", which none of the old hard-coded paths covered.
 * --chrome / NTS_BROWSER_PATH / CHROME_PATH all work; chrome-headless-shell too. */
function resolveChrome() {
  const cands = [];
  if (process.env.NTS_BROWSER_PATH) cands.push(process.env.NTS_BROWSER_PATH);
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  cands.push(
    'C:\\Program Files\\Chrome\\App\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  );
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  return '';
}
const CHROME = arg('chrome', '') || resolveChrome();
if (!CHROME || !fs.existsSync(CHROME)) {
  console.error('HARNESS ERROR: no Chromium browser found. Pass --chrome <chrome.exe path> or set NTS_BROWSER_PATH (chrome-headless-shell also works).');
  process.exit(2);
}
const TIMEOUT_MS = parseInt(arg('timeout', '40000'), 10);
/* The plugin panel guards 重置 with window.confirm(). A native dialog BLOCKS the
 * page, so Runtime.evaluate never returns and this harness dies on a timeout that
 * looks like a hang. Auto-answer dialogs via CDP instead; --confirm dismiss
 * exercises the cancel path. */
const CONFIRM = arg('confirm', 'accept');

if (!JS_FILE || !fs.existsSync(JS_FILE)) {
  console.error('HARNESS ERROR: --js <file> is required and must exist');
  process.exit(2);
}
const EXPR = fs.readFileSync(JS_FILE, 'utf8');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nts_eval_'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('HARNESS ERROR: chrome not found'); process.exit(2); }
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let pageWs = null;
  for (let i = 0; i < 80 && !pageWs; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) pageWs = p.webSocketDebuggerUrl;
    } catch (_) {}
  }
  if (!pageWs) { console.error('HARNESS ERROR: devtools endpoint never came up'); process.exit(2); }

  const ws = new WebSocket(pageWs);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });

  let id = 1;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const i = id++; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, TIMEOUT_MS);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result ? r.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  /* Auto-answer javascript dialogs (window.confirm in the plugin panel), else the
     page blocks and Runtime.evaluate times out with a misleading "hang". */
  if (CONFIRM !== 'block') {
    try {
      await send('Page.setInterceptFileChooserDialog', { enabled: false });
    } catch (_) {}
    try {
      const client = ws;
      client.addEventListener('message', (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.method !== 'Page.javascriptDialogOpening') return;
        const accept = CONFIRM !== 'dismiss';
        ws.send(JSON.stringify({ id: id++, method: 'Page.handleJavaScriptDialog', params: { accept } }));
      });
    } catch (_) {}
  }

  await send('Page.navigate', { url: URL_ });

  if (WAIT) {
    let ok = false;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      try { ok = await ev(WAIT); } catch (_) { ok = false; }
      if (ok) break;
    }
    if (!ok) { console.error('HARNESS ERROR: --wait condition never became true'); ws.close(); chrome.kill(); process.exit(2); }
  } else {
    await sleep(5000);
  }

  const out = await ev(EXPR);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));

  ws.close(); chrome.kill();
  process.exit(0);
}

main()
  .catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); })
  .finally(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} });
