import fs from 'node:fs';
import { open } from '/home/nekophobia/Projects/BrowserSnipRepo/.lanes/convert2/docs/research/audit3-cdp.mjs';
const install = async () => {
  const render = await import('/src/lib/pdf/core/render.ts');
  const convert = await import('/src/lib/pdf/core/convert.ts');
  const lib = await import('/@id/@maxwbh/pdf-lib');
  window.__onoff = async (b64) => {
    const raw = atob(b64); const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const session = await render.openRender(bytes);
    const doc = await lib.PDFDocument.load(bytes.slice());
    const out = {};
    for (const embedImages of [true, false]) {
      const svg = await convert.documentToSvg(doc, session, 1, { embedImages });
      out[embedImages ? 'on' : 'off'] = {
        bytes: svg.length,
        images: (svg.match(/<image /g) || []).length,
        skipped: (svg.match(/(\d+) operator\(s\) skipped/) || [])[1] || '0',
        hrefHead: (svg.match(/href="data:([^;,]+)[^"]{0,40}/) || [])[1] || null,
      };
      if (embedImages) window.__svg = svg;
    }
    await session.destroy();
    return out;
  };
  return 'ready';
};
const h = await open();
await h.send('Page.navigate', { url: `${process.env.BASE || 'http://localhost:5293'}/#/tool/pdf-to-svg` });
await h.wait('!!document.querySelector("input[type=file]")', 60000);
if ((await h.ev(`(${install.toString()})()`)) !== 'ready') throw new Error('install failed');
for (const f of process.argv.slice(2)) {
  const r = await h.ev(`window.__onoff(${JSON.stringify(fs.readFileSync(f).toString('base64'))})`);
  console.log('#####', f.split('/').pop(), JSON.stringify(r));
  fs.writeFileSync('/tmp/lane-seam2c/live-' + f.split('/').pop() + '.svg', await h.ev('window.__svg'));
}
await h.send('Browser.close').catch(() => {}); h.chrome.kill(); process.exit(0);
