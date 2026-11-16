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

/**
 * A `TimeStampResp` shaped the way RFC 3161 shapes it, because the flat stub this
 * file used to serve — `SEQUENCE { PKIStatusInfo, SEQUENCE { OID, GeneralizedTime } }`
 * — could not tell a token from a tree: it carried no `TSTInfo`, so nothing read
 * the attested time out of it, and the nonce had nothing to be compared with.
 *
 * `TimeStampResp { PKIStatusInfo { 0 }, ContentInfo { id-ct-TSTInfo, [0]
 * SignedData { version, digestAlgorithms, encapContentInfo { id-ct-TSTInfo,
 * [0] TSTInfo } } } }`, and the `TSTInfo` carries the echoed nonce the request asked
 * with. It also **parses the request**: the nonce has to be read out of a
 * `messageImprint`-shaped `TimeStampReq`, which is what the old request builder got
 * wrong.
 */
function tstInfo(nonce: string): forge.asn1.Asn1 {
  const universal = forge.asn1.Class.UNIVERSAL;
  const sequence = (children: forge.asn1.Asn1[]) =>
    forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, children);
  return sequence([
    forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(1)),
    forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer('1.2.3.4.1').getBytes()),
    sequence([
      sequence([
        forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
        forge.asn1.create(universal, forge.asn1.Type.NULL, false, ''),
      ]),
      forge.asn1.create(universal, forge.asn1.Type.OCTETSTRING, false, forge.random.getBytesSync(32)),
    ]),
    forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(9)),
    forge.asn1.create(universal, forge.asn1.Type.GENERALIZEDTIME, false, GEN_TIME),
    forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, nonce),
  ]);
}

function tsaResponse(nonce: string): ArrayBuffer {
  const universal = forge.asn1.Class.UNIVERSAL;
  const sequence = (children: forge.asn1.Asn1[]) =>
    forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, children);
  const tstDer = forge.asn1.toDer(tstInfo(nonce)).getBytes();
  const token = sequence([
    forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer('1.2.840.113549.1.9.16.1.4').getBytes()),
    forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      sequence([
        forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(3)),
        forge.asn1.create(universal, forge.asn1.Type.SET, true, [
          sequence([
            forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
            forge.asn1.create(universal, forge.asn1.Type.NULL, false, ''),
          ]),
        ]),
        sequence([
          forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer('1.2.840.113549.1.9.16.1.4').getBytes()),
          forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
            forge.asn1.create(universal, forge.asn1.Type.OCTETSTRING, false, tstDer),
          ]),
        ]),
      ]),
    ]),
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

/** The nonce the request asked with — the INTEGER that is not the version. */
function nonceOfRequest(body: Uint8Array): string {
  const request = forge.asn1.fromDer(forge.util.binary.raw.encode(body), false);
  const members = (request.value ?? []) as forge.asn1.Asn1[];
  const nonce = members.slice(1).find(
    (member) => member.tagClass === forge.asn1.Class.UNIVERSAL && member.type === forge.asn1.Type.INTEGER,
  );
  return nonce && typeof nonce.value === 'string' ? nonce.value : '';
}

/**
 * Stand in for the authority.
 *
 * `fail` throws the way a blocked or offline request does; `status` answers the way
 * a reachable authority that will not take the request does. Every body is kept so a
 * case can measure the request itself, and `nonce` overrides the echo.
 */
