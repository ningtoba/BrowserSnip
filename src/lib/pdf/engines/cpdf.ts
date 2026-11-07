/**
 * CoherentPDF loader.
 *
 * `coherentpdf.browser.min.js` is a UMD/js_of_ocaml bundle: it is not an ES
 * module, so it cannot be `import()`ed. It is injected as a classic `<script>`
 * once and then reads itself off `window.coherentpdf` — exactly what BentoPDF's
 * shipped `cpdf-helper` does.
 *
 * Two properties of this API matter to callers:
 *
 *   - it is **synchronous and non-re-entrant**. A long merge blocks the thread
 *     that runs it, so heavy jobs belong in a worker;
 *   - it is **manually memory managed**: every document handle must be passed
 *     to `deletePdf` when the caller is done, or the WASM heap grows per run.
 *
 * The signatures mirror `cpdfdocs.js` from coherentpdf@2.5.5 (the file that
 * documents every exported function). js_of_ocaml exports are curried, so the
 * argument lists below are the fully-applied forms shown in that documentation.
 * The bundle exposes around 325 names; the ones BrowserSnip's tools need are
 * typed here, and anything else arrives as `unknown` and must be narrowed by
 * the caller.
 */
import { EngineUnavailable, engines, normalizeBaseUrl } from './provider';

declare const cpdfDocumentHandle: unique symbol;

/** An opaque CoherentPDF document. Free it with `deletePdf`. */
export type CpdfDocument = { readonly [cpdfDocumentHandle]: true };

/** CoherentPDF page ranges are plain arrays of 1-based page numbers. */
export type CpdfRange = number[];

export interface CpdfApi {
  // ── Constants, exported as numbers by the bundle ───────────────────────────
  readonly noEdit: number;
  readonly noPrint: number;
  readonly noCopy: number;
  readonly noAnnot: number;
  readonly noForms: number;
  readonly noExtract: number;
  readonly noAssemble: number;
  readonly noHqPrint: number;
  readonly pdf40bit: number;
  readonly pdf128bit: number;
  readonly aes128bitfalse: number;
  readonly aes128bittrue: number;
  readonly aes256bitfalse: number;
  readonly aes256bittrue: number;
  readonly a4portrait: number;
  readonly a4landscape: number;
  readonly usletterportrait: number;
  readonly usletterlandscape: number;
  readonly uslegalportrait: number;
  readonly uslegallandscape: number;
  readonly posCentre: number;
  readonly posLeft: number;
  readonly posRight: number;
  readonly top: number;
  readonly topLeft: number;
  readonly topRight: number;
  readonly left: number;
  readonly bottom: number;
  readonly bottomLeft: number;
  readonly bottomRight: number;
  readonly right: number;
  readonly diagonal: number;
  readonly timesRoman: number;
  readonly timesBold: number;
  readonly timesItalic: number;
  readonly helvetica: number;
  readonly helveticaBold: number;
  readonly courier: number;
  readonly courierBold: number;
  readonly leftJustify: number;
  readonly centreJustify: number;
  readonly rightJustify: number;
  readonly singlePage: number;
  readonly oneColumn: number;
  readonly twoColumnLeft: number;
  readonly twoColumnRight: number;
  readonly useNone: number;
  readonly useOutlines: number;
  readonly useThumbs: number;
  readonly useOC: number;
  readonly useAttachments: number;
  readonly decimalArabic: number;
  readonly uppercaseRoman: number;
  readonly lowercaseRoman: number;
  readonly uppercaseLetters: number;
  readonly lowercaseLetters: number;

  // ── Documents ─────────────────────────────────────────────────────────────
  version(): string;
  setFast(): void;
  setSlow(): void;
  fromFile(filename: string, userpw: string): CpdfDocument;
  fromMemory(data: Uint8Array, userpw: string): CpdfDocument;
  toMemory(pdf: CpdfDocument, linearize: boolean, makeId: boolean): Uint8Array;
  toFile(
    pdf: CpdfDocument,
    filename: string,
    linearize: boolean,
    makeId: boolean,
  ): void;
  toMemoryEncrypted(
    pdf: CpdfDocument,
    encryptionMethod: number,
    permissions: number[],
    ownerpw: string,
    userpw: string,
    linearize: boolean,
    makeId: boolean,
  ): Uint8Array;
  deletePdf(pdf: CpdfDocument): void;
  pages(pdf: CpdfDocument): number;
  all(pdf: CpdfDocument): CpdfRange;
  range(from: number, to: number): CpdfRange;
  parsePagespec(pdf: CpdfDocument, pagespec: string): CpdfRange;
  validatePagespec(pagespec: string): boolean;
  stringOfPagespec(pdf: CpdfDocument, range: CpdfRange): string;

