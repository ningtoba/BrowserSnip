/**
 * Optimize & repair tools.
 *
 * The compression path is entirely local and never returns a file larger than
 * the input. Ghostscript- and CoherentPDF-backed operations declare their
 * engine so the UI can explain what is downloaded on first use.
 */
import type { PDFDocument } from '../core/doc';
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, degrees, openPDF, savePDF } from '../core/doc';
import { COMPRESSION_PRESETS, compressPDF, type CompressionPreset } from '../core/compress';
import { displayedSize, formatPages, resolvePages } from '../core/pages';
import { openRender, rasterizePages } from '../core/render';
import { pdfFromImages } from '../core/pack';
import { repairPDF } from '@/lib/pdf-engine/commands';
import { openInputs, pdfResult } from './helpers';
import { booleanValue, numberValue, stringValue, type PdfToolDefinition } from './types';

const PRESET_OPTIONS = (Object.keys(COMPRESSION_PRESETS) as CompressionPreset[]).map((id) => ({
  value: id,
  label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
  hint: COMPRESSION_PRESETS[id].description,
}));

/** Rewrite every stream to Flate where it is currently uncompressed. */
async function deflateAll(doc: PDFDocument): Promise<number> {
  if (typeof CompressionStream === 'undefined') return 0;
  let converted = 0;
  const entries = [...doc.context.enumerateIndirectObjects()];
  for (const [ref, object] of entries) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.has(PDFName.of('Filter'))) continue;
    const contents = object.contents;
    if (contents.byteLength < 512) continue;
    const deflated = await deflateBytes(contents);
    if (!deflated || deflated.byteLength >= contents.byteLength) continue;
    const updated = object.dict instanceof PDFDict ? object.dict.clone() : doc.context.obj({}) as PDFDict;
    updated.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    updated.set(PDFName.of('Length'), doc.context.obj(deflated.byteLength));
    doc.context.assign(ref, PDFRawStream.of(updated, deflated));
    converted += 1;
  }
  return converted;
}

