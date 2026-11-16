/**
 * `digital-sign-pdf`, judged on whether it signs anything at all.
 *
 * The card makes a security claim — "Sign with an X.509 certificate so tampering is
 * detectable", "A signature that covers the bytes: change anything afterwards and
 * validation says so" — so this is held to that standard rather than to "a /Sig key
 * appeared somewhere". Four questions, each answered from the produced bytes:
 *
 * 1. is there a signature *field* — `/FT /Sig`, an `/ Adobe.PPKLite` signer with an
 *    `adbe.pkcs7.detached` value and a `/ByteRange` that tiles the file?
 * 2. does the digest match those bytes, and does one flipped byte inside them stop
 *    matching? (`readSignatures` is this app's reader; the outside judgement —
 *    `openssl cms -verify`, "CMS Verification successful", and failure on a tampered
 *    copy — is in `docs/research/digital-deployed.log`.)
 * 3. does the sentence the tool print come from `/ByteRange`, or from the size of the
 *    signature blob? It used to report `1.38 KiB of the file` — the CMS length — for a
 *    file whose signed span was 3.34 KiB of 19.34 KiB.
 * 4. does the visible block land on the page the field named, inside that page's box?
 * 5. does the block *paint* — a name, a date and a rule the reader can see? The first
 *    four questions were all green while `/Rect` was the only thing written: a widget
 *    with no `/AP` adds **0** dark pixels, so "Show a visible signature block" painted
 *    a bordered box that nobody could see. `appearance-harness.ts` measures the stream
 *    in pt², and `visible: false` is the control that must measure none.
 * 6. are `/Name`, `/Reason` and `/Location` text strings (`/Name` = the *signer*, not
 *    `Signature8563`), the widget `/Parent`ed to its field, and is the earlier
 *    signature's fate reported when a signed file is signed again?
 *
 * Nothing here needs a server: the certificate and key are handed in as files and the
 * signature is made in-process. Only `timestamp-pdf` reaches the network, and it says
 * so on its own card.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFDict, PDFName } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool, type PdfToolDefinition } from '@/lib/pdf/tools/registry';
import type { ToolValues } from '@/lib/pdf/tools/types';
import {
  createSelfSignedCertificate,
  readSignatures,
  signDocument,
} from '@/lib/pdf/core/signature';
import { appearanceInk } from './appearance-harness';
import { openPDF, saveEncrypted, savePDF } from '@/lib/pdf/core/doc';

const latin1 = new TextDecoder('latin1');

/** Page 1 and 2 are A4, page 3 is a 400x300 sheet, so a wrong page is visible. */
async function mixedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  doc.addPage([400, 300]);
  return doc.save({ useObjectStreams: false });
}

const asFile = (bytes: Uint8Array | string, name: string, mime: string) =>
  new File([bytes as BlobPart], name, { type: mime });

const bytes = (text: string) => new TextEncoder().encode(text);

function formDictOf(doc: PDFDocument): PDFDict | undefined {
  const root = doc.context.lookup(doc.context.trailerInfo.Root) as PDFDict;
  const form = root.get(PDFName.of('AcroForm'));
  return form === undefined ? undefined : (doc.context.lookup(form) as PDFDict);
}

/** The signature dictionary of the first `/Sig` field, read off the saved file. */
function signatureOf(doc: PDFDocument): { field: PDFDict; value: PDFDict } {
  const form = formDictOf(doc);
  expect(form, 'the signed file has no /AcroForm').not.toBeUndefined();
  const fields = doc.context.lookup((form as PDFDict).get(PDFName.of('Fields'))) as PDFArray;
  expect(fields.size(), 'the form has no fields').toBeGreaterThan(0);
  for (const entry of fields.asArray()) {
    const field = doc.context.lookup(entry) as PDFDict;
    if (String(field.get(PDFName.of('FT'))) === '/Sig') {
      const value = doc.context.lookup(field.get(PDFName.of('V'))) as PDFDict;
      expect(value, 'the /Sig field has no /V').not.toBeUndefined();
      return { field, value };
    }
  }
  throw new Error('no /Sig field in the form');
}

