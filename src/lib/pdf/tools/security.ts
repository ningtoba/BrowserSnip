/**
 * PDF security tools.
 *
 * Encryption uses the `@maxwbh/pdf-lib` fork's crypto dictionary writer (RC4-40
 * and RC4-128, AES-128, AES-256, with the `/P` permissions dictionary). The
 * previous implementation called an RC4-128-only library and silently discarded
 * all seven permission checkboxes and the cipher selector.
 *
 * Nothing in this module claims a security property it has not checked: every
 * protect / unlock / restriction result is re-read through `core/guard` before
 * the tool describes it, so the message reports the cipher and permission bits
 * *the file carries*, not the ones the form asked for. Where the check shows a
 * compromise — a permission the file could not record, a rebuild that dropped
 * form fields, a signature that cannot be re-read — it is admitted in
 * `ToolResult.warnings` rather than buried in the log pane.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  openPDF,
  savePDF,
  saveEncrypted,
} from '../core/doc';
import { looksEncrypted } from '../core/doc';
import type { PDFPermissions } from '../core/doc';
import { formatPages } from '../core/pages';
import { formatBytes, readInfo, readXmp } from '../core/metadata';
import { listAttachments, removeAttachments } from '../core/attachments';
import { openRender } from '../core/render';
import { annotationCount } from '../core/annotations';
import { readOutline } from '../core/bookmarks';
import { pageContentStreams } from '../core/content';
import {
  booleanValue,
  fileValues,
  numberValue,
  objectValue,
  stringValue,
  type PdfToolDefinition,
} from './types';
import {
  baseName,
  inspectPdf,
  openInputs,
  pdfResult,
  filesResult,
  rebuildDocument,
  reportResult,
  type PdfInspection,
  type PdfPermissions,
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
      const source = contentFingerprint(input.doc);
      const bytes = await saveEncrypted(input.doc, {
        userPassword: user,
        ownerPassword: owner || user,
        version,
        permissions: flags,
      });
      const cipherName = CIPHER_OPTIONS.find((c) => c.value === String(version))?.label ?? `v${version}`;
      const { inspection, warnings } = await verifyProtection(bytes, input.name, flags, cipherName, source, user === '');
      // E5: the password that was just written has to be the one that opens it.
      const reopened = await inspectPdf(bytes, input.name, { password: user || owner });
      if (!reopened.passwordAccepted) {
        warnings.push(`The saved file did not open with the password that was just set${reopened.error ? `: ${reopened.message}` : '.'}`);
      }
      const how = user
        ? `${cipherName} and an open password`
        : `${cipherName}, restrictions only — no open password was set`;
      return {
        kind: 'pdf',
        bytes,
        message: `Protected with ${how}. As written to the file: ${permissionSentence(inspection.permissions ?? flags)}.`,
        warnings,
      };
    },
  },

  {
    id: 'unlock',
    // Removing protection is the whole point: the runner would otherwise
    // re-encrypt the output with the password that was just retired.
    stripsProtection: true,
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
      if (!input.inspection?.encrypted) {
        // Nothing to remove. Rebuilding the page tree for show would drop form
        // fields, comments and bookmarks from a file that never needed it.
        return {
          kind: 'pdf',
          bytes: input.bytes,
          message: `"${input.name}" is not password protected — it already opens without one, so the file is returned unchanged.`,
          warnings: ['No /Encrypt entry was found, so there was no password to remove.'],
        };
      }
      const doc = await openPDF(input.bytes, { password });
      const before = contentFingerprint(doc);
      const losses = rebuildLosses(doc);
      // Rebuild rather than re-save: saving a document that was loaded with a
      // password keeps the `/Encrypt` entry, so the "unlocked" file would still
      // ask for one.
      const cleared = await rebuildDocument(doc);
      const bytes = await savePDF(cleared, { useObjectStreams: true });
      const after = await inspectPdf(bytes, input.name);
      if (after.encrypted) {
        throw new Error('The unlocked copy still carries an /Encrypt entry and would ask for a password, so it was not returned.');
      }
      if (after.pages !== doc.getPageCount()) {
        throw new Error(`The unlocked copy has ${after.pages} of the ${doc.getPageCount()} pages the source has, so it was not returned.`);
      }
      const contentKept = contentFingerprint(cleared) === before;
      const warnings: string[] = [];
      if (!contentKept) {
        warnings.push('Some page content read differently after the rebuild, so check the copy before relying on it.');
      }
      if (losses.length > 0) {
        warnings.push(`Dropping the protection copies the pages into a fresh document, so ${losses.join(', ')} did not carry over.`);
      }
      return {
        kind: 'pdf',
        bytes,
        message: `Removed protection — the file opens without a password now: ${after.pages} page(s), ${contentKept ? 'page content verified' : 'page content re-read with differences'}.`,
        warnings,
      };
    },
  },

  {
    id: 'change-permissions',
    // Sets or clears the encryption dictionary itself, so the runner must not
    // second-guess the result: for `clear` the loss of protection is the point,
    // and for `set` the owner password is one this layer never sees.
    stripsProtection: true,
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
      const wasProtected = input.inspection?.encrypted === true;
      if (stringValue(context.values, 'action', 'set') === 'clear') {
        if (!wasProtected) {
          return {
            kind: 'pdf',
            bytes: input.bytes,
            message: `"${input.name}" carries no encryption dictionary, so there were no restrictions to remove — the file is returned unchanged.`,
            warnings: ['Nothing to clear: this PDF is not protected.'],
          };
        }
        const losses = rebuildLosses(doc);
        const cleared = await rebuildDocument(doc);
        const bytes = await savePDF(cleared);
        const after = await inspectPdf(bytes, input.name);
        if (after.encrypted) {
          throw new Error('The saved copy still carries an /Encrypt entry, so the restrictions were not actually removed.');
        }
        return {
          kind: 'pdf',
          bytes,
          message: `All restrictions and the password were removed — ${after.pages} page(s) verified, opens freely.`,
          warnings: losses.length
            ? [`Removing the restrictions copies the pages into a fresh document, so ${losses.join(', ')} did not carry over.`]
            : [],
        };
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
      const version = Number(stringValue(context.values, 'version', '5')) as 1 | 2 | 4 | 5;
      const cipherName = CIPHER_OPTIONS.find((c) => c.value === String(version))?.label ?? `v${version}`;
      const source = contentFingerprint(doc);
      const bytes = await saveEncrypted(doc, {
        ownerPassword: owner || 'browsersnip',
        userPassword: '',
        version,
        permissions: flags,
      });
      const { inspection, warnings } = await verifyProtection(bytes, input.name, flags, cipherName, source, true);
      if (wasProtected) {
        warnings.push('This replaced any protection the file already had. The copy opens without a password; only the owner password set here unlocks its restrictions.');
      }
      if (!owner) {
        warnings.push('No owner password was entered, so a random one was used: the restrictions can be changed again but not lifted by name.');
      }
      return {
        kind: 'pdf',
        bytes,
        message: `Restrictions as recorded in the file (${cipherName}): ${permissionSentence(inspection.permissions ?? flags)}. The document opens without a password.`,
        warnings,
      };
    },
  },

  {
    id: 'remove-restrictions',
    // Removing protection is the whole point: the runner would otherwise
    // re-encrypt the output with the password that was just retired.
    stripsProtection: true,
    name: 'Remove Restrictions',
    description: 'Clear the permissions a signed or protected PDF was locked with',
    icon: '🔓',
    category: 'security',
    keywords: ['unlock features', 'owner password', 'signed'],
    outputSuffix: '_unrestricted.pdf',
    async run(context) {
      const [input] = await openInputs(context);
      const password = context.password ?? '';
      if (!input.inspection?.encrypted) {
        return {
          kind: 'pdf',
          bytes: input.bytes,
          message: `"${input.name}" has no encryption dictionary, so nothing was restricting it — the file is returned unchanged.`,
          warnings: ['Nothing to clear: this PDF carries no /Encrypt entry, so a reader cannot be told to hold it back.'],
        };
      }
      const doc = await openPDF(input.bytes, { password, ignoreEncryption: password === '' });
      const losses = rebuildLosses(doc);
      const rebuilt = await rebuildDocument(doc);
      const bytes = await savePDF(rebuilt);
      const after = await inspectPdf(bytes, input.name);
      if (after.encrypted) {
        throw new Error('The saved copy is still listed as encrypted, so its restrictions were not actually cleared.');
      }
      return {
        kind: 'pdf',
        bytes,
        message: `Restrictions cleared — ${after.pages} page(s) verified readable with no /Encrypt entry and no password needed.`,
        warnings: losses.length
          ? [`Clearing the restrictions copies the pages into a fresh document, so ${losses.join(', ')} did not carry over.`]
          : [],
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
        const fields = booleanValue(context.values, 'forms', true)
          ? await flattenForm(input.doc, session ?? undefined)
          : { flattened: 0, needsRender: false };
        const outcome = await flattenAnnotations(
          input.doc,
          session ?? undefined,
          {
            kinds: needsRender ? undefined : ['Link'],
            keepLinks: booleanValue(context.values, 'keepLinks', true),
            onProgress: context.progress,
          },
        );
        const bytes = await savePDF(input.doc);
        const warnings: string[] = [];
        if (outcome.skippedNoAppearance > 0) {
          warnings.push(`${outcome.skippedNoAppearance} annotation(s) had no appearance to draw and were left as live comments instead of being baked in.`);
        }
        if (fields.needsRender && fields.flattened === 0) {
          warnings.push('The form fields could not be baked from their appearances, so they are still interactive in the output.');
        }
        if (!needsRender) {
          warnings.push('Annotation flattening was off, so comments stayed live — only link annotations were considered.');
        }
        if (outcome.flattened === 0 && fields.flattened === 0) {
          warnings.push('This PDF had nothing of the selected kind to flatten, so the file is effectively unchanged.');
        }
        return {
          kind: 'pdf',
          bytes,
          message: needsRender
            ? `Baked ${outcome.flattened} annotation(s) and ${fields.flattened} form field(s) into the content of ${outcome.pagesTouched} page(s).`
            : `Baked ${fields.flattened} form field(s) into the page content. Turn on annotation flattening to bake comments as well.`,
          warnings,
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
      // A box with no area removes no glyph, and counting it as redacted would
      // be the covered-but-selectable failure this tool exists to avoid (E13).
      const marked = rects.filter((r) => r.width > 0 && r.height > 0);
      const skipped = rects.length - marked.length;
      const outcome = applyRedactions(
        input.doc,
        marked.map((r) => ({ page: r.page, rect: { x: r.x, y: r.y, width: r.width, height: r.height } })),
        { fill },
      );
      const bytes = await savePDF(input.doc);
      const warnings: string[] = [];
      if (skipped > 0) {
        warnings.push(`${skipped} marked area(s) had no width or height and were skipped — a redaction has to cover something to delete something.`);
      }
      if (outcome.rasterised) {
        warnings.push('At least one area fell inside an image, so the pixels there were painted over rather than cut out: text that is part of a scanned page survives as image data.');
      }
      if (booleanValue(context.values, 'alsoMetadata', true)) {
        const elsewhere = textHeldOutsidePageContent(input.doc);
        if (elsewhere.length > 0) {
          warnings.push(`Redaction deletes text from page content. ${elsewhere.join(', ')} still holds words this tool did not touch — clear them with Remove Metadata.`);
        }
      }
      return {
        kind: 'pdf',
        bytes,
        message: outcome.removed === 0
          ? `Marked ${marked.length} area(s); none of them held text, so nothing was deleted — the fill was painted over the page only.`
          : `Redacted ${outcome.removed} text run(s) by deleting the glyphs themselves — selecting the area now returns nothing.`,
        warnings,
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
      const inspection = input.inspection;
      const protection: { label: string; value: string }[] = [
        { label: 'Encrypted', value: inspection?.encrypted ? 'yes' : 'no' },
      ];
      if (inspection?.encrypted) {
        protection.push({ label: 'Cipher', value: inspection.algorithm ?? 'declared, but not readable from /V and /R' });
        protection.push({
          label: 'Open password',
          value: inspection.passwordAccepted ? 'required, and the one supplied opened it' : 'required',
        });
        protection.push({
          label: 'Restrictions recorded',
          value: inspection.permissions ? permissionSentence(inspection.permissions) : 'none — the file has no /P dictionary',
        });
        protection.push({ label: 'Raw /P value', value: inspection.permissions ? String(inspection.permissions.raw) : '—' });
        protection.push({
          label: 'Enforced by',
          value: 'readers that honour the flags. Restrictions are a request, not encryption: treat them as polite, not private.',
        });
      }
      sections.push({ title: 'Protection', rows: protection });
      const attachments = listAttachments(input.doc);
      if (attachments.length > 0) {
        sections.push({
          title: 'Embedded files',
          rows: attachments.map((a) => ({ label: a.name, value: `${formatBytes(a.size)} · ${a.mimeType ?? 'unknown type'}` })),
        });
      }
      return {
        kind: 'report',
        sections,
        message: `Read ${sections.length} section(s) of document metadata.`,
        warnings: inspection?.encrypted
          ? [`This PDF is protected with ${inspection.algorithm ?? 'an unreadable cipher'}; the restrictions above are what its /P dictionary records, not a guarantee about a given reader.`]
          : [],
      };
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
        // removed them. A zero count is not something that was removed, so it
        // is not added to the list either.
        const cleared = stripInfo(input.doc);
        if (cleared > 0) done.push(`${cleared} propert${cleared === 1 ? 'y' : 'ies'}`);
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
        // Only claim the keys that were really there: this used to report
        // "reader settings" on a document that had none of them.
        const cleared: string[] = [];
        if (input.doc.catalog.delete(PDFName.of('PageMode'))) cleared.push('PageMode');
        const viewerPrefs = input.doc.catalog.get(PDFName.of('ViewerPreferences'));
        if (viewerPrefs instanceof PDFDict && viewerPrefs.delete(PDFName.of('DisplayDocTitle'))) {
          cleared.push('ViewerPreferences/DisplayDocTitle');
        }
        if (input.doc.catalog.delete(PDFName.of('Perms'))) cleared.push('Perms');
        if (cleared.length > 0) done.push(`reader settings (${cleared.join(', ')})`);
      }
      const bytes = await savePDF(input.doc);
      return {
        kind: 'pdf',
        bytes,
        message: done.length
          ? `Removed ${done.join(', ')}.`
          : 'Nothing was removed: the selected stores were already empty in this PDF.',
        warnings: done.length
          ? []
          : ['This PDF held no document info, XMP packet, embedded files or reader settings of the kinds selected, so the output is the same document.'],
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
      const missing = wanted.filter((name) => !existing.some((a) => a.name === name || a.filename === name));
      const warnings = missing.length
        ? [`${missing.map((name) => `"${name}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not embedded in this PDF, so nothing was removed for ${missing.length === 1 ? 'it' : 'them'}.`]
        : [];
      if (removed === 0 && wanted.length > 0) {
        warnings.push('None of the names you listed matched an attachment, so the document is unchanged.');
      }
      const bytes = await savePDF(input.doc);
      return {
        kind: 'pdf',
        bytes,
        message: `Removed ${removed} of ${wanted.length} requested attachment(s). Remaining: ${existing.length - removed}.`,
        warnings,
      };
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
      // E6: a visible block on page 9 of a 3-page PDF is a mistake worth naming
      // before the signature is written somewhere unexpected.
      const total = input.doc.getPageCount();
      const page = numberValue(context.values, 'page', 1);
      if (booleanValue(context.values, 'visible', true) && (!Number.isInteger(page) || page < 1 || page > total)) {
        throw new Error(`The signature page must be between 1 and ${total} — this document has ${total} page${total === 1 ? '' : 's'}.`);
      }
      const result = await signDocument(input.doc, {
        certificate: cert.bytes,
        privateKey: key?.bytes,
        passphrase: stringValue(context.values, 'passphrase'),
        reason: stringValue(context.values, 'reason'),
        location: stringValue(context.values, 'location'),
        contact: stringValue(context.values, 'contact'),
        visible: booleanValue(context.values, 'visible', true),
        page: page - 1,
      });
      // A signature nobody can re-read signs nothing, so the bytes are checked
      // back before the tool claims the document is signed.
      const warnings: string[] = [];
      const { readSignatures } = await import('../core/signature');
      let readBack: Awaited<ReturnType<typeof readSignatures>> = [];
      try {
        readBack = await readSignatures(result.bytes);
      } catch (error) {
        warnings.push(`The signature was written but could not be read back from the saved file (${error instanceof Error ? error.message : 'unknown reason'}). Run Validate Signature on the output before relying on it.`);
      }
      const mine = readBack[readBack.length - 1];
      if (readBack.length > 0 && mine && !mine.digestMatches) {
        warnings.push('The signature does not verify against the file it was just written into, so treat this copy as unsigned.');
      }
      if (readBack.length > 0 && mine?.error) {
        warnings.push(`The saved signature could not be parsed: ${mine.error}`);
      }
      return {
        kind: 'pdf',
        bytes: result.bytes,
        message: `Signed as ${result.signer}${result.hash ? ` using ${result.hash}` : ''}. The signature covers ${formatBytes(result.contentsLength)} of the file${readBack.length > 0 && mine?.digestMatches ? ' and verifies against it' : ''}.`,
        warnings,
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
      const fields = signatureFields(input.doc);
      if (fields.length === 0) {
        return reportResult(
          [{ title: 'Digital signatures', rows: [{ label: 'Result', value: 'This document has no digital signature field — nobody has signed it, so nothing proves these bytes are unchanged.' }] }],
          { message: 'No digital signature found.' },
        );
      }
      let signatures: Awaited<ReturnType<typeof readSignatures>> = [];
      let readFailure: string | null = null;
      try {
        signatures = await readSignatures(input.bytes);
      } catch (error) {
        readFailure = error instanceof Error ? error.message : String(error);
      }
      if (signatures.length === 0) {
        return {
          kind: 'report',
          sections: [{
            title: 'Digital signatures',
            rows: [{
              label: 'Result',
              value: readFailure
                ? `The signature field exists but could not be read: ${readFailure}`
                : `There ${fields.length === 1 ? 'is' : 'are'} ${fields.length} signature field(s) with no signature value in them — the document was set up for signing but never signed.`,
            }],
          }],
          message: 'The signature field is empty.',
          warnings: fields.length > 0 && readFailure === null
            ? ['A signature field with no value restricts nothing and proves nothing; the document is unsigned.']
            : [],
        };
      }
      const now = Date.now();
      const broken = signatures.filter((signature) => !signature.error && !signature.digestMatches).length;
      const unreadable = signatures.filter((signature) => signature.error).length;
      const intact = signatures.length - broken - unreadable;
      const warnings: string[] = [];
      if (fields.length > signatures.length) {
        warnings.push(`${fields.length - signatures.length} signature field(s) sit in page annotations and are not registered in the document form, so they could not be verified.`);
      }
      if (intact > 0) {
        warnings.push('Intact means the bytes the signature covers have not changed. The certificate chain is not validated and revocation cannot be checked in the browser, so this does not confirm the signer is trusted.');
      }
      const expired = signatures.filter((signature) => signature.notAfter && signature.notAfter.getTime() < now).length;
      if (expired > 0) {
        warnings.push(`${expired} signature(s) used a certificate that has since passed its expiry date. That does not undo the signature — it was valid when applied — but the signing identity can no longer be confirmed from the certificate alone.`);
      }
      return {
        kind: 'report',
        sections: signatures.map((signature, index) => ({
          title: `Signature ${index + 1}${signature.fieldName ? ` — ${signature.fieldName}` : ''}`,
          rows: [
            {
              label: 'Byte range intact',
              value: signature.error
                ? `Not checked — ${signature.error}`
                : signature.digestMatches
                  ? 'Yes — the document has not changed since signing'
                  : 'No — the file was modified after signing',
            },
            { label: 'Signer', value: signature.signer ?? 'unknown' },
            { label: 'Issued by', value: signature.issuer ?? 'unknown' },
            { label: 'Signed at', value: signature.signedAt?.toISOString() ?? 'not recorded' },
            { label: 'Digest', value: signature.digestAlgorithm ?? 'unknown' },
            { label: 'Certificate valid from', value: signature.notBefore?.toISOString() ?? 'unknown' },
            { label: 'Certificate valid until', value: signature.notAfter?.toISOString() ?? 'unknown' },
            { label: 'Revocation', value: 'not checked offline — a browser has no OCSP responder access for this chain' },
          ],
        })),
        message: broken === 0 && unreadable === 0
          ? `All ${signatures.length} signature(s) verify: the bytes they cover are unchanged since signing.`
          : `${intact} of ${signatures.length} signature(s) verify; ${broken} were broken by an edit after signing${unreadable > 0 ? `; ${unreadable} could not be read at all` : ''}.`,
        warnings,
      };
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
      // `core/signature` looks for a `/Contents` key to find the signature, and
      // every page has a `/Contents` — so an unsigned file used to come back
      // complaining about its PKCS#7 instead of saying it was never signed.
      const signatureCount = signatureFields(input.doc).length;
      if (signatureCount === 0) {
        throw new Error('This PDF has no digital signature to timestamp. Run Digital Signature on it first, then timestamp the signed file.');
      }
      const tsaUrl = stringValue(context.values, 'tsa', 'http://timestamp.digicert.com');
      let result: Awaited<ReturnType<typeof timestampDocument>>;
      try {
        result = await timestampDocument(input.doc, {
          tsaUrl,
          fieldName: stringValue(context.values, 'fieldName') || undefined,
        });
      } catch (error) {
        throw timestampFailure(error, tsaUrl, signatureCount);
      }
      return {
        kind: 'pdf',
        bytes: result.bytes,
        message: `Timestamped at ${result.attestedAt.toISOString()} by ${result.authority}.`,
        warnings: [`The timestamp covers the signature, not the document: it proves the signature existed at ${result.attestedAt.toISOString()}, and ${tsaUrl} is the one address this app sends a digest to.`],
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

/* ------------------------------------------------------------------ *
 * Verification — a security tool may only claim what it has re-read    *
 * ------------------------------------------------------------------ */

