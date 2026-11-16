#!/usr/bin/env node
/*
 * hover-check.js -- verify that a GATED :hover rule really takes effect in the
 * real /chat page.  Static DOM dumps cannot trigger :hover, so this drives a
 * real headless Chrome over CDP and dispatches an actual mouse move.
 *
 * Usage:
 *   node hover-check.js --url http://127.0.0.1:48911/chat \
 *                       --sel .composer-tool-btn \
 *                       --gate data-nts-button-hover-bg \
 *                       [--expect "rgb(225, 112, 85)"] \
 *                       [--port 9333]
 *
 * Exit codes: 0 = observed value matched --expect (or no --expect given),
 *             1 = mismatch / rule not effective, 2 = harness error.
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
const SEL = arg('sel', '.composer-tool-btn');
const GATE = arg('gate', 'data-nts-button-hover-bg');
const EXPECT = arg('expect', '');
const PORT = parseInt(arg('port', '9333'), 10);
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nts_hover_'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bail(code, msg) {
  console.error('HARNESS ERROR: ' + msg);
  process.exit(code);
}

async function main() {
  if (!fs.existsSync(CHROME)) bail(2, 'chrome not found at ' + CHROME);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + profile,
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  let version = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) { version = await r.json(); break; }
    } catch (_) { /* not up yet */ }
  }
  if (!version) bail(2, 'chrome devtools endpoint never came up on port ' + PORT);

  let pageWs = null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    const list = await r.json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { pageWs = page.webSocketDebuggerUrl; break; }
    await sleep(250);
  }
  if (!pageWs) bail(2, 'no page target with a websocket url');

  const ws = new WebSocket(pageWs);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg.method);
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); }
      }, 30000);
    });
  }

  async function eval_(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page eval threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result ? r.result.value : undefined;
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });

  // Wait for the app page + our loader to have injected its style element.
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      ready = await eval_('!!document.getElementById("nts-dynamic")');
    } catch (_) { ready = false; }
    if (ready) break;
  }
  if (!ready) bail(2, 'loader never injected #nts-dynamic into ' + URL_);

  const gatePresent = await eval_(
    'document.documentElement.hasAttribute(' + JSON.stringify(GATE) + ')'
  );

  // Make sure a matching element exists; inject a throwaway one if the real
  // composer is not rendered (no conversation open).
  const injected = await eval_(`(() => {
    if (document.querySelector(${JSON.stringify(SEL)})) return false;
    const el = document.createElement('button');
    el.className = ${JSON.stringify(SEL.replace(/^\./, ''))};
    el.id = '__nts_hover_target';
    el.textContent = 'NTS';
    el.style.position = 'fixed';
    el.style.left = '600px';
    el.style.top = '300px';
    el.style.width = '48px';
    el.style.height = '32px';
    el.style.zIndex = '2147483647';
    document.body.appendChild(el);
    return true;
  })()`);

  const rectJson = await eval_(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, cls: String(el.className) });
  })()`);
  if (!rectJson) bail(2, 'no element matched ' + SEL);
  const rect = JSON.parse(rectJson);

  const baseline = await eval_(
    'getComputedStyle(document.querySelector(' + JSON.stringify(SEL) + ')).backgroundColor'
  );

  // Park the pointer far away, then move onto the element: :hover needs a real move.
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 });
  await sleep(600);

  const hovered = await eval_(
    'getComputedStyle(document.querySelector(' + JSON.stringify(SEL) + ')).backgroundColor'
  );
  const isHover = await eval_(
    'document.querySelector(' + JSON.stringify(SEL) + ').matches(":hover")'
  );

  ws.close();
  chrome.kill();

  const ok = !EXPECT || hovered === EXPECT;
  const out = {
    url: URL_,
    selector: SEL,
    gateAttribute: GATE,
    gatePresent: gatePresent,
    injectedThrowawayElement: injected,
    elementClass: rect.cls,
    center: { x: cx, y: cy },
    matchesHover: isHover,
    backgroundBefore: baseline,
    backgroundHovering: hovered,
    expected: EXPECT || '(not asserted)',
    verdict: ok ? 'PASS' : 'FAIL',
  };
  console.log(JSON.stringify(out, null, 2));

  if (GATE && !gatePresent) {
    console.error('NOTE: gate attribute ' + GATE + ' is absent -> the gated rule cannot apply.');
  }
  process.exit(ok && (!GATE || gatePresent) ? 0 : 1);
}

main()
  .catch((e) => { try { console.error('HARNESS ERROR: ' + (e && e.stack || e)); } catch (_) {} process.exit(2); })
  .finally(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  });
