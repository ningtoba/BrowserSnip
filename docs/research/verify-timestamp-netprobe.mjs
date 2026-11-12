// Can a browser page reach the default timestamp authority at all?
//
//   BASE=https://www.browsersnip.com node docs/research/verify-timestamp-netprobe.mjs
//
// `timestamp-pdf` names http://timestamp.digicert.com as its default authority. The
// tool says the authority address is the only thing that leaves the tab, so the
// question is whether the tab can get an answer: POST from the page's own origin,
// exactly as `core/signature.requestTimestamp` does, and report the failure by name.
import { open } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const TARGETS = (process.env.TARGETS || 'http://timestamp.digicert.com,https://timestamp.digicert.com')
  .split(',');
const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/timestamp-pdf` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
console.log(`page origin: ${BASE}`);
for (const url of TARGETS) {
  const result = await h.ev(`(async () => {
    const body = new Uint8Array([48, 8, 6, 5, 43, 14, 3, 2, 27, 5, 0]);
    try {
      const response = await fetch(${JSON.stringify(url)}, { method: 'POST', body, headers: { 'Content-Type': 'application/timestamp-query' } });
      return 'HTTP ' + response.status + ' (opaque ok=' + response.ok + ')';
    } catch (error) {
      return 'threw ' + (error && error.name) + ': ' + String(error && error.message).slice(0, 90);
    }
  })()`);
  console.log(`POST ${url} → ${result}`);
}
const mixed = await h.ev(`JSON.stringify({ page: location.protocol, secure: window.isSecureContext })`);
console.log('page context:', mixed);
h.chrome.kill('SIGKILL');
process.exit(0);