function byteRangeOf(doc: PDFDocument, value: PDFDict): number[] {
  const span = value.get(PDFName.of('ByteRange'));
  expect(span, 'the signature has no /ByteRange').not.toBeUndefined();
  return (doc.context.lookup(span) as PDFArray).asArray().map((n) => Number(String(n)));
}

const resultLength = (bytes: Uint8Array) => bytes.length;

describe('a digital signature signs the bytes it says it signs', () => {
  it('writes a /Sig field whose /ByteRange covers the whole file but its own placeholder', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const source = await mixedFixture();
    const doc = await PDFDocument.load(source);
    const result = await signDocument(doc, {
      certificate: bytes(cert.certificatePem),
      privateKey: bytes(cert.privateKeyPem),
      reason: 'I approve this document',
      page: 2,
    });

    const signed = await PDFDocument.load(result.bytes);
    const { field, value } = signatureOf(signed);
    expect(String(value.get(PDFName.of('Filter')))).toBe('/Adobe.PPKLite');
    expect(String(value.get(PDFName.of('SubFilter')))).toBe('/adbe.pkcs7.detached');
    expect(String(field.get(PDFName.of('FT')))).toBe('/Sig');

    const [start, first, secondStart, secondLength] = byteRangeOf(signed, value);
    const fileLength = result.bytes.length;
    expect(start).toBe(0);
    expect(secondStart + secondLength, 'the ranges must end at the end of the file').toBe(fileLength);
    const placeholder = secondStart - first;
    expect(placeholder, 'the gap must be the /Contents placeholder, not unsigned content')
      .toBeGreaterThan(0);
    expect(first + secondLength, 'the covered bytes are the file minus the placeholder')
      .toBe(fileLength - placeholder);
    expect(result.byteRange).toEqual([start, first, secondStart, secondLength]);
  });

  it('verifies against its own bytes and stops verifying when one of them moves', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const doc = await PDFDocument.load(await mixedFixture());
    const result = await signDocument(doc, {
      certificate: bytes(cert.certificatePem),
      privateKey: bytes(cert.privateKeyPem),
    });

    const [asWritten] = await readSignatures(result.bytes);
    expect(asWritten, 'the signature cannot be read back at all').toBeTruthy();
    expect(asWritten.digestMatches, 'the digest does not match the bytes it claims').toBe(true);
    expect(asWritten.signer).toContain('Ada Lovelace');
    expect(String(asWritten.digestAlgorithm).replace('-', '').toLowerCase()).toBe('sha256');

    /**
     * `intact` is the only answer that means "nobody would notice". A file the reader
     * cannot parse at all is still a detected change; it is reported separately
     * because the message a user then sees is an error, not "signature invalid".
     */
    const verdict = async (candidate: Uint8Array): Promise<string> => {
      try {
        const [entry] = await readSignatures(candidate);
        return entry?.digestMatches ? 'intact' : `digest does not match (${entry?.error ?? 'parsed'})`;
      } catch (error) {
        return `unreadable: ${error instanceof Error ? error.message.slice(0, 60) : 'parse failed'}`;
      }
    };

    const [firstStart, firstLength, secondStart, secondLength] = result.byteRange;
    const text = latin1.decode(result.bytes);
    // Inside a stream's stored bytes: the `/Length` is untouched, so the file still
    // parses, and only the digest can tell the page changed.
    const streamAt = text.indexOf('stream', firstStart + 8);
    const spots: Array<[string, number]> = [
      ['page content of the first span', streamAt + 40],
      ['a second stream in the first span', text.indexOf('stream', streamAt + 60) + 30],
      ['the last span of the file', secondStart + Math.floor(secondLength / 2)],
      ['the signature placeholder itself', firstStart + firstLength + 4],
    ];
    for (const [label, offset] of spots) {
      expect(offset, `${label}: no such offset in a ${result.bytes.length}-byte file`)
        .toBeGreaterThan(0);
      const moved = new Uint8Array(result.bytes);
      moved[offset] ^= 0x01;
      const answer = await verdict(moved);
      const covered = offset < firstLength || offset >= secondStart;
      if (covered && label !== 'the signature placeholder itself') {
        expect(answer, `a flipped byte at ${offset} (${label}) went undetected`).not.toBe('intact');
      }
    }
  });

  it('says the coverage from /ByteRange, not the length of the signature blob', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const tool = getPdfTool('digital-sign-pdf') as PdfToolDefinition;
    expect(tool, 'the tool is not registered').toBeTruthy();
    // The card's promise is about the bytes; the notes must not promise a server.
    expect(tool.promise).toMatch(/covers the bytes/i);
    expect(`${tool.promise} ${tool.notes?.join(' ') ?? ''}`).toMatch(/never leaves this tab|local|in your browser/i);
    const values: ToolValues = {
      certificate: [{ name: 'ada.pem', mimeType: 'application/x-x509-ca-cert', size: cert.certificatePem.length, bytes: bytes(cert.certificatePem) }],
      privateKey: [{ name: 'ada.key.pem', mimeType: 'application/x-pem-file', size: cert.privateKeyPem.length, bytes: bytes(cert.privateKeyPem) }],
      reason: 'I approve this document',
      location: 'Cambridge',
      contact: '',
      visible: true,
      page: 3,
    };
    const outcome = (await runPdfTool({
      toolId: 'digital-sign-pdf',
      files: [asFile(await mixedFixture(), 'ruled.pdf', 'application/pdf')],
      values,
      onProgress: () => {},
      onLog: () => {},
    })) as unknown as { outputs: { blob: Blob }[]; message?: string; warnings: string[] };

    const produced = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const signed = await PDFDocument.load(produced);
    const { field, value } = signatureOf(signed);
    const [, first, secondStart, secondLength] = byteRangeOf(signed, value);
    const covered = first + secondLength;
    const placeholder = secondStart - first;
    const message = outcome.message ?? '';
    // The words have to come from the same numbers as the file. `formatBytes` is
    // KiB to two decimals; assert on the pair rather than the string so a reformat
    // cannot quietly restore the old meaning.
    const stated = [...message.matchAll(/([\d.]+) (B|KiB|MB)/g)].map((m) => ({
      bytes: Number(m[1]) * (m[2] === 'KiB' ? 1024 : m[2] === 'MB' ? 1024 * 1024 : 1),
      // "17.7 KiB" is a rounding of anything within half a tenth of a KiB, so the
      // test asks whether the number could be the byte count, not whether it prints
      // identically: formatBytes keeps three significant digits.
      room: (m[2] === 'B' ? 1 : 1024) / 10 ** ((m[1].split('.')[1] ?? '').length) / 2 + 1,
    }));
    const names = (target: number) => stated.some((entry) => Math.abs(entry.bytes - target) <= entry.room);
    expect(names(covered), `the message does not state the covered length (${covered}): ${message}`)
      .toBe(true);
    expect(names(placeholder), `the message does not name the placeholder it excludes (${placeholder}): ${message}`)
      .toBe(true);
    expect(names(resultLength(produced)), `the message does not state the file length: ${message}`)
      .toBe(true);
    expect(message).toContain('verifies against those bytes');
    expect(message).not.toMatch(/covers .{0,12}of the file and verifies$/);
    expect(latin1.decode(produced).length).toBe(produced.length);

    // The block was asked for on page 3, which is the 400x300 sheet. The widget is a
    // kid of the /Sig field, and the page must point back at it, or no viewer paints it.
    const kids = signed.context.lookup(field.get(PDFName.of('Kids'))) as PDFArray;
    expect(kids, 'the signature field has no widget, so nothing is visible').not.toBeUndefined();
    const widget = signed.context.lookup(kids.asArray()[0]) as PDFDict;
    const rect = (signed.context.lookup(widget.get(PDFName.of('Rect'))) as PDFArray)
      .asArray().map((n) => Number(String(n)));
    expect(rect.length).toBe(4);
    const [x0, y0, x1, y1] = rect;
    expect([x0 >= 0, y0 >= 0, x1 <= 400, y1 <= 300], `the block is outside the 400x300 sheet: ${rect}`)
      .toEqual([true, true, true, true]);
    expect(x1 - x0, 'the block has no width').toBeGreaterThan(40);
    expect(y1 - y0, 'the block has no height').toBeGreaterThan(20);
    const widgetPage = signed.getPage(2);
    expect(widgetPage.node.get(PDFName.of('Annots')), 'the block is not annotated onto the page it was aimed at')
      .not.toBeUndefined();
  });
});

