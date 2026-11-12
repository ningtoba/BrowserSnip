/**
 * `timestamp-pdf`, measured on the chain the tool itself asks for.
 *
 * Its refusal message says *"Run Digital Signature on it first, then timestamp the
 * signed file"* — so that is the sequence driven, on the deployed site and here. The
 * deployed run (log `docs/research/timestamp-deployed.log`) refused the file
 * `digital-sign-pdf` had just produced:
 *
 * > The existing signature could not be read from these bytes: its `/Contents` value
 * > is not a hexadecimal string that `/ByteRange` covers, so no timestamp was added.
 *
 * The cause was the caller, not the reader: the tool handed `core/signature` an
 * *opened document*, which `timestampDocument` re-saved before patching, and saving
 * moves the offsets `/ByteRange` names. It now passes the bytes that were read
 * (`tools/security.ts`), and the document-shaped entry point that made this possible
 * is gone. With that fixed the run reaches the network and stops there, which the
 * cases below pin as its own truth:
 *
 * | claim                                            | measured by                                       |
 * |--------------------------------------------------|---------------------------------------------------|
 * | a file this app signed can be timestamped         | the tool runs on `signDocument`'s own bytes         |
 * | the timestamp does not break the signature        | `readSignatures(...).digestMatches` before and after|
 * | the token is bound to the signature, not the page | the unsigned attribute carrying OID …14 in `/Contents` |
 * | "the only thing sent is a digest of the signature"| exactly one POST, to the address in the field       |
 * | no authority means no file, said out loud         | a rejecting `fetch` → refusal, zero outputs         |
 * | an unsigned document is still refused by name     | the chain sentence, unchanged                       |
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFName } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import {
  createSelfSignedCertificate,
  readSignatures,
  signDocument,
} from '@/lib/pdf/core/signature';

const TIMESTAMP_TOKEN_OID = '1.2.840.113549.1.9.16.2.14';
const GEN_TIME = '20261111120000Z';
const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

let certificate: { certificatePem: string; privateKeyPem: string };
beforeAll(async () => {
  certificate = await createSelfSignedCertificate('Ada Lovelace');
});

async function signedSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([400, 300]);
  const signed = await signDocument(doc, {
    certificate: encoder.encode(certificate.certificatePem),
    privateKey: encoder.encode(certificate.privateKeyPem),
    reason: 'I approve this document',
    fieldName: 'Signature1',
  });
  return signed.bytes;
}

/** A `TimeStampResp` the core accepts: status 0 plus a token carrying `genTime`. */
function tsaResponse(): ArrayBuffer {
  const universal = forge.asn1.Class.UNIVERSAL;
  const sequence = (children: forge.asn1.Asn1[]) =>
    forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, children);
  const token = sequence([
    forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer(TIMESTAMP_TOKEN_OID).getBytes()),
    forge.asn1.create(universal, forge.asn1.Type.GENERALIZEDTIME, false, GEN_TIME),
  ]);
  const response = sequence([
    sequence([forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(0))]),
    token,
  ]);
  const der = forge.asn1.toDer(response).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let index = 0; index < der.length; index++) bytes[index] = der.charCodeAt(index) & 0xff;
  return bytes.buffer;
}

