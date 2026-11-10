# PDF engine module contracts

Authoritative interface for the `src/lib/pdf/**` build-out. Every module is
implemented **100 % client-side** — bytes in, bytes out, no server call except
the explicitly optional CDN engines in §1.

Already implemented and **frozen** (do not edit unless the task says so):

| File | Exports you may rely on |
| --- | --- |
| `src/lib/pdf/core/doc.ts` | `openPDF(src, {password, ignoreEncryption})`, `newPDF()`, `withFontkit(doc)`, `savePDF(doc, opts)`, `saveEncrypted(doc, PasswordOptions)`, `saveIncremental(doc)`, `snapshot(doc)`, `clonePDF(doc)`, `collectPages(sources)`, `drawPageInto(target, page, source, box, {scale, rotate, opacity})`, `looksEncrypted(bytes)`, `isPasswordError(e)`, `PasswordRequiredError`, `toBytes`, `toArrayBuffer`, `blobToBytes`, `pdfVersion(doc)`, and re-exports `PDFDocument, PDFPage, PDFName, PDFDict, PDFHexString, PDFFlateStream, PDFRawStream, PDFRef, PDFArray, PDFContext, PDFNumber, PDFBool, PDFNull, StandardFonts, rgb, cmyk, degrees, LineCapStyle`, types `PDFFont, PDFImage, PDFEmbeddedPage, EncryptOptions, PDFPermissions`, const `fontkit` |
| `src/lib/pdf/core/pages.ts` | `resolvePages(spec, total): number[]` (0-based, throws `PageSpecError`), `tryResolvePages`, `resolvePageSet`, `formatPages(nums)`, `mediaBox(page)`, `cropBox(page)`, `displayedSize(page)`, `setMediaAndCrop(page, box)`, `normaliseRotation`, `rotateBy`, `PAGE_SIZES`, `pageSize(name, landscape)`, `toPoints/fromPoints/describeUnit`, type `PageSpec`, `PageBox`, `LengthUnit` |
| `src/lib/pdf/core/fonts.ts` | `getFont(doc, {text,size,bold,italic,fontFamily,exact})`, `drawTextU(page, DrawTextOptions)`, `measureText(doc, opts)`, `wrapText(doc, text, {size,maxWidth,...})`, `needsUnicodeFont`, `isWinAnsiSafe`, `detectScript`, `isRightToLeft`, `prepareTextForDirection`, `SCRIPT_FONTS`, types `TextStyle`, `DrawTextOptions` |
| `src/lib/pdf/core/render.ts` | `openRender(src, {password, signal}) => Promise<PdfSession>`; `PdfSession.{numPages, fingerprint, page(n), renderToCanvas, renderPage(n, scale, {filter, background}), textContent(n), textItems(n), metadata(), attachments(), destroy()}`; `extractDocumentText(session, {pages, onProgress})`, `joinReadingOrder(items)`, `thumbnails(session, {maxSide, pages, onPage, signal})`, `rasterizePages(session, opts)`, `range(from, to)`, types `ExtractedTextItem`, `PageRender`, `RenderMetadata`, `RenderCancelled` |
| `src/lib/pdf/core/images.ts` | `decodeImage(input, {mime, maxSide, background}) => DecodedImage`, `decodeImagePages`, `encodeImage(canvas, {format, quality, background})`, `encodeImageBytes`, `toEmbeddableImage(doc, input, opts)`, `sniffImageMime`, `resolveImageMime`, `mimeForFile`, `extensionForMime`, types `ImageFormat`, `DecodedImage` |
| `src/lib/pdf/core/raster.ts` | `canvasToBlob(canvas, format, quality, {background})`, `encodeBmp`, `encodeTiff`, `concatTiffs(blobs)`, `hasAlpha(canvas)`, `canvasContext2d`, `extensionForImage`, `mimeForImage` |
| `src/lib/pdf/tools/types.ts` | the declarative `PdfToolDefinition` contract, `ToolRunContext`, `ToolResult`, `ToolField`, helpers `stringValue/numberValue/booleanValue/arrayValue/defaultValues` |

Conventions for every new file:

- TypeScript `strict`, no `any` in exported signatures, no new npm dependency
  unless this document names it.
- Every user-facing error message is a complete sentence naming what to do
  (the app renders `error.message` verbatim in a banner).
- Long operations call the supplied `progress(fraction, message?)` and check
  `signal.aborted` between pages.