  // ── Encryption ────────────────────────────────────────────────────────────
  isEncrypted(pdf: CpdfDocument): boolean;
  decryptPdf(pdf: CpdfDocument, userpw: string): void;
  decryptPdfOwner(pdf: CpdfDocument, ownerpw: string): void;
  hasPermission(pdf: CpdfDocument, permission: number): boolean;
  encryptionKind(pdf: CpdfDocument): string;

  // ── Page operations ───────────────────────────────────────────────────────
  mergeSimple(pdfs: CpdfDocument[]): CpdfDocument;
  merge(
    pdfs: CpdfDocument[],
    retainNumbering: boolean,
    removeDuplicateFonts: boolean,
  ): CpdfDocument;
  mergeSame(
    pdfs: CpdfDocument[],
    retainNumbering: boolean,
    removeDuplicateFonts: boolean,
    ranges: CpdfRange[],
  ): CpdfDocument;
  selectPages(pdf: CpdfDocument, range: CpdfRange): void;
  scalePages(pdf: CpdfDocument, range: CpdfRange, sx: number, sy: number): void;
  rotate(pdf: CpdfDocument, range: CpdfRange, rotation: number): void;
  rotateBy(pdf: CpdfDocument, range: CpdfRange, rotation: number): void;
  compress(pdf: CpdfDocument): void;
  blankDocument(): CpdfDocument;

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  startGetBookmarkInfo(pdf: CpdfDocument): void;
  numberBookmarks(): number;
  getBookmarkLevel(n: number): number;
  getBookmarkPage(pdf: CpdfDocument, n: number): number;
  getBookmarkText(n: number): string;
  getBookmarkOpenStatus(n: number): boolean;
  endGetBookmarkInfo(): void;
  startSetBookmarkInfo(n: number): void;
  setBookmarkLevel(n: number, level: number): void;
  setBookmarkPage(pdf: CpdfDocument, n: number, targetPage: number): void;
  setBookmarkText(n: number, text: string): void;
  setBookmarkOpenStatus(n: number, status: boolean): void;
  endSetBookmarkInfo(pdf: CpdfDocument): void;
  /** Bookmark data as a JSON byte array — the round-trip form. */
  getBookmarksJSON(pdf: CpdfDocument): Uint8Array;
  setBookmarksJSON(pdf: CpdfDocument, data: Uint8Array): void;
  tableOfContents(
    pdf: CpdfDocument,
    font: number,
    fontSize: number,
    title: string,
    bookmark: boolean,
  ): void;

  // ── Page labels ───────────────────────────────────────────────────────────
  addPageLabels(
    pdf: CpdfDocument,
    style: number,
    prefix: string,
    offset: number,
    range: CpdfRange,
    progress: boolean,
  ): void;
  removePageLabels(pdf: CpdfDocument): void;
  /** Returns the number of label ranges; read them with the `getPageLabel*` set. */
  startGetPageLabels(pdf: CpdfDocument): number;
  getPageLabelStyle(n: number): number;
  getPageLabelPrefix(n: number): string;
  getPageLabelOffset(n: number): number;
  getPageLabelRange(n: number): CpdfRange;
  endGetPageLabels(): void;
  getPageLabelStringForPage(pdf: CpdfDocument, page: number): string;

