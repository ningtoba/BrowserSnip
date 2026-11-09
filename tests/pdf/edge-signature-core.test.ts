/**
 * Signature and protection *core* — `docs/tasks/b4-request.md` items 1, 2, 4.
 *
 * Three promises the security tools could not keep without a workaround in their
 * own file:
 *
 * 1. "This document is not signed" must be an answer, not a crash. A PDF either
 *    has no `/AcroForm` or an `/AcroForm` with no `/Fields`, and handing that to
 *    `context.lookup(undefined, PDFArray)` threw.
 * 2. A timestamp has to be written into the *signature's* `/Contents`. Every page
 *    has a `/Contents` too, and they come first, so the signature dictionary is
 *    resolved through the form (`/SubFilter`) and its placeholder located exactly
 *    — an in-place rewrite one byte off invalidates the signature it dates.
 * 3. A permissions-only PDF (owner password, no user password) opens for anyone,
 *    so the guard must not demand a password for it, while still reporting the
 *    cipher and the `/P` flags.
 *
 * Fixtures are real PDFs built with `@maxwbh/pdf-lib` and signed with a throwaway
 * certificate; the parser is never mocked. The only stub is the RFC 3161
 * authority, which is a network peer.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { saveEncrypted } from '@/lib/pdf/core/doc';
import { inspectPdf, openPdfInput, preflightPdf } from '@/lib/pdf/core/guard';
import {
  createSelfSignedCertificate,
  readSignatures,
  signDocument,
  timestampBytes,
} from '@/lib/pdf/core/signature';

const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');
/** `id-aa-timeStampToken` — the attribute a trusted timestamp is stored under. */
const TIMESTAMP_TOKEN_OID = '1.2.840.113549.1.9.16.2.14';
/** `genTime` served by the stub authority: 2026-02-14T07:30:00Z. */
const GEN_TIME = '20260214073000Z';
const TSA_URL = 'http://ts.example.gov/rfc3161';

let certificate: { certificatePem: string; privateKeyPem: string };

beforeAll(async () => {
  // One RSA pair for the whole file; generating it is the slow part.
  certificate = await createSelfSignedCertificate('BrowserSnip Signature Core');
}, 120_000);

