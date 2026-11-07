/**
 * PyMuPDF loader.
 *
 * PyMuPDF here is Pyodide plus the `pymupdf` WASM wheel, so it is loaded with a
 * dynamic `import()` of `${base}dist/index.js` and then pointed at
 * `${base}assets/` for the wheels. The address comes from the engine provider,
 * which is what stops a bad `localStorage` entry from importing another origin.
 *
 * Mirrored from BentoPDF's shipped `pymupdf-loader` bundle: the instance is
 * created once, memoised, and the loader refuses to run unless Ghostscript is
 * configured too — PyMuPDF calls out to it for some conversions, so loading
 * PyMuPDF alone would fail later, in a worse place to explain.
 *
 * The TypeScript surface below mirrors the published declarations at
 * https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/types/index.d.ts
 * (and `dist/index.js`, which exports exactly `PyMuPDF`, `PyMuPDFDocument` and
 * `PyMuPDFPage`). The package is not an npm dependency — it is fetched from the
 * CDN — so the names are copied rather than imported.
 */
import { EngineUnavailable, engines, normalizeBaseUrl } from './provider';

export interface PyMuPDFOptions {
  /** Folder holding `pyodide.asm.js` and the wheels. Defaults to `./`. */
  assetPath?: string;
  /** Optional address of a Ghostscript build for the filters that need one. */
  ghostscriptUrl?: string;
}

export interface PyMuPDFPoint {
  x: number;
  y: number;
}

export interface PyMuPDFRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PyMuPDFColor {
  r: number;
  g: number;
  b: number;
}

export interface PyMuPDFMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
}

export type PyMuPDFTextFormat =
  | 'text'
  | 'blocks'
  | 'words'
  | 'dict'
  | 'json'
  | 'html'
  | 'xhtml'
  | 'xml';

export interface PyMuPDFTextBlock {
  type: 'text' | 'image';
  bbox: PyMuPDFRect;
  text?: string;
}

export interface PyMuPDFImageInfo {
  xref: number;
  width: number;
  height: number;
  bpc: number;
  colorspace: string;
  size: number;
}

export interface PyMuPDFExtractedImage extends PyMuPDFImageInfo {
  data: Uint8Array;
  ext: string;
}

export type PyMuPDFAnnotationType =
  | 'Text'
  | 'FreeText'
  | 'Line'
  | 'Square'
  | 'Circle'
  | 'Polygon'
  | 'PolyLine'
  | 'Highlight'
  | 'Underline'
  | 'StrikeOut'
  | 'Squiggly'
  | 'Stamp'
  | 'Caret'
  | 'Ink'
  | 'FileAttachment'
  | 'Link';

export interface PyMuPDFAnnotationInfo {
  type: PyMuPDFAnnotationType;
  rect: PyMuPDFRect;
  content?: string;
  author?: string;
  color?: PyMuPDFColor;
}

export interface PyMuPDFFormField {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'choice' | 'button' | 'signature';
  value: string | boolean | string[];
  rect: PyMuPDFRect;
  readonly?: boolean;
}

export interface PyMuPDFSearchResult {
  page: number;
  rect: PyMuPDFRect;
  text: string;
}

export interface PyMuPDFRenderOptions {
  dpi?: number;
  alpha?: boolean;
  rotation?: number;
  clip?: PyMuPDFRect;
}

export interface PyMuPDFEncryptionOptions {
  userPassword?: string;
  ownerPassword: string;
  permissions?: {
    print?: boolean;
    copy?: boolean;
    annotate?: boolean;
    modify?: boolean;
  };
}

export interface PyMuPDFLinkInfo {
  rect: PyMuPDFRect;
  uri?: string;
  page?: number;
  dest?: PyMuPDFPoint;
}

export interface PyMuPDFTocEntry {
  level: number;
  title: string;
  page: number;
  dest?: PyMuPDFPoint;
}