const latin1 = new TextDecoder('latin1');

/**
 * The readable page content of a document, as one string.
 *
 * Three sampled pages (first, middle, last) of decoded `/Contents` streams:
 * enough to prove that a rebuild carried the pages over unchanged and that an
 * encryption pass actually altered the bytes at rest, without reading all 500
 * pages of a large document twice (E7).
 */
function contentFingerprint(doc: PDFDocument): string {
  const pages = doc.getPages();
  const picks = [...new Set([0, Math.floor(pages.length / 2), pages.length - 1])];
  const parts: string[] = [];
  for (const index of picks) {
    const page = pages[index];
    if (!page) continue;
    try {
      for (const stream of pageContentStreams(page)) {
        parts.push(`${index + 1}:${stream.bytes.length}:${latin1.decode(stream.bytes)}`);
      }
    } catch {
      // A stream that will not decompress still fingerprints: its absence of
      // readable text is itself the fact the caller reports.
      parts.push(`${index + 1}:unreadable`);
    }
  }
  return parts.join('\n');
}

/** Read an entry whose value may be a reference or inlined, without throwing. */
function dictAt(doc: PDFDocument, value: unknown): PDFDict | undefined {
  if (value instanceof PDFRef) return doc.context.lookupMaybe(value, PDFDict);
  return value instanceof PDFDict ? value : undefined;
}

