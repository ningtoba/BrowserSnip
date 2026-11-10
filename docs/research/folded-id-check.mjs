// Does a folded (and now retired) tool id still reach a usable page on a live build,
// and does the app's own tool count match the catalogue it renders?
//
//   BASE=https://www.browsersnip.com node docs/research/folded-id-check.mjs
//
// `redact` was retired: its definition is gone and only `TOOL_ALIASES` keeps the id
// answering. This asks the two questions that leaves open on a deployed page — the
// bookmark, and the number in the copy — because both are claims about what a visitor
// sees, not about the module graph.
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5311';
const PDF = process.env.PDF || '/tmp/crop-units/sheets.pdf';
const h = await open();

/** `innerText` carries the soft-wrap newlines, so a two-word phrase needs folding. */
const TEXT = `(document.body.innerText || '').replace(/\\s+/g, ' ')`;

const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};

// 1. The retired id's URL: it has to land on the tool that owns redaction, and once a
//    file is in, mount the panel that runs it.
await h.send('Page.navigate', { url: `${BASE}/#/tool/redact` });
if (!(await h.wait(`location.hash === '#/tool/redact-pdf'`, 60000))) {
  throw new Error(`#/tool/redact did not fold; the page is ${await h.ev('location.hash')}`);
}
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
console.log('intake:', await h.ev(`JSON.stringify({
  path: location.hash,
  title: (${TEXT}).match(/Redact [A-Za-z ]{0,12}/)?.[0] ?? null,
  retiredName: (${TEXT}).includes('Redact Regions'),
})`));
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file]'), files: [PDF] });
if (!(await h.wait(`!!document.querySelector('#tool-process-btn')`, 60000))) {
  throw new Error('no control that runs redaction appeared beside the canvas');
}
await sleep(500);
console.log('redact panel:', await h.ev(`JSON.stringify({
  path: location.hash,
  apply: document.querySelector('#tool-process-btn')?.innerText?.trim() ?? null,
  warning: /Permanent redaction/.test(${TEXT}),
  metadataSwitch: /Also clear matching text from metadata and bookmarks/.test(${TEXT}),
  canvas: !!document.querySelector('canvas'),
})`));

// 2. The dashboard: the total in the copy, the totals on the shelves, the cards the
//    shelves hold, and the retired tool's own name.
await h.send('Page.navigate', { url: `${BASE}/#/pdf` });
await h.wait(`!!document.querySelector('[data-tool]')`, 60000);
await sleep(1200);
console.log('dashboard:', await h.ev(`(() => {
  const text = ${TEXT};
  const cards = [...document.querySelectorAll('[data-tool]')];
  const shelfCounts = [...document.querySelectorAll('h2[id^="job-"]')]
    .map((heading) => Number(heading.nextElementSibling?.textContent ?? NaN))
    .filter((value) => Number.isFinite(value));
  const printed = Number(text.match(/(\\d+) tools that run on your own computer/)?.[1] ?? -1);
  const shelfTotal = shelfCounts.reduce((sum, value) => sum + value, 0);
  return JSON.stringify({
    printed,
    cards: cards.length,
    shelves: shelfCounts,
    shelfTotal,
    agrees: printed === cards.length && printed === shelfTotal,
    uniqueIds: new Set(cards.map((card) => card.getAttribute('data-tool'))).size,
    redactCard: cards.some((card) => card.getAttribute('data-tool') === 'redact'),
    redactPdfCard: cards.some((card) => card.getAttribute('data-tool') === 'redact-pdf'),
    retiredName: text.includes('Redact Regions'),
  });
})()`));

// 3. The landing page, which states the total twice and in different words. The second
//    statement sits below the fold behind a scroll-triggered reveal, so the raw text node
//    is read beside the painted one rather than assumed from it.
await h.send('Page.navigate', { url: `${BASE}/#/` });
await h.wait(`/tools/.test(${TEXT})`, 60000);
await sleep(800);
console.log('landing:', await h.ev(`JSON.stringify({
  painted: (${TEXT}).match(/\\d+ (?:PDF )?tools(?: · \\d+ categories)?/g) ?? [],
  inDocument: (document.body.textContent || '').replace(/\\s+/g, ' ').match(/\\d+ (?:PDF )?tools(?: · \\d+ categories)?/g) ?? [],
})`));
console.log('console errors:', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