- Never hold a module-level mutable document; callers own sessions.
- Add a `tests/pdf/<module>.test.ts` for pure logic (parsers, geometry,
  tokenizers). jsdom has no canvas, so guard canvas paths with
  `describe.skipIf(typeof HTMLCanvasElement === 'undefined')` or test the pure
  half only. `tests/setup.ts` must exist and import `@testing-library/jest-dom/vitest`.

---

## 1. Owner: engines — `src/lib/pdf/engines/**`

Reverse-engineered from BentoPDF's shipped `wasm-provider-Cp29wuFm.js`
(verified verbatim): three optional engines, each a lazily fetched CDN module,
user-overridable in `localStorage`, with an allow-list so a stored URL cannot
point at an attacker-controlled host.

```ts
// provider.ts
export type EngineId = 'pymupdf' | 'ghostscript' | 'cpdf';
export const ENGINE_DEFAULTS: Record<EngineId, string>;      // observed CDN URLs
export interface EngineProvider {
  getUrl(id: EngineId): string;
  isConfigured(id: EngineId): boolean;
  isUserConfigured(id: EngineId): boolean;
  setUrl(id: EngineId, url: string): void;
  removeUrl(id: EngineId): void;
  reset(): void;
  isTrustedUrl(url: string): boolean;
  validateUrl(id: EngineId, url: string): Promise<{ valid: boolean; error?: string }>;
  snapshot(): Record<EngineId, string>;
  subscribe(listener: () => void): () => void;
}
export const engines: EngineProvider;      // singleton, localStorage key 'browsersnip:wasm-engines'
export class EngineUnavailable extends Error { engine: EngineId; remediation: string }
```

```ts
// pymupdf.ts   — module URL `${base}dist/index.js`, `new m.PyMuPDF({assetPath: base+'assets/'})`, `await load()`
export function pymupdf(): Promise<PyMuPDFInstance>;   // memoised, concurrent-safe
export type PyMuPDFInstance = { Document: new (data?: Uint8Array, opts?: {title?: string; password?: string}) => PyMuPDFDocument; close(): void };
export interface PyMuPDFDocument { /* typed surface you actually use */ }
// ghostscript.ts — `${base}gs.js`, `createGSModule()`; expose run(args: string[], files) 
// cpdf.ts       — injects `${base}coherentpdf.browser.min.js` as a <script>, returns window.coherentpdf
export function cpdf(): Promise<CpdfApi>;              // { call(cmd: string): Promise<number>, setOutputBufferToFile..., readInputFile..., getFileData... }
```

Validation test files (same as BentoPDF, so a custom CDN can be checked):
`pymupdf → dist/index.js`, `ghostscript → gs.js`, `cpdf → coherentpdf.browser.min.js`.
`setUrl` must reject a URL whose host is not already trusted **unless** the user
typed it deliberately — mirror BentoPDF: a URL the user sets becomes trusted.
Also keep the per-engine prefix check that refuses a stale URL from an older
package name/version.

Then `src/lib/pdf/engines/EngineGate.tsx`:

```tsx
export function EngineBadge({ id }: { id: EngineId }): JSX.Element;      // status pill
export function EngineGate({ id, children }: { id: EngineId; children: ReactNode }): JSX.Element;
export function EngineSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element;
export function useEngineStatus(): Record<EngineId, { configured: boolean; url: string; fromUser: boolean }>;
```

The dialog is reachable from the app nav. Copy must state plainly that the
module is downloaded once from a CDN, that files never leave the device, and
that these three engines are AGPL-3.0 while BrowserSnip is MIT.

## 2. Owner: annotations — `src/lib/pdf/core/annotations.ts`

Pure pdf-lib object writing. No canvas.