/** The widget kid of the first `/Sig` field, and the box the file already had there. */
function widgetOf(doc: PDFDocument): PDFDict {
  const { field } = signatureOf(doc);
  const kids = doc.context.lookup(field.get(PDFName.of('Kids'))) as PDFArray;
  expect(kids, 'the field has no widget').not.toBeUndefined();
  return doc.context.lookup(kids.asArray()[0]) as PDFDict;
}

const decoded = (value: unknown): string | null =>
  value === undefined || value === null ? null : (value as { decodeText?: () => string }).decodeText?.() ?? null;

describe('the visible block is drawn, and says who and when', () => {
  it('paints a rule, the signer and the date inside the box, and names the signer in /Name', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const doc = await PDFDocument.load(await mixedFixture());
    const result = await signDocument(doc, {
      certificate: bytes(cert.certificatePem),
      privateKey: bytes(cert.privateKeyPem),
      reason: 'I approve this document',
      location: 'Cambridge',
      contact: '',
      visible: true,
      page: 2,
    });

    const signed = await PDFDocument.load(result.bytes);
    const { field, value } = signatureOf(signed);
    const widget = widgetOf(signed);
    // No `/AP` at all is the defect this test exists for: `/Rect` alone renders as paper.
    const painted = appearanceInk(signed, widget);
    expect(painted.ops, 'the widget carries no appearance stream').not.toBe('');
    expect(painted.inkPt2, `the appearance paints no area: ${painted.ops}`).toBeGreaterThan(500);
    expect(painted.ops).toContain('Digitally signed by');
    expect(painted.ops).toContain('Ada Lovelace');
    expect(painted.ops).toMatch(/Date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(painted.ops).toContain('Reason: I approve this document');

    // The stream is a Form XObject: without `/BBox` and a font the reader paints nothing.
    const ap = signed.context.lookup(widget.get(PDFName.of('AP'))) as PDFDict;
    const normal = signed.context.lookup(ap.get(PDFName.of('N'))) as unknown as { dict: PDFDict };
    expect(String(normal.dict.get(PDFName.of('Subtype')))).toBe('/Form');
    expect(normal.dict.get(PDFName.of('Resources')), 'the stream has no font to draw with')
      .not.toBeUndefined();
    const box = (signed.context.lookup(normal.dict.get(PDFName.of('BBox'))) as PDFArray).asArray().map(Number);
    const rect = (signed.context.lookup(widget.get(PDFName.of('Rect'))) as PDFArray).asArray().map(Number);
    // The appearance is clipped to its own box, so the box and the rect must agree.
    expect(box).toEqual([0, 0, rect[2] - rect[0], rect[3] - rect[1]]);

    // `/Name` is the signer's name (PDF 32000-1 §12.8.3 Table 252), not the field name.
    expect(decoded(value.get(PDFName.of('Name'))), 'the signature does not name the signer')
      .toBe('Ada Lovelace');
    expect(decoded(value.get(PDFName.of('Reason')))).toBe('I approve this document');
    expect(decoded(value.get(PDFName.of('Location')))).toBe('Cambridge');
    // An empty box is left out rather than written as a bare `/` (an empty *name*).
    expect(value.get(PDFName.of('ContactInfo'))).toBeUndefined();
    expect(String(value.get(PDFName.of('Reason')))).not.toMatch(/^\/[^<]/);

    // The widget is the appearance *of* that field, not a second signature.
    const parent = signed.context.lookup(widget.get(PDFName.of('Parent'))) as PDFDict;
    expect(String(parent.get(PDFName.of('FT')))).toBe('/Sig');
    expect(String(parent.get(PDFName.of('V')))).toBe(String(field.get(PDFName.of('V'))));
    // The widget repeats no `/FT`, `/T` or `/V`: pypdf read a duplicated set as a
    // second field named `/Signature1./Signature1`.
    expect(widget.get(PDFName.of('T'))).toBeUndefined();
    expect(widget.get(PDFName.of('V'))).toBeUndefined();
  });

  it('leaves the page untouched when the block is switched off, and names the field uniquely', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const doc = await PDFDocument.load(await mixedFixture());
    const result = await signDocument(doc, {
      certificate: bytes(cert.certificatePem),
      privateKey: bytes(cert.privateKeyPem),
      visible: false,
      page: 0,
    });

    const signed = await PDFDocument.load(result.bytes);
    const widget = widgetOf(signed);
    expect(widget.get(PDFName.of('AP')), 'an invisible signature must not paint a box').toBeUndefined();
    expect(appearanceInk(signed, widget).inkPt2).toBe(0);
    // The control for the ink above: an empty stream and an absent one are different
    // things, and only the absent one means "invisible".
    expect(signatureOf(signed).field.get(PDFName.of('T'))).toBeDefined();
    expect(String(signatureOf(signed).field.get(PDFName.of('T')))).toBe('/Signature1');
  });
});

