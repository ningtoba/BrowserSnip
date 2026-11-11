import { open, sleep } from './audit3-cdp.mjs';
const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${process.env.BASE}/#/tool/add-stamps` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const f = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: f.nodeId, files: [process.env.PDF] });
await h.wait(`!!document.querySelector('[data-tool="stamp"]')`, 60000);
await sleep(2000);
await h.ev(`document.querySelector('[data-tool="stamp"]').click()`);
await sleep(400);
const sheet = JSON.parse(await h.ev(`(() => { const s = document.querySelector('[data-tool-gesture]'); const r = s.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`));
await h.click(sheet.x + sheet.w * 0.7, sheet.y + sheet.h * 0.2);
await sleep(900);
console.log('inspector after one stamp:', await h.ev(`JSON.stringify({
  fields: [...document.querySelectorAll('input, select, [role=slider]')].filter((e) => e.offsetParent).map((e) => ({
    tag: e.tagName.toLowerCase(), id: e.id || null, label: e.getAttribute('aria-label') || null,
    type: e.type || null, value: e.value ?? null, min: e.min ?? null, max: e.max ?? null })),
  text: (document.body.innerText.match(/[^\\n]*(Opacity|Width|Position|Pages|Colour|Color|Stamp)[^\\n]*/g) || []).slice(0, 14),
})`));
h.chrome.kill('SIGKILL');