```ts
export type AnnotationKind =
  | 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'
  | 'Text' | 'FreeText' | 'Ink' | 'Square' | 'Circle' | 'Line' | 'Arrow'
  | 'Polygon' | 'PolyLine' | 'Stamp' | 'Caret' | 'Popup' | 'Link' | 'Redact' | 'Widget';

export interface QuadRect { x: number; y: number; width: number; height: number } // PDF user space, origin bottom-left

export interface AnnotationSpec {
  kind: AnnotationKind;
  page: number;                 // 0-based
  rect: QuadRect;
  color?: string;               // #rrggbb
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;             // 0..1 -> /CA
  contents?: string;
  author?: string;
  createdAt?: Date;
  freeText?: { text: string; fontSize: number; fontFamily?: string; bold?: boolean; italic?: boolean; align?: 'left'|'center'|'right'; background?: string; border?: boolean };
  inkPath?: number[][][];       // strokes of [x,y] pairs, user space
  lineEnds?: [QuadRect['x'], number, number, number]; // [x1,y1,x2,y2]
  lineArrow?: 'none' | 'start' | 'end' | 'both';
  quadPoints?: number[];        // 8 numbers per line for text markup
  stampImage?: Uint8Array;      // rasterised stamp appearance
  stampName?: string;           // built-in /S value e.g. 'Draft'
  link?: { type: 'goTo'; page: number } | { type: 'uri'; uri: string };
  redact?: boolean;             // /Redact true
  flags?: string[];             // e.g. ['Print','ReadOnly']
}

export function addAnnotation(doc: PDFDocument, spec: AnnotationSpec): number; // returns annotation index
export function addAnnotations(doc: PDFDocument, specs: AnnotationSpec[]): void;
export interface ExistingAnnotation { kind: AnnotationKind; page: number; rect: QuadRect; contents?: string; color?: string; readonly: boolean; flags: number; ref: PDFRef }
export function listAnnotations(doc: PDFDocument): ExistingAnnotation[];
export function removeAnnotations(doc: PDFDocument, filter: { pages?: number[]; kinds?: AnnotationKind[]; except?: AnnotationKind[] }): number;
export function annotationCount(doc: PDFDocument): number;
/** True content removal: clips the marked region out of the content stream. */
export function applyRedactions(doc: PDFDocument, rects: {page: number; rect: QuadRect}[], opts?: { fill?: string; onImage?: 'blackout' | 'keep' }): { removed: number; rasterised: boolean };
```

Requirements: annotations must be visible in Okular/Acrobat/Chrome, so write
`/Subtype /Annots`, `/Rect`, `/AP /N <xobject>`, `/C`, `/CA`, `/NM`, `/T`,
`/M`, `/F`, and for text markup `/QuadPoints`. Appearance streams must embed
their own resources (`/XObject`, `/Font`) — use `doc.context.register(...)`.
`applyRedactions` must not merely paint a box: for text it rewrites the page
content stream (§3 `removeTextInRects`) and, when the region contains an image,
falls back to a blackout + `rasterised: true` so the caller can warn.

## 3. Owner: content + layout — `src/lib/pdf/core/content.ts`, `src/lib/pdf/core/layout.ts`, `src/lib/pdf/core/sanitize.ts`