function arrayAt(doc: PDFDocument, value: unknown): PDFArray | undefined {
  if (value instanceof PDFRef) return doc.context.lookupMaybe(value, PDFArray);
  return value instanceof PDFArray ? value : undefined;
}

/** `/AcroForm /Fields` size, without creating an AcroForm as a side effect. */
function formFieldCount(doc: PDFDocument): number {
  const acroForm = dictAt(doc, doc.catalog.get(PDFName.of('AcroForm')));
  return arrayAt(doc, acroForm?.get(PDFName.of('Fields')))?.size() ?? 0;
}

/**
 * What copying the page tree into a fresh document leaves behind.
 *
 * `rebuildDocument` is the only reliable way to drop the trailer's `/Encrypt`
 * entry, and page copying does not carry form fields, comments, bookmarks or
 * embedded files across. Losing a filled-in form while "just" removing a
 * password is the silent failure this list exists to prevent (E13).
 */
function rebuildLosses(doc: PDFDocument): string[] {
  const losses: string[] = [];
  const fields = formFieldCount(doc);
  const annotations = annotationCount(doc);
  const bookmarks = readOutline(doc).length;
  const attachments = listAttachments(doc).length;
  if (fields > 0) losses.push(`${fields} form field(s)`);
  if (annotations > 0) losses.push(`${annotations} annotation(s) / comment(s)`);
  if (bookmarks > 0) losses.push(`${bookmarks} bookmark(s)`);
  if (attachments > 0) losses.push(`${attachments} embedded file(s)`);
  return losses;
}