function stubAuthority(
  calls: string[],
  options: { fail?: boolean; status?: number; nonce?: string; bodies?: Uint8Array[] } = {},
): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    // The body has to be *bytes*: a binary string body is UTF-8 encoded by
    // `fetch` and stops being DER. `bodies` records what arrived, and the shape
    // test below pins that it is a `Uint8Array`.
    const raw = init?.body as unknown;
    const body = raw instanceof Uint8Array
      ? raw
      : Uint8Array.from(String(raw), (character) => character.charCodeAt(0) & 0xff);
    options.bodies?.push(body);
    if (options.fail) throw new TypeError('Failed to fetch');
    if (options.status) return { ok: false, status: options.status } as unknown as Response;
    const answer = tsaResponse(options.nonce ?? nonceOfRequest(body));
    return { ok: true, arrayBuffer: async () => answer } as unknown as Response;
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
    const restore = stubAuthority(calls, { fail: true });
    try {
      const failure = await timestamp(await signedSource()).catch((error: unknown) => error);
      expect(calls.length).toBe(1);
      const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
      expect(text).not.toBe('undefined');
      expect(text).toMatch(/could not be reached/i);
      expect(text).toMatch(/https:\/\/tsa\.example\.org\/tsa/);
      // Product truth, in the tool's own words: this step needs a connection.
      expect(text).toMatch(/only step in BrowserSnip that needs the network/i);
      expect(text).toMatch(/digest of the signature value, never the document/i);
      // And said once: the core's sentence used to be wrapped inside the tool's,
      // so the card printed the address and the parenthesis twice over.
      expect(text.match(/could not be reached/gi), 'the failure is stated twice').toHaveLength(1);
      expect(text.match(/https:\/\/tsa\.example\.org\/tsa/g), 'the address is named twice').toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('sends a TimeStampReq an RFC 3161 parser accepts', async () => {
    const calls: string[] = [];
    const bodies: Uint8Array[] = [];
    const restore = stubAuthority(calls, { bodies });
    try {
      const shapes: string[] = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        shapes.push(init?.body instanceof Uint8Array ? 'bytes' : typeof init?.body);
        return real(input, init);
      }) as unknown as typeof fetch;
      await timestamp(await signedSource());
      expect(bodies, 'no request reached the authority').toHaveLength(1);
      // A binary string here is UTF-8 encoded by the browser and every octet
      // above 0x7f becomes two, so the request reaches the authority as noise.
      expect(shapes).toEqual(['bytes']);
      const { execFileSync } = await import('node:child_process');
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const file = join(mkdtempSync(join(tmpdir(), 'tsq-')), 'request.der');
      writeFileSync(file, bodies[0]);
      // `openssl ts` parses it as a query or it does not: the builder used to put
      // the digest straight beside the version, with no `messageImprint` wrapper
      // around it, and openssl stopped on `wrong tag` at `X509_ALGOR`.
      const parsed = execFileSync('openssl', ['ts', '-query', '-in', file, '-text'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(parsed).toMatch(/Message data/);
      expect(parsed).toMatch(/Hash Algorithm: sha256/);
    } finally {
      restore();
    }
  });

  it('imprints the signature value, not the digest of the document', async () => {
    const calls: string[] = [];
    const bodies: Uint8Array[] = [];
    const restore = stubAuthority(calls, { bodies });
    try {
      const signed = await signedSource();
      await timestamp(signed);
      const digest = imprintOf(bodies[0]);
      const { signatureValue, documentDigest } = digestTargets(signed);
      const sha = (octets: string) => forge.md.sha256.create().update(octets).digest().toHex();
      // A signature time-stamp is over the signature value octets
      // (ETSI EN 319 142-1 §6.3) — the only thing a verifier can recompute from
      // the file that is tied to *this* signature rather than to the pages.
      expect(digest, 'the imprint is not the signature value').toBe(sha(signatureValue));
      expect(digest, 'the imprint is still the document digest').not.toBe(sha(documentDigest));
    } finally {
      restore();
    }
  });

  it('reports the time the authority attested, not this machine clock', async () => {
    const calls: string[] = [];
    const restore = stubAuthority(calls);
    try {
      const outcome = await timestamp(await signedSource());
      // The stub token carries no `signingTime`: the attested moment lives in the
      // `TSTInfo.genTime`, inside the encapsulated content, which `forge` does not
      // parse on its own — so this used to fall through to `new Date()`.
      expect(outcome.message).toMatch(/Timestamped at 2026-11-11T12:00:00\.000Z/);
      expect(outcome.message).not.toMatch(new RegExp(`at ${new Date().toISOString().slice(0, 10)}`));
    } finally {
      restore();
    }
  });

  it('refuses a token that answers a different request', async () => {
    const calls: string[] = [];
    // A nonce differing from the one the request will carry, in its encoding.
    const restore = stubAuthority(calls, { nonce: '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008' });
    try {
      const failure = await timestamp(await signedSource()).catch((error: unknown) => error);
      const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
      expect(text).toMatch(/different request/i);
      expect(text).toMatch(/nonce/i);
    } finally {
      restore();
    }
  });

  it('says the authority was reached when it turns the request down', async () => {
    const calls: string[] = [];
    const restore = stubAuthority(calls, { status: 400 });
    try {
      const failure = await timestamp(await signedSource()).catch((error: unknown) => error);
      const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
      // An HTTP error is an answer. Calling it "unreachable" sent the user to
      // check their connection for a defect in the request.
      expect(text).toMatch(/was reached but/i);
      expect(text).toMatch(/HTTP 400/);
      expect(text).not.toMatch(/could not be reached/i);
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

/** The `messageImprint` digest out of a built `TimeStampReq`. */
function imprintOf(body: Uint8Array): string {
  const request = forge.asn1.fromDer(forge.util.binary.raw.encode(body), false);
  const imprint = (request.value as forge.asn1.Asn1[])[1];
  const digest = (imprint?.value as forge.asn1.Asn1[])?.[1];
  return forge.util.bytesToHex(String(digest?.value ?? ''));
}

/**
 * The two candidate imprint targets, read out of the signed file: the signature
 * value octets and the `messageDigest` attribute's value.
 */
function digestTargets(signed: Uint8Array): { signatureValue: string; documentDigest: string } {
  const hex = /\/Contents\s*<([0-9A-Fa-f\s]+)>/.exec(latin1.decode(signed))?.[1].replace(/\s+/g, '') ?? '';
  const root = forge.asn1.fromDer(forge.util.hexToBytes(hex.replace(/0+$/, '')), false);
  const signedData = (root.value as forge.asn1.Asn1[])[1];
  const content = (signedData.value as forge.asn1.Asn1[])[0];
  const sets = (content.value as forge.asn1.Asn1[]).filter((m) => m.type === forge.asn1.Type.SET);
  const signerInfo = (sets[sets.length - 1].value as forge.asn1.Asn1[])[0];
  const members = signerInfo.value as forge.asn1.Asn1[];
  const signatureValue = members.find(
    (m) => m.tagClass === forge.asn1.Class.UNIVERSAL && m.type === forge.asn1.Type.OCTETSTRING,
  )?.value;
  const attributes = members.find((m) => m.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && m.type === 0);
  const messageDigest = (attributes?.value as forge.asn1.Asn1[])
    ?.find((attribute) => {
      const oid = (attribute.value as forge.asn1.Asn1[])[0]?.value;
      return typeof oid === 'string' && forge.asn1.derToOid(oid) === '1.2.840.113549.1.9.4';
    })
    ?.value as forge.asn1.Asn1[];
  return {
    signatureValue: String(signatureValue ?? ''),
    documentDigest: String((messageDigest?.[1]?.value as forge.asn1.Asn1[])?.[0]?.value ?? ''),
  };
}