```ts
// content.ts — a real tokenizer over PDF content streams (no regex hacks).
export interface ContentOp { name: string; operands: (number | string | boolean | null)[]; start: number; end: number }
export function parseContentStream(bytes: Uint8Array): ContentOp[];
export function serialiseContentStream(ops: ContentOp[]): Uint8Array;
export function pageContentStreams(page: PDFPage): { bytes: Uint8Array; ref: PDFRef }[];
export function rewritePageContent(page: PDFPage, fn: (ops: ContentOp[]) => ContentOp[]): number; // ops changed
export function recolourText(page: PDFPage, from: string | 'any', to: string, opts?: { bold?: boolean }): number; // operator rg/RG/g/G/k/K
export function prependBackground(page: PDFPage, rect: QuadRect, color: string): void;  // /Artifact /Background BDC..BMC..EMC
export function removeTextInRects(page: PDFPage, rects: QuadRect[]): { removedGlyphRuns: number; needsRasterFallback: boolean }; // TJ/Tj inside rect, incl. cross-BT blocks
export function textRects(page: PDFPage): { rect: QuadRect; text: string }[];      // from Tm/Td/TD/Tz/TL + TJ arrays
export function pageUsesColor(page: PDFPage): boolean;
export function greyscalePage(page: PDFPage): number;   // convert rg/k colour ops to grey
export function stripEmbeddedFiles(doc: PDFDocument): number;
export function setViewerPreferences(doc: PDFDocument, prefs: Record<string, unknown>): void;
export function objectAudit(doc: PDFDocument): { objects: number; streams: number; images: number; fonts: number; uncompressedBytes: number };

// sanitize.ts — the script a document runs by itself, and its removal.
// An entry is a place that RUNS an action (`/OpenAction`, `/A`, one `/AA` trigger,
// `/JavaScript` in the catalogue or the name tree), inline or behind a reference;
// the action dictionary it reaches is emptied with it and is never a second entry.
export interface ScriptEntry { where: string; remove: () => void }
export interface ScriptReport { present: number; places: string[]; unreachable: string | null }
export function inspectScript(doc: PDFDocument): ScriptReport;
export function stripScript(doc: PDFDocument): { removed: number; where: string[] };

// layout.ts — a rich-text block model rendered to real, selectable PDF text.
export interface Inline { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; link?: string; code?: boolean; size?: number; superscript?: boolean; subscript?: boolean; font?: string }
export type Block =
  | { kind: 'heading'; level: 1|2|3|4|5|6; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[]; align?: 'left'|'center'|'right'|'justify'; indent?: number; spaceBefore?: number; spaceAfter?: number }
  | { kind: 'list'; ordered?: boolean; items: { inlines: Inline[]; level: number; checked?: boolean|null }[] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'table'; header?: Inline[][]; rows: Inline[][][]; widths?: number[]; caption?: string }
  | { kind: 'image'; bytes: Uint8Array; mime?: string; caption?: string; width?: number; alt?: string }
  | { kind: 'rule' } | { kind: 'pagebreak' };

export interface LayoutOptions { pageSize?: string | [number, number]; margin?: number; baseFontSize?: number; lineHeight?: number; fontFamily?: string; header?: string; footer?: string; pageNumbers?: boolean; columns?: 1|2; color?: string }
export function renderBlocks(doc: PDFDocument, blocks: Block[], opts?: LayoutOptions): Promise<PDFPage[]>;
export function textToBlocks(text: string, opts?: { monospace?: boolean; paragraphs?: '\n\n' | '\n' }): Block[];
export function markdownToBlocks(markdown: string, opts?: { images?: (src: string) => Promise<Uint8Array|null> }): Promise<Block[]>;   // uses `marked` + a tokenizer walk, NOT innerHTML
export function htmlToBlocks(html: string, opts?: { fetchImage?: (src: string) => Promise<Uint8Array|null> }): Promise<Block[]>;     // DOMParser walk
export function csvToBlocks(text: string, opts?: { delimiter?: string; header?: boolean }): Promise<Block[]>;                        // use the `xlsx` reader already in deps
export function jsonToBlocks(value: unknown, opts?: { maxDepth?: number }): Block[];
export function xmlToBlocks(text: string): Block[];
export function rtfToBlocks(rtf: string): Block[];   // small RTF reader: \b \i \ul \par \table?, ignore destinations
```