describe('signing an already signed file', () => {
  it('keeps both signatures readable but reports that the first no longer matches', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const certificate = bytes(cert.certificatePem);
    const privateKey = bytes(cert.privateKeyPem);
    const first = await signDocument(await PDFDocument.load(await mixedFixture()), { certificate, privateKey });

    const tool = getPdfTool('digital-sign-pdf') as PdfToolDefinition;
    const outcome = (await runPdfTool({
      toolId: 'digital-sign-pdf',
      files: [asFile(first.bytes, 'once.pdf', 'application/pdf')],
      values: {
        certificate: [{ name: 'ada.pem', mimeType: 'application/x-x509-ca-cert', size: certificate.length, bytes: certificate }],
        privateKey: [{ name: 'ada.key.pem', mimeType: 'application/x-pem-file', size: privateKey.length, bytes: privateKey }],
        visible: true,
        page: 1,
        reason: '',
      } satisfies ToolValues,
      onProgress: () => {},
      onLog: () => {},
    })) as unknown as { outputs: { blob: Blob }[]; message?: string; warnings: string[]; error?: string };
    expect(outcome.error, outcome.error).toBeUndefined();

    const twice = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const both = await readSignatures(twice);
    expect(both.length, 'the second run lost a signature').toBe(2);
    expect(both[1].digestMatches, 'the new signature does not verify').toBe(true);
    // Rewriting the file is what breaks the first one; the sentence has to say so.
    expect(both[0].digestMatches).toBe(false);
    expect((outcome.warnings ?? []).join(' ')).toMatch(/already in this document no longer match/);
    expect(outcome.message ?? '').toMatch(/verifies against those bytes/);

    // Two fields, two distinct names, or a reader addressing `/Signature1` hits both.
    const signed = await PDFDocument.load(twice);
    const form = formDictOf(signed) as PDFDict;
    const named = (signed.context.lookup(form.get(PDFName.of('Fields'))) as PDFArray).asArray()
      .map((ref) => String((signed.context.lookup(ref) as PDFDict).get(PDFName.of('T'))));
    expect(new Set(named).size, `field names collide: ${named.join(',')}`).toBe(named.length);
  });
});