export interface PyMuPDFTableInfo {
  rows: (string | null)[][];
  markdown: string;
  rowCount: number;
  colCount: number;
  bbox?: PyMuPDFRect;
}

export interface PyMuPDFDeskewOptions {
  threshold?: number;
  dpi?: number;
  maxAngle?: number;
  pages?: number[];
}

export interface PyMuPDFDeskewResult {
  totalPages: number;
  correctedPages: number;
  angles: number[];
  corrected: boolean[];
}

export interface PyMuPDFLayer {
  number: number;
  xref?: number;
  text: string;
  on: boolean;
  locked: boolean;
  depth?: number;
  parentXref?: number;
  displayOrder?: number;
}

export interface PyMuPDFPage {
  readonly pageNumber: number;
  readonly rect: PyMuPDFRect;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;

  setRotation(angle: number): void;

  getText(format?: PyMuPDFTextFormat): string | PyMuPDFTextBlock[];
  searchFor(text: string, quads?: boolean): PyMuPDFRect[];
  insertText(
    point: PyMuPDFPoint,
    text: string,
    options?: {
      fontsize?: number;
      fontname?: string;
      color?: PyMuPDFColor;
      rotate?: number;
    },
  ): void;

  getImages(): PyMuPDFImageInfo[];
  extractImage(xref: number): PyMuPDFExtractedImage | null;
  insertImage(
    rect: PyMuPDFRect,
    imageData: Uint8Array,
    options?: { overlay?: boolean; keepProportion?: boolean },
  ): void;

  getAnnotations(): PyMuPDFAnnotationInfo[];
  addHighlight(rect: PyMuPDFRect, color?: PyMuPDFColor): void;
  addTextAnnotation(point: PyMuPDFPoint, text: string, icon?: string): void;
  addRectAnnotation(rect: PyMuPDFRect, color?: PyMuPDFColor, fill?: PyMuPDFColor): void;
  deleteAnnotations(): void;

  getLinks(): PyMuPDFLinkInfo[];
  insertLink(rect: PyMuPDFRect, uri: string): void;

  toImage(options?: PyMuPDFRenderOptions): Promise<Uint8Array>;
  toSvg(): string;

  addRedaction(rect: PyMuPDFRect, text?: string, fill?: PyMuPDFColor): void;
  applyRedactions(): void;

  drawLine(from: PyMuPDFPoint, to: PyMuPDFPoint, color?: PyMuPDFColor, width?: number): void;
  drawRect(
    rect: PyMuPDFRect,
    color?: PyMuPDFColor,
    fill?: PyMuPDFColor,
    width?: number,
  ): void;
  drawCircle(
    center: PyMuPDFPoint,
    radius: number,
    color?: PyMuPDFColor,
    fill?: PyMuPDFColor,
  ): void;

  findTables(): PyMuPDFTableInfo[];
}

export interface PyMuPDFDocument {
  readonly pageCount: number;
  readonly isPdf: boolean;
  readonly isEncrypted: boolean;
  readonly needsPass: boolean;
  readonly metadata: PyMuPDFMetadata;
  readonly isFormPdf: boolean;

  setMetadata(metadata: Partial<PyMuPDFMetadata>): void;

  getPage(index: number): PyMuPDFPage;
  pages(): Generator<PyMuPDFPage>;
  deletePage(index: number): void;
  deletePages(indices: number[]): void;
  insertBlankPage(index: number, width?: number, height?: number): PyMuPDFPage;
  movePage(from: number, to: number): void;
  copyPage(from: number, to: number): void;
  selectPages(indices: number[]): void;

  insertPdf(
    sourceDoc: PyMuPDFDocument,
    options?: { fromPage?: number; toPage?: number; startAt?: number; rotate?: number },
  ): void;

  convertToPdf(): Uint8Array;
  searchText(query: string): PyMuPDFSearchResult[];

  getToc(): PyMuPDFTocEntry[];
  setToc(toc: PyMuPDFTocEntry[]): void;