`htmlToBlocks`/`markdownToBlocks` must sanitise: build a `DOMParser` tree and
walk it; never inject author HTML into the live document (the old
`html-to-pdf` did, which is an XSS in the page's own origin). External images
only load when the caller passes `fetchImage`.

## 4. Owner: document parts — `bookmarks.ts`, `metadata.ts`, `attachments.ts`, `forms.ts`

```ts
// bookmarks.ts (pdf-lib exposes doc.getOutline()/insertOutlineEntry; cpdf optional)
export interface OutlineNode { title: string; page: number | null; children?: OutlineNode[]; color?: string; bold?: boolean; italic?: boolean; destination?: { kind:'fit'|'xyz'; x?:number; y?:number; zoom?:number } }
export function readOutline(doc: PDFDocument): OutlineNode[];
export function writeOutline(doc: PDFDocument, nodes: OutlineNode[]): void;      // replaces the tree
export function outlineFromJson(json: string): OutlineNode[];                    // accept nested array OR [{title,page}] OR FreeMind/OPML-lite text
export function outlineToJson(nodes: OutlineNode[]): string;
export function generateTocPage(doc: PDFDocument, opts: { nodes: OutlineNode[]; title?: string; fontSize?: number; leader?: 'dots'|'none'; rightAlignPageNumbers?: boolean; startPage?: number; pagesBefore?: number }): Promise<PDFPage[]>;
export function addPageLabels(doc: PDFDocument, ranges: { start: number; style: 'D'|'R'|'r'|'A'|'a'|''; prefix?: string; firstPageNumber?: number }[]): void;
export function readPageLabels(doc: PDFDocument): { page: number; label: string }[];
export function addBatesNumbers(doc: PDFDocument, opts: { format: string; start: number; increment: number; sequenceDigits: number; prefix?: string; suffix?: string; fontFamily?: string; fontSize: number; color: string; position: string; pages: string | 'all'; unitOffset?: number; crossDocument?: boolean }): { stamped: number }; // format tokens {n},{org},{page},{total},{date},{time}
```

```ts
// metadata.ts
export interface DocumentInfo { title?: string; author?: string; subject?: string; keywords?: string; creator?: string; producer?: string; creationDate?: string; modDate?: string; extra?: Record<string,string>; trapped?: string; lang?: string }
export function readInfo(doc: PDFDocument): DocumentInfo;
export function writeInfo(doc: PDFDocument, info: DocumentInfo, opts?: { freshDates?: boolean }): void;   // PDF date format (D:YYYYMMDDHHmmSSOHH'mm')
export function stripInfo(doc: PDFDocument): number;
export interface XmpSummary { title?: string; description?: string; creator?: string; keywords?: string[]; pdfVersion?: string; pdfaPart?: number; pdfaConformance?: string; raw: string | null }
export function readXmp(doc: PDFDocument): XmpSummary | null;
export function stripXmp(doc: PDFDocument): boolean;
export function writeXmp(doc: PDFDocument, xmp: string): void;
export function metadataReport(doc: PDFDocument, bytes: Uint8Array): { title: string; rows: { label: string; value: string }[] }[]; // human-readable, incl. per-page sizes
```

```ts
// attachments.ts  — doc.attach() exists in the fork; reading must be hand-written
export interface AttachmentEntry { name: string; filename?: string; mimeType?: string; description?: string; size: number; creationDate?: string; modificationDate?: string; checksum?: string; bytes: Uint8Array }
export function listAttachments(doc: PDFDocument): AttachmentEntry[];     // /Names /EmbeddedFiles and /EmbeddedFiles on each page
export function addAttachments(doc: PDFDocument, files: { name: string; bytes: Uint8Array; mimeType?: string; description?: string }[]): Promise<number>;
export function removeAttachments(doc: PDFDocument, names: string[]): number;
export function replaceAttachment(doc: PDFDocument, name: string, bytes: Uint8Array): Promise<boolean>;
```

```ts
// forms.ts — AcroForm read/fill/flatten using pdf-lib's PDFDocument.getForm()
export interface FormFieldInfo { name: string; type: 'text'|'checkbox'|'radio'|'dropdown'|'list'|'button'|'signature'; page: number; rect: QuadRect; value?: string; options?: string[]; checked?: boolean; readOnly: boolean; required: boolean; multiline: boolean; maxLen?: number; alternateName?: string }
export function listFormFields(doc: PDFDocument): FormFieldInfo[];
export function fillForm(doc: PDFDocument, values: Record<string, string | boolean>, opts?: { appearance?: boolean }): { filled: number; missing: string[] };
export async function flattenForm(doc: PDFDocument, session?: PdfSession): Promise<{ flattened: number; needsRender: boolean }>;  // without a session, bake with pdf-lib appearances only
export function createFormField(doc: PDFDocument, page: number, spec: { type: 'text'|'checkbox'|'radio'|'dropdown'|'list'; rect: QuadRect; name: string; label?: string; options?: string[]; value?: string; fontSize?: number; multiline?: boolean; required?: boolean; readOnly?: boolean; maxLength?: number }): number;
export function hasXfa(doc: PDFDocument): boolean;
```

## 5. Owner: analysis — `tables.ts`, `measure.ts`, `ocr.ts`, `convert.ts` (PDF→SVG/JSON/markdown helpers)

```ts
// tables.ts — detect tabular structure from ExtractedTextItem[]
export interface DetectedTable { page: number; rect: QuadRect; rows: string[][]; confidence: number; headerRow?: string[] }
export function detectTables(items: ExtractedTextItem[], opts?: { minRows?: number; tolerance?: number; useVectorLines?: boolean; lines?: VectorLine[] }): DetectedTable[];
export function tablesToCsv(tables: DetectedTable[]): string;
export function tablesToAoa(tables: DetectedTable[]): string[][][];
// clustering by projection profiles; must handle ruled tables when `lines` are supplied
export interface VectorLine { x1:number;y1:number;x2:number;y2:number;width:number }

// measure.ts
export async function isBlankPage(session: PdfSession, page: number, opts?: { inkThreshold?: number; scale?: number }): Promise<{ blank: boolean; inkRatio: number }>;
export async function detectSkew(session: PdfSession, page: number, opts?: { maxAngle?: number; scale?: number }): Promise<{ angle: number; confidence: number }>;   // projection-profile / Hough-lite over edge pixels
export function pageSizeReport(doc: PDFDocument): { page: number; widthPt: number; heightPt: number; widthMm: number; heightMm: number; orientation: 'portrait'|'landscape'|'square'; rotation: number; name: string }[];   // name = A4/Letter/… matched within 1 pt
export async function rasterizeWithOptions(session: PdfSession, doc: PDFDocument, opts: { dpi: number; format: 'jpeg'|'png'; quality?: number; filter?: string; background?: string; pages?: string; progress: (f:number,m?:string)=>void; signal: AbortSignal }): Promise<Uint8Array>;
export async function applyColorFilter(session, doc, opts: { brightness: number; contrast: number; saturation: number; hue: number; invert: boolean; grayscale: boolean; threshold?: number; pages: string; progress; signal }): Promise<Uint8Array>;  // CSS filter string composed once
export async function scannerEffect(session, doc, opts: { dpi: number; whitening: boolean; sharpen: boolean; grayscale: boolean; contrast: number; progress; signal }): Promise<Uint8Array>;
export function compressionPresets(): { id: string; label: string; dpi: number; quality: number; description: string }[];

// ocr.ts — reuse src/lib/ocr/engine.ts (ppu-paddle-ocr); do not add tesseract
export interface OcrPageResult { page: number; text: string; width: number; height: number; blocks: { text: string; rect: QuadRect; confidence: number }[] }
export async function ocrDocument(session: PdfSession, opts: { pages?: string; dpi?: number; lang?: string; onProgress?: (done:number,total:number,page:number)=>void; signal?: AbortSignal; onStatus?: (s: string) => void }): Promise<OcrPageResult[]>;
export async function addSearchableTextLayer(doc: PDFDocument, results: OcrPageResult[], opts?: { invisible?: boolean; fontSizeFallback?: number }): Promise<{ words: number; pages: number }>;  // render mode 3 text over the page image
export { getOcrStatus, destroyOcr } from '@/lib/ocr/engine';

// convert.ts — structured exports from a rendered document
export interface PdfJsonPage { page: number; width: number; height: number; rotation: number; text: string; blocks: PdfJsonBlock[]; images: number; links: string[] }
export interface PdfJsonBlock { type: 'text'|'image'|'table'; rect: QuadRect; text?: string; lines?: { text: string; bbox: QuadRect; fontHeight: number }[]; rows?: string[][] }
export function documentToJson(doc: PDFDocument, session: PdfSession, pages?: number[]): Promise<{ meta: Record<string, unknown>; pages: PdfJsonPage[] }>;
export function jsonToMarkdown(json: { pages: PdfJsonPage[] }, opts?: { headingHeights?: number[]; tables?: boolean; pageBreaks?: boolean }): string;
export function jsonToText(json: { pages: PdfJsonPage[] }, opts?: { formFeed?: boolean; pageMarkers?: boolean }): string;
export function jsonToLlamaIndex(json: { pages: PdfJsonPage[] }, opts?: { title?: string; extraMetadata?: Record<string, unknown> }): { ref_doc_info: Record<string, { metadata: unknown; text: string }> };
export function documentToSvg(doc: PDFDocument, session: PdfSession, page: number, opts?: { embedImages?: boolean; floatPrecision?: number; fontToPath?: boolean }): Promise<string>;  // rebuild from pdf.js getOperatorList() (OPS.paintTypeText/path/majorPath/minorPath)
export function jsonToHtml(json: { pages: PdfJsonPage[] }): string;
```

## 6. Registry (owner: lead — do not edit)

`src/lib/pdf/tools/registry.ts` imports each group module and flattens. Group
modules export `const <group>Tools: PdfToolDefinition[]`. A tool that needs a
bespoke full-pane UI sets `surface: 'custom'` and supplies `mainComponent`,
lazily imported.

## 7. Licence and offline notes

- Bundled runtime dependencies stay MIT/Apache/BSD: `@maxwbh/pdf-lib`,
  `@pdf-lib/fontkit`, `pdfjs-dist`, `jszip`, `node-forge`, `mammoth`, `marked`,
  `utif`, `docx`, `xlsx`, `html2canvas`, `ppu-paddle-ocr`.
- The three §1 engines are AGPL-3.0, fetched from a CDN at first use and never
  bundled. Anything that can be done with the MIT core must be done with the
  MIT core; an engine is only a preference, and every engine-backed tool must
  state which part degrades without it.
- No tool may require the network for its primary path except §1 engines,
  lazy script fonts (`core/fonts.ts`), and RFC 3161 timestamping.
