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
