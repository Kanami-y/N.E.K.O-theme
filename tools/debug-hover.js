#!/usr/bin/env node
/* debug-hover.js -- figure out why a CDP mouse move is not producing :hover. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = process.argv[2] || 'http://127.0.0.1:48911/chat';
const SEL = process.argv[3] || '.composer-tool-btn';
const PORT = 9344;
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
const CHROME = resolveChrome();
if (!CHROME) { console.error('HARNESS ERROR: no Chromium browser found. Set NTS_BROWSER_PATH to chrome.exe / chrome-headless-shell.exe.'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nts_dbg_'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
    } catch (_) {}
  }
  if (!ws) { console.error('no devtools'); process.exit(2); }
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));

  let id = 1;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const i = id++; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);

  const info = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL)});
    const shot = {};
    shot.innerWidth = window.innerWidth;
    shot.innerHeight = window.innerHeight;
    shot.dpr = window.devicePixelRatio;
    shot.outerWidth = window.outerWidth;
    shot.outerHeight = window.outerHeight;
    shot.screenX = window.screenX; shot.screenY = window.screenY;
    shot.visualViewport = window.visualViewport ? { w: visualViewport.width, h: visualViewport.height, scale: visualViewport.scale, offTop: visualViewport.offsetTop, offLeft: visualViewport.offsetLeft } : null;
    shot.hasEl = !!el;
    if (el) { const r = el.getBoundingClientRect(); shot.rect = { x: r.x, y: r.y, w: r.width, h: r.height }; }
    return JSON.stringify(shot);
  })()`);
  console.log('page info:', info);

  const o = JSON.parse(info);
  if (!o.hasEl) { console.error('.composer-tool-btn not found'); }
  else {
    const cx = Math.round(o.rect.x + o.rect.w / 2);
    const cy = Math.round(o.rect.y + o.rect.h / 2);
    console.log('computed center:', cx, cy);
    const efp = await ev(`(() => {
      const e = document.elementFromPoint(${cx}, ${cy});
      return e ? (e.tagName + '.' + String(e.className)) : 'null';
    })()`);
    console.log('elementFromPoint:', efp);

    // Way 1: plain mouseMoved
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 });
    await sleep(500);
    console.log('after mouseMoved  -> matches(:hover) =', await ev(`document.querySelector(${JSON.stringify(SEL)}).matches(':hover')`));

    // Way 2: two-step move then a hover-ish sequence
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx - 40, y: cy - 40, buttons: 0 });
    await sleep(200);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 });
    await sleep(500);
    console.log('after two-step    -> matches(:hover) =', await ev(`document.querySelector(${JSON.stringify(SEL)}).matches(':hover')`));

    // Way 3: CSS.forcePseudoState via DOM domain
    try {
      const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
      const nodeId = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: SEL });
      if (nodeId && nodeId.nodeId) {
        await send('CSS.enable');
        await send('CSS.forcePseudoState', { nodeId: nodeId.nodeId, forcedPseudoClasses: ['hover'] });
        await sleep(400);
        console.log('after forcePseudo -> matches(:hover) =', await ev(`document.querySelector(${JSON.stringify(SEL)}).matches(':hover')`));
        console.log('after forcePseudo -> backgroundColor =', await ev(`getComputedStyle(document.querySelector(${JSON.stringify(SEL)})).backgroundColor`));
      } else {
        console.log('DOM.querySelector returned no nodeId');
      }
    } catch (e) { console.log('forcePseudoState failed:', String(e).slice(0, 200)); }
  }

  ws.close(); chrome.kill();
}
main().catch((e) => { console.error('ERR ' + (e && e.stack || e)); process.exit(2); })
  .finally(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} });