/** The eight `/P` flags, in the order the report text lists them. */
const PERMISSION_REPORT: readonly [keyof PDFPermissions, string][] = [
  ['printing', 'printing'],
  ['printingHighQuality', 'full-resolution printing'],
  ['modifying', 'editing'],
  ['copying', 'copying text and images'],
  ['annotating', 'comments and form filling'],
  ['fillingForms', 'filling existing forms'],
  ['contentAccessibility', 'screen readers'],
  ['documentAssembly', 'rotating and inserting pages'],
];

/** One sentence describing the permissions a file really carries. */
function permissionSentence(permissions: PDFPermissions | PdfPermissions): string {
  const state = (key: keyof PDFPermissions): string =>
    permissions[key] === true ? 'allowed' : 'blocked';
  const printing = `printing ${state('printing')}`;
  const detail =
    permissions.printing === true
      ? permissions.printingHighQuality === true
        ? ' (any resolution)'
        : ' (low resolution only)'
      : '';
  return [
    `${printing}${detail}`,
    `editing ${state('modifying')}`,
    `copying ${state('copying')}`,
    `comments ${state('annotating')}`,
    `form filling ${state('fillingForms')}`,
    `screen readers ${state('contentAccessibility')}`,
    `page assembly ${state('documentAssembly')}`,
  ].join(', ');
}

