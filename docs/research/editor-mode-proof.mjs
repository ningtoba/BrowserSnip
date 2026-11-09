/**
 * Proof harness for the merged PDF editor (`edit-pdf` + `edit-pdf-text` → one tool).
 *
 *   BASE=http://localhost:5223 node docs/research/editor-mode-proof.mjs
 *   BASE=https://www.browsersnip.com EXPECT=split node docs/research/editor-mode-proof.mjs
 *   OUT=/tmp/merged-doc.pdf EXPECT=merged node docs/research/editor-mode-proof.mjs
 *
 * It measures the two things the merge claims, and nothing else:
 *
 * 1. **One tool in the catalogue.** Cards on the dashboard, rows in the palette,
 *    and every number the app prints, compared with the number of cards a visitor
 *    can actually click. `EXPECT=split` records the pre-merge state (two of each);
 *    `EXPECT=merged` requires one.
 * 2. **One surface that keeps its work across a mode switch.** The old URL opens
 *    the merged page in the text mode; a paragraph is retyped there; the surface
 *    switches to Annotate and drags a real highlight over a real text line of
 *    `/tmp/sample.pdf`; it switches away and back; the mark is still there, undo
 *    still steps it, and the **exported file** — read afterwards by
 *    `editor-mode-bytes.py`, never the layer list — carries it.
 *
 * Screenshots land in `docs/research/shots/`, light and dark. Nothing here trusts
 * a component's own count: marks are counted off the overlay DOM, the count off
 * the exported bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open, HELPERS, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5223';
const EXPECT = process.env.EXPECT || 'merged';
const OUT = process.env.OUT || '/tmp/merged-doc.pdf';
const SHOTS = process.env.SHOTS || 'docs/research/shots';
const FIXTURE = process.env.FIXTURE || '/tmp/sample.pdf';
/** Page-1 geometry of the fixture, in PDF points, read out of the file itself. */
const PAGE = { width: 595, height: 842 };
const LINE = { x0: 202, x1: 352, y: 216 }; // the "Full name" row of the CV fixture

fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(FIXTURE)) {
  console.error(`fixture missing: ${FIXTURE} (the campaign's sample.pdf)`);
  process.exit(2);
}

const h = await open();
const ev = (x) => h.ev(x);
const rows = [];
const check = (name, ok, detail) => {
  rows.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
};

const pick = async (sel) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};

const goto = async (hashRoute, waitExpr, ms = 45000) => {
  await h.send('Page.navigate', { url: `${BASE}/#${hashRoute}` });
  const ok = await h.wait(waitExpr, ms);
  if (!ok) console.log(`(timeout waiting for ${waitExpr} on ${hashRoute})`);
  await sleep(600);
  return ok;
};

/** Every `[data-tool]` card the dashboard renders, and the number it prints. */
const census = async () =>
  JSON.parse(
    await ev(`(() => {
      const cards = [...document.querySelectorAll('button[data-tool]')].map((b) => b.getAttribute('data-tool'));
      const printed = [...document.querySelectorAll('p, span, div, h1, h2')]
        .map((n) => (n.childElementCount === 0 ? (n.textContent || '').trim() : ''))
        .filter((t) => /\\b\\d+ tools?\\b/.test(t))
        .slice(0, 8);
      return JSON.stringify({ cards, printed, editors: cards.filter((id) => /^edit-pdf/.test(id)) });
    })()`),
  );

/* ── 1. the catalogue ──────────────────────────────────────────────────────── */

await goto('/pdf', `document.querySelectorAll('button[data-tool]').length > 20`);
const dash = await census();
const cardCount = dash.cards.length;
const printedOnDashboard = (dash.printed.join(' ').match(/(\d+)\s+tools/) || [])[1] ?? null;
check(
  'dashboard prints the number of cards it holds',
  printedOnDashboard === String(cardCount),
  `printed ${printedOnDashboard}, cards ${cardCount}`,
);
if (EXPECT === 'merged') {
  check('one editor card', dash.editors.length === 1, `edit-pdf cards: ${JSON.stringify(dash.editors)}`);
} else {
  check('two editor cards (the state before the merge)', dash.editors.length === 2, `cards: ${JSON.stringify(dash.editors)}`);
}

