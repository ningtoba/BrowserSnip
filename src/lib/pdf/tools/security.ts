/**
 * PDF security tools.
 *
 * Encryption uses the `@maxwbh/pdf-lib` fork's real crypto (RC4-40/128,
 * AES-128, AES-256 with the `/P` permissions dictionary). The previous
 * implementation called an RC4-128-only library and silently discarded all
 * seven permission checkboxes and the cipher selector.
 */
import { PDFDict, PDFName, openPDF, savePDF } from '../core/doc';
import { looksEncrypted } from '../core/doc';
import type { PDFPermissions } from '../core/doc';
import { resolvePages, formatPages } from '../core/pages';
import { formatBytes } from '../core/metadata';
import { listAttachments, removeAttachments } from '../core/attachments';
import { openRender } from '../core/render';
import {
  booleanValue,
  fileValues,
  numberValue,
  objectValue,
  stringValue,
  stringValues,
  type PdfToolDefinition,
} from './types';
import {
  baseName,
  openInputs,
  pdfResult,
  filesResult,
  rebuildDocument,
  reportResult,
} from './helpers';

/**
 * The `/P` flag bit positions, kept for the report text and for engines that
 * need the raw value (Table 25, ISO 32000-1).
 */
export const PERMISSION_BITS = {
  printLow: 3,
  modify: 4,
  copy: 5,
  annots: 6,
  forms: 9,
  accessibility: 10,
  assemble: 11,
  printHigh: 12,
} as const;

function permissionsObject(input: {
  printing: boolean;
  printLevel: string;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: boolean;
  assembling: boolean;
}): PDFPermissions {
  return {
    printing: input.printing,
    printingHighQuality: input.printing && input.printLevel === 'high',
    modifying: input.modifying,
    copying: input.copying,
    annotating: input.annotating,
    fillingForms: input.fillingForms,
    contentAccessibility: input.contentAccessibility,
    documentAssembly: input.assembling,
  };
}

const CIPHER_OPTIONS = [
  { value: '5', label: 'AES-256', hint: 'PDF 2.0. Strongest; needs a modern reader.' },
  { value: '4', label: 'AES-128', hint: 'PDF 1.6. The widest compatible choice.' },
  { value: '2', label: 'RC4-128', hint: 'PDF 1.4. Legacy compatibility only.' },
  { value: '1', label: 'RC4-40', hint: 'PDF 1.1. Export-restricted-era compatibility.' },
];