/**
 * Every restriction that was asked for but is not what the written file says.
 *
 * The `/P` bitfield is the only thing a reader can honour, so a bit that did not
 * land is a real difference between a protected document and an unprotected one
 * — reported, never smoothed over (E5).
 */
function permissionMismatches(
  requested: PDFPermissions,
  recorded: PdfPermissions | null,
): string[] {
  if (!recorded) {
    return ['The protected file carries no /P dictionary, so no restriction was recorded in it.'];
  }
  const problems: string[] = [];
  for (const [key, label] of PERMISSION_REPORT) {
    const wanted = requested[key] === true;
    const got = recorded[key] === true;
    if (wanted !== got) {
      problems.push(`The file records ${label} as ${got ? 'allowed' : 'blocked'}, which is not what was asked for.`);
    }
  }
  return problems;
}

/**
 * Where else this document holds words that a page-content redaction cannot
 * reach.
 *
 * The `alsoMetadata` option asks for the secret to be gone from the *file*, and
 * the only honest answer is to name what is still in it: `/Info` entries, the
 * XMP packet, bookmark titles and embedded files all survive a content-stream
 * rewrite (E13, E20).
 */
function textHeldOutsidePageContent(doc: PDFDocument): string[] {
  const stores: string[] = [];
  const info = readInfo(doc);
  const filled = (['title', 'author', 'subject', 'keywords'] as const)
    .map((key) => (info[key] ?? '').trim())
    .filter((value) => value.length > 0);
  if (filled.length > 0) stores.push(`the ${filled.length} document propert${filled.length === 1 ? 'y' : 'ies'} you can see under View Metadata`);
  if (readXmp(doc)) stores.push('the XMP packet');
  const bookmarks = readOutline(doc).length;
  if (bookmarks > 0) stores.push(`${bookmarks} bookmark title(s)`);
  const attachments = listAttachments(doc).length;
  if (attachments > 0) stores.push(`${attachments} embedded file(s)`);
  return stores;
}