  getFormFields(): PyMuPDFFormField[];
  setFormField(name: string, value: string | boolean): void;

  authenticate(password: string): boolean;

  save(options?: {
    garbage?: number;
    deflate?: boolean;
    clean?: boolean;
    encryption?: PyMuPDFEncryptionOptions;
  }): Uint8Array;
  saveAsBlob(options?: {
    garbage?: number;
    deflate?: boolean;
    clean?: boolean;
    encryption?: PyMuPDFEncryptionOptions;
  }): Blob;

  getLayerConfig(): PyMuPDFLayer[];
  addOCG(
    name: string,
    options?: { config?: number; on?: boolean; intent?: string; usage?: string },
  ): number;
  addOCGWithParent(
    name: string,
    parentXref: number,
    options?: { config?: number; on?: boolean; intent?: string; usage?: string },
  ): number;
  setLayerVisibility(ocgXref: number, on: boolean): void;
  deleteOCG(number: number): void;

  close(): void;
}

export interface PyMuPDFCompressResult {
  blob: Blob;
  originalSize: number;
  compressedSize: number;
  savings: number;
  savingsPercent: number;
  pageCount: number;
}

/** The instance `new mod.PyMuPDF(...)` produces. */
export interface PyMuPDFInstance {
  readonly assetPath: string;
  readonly ghostscriptUrl: string;

  load(): Promise<void>;

  open(input: Blob | File): Promise<PyMuPDFDocument>;
  openUrl(url: string): Promise<PyMuPDFDocument>;
  create(): Promise<PyMuPDFDocument>;

  merge(pdfs: (Blob | File)[]): Promise<Blob>;
  split(pdf: Blob | File, ranges: { start: number; end: number }[]): Promise<Blob[]>;
  extractText(pdf: Blob | File): Promise<string>;
  renderPage(pdf: Blob | File, pageIndex: number, dpi?: number): Promise<Uint8Array>;

  convertToPdf(file: Blob | File, options?: { filetype?: string }): Promise<Blob>;
  xpsToPdf(xps: Blob | File): Promise<Blob>;
  epubToPdf(epub: Blob | File): Promise<Blob>;
  imageToPdf(image: Blob | File, options?: { imageType?: string }): Promise<Blob>;
  svgToPdf(svg: Blob | File): Promise<Blob>;
  imagesToPdf(images: (Blob | File)[]): Promise<Blob>;

  pdfToImages(
    pdf: Blob | File,
    options?: {
      format?: 'png' | 'jpeg' | 'pnm' | 'pgm' | 'pbm' | 'ppm' | 'pam' | 'psd' | 'ps';
      dpi?: number;
      pages?: number[];
    },
  ): Promise<Uint8Array[]>;
  pdfToSvg(pdf: Blob | File, pages?: number[]): Promise<string[]>;
  pdfToText(pdf: Blob | File): Promise<string>;
  pdfToHtml(pdf: Blob | File): Promise<string>;
  pdfToJson(pdf: Blob | File): Promise<Record<string, unknown>[]>;
  pdfToXml(pdf: Blob | File): Promise<string>;

  pdfToMarkdown(
    pdf: Blob | File,
    options?: { pageBreaks?: boolean; includeImages?: boolean; pages?: number[] },
  ): Promise<string>;
  pdfToLlmChunks(
    pdf: Blob | File,
  ): Promise<{ text: string; metadata: { page?: number; heading?: string } }[]>;
  pdfToLlamaIndex(
    pdf: Blob | File,
  ): Promise<{ text: string; metadata: Record<string, unknown>; extra_info?: Record<string, unknown> }[]>;

  pdfToDocx(pdf: Blob | File, pages?: number[]): Promise<Blob>;
  pdfToEpub(
    pdf: Blob | File,
    options?: {
      title?: string;
      author?: string;
      toc?: boolean;
      pandocAssetPath?: string;
    },
  ): Promise<Blob>;