/** Two pages that each carry a real content stream, as any normal document does. */
async function drawnDoc(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Invoice 2026-014 page ${index + 1} — total 1,200.00 EUR`, {
      x: 36,
      y: 700,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return doc.save({ useObjectStreams: false });
}

async function sign(source: Uint8Array, fieldName = 'Sig1') {
  return signDocument(await PDFDocument.load(source), {
    certificate: encoder.encode(certificate.certificatePem),
    privateKey: encoder.encode(certificate.privateKeyPem),
    visible: false,
    fieldName,
  });
}

/** Every `/Contents` key in the file, in byte order. */
function contentsOffsets(bytes: Uint8Array): number[] {
  const text = latin1.decode(bytes);
  const offsets: number[] = [];
  for (let at = text.indexOf('/Contents'); at !== -1; at = text.indexOf('/Contents', at + 1)) {
    offsets.push(at);
  }
  return offsets;
}

/** The AcroForm dictionary of a document, whether the catalog inlines or points at it. */
function acroFormOf(doc: PDFDocument): PDFDict | undefined {
  const entry = doc.catalog.get(PDFName.of('AcroForm'));
  return entry instanceof PDFRef ? doc.context.lookup(entry, PDFDict) : (entry as PDFDict | undefined);
}

/**
 * A `TimeStampResp` the core can use: `SEQUENCE { PKIStatusInfo { status 0 },
 * token }`. The token only has to be an ASN.1 tree carrying `genTime`; the core
 * copies whatever it finds into the signer info's *unsigned* attributes.
 */
function tsaResponse(): ArrayBuffer {
  const universal = forge.asn1.Class.UNIVERSAL;
  const sequence = (children: forge.asn1.Asn1[]) =>
    forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, children);
  const token = sequence([
    forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer(TIMESTAMP_TOKEN_OID).getBytes()),
    forge.asn1.create(universal, forge.asn1.Type.GENERALIZEDTIME, false, GEN_TIME),
  ]);
  const response = sequence([sequence([
    forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(0)),
  ]), token]);
  const der = forge.asn1.toDer(response).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let index = 0; index < der.length; index++) bytes[index] = der.charCodeAt(index) & 0xff;
  return bytes.buffer;
}

/** Serve the stub token and record every URL the core posts to. */
function stubAuthority(calls: string[]): () => void {
  const real = globalThis.fetch;
  const body = tsaResponse();
  // jsdom's `Response` refuses an ArrayBuffer body, and the core reads nothing
  // but `ok` and `arrayBuffer()`, so the network peer is stood in for directly.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return { ok: true, arrayBuffer: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** The `/ByteRange` in the saved file, with the offset of its first digit. */
function readByteRange(bytes: Uint8Array): { digitsAt: number; values: number[] } | null {
  const match = /\/ByteRange\s*\[\s*(\d{10})\s+(\d{10})\s+(\d{10})\s+(\d{10})\s*\]/.exec(latin1.decode(bytes));
  if (!match) return null;
  return {
    digitsAt: match.index + match[0].indexOf(match[1]),
    values: [match[1], match[2], match[3], match[4]].map(Number),
  };
}

/** Rewrite the recorded ranges in place, keeping the fixed-width placeholder. */
function writeByteRange(bytes: Uint8Array, digitsAt: number, values: number[]): Uint8Array {
  const patched = new Uint8Array(bytes);
  const text = values.map((value) => String(value).padStart(10, '0')).join(' ');
  for (let index = 0; index < text.length; index++) patched[digitsAt + index] = text.charCodeAt(index);
  return patched;
}

describe('readSignatures on an unsigned document (b4 #1)', () => {
  it('answers "no signatures" for a document with no form', async () => {
    const source = await drawnDoc();
    expect(acroFormOf(await PDFDocument.load(source))).toBeUndefined();
    await expect(readSignatures(source)).resolves.toEqual([]);
  }, 60_000);

  it('answers "no signatures" for a form that declares no field list', async () => {
    // The other half of the case: producers that write an `/AcroForm` of defaults
    // with no `/Fields` key at all, so the entry the verifier looked up by type
    // was `undefined`.
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    doc.catalog.set(
      PDFName.of('AcroForm'),
      doc.context.register(doc.context.obj({ DA: '/Helv 12 Tf 0 g' })),
    );
    const source = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    expect(latin1.decode(source)).toMatch(/\/AcroForm/);
    expect(latin1.decode(source)).not.toMatch(/\/Fields/);

    await expect(readSignatures(source)).resolves.toEqual([]);
  }, 60_000);

  it('ignores form fields that are not signatures', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    doc.getForm().createTextField('Notes');
    const source = await doc.save({ useObjectStreams: false });
    expect(latin1.decode(source)).toMatch(/\/FT\s*\/Tx/);
    await expect(readSignatures(source)).resolves.toEqual([]);
  }, 60_000);

  it('still verifies a signature it made, including the field name', async () => {
    const signed = await sign(await drawnDoc());
    const read = await readSignatures(signed.bytes);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      fieldName: 'Sig1',
      digestMatches: true,
      signer: 'BrowserSnip Signature Core',
    });
    expect(read[0].error).toBeUndefined();
  }, 120_000);

  it('follows /Fields when the form stores it as a reference', async () => {
    const signed = await sign(await drawnDoc());
    const doc = await PDFDocument.load(signed.bytes);
    const acroForm = acroFormOf(doc);
    expect(acroForm?.get(PDFName.of('Fields'))).toBeInstanceOf(PDFArray);
    acroForm?.set(PDFName.of('Fields'), doc.context.register(acroForm.get(PDFName.of('Fields')) as PDFArray));

    const read = await readSignatures(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
    expect(read).toHaveLength(1);
    expect(read[0].fieldName).toBe('Sig1');
  }, 120_000);
});

describe('timestampBytes locates the signature (b4 #2)', () => {
  it('is aimed at a file whose page content comes first', async () => {
    const signed = await sign(await drawnDoc());
    const offsets = contentsOffsets(signed.bytes);
    // Two pages plus the signature: `indexOf('/Contents')` found the first of
    // these — a page's content-stream array — and called it a bad PKCS#7.
    expect(offsets.length).toBeGreaterThanOrEqual(3);
    expect(latin1.decode(signed.bytes).slice(offsets[0], offsets[0] + 24)).toMatch(/\/Contents\s*\[?\s*\d+\s+\d+\s+R/);
  }, 120_000);

  it('timestamps a real signature in place and leaves the signature intact', async () => {
    const signed = await sign(await drawnDoc());
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      const result = await timestampBytes(signed.bytes, { tsaUrl: TSA_URL });
      // It found a signature worth asking about — one request, to the right URL.
      expect(calls).toEqual([TSA_URL]);
      expect(result.attestedAt).toEqual(new Date(Date.UTC(2026, 1, 14, 7, 30, 0)));
      expect(result.authority).toBe('ts.example.gov');
      // The token is patched in: the file keeps its length and gains the
      // timestamp attribute where the signature placeholder lives.
      expect(result.bytes.length).toBe(signed.bytes.length);
      const tokenHex = forge.util.bytesToHex(forge.asn1.oidToDer(TIMESTAMP_TOKEN_OID).getBytes());
      expect(latin1.decode(result.bytes)).toContain(tokenHex);
      expect(latin1.decode(signed.bytes)).not.toContain(tokenHex);
      // The exactness proof: with the splice inside the placeholder, the bytes
      // the signature covers still hash to the stored digest.
      const read = await readSignatures(result.bytes);
      expect(read).toHaveLength(1);
      expect(read[0].digestMatches).toBe(true);
      expect(read[0].error).toBeUndefined();
      expect(read[0].byteRange).toEqual(signed.byteRange);
    } finally {
      restore();
    }
  }, 180_000);

  it('stamps the field it was asked for and says so when that name is absent', async () => {
    const signed = await sign(await drawnDoc(), 'Contract-42');
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      const named = await timestampBytes(signed.bytes, { tsaUrl: TSA_URL, fieldName: 'Contract-42' });
      expect(named.bytes.length).toBe(signed.bytes.length);
      expect(calls).toHaveLength(1);
      await expect(timestampBytes(signed.bytes, { tsaUrl: TSA_URL, fieldName: 'Other' }))
        .rejects.toThrow(/no signature field named "Other"/);
      expect(calls, 'a name that does not exist must not reach the authority').toHaveLength(1);
    } finally {
      restore();
    }
  }, 180_000);

  it('tells an unsigned document it was never signed', async () => {
    await expect(timestampBytes(await drawnDoc(), { tsaUrl: TSA_URL }))
      .rejects.toThrow(/has no signature to timestamp — sign it first/);
  }, 60_000);

  it('refuses to splice where /ByteRange says the placeholder is not', async () => {
    const signed = await sign(await drawnDoc());
    const declared = readByteRange(signed.bytes);
    expect(declared).not.toBeNull();
    const [offsetA, lengthA, offsetB, lengthB] = declared!.values;
    expect([offsetA, lengthA, offsetB, lengthB]).toEqual(signed.byteRange);
    // Claim the covered region runs 100 bytes into the placeholder.
    const lying = writeByteRange(
      signed.bytes,
      declared!.digitsAt,
      [offsetA, lengthA + 100, offsetB + 100, lengthB - 100],
    );
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      await expect(timestampBytes(lying, { tsaUrl: TSA_URL }))
        .rejects.toThrow(/could not be read from these bytes/);
    } finally {
      restore();
    }
    expect(calls, 'a signature it cannot splice must not be sent to the authority').toEqual([]);
  }, 180_000);

  it('does not touch the signature when it refuses', async () => {
    const signed = await sign(await drawnDoc());
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      await expect(timestampBytes(signed.bytes, { tsaUrl: TSA_URL, fieldName: 'Nope' })).rejects.toThrow();
      const read = await readSignatures(signed.bytes);
      expect(read).toHaveLength(1);
      expect(read[0].digestMatches).toBe(true);
    } finally {
      restore();
    }
  }, 180_000);
});

/* ------------------------------------------------------------------- guard */

/** A document with restrictions recorded and no open password (E5, b4 #4). */
async function restrictionsOnly(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.addPage([300, 200]);
  return saveEncrypted(doc, {
    ownerPassword: 'owner-only',
    permissions: { printing: true, copying: false, modifying: false },
  });
}

/** A document with a real user password: opening it genuinely needs one (E4). */
async function locked(password = 'hunter2'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return saveEncrypted(doc, { userPassword: password, ownerPassword: password });
}

const asSource = (bytes: Uint8Array, name: string) => ({
  name,
  size: bytes.length,
  blob: () => new Blob([new Uint8Array(bytes) as BlobPart], { type: 'application/pdf' }),
});

describe('the guard reports the user password, not the trailer (b4 #4)', () => {
  it('opens a permissions-only PDF without asking for a password', async () => {
    const seen = await inspectPdf(await restrictionsOnly(), 'perm.pdf');
    expect(seen.needsPassword).toBe(false);
    expect(seen.error).toBeNull();
    expect(seen.opensWithEmptyPassword).toBe(true);
    expect(seen.message).toMatch(/Restricted, not locked/);
    // …while still telling the tools what the file really is: a gate whose crypt
    // filter is /None, so no cipher is claimed for bytes that carry none.
    expect(seen.encrypted).toBe(true);
    expect(seen.algorithm).toBe('no cipher');
    expect(seen.pages).toBe(2);
    expect(seen.permissions).toMatchObject({ printing: true, copying: false, modifying: false });
  }, 60_000);

  it('hands the gate a usable document for a restricted file', async () => {
    const opened = await openPdfInput(await restrictionsOnly(), 'perm.pdf');
    expect(opened.doc.getPageCount()).toBe(2);
    expect(opened.inspection.error).toBeNull();
    expect(opened.inspection.needsPassword).toBe(false);
  }, 60_000);

  it('still asks for a password when the user password is set (E4)', async () => {
    const seen = await inspectPdf(await locked(), 'contract.pdf');
    expect(seen.needsPassword).toBe(true);
    expect(seen.error).toBe('PASSWORD_REQUIRED');
    expect(seen.opensWithEmptyPassword).toBe(false);
    expect(seen.encrypted).toBe(true);
    expect(seen.algorithm).toBe('no cipher');
    await expect(openPdfInput(await locked(), 'contract.pdf')).rejects.toMatchObject({
      code: 'PASSWORD_REQUIRED',
      fileName: 'contract.pdf',
    });
  }, 60_000);

  it('accepts a password on both kinds, and rejects a wrong one only where it matters (E5)', async () => {
    const restricted = await inspectPdf(await restrictionsOnly(), 'perm.pdf', { password: 'owner-only' });
    expect(restricted.error).toBeNull();
    expect(restricted.passwordAccepted).toBe(true);
    expect(restricted.opensWithEmptyPassword).toBe(true);

    const right = await inspectPdf(await locked(), 'contract.pdf', { password: 'hunter2' });
    expect(right.error).toBeNull();
    expect(right.passwordAccepted).toBe(true);

    const wrong = await inspectPdf(await locked(), 'contract.pdf', { password: 'butter3' });
    expect(wrong.error).toBe('BAD_PASSWORD');
    expect(wrong.needsPassword).toBe(true);
    expect(wrong.passwordAccepted).toBe(false);
  }, 60_000);

  it('refuses a locked file at the pre-flight but waves a restricted one through', async () => {
    const refusal = await preflightPdf(asSource(await locked(), 'locked.pdf'));
    expect(refusal?.code).toBe('PASSWORD_REQUIRED');
    expect(refusal?.message).toMatch(/"locked\.pdf" is password protected/);

    expect(await preflightPdf(asSource(await restrictionsOnly(), 'perm.pdf'))).toBeNull();
    expect(await preflightPdf(asSource(await locked(), 'locked.pdf'), 'hunter2')).toBeNull();
    expect((await preflightPdf(asSource(new Uint8Array(0), 'empty.pdf')))?.code).toBe('EMPTY_FILE');
  }, 60_000);

  it('keeps the no-parse pass conservative, since it cannot read the hash', async () => {
    const cheap = await inspectPdf(await restrictionsOnly(), 'perm.pdf', { cheap: true });
    expect(cheap.encrypted).toBe(true);
    expect(cheap.needsPassword).toBe(true);
    // The cheap answer is only "there is an /Encrypt entry"; `preflightPdf`
    // re-asks the parser before it refuses the file.
    expect(await preflightPdf(asSource(await restrictionsOnly(), 'perm.pdf'))).toBeNull();
  }, 60_000);

  it('proves the trap from the reader\'s point of view', async () => {
    // The file the guard used to call locked really does open on the empty
    // password, which is why demanding one blocked `remove-restrictions` (E4/E5).
    const source = await restrictionsOnly();
    const doc = await PDFDocument.load(source, { password: '' });
    expect(doc.isEncrypted).toBe(true);
    expect(doc.getPageCount()).toBe(2);
    const seen = await inspectPdf(source, 'perm.pdf');
    expect([seen.encrypted, seen.needsPassword, seen.error]).toEqual([true, false, null]);
  }, 60_000);
});