  // ── Metadata ──────────────────────────────────────────────────────────────
  getVersion(pdf: CpdfDocument): string;
  getMajorVersion(pdf: CpdfDocument): number;
  getTitle(pdf: CpdfDocument): string;
  getAuthor(pdf: CpdfDocument): string;
  getSubject(pdf: CpdfDocument): string;
  getKeywords(pdf: CpdfDocument): string;
  getCreator(pdf: CpdfDocument): string;
  getProducer(pdf: CpdfDocument): string;
  getCreationDate(pdf: CpdfDocument): string;
  getModificationDate(pdf: CpdfDocument): string;
  setTitle(pdf: CpdfDocument, value: string): void;
  setAuthor(pdf: CpdfDocument, value: string): void;
  setSubject(pdf: CpdfDocument, value: string): void;
  setKeywords(pdf: CpdfDocument, value: string): void;
  setCreator(pdf: CpdfDocument, value: string): void;
  setProducer(pdf: CpdfDocument, value: string): void;
  setCreationDate(pdf: CpdfDocument, value: string): void;
  setModificationDate(pdf: CpdfDocument, value: string): void;
  getTitleXMP(pdf: CpdfDocument): string;
  getAuthorXMP(pdf: CpdfDocument): string;
  getMetadata(pdf: CpdfDocument): Uint8Array;
  setMetadataFromByteArray(pdf: CpdfDocument, data: Uint8Array): void;
  createMetadata(pdf: CpdfDocument): void;
  removeMetadata(pdf: CpdfDocument): void;
  markTrapped(pdf: CpdfDocument): void;
  markUntrapped(pdf: CpdfDocument): void;

  // ── Attachments ───────────────────────────────────────────────────────────
  attachFileFromMemory(data: Uint8Array, filename: string, pdf: CpdfDocument): void;
  attachFileToPageFromMemory(
    data: Uint8Array,
    filename: string,
    pdf: CpdfDocument,
    page: number,
  ): void;
  removeAttachedFiles(pdf: CpdfDocument): void;
  startGetAttachments(pdf: CpdfDocument): void;
  numberGetAttachments(): number;
  getAttachmentName(n: number): string;
  /** 0 means document level. */
  getAttachmentPage(n: number): number;
  getAttachmentData(n: number): Uint8Array;
  endGetAttachments(): void;

  // ── Structure ─────────────────────────────────────────────────────────────
  annotationsJSON(pdf: CpdfDocument): Uint8Array;
  outputJSONMemory(
    parseContent: boolean,
    noStreamData: boolean,
    decompressStreams: boolean,
    pdf: CpdfDocument,
  ): Uint8Array;
  fromJSONMemory(data: Uint8Array): CpdfDocument;
  numberFonts(pdf: CpdfDocument): number;
  getFontPage(page: number): string;
  getFontName(n: number): string;
  getFontType(n: number): string;
  getFontEncoding(n: number): string;

  /** Any other name the bundle exports; narrow it before calling. */
  readonly [name: string]: unknown;
}

declare global {
  interface Window {
    coherentpdf?: CpdfApi;
  }
}

let loaded = false;
let pending: Promise<CpdfApi> | null = null;

function scriptSource(): string | null {
  if (!engines.isConfigured('cpdf')) return null;
  return `${normalizeBaseUrl(engines.getUrl('cpdf'))}coherentpdf.browser.min.js`;
}

function existingApi(): CpdfApi | null {
  if (typeof window === 'undefined') return null;
  return window.coherentpdf ?? null;
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          `Could not load CoherentPDF from ${src}: the browser could not reach that address, ` +
            `or refused the request.`,
        ),
      );
    document.head.appendChild(script);
  });
}

/**
 * Load CoherentPDF. Memoised and concurrent-safe; the `<script>` is injected at
 * most once per page even if several tools ask for it together.
 */
export function loadCpdf(): Promise<CpdfApi> {
  if (loaded) {
    const api = existingApi();
    if (api) return Promise.resolve(api);
  }
  // A failed load is never memoised, so the next run can try the network again.
  const src = scriptSource();
  if (!src) {
    return Promise.reject(new EngineUnavailable('cpdf', 'no address is set'));
  }
  if (!pending) {
    pending = (async () => {
      const already = existingApi();
      if (already) {
        loaded = true;
        return already;
      }
      await injectScript(src);
      const api = existingApi();
      if (!api) {
        throw new Error(
          `${src} loaded without defining window.coherentpdf, so it is not a CoherentPDF browser build.`,
        );
      }
      loaded = true;
      return api;
    })().catch((err: unknown) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Alias matching the other engine modules: `const cpdfApi = await cpdf()`. */
export const cpdf = loadCpdf;

/**
 * Forget the loader state. The script tag itself is left in place — a classic
 * script cannot be unloaded — so this only matters after a URL change.
 */
export function resetCpdf(): void {
  loaded = false;
  pending = null;
}