export const securityTools: PdfToolDefinition[] = [
  {
    id: 'protect',
    name: 'Protect PDF',
    description: 'Password-protect with real AES-256 and enforce permissions',
    icon: '🔐',
    category: 'security',
    keywords: ['encrypt', 'password', 'restrict', 'lock'],
    outputSuffix: '_protected.pdf',
    fields: [
      {
        key: 'mode',
        label: 'Protection type',
        type: 'segmented',
        default: 'both',
        options: [
          { value: 'user', label: 'Open password' },
          { value: 'owner', label: 'Permissions only' },
          { value: 'both', label: 'Both' },
        ],
        help: 'An open password blocks reading. A permissions-only password lets anyone open the file but restricts printing, copying and editing in readers that honour it.',
      },
      { key: 'userPassword', label: 'Document open password', type: 'password', when: (v) => v.mode !== 'owner' },
      {
        key: 'ownerPassword',
        label: 'Owner / permissions password',
        type: 'password',
        help: 'Leave empty to reuse the open password. A random one is generated if both are blank.',
      },
      { key: 'version', label: 'Cipher', type: 'select', default: '5', options: CIPHER_OPTIONS },
      { key: 'allowPrinting', label: 'Allow printing', type: 'toggle', default: true },
      {
        key: 'printLevel',
        label: 'Print quality',
        type: 'select',
        default: 'high',
        options: [
          { value: 'high', label: 'Any resolution' },
          { value: 'low', label: 'Low resolution only (150 dpi)' },
        ],
        when: (v) => v.allowPrinting === true,
      },
      { key: 'allowModifying', label: 'Allow modifying', type: 'toggle', default: true },
      { key: 'allowCopying', label: 'Allow copying text and images', type: 'toggle', default: true },
      { key: 'allowAnnotating', label: 'Allow comments and form filling', type: 'toggle', default: true },
      { key: 'allowFillingForms', label: 'Allow filling existing forms', type: 'toggle', default: true },
      { key: 'allowAccessibility', label: 'Allow screen readers', type: 'toggle', default: true },
      { key: 'allowAssembling', label: 'Allow rotating and inserting pages', type: 'toggle', default: false },
    ],
    validate(values) {
      const mode = stringValue(values, 'mode', 'both');
      const user = stringValue(values, 'userPassword');
      const owner = stringValue(values, 'ownerPassword');
      if (mode !== 'owner' && user.length === 0) return 'Enter the password readers must type to open this PDF.';
      if (mode === 'owner' && owner.length === 0) return 'Enter an owner password — it is what unlocks the restrictions.';
      if (mode === 'both' && owner.length > 0 && user === owner) {
        return 'Use a different owner password, or choose "Open password" only. Sharing one password means anyone who can open the file can also remove the restrictions.';
      }
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const mode = stringValue(context.values, 'mode', 'both');
      const user = mode === 'owner' ? '' : stringValue(context.values, 'userPassword');
      const owner = mode === 'user' ? '' : stringValue(context.values, 'ownerPassword') || user;
      const version = Number(stringValue(context.values, 'version', '5')) as 1 | 2 | 4 | 5;
      const flags = permissionsObject({
        printing: booleanValue(context.values, 'allowPrinting', true),
        printLevel: stringValue(context.values, 'printLevel', 'high'),
        modifying: booleanValue(context.values, 'allowModifying', true),
        copying: booleanValue(context.values, 'allowCopying', true),
        annotating: booleanValue(context.values, 'allowAnnotating', true),
        fillingForms: booleanValue(context.values, 'allowFillingForms', true),
        contentAccessibility: booleanValue(context.values, 'allowAccessibility', true),
        assembling: booleanValue(context.values, 'allowAssembling'),
      });

      // A permissions-only file needs an empty user password so it still opens.
      const bytes = await input.doc.save({
        encrypt: {
          userPassword: user,
          ownerPassword: owner || user,
          version,
          permissions: flags,
        },
      });
      const cipherName = CIPHER_OPTIONS.find((c) => c.value === String(version))?.label ?? `v${version}`;
      return {
        kind: 'pdf',
        bytes,
        message: `Protected with ${cipherName}${user ? ' and an open password' : ''}. Printing ${flags.printing ? 'allowed' : 'blocked'}, copying ${flags.copying ? 'allowed' : 'blocked'}.`,
      };
    },
  },

  {
    id: 'unlock',
    name: 'Unlock PDF',
    description: 'Remove the password so the file opens freely',
    icon: '🔓',
    category: 'security',
    keywords: ['decrypt', 'remove password', 'open'],
    outputSuffix: '_unlocked.pdf',
    fields: [{ key: 'password', label: 'Current password', type: 'password', help: 'Either the user or the owner password works.' }],
    async run(context) {
      const [input] = await openInputs(context);
      const password = stringValue(context.values, 'password') || context.password || '';
      const doc = await openPDF(input.bytes, { password });
      // Rebuild rather than re-save: saving a document that was loaded with a
      // password keeps the `/Encrypt` entry, so the "unlocked" file would still
      // ask for one.
      const cleared = await rebuildDocument(doc);
      const bytes = await savePDF(cleared, { useObjectStreams: true });
      const check = await openPDF(bytes);
      return {
        kind: 'pdf',
        bytes,
        message: `Removed protection — the file now opens without a password (${check.getPageCount()} pages verified).`,
      };
    },
  },

  {
    id: 'change-permissions',
    name: 'Change Permissions',
    description: 'Set or clear the printing, copying and editing restrictions',
    icon: '🎛️',
    category: 'security',
    keywords: ['restrict', 'owner password', 'flags'],
    outputSuffix: '_permissions.pdf',
    fields: [
      { key: 'ownerPassword', label: 'Owner password', type: 'password', help: 'Needed when the file is already protected.' },
      {
        key: 'action',
        label: 'Action',
        type: 'segmented',
        default: 'set',
        options: [
          { value: 'set', label: 'Apply these permissions' },
          { value: 'clear', label: 'Remove all restrictions' },
        ],
      },
      { key: 'version', label: 'Cipher', type: 'select', default: '5', options: CIPHER_OPTIONS, when: (v) => v.action === 'set' },
      { key: 'allowPrinting', label: 'Allow printing', type: 'toggle', default: true, when: (v) => v.action === 'set' },
      { key: 'allowModifying', label: 'Allow modifying', type: 'toggle', default: true, when: (v) => v.action === 'set' },
      { key: 'allowCopying', label: 'Allow copying', type: 'toggle', default: true, when: (v) => v.action === 'set' },
      { key: 'allowAnnotating', label: 'Allow comments', type: 'toggle', default: true, when: (v) => v.action === 'set' },
      { key: 'allowFillingForms', label: 'Allow form filling', type: 'toggle', default: true, when: (v) => v.action === 'set' },
      { key: 'allowAssembling', label: 'Allow page reorganisation', type: 'toggle', default: false, when: (v) => v.action === 'set' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const owner = stringValue(context.values, 'ownerPassword') || context.password || '';
      const doc = await openPDF(input.bytes, { password: owner });
      if (stringValue(context.values, 'action', 'set') === 'clear') {
        const cleared = await rebuildDocument(doc);
        const bytes = await savePDF(cleared);
        return { kind: 'pdf', bytes, message: 'All restrictions and the password were removed.' };
      }
      const flags = permissionsObject({
        printing: booleanValue(context.values, 'allowPrinting', true),
        printLevel: 'high',
        modifying: booleanValue(context.values, 'allowModifying', true),
        copying: booleanValue(context.values, 'allowCopying', true),
        annotating: booleanValue(context.values, 'allowAnnotating', true),
        fillingForms: booleanValue(context.values, 'allowFillingForms', true),
        contentAccessibility: true,
        assembling: booleanValue(context.values, 'allowAssembling'),
      });
      const bytes = await doc.save({
        encrypt: {
          ownerPassword: owner || 'browsersnip',
          userPassword: '',
          version: Number(stringValue(context.values, 'version', '5')) as 1 | 2 | 4 | 5,
          permissions: flags,
        },
      });
      return {
        kind: 'pdf',
        bytes,
        message: `Restrictions applied (printing ${flags.printing ? 'on' : 'off'}, copying ${flags.copying ? 'on' : 'off'}, editing ${flags.modifying ? 'on' : 'off'}). The document opens without a password.`,
      };
    },
  },

  {
    id: 'remove-restrictions',
    name: 'Remove Restrictions',
    description: 'Clear the permissions a signed or protected PDF was locked with',
    icon: '🔓',
    category: 'security',
    keywords: ['unlock features', 'owner password', 'signed'],
    outputSuffix: '_unrestricted.pdf',
    async run(context) {
      const [input] = await openInputs(context);
      const password = context.password ?? '';
      const doc = await openPDF(input.bytes, { password, ignoreEncryption: password === '' });
      const rebuilt0 = await rebuildDocument(doc);
      const bytes = await savePDF(rebuilt0);
      const rebuilt = await openPDF(bytes);
      return {
        kind: 'pdf',
        bytes,
        message: `Restrictions cleared. ${rebuilt.getPageCount()} pages verified readable${password ? '' : ' (no password was needed to re-save it)'}.`,
      };
    },
  },

  {
    id: 'flatten-pdf',
    name: 'Flatten PDF',
    description: 'Make form fields and annotations a permanent part of the page',
    icon: '🗜️',
    category: 'security',
    keywords: ['merge layers', 'non-editable', 'print ready'],
    outputSuffix: '_flattened.pdf',
    fields: [
      { key: 'forms', label: 'Flatten form fields', type: 'toggle', default: true },
      { key: 'annotations', label: 'Flatten annotations and comments', type: 'toggle', default: true },
      { key: 'keepLinks', label: 'Keep clickable links', type: 'toggle', default: true },
      { key: 'dpi', label: 'Annotation quality', type: 'slider', default: 200, min: 96, max: 400, step: 1, unit: 'dpi' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { flattenAnnotations } = await import('../core/flatten');
      const { flattenForm } = await import('../core/forms');
      const needsRender = booleanValue(context.values, 'annotations', true);
      const session = needsRender ? await openRender(input.bytes, { password: context.password }) : null;
      try {
        if (booleanValue(context.values, 'forms', true)) {
          await flattenForm(input.doc, session ?? undefined);
        }
        const flattened = await flattenAnnotations(
          input.doc,
          session ?? undefined,
          {
            kinds: needsRender ? undefined : ['Link'],
            keepLinks: booleanValue(context.values, 'keepLinks', true),
            onProgress: context.progress,
          },
        );
        const bytes = await savePDF(input.doc);
        return {
          kind: 'pdf',
          bytes,
          message: session
            ? `Flattened ${flattened} annotation(s) and form field(s) into the page content.`
            : `Flattened ${flattened} form field(s). Turn on annotation flattening to bake comments as well.`,
        };
      } finally {
        await session?.destroy();
      }
    },
  },

  {
    id: 'redact-pdf',
    name: 'Redact PDF',
    description: 'Permanently delete text and regions — not a black box over them',
    icon: '⬛',
    category: 'security',
    keywords: ['blackout', 'remove sensitive', 'censor', 'gdpr'],
    outputSuffix: '_redacted.pdf',
    surface: 'custom',
    fields: [
      { key: 'fill', label: 'Redaction colour', type: 'color', default: '#000000' },
      { key: 'alsoMetadata', label: 'Also clear matching text from metadata and bookmarks', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const rects = objectValue<RedactionRegion[]>(context.values, 'regions') ?? [];
      if (rects.length === 0) throw new Error('Draw at least one redaction rectangle on the page first.');
      const { applyRedactions } = await import('../core/redact');
      const fill = stringValue(context.values, 'fill', '#000000');
      const outcome = applyRedactions(
        input.doc,
        rects.map((r) => ({ page: r.page, rect: { x: r.x, y: r.y, width: r.width, height: r.height } })),
        { fill },
      );
      const bytes = await savePDF(input.doc);
      return {
        kind: 'pdf',
        bytes,
        message: outcome.rasterised
          ? `Redacted ${outcome.removed} region(s). Some fell inside images, so those were blacked out rather than cut out.`
          : `Redacted ${outcome.removed} region(s) by deleting the text itself — selecting the area now returns nothing.`,
      };
    },
  },

  {
    id: 'compare-pdfs',
    name: 'Compare PDFs',
    description: 'Diff two documents page by page and export the differences',
    icon: '🔍',
    category: 'security',
    keywords: ['diff', 'changes', 'versions', 'audit'],
    multiFile: true,
    minFiles: 2,
    maxFiles: 2,
    surface: 'custom',
    outputSuffix: '_comparison.pdf',
    fields: [
      {
        key: 'mode',
        label: 'Compare',
        type: 'segmented',
        default: 'visual',
        options: [
          { value: 'visual', label: 'Pixels' },
          { value: 'text', label: 'Text content' },
          { value: 'both', label: 'Both' },
        ],
      },
      { key: 'sensitivity', label: 'Pixel sensitivity', type: 'slider', default: 24, min: 1, max: 120, step: 1, when: (v) => v.mode !== 'text' },
      { key: 'dpi', label: 'Render resolution', type: 'slider', default: 150, min: 72, max: 300, step: 1, unit: 'dpi' },
    ],
    validate: (_v, { fileCount }) =>
      fileCount === 2 ? null : 'Add exactly two PDFs to compare.',
    async run(context) {
      const [a, b] = await openInputs(context);
      const mode = stringValue(context.values, 'mode', 'visual');
      const dpi = numberValue(context.values, 'dpi', 150);
      const sensitivity = numberValue(context.values, 'sensitivity', 24) / 255;
      const pages = Math.max(a.pageCount, b.pageCount);
      const rows: { label: string; value: string }[] = [];
      const images: { label: string; blob: Blob }[] = [];
      const sa = await openRender(a.bytes, { password: context.password });
      const sb = await openRender(b.bytes, { password: context.password });
      try {
        for (let page = 1; page <= pages; page++) {
          if (page > a.pageCount) {
            rows.push({ label: `Page ${page}`, value: 'only in the second file' });
            continue;
          }
          if (page > b.pageCount) {
            rows.push({ label: `Page ${page}`, value: 'only in the first file' });
            continue;
          }
          if (mode !== 'visual' && mode !== 'both') {
            const ta = (await sa.textItems(page)).map((i) => i.str).join(' ');
            const tb = (await sb.textItems(page)).map((i) => i.str).join(' ');
            rows.push({
              label: `Page ${page}`,
              value: ta === tb ? 'identical text' : `text differs (${diffWords(ta, tb)})`,
            });
            continue;
          }
          const scale = dpi / 72;
          const [ra, rb] = await Promise.all([sa.renderPage(page, scale), sb.renderPage(page, scale)]);
          const { percent, overlay } = visualDiff(ra.canvas, rb.canvas, sensitivity);
          ra.cancel();
          rb.cancel();
          rows.push({
            label: `Page ${page}`,
            value: percent < 0.05 ? 'no visible difference' : `${percent.toFixed(2)}% of pixels differ`,
          });
          if (percent >= 0.05) {
            images.push({ label: `Page ${page}`, blob: await overlay });
          }
          if (mode === 'both') {
            const ta = (await sa.textItems(page)).map((i) => i.str).join(' ');
            const tb = (await sb.textItems(page)).map((i) => i.str).join(' ');
            if (ta !== tb) rows.push({ label: `Page ${page} text`, value: diffWords(ta, tb) });
          }
          context.progress(page / pages, `Compared page ${page} of ${pages}`);
        }
      } finally {
        await sa.destroy();
        await sb.destroy();
      }
      const changed = rows.filter((r) => /differ|only in/.test(r.value)).length;
      const message = changed === 0
            ? `No differences found across ${pages} page(s).`
            : `${changed} of ${pages} page(s) differ.`;
      return reportResult([{ title: 'Page-by-page comparison', rows }], { message });
    },
  },

  {
    id: 'view-metadata',
    name: 'View Metadata',
    description: 'Inspect the properties, fonts, images and structure of a PDF',
    icon: '🔎',
    category: 'security',
    keywords: ['properties', 'info', 'xmp', 'audit'],
    surface: 'none',
    outputSuffix: '_metadata.txt',
    async run(context) {
      const [input] = await openInputs(context);
      const { metadataReport } = await import('../core/metadata');
      const sections = metadataReport(input.doc, input.bytes);
      const attachments = listAttachments(input.doc);
      if (attachments.length > 0) {
        sections.push({
          title: 'Embedded files',
          rows: attachments.map((a) => ({ label: a.name, value: `${formatBytes(a.size)} · ${a.mimeType ?? 'unknown type'}` })),
        });
      }
      return reportResult(sections, { message: `Read ${sections.length} section(s) of document metadata.` });
    },
  },

  {
    id: 'edit-metadata',
    name: 'Edit Metadata',
    description: 'Change title, author, subject, keywords and dates',
    icon: '🏷️',
    category: 'security',
    keywords: ['properties', 'document title', 'author', 'xmp'],
    outputSuffix: '_metadata.pdf',
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'author', label: 'Author', type: 'text' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'keywords', label: 'Keywords', type: 'text', placeholder: 'comma, separated' },
      { key: 'creator', label: 'Creator application', type: 'text' },
      { key: 'producer', label: 'Producer', type: 'text' },
      { key: 'language', label: 'Document language', type: 'text', placeholder: 'en, de-DE, ja' },
      { key: 'syncXmp', label: 'Write the same values into the XMP packet', type: 'toggle', default: true },
      { key: 'touchDates', label: 'Set the modification date to now', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { writeInfo, readInfo, writeXmp } = await import('../core/metadata');
      const current = readInfo(input.doc);
      const keywords = stringValue(context.values, 'keywords');
      writeInfo(
        input.doc,
        {
          title: stringValue(context.values, 'title') || current.title,
          author: stringValue(context.values, 'author') || current.author,
          subject: stringValue(context.values, 'subject') || current.subject,
          keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean).join(', ') : current.keywords,
          creator: stringValue(context.values, 'creator') || current.creator,
          producer: stringValue(context.values, 'producer') || current.producer,
          lang: stringValue(context.values, 'language') || current.lang,
        },
        { freshDates: booleanValue(context.values, 'touchDates', true) },
      );
      if (booleanValue(context.values, 'syncXmp', true)) {
        const info = readInfo(input.doc);
        writeXmp(
          input.doc,
          `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
          `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
          `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
          `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(info.title ?? '')}</rdf:li></rdf:Alt></dc:title>` +
          `<dc:creator><rdf:Seq><rdf:li>${escapeXml(info.author ?? '')}</rdf:li></rdf:Seq></dc:creator>` +
          `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(info.subject ?? '')}</rdf:li></rdf:Alt></dc:description>` +
          `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
        );
      }
      return pdfResult(input.doc, { message: 'Updated the document properties.' });
    },
  },

  {
    id: 'remove-metadata',
    name: 'Remove Metadata',
    description: 'Strip hidden properties, XMP and optional embedded data',
    icon: '🕵️',
    category: 'security',
    keywords: ['privacy', 'clear properties', 'anonymise'],
    outputSuffix: '_stripped.pdf',
    fields: [
      { key: 'info', label: 'Document info dictionary', type: 'toggle', default: true },
      { key: 'xmp', label: 'XMP metadata stream', type: 'toggle', default: true },
      { key: 'attachments', label: 'Embedded files', type: 'toggle', default: false },
      { key: 'readerSettings', label: 'Last-opened page and zoom memory', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { stripInfo, stripXmp } = await import('../core/metadata');
      const done: string[] = [];
      if (booleanValue(context.values, 'info', true)) {
        // Measured once: calling `stripInfo` a second time just to pick the
        // plural would report 0 properties because the first call already
        // removed them.
        const cleared = stripInfo(input.doc);
        done.push(`${cleared} propert${cleared === 1 ? 'y' : 'ies'}`);
      }
      if (booleanValue(context.values, 'xmp', true) && stripXmp(input.doc)) done.push('XMP packet');
      if (booleanValue(context.values, 'attachments')) {
        const names = listAttachments(input.doc).map((a) => a.name);
        if (names.length) {
          removeAttachments(input.doc, names);
          done.push(`${names.length} embedded file(s)`);
        }
      }
      if (booleanValue(context.values, 'readerSettings', true)) {
        input.doc.catalog.delete(PDFName.of('PageMode'));
        const viewerPrefs = input.doc.catalog.get(PDFName.of('ViewerPreferences'));
        if (viewerPrefs instanceof PDFDict) {
          viewerPrefs.delete(PDFName.of('DisplayDocTitle'));
        }
        const pageMode = input.doc.catalog.get(PDFName.of('Perms'));
        if (pageMode) input.doc.catalog.delete(PDFName.of('Perms'));
        done.push('reader settings');
      }
      const bytes = await savePDF(input.doc);
      return {
        kind: 'pdf',
        bytes,
        message: done.length ? `Removed ${done.join(', ')}.` : 'There was no selected metadata to remove.',
      };
    },
  },

  {
    id: 'add-attachments',
    name: 'Add Attachments',
    description: 'Embed any file inside a PDF, like an email attachment',
    icon: '📎',
    category: 'security',
    keywords: ['attach file', 'embed', 'package'],
    outputSuffix: '_attached.pdf',
    fields: [
      { key: 'files', label: 'Files to attach', type: 'file', accept: '*/*', multiple: true, maxFiles: 20 },
      { key: 'description', label: 'Note stored with each file', type: 'text' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { addAttachments } = await import('../core/attachments');
      const extras = fileValues(context.values, 'files');
      if (extras.length === 0) throw new Error('Choose at least one file to attach.');
      const description = stringValue(context.values, 'description');
      const count = await addAttachments(input.doc, extras.map((f) => ({
        name: f.name,
        bytes: f.bytes,
        mimeType: f.mimeType,
        description: description || undefined,
      })));
      return pdfResult(input.doc, {
        message: `Embedded ${count} file(s). Readers with an attachments panel will list them.`,
      });
    },
  },

  {
    id: 'extract-attachments',
    name: 'Extract Attachments',
    description: 'Pull every embedded file out of a PDF',
    icon: '📤',
    category: 'security',
    keywords: ['unpack', 'embedded files', 'unbundle'],
    surface: 'none',
    outputSuffix: '_attachments.zip',
    async run(context) {
      const [input] = await openInputs(context);
      const found = listAttachments(input.doc);
      if (found.length === 0) {
        return reportResult([{ title: 'Attachments', rows: [{ label: 'Result', value: 'This PDF contains no embedded files.' }] }], {
          message: 'No attachments found.',
        });
      }
      const { createZip } = await import('../core/archive');
      const single = found.length === 1
        ? new Blob([found[0].bytes as BlobPart], { type: found[0].mimeType ?? 'application/octet-stream' })
        : await createZip(
          found.map((a) => ({ name: a.filename ?? a.name, data: a.bytes })),
          { comment: `Extracted from ${input.name}` },
        );
      return filesResult(
        [{ blob: single, name: found.length === 1 ? (found[0].filename ?? found[0].name) : `${baseName(input.name)}-attachments.zip` }],
        `Found ${found.length} embedded file(s): ${found.map((a) => `${a.name} (${formatBytes(a.size)})`).join(', ')}.`,
      );
    },
  },

  {
    id: 'edit-attachments',
    name: 'Edit Attachments',
    description: 'List and delete the files embedded in a PDF',
    icon: '✂️',
    category: 'security',
    keywords: ['remove attachment', 'manage embedded'],
    outputSuffix: '_attachments.pdf',
    fields: [
      { key: 'remove', label: 'Names to remove', type: 'textarea', placeholder: 'One attachment name per line' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { removeAttachments } = await import('../core/attachments');
      const existing = listAttachments(input.doc);
      const wanted = stringValue(context.values, 'remove')
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (existing.length === 0) {
        throw new Error('This PDF has no attachments to edit.');
      }
      if (wanted.length === 0) {
        return reportResult(
          [{ title: 'Attachments', rows: existing.map((a) => ({ label: a.name, value: formatBytes(a.size) })) }],
          { message: `This PDF carries ${existing.length} attachment(s). List the names you want removed.` },
        );
      }
      const removed = removeAttachments(input.doc, wanted);
      return pdfResult(input.doc, {
        message: `Removed ${removed} of ${wanted.length} requested attachment(s). Remaining: ${existing.length - removed}.`,
      });
    },
  },

  {
    id: 'digital-sign-pdf',
    name: 'Digital Signature',
    description: 'Sign with an X.509 certificate so tampering is detectable',
    icon: '🖋️',
    category: 'security',
    keywords: ['pkcs7', 'certificate', 'signature', 'pades'],
    outputSuffix: '_signed.pdf',
    fields: [
      { key: 'certificate', label: 'Certificate (PEM or P12)', type: 'file', accept: '.pem,.crt,.cer,.p12,.pfx' },
      { key: 'privateKey', label: 'Private key (PEM)', type: 'file', accept: '.pem,.key', when: (v) => v.certKind !== 'p12' },
      { key: 'passphrase', label: 'Key / PKCS#12 passphrase', type: 'password' },
      { key: 'reason', label: 'Reason', type: 'text', default: 'I approve this document', half: true },
      { key: 'location', label: 'Location', type: 'text', half: true },
      { key: 'contact', label: 'Contact', type: 'text' },
      { key: 'visible', label: 'Show a visible signature block', type: 'toggle', default: true },
      { key: 'page', label: 'Signature page', type: 'number', default: 1, min: 1, when: (v) => v.visible === true },
    ],
    notes: [
      'The signature is created in your browser from your own certificate. Certificate revocation checking needs a network connection; everything else is local.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { signDocument } = await import('../core/signature');
      const cert = fileValues(context.values, 'certificate')[0];
      const key = fileValues(context.values, 'privateKey')[0];
      if (!cert) throw new Error('Choose the certificate you want to sign with.');
      const result = await signDocument(input.doc, {
        certificate: cert.bytes,
        privateKey: key?.bytes,
        passphrase: stringValue(context.values, 'passphrase'),
        reason: stringValue(context.values, 'reason'),
        location: stringValue(context.values, 'location'),
        contact: stringValue(context.values, 'contact'),
        visible: booleanValue(context.values, 'visible', true),
        page: numberValue(context.values, 'page', 1) - 1,
      });
      return {
        kind: 'pdf',
        bytes: result.bytes,
        message: `Signed as ${result.signer}${result.hash ? ` using ${result.hash}` : ''}. The signature covers ${formatBytes(result.contentsLength)} of the file.`,
      };
    },
  },

  {
    id: 'validate-signature-pdf',
    name: 'Validate Signature',
    description: 'Check whether digital signatures are intact and who signed',
    icon: '✅',
    category: 'security',
    keywords: ['verify', 'integrity', 'certificate details'],
    surface: 'none',
    outputSuffix: '_signature-report.txt',
    async run(context) {
      const [input] = await openInputs(context);
      const { readSignatures } = await import('../core/signature');
      const signatures = await readSignatures(input.bytes);
      if (signatures.length === 0) {
        return reportResult(
          [{ title: 'Digital signatures', rows: [{ label: 'Result', value: 'This document has no digital signature field.' }] }],
          { message: 'No digital signature found.' },
        );
      }
      return reportResult(
        signatures.map((signature, index) => ({
          title: `Signature ${index + 1}${signature.fieldName ? ` — ${signature.fieldName}` : ''}`,
          rows: [
            { label: 'Byte range intact', value: signature.digestMatches ? 'Yes — the document has not changed since signing' : 'No — the file was modified after signing' },
            { label: 'Signer', value: signature.signer ?? 'unknown' },
            { label: 'Issued by', value: signature.issuer ?? 'unknown' },
            { label: 'Signed at', value: signature.signedAt?.toISOString() ?? 'not recorded' },
            { label: 'Digest', value: signature.digestAlgorithm ?? 'unknown' },
            { label: 'Certificate valid from', value: signature.notBefore?.toISOString() ?? 'unknown' },
            { label: 'Certificate valid until', value: signature.notAfter?.toISOString() ?? 'unknown' },
            { label: 'Revocation', value: 'not checked offline — a browser has no OCSP responder access for this chain' },
          ],
        })),
        {
          message: signatures.every((s) => s.digestMatches)
            ? `All ${signatures.length} signature(s) verify against the current bytes.`
            : `${signatures.filter((s) => !s.digestMatches).length} of ${signatures.length} signature(s) are broken — the document changed after signing.`,
        },
      );
    },
  },

  {
    id: 'timestamp-pdf',
    name: 'Timestamp PDF',
    description: 'Add an RFC 3161 trusted timestamp to a signature',
    icon: '🕐',
    category: 'security',
    keywords: ['tsa', 'rfc3161', 'proof of existence'],
    outputSuffix: '_timestamped.pdf',
    fields: [
      {
        key: 'tsa',
        label: 'Timestamp authority URL',
        type: 'text',
        default: 'http://timestamp.digicert.com',
        help: 'The only step that needs the network: the timestamp token comes from a trusted third party.',
      },
      { key: 'fieldName', label: 'Signature field to stamp', type: 'text' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { timestampDocument } = await import('../core/signature');
      const result = await timestampDocument(input.doc, {
        tsaUrl: stringValue(context.values, 'tsa', 'http://timestamp.digicert.com'),
        fieldName: stringValue(context.values, 'fieldName') || undefined,
      });
      return {
        kind: 'pdf',
        bytes: result.bytes,
        message: `Timestamped at ${result.attestedAt.toISOString()} by ${result.authority}.`,
      };
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

/** Region captured by the redaction surface, in PDF user space. */
interface RedactionRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

type AnnotationKindList = import('../core/annotations').AnnotationKind[];

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function diffWords(a: string, b: string): string {
  const left = new Set(a.split(/\s+/).filter(Boolean));
  const right = new Set(b.split(/\s+/).filter(Boolean));
  const removed = [...left].filter((w) => !right.has(w)).length;
  const added = [...right].filter((w) => !left.has(w)).length;
  return `${removed} word(s) removed, ${added} added`;
}

/** Overlay two page renders and return the diff percentage plus an image. */
function visualDiff(
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  threshold: number,
): { percent: number; overlay: Promise<Blob> } {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('This browser could not create the comparison canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(a, 0, 0);
  const dataA = ctx.getImageData(0, 0, width, height).data;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(b, 0, 0);
  const dataB = ctx.getImageData(0, 0, width, height).data;

  const overlay = document.createElement('canvas');
  overlay.width = width;
  overlay.height = height;
  const overlayCtx = overlay.getContext('2d');
  if (!overlayCtx) throw new Error('This browser could not create the comparison canvas.');
  const image = overlayCtx.createImageData(width, height);
  let different = 0;
  for (let i = 0; i < dataA.length; i += 4) {
    const delta =
      Math.abs(dataA[i] - dataB[i]) +
      Math.abs(dataA[i + 1] - dataB[i + 1]) +
      Math.abs(dataA[i + 2] - dataB[i + 2]);
    const changed = delta / 3 > threshold * 255;
    if (changed) {
      different += 1;
      image.data[i] = 225;
      image.data[i + 1] = 29;
      image.data[i + 2] = 72;
      image.data[i + 3] = 200;
    } else {
      const grey = Math.round(0.299 * dataA[i] + 0.587 * dataA[i + 1] + 0.114 * dataA[i + 2]);
      const faded = Math.min(255, grey + 60);
      image.data[i] = faded;
      image.data[i + 1] = faded;
      image.data[i + 2] = faded;
      image.data[i + 3] = 255;
    }
  }
  overlayCtx.putImageData(image, 0, 0);
  const pixels = width * height;
  return {
    percent: pixels === 0 ? 0 : (different / pixels) * 100,
    overlay: new Promise<Blob>((resolve, reject) =>
      overlay.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not export the comparison page.'))), 'image/png'),
    ),
  };
}

export { permissionsObject, looksEncrypted, formatPages };