/**
 * Every signature field in the document, wherever it is registered.
 *
 * `core/signature.readSignatures` walks `AcroForm /Fields` and throws when that
 * key is absent — which is the case for almost every unsigned PDF, so the tool
 * cannot call it blind. Looking here first keeps "this document is not signed"
 * an answer instead of a stack trace, and catches a signature stored only as a
 * page annotation, which the AcroForm walk misses.
 */
function signatureFields(doc: PDFDocument): PDFDict[] {
  const found: PDFDict[] = [];
  const consider = (entry: unknown): void => {
    const field = dictAt(doc, entry);
    if (!field) return;
    const fieldType = field.get(PDFName.of('FT'));
    const value = dictAt(doc, field.get(PDFName.of('V')));
    const valueType = value?.get(PDFName.of('Type'));
    const isSig =
      (fieldType instanceof PDFName && fieldType.asString() === '/Sig')
      || (valueType instanceof PDFName && valueType.asString() === '/Sig');
    if (isSig && !found.includes(field)) found.push(field);
  };
  const acroForm = dictAt(doc, doc.catalog.get(PDFName.of('AcroForm')));
  const fields = arrayAt(doc, acroForm?.get(PDFName.of('Fields')));
  if (fields) {
    for (let index = 0; index < fields.size(); index++) consider(fields.get(index));
  }
  for (const page of doc.getPages()) {
    const annots = arrayAt(doc, page.node.get(PDFName.of('Annots')));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index++) consider(annots.get(index));
  }
  return found;
}