// The palette: the same job must be offered once, and its footer must agree.
await ev(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>/Search tools/i.test(x.getAttribute('aria-label')||'')); if (b) b.click(); return !!b; })()`);
await h.wait(`!!document.querySelector('[role="listbox"]')`, 8000);
await ev(`(() => { const i=document.querySelector('[role="dialog"] input, [cmdk-input], input[type="search"], [role="combobox"]'); if (i) { i.value='edit pdf text'; i.dispatchEvent(new Event('input',{bubbles:true})); } return !!i; })()`);
await sleep(900);
const palette = JSON.parse(
  await ev(`(() => {
    const list = document.querySelector('[role="listbox"]');
    const items = [...(list?.querySelectorAll('[role="option"]') || [])].map((o) => (o.innerText || '').split('\\n')[0].trim());
    const footer = ([...(document.querySelectorAll('p, span, div'))].map((n) => (n.childElementCount === 0 ? (n.textContent||'').trim() : '')).find((t) => /^\\d+ tools$/.test(t))) || null;
    return JSON.stringify({ items, footer, editors: items.filter((t) => /edit|text/i.test(t)).slice(0, 6) });
  })()`),
);
if (EXPECT === 'merged') {
  const editorRows = palette.items.filter((t) => /^PDF Editor$/i.test(t));
  check('one palette row for the editor', editorRows.length === 1, `rows: ${JSON.stringify(palette.items.slice(0, 6))}`);
} else {
  const both = palette.items.filter((t) => /PDF Editor|Edit PDF Text/i.test(t));
  check('two palette rows for one job (before)', both.length === 2, `rows: ${JSON.stringify(both)}`);
}
if (palette.footer) {
  const n = Number(palette.footer.split(' ')[0]);
  check('the palette counts what the dashboard shows', n === cardCount, `palette ${n}, cards ${cardCount}`);
}
await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1; })()`);
await sleep(300);

/* ── 2. the old URL, the header, and one promise ───────────────────────────── */

await goto('/tool/edit-pdf-text', `!!document.querySelector('input[type=file][accept*="pdf"], [data-editor-surface], [data-text-editor], canvas')`);
await sleep(1200);
const landing = JSON.parse(
  await ev(`JSON.stringify({
    hash: location.hash,
    header: (document.querySelector('[aria-current="page"]')?.textContent || '').trim(),
    names: [...document.querySelectorAll('h1')].map((n) => (n.textContent||'').trim()),
    promises: [...document.querySelectorAll('[data-tool-promise]')].map((n) => (n.textContent||'').trim()),
    surface: !!document.querySelector('[data-editor-surface]'),
    modeBar: document.querySelector('[data-editor-mode-bar]')?.getAttribute('data-editor-mode-bar') ?? null,
    pressed: [...document.querySelectorAll('[data-editor-mode]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-editor-mode')),
  })`),
);
if (EXPECT === 'merged') {
  check('the old URL lands on the canonical route, in the text mode', landing.hash === '#/tool/edit-pdf?mode=text', landing.hash);
  check('the header names one tool', landing.header === 'PDF Editor', `breadcrumb reads "${landing.header}"`);
  check('the merged surface is up', landing.surface === true);
  check('the text mode is the pressed one', landing.pressed.join() === 'text', `pressed: ${JSON.stringify(landing.pressed)}`);
} else {
  check('the old URL was its own page (before)', landing.hash === '#/tool/edit-pdf-text', landing.hash);
  check('it named itself a second tool (before)', landing.header === 'Edit PDF Text', `breadcrumb read "${landing.header}"`);
}

/* ── 3. the document, then the mode round trip ─────────────────────────────── */

