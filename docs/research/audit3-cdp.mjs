// Shared CDP harness for the edit-pdf audit. Usage: node /tmp/harness.mjs
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
const CHROME = '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
export const PORT = Number(process.env.CDP || 9517);
export const BASE = process.env.BASE || 'http://localhost:5261';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open() {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/hns-${PORT}`, '--download-dir=/tmp/hns-dl', 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {} await sleep(300); }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 1; const pend = new Map(); const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exc: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text.slice(0, 200));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'PAGEERR ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 240);
    return r.result?.value;
  };
  const wait = async (x, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(x)) return true; } catch {} await sleep(200); } return false; };
  const mouse = (type, x, y, b = 0) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: b });
  const drag = async (x0, y0, x1, y1, steps = 8) => {
    await mouse('mousePressed', x0, y0, 1);
    for (let s = 1; s <= steps; s++) await mouse('mouseMoved', x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps, 1);
    await mouse('mouseReleased', x1, y1, 0);
  };
  const click = async (x, y) => { await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); };
  const type = async (text) => send('Input.insertText', { text });
  const doubleClick = async (x, y) => {
    for (let n = 0; n < 2; n++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: n + 1, buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: n + 1, buttons: 0 });
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  // Every blob the app creates, with its type and size, so an export can be read
  // out of the page instead of trusting a headless download to land on disk.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { const u = orig(b); window.__blobs.push({ u, type: b && b.type, size: b && b.size }); return u; };
    const rev = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => { const r = rev(u); (window.__blobs || []).forEach((x) => { if (x.u === u) x.revoked = true; }); return r; };
  ` });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/hns-dl' });
  await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.VW || 1500), height: Number(process.env.VH || 1400), deviceScaleFactor: 1, mobile: false });
  return { chrome, ws, send, ev, wait, mouse, drag, click, type, doubleClick, errors, shot: async (p) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(r.data, 'base64')); } };
}

export const HELPERS = `(() => {
  const painted = (k) => {
    const tag = k.tagName.toLowerCase();
    if (tag === 'g' || tag === 'svg' || tag === 'defs') return null;
    const cs = getComputedStyle(k);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    const sw = parseFloat(cs.strokeWidth) || 0;
    const stroke = cs.stroke && cs.stroke !== 'none' && cs.stroke !== 'transparent' && sw > 0;
    const fill = cs.fill && cs.fill !== 'none' && cs.fill !== 'transparent';
    if (!stroke && !fill) return null;
    const r = k.getBoundingClientRect();
    const w = Math.max(r.width, stroke ? sw : 0);
    const h = Math.max(r.height, stroke ? sw : 0);
    return { tag, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1), area: +(w * h).toFixed(1), stroke: cs.stroke, fill: cs.fill, sw };
  };
  window.__surface = () => {
    const o = document.querySelector('[data-tool-gesture]');
    const r = (o || document.querySelector('canvas')).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  window.__armed = () => document.querySelector('[data-armed-tool]')?.getAttribute('data-armed-tool') ?? null;
  window.__count = () => { const m = (document.body.innerText.match(/Export annotated PDF \\((\\d+)\\)/) || [])[1]; return m ? Number(m) : null; };
  window.__notice = () => ({ tone: document.querySelector('[data-editor-status]')?.getAttribute('data-editor-status') ?? null, text: document.querySelector('[data-editor-status]')?.innerText ?? null });
  window.__ids = () => [...document.querySelectorAll('[data-mark]')].map((g) => g.getAttribute('data-mark'));
  window.__marks = () => [...document.querySelectorAll('[data-mark]')].map((g) => {
    let area = 0; const kids = [];
    for (const k of g.querySelectorAll('*')) { const p = painted(k); if (p) { area += p.area; kids.push(p); } }
    const gb = g.getBoundingClientRect();
    return { id: g.getAttribute('data-mark'), box: { x: +gb.x.toFixed(1), y: +gb.y.toFixed(1), w: +gb.width.toFixed(1), h: +gb.height.toFixed(1) }, area: Math.round(area), kids: kids.slice(0, 6), childCount: kids.length };
  });
  window.__arm = (t) => { const b = document.querySelector('[data-tool="' + t + '"]'); if (!b) return 'missing'; b.click(); return 'clicked'; };
  // Only buttons inside a dialog: a document-wide scan once clicked the tab's
  // own "Close" button and took the page down with it.
  window.__closeModals = () => {
    let n = 0;
    for (const d of document.querySelectorAll('[role="dialog"], [data-dialog]')) {
      for (const b of d.querySelectorAll('button')) {
        const l = (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '');
        if (/\\b(Cancel|Close|Done|Dismiss)\\b/i.test(l)) { b.click(); n++; break; }
      }
    }
    return n;
  };
  window.__dialogs = () => [...document.querySelectorAll('[role="dialog"], [data-dialog]')].map((d) => d.innerText.split('\\n')[0].slice(0, 40));
  return 'ok';
})()`;