  htmlToPdf(
    html: string,
    options?: {
      css?: string;
      pageSize?: 'a4' | 'letter' | 'legal' | 'a3' | 'a5';
      margins?: number | { top: number; right: number; bottom: number; left: number };
    },
  ): Promise<Blob>;
  textToPdf(
    text: string,
    options?: {
      fontName?: 'helv' | 'tiro' | 'cour' | 'times';
      fontSize?: number;
      pageSize?: 'a4' | 'letter' | 'legal' | 'a3' | 'a5';
      textColor?: string;
      margins?: number;
    },
  ): Promise<Blob>;

  rasterizePdf(
    pdf: Blob | File,
    options?: {
      dpi?: number;
      format?: 'png' | 'jpeg';
      quality?: number;
      alpha?: boolean;
      grayscale?: boolean;
      pages?: number[];
    },
  ): Promise<Blob>;

  compressPdf(
    pdf: Blob | File,
    options?: {
      scrub?: {
        metadata?: boolean;
        xmlMetadata?: boolean;
        attachedFiles?: boolean;
        embeddedFiles?: boolean;
        thumbnails?: boolean;
      };
      images?: {
        enabled?: boolean;
        dpiThreshold?: number;
        dpiTarget?: number;
        quality?: number;
        convertToGray?: boolean;
      };
      subsetFonts?: boolean;
      save?: {
        garbage?: 0 | 1 | 2 | 3 | 4;
        deflate?: boolean;
        useObjstms?: boolean;
        clean?: boolean;
      };
    },
  ): Promise<PyMuPDFCompressResult>;

  deskewPdf(
    pdf: Blob | File,
    options?: PyMuPDFDeskewOptions,
  ): Promise<{ pdf: Blob; result: PyMuPDFDeskewResult }>;
}

/** Shape of `${base}dist/index.js`. */
interface PyMuPDFModule {
  PyMuPDF: new (options?: PyMuPDFOptions | string) => PyMuPDFInstance;
}

let instance: PyMuPDFInstance | null = null;
let pending: Promise<PyMuPDFInstance> | null = null;

/**
 * PyMuPDF calls out to Ghostscript for some of its conversions, so the loader
 * refuses when Ghostscript has no address: loading PyMuPDF alone would fail
 * later, in a worse place to explain.
 */
async function loadPymupdf(): Promise<PyMuPDFInstance> {
  if (!engines.isConfigured('pymupdf')) {
    throw new EngineUnavailable('pymupdf', 'no address is set');
  }
  if (!engines.isConfigured('ghostscript')) {
    throw new EngineUnavailable(
      'ghostscript',
      'PyMuPDF needs Ghostscript for some of its conversions, so it is not loaded on its own',
    );
  }

  const base = normalizeBaseUrl(engines.getUrl('pymupdf'));
  try {
    const mod = (await import(/* @vite-ignore */ `${base}dist/index.js`)) as Partial<PyMuPDFModule>;
    if (typeof mod.PyMuPDF !== 'function') {
      throw new Error(`${base}dist/index.js did not export the PyMuPDF class.`);
    }
    const created = new mod.PyMuPDF({ assetPath: `${base}assets/` });
    await created.load();
    return created;
  } catch (err) {
    // `Error` options are ES2022 and this project compiles against ES2020, so
    // the original message is carried in the text instead of in `cause`.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load PyMuPDF from ${base}: ${message}`);
  }
}

/**
 * The loaded PyMuPDF instance. Memoised and safe to call concurrently: the
 * promise is stored, not just the result, so two tools started together share
 * one ~40 MB download.
 */
export function pymupdf(): Promise<PyMuPDFInstance> {
  if (instance) return Promise.resolve(instance);
  if (!pending) {
    pending = loadPymupdf().catch((err: unknown) => {
      // A failed load must not be cached, or one offline retry poisons the tab.
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Forget the instance. The Pyodide runtime itself is left to the browser. */
export function resetPymupdf(): void {
  instance = null;
  pending = null;
}