describe('a sheet with no room, and a file that is locked', () => {
  it('shrinks and clamps the block inside a page smaller than it is', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const doc = await PDFDocument.create();
    doc.addPage([150, 100]);
    doc.addPage([420, 595]);
    const result = await signDocument(doc, {
      certificate: bytes(cert.certificatePem),
      privateKey: bytes(cert.privateKeyPem),
      reason: 'I approve this document',
      visible: true,
      page: 0,
    });

    const signed = await PDFDocument.load(result.bytes);
    const widget = widgetOf(signed);
    const rect = (signed.context.lookup(widget.get(PDFName.of('Rect'))) as PDFArray)
      .asArray().map(Number);
    const [x0, y0, x1, y1] = rect;
    // 220x90 on a 150x100 sheet used to be written as [36, -26, 256, 64]: two edges
    // of the box, and its border, hung off the paper.
    expect([x0 >= 0, y0 >= 0, x1 <= 150, y1 <= 100], `the block leaves the 150x100 sheet: ${rect}`)
      .toEqual([true, true, true, true]);
    expect(x1 - x0).toBeGreaterThan(100);
    expect(y1 - y0).toBeGreaterThan(70);
    // The appearance is clipped to its own box, so it has to follow the shrink.
    const painted = appearanceInk(signed, widget);
    expect(painted.inkPt2).toBeGreaterThan(500);
  });

  it('refuses a locked file and a permissions-only one instead of shipping a dead signature', async () => {
    const cert = await createSelfSignedCertificate('Ada Lovelace');
    const locked = await saveEncrypted(await PDFDocument.load(await mixedFixture()), {
      userPassword: 'hunter2',
      ownerPassword: 'hunter2',
    });
    const tool = getPdfTool('digital-sign-pdf') as PdfToolDefinition;
    const values = {
      certificate: [{ name: 'ada.pem', mimeType: 'application/x-x509-ca-cert', size: 1, bytes: bytes(cert.certificatePem) }],
      privateKey: [{ name: 'ada.key.pem', mimeType: 'application/x-pem-file', size: 1, bytes: bytes(cert.privateKeyPem) }],
      visible: true,
      page: 1,
      reason: '',
    } satisfies ToolValues;
    const gated = await saveEncrypted(await PDFDocument.load(await mixedFixture()), {
      ownerPassword: 'owner',
      permissions: { printing: true, copying: false, modifying: false },
    });
    const attempt = (file: Uint8Array, password?: string) => runPdfTool({
      toolId: 'digital-sign-pdf',
      files: [asFile(file, 'locked.pdf', 'application/pdf')],
      values,
      password,
      onProgress: () => {},
      onLog: () => {},
    }) as unknown as Promise<{ outputs: { blob: Blob }[] }>;

    // The guard asks for the password first; with it supplied the tool refuses,
    // because the re-encryption of the copy ciphers a signature that was just made.
    await expect(attempt(locked)).rejects.toThrow(/password protected/i);
    await expect(attempt(locked, 'hunter2')).rejects.toThrow(/is encrypted.*unlock it first/i);
    // A permissions-only file opens with no password at all and is refused all the same:
    // measured, its signature also comes back `digestMatches: false`.
    await expect(attempt(gated)).rejects.toThrow(/is encrypted.*unlock it first/i);
    // The control: the same document unlocked signs and verifies.
    const clear = await savePDF(await openPDF(locked, { password: 'hunter2' }));
    const signed = await attempt(clear);
    const [read] = await readSignatures(new Uint8Array(await signed.outputs[0].blob.arrayBuffer()));
    expect(read.digestMatches, 'the unlocked control does not verify').toBe(true);
  });
});