/**
 * The timestamp tool's failures, phrased as an instruction (E13, E20).
 *
 * Three different things can go wrong and the old wording conflated them: the
 * document has no signature; the signature is there but the timestamp step
 * cannot read it; and the authority is unreachable. Only the last one has
 * anything to do with the network, and none of them should leave the user
 * thinking their document is now timestamped.
 */
function timestampFailure(error: unknown, tsaUrl: string, signatureCount: number): Error {
  const detail = error instanceof Error ? error.message : String(error ?? 'unknown reason');
  if (signatureCount === 0 || /has no signature/i.test(detail)) {
    return new Error('This PDF has no digital signature to timestamp. Run Digital Signature on it first, then timestamp the signed file.');
  }
  if (/not a PKCS#7|no signer information|no message digest|could not be read/i.test(detail)) {
    return new Error(
      `The signature in this PDF could not be read by the timestamp step (${detail}), so no timestamp was attached and nothing was changed. The signature itself is untouched — Validate Signature still reports on it; a timestamp can be added when the authority answers this app's request.`,
    );
  }
  return new Error(
    `The timestamp authority at ${tsaUrl} could not be reached (${detail}). This is the only step in BrowserSnip that needs the network — the signature digest, never the document, is sent. Try again with a connection, or keep the untimed signature.`,
  );
}