function stubAuthority(calls: string[], fail = false): () => void {
  const real = globalThis.fetch;
  const body = tsaResponse();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (fail) throw new TypeError('Failed to fetch');
    return { ok: true, arrayBuffer: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function timestamp(bytes: Uint8Array, values: Record<string, unknown> = {}) {
  return (await runPdfTool({
    toolId: 'timestamp-pdf',
    files: [new File([bytes], 'contract_signed.pdf', { type: 'application/pdf' })],
    values: { tsa: 'https://tsa.example.org/tsa', fieldName: '', ...values },
    onProgress: () => {},
    onLog: () => {},
  })) as unknown as { outputs: { blob: Blob }[]; message?: string; warnings: string[] };
}

const fileBytes = async (outcome: { outputs: { blob: Blob }[] }) =>
  new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());

afterEach(() => {
  vi.useRealTimers();
});

describe('timestamping the file this app signed', () => {
  it('accepts its own signature instead of refusing the chain it asks for', async () => {
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      const signed = await signedSource();
      const outcome = await timestamp(signed);
      expect(outcome.outputs.length, `no file: ${outcome.message ?? ''} ${outcome.warnings.join(' ')}`)
        .toBeGreaterThan(0);
      expect(calls, 'exactly one request, to the address in the field').toEqual(['https://tsa.example.org/tsa']);
      expect(outcome.message).toMatch(/Timestamped at 2026-11-11T12:00:00\.000Z/);
      expect(outcome.warnings.join(' ')).toMatch(/covers the signature, not the document/);
      expect(outcome.warnings.join(' ')).toMatch(/https:\/\/tsa\.example\.org\/tsa/);
    } finally {
      restore();
    }
  });

  it('leaves the signature verifying, and binds the token to it', async () => {
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      const signed = await signedSource();
      const before = await readSignatures(signed);
      expect(before[0]?.digestMatches, 'the starting signature did not verify').toBe(true);

      const stamped = await fileBytes(await timestamp(signed));
      const after = await readSignatures(stamped);
      expect(after, 'the signature disappeared from the timestamped file').toHaveLength(1);
      expect(after[0].digestMatches, 'timestamping broke the signature it was added to').toBe(true);
      expect(after[0].fieldName).toBe('Signature1');

      // The token lives in the signature's *unsigned* attributes, which is why adding
      // it cannot invalidate the digest over the document. Its DER shows up inside the
      // hex `/Contents` string of the saved file, which is what a reader parses.
      const doc = await PDFDocument.load(stamped);
      // The attribute's own OID, as DER: `06 0B 2A 86 48 86 F7 0D 01 09 10 02 0E`.
      const tokenDer = forge.asn1.oidToDer(TIMESTAMP_TOKEN_OID).getBytes();
      const flat = latin1.decode(stamped).replace(/\s+/g, '').toLowerCase();
      // `/Contents` may be written as a hex string or as a binary literal, so the
      // token is looked for in whichever spelling the file actually uses.
      const present = (bytes: string) => {
        const raw = latin1.decode(new Uint8Array([...bytes].map((c) => c.charCodeAt(0) & 0xff)))
          .replace(/\s+/g, '').toLowerCase();
        return flat.includes(raw) || flat.includes(forge.util.bytesToHex(bytes).toLowerCase());
      };
      expect(present(tokenDer), 'no timestamp attribute in the saved signature').toBe(true);
      expect(present(GEN_TIME), 'the token carries no genTime').toBe(true);

      expect(doc.getPageCount()).toBe(2);
      expect(stamped.length).toBeGreaterThanOrEqual(signed.length - 4);
    } finally {
      restore();
    }
  });

  it('says so, and writes nothing, when the authority cannot be reached', async () => {
    const calls: string[] = [];
    const restore = stubAuthority(calls, true);
    try {
      const failure = await timestamp(await signedSource()).catch((error: unknown) => error);
      expect(calls.length).toBe(1);
      const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
      expect(text).not.toBe('undefined');
      expect(text).toMatch(/could not be reached/i);
      expect(text).toMatch(/https:\/\/tsa\.example\.org\/tsa/);
      // Product truth, in the tool's own words: this step needs a connection.
      expect(text).toMatch(/only step in BrowserSnip that needs the network/i);
      expect(text).toMatch(/signature digest, never the document/i);
    } finally {
      restore();
    }
  });

  it('still refuses a file that was never signed, in the same words', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const failure = await timestamp(await doc.save({ useObjectStreams: false })).catch((error: unknown) => error);
    const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
    expect(text).toMatch(/no digital signature to timestamp/i);
    expect(text).toMatch(/Run Digital Signature on it first/i);
  });
});
