/**
 * A password gate with **no cipher**: `/V 4 /R 4`, the `/O` `/U` `/P` of
 * revision 4, and the crypt filter `/None` — spelled as an empty `/CF` with
 * `/StmF` and `/StrF` absent, whose spec default is "the data are not encrypted"
 * (ISO 32000-1 §7.4.4, Table 30).
 *
 * This is the shape `core/doc.ts:saveEncrypted` wrote while the vendor ran no
 * cipher, so files out there — including every copy downloaded from
 * browsersnip.com before the cipher landed — still carry it, and the guard, the
 * rotation path and the unlock path all have to keep treating it as readable
 * plaintext behind a prompt. It is built here, from the fork's own exported
 * `PDFSecurity`, rather than by this app's writer, for exactly that reason: a
 * test that asked `saveEncrypted` for a gate would silently become a test about
 * AES-128 the moment the writer changed. Which is what happened.
 *
 * Naming a filter whose `/CFM` is `/None` (instead of leaving `/StmF` out) is not
 * equivalent: measured with `docs/research/protect-readers.py`, that spelling is
 * what made MuPDF refuse the file and qpdf report errors decoding its content
 * streams, so the empty `/CF` is the shape kept here.
 */
import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFSecurity } from '@maxwbh/pdf-lib';
import type { PDFDocument, PDFPermissions } from '@maxwbh/pdf-lib';

export interface GateOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: PDFPermissions;
}

/** Save `doc` as a gated-but-plaintext PDF and hand back its bytes. */
export async function saveGateOnly(doc: PDFDocument, options: GateOptions = {}): Promise<Uint8Array> {
  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword || userPassword || 'gate-owner';
  const security = new PDFSecurity(doc.context);
  security.setupEncryption({ ownerPassword, userPassword, permissions: options.permissions, version: 4 });

  const dict = security.createEncryptDict();
  dict.set(PDFName.of('CF'), PDFDict.withContext(doc.context));
  dict.delete(PDFName.of('StmF'));
  dict.delete(PDFName.of('StrF'));
  dict.set(PDFName.of('EncryptMetadata'), PDFBool.True);
  doc.context.trailerInfo.Encrypt = doc.context.register(dict);

  // `/U` is derived over the `/ID`, so both come from the same security object;
  // `save()` without `encrypt` leaves the pair alone.
  const ids = PDFArray.withContext(doc.context);
  const documentId = PDFHexString.fromBytes(security.getDocumentId());
  ids.push(documentId);
  ids.push(documentId);
  doc.context.trailerInfo.ID = ids;

  return doc.save({ useObjectStreams: true });
}