/**
 * Re-read the bytes a protection tool just wrote, and describe what they say.
 *
 * Returns the recorded permissions plus the warnings the tool must carry: wrong
 * cipher, permissions that did not reach the file, and page content that came
 * out byte-identical — which means the password gate was written but the text
 * itself was not re-encrypted by the built-in engine.
 */
async function verifyProtection(
  bytes: Uint8Array,
  name: string,
  requested: PDFPermissions,
  cipherLabel: string,
  sourceFingerprint: string,
  opensFreely: boolean,
): Promise<{ inspection: PdfInspection; warnings: string[] }> {
  // No password: the gate is what a reader without one sees (E4).
  const inspection = await inspectPdf(bytes, name);
  const warnings: string[] = [];
  if (!inspection.encrypted) {
    warnings.push(`The saved file carries no /Encrypt entry, so a reader will open it without asking for ${cipherLabel} protection.`);
  } else if (inspection.algorithm && inspection.algorithm !== cipherLabel) {
    warnings.push(`The file records ${inspection.algorithm}, not the ${cipherLabel} cipher that was selected.`);
  }
  warnings.push(...permissionMismatches(requested, inspection.permissions));
  if (!inspection.encrypted) return { inspection, warnings };
  // A restrictions-only file must still open on double-click; a file with an
  // open password must not. `PDFDocument.load` with an empty password is the
  // reader's point of view here, because the guard reports any /Encrypt as
  // needing a password (it cannot know the user password is empty).
  let opensWithoutOne = false;
  try {
    await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    opensWithoutOne = true;
  } catch {
    opensWithoutOne = false;
  }
  if (opensFreely && !opensWithoutOne) {
    warnings.push('No open password was set, yet the saved file does not open on the empty password — check the copy before sending it.');
  }
  if (!opensFreely && opensWithoutOne) {
    warnings.push('The saved file opens without any password even though one was set, so it offers no confidentiality.');
  }
  try {
    const written = await openPDF(bytes, { ignoreEncryption: true });
    if (contentFingerprint(written) === sourceFingerprint) {
      warnings.push(
        'The page content came out of the engine unchanged, so the password and restrictions are recorded in the file but the text inside it was not rewritten as ciphertext. Readers will prompt for the password; a tool that ignores /Encrypt can still read the page.',
      );
    }
  } catch {
    // Nothing to admit: the streams could not be re-read, which is what a file
    // whose content really was encrypted looks like from this side.
  }
  return { inspection, warnings };
}


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
