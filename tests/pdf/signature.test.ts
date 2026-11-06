/**
 * Signature round-trip tests.
 *
 * These exercise the two-pass byte patching in `core/signature`: the file must
 * keep exactly the same length after `/ByteRange` and `/Contents` are patched,
 * the recomputed digest must match, and any later edit must be detected.
 */
import { describe, expect, it } from 'vitest';
import { newPDF, openPDF } from '@/lib/pdf/core/doc';
import { StandardFonts, rgb } from '@/lib/pdf/core/doc';
import {
  createSelfSignedCertificate,
  readSignatures,
  signDocument,
} from '@/lib/pdf/core/signature';

async function buildSample(): Promise<Uint8Array> {
  const doc = await newPDF();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Invoice 2026-014 — total 1,200.00 EUR', {
    x: 36,
    y: 220,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });
  return doc.save({ useObjectStreams: false });
}

const encoder = new TextEncoder();

describe('core/signature', () => {
  it('signs a document and the byte ranges stay consistent', async () => {
    const source = await buildSample();
    const { certificatePem, privateKeyPem } = await createSelfSignedCertificate('BrowserSnip Test');

    const result = await signDocument(await openPDF(source), {
      certificate: encoder.encode(certificatePem),
      privateKey: encoder.encode(privateKeyPem),
      reason: 'Approval',
      visible: false,
    });

    expect(result.bytes.length).toBeGreaterThan(source.length);
    const [offsetA, lengthA, offsetB, lengthB] = result.byteRange;
    // The two ranges must be contiguous apart from the /Contents placeholder,
    // and must not run off the end of the file.
    expect(offsetA).toBe(0);
    expect(offsetB).toBeGreaterThan(lengthA);
    expect(offsetB + lengthB).toBe(result.bytes.length);
  }, 60_000);

  it('verifies its own signature and reports the signer', async () => {
    const source = await buildSample();
    const { certificatePem, privateKeyPem } = await createSelfSignedCertificate('Ada Lovelace');
    const signed = await signDocument(await openPDF(source), {
      certificate: encoder.encode(certificatePem),
      privateKey: encoder.encode(privateKeyPem),
      visible: false,
      fieldName: 'Sig1',
    });

    const signatures = await readSignatures(signed.bytes);
    expect(signatures).toHaveLength(1);
    expect(signatures[0].digestMatches).toBe(true);
    expect(signatures[0].signer).toBe('Ada Lovelace');
    expect(signatures[0].digestAlgorithm).toBe('SHA-256');
    expect(signatures[0].fieldName).toBe('Sig1');
    expect(signatures[0].error).toBeUndefined();
  }, 60_000);

  it('detects a changed byte inside the signed byte range', async () => {
    const source = await buildSample();
    const { certificatePem, privateKeyPem } = await createSelfSignedCertificate('Tamper Test');
    const signed = await signDocument(await openPDF(source), {
      certificate: encoder.encode(certificatePem),
      privateKey: encoder.encode(privateKeyPem),
      visible: false,
    });

    const [offsetA, lengthA, offsetB, lengthB] = signed.byteRange;
    // Pick a byte that is provably inside the first covered range and is not
    // part of the header, so the flip changes signed content.
    const index = offsetA + Math.floor(lengthA / 2);
    expect(index).toBeLessThan(offsetA + lengthA);
    const tampered = new Uint8Array(signed.bytes);
    tampered[index] = tampered[index] === 0xff ? 0x00 : tampered[index] + 1;

    const signatures = await readSignatures(tampered);
    expect(signatures).toHaveLength(1);
    expect(signatures[0].error).toBeUndefined();
    expect(signatures[0].digestMatches).toBe(false);

    // And a byte between the two ranges — inside the /Contents hex itself — is
    // legitimately unsigned, which is what lets incremental signing work.
    expect(lengthA + lengthB).toBeLessThan(signed.bytes.length);
    expect(offsetB).toBeGreaterThanOrEqual(lengthA);
    void offsetB;
    void lengthB;
  }, 60_000);

  it('reports a clear error for a PEM private key that is not a key at all', async () => {
    const source = await buildSample();
    const { certificatePem } = await createSelfSignedCertificate('No Key');
    await expect(
      signDocument(await openPDF(source), {
        certificate: encoder.encode(certificatePem),
        privateKey: encoder.encode(certificatePem),
        visible: false,
      }),
    ).rejects.toThrow(/private key|key could not be read/i);
  }, 60_000);

  it('reports a clear error for a non-PEM, non-DER certificate file', async () => {
    const source = await buildSample();
    await expect(
      signDocument(await openPDF(source), {
        certificate: encoder.encode('this is not a certificate'),
        privateKey: encoder.encode('-----BEGIN RSA PRIVATE KEY-----\nZm9v\n-----END RSA PRIVATE KEY-----\n'),
        visible: false,
      }),
    ).rejects.toThrow(/certificate/i);
  }, 60_000);
});
