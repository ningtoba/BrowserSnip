// Why `embedImages` hands back an empty frame in a real browser: measure the
// pdf.js object transport from inside the app's own session, in Chromium.
//
//   BASE=http://localhost:5293 CDP=9853 node docs/research/svg-img-intent-probe.mjs <pdf> [<pdf>…]
//
// For every PDF it reports, per image operator in the list the SVG builder walks:
// whether `page.objs` already holds the raster when `getOperatorList()` resolves,
// whether `objs.get(id, cb)` ever fires (and how long it takes), and what the
// same lookup returns after a real `page.render()` has run — which is what tells
// the two candidate cures apart (drive a render vs read the stream bytes).
import fs from 'node:fs';
import { open } from './audit3-cdp.mjs';

const install = async () => {
  const render = await import('/src/lib/pdf/core/render.ts');
  window.__probe = async (base64) => {
    const IMAGE_OPS = { 83: 'paintImageMaskXObject', 85: 'paintImageXObject', 86: 'paintInlineImageXObject', 88: 'paintImageXObjectRepeat' };
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const describe = (v) => {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (typeof v !== 'object') return `${typeof v} ${String(v).slice(0, 40)}`;
      const bitmap = v.bitmap;
      const data = v.data;
      return JSON.stringify({
        ctor: v.constructor?.name ?? null,
        keys: Object.keys(v).slice(0, 12),
        width: v.width,
        height: v.height,
        kind: v.kind,
        alt: v.alt,
        bitmap: bitmap ? `${bitmap.width}x${bitmap.height} ${bitmap.constructor?.name}` : null,
        data: data
          ? `${data.constructor?.name ?? typeof data} len=${data.length ?? '?'}`
          : null,
      });
    };
    const grab = (proxy, id, ms) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve('TIMEOUT'), ms);
        try {
          proxy.objs.get(id, (value) => {
            clearTimeout(t);
            resolve(describe(value));
          });
        } catch (e) {
          clearTimeout(t);
          resolve(`throw ${String(e).slice(0, 80)}`);
        }
      });

    const session = await render.openRender(bytes);
    const doc = session.doc;
    const proxy = await session.page(1);
    const list = await proxy.getOperatorList();
    const imgs = [];
    for (let i = 0; i < list.fnArray.length; i += 1) {
      const name = IMAGE_OPS[list.fnArray[i]];
      if (!name) continue;
      const arg = list.argsArray[i]?.[0];
      imgs.push({ op: name, arg: typeof arg === 'string' ? arg : describe(arg), id: typeof arg === 'string' ? arg : null });
    }
    const report = {
      numPages: doc.numPages,
      intentStatesAfterOpList: proxy._intentStates ? proxy._intentStates.size : 'no field',
      objsIterable: [...proxy.objs].map(([k, v]) => `${k}=${describe(v)}`).slice(0, 6),
      imgs: [],
    };
    for (const im of imgs) {
      const row = { ...im };
      if (im.id) {
        row.hasNow = proxy.objs.has(im.id);
        try {
          row.getNow = describe(proxy.objs.get(im.id));
        } catch (e) {
          row.getNow = `throw ${String(e).slice(0, 60)}`;
        }
        row.t0 = await grab(proxy, im.id, 400);
        report.imgs.push(row);
      }
    }
    // Now drive a real render of the same page and re-check the same ids.
    const viewport = proxy.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const task = proxy.render({ canvasContext: canvas.getContext('2d'), viewport });
    await task.promise;
    report.afterRender = {
      intentStates: proxy._intentStates ? proxy._intentStates.size : 'no field',
      objsIterable: [...proxy.objs].map(([k, v]) => `${k}=${describe(v)}`).slice(0, 6),
      imgs: imgs.filter((i) => i.id).map((im) => ({
        id: im.id,
        has: proxy.objs.has(im.id),
        got: proxy.objs.has(im.id) ? describe(proxy.objs.get(im.id)) : 'absent',
      })),
      ink: (() => {
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let p = 0; p < d.length; p += 4) if (d[p] !== 255 || d[p + 1] !== 255 || d[p + 2] !== 255) n += 1;
        return n;
      })(),
    };
    // A slow-grab on a second fresh session, to time the delivery.
    const proxy2 = await session.page(1);
    await proxy2.getOperatorList();
    if (imgs[0]?.id) report.slowGrab = await grab(proxy2, imgs[0].id, 3000);
    await session.destroy();
    return report;
  };
  return 'ready';
};

const h = await open();
await h.send('Page.navigate', { url: `${process.env.BASE || 'http://localhost:5293'}/#/tool/pdf-to-svg` });
await h.wait('!!document.querySelector("input[type=file]")', 60000);
if ((await h.ev(`(${install.toString()})()`)) !== 'ready') throw new Error('install failed');
for (const file of process.argv.slice(2)) {
  const b64 = fs.readFileSync(file).toString('base64');
  const r = await h.ev(`window.__probe(${JSON.stringify(b64)})`);
  console.log('#####', file);
  console.log(JSON.stringify(r, null, 1));
}
console.log('page errors', JSON.stringify((h.errors || []).slice(0, 3)));
await h.send('Browser.close').catch(() => undefined);
h.chrome.kill();
process.exit(0);