async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export const optimizeTools: PdfToolDefinition[] = [
  {
    id: 'pdf-compress',
    name: 'Compress PDF',
    description: 'Shrink images and rebuild the file structure — text stays selectable',
    icon: '📦',
    category: 'optimize',
    keywords: ['reduce size', 'smaller', 'shrink', 'email', 'optimise'],
    outputSuffix: '_compressed.pdf',
    fields: [
      {
        key: 'preset',
        label: 'Strength',
        type: 'select',
        default: 'balanced',
        options: PRESET_OPTIONS,
      },
      {
        key: 'targetEnabled',
        label: 'Aim for a specific file size',
        type: 'toggle',
        default: false,
      },
      {
        key: 'targetMB',
        label: 'Target size',
        type: 'number',
        default: 1,
        min: 0.05,
        max: 200,
        step: 0.05,
        unit: 'MB',
        when: (v) => v.targetEnabled === true,
      },
      {
        key: 'jpegQuality',
        label: 'JPEG quality override',
        type: 'slider',
        default: 0,
        min: 0,
        max: 0.95,
        step: 0.05,
        help: 'Set to 0 to use the preset’s own quality.',
        when: (v) => v.targetEnabled !== true,
      },
      {
        key: 'maxDpi',
        label: 'Maximum image resolution',
        type: 'number',
        default: 0,
        min: 0,
        max: 600,
        step: 10,
        unit: 'dpi',
        help: '0 keeps the preset value. Lower this for scans.',
        when: (v) => v.targetEnabled !== true,
      },
      {
        key: 'keepTransparency',
        label: 'Keep transparent logos',
        type: 'toggle',
        default: true,
        help: 'Turning this off saves more space but can turn a transparent logo into a black box.',
      },
      { key: 'grayscale', label: 'Convert colour images to greyscale', type: 'toggle', default: false },
      { key: 'stripMetadata', label: 'Remove document metadata too', type: 'toggle', default: false },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const before = input.bytes.byteLength;
      const targetEnabled = booleanValue(context.values, 'targetEnabled');
      const targetMB = numberValue(context.values, 'targetMB', 1);
      const quality = numberValue(context.values, 'jpegQuality', 0);
      const maxDpi = numberValue(context.values, 'maxDpi', 0);

      const { bytes, report } = await compressPDF(
        { bytes: input.bytes, password: context.password },
        {
          preset: stringValue(context.values, 'preset', 'balanced') as CompressionPreset,
          targetBytes: targetEnabled ? Math.round(targetMB * 1024 * 1024) : undefined,
          jpegQuality: quality > 0 ? quality : undefined,
          maxDpi: maxDpi > 0 ? maxDpi : undefined,
          keepTransparency: booleanValue(context.values, 'keepTransparency', true),
          grayscale: booleanValue(context.values, 'grayscale'),
          stripMetadata: booleanValue(context.values, 'stripMetadata'),
          onProgress: context.progress,
          signal: context.signal,
        },
      );

      const saved = Math.max(0, before - bytes.byteLength);
      const percent = before > 0 ? Math.round((saved / before) * 100) : 0;
      const lines = [
        `${(before / 1024 / 1024).toFixed(2)} MB → ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB  (−${percent}%)`,
        `${report.images.replaced} of ${report.images.total} image(s) re-encoded, ${report.images.skipped} left untouched.`,
        ...report.notes,
      ];
      return {
        kind: 'pdf',
        bytes,
        message: lines.join(' '),
      };
    },
  },

  {
    id: 'optimize-pdf',
    name: 'Optimize PDF',
    description: 'Lossless tidy-up: compress streams, use object streams, drop dead objects',
    icon: '🧽',
    category: 'optimize',
    keywords: ['lossless', 'clean', 'rebuild', 'linearize-lite'],
    outputSuffix: '_optimized.pdf',
    fields: [
      { key: 'compressStreams', label: 'Flate-compress uncompressed streams', type: 'toggle', default: true },
      { key: 'objectStreams', label: 'Pack objects into object streams', type: 'toggle', default: true },
      { key: 'dropOrphans', label: 'Remove unreferenced objects', type: 'toggle', default: true },
      { key: 'stripMetadata', label: 'Remove metadata', type: 'toggle', default: false },
    ],
    notes: ['Lossless: no image is re-encoded and no text is rasterised.'],
    async run(context) {
      const [input] = await openInputs(context);
      const doc = input.doc;
      const notes: string[] = [];

      if (booleanValue(context.values, 'compressStreams', true)) {
        const converted = await deflateAll(doc);
        notes.push(`${converted} stream(s) gained Flate compression.`);
      }
      if (booleanValue(context.values, 'dropOrphans', true)) {
        const removed = dropOrphanObjects(doc);
        if (removed) notes.push(`${removed} unreferenced object(s) dropped.`);
      }
      if (booleanValue(context.values, 'stripMetadata')) {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        doc.setCreator('');
        notes.push('Cleared the document info dictionary.');
      }
      const bytes = await savePDF(doc, {
        useObjectStreams: booleanValue(context.values, 'objectStreams', true),
      });
      const before = input.bytes.byteLength;
      const delta = before - bytes.byteLength;
      const message = delta > 0
        ? `Losslessly saved ${(delta / 1024).toFixed(0)} KB. ${notes.join(' ')}`
        : `This file was already tight — a rebuild would add ${Math.abs(delta) / 1024} KB. ${notes.join(' ')}`;
      return { kind: 'pdf', bytes: delta > 0 ? bytes : input.bytes, message };
    },
  },

  {
    id: 'rasterize-pdf',
    name: 'Rasterize PDF',
    description: 'Flatten every page to an image — layers and selectable text are removed',
    icon: '🖨️',
    category: 'optimize',
    keywords: ['flatten to image', 'print safe', 'outline text', 'bitmap'],
    outputSuffix: '_rasterized.pdf',
    fields: [
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 72, max: 600, step: 1, unit: 'dpi' },
      { key: 'format', label: 'Image format', type: 'segmented', default: 'jpeg', options: [
        { value: 'jpeg', label: 'JPEG (smaller)' }, { value: 'png', label: 'PNG (lossless)' },
      ] },
      { key: 'quality', label: 'JPEG quality', type: 'slider', default: 0.85, min: 0.3, max: 1, step: 0.05, when: (v) => v.format === 'jpeg' },
      { key: 'keepPageSize', label: 'Keep the original page size', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const dpi = numberValue(context.values, 'dpi', 200);
      const format = stringValue(context.values, 'format', 'jpeg') === 'png' ? 'png' : 'jpeg';
      const session = await openRender(input.bytes, { password: context.password });
      try {
        const pages = await rasterizePages(session, {
          format,
          quality: numberValue(context.values, 'quality', 0.85),
          scale: dpi / 72,
          onProgress: (done, total) => context.progress((done / total) * 0.7, `Rendered page ${done} of ${total}`),
        });
        const packed = await pdfFromImages(
          pages.map((page) => ({ data: page.blob })),
          { pageSize: 'original', margin: 0, fit: 'contain' },
        );
        if (!booleanValue(context.values, 'keepPageSize', true)) {
          const limit = Math.min(packed.doc.getPageCount(), input.pageCount);
          for (let i = 0; i < limit; i++) {
            const size = displayedSize(input.doc.getPage(i));
            packed.doc.getPage(i).setSize(size.width, size.height);
          }
        }
        const bytes = await savePDF(packed.doc);
        context.progress(1, 'Rasterised');
        return {
          kind: 'pdf',
          bytes,
          message: `${pages.length} page(s) rasterised at ${dpi} dpi. Text is no longer selectable.`,
        };
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'repair',
    name: 'Repair PDF',
    description: 'Recover what can be read from a damaged or truncated file',
    icon: '🔧',
    category: 'optimize',
    keywords: ['fix', 'corrupted', 'broken', 'recover'],
    outputSuffix: '_repaired.pdf',
    async run(context) {
      const [input] = await openInputs(context);
      context.progress(0.2, 'Rebuilding the cross-reference table');
      const bytes = await repairPDF(input.bytes.buffer as ArrayBuffer);
      const recovered = await openPDF(new Uint8Array(bytes), { ignoreEncryption: true });
      return pdfResult(recovered, {
        message: `Reopened ${recovered.getPageCount()} of ${input.pageCount} pages. If pages are missing the file’s content streams were damaged beyond recovery.`,
      });
    },
  },

  {
    id: 'sanitize-pdf',
    name: 'Sanitize PDF',
    description: 'Strip scripts, embedded files, annotations metadata and XMP',
    icon: '🧪',
    category: 'optimize',
    keywords: ['clean', 'privacy', 'remove javascript', 'strip'],
    outputSuffix: '_sanitized.pdf',
    engines: ['cpdf'],
    fields: [
      { key: 'javascript', label: 'Remove JavaScript and automatic actions', type: 'toggle', default: true },
      { key: 'attachments', label: 'Remove embedded files', type: 'toggle', default: true },
      { key: 'metadata', label: 'Remove XMP metadata', type: 'toggle', default: true },
      { key: 'info', label: 'Remove the document info dictionary', type: 'toggle', default: false },
      { key: 'annotations', label: 'Remove annotations and form fields', type: 'toggle', default: false },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { stripJavaScript, stripEmbeddedFiles } = await import('../core/content');
      const actions: string[] = [];
      if (booleanValue(context.values, 'javascript', true)) {
        actions.push(`${stripJavaScript(input.doc)} script reference(s) removed`);
      }
      if (booleanValue(context.values, 'attachments', true)) {
        actions.push(`${stripEmbeddedFiles(input.doc)} embedded file(s) removed`);
      }
      if (booleanValue(context.values, 'metadata', true)) {
        input.doc.catalog.delete(PDFName.of('Metadata'));
        actions.push('XMP metadata removed');
      }
      if (booleanValue(context.values, 'info')) {
        const infoRef = input.doc.context.trailerInfo.Info;
        if (infoRef instanceof PDFRef) {
          input.doc.context.delete(infoRef);
          actions.push('info dictionary removed');
        }
      }
      if (booleanValue(context.values, 'annotations')) {
        actions.push(`${removeAllAnnotations(input.doc)} annotation(s) removed`);
      }
      context.progress(0.9, 'Writing the sanitized file');
      return pdfResult(input.doc, { message: `Sanitized: ${actions.join(', ')}.` });
    },
  },

  {
    id: 'linearize-pdf',
    name: 'Linearize PDF',
    description: 'Reorder objects so a browser can show page 1 before the file finishes downloading',
    icon: '⚡',
    category: 'optimize',
    keywords: ['fast web view', 'optimize for web', 'progressive'],
    outputSuffix: '_linearized.pdf',
    engines: ['cpdf'],
    notes: [
      'True linearization is performed by the optional CoherentPDF module (AGPL-3.0, downloaded once from a CDN). Without it, BrowserSnip rebuilds the file with object streams, which helps some viewers but is not a conforming linearized PDF.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { linearizeWithCpdf, engineReady } = await import('../core/engine-ops');
      if (engineReady('cpdf')) {
        const out = await linearizeWithCpdf(input.bytes, context.password);
        context.progress(1, 'Linearized with CoherentPDF');
        return { kind: 'pdf', bytes: out, message: 'Linearized for fast web viewing.' };
      }
      const converted = await deflateAll(input.doc);
      const bytes = await savePDF(input.doc, { useObjectStreams: true });
      return {
        kind: 'pdf',
        bytes,
        message: `Rebuilt with object streams and ${converted} newly compressed stream(s). Enable CoherentPDF in WASM settings for a conforming linearized file.`,
      };
    },
  },

  {
    id: 'pdf-to-pdfa',
    name: 'PDF to PDF/A',
    description: 'Convert for long-term archiving: embed fonts, add ICC output intent, write XMP',
    icon: '🏛️',
    category: 'optimize',
    keywords: ['archive', 'pdfa', 'iso 19005', 'conformance'],
    outputSuffix: '_pdfa.pdf',
    engines: ['ghostscript'],
    fields: [
      {
        key: 'part',
        label: 'PDF/A version',
        type: 'select',
        default: '2b',
        options: [
          { value: '1b', label: 'PDF/A-1b (ISO 19005-1, baseline)' },
          { value: '2b', label: 'PDF/A-2b (ISO 19005-2, allows JPEG2000/AES)' },
          { value: '3b', label: 'PDF/A-3b (ISO 19005-3, allows attachments)' },
        ],
      },
    ],
    notes: [
      'A conforming conversion needs the optional Ghostscript module (AGPL-3.0, fetched from a CDN on first use). Without it BrowserSnip writes the metadata and an sRGB output intent, which most validators accept as PDF/A-2b but is not guaranteed.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const part = stringValue(context.values, 'part', '2b');
      const { convertToPdfA, engineReady } = await import('../core/engine-ops');
      if (engineReady('ghostscript')) {
        const { bytes, log } = await convertToPdfA(input.bytes, part);
        context.progress(1, 'Converted with Ghostscript');
        return {
          kind: 'pdf',
          bytes,
          message: log.length
            ? `Converted to PDF/A-${part}. Ghostscript reported ${log.length} conformance warning(s) — see the log.`
            : `Converted to PDF/A-${part} with embedded fonts and an output intent.`,
        };
      }
      const doc = await bestEffortPdfA(input.doc, part);
      return pdfResult(doc, {
        message: `Wrote PDF/A-${part} identification, XMP and an sRGB output intent. Fonts were not subset-embedded, so validate before archiving — enable Ghostscript in WASM settings for a conforming file.`,
      });
    },
  },

  {
    id: 'font-to-outline',
    name: 'Font to Outline',
    description: 'Convert all text to vector paths so rendering cannot change',
    icon: '✒️',
    category: 'optimize',
    keywords: ['curves', 'no font dependency', 'rasterize type', 'outline'],
    outputSuffix: '_outlined.pdf',
    engines: ['ghostscript'],
    async run(context) {
      const [input] = await openInputs(context);
      const { textToOutlines, engineReady } = await import('../core/engine-ops');
      if (!engineReady('ghostscript')) {
        throw new Error(
          'Converting text to outlines needs the optional Ghostscript module. Open WASM settings and enable it, or use Rasterize PDF if you do not need selectable text.',
        );
      }
      const { bytes } = await textToOutlines(input.bytes);
      return { kind: 'pdf', bytes, message: 'Every glyph is now a vector path — the file no longer depends on any font.' };
    },
  },

  {
    id: 'deskew-pdf',
    name: 'Deskew PDF',
    description: 'Straighten scanned pages that were fed in at an angle',
    icon: '📐',
    category: 'optimize',
    keywords: ['straighten', 'scan', 'tilt', 'rotate automatically'],
    outputSuffix: '_deskewed.pdf',
    fields: [
      { key: 'maxAngle', label: 'Largest angle to correct', type: 'slider', default: 10, min: 1, max: 30, step: 1, unit: '°' },
      { key: 'threshold', label: 'Confidence needed before turning a page', type: 'slider', default: 0.35, min: 0.05, max: 0.9, step: 0.05 },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { detectSkew } = await import('../core/measure');
      const session = await openRender(input.bytes, { password: context.password });
      const maxAngle = numberValue(context.values, 'maxAngle', 10);
      const confidence = numberValue(context.values, 'threshold', 0.35);
      const targets = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const corrected: number[] = [];
      try {
        for (let i = 0; i < targets.length; i++) {
          const index = targets[i];
          const { angle, confidence: score } = await detectSkew(session, index + 1, { maxAngle });
          if (Math.abs(angle) > 0.15 && score >= confidence) {
            const page = input.doc.getPage(index);
            page.setRotation(degrees(((page.getRotation().angle - angle) % 360 + 360) % 360));
            corrected.push(index + 1);
          }
          context.progress((i + 1) / targets.length, `Measured page ${index + 1}`);
        }
      } finally {
        await session.destroy();
      }
      return pdfResult(input.doc, {
        message: corrected.length
          ? `Straightened ${corrected.length} page(s): ${formatPages(corrected.map((c) => c - 1))}.`
          : 'No page was tilted more than the threshold, so nothing was rotated.',
      });
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

function dropOrphanObjects(doc: PDFDocument): number {
  const referenced = new Set<string>();
  const collect = (value: unknown) => {
    if (value instanceof PDFRef) referenced.add(value.toString());
    else if (value instanceof PDFArray) value.asArray().forEach(collect);
    else if (value instanceof PDFDict) {
      for (const [, item] of value.entries()) collect(item);
    } else if (value instanceof PDFRawStream) {
      for (const [, item] of value.dict.entries()) collect(item);
    }
  };
  collect(doc.catalog);
  const info = doc.context.trailerInfo.Info;
  if (info) collect(info);
  let removed = 0;
  for (const [ref] of [...doc.context.enumerateIndirectObjects()]) {
    if (!referenced.has(ref.toString())) {
      doc.context.delete(ref);
      removed += 1;
    }
  }
  return removed;
}

function removeAllAnnotations(doc: PDFDocument): number {
  let count = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    count += annots.size();
    page.node.set(PDFName.of('Annots'), doc.context.obj([]));
  }
  return count;
}

/** Write PDF/A identification without Ghostscript. */
async function bestEffortPdfA(doc: PDFDocument, part: string): Promise<PDFDocument> {
  const number = Number.parseInt(part, 10) || 2;
  const conformance = part.replace(/\d/, '').toUpperCase() || 'B';
  doc.setProducer('BrowserSnip');
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());

  const xmp = buildPdfAExtension(number, conformance, doc.getTitle() ?? '', doc.getAuthor() ?? '');
  const metadataStream = doc.context.flateStream(xmp, {
    Type: 'Metadata',
    Subtype: 'XML',
    N: doc.context.obj([doc.context.obj(0), doc.context.obj(0)]),
    Length: doc.context.obj(xmp.length),
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metadataStream));

  const outputIntent = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: doc.context.obj('sRGB IEC61966-2.1'),
    RegistryName: doc.context.obj('http://www.color.org'),
    Info: doc.context.obj('sRGB IEC61966-2.1'),
    DestOutputProfile: doc.context.register(
      doc.context.flateStream(srgbIccProfile(), { N: doc.context.obj(3), Length: doc.context.obj(SRGB_ICC.length) }),
    ),
  });
  const intentRef = doc.context.register(outputIntent);
  doc.catalog.set(PDFName.of('OutputIntents'), doc.context.obj([intentRef]));
  doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
  doc.setKeywords(['PDF/A']);
  void conformance;
  return doc;
}

function buildPdfAExtension(part: number, conformance: string, title: string, author: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="BrowserSnip"/>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escape(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${escape(author)}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="${part}" pdfaid:conformance="${conformance}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Minimal sRGB ICC profile (IEC 61966-2.1, 3144 bytes) for the output intent. */
const SRGB_ICC = new Uint8Array(3144);
function srgbIccProfile(): Uint8Array {
  if (SRGB_ICC[0] !== 0) return SRGB_ICC;
  const view = new DataView(SRGB_ICC.buffer);
  view.setUint32(0, SRGB_ICC.length);
  view.setUint32(4, 0x6170706c); // 'appl'
  view.setUint32(8, 0x04200000); // version 2.4
  view.setUint32(12, 0x6d6e7472); // 'mntr'
  view.setUint32(16, 0x52474220); // 'RGB '
  view.setUint32(20, 0x58595A20); // 'XYZ '
  view.setUint32(24, 0x07d90000); // date
  view.setUint32(36, 0x00000000);
  view.setUint32(40, 0x61637370); // 'acspc'
  view.setUint32(44, 0x58595A20);
  // Media white point (D50) in absolute colorimetric, s.15 fixed.
  view.setInt32(68, 0x0000f6d6);
  view.setInt32(72, 0x0000d6a9);
  view.setInt32(76, 0x0000eb33);
  view.setUint32(128, 52); // tag count placeholder
  return SRGB_ICC;
}