const intake = await ev(`!!document.querySelector('input[type=file][accept*="pdf"]')`);
if (!intake) {
  console.log('no intake to drop on — skipping the interaction half');
} else {
  await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="pdf"]'), files: [FIXTURE] });

  if (EXPECT === 'split') {
    await h.wait(`!!document.querySelector('[data-editable-block]')`, 40000);
    const split = await census();
    await h.shot(`${SHOTS}/editor-merge-before-split-page.png`);
    check('the text page had no way to annotate (before)', !(await ev(`!!document.querySelector('[data-editor-mode-bar]')`)));
    console.log(`(before: ${split.editors.length} editor cards, no mode bar on ${landing.hash})`);
  } else {
    await h.wait(`!!document.querySelector('[data-editable-block]')`, 60000);
    await h.ev(HELPERS);
    await sleep(1500);

    // One paragraph retyped in place, in the mode the bookmark opened.
    const block = JSON.parse(
      await ev(`(() => {
        const nodes = [...document.querySelectorAll('[data-editable-block="yes"]')];
        const hit = nodes.find((n) => /Razlan|luqmanhakim/i.test(n.getAttribute('aria-label') || '')) || nodes[0];
        if (!hit) return 'null';
        const r = hit.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, label: (hit.getAttribute('aria-label') || '').slice(0, 60) });
      })()`,
      ),
    );
    check('the text mode found a paragraph', block !== 'null', JSON.stringify(block));

    if (block !== 'null') {
      await h.doubleClick(block.x, block.y);
      await sleep(1200);
      await ev(`(() => { const b=document.querySelector('[data-paragraph]'); if (b) { const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width}); } return 'null'; })()`);
      // Select all and replace, so the marker is the whole block and the bytes
      // have one unambiguous thing to look for.
      await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await sleep(200);
      await h.type('MERGEDMODE');
      await sleep(400);
      await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(2500);
      const typed = await ev(`document.body.innerText.includes('MERGEDMODE')`);
      check('the rewrite is on screen', typed === true);
      await h.shot(`${SHOTS}/editor-merge-1-text-edited.png`);
    }

    // Switch to Annotate: same document, same page, no second pick.
    await ev(`(() => { const b=document.querySelector('[data-editor-mode="annotate"]'); if (b) b.click(); return !!b; })()`);
    await h.wait(`!!document.querySelector('[data-tool-gesture]')`, 30000);
    await sleep(2500);
    const stillOpen = JSON.parse(
      await ev(`JSON.stringify({
        tabs: [...document.querySelectorAll('[data-editor-pane="annotate"] button')].map((b) => (b.textContent || '').trim()).filter((t) => /\\.pdf$/i.test(t)),
        paneHidden: document.querySelector('[data-editor-pane="text"]')?.classList.contains('hidden') ?? null,
        rewriteStillMounted: !!document.querySelector('[data-editable-block]'),
        markerStillOnScreen: document.body.innerText.includes('MERGEDMODE'),
        page: (() => { const c = document.querySelector('[data-editor-pane="annotate"] canvas'); return c ? { w: c.width, h: c.height } : null; })(),
      })()`),
    );
    check('the annotation pane came up on the document already open', stillOpen.tabs.length > 0, JSON.stringify(stillOpen.tabs));
    check('the text pane is hidden but not torn down', stillOpen.paneHidden === true && stillOpen.rewriteStillMounted === true, JSON.stringify({ hidden: stillOpen.paneHidden, mounted: stillOpen.rewriteStillMounted }));
    check('the unfinished rewrite survived the switch on screen', stillOpen.markerStillOnScreen === true);

    // A real highlight, dragged over a real line of the fixture.
    const sv = JSON.parse(await ev('JSON.stringify(window.__surface())'));
    const sx = sv.w / PAGE.width;
    const sy = sv.h / PAGE.height;
    await ev(`window.__arm('highlight')`);
    await sleep(300);
    await h.drag(sv.x + LINE.x0 * sx, sv.y + LINE.y * sy, sv.x + LINE.x1 * sx, sv.y + LINE.y * sy);
    await sleep(1200);
    const marksAfterDrag = Number(await ev(`window.__ids().length`));
    const armedAfter = await ev('window.__armed()');
    check('the drag made a highlight', marksAfterDrag === 1, `marks: ${marksAfterDrag}`);
    check('the tool stepped aside after the placement', armedAfter === 'select', `armed: ${armedAfter}`);

    // Away to the text mode and back: the mark must still be on the canvas.
    await ev(`(() => { const b=document.querySelector('[data-editor-mode="text"]'); if (b) b.click(); return !!b; })()`);
    await sleep(1500);
    await ev(`(() => { const b=document.querySelector('[data-editor-mode="annotate"]'); if (b) b.click(); return !!b; })()`);
    await h.wait(`!!document.querySelector('[data-tool-gesture]')`, 20000);
    await sleep(2000);
    const marksAfterRoundTrip = Number(await ev(`window.__ids().length`));
    const exportLabel = await ev(`([...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).find((t) => /Export annotated PDF/i.test(t)) || null)`);
    check('the highlight survived the mode round trip', marksAfterRoundTrip === 1, `marks: ${marksAfterRoundTrip}`);
    check('and the export still counts it', /Export annotated PDF \(1\)/.test(exportLabel || ''), String(exportLabel));
    await h.shot(`${SHOTS}/editor-merge-2-highlight-after-switch.png`);

    // Undo across the switch: one step back, one step forward, in the pane that
    // drew the mark — while the text pane sits hidden beside it.
    const key = async (k, mods) => {
      await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, modifiers: mods, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
      await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Key${k.toUpperCase()}`, modifiers: mods, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
    };
    await key('z', 2);
    await sleep(900);
    const afterUndo = Number(await ev(`window.__ids().length`));
    await key('z', 2 + 8); // shift+ctrl
    await sleep(900);
    const afterRedo = Number(await ev(`window.__ids().length`));
    check('undo steps the annotation across a mode switch', afterUndo === 0 && afterRedo === 1, `undo → ${afterUndo}, redo → ${afterRedo}`);
    // …and the hidden pane never joined in: the rewrite is still there to export.
    check('the hidden text pane did not undo along with it', (await ev(`document.body.innerText.includes('MERGEDMODE')`)) === true);

    // Export both halves, and read the files afterwards rather than the layer list.
    const blobsBefore = await ev(`(window.__blobs || []).length`);
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find((x) => /Export annotated PDF/i.test(x.innerText || '')); if (b) b.click(); return !!b; })()`);
    await h.wait(`(window.__blobs || []).length > ${blobsBefore}`, 60000);
    const annotated = await readLastPdf(blobsBefore);
    if (annotated) {
      fs.writeFileSync(OUT, annotated);
      check('the annotation export came out of the merged surface', annotated.length > 1000, `${annotated.length} bytes → ${OUT}`);
    } else {
      check('the annotation export came out of the merged surface', false, 'no application/pdf blob');
    }

    const beforeText = await ev(`(window.__blobs || []).length`);
    await ev(`(() => { const b=document.querySelector('[data-editor-mode="text"]'); if (b) b.click(); return !!b; })()`);
    await h.wait(`!!document.querySelector('[data-editable-block]')`, 30000);
    await sleep(1200);
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find((x) => /export|save/i.test((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '')) && !x.disabled); if (b) b.click(); return b ? (b.innerText || b.getAttribute('aria-label')) : null; })()`);
    await sleep(2000);
    const textBytes = await readLastPdf(beforeText);
    if (textBytes) {
      fs.writeFileSync(`${OUT}.text.pdf`, textBytes);
      check('the text mode exported the rewrite it was holding', textBytes.length > 1000, `${textBytes.length} bytes → ${OUT}.text.pdf`);
    } else {
      check('the text mode exported the rewrite it was holding', false, 'no second pdf blob appeared');
    }

    // One memory for one tool: the star and the recents sit on the canonical id.
    await ev(`(() => { const b=document.querySelector('button[aria-label^="Star"], button[aria-label^="Unstar"]'); if (b) b.click(); return !!b; })()`);
    await sleep(500);
    const memory = JSON.parse(
      await ev(`JSON.stringify({
        starred: JSON.parse(localStorage.getItem('browsersnip:starred-tools:v1') || '[]'),
        recents: JSON.parse(localStorage.getItem('browsersnip:recent-files:v1') || '[]').map((r) => r.toolId),
      })()`),
    );
    check('the star is stored against one id', memory.starred.includes('edit-pdf') && !memory.starred.includes('edit-pdf-text'), JSON.stringify(memory.starred));
    check('the recents entry resolves to the same tool', memory.recents.length > 0 && memory.recents.every((id) => id === 'edit-pdf'), JSON.stringify(memory.recents));

    // Dark mode: the bar and its chips must be token-painted, not fallbacks.
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find((x) => /Switch to dark mode/i.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return !!b; })()`);
    await sleep(1500);
    const tokens = JSON.parse(
      await ev(`JSON.stringify((() => {
        const bar = document.querySelector('[data-editor-mode-bar]');
        const chip = document.querySelector('[data-editor-mode][aria-pressed="true"]');
        const cs = bar ? getComputedStyle(bar) : null;
        const chipCs = chip ? getComputedStyle(chip) : null;
        return {
          barBg: cs?.backgroundColor ?? null,
          barFg: cs?.color ?? null,
          chipBg: chipCs?.backgroundColor ?? null,
          chipFg: chipCs?.color ?? null,
          hex: [...document.querySelectorAll('[data-editor-surface] *')].filter((n) => /#(?:[0-9a-f]{3}|[0-9a-f]{6})/i.test(n.getAttribute('style') || '')).length,
        };
      })()`),
    );
    const notPaper = tokens.barBg && !/rgba?\(255, 255, 255/.test(tokens.barBg);
    check('dark mode paints the bar in tokens', notPaper && tokens.chipFg && tokens.chipBg, JSON.stringify(tokens));
    await h.shot(`${SHOTS}/editor-merge-3-dark.png`);
  }
}

async function readLastPdf(since) {
  const found = await ev(`(() => { const b=(window.__blobs || []).filter((x) => x.type === 'application/pdf').slice(${since})[0]; return b ? b.u : ''; })()`);
  if (!found) return null;
  const b64 = await ev(`(async()=>{try{const r=await fetch(${JSON.stringify(found)});const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s)}catch(e){return ''}})()`);
  return typeof b64 === 'string' && b64.length > 200 ? Buffer.from(b64, 'base64') : null;
}

console.log(`\nerrors: ${JSON.stringify(h.errors.slice(0, 6))}`);
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} checks passed — EXPECT=${EXPECT} on ${BASE}`);
console.log(`screenshot dir: ${SHOTS}; export: ${path.basename(OUT)}`);
fs.writeFileSync(`${OUT}.probe.json`, JSON.stringify({ base: BASE, expect: EXPECT, rows }, null, 2));
h.ws.close();
h.chrome.kill('SIGKILL');
process.exit(failed.length ? 1 : 0);
