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
  PDFNumber,
  PDFRef,
  openPDF,
  savePDF,
  saveEncrypted,
} from '../core/doc';
import { looksEncrypted } from '../core/doc';
import type { PDFPermissions } from '../core/doc';
import type { PDFPage } from '../core/doc';
import { cropBox, formatPages, normaliseRotation } from '../core/pages';
import type { PageFrame } from '../core/tables';
import { viewerRectToUserSpace } from '../core/tables';
import { formatBytes, formatPdfDate, readInfo, readXmp, scrubMetadataText } from '../core/metadata';
import { listAttachments, removeAttachments } from '../core/attachments';
import { openRender } from '../core/render';
import type { ExtractedTextItem } from '../core/render';
import { annotationCount, listAnnotations } from '../core/annotations';
import { readOutline, writeOutline } from '../core/bookmarks';
import type { OutlineNode } from '../core/bookmarks';
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
  downloadStem,
  inspectPdf,
  resolutionField,
  openInputs,
  pdfResult,
  filesResult,
  rebuildDocument,
  reportResult,
  type OpenedInput,
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

const PERMISSION_NOTES = [
  'Permissions are a request, not encryption of what you can see: the PDF standard lets a reader ignore the /P flags, and a tool that ignores the format (or a print-to-PDF pass) removes them entirely.',
  'The owner password is what unlocks the restrictions. Leave it blank and a random one is generated, so the limits hold but nobody can lift them by name later.',
];

/**
 * What this browser's engine does and does not do to the bytes.
 *
 * `saveEncrypted` records the cipher, the two password hashes and the `/P`
 * dictionary, and `@maxwbh/pdf-lib`'s writer never calls its own
 * `PDFSecurity.encryptStream`, so the page streams leave this tab exactly as
 * they arrived. Any wording about protection has to live inside that fact (E5).
 */
const CIPHERTEXT_NOTE =
  'The password prompt and the /P flags are written into the file; the page streams themselves are copied through as they are, so a tool that ignores /Encrypt can still lift the text out. Every run of this tool re-reads the output and says which of the two it got.';

const SCAN_ALTERNATIVE_NOTE =
  'When the bytes themselves must be unreadable, turn the pages into pictures first — PDF to Images, then Images to PDF — and protect the result. A scan holds no extractable text to recover.';

/**
 * One spelling of the /P permission checkboxes, shared by both panels.
 *
 * Declared as two columns of four. The bar puts each `group` in its own column and
 * collapses to one truncated summary line, so eight checkboxes under one heading
 * is a column nobody finishes reading — and the summary never reaches the second
 * half of them.
 */
function permissionFields(whenSet?: (v: Record<string, unknown>) => boolean) {
  const shown = whenSet ? { when: whenSet } : {};
  return [
    { key: 'allowPrinting', label: 'Allow printing', type: 'toggle' as const, default: true, group: 'Reading and printing', help: 'Off still prints from the owner password; a reader without it is refused.', ...shown },
    {
      key: 'printLevel',
      label: 'Print quality',
      type: 'select' as const,
      default: 'high',
      group: 'Reading and printing',
      options: [
        { value: 'high', label: 'Any resolution' },
        { value: 'low', label: 'Low resolution only (150 dpi)' },
      ],
      when: (v: Record<string, unknown>) => v.allowPrinting === true && (!whenSet || whenSet(v)),
      help: 'Low resolution is a hint most readers honour; it is not a downsample, so the full-quality page is still in the file.',
    },
    { key: 'allowCopying', label: 'Allow copying text and images', type: 'toggle' as const, default: true, group: 'Reading and printing', help: 'Text and images a reader may lift out of the file — the permission that stops a contract being pasted elsewhere.', ...shown },
    { key: 'allowAccessibility', label: 'Allow screen readers', type: 'toggle' as const, default: true, group: 'Reading and printing', help: 'Extract text for assistive technology. Turning this off makes the document unusable to a blind reader and nothing else.', ...shown },
    { key: 'allowModifying', label: 'Allow modifying', type: 'toggle' as const, default: true, group: 'Editing rights', help: 'Page editing, form-field creation and rotation of the document body. Leave it off for anything already filed or signed.', ...shown },
    { key: 'allowAnnotating', label: 'Allow comments', type: 'toggle' as const, default: true, group: 'Editing rights', help: 'Adding or changing annotations, highlights and form-field appearances (the /Annotate flag).', ...shown },
    { key: 'allowFillingForms', label: 'Allow filling forms', type: 'toggle' as const, default: true, group: 'Editing rights', help: 'Typing into the fields that already exist (/QueryForms). Separate from adding comments: a reader may do one and not the other.', ...shown },
    { key: 'allowAssembling', label: 'Allow page reorganisation', type: 'toggle' as const, default: false, group: 'Editing rights', help: 'Inserting, rotating, deleting or extracting pages and editing bookmarks (/Assemble). Off keeps a filed document in one piece.', ...shown },
  ];
}

export const securityTools: PdfToolDefinition[] = [
  {
    id: 'protect',
    name: 'Protect PDF',
    description: 'Open password, owner password and the /P permissions, recorded in the file',
    icon: '🔐',
    category: 'security',
    // The cipher names are searchable because the cipher is a choice this tool
    // writes into `/Encrypt`; people look for a locked PDF by the algorithm.
    keywords: ['encrypt', 'encryption', 'aes', 'aes-256', 'rc4', 'cipher', 'password', 'restrict', 'lock'],
    outputSuffix: '_protected.pdf',
    promise: 'A copy that asks for your password before it opens, with the permissions you ticked written in and read back from the output to prove they landed.',
    actionLabel: 'Protect',
    notes: [CIPHERTEXT_NOTE, SCAN_ALTERNATIVE_NOTE, ...PERMISSION_NOTES],
    fields: [
      {
        key: 'mode',
        label: 'Protection type',
        type: 'segmented',
        default: 'both',
        group: 'Password',
        options: [
          { value: 'user', label: 'Open password' },
          { value: 'owner', label: 'Permissions only' },
          { value: 'both', label: 'Both' },
        ],
        help: 'An open password blocks reading. A permissions-only password lets anyone open the file but restricts printing, copying and editing in readers that honour it.',
      },
      {
        key: 'userPassword',
        label: 'Open password',
        type: 'password',
        group: 'Password',
        placeholder: 'What a reader types to see the pages',
        when: (v) => v.mode !== 'owner',
        // A required field the user can actually find: the message lands on the box
        // it belongs to, which is the whole difference between three adjacent
        // password fields and one of them being clearly the one still needed.
        //
        // The predicate restates the `when` above rather than saying `true`, and
        // that is not decoration. A field that is required unconditionally can be
        // hidden by `when` while still blocking the run - a gate with nothing
        // behind it. Declaring the requirement with the same condition makes that
        // state unreachable: whenever this field disappears, it stops being a
        // requirement in the same breath.
        required: (v) => v.mode !== 'owner',
        missing: 'Enter the password readers must type to open this PDF.',
        help: 'Renaming or zipping the file does not get around this prompt in a reader that honours /Encrypt. The page streams themselves are copied through, so a tool that ignores /Encrypt can still read the text.',
      },
      {
        key: 'ownerPassword',
        label: 'Owner password',
        type: 'password',
        group: 'Password',
        placeholder: 'Blank reuses the open password',
        // Only a permissions-only PDF needs this on its own; in every other mode
        // a blank owner password legitimately reuses the open one.
        required: (v) => stringValue(v, 'mode', 'both') === 'owner',
        missing: 'Enter an owner password — it is what unlocks the restrictions.',
        help: 'Leave empty to reuse the open password. A random one is generated if both are blank.',
      },
      { key: 'version', label: 'Cipher', type: 'select', default: '5', options: CIPHER_OPTIONS, group: 'Password', help: 'AES-256 for anything current. Older options exist for readers from before PDF 1.7: RC4-40 is breakable in seconds on a laptop.' },
      ...permissionFields(),
    ],
    validate(values) {
      const mode = stringValue(values, 'mode', 'both');
      const user = stringValue(values, 'userPassword');
      const owner = stringValue(values, 'ownerPassword');
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
      // One password for both jobs is the common case and the least protected
      // one, so it is named rather than left to the tooltip.
      if (user && !stringValue(context.values, 'ownerPassword')) {
        warnings.push('The open password is also the owner password here: anyone who can open the file can remove its restrictions. Set a separate owner password if that matters.');
      }
      // The gate is then checked from the outside, with the reader this app
      // draws its own previews with. Whatever the built-in engine recorded, a
      // reader that refuses the password is the fact the user needs (E5).
      const reader = user ? await probeReader(bytes, user) : await probeReader(bytes);
      const gateOpens = reader.verdict === 'opens';
      if (reader.verdict === 'unavailable' || reader.verdict === 'unreadable') {
        warnings.push(`No PDF reader could be started in this browser to re-check the saved file${reader.detail ? ` (${reader.detail})` : ''}, so only the built-in engine's own view of it was verified.`);
      } else if (user && reader.verdict !== 'opens') {
        warnings.push(`A PDF reader refused the password you set on the saved file (${reader.verdict === 'wrong-password' ? '“not correct”' : 'it still asks before it will open'}) while the built-in engine accepts it, so the gate is recorded but not portable. Open the copy in the reader your recipient uses before you rely on it.`);
      } else if (!user && reader.verdict !== 'opens') {
        warnings.push('No open password was set, yet a PDF reader will not open the saved file without one — check the copy before sending it.');
      }
      const pagesMatch = gateOpens && reader.pages === input.doc.getPageCount();
      if (gateOpens && !pagesMatch) {
        warnings.push(`The saved file shows ${reader.pages} page(s) to a PDF reader but ${input.doc.getPageCount()} to the engine that wrote it.`);
      }
      const how = user
        ? `${cipherName} and an open password`
        : `${cipherName}, restrictions only — no open password was set`;
      return {
        kind: 'pdf',
        bytes,
        // The bytes were saved from `input.doc` a moment ago, so its page count
        // is the output's — the only moment this number is free.
        pages: input.doc.getPageCount(),
        message: `Protected with ${how}. As written to the file: ${permissionSentence(inspection.permissions ?? flags)}. ${
          gateOpens && user
            ? `A PDF reader opened the copy with that password and read ${reader.pages} page(s).`
            : gateOpens
              ? `A PDF reader opened the copy with no password and read ${reader.pages} page(s), with the restrictions above in force.`
              : 'Re-read by the built-in engine only; no independent reader could confirm the gate.'
        }`,
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
    promise: 'The same pages, opening with no password asked — and a refusal to hand back a file that still carries one.',
    actionLabel: 'Unlock',
    notes: [
      'Protection lives in the trailer, so it is removed there: the page tree, the form fields, the comments, the bookmarks and any embedded files all stay where they were.',
      'A file that needs the password just to be read cannot lose it here: unlock it with the open password first. A restricted-but-openable one needs no password at all.',
      'If the fields, comments or bookmarks of the source do come out missing, the result names them; the page count is refused outright rather than reported.',
    ],
    fields: [{ key: 'password', label: 'Current password', type: 'password', group: 'Password', placeholder: 'The password this file opens with', help: 'Either the user or the owner password works. Leave blank if the file is restricted but readable.' }],
    async run(context) {
      const [input] = await openInputs(context);
      const password = stringValue(context.values, 'password') || context.password || '';
      if (!input.inspection?.encrypted) {
        // Nothing to remove. Rebuilding the page tree for show would drop form
        // fields, comments and bookmarks from a file that never needed it.
        return {
          kind: 'pdf',
          bytes: input.bytes,
          pages: input.doc.getPageCount(),
          message: `"${input.name}" is not password protected — it already opens without one, so the file is returned unchanged.`,
          warnings: ['No /Encrypt entry was found, so there was no password to remove.'],
        };
      }
      const doc = await openForStripping(input, password);
      const removed = await stripProtectionFrom(input, doc, await sourceTextOf(input.bytes, password));
      return {
        kind: 'pdf',
        bytes: removed.bytes,
        pages: removed.pages,
        message: `Removed protection — the file opens without a password now: ${removed.pages} page(s), ${removed.contentKept ? 'page content verified' : 'page content re-read with differences'}, carrying ${structureSentence(removed.kept)}.`,
        warnings: removed.warnings,
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
    promise: 'The printing, copying and editing limits on this file, rewritten — and the result reports what the saved file actually recorded.',
    actionLabel: 'Change permissions',
    notes: [
      'This tool writes the /P dictionary without an open password, so the document still opens freely. Use Protect to make it unreadable without one.',
      CIPHERTEXT_NOTE,
      ...PERMISSION_NOTES,
    ],
    fields: [
      { key: 'ownerPassword', label: 'Owner password', type: 'password', group: 'Password', placeholder: 'Only needed when the file is already protected', help: 'Needed when the file is already protected. Blank on an unprotected file means a random one is generated.' },
      {
        key: 'action',
        label: 'Action',
        type: 'segmented',
        default: 'set',
        group: 'Password',
        options: [
          { value: 'set', label: 'Apply these permissions' },
          { value: 'clear', label: 'Remove all restrictions' },
        ],
        help: 'Remove all restrictions drops the encryption dictionary, which is the only edit that clears a permissions-only file from inside this tool.',
      },
      { key: 'version', label: 'Cipher', type: 'select', default: '5', options: CIPHER_OPTIONS, group: 'Password', when: (v) => v.action === 'set', help: 'AES-256 for anything current. Older options exist for readers from before PDF 1.7: RC4-40 is breakable in seconds on a laptop.' },
      ...permissionFields((v) => v.action === 'set'),
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const owner = stringValue(context.values, 'ownerPassword') || context.password || '';
      const doc = await openForStripping(input, owner);
      const wasProtected = input.inspection?.encrypted === true;
      if (stringValue(context.values, 'action', 'set') === 'clear') {
        if (!wasProtected) {
          return {
            kind: 'pdf',
            bytes: input.bytes,
            pages: input.doc.getPageCount(),
            message: `"${input.name}" carries no encryption dictionary, so there were no restrictions to remove — the file is returned unchanged.`,
            warnings: ['Nothing to clear: this PDF is not protected.'],
          };
        }
        const cleared = await stripProtectionFrom(input, doc, await sourceTextOf(input.bytes, owner));
        return {
          kind: 'pdf',
          bytes: cleared.bytes,
          pages: cleared.pages,
          message: `All restrictions and the password were removed — ${cleared.pages} page(s) verified readable with no password, carrying ${structureSentence(cleared.kept)}.`,
          warnings: cleared.warnings,
        };
      }
      const flags = permissionsObject({
        printing: booleanValue(context.values, 'allowPrinting', true),
        // Read from the form, not assumed: this panel shows the same print-quality
        // choice `protect` does, and a recorded bit that ignores it is a
        // restriction the file does not carry.
        printLevel: stringValue(context.values, 'printLevel', 'high'),
        modifying: booleanValue(context.values, 'allowModifying', true),
        copying: booleanValue(context.values, 'allowCopying', true),
        annotating: booleanValue(context.values, 'allowAnnotating', true),
        fillingForms: booleanValue(context.values, 'allowFillingForms', true),
        contentAccessibility: booleanValue(context.values, 'allowAccessibility', true),
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
      // The promise of this mode is that the file still opens: asked of a reader
      // rather than assumed from the empty user password we passed in.
      const reader = await probeReader(bytes);
      if (reader.verdict === 'unavailable' || reader.verdict === 'unreadable') {
        warnings.push(`No PDF reader could be started in this browser to re-open the saved copy${reader.detail ? ` (${reader.detail})` : ''}, so the restrictions were confirmed only with the built-in engine.`);
      } else if (reader.verdict !== 'opens') {
        warnings.push(`A PDF reader will not open the saved copy without a password (${reader.detail ?? reader.verdict}) even though no open password was set.`);
      }
      return {
        kind: 'pdf',
        bytes,
        pages: doc.getPageCount(),
        message: `Restrictions as recorded in the file (${cipherName}): ${permissionSentence(inspection.permissions ?? flags)}. ${
          reader.verdict === 'opens'
            ? `A PDF reader opens it with no password: ${reader.pages} page(s) readable.`
            : 'The document is written to open without a password.'
        }`,
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
    promise: 'Every restriction lifted — the copy opens, prints, copies and edits without a password or an owner key.',
    actionLabel: 'Remove restrictions',
    notes: [
      'A signature in the source is broken by clearing its restrictions, whether the page tree is rebuilt or only the encryption entry is dropped: verify the signature first if the file is signed.',
      'A file with no /Encrypt entry is returned unchanged, and the result says so rather than claiming a removal.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const password = context.password ?? '';
      if (!input.inspection?.encrypted) {
        return {
          kind: 'pdf',
          bytes: input.bytes,
          pages: input.doc.getPageCount(),
          message: `"${input.name}" has no encryption dictionary, so nothing was restricting it — the file is returned unchanged.`,
          warnings: ['Nothing to clear: this PDF carries no /Encrypt entry, so a reader cannot be told to hold it back.'],
        };
      }
      const doc = await openForStripping(input, password);
      const cleared = await stripProtectionFrom(input, doc, await sourceTextOf(input.bytes, password));
      return {
        kind: 'pdf',
        bytes: cleared.bytes,
        pages: cleared.pages,
        message: `Restrictions cleared — ${cleared.pages} page(s) verified readable with no /Encrypt entry and no password needed, carrying ${structureSentence(cleared.kept)}.`,
        warnings: cleared.warnings,
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
    promise: 'Form answers baked into the page, and comments baked wherever they have an appearance to draw — the result counts what is still live.',
    actionLabel: 'Flatten',
    notes: [
      'A flattened mark is page content: it can no longer be selected, moved, deleted or read as a comment by another reader.',
      'Annotations with no stored appearance have nothing to bake, and the result names how many were left live instead of pretending they were flattened.',
      'Baking changes the bytes, so it breaks a signature that is already on the file — flatten first, then sign.',
    ],
    fields: [
      { key: 'forms', label: 'Flatten form fields', type: 'toggle', default: true, group: 'What to bake in', help: 'Field values are drawn into the page and the interactive field is removed, so the answers cannot be retyped.' },
      { key: 'annotations', label: 'Flatten comments', type: 'toggle', default: true, group: 'What to bake in', help: 'Highlights, ink, stamps and text notes become page content. Turn this off to bake only the form fields.' },
      { key: 'keepLinks', label: 'Keep clickable links', type: 'toggle', default: true, group: 'What to bake in', help: 'Off draws the underline but removes the target, which is what a print-ready or archived copy wants.' },
      resolutionField({ group: 'What to bake in', max: 400, help: 'How sharply an annotation is re-drawn when it has no usable appearance of its own. Higher is crisper and bigger.' }),
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { flattenAnnotations } = await import('../core/flatten');
      const { flattenForm } = await import('../core/forms');
      const needsRender = booleanValue(context.values, 'annotations', true);
      const keepLinks = booleanValue(context.values, 'keepLinks', true);
      const session = needsRender ? await openRender(input.bytes, { password: context.password }) : null;
      const warnings: string[] = [];
      let bakedAnnotations = 0;
      let pagesTouched = 0;
      let skippedNoAppearance = 0;
      let fieldsBaked = 0;
      try {
        const fields = booleanValue(context.values, 'forms', true)
          ? await flattenForm(input.doc, session ?? undefined)
          : { flattened: 0, needsRender: false };
        fieldsBaked = fields.flattened;
        if (fields.needsRender && fields.flattened === 0) {
          warnings.push('The form fields could not be baked from their appearances, so they are still interactive in the output.');
        }
        try {
          const outcome = await flattenAnnotations(
            input.doc,
            session ?? undefined,
            {
              kinds: needsRender ? undefined : ['Link'],
              keepLinks,
              onProgress: context.progress,
            },
          );
          bakedAnnotations = outcome.flattened;
          pagesTouched = outcome.pagesTouched;
          skippedNoAppearance = outcome.skippedNoAppearance;
        } catch (error) {
          // An appearance the engine cannot draw is a comment left where it is,
          // not a flattened one: the run continues and the saved file is read
          // back, so the result reports what is really still live.
          warnings.push(
            `The comments could not be drawn into the page content (${error instanceof Error ? error.message : 'unknown reason'}), so they were left as live annotations rather than reported as flattened.`,
          );
        }
      } finally {
        await session?.destroy();
      }
      const bytes = await savePDF(input.doc);
      // The claim is read out of the output, not out of the counters: a field
      // that survived the bake is still typeable, whatever this run tallied.
      const saved = await liveMarks(bytes);
      if (skippedNoAppearance > 0) {
        warnings.push(`${skippedNoAppearance} annotation(s) had no appearance to draw and were left as live comments instead of being baked in.`);
      }
      if (saved.fields > 0) {
        warnings.push(`${saved.fields} form field(s) are still interactive in the saved file, so their answers can still be retyped.`);
      }
      const liveMarksLeft = keepLinks ? saved.marks - saved.links : saved.marks;
      if (needsRender && liveMarksLeft > 0) {
        warnings.push(`${liveMarksLeft} comment(s) are still live annotations in the saved file rather than page content.`);
      }
      if (!needsRender) {
        warnings.push('Annotation flattening was off, so comments stayed live — only link annotations were considered.');
      }
      if (bakedAnnotations === 0 && fieldsBaked === 0) {
        warnings.push('This PDF had nothing of the selected kind to flatten, so the file is effectively unchanged.');
      }
      const stillLive = [
        ...(saved.fields > 0 ? [`${saved.fields} form field(s) still interactive`] : []),
        ...(liveMarksLeft > 0 ? [`${liveMarksLeft} comment(s) still live`] : []),
      ];
      return {
        kind: 'pdf',
        bytes,
        pages: input.doc.getPageCount(),
        // The two bakes are counted separately because only the annotation pass
        // reports pages: `flattenForm` answers with a field count, and a run whose
        // comments could not be drawn would otherwise read "into the content of
        // 0 page(s)" while two field values were in fact painted.
        message: needsRender
          ? `${bakedAnnotations} annotation(s) drawn into the content of ${pagesTouched} page(s) and ${fieldsBaked} form field(s) removed from the form${
              stillLive.length > 0 ? `; ${andList(stillLive)} in the saved file` : '; nothing of the selected kind is left live'
            }.`
          : `${fieldsBaked} form field(s) removed from the form and drawn into the page content${
              saved.fields > 0 ? `; ${saved.fields} field(s) are still interactive in the saved file` : ''
            }. Turn on flatten comments to bake the marks as well.`,
        warnings,
      };
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
    promise: 'The words under each box deleted from the page, then painted over — select the black bar and there is nothing left to copy.',
    actionLabel: 'Redact',
    notes: [
      'Redaction deletes glyphs from page content. With the metadata option on the same words are deleted from the document properties, the XMP packet and the bookmark titles as well; a comment’s own text and an embedded file’s bytes are never rewritten, and the result names whatever still holds the words.',
      'An area that lands inside an image is painted over rather than cut out: the pixels of a scanned page still contain the shape of what was there.',
    ],
    fields: [
      { key: 'fill', label: 'Redaction colour', type: 'color', default: '#000000', group: 'Marking', help: 'Painted on after the text is deleted, so a pale colour is fine as long as the words are gone from the content.' },
      { key: 'alsoMetadata', label: 'Also clear matching text from metadata and bookmarks', type: 'toggle', default: true, group: 'Marking', help: 'Off leaves the word in the outline and the document properties, where a search still finds it.' },
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
      const pages = input.doc.getPages();
      const outOfRange = marked.filter((r) => !Number.isInteger(r.page) || r.page < 0 || r.page >= pages.length);
      if (outOfRange.length > 0) {
        throw new Error(
          `A redaction targets page ${(Number.isInteger(outOfRange[0].page) ? outOfRange[0].page : 0) + 1}, but this document has ${pages.length} page${pages.length === 1 ? '' : 's'}. Choose pages inside the document.`,
        );
      }
      // The marks arrive in the space the editor shows: the page as displayed,
      // origin top-left, `/Rotate` and an offset `/MediaBox` already folded in.
      // Page content is addressed in unrotated user space from the bottom-left,
      // so every mark is turned back through the same quarter-turn maths the
      // table and OCR paths use. Skipping that redacts the mirrored band: the
      // bar lands where the user drew it, the deleted words are someone else's.
      const placed = marked.map((region) => ({
        page: region.page,
        rect: viewerRectToUserSpace(
          { x: region.x, y: region.y, width: region.width, height: region.height },
          frameOf(pages[region.page]),
        ),
      }));
      // What a reader can lift out from under the marks beforehand. The claim
      // afterwards is only as good as this comparison, so a redaction that
      // painted a bar over still-selectable text cannot pass for one.
      const before = await readMarkedWords(input.bytes, context.password, marked);
      const outcome = applyRedactions(input.doc, placed, { fill });

      const warnings: string[] = [];
      if (skipped > 0) {
        warnings.push(`${skipped} marked area(s) had no width or height and were skipped — a redaction has to cover something to delete something.`);
      }
      if (outcome.rasterised) {
        warnings.push('At least one area fell inside an image, so the pixels there were painted over rather than cut out: text that is part of a scanned page survives as image data.');
      }
      if (!before.ok) {
        warnings.push(`No PDF reader could be started in this browser to re-read the text under the marked areas${before.detail ? ` (${before.detail})` : ''}, so the deletion was confirmed from the page content alone — spot-check the copy.`);
      }

      // The option promises the words go from the properties and the bookmarks
      // too, so they are deleted there and the result says where they were found.
      // Only words that sit under a mark and nowhere else on the page are taken
      // as redacted text: a term repeated in a heading the user did not mark is
      // not a secret.
      if (booleanValue(context.values, 'alsoMetadata', true) && before.unique.length > 0) {
        const scrubbed = scrubMetadataText(input.doc, before.unique);
        const titles = scrubOutlineTitles(input.doc, before.unique);
        if (scrubbed.properties.length > 0 || scrubbed.xmp || titles > 0) {
          const where = [
            ...(scrubbed.properties.length > 0
              ? [`${scrubbed.properties.length} document propert${scrubbed.properties.length === 1 ? 'y' : 'ies'}`]
              : []),
            ...(scrubbed.xmp ? ['the XMP packet'] : []),
            ...(titles > 0 ? [`${titles} bookmark title(s)`] : []),
          ];
          warnings.push(`Also deleted the redacted words from ${where.join(', ')} — a search that reads properties or the outline no longer finds them.`);
        }
      }
      const elsewhere = textHeldOutsidePageContent(input.doc);
      const clearEverywhere = booleanValue(context.values, 'alsoMetadata', true);
      if (clearEverywhere && elsewhere.length > 0) {
        warnings.push(`Redaction deletes text from page content and, with this option on, from the document properties and the outline — ${andList(elsewhere)} still hold other text this tool does not rewrite. Clear it with Remove Metadata if the file must not carry it at all.`);
      } else if (!clearEverywhere && before.unique.length > 0 && elsewhere.length > 0) {
        warnings.push(`"Also clear matching text from metadata and bookmarks" was off, so the redacted words stay in ${andList(elsewhere)} — a search that reads them still finds what the page no longer shows.`);
      }
      // Comment text and an enclosure's bytes are outside every store this tool
      // rewrites, and they are named separately from the generic caveat above:
      // one is the secret surviving, the other is merely other text (E20).
      const leaked = redactedWordsStillHeld(input.doc, before.unique);
      if (leaked.length > 0) {
        warnings.push(`${andList(leaked)} still hold the redacted words: this tool rewrites page content, the document properties and bookmark titles, not comment text or an embedded file's own bytes.`);
      }
      const bytes = await savePDF(input.doc);
      const after = before.ok ? await readMarkedWords(bytes, undefined, marked) : null;
      const survivors = after ? before.unique.filter((word) => after.all.includes(word)) : [];
      const destroyed = before.unique.length > 0 ? before.unique.filter((word) => !survivors.includes(word)) : [];
      if (survivors.length > 0) {
        warnings.push(`${survivors.length} word(s) under the marked areas are still extractable from the saved file: ${previewList(survivors)}. They are covered, not gone — widen the mark to cover the whole line, or convert that page to an image and redact the image.`);
      }
      return {
        kind: 'pdf',
        bytes,
        pages: input.doc.getPageCount(),
        message: outcome.removed === 0
          ? `Marked ${marked.length} area(s); none of them held text, so nothing was deleted — the fill was painted over the page only.`
          : survivors.length > 0
            ? `Deleted ${outcome.removed} text run(s) under ${marked.length} area(s) and painted the fill, but ${survivors.length} word(s) under those areas still extract from the saved file.`
            : `Redacted ${outcome.removed} text run(s) under ${marked.length} area(s) by deleting the glyphs themselves${
                after
                  ? destroyed.length > 0
                    ? `, then read the saved file back: none of the ${destroyed.length} word(s) that were under the marks still extracts.`
                    : '; no whole word under the marks could be located in the page text layer, so the deletion was confirmed from the page content alone.'
                  : '.'
              }`,
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
    promise: 'A page-by-page report of what differs, with a picture of each changed area when you compare pixels.',
    actionLabel: 'Compare',
    notes: [
      'Comparison works page against page by number, so a document with one page inserted reports every later page as different.',
      'A difference in rendering is not a difference in content: two files can hold the same text and still differ in pixels because of a font substitute.',
    ],
    fields: [
      {
        key: 'mode',
        label: 'Compare',
        type: 'segmented',
        default: 'visual',
        group: 'What to look for',
        options: [
          { value: 'visual', label: 'Pixels' },
          { value: 'text', label: 'Text content' },
          { value: 'both', label: 'Both' },
        ],
        help: 'Pixels catch a moved logo or a colour change; text content catches a reworded sentence a rendering hides.',
      },
      { key: 'sensitivity', label: 'Sensitivity', type: 'slider', default: 24, min: 1, max: 120, step: 1, integer: true, group: 'What to look for', when: (v) => v.mode !== 'text', help: 'How far a pixel has to move before it counts as different. Raise it when antialiasing makes every page look changed.' },
      resolutionField({ default: 150, min: 72, max: 300, group: 'What to look for', help: 'Both pages are rendered at this resolution before they are compared. Higher finds finer differences and costs more memory per page.' }),
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
      const textlessPages: number[] = [];
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
            // Two pages with no text layer are not a match: they are two pages
            // this mode cannot read. Saying "identical text" over two different
            // scans told the user the documents agreed (E10, E13).
            const silent = ta.trim() === '' && tb.trim() === '';
            rows.push({
              label: `Page ${page}`,
              value: silent
                ? 'neither page has any extractable text — a scanned page: run OCR on both, or compare pixels'
                : ta === tb
                  ? 'identical text'
                  : `text differs (${diffWords(ta, tb)})`,
            });
            if (silent) textlessPages.push(page);
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
      const message = textlessPages.length === pages
        ? `Nothing could be compared: none of the ${pages} page(s) carries a text layer. Run OCR on both files, or compare pixels.`
        : changed === 0
          ? `No differences found across ${pages} page(s).`
          : `${changed} of ${pages} page(s) differ.`;
      const warnings = textlessPages.length > 0 && textlessPages.length < pages
        ? [`${textlessPages.length} of ${pages} page(s) have no extractable text, so text mode could not compare them at all (pages ${textlessPages.join(', ')}). Run OCR, or compare pixels.`]
        : [];
      return { ...reportResult([{ title: 'Page-by-page comparison', rows }], { message }), warnings };
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
    promise: 'Everything the file says about itself — properties, XMP, fonts, images, protection and attachments — read back, not guessed.',
    actionLabel: 'Read metadata',
    notes: [
      'The /P permission flags are reported as what the file records, not as a guarantee: a reader is free to ignore them.',
    ],
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
          // `/Encrypt` alone does not mean a password is asked for: a
          // permissions-only file hashes the empty user password, so it opens on
          // a double-click. Saying "required" there is contradicted by the file.
          value: inspection.passwordAccepted
            ? 'required, and the one supplied opened it'
            : inspection.opensWithEmptyPassword
              ? 'none — the user password is empty, so the file opens without one and only the restrictions apply'
              : 'required',
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
    promise: 'The document properties you can see in a reader’s file panel, rewritten; the pages are left exactly as they were.',
    actionLabel: 'Save properties',
    notes: [
      'Only the info dictionary and the XMP packet change — the page content is not re-written, so this cannot alter what the document says.',
      'Anything you leave blank keeps its current value. To erase a field rather than replace it, use Remove Metadata.',
    ],
    fields: [
      { key: 'title', label: 'Title', type: 'text', group: 'Identity', placeholder: 'The name a reader shows in its tab', help: 'This is what most readers title the window with — more visible to the person reading than the filename is.' },
      { key: 'author', label: 'Author', type: 'text', group: 'Identity', help: 'Shown as the document’s creator and copied into the XMP dc:creator field.' },
      { key: 'subject', label: 'Subject', type: 'text', group: 'Identity', placeholder: 'One line about what the document is about', help: 'A one-line description; also written to the XMP description field when the packet is synced.' },
      { key: 'keywords', label: 'Keywords', type: 'text', group: 'Identity', placeholder: 'comma, separated', help: 'A comma-separated list. Desktop search indexes these; a reader usually just displays them.' },
      { key: 'docLanguage', label: 'Document language', type: 'text', group: 'Identity', placeholder: 'en, de-DE, ja', help: 'A language tag, not a translation. Screen readers and spell-checkers pick their voice from it.' },
      { key: 'creator', label: 'Creator application', type: 'text', group: 'Provenance', placeholder: 'What produced the original content', help: 'The application that produced the original content, which is different from the one that wrote this PDF.' },
      { key: 'producer', label: 'Producer', type: 'text', group: 'Provenance', placeholder: 'What wrote this PDF' , help: 'Named because auditors look for it: overwriting it hides which tool produced the file.' },
      { key: 'syncXmp', label: 'Write the same values into the XMP packet', type: 'toggle', default: true, group: 'Provenance', help: 'Off leaves the two stores disagreeing, and a different reader then shows the value you did not change.' },
      { key: 'touchDates', label: 'Set the modification date to now', type: 'toggle', default: true, group: 'Provenance', help: 'Off keeps the original ModDate, which is what you want when the file has been signed or filed against that date.' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { writeInfo, readInfo, writeXmp } = await import('../core/metadata');
      const current = readInfo(input.doc);
      const keywords = stringValue(context.values, 'keywords');
      const written: Parameters<typeof writeInfo>[1] = {
        title: stringValue(context.values, 'title') || current.title,
        author: stringValue(context.values, 'author') || current.author,
        subject: stringValue(context.values, 'subject') || current.subject,
        keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean).join(', ') : current.keywords,
        creator: stringValue(context.values, 'creator') || current.creator,
        producer: stringValue(context.values, 'producer') || current.producer,
        lang: stringValue(context.values, 'docLanguage') || current.lang,
      };
      // The control reads "Set the modification date to now", and `freshDates`
      // also overwrote CreationDate — a document's birthday is not this tool's to
      // change, and auditors read it.
      if (booleanValue(context.values, 'touchDates', true)) written.modDate = formatPdfDate(new Date());
      writeInfo(input.doc, written);
      if (booleanValue(context.values, 'syncXmp', true)) {
        const info = readInfo(input.doc);
        const previous = readXmp(input.doc);
        const subjects = (info.keywords ?? '')
          .split(/[,;]+/)
          .map((word) => word.trim())
          .filter(Boolean)
          .map((word) => `<rdf:li>${escapeXml(word)}</rdf:li>`)
          .join('');
        // A packet that declared PDF/A conformance keeps it: editing the
        // properties must not silently un-archive a filed document, and that
        // identity exists only in the XMP.
        const pdfa = previous?.pdfaPart !== undefined
          ? `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">` +
            `<pdfaid:part>${previous.pdfaPart}</pdfaid:part>` +
            (previous.pdfaConformance ? `<pdfaid:conformance>${escapeXml(previous.pdfaConformance)}</pdfaid:conformance>` : '') +
            `</rdf:Description>`
          : '';
        writeXmp(
          input.doc,
          `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
          `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">` +
          `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
          `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(info.title ?? '')}</rdf:li></rdf:Alt></dc:title>` +
          `<dc:creator><rdf:Seq><rdf:li>${escapeXml(info.author ?? '')}</rdf:li></rdf:Seq></dc:creator>` +
          `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(info.subject ?? '')}</rdf:li></rdf:Alt></dc:description>` +
          (subjects ? `<dc:subject><rdf:Seq>${subjects}</rdf:Seq></dc:subject>` : '') +
          (info.producer ? `<pdf:Producer>${escapeXml(info.producer)}</pdf:Producer>` : '') +
          (info.creator ? `<xmp:CreatorTool>${escapeXml(info.creator)}</xmp:CreatorTool>` : '') +
          `</rdf:Description>${pdfa}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
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
    promise: 'The hidden properties, XMP packet and reader settings taken out, with a list of what was actually found and removed.',
    actionLabel: 'Remove metadata',
    notes: [
      'Metadata is not the page. Words still sit in the content streams, bookmarks and annotations of a document, and text hidden under a redaction bar is removed by Redact PDF, not here.',
      'A store that was already empty is reported as untouched rather than counted as removed.',
    ],
    fields: [
      { key: 'info', label: 'Document info dictionary', type: 'toggle', default: true, group: 'What to remove', help: 'Title, author, subject, keywords, producer and the dates. This is the panel a reader shows under Properties.' },
      { key: 'xmp', label: 'XMP metadata stream', type: 'toggle', default: true, group: 'What to remove', help: 'The XML copy of the same facts, plus history some applications embed. Removing one store and leaving the other is how a "cleaned" file still carries your name.' },
      { key: 'attachments', label: 'Embedded files', type: 'toggle', default: false, group: 'What to remove', help: 'Off by default because these are payload, not furniture: an attachment can be the contract itself.' },
      { key: 'readerSettings', label: 'Last-opened page and zoom memory', type: 'toggle', default: true, group: 'What to remove', help: 'Which page and zoom the document opens at, and whether the title or the filename is shown. They reveal how the file was used.' },
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
        pages: input.doc.getPageCount(),
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
    promise: 'The files carried inside the PDF itself, so the document and its enclosures travel as one attachment.',
    actionLabel: 'Attach files',
    notes: [
      'Nothing is uploaded: the bytes are stored inside the PDF, which grows by roughly the size of every file you add.',
      'An attachment is only as useful as the reader showing it. A viewer without an attachments panel — including a printout — gives no sign the files are there.',
    ],
    fields: [
      { key: 'files', label: 'Files to attach', type: 'file', accept: '*/*', multiple: true, maxFiles: 20, group: 'Files', help: 'Up to 20 files of any type. They are embedded whole, not referenced, so the PDF is the only file you need to send.' },
      { key: 'description', label: 'Note stored with each file', type: 'text', group: 'Files', placeholder: 'What this enclosure is', help: 'Stored with every file in this run, so one note cannot describe three different enclosures.' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { addAttachments } = await import('../core/attachments');
      const extras = fileValues(context.values, 'files');
      if (extras.length === 0) throw new Error('Choose at least one file to attach.');
      const description = stringValue(context.values, 'description');
      const wanted = extras.map((f) => ({
        name: f.name,
        bytes: f.bytes,
        mimeType: f.mimeType,
        description: description || undefined,
      }));
      const before = new Map(listAttachments(input.doc).map((a) => [a.name, a]));
      // `addAttachments` returns how many the document carries afterwards, which
      // is not how many this run embedded: a document with one attachment and one
      // new file did not gain two. The names are diffed instead, and the saved
      // bytes are asked what they really carry.
      const had = before.size;
      await addAttachments(input.doc, wanted);
      const requested = [...new Set(wanted.map((file) => file.name))];
      const replaced = requested.filter((name) => before.has(name));
      const added = requested.filter((name) => !before.has(name));
      const collided = wanted.length - requested.length;
      const bytes = await savePDF(input.doc);
      const carried = listAttachments(await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }));
      const warnings: string[] = [];
      if (collided > 0) {
        warnings.push(`${collided} file(s) shared a name with another in this run, and a PDF stores one attachment per name: only the last copy of each is embedded.`);
      }
      const missing = requested.filter((name) => !carried.some((a) => a.name === name));
      if (missing.length > 0) {
        warnings.push(`${missing.map((name) => `"${name}"`).join(', ')} is not in the saved file, so it is not among the attachments the recipient will see.`);
      }
      return {
        kind: 'pdf' as const,
        bytes,
        pages: input.doc.getPageCount(),
        message: `Embedded ${added.length} new file(s)${replaced.length > 0 ? ` and replaced ${replaced.length} already stored under the same name(s)` : ''}. The document now carries ${carried.length} attachment(s)${had > 0 ? `, up from ${had}` : ''}. Readers with an attachments panel will list them.`,
        warnings,
      };
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
    promise: 'Every embedded file out of the PDF, each under its own name — one file when there is one, a ZIP when there are several.',
    actionLabel: 'Extract attachments',
    notes: [
      'A PDF with no embedded files returns a report saying so rather than an empty archive.',
      'The files are written out byte for byte, so a protected document still opens and a corrupted enclosure stays corrupted.',
    ],
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
        [{ blob: single, name: found.length === 1 ? (found[0].filename ?? found[0].name) : `${downloadStem(input.name)}-attachments.zip` }],
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
    keywords: ['remove attachment', 'manage embedded', 'package', 'enclosed files'],
    outputSuffix: '_attachments.pdf',
    promise: 'The attachments listed with their sizes, and only the ones you name deleted — a name that is not there is reported, not ignored.',
    actionLabel: 'Remove attachments',
    notes: [
      'Deleting an attachment is permanent in the output copy: an enclosure that was the only version of that file is gone.',
    ],
    fields: [
      { key: 'remove', label: 'Names to remove', type: 'textarea', group: 'Attachments', placeholder: 'One attachment name per line', help: 'Copy the names from the list this tool shows first. Leaving the box empty is a request to look, not to delete.' },
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
        pages: input.doc.getPageCount(),
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
    promise: 'A signature that covers the bytes: change anything afterwards and validation says so. The private key never leaves this tab.',
    actionLabel: 'Sign',
    notes: [
      'Signing proves the document has not changed since. It does not prove the signer is who they claim: that needs a certificate issued by an authority the other side already trusts.',
      'A signature seals the document. Any later edit — flattening, timestamping, even opening and re-saving in some tools — invalidates it, so sign last.',
      'The signature is created in your browser from your own certificate. Certificate revocation checking needs a network connection; everything else is local.',
    ],
    fields: [
      { key: 'certificate', label: 'Certificate (PEM or P12)', type: 'file', accept: '.pem,.crt,.cer,.p12,.pfx', group: 'Your certificate', required: true, help: 'The public half, plus the private key when it is a .p12/.pfx bundle. Nothing is uploaded and nothing is stored afterwards.' },
      { key: 'privateKey', label: 'Private key (PEM)', type: 'file', accept: '.pem,.key', group: 'Your certificate', when: (v) => v.certKind !== 'p12', help: 'Needed when the certificate is a bare .pem. The key is read once, to sign, and then dropped.' },
      { key: 'passphrase', label: 'Key / PKCS#12 passphrase', type: 'password', group: 'Your certificate', placeholder: 'Only if the key or bundle is encrypted', help: 'Only needed when the key or bundle is encrypted. It is used once to sign and then dropped.' },
      { key: 'reason', label: 'Reason', type: 'text', default: 'I approve this document', half: true, group: 'What the signature says', help: 'Stored inside the signature, so it is part of what a validator reports and cannot be quietly reworded later.' },
      { key: 'location', label: 'Location', type: 'text', half: true, group: 'What the signature says', placeholder: 'Where you signed', help: 'Stored inside the signature, so it is part of what a validator reports.' },
      { key: 'contact', label: 'Contact', type: 'text', group: 'What the signature says', placeholder: 'How to reach you about this', help: 'How a recipient reaches you about this signature. Readers show it in the signature panel.' },
      { key: 'visible', label: 'Show a visible signature block', type: 'toggle', default: true, group: 'Mark on the page', help: 'Off signs the document invisibly: it still validates, but nobody can see that it was signed.' },
      { key: 'page', label: 'Signature page', type: 'number', default: 1, min: 1, max: 5000, step: 1, integer: true, group: 'Mark on the page', when: (v) => v.visible === true, help: 'Counted in the document you dropped in; a page past the end is refused before the key is used.' },
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
        // `signDocument` saves this same document and fills the `/ByteRange`
        // placeholder in place: the signature adds a field, never a page.
        pages: input.doc.getPageCount(),
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
    promise: 'Whether each signature still matches these bytes, who signed, and what an empty signature field really means.',
    actionLabel: 'Validate signatures',
    notes: [
      'Intact means the signed bytes are unchanged. The certificate chain is not validated and revocation cannot be checked offline, so this does not tell you the signer is trusted.',
      'An empty signature field proves nothing: it is a box somebody prepared and never signed.',
    ],
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
    promise: 'A third-party stamp proving the signature existed at a stated moment, so it outlives the certificate that made it.',
    actionLabel: 'Add timestamp',
    notes: [
      'The timestamp covers the signature, not the whole document, and the authority address is the only thing sent over the network: a digest of the signature, never the pages.',
      'This tool refuses an unsigned file rather than producing a timestamp on nothing.',
    ],
    fields: [
      {
        key: 'tsa',
        label: 'Timestamp authority URL',
        type: 'text',
        default: 'http://timestamp.digicert.com',
        group: 'Authority',
        required: true,
        pattern: '^https?://',
        help: 'The only step that needs the network: the timestamp token comes from a trusted third party. Prefer an https address, since the digest travels.',
      },
      { key: 'fieldName', label: 'Signature field to stamp', type: 'text', group: 'Authority', placeholder: 'The only signature, if left blank', help: 'Needed when a document carries more than one signature and only one of them should be stamped.' },
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
        pages: input.doc.getPageCount(),
        message: `Timestamped at ${result.attestedAt.toISOString()} by ${result.authority}.`,
        warnings: [`The timestamp covers the signature, not the document: it proves the signature existed at ${result.attestedAt.toISOString()}, and ${tsaUrl} is the one address this app sends a digest to.`],
      };
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

/** Region captured by the redaction surface, in the space of the *displayed* page. */
interface RedactionRegion {
  /** 0-based page index. */
  page: number;
  /**
   * Top-left corner in points on the page as the editor shows it: origin
   * top-left, `/Rotate` applied, so on a quarter-turned sheet `width` runs
   * along the displayed long edge. `redact-pdf` turns each mark back into
   * unrotated user space before deleting anything.
   */
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Redaction proof — read the words back, do not infer them            *
 * ------------------------------------------------------------------ */

/** The frame a page's displayed coordinates are measured against. */
function frameOf(page: PDFPage): PageFrame {
  const box = cropBox(page);
  return {
    x0: box.x,
    y0: box.y,
    width: box.width,
    height: box.height,
    rotation: normaliseRotation(page.getRotation().angle),
  };
}

/** One word, with its box in the displayed page's space. */
interface MarkWord {
  word: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The words of one extracted run, with a box each.
 *
 * pdf.js hands back a run per styling change, which is often a whole line. A
 * run is split on whitespace and its box shared out by character position: the
 * mark/word overlap only decides which words are *candidates* for verification,
 * so an approximate box widens the sample without ever letting a redaction pass
 * a word it did not delete.
 */
function wordsOfRun(item: ExtractedTextItem): MarkWord[] {
  const text = item.str ?? '';
  if (text.trim() === '') return [];
  const boxWidth = Math.abs(item.w) || 1;
  const height = Math.abs(item.h) || 1;
  const out: MarkWord[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index / text.length;
    const end = (match.index + match[0].length) / text.length;
    out.push({
      word: match[0],
      x: item.x + start * boxWidth,
      y: item.y,
      width: (end - start) * boxWidth,
      height,
    });
  }
  return out;
}

/** Whether the centre of a word box falls inside one marked area. */
function underMark(word: MarkWord, marks: { page: number; x: number; y: number; width: number; height: number }[], page: number): boolean {
  const cx = word.x + word.width / 2;
  const cy = word.y + word.height / 2;
  return marks.some((mark) =>
    mark.page === page
    && cx >= Math.min(mark.x, mark.x + mark.width) && cx <= Math.max(mark.x, mark.x + mark.width)
    && cy >= Math.min(mark.y, mark.y + mark.height) && cy <= Math.max(mark.y, mark.y + mark.height),
  );
}

/**
 * What a PDF reader can still extract from the pages the marks cover.
 *
 * `unique` is the useful half: words that sit under a mark and nowhere else on
 * that page. Those are the words the user meant to destroy, so their presence in
 * the saved file is a redaction that only looks like one, and their absence is
 * the proof the fill is covering deleted text rather than hiding live text.
 */
async function readMarkedWords(
  bytes: Uint8Array,
  password: string | undefined,
  marks: RedactionRegion[],
): Promise<{ ok: boolean; detail?: string; all: string[]; under: string[]; unique: string[] }> {
  const empty = { ok: false, detail: undefined as string | undefined, all: [] as string[], under: [] as string[], unique: [] as string[] };
  if (marks.length === 0) return { ...empty, ok: true };
  let session;
  try {
    session = await openRender(bytes, password ? { password } : {});
  } catch (error) {
    return { ...empty, detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    const all = new Set<string>();
    const under = new Set<string>();
    const elsewhere = new Set<string>();
    const pages = [...new Set(marks.map((mark) => mark.page))];
    for (const page of pages) {
      if (!Number.isInteger(page) || page < 0 || page >= session.numPages) continue;
      for (const item of await session.textItems(page + 1)) {
        for (const word of wordsOfRun(item)) {
          all.add(word.word);
          if (underMark(word, marks, page)) under.add(word.word);
          else elsewhere.add(word.word);
        }
      }
    }
    return {
      ok: true,
      all: [...all],
      under: [...under],
      unique: [...under].filter((word) => !elsewhere.has(word)),
    };
  } catch (error) {
    return { ...empty, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await session.destroy();
  }
}

/**
 * Delete `terms` from every bookmark title, in place.
 *
 * An outline entry is a string the reader searches, so a title carrying a
 * redacted name leaks it back. The tree is rewritten through the same model the
 * bookmarks tool uses, which keeps destinations, nesting and styling.
 *
 * @returns how many titles changed.
 */
function scrubOutlineTitles(doc: PDFDocument, terms: readonly string[]): number {
  const wanted = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (wanted.length === 0) return 0;
  const pattern = new RegExp(`\\b(?:${wanted.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  const nodes = readOutline(doc);
  if (nodes.length === 0) return 0;
  let changed = 0;
  const scrub = (list: OutlineNode[]): OutlineNode[] => list.map((node) => {
    const title = node.title.replace(pattern, '').replace(/\s+/g, ' ').trim();
    if (title !== node.title) changed += 1;
    return { ...node, title: title === '' ? '[redacted]' : title, children: node.children ? scrub(node.children) : undefined };
  });
  const next = scrub(nodes);
  if (changed > 0) writeOutline(doc, next);
  return changed;
}

/** A short, quoted list for a warning that has to name what it found. */
function previewList(words: readonly string[], limit = 6): string {
  const shown = words.slice(0, limit).map((word) => `“${word}”`).join(', ');
  return words.length > limit ? `${shown}, and ${words.length - limit} more` : shown;
}

/** `['a','b','c']` → `a, b and c`, for a sentence that has to read as English. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Stores a redaction cannot rewrite that still carry one of the redacted words.
 *
 * `redact-pdf` deletes glyphs from page content and, when asked, scrubs the
 * `/Info` strings, the XMP packet and the outline. Annotation text and the bytes
 * of an embedded file are neither: a name blacked out on the page but living on
 * in a comment popover or in `enclosure.zip` has not been redacted, so the
 * warning has to say that in particular rather than lean on the generic caveat.
 */
function redactedWordsStillHeld(doc: PDFDocument, terms: readonly string[]): string[] {
  const wanted = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const pattern = new RegExp(`\\b(?:${wanted.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
  const holds = (value: string | undefined): boolean => value !== undefined && pattern.test(value);
  const found: string[] = [];
  const comments = listAnnotations(doc).filter((mark) => holds(mark.contents)).length;
  if (comments > 0) found.push(`${comments} comment${comments === 1 ? '' : 's'}`);
  const files = listAttachments(doc).filter((file) =>
    holds(file.name) || holds(file.description) || holds(latin1.decode(file.bytes)),
  ).length;
  if (files > 0) found.push(`${files} embedded file${files === 1 ? '' : 's'}`);
  return found;
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

/* ------------------------------------------------------------------ *
 * The reader's point of view — what an independent engine can do      *
 * ------------------------------------------------------------------ */

/**
 * How this app's own rendering engine (pdf.js) answered when asked to open a
 * file. `protect`, `unlock` and the restriction tools report this, not the
 * options they were handed: a password gate nobody else can pass is not
 * protection, and a file that still demands a password is not unlocked (E4/E5).
 */
type ReaderVerdict = 'opens' | 'needs-password' | 'wrong-password' | 'unreadable' | 'unavailable';

interface ReaderProbe {
  verdict: ReaderVerdict;
  /** Pages the reader counted, when it got that far. */
  pages: number;
  /** Text of the sampled pages, in page order, when it could read them. */
  text: string[];
  detail?: string;
}

/** Pages sampled by `probeReader`: enough to prove content survived, bounded for E7. */
function sampledPages(total: number): number[] {
  const picks = [...new Set([1, Math.ceil(total / 2), total])];
  return picks.filter((page) => page >= 1 && page <= total);
}

async function probeReader(bytes: Uint8Array, password?: string): Promise<ReaderProbe> {
  let session;
  try {
    session = await openRender(bytes, password ? { password } : {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const named = error instanceof Error ? error.name : '';
    if (named !== 'PasswordRequiredError' && !/password/i.test(message)) {
      return { verdict: 'unavailable', pages: 0, text: [], detail: message };
    }
    return {
      verdict: /not correct/i.test(message) ? 'wrong-password' : 'needs-password',
      pages: 0,
      text: [],
      detail: message,
    };
  }
  try {
    const text: string[] = [];
    for (const page of sampledPages(session.numPages)) {
      text.push((await session.textItems(page)).map((item) => item.str).join(' '));
    }
    return { verdict: 'opens', pages: session.numPages, text };
  } catch (error) {
    return {
      verdict: 'unreadable',
      pages: session.numPages,
      text: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await session.destroy();
  }
}

/**
 * Save `doc` with no `/Encrypt` entry, page tree and all.
 *
 * Protection lives in the trailer and in the dictionary it points at, so
 * dropping both is the whole removal — and it is the only removal that keeps the
 * form fields, comments, bookmarks and embedded files a page-tree rebuild
 * leaves behind. The rebuild stays as the fallback for a file this does not
 * clear; the caller verifies which one it got.
 */
async function saveUnprotected(doc: PDFDocument): Promise<Uint8Array> {
  const entry = doc.context.trailerInfo.Encrypt;
  if (entry instanceof PDFRef) doc.context.delete(entry);
  doc.context.trailerInfo.Encrypt = undefined;
  return savePDF(doc, { useObjectStreams: true });
}

/**
 * A document opened however the file allows: with the password when it has one,
 * and without demanding one when the guard already read the file on the empty
 * password. `openPDF` refuses any `/Encrypt` entry it is not given a password
 * for, which used to make `unlock` answer "this PDF is password protected" for a
 * restricted-but-openable file — the exact case the tool exists for (E4/E5).
 */
async function openForStripping(input: OpenedInput, password: string): Promise<PDFDocument> {
  if (password) return openPDF(input.bytes, { password });
  if (input.inspection?.opensWithEmptyPassword) return input.doc;
  return openPDF(input.bytes, { password: '', ignoreEncryption: true });
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
 * The parts of a document a page-tree rebuild is known to leave behind.
 *
 * `countStructure` measures them, `missingStructure` turns a difference into the
 * sentence a result has to carry.
 */
interface StructureCounts {
  fields: number;
  annotations: number;
  bookmarks: number;
  attachments: number;
}

/** What a saved file still carries that a reader can edit or select. */
interface LiveMarks {
  /** Entries in `AcroForm /Fields`. */
  fields: number;
  /** Annotation objects reachable from a page, of any subtype. */
  marks: number;
  /** The `/Link` subset of `marks`. */
  links: number;
}

/**
 * Count the live fields and annotations in bytes that were just written.
 *
 * Flattening is the operation whose success is invisible from the document a run
 * mutated: an appearance that could not be drawn leaves its annotation exactly
 * where it was. Re-reading the output is the only way to tell "baked" from
 * "attempted", and it is what stops a result promising a page the reader can no
 * longer type into.
 */
async function liveMarks(bytes: Uint8Array): Promise<LiveMarks> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  let marks = 0;
  let links = 0;
  for (const page of doc.getPages()) {
    const annots = arrayAt(doc, page.node.get(PDFName.of('Annots')));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index++) {
      const annotation = dictAt(doc, annots.get(index));
      if (!annotation) continue;
      marks += 1;
      const subtype = annotation.get(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.asString() === '/Link') links += 1;
    }
  }
  return { fields: formFieldCount(doc), marks, links };
}

/**
 * What one document holds of the four kinds a rebuild is known to lose.
 *
 * The tools that drop protection used to rebuild the page tree — the only way
 * they knew to clear the trailer's `/Encrypt` entry — and hand back a file
 * missing its form fields, comments, bookmarks or embedded files. Losing a
 * filled-in form while "just" removing a password is the silent failure this
 * measurement exists to prevent (E13).
 */
function countStructure(doc: PDFDocument): StructureCounts {
  return {
    fields: formFieldCount(doc),
    annotations: annotationCount(doc),
    bookmarks: readOutline(doc).length,
    attachments: listAttachments(doc).length,
  };
}

const STRUCTURE_LABELS: [keyof StructureCounts, (count: number) => string][] = [
  ['fields', (n) => `${n} form field(s)`],
  ['annotations', (n) => `${n} annotation(s) / comment(s)`],
  ['bookmarks', (n) => `${n} bookmark(s)`],
  ['attachments', (n) => `${n} embedded file(s)`],
];

/** The parts of `before` that `after` no longer carries, phrased for a warning. */
function missingStructure(before: StructureCounts, after: StructureCounts): string[] {
  return STRUCTURE_LABELS
    .map(([key, label]) => ({ key, label, gone: before[key] - after[key] }))
    .filter((entry) => entry.gone > 0)
    .map((entry) => entry.label(entry.gone));
}

/** What the file still holds, as a clause for the result message. */
function structureSentence(counts: StructureCounts): string {
  const held = STRUCTURE_LABELS
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => label(counts[key]));
  return held.length > 0 ? held.join(', ') : 'no form fields, comments, bookmarks or embedded files';
}

/** The text a reader gets from a file, or `null` when it cannot read it. */
async function sourceTextOf(bytes: Uint8Array, password: string): Promise<string[] | null> {
  const probe = await probeReader(bytes, password || undefined);
  return probe.verdict === 'opens' ? probe.text : null;
}

interface StripResult {
  bytes: Uint8Array;
  pages: number;
  kept: StructureCounts;
  contentKept: boolean;
  rebuilt: boolean;
  warnings: string[];
}

/**
 * Remove the protection from `doc` and prove it from the saved bytes.
 *
 * The trailer's `/Encrypt` entry *is* protection, so dropping it and saving is
 * both the removal and the cheap one: the page tree, the AcroForm, the
 * annotations, the outline and the embedded files are untouched. The page-tree
 * rebuild is kept as the fallback for a file that still reports itself encrypted
 * afterwards, and the result says which path ran.
 *
 * Four facts are then re-read from the output rather than assumed: the
 * encryption flag and page count (through the same guard the file queue uses),
 * the structure counts, and — where a reader can be started at all — whether it
 * opens the copy with no password and still extracts the text it extracted from
 * the source. A file whose streams really are ciphertext loses its content when
 * the dictionary goes, and that is named instead of shipped quietly (E5).
 */
async function stripProtectionFrom(
  input: OpenedInput,
  doc: PDFDocument,
  sourceText: string[] | null,
): Promise<StripResult> {
  const source = countStructure(doc);
  const sourceContent = contentFingerprint(doc);
  let bytes = await saveUnprotected(doc);
  let inspection = await inspectPdf(bytes, input.name);
  let rebuilt = false;
  if (inspection.encrypted) {
    const cleared = await rebuildDocument(doc);
    bytes = await savePDF(cleared, { useObjectStreams: true });
    inspection = await inspectPdf(bytes, input.name);
    rebuilt = true;
  }
  if (inspection.encrypted) {
    throw new Error('The saved copy still carries an /Encrypt entry and would ask for a password, so it was not returned.');
  }
  if (inspection.pages !== doc.getPageCount()) {
    throw new Error(`The saved copy has ${inspection.pages} of the ${doc.getPageCount()} pages the source has, so it was not returned.`);
  }
  const output = await PDFDocument.load(bytes, { updateMetadata: false });
  const kept = countStructure(output);
  const warnings: string[] = [];
  const lost = missingStructure(source, kept);
  if (lost.length > 0) {
    warnings.push(rebuilt
      ? `Dropping the protection had to copy the pages into a fresh document, so ${lost.join(', ')} did not carry over.`
      : `${lost.join(', ')} present in the source are missing from the copy that was unlocked, so check it before relying on it.`);
  }
  const contentKept = contentFingerprint(output) === sourceContent;
  if (!contentKept) {
    warnings.push('Some page content read differently once the password was removed, so check the copy before relying on it.');
  }
  const reader = await probeReader(bytes);
  if (reader.verdict === 'unavailable' || reader.verdict === 'unreadable') {
    warnings.push(`No PDF reader could be started in this browser to re-open the unlocked copy${reader.detail ? ` (${reader.detail})` : ''}; its /Encrypt entry was confirmed gone, but the pages were only checked with the built-in engine.`);
  } else if (reader.verdict !== 'opens') {
    warnings.push(`A PDF reader still will not open the saved copy without a password (${reader.detail ?? reader.verdict}), so this file is not free of its protection yet.`);
  } else if (reader.pages !== inspection.pages) {
    warnings.push(`A PDF reader counts ${reader.pages} page(s) in the saved copy where the engine that wrote it counts ${inspection.pages}.`);
  } else if (sourceText && sourceText.join('\n') !== reader.text.join('\n')) {
    warnings.push('A PDF reader extracts different text from the unlocked copy than it could read from the protected one: the page content was stored as ciphertext this browser cannot decrypt, so check the copy before relying on it.');
  }
  return { bytes, pages: inspection.pages, kept, contentKept, rebuilt, warnings };
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
 * Which stores outside the page still hold text at all.
 *
 * This is the *other text* inventory — the caveat that a redaction rewrites page
 * content, `/Info`, the XMP packet and bookmark titles, and nothing else. Whether
 * a **redacted** word specifically survived in a comment or an enclosure is
 * `redactedWordsStillHeld`'s question, and the two are reported as separate
 * sentences because only one of them is a leak (E13, E20).
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
 * The crypt filter an encryption revision requires (ISO 32000-1 §7.6.2, Table 30).
 *
 * RC4 needs no `/CF` entry at all — `/V 1` and `/V 2` mean RC4 with the key length
 * read from `/Length` — which is why the older revisions answer `undefined`.
 */
function requiredCryptFilter(revision: number): 'AESV3' | 'AESV2' | undefined {
  if (revision >= 5) return 'AESV3';
  if (revision === 4) return 'AESV2';
  return undefined;
}

/** The encryption dictionary itself, whether the trailer inlines it or points at it. */
function encryptDictOf(doc: PDFDocument): PDFDict | undefined {
  const entry = doc.context.trailerInfo.Encrypt;
  if (entry instanceof PDFDict) return entry;
  return entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFDict) : undefined;
}

/** Every `/CFM` name the file's crypt filter dictionary declares. */
function cryptFilterNames(doc: PDFDocument): string[] {
  const filters = encryptDictOf(doc)?.lookupMaybe(PDFName.of('CF'), PDFDict);
  if (!filters) return [];
  const names: string[] = [];
  for (const [, value] of filters.entries()) {
    const filter = value instanceof PDFRef ? doc.context.lookupMaybe(value, PDFDict) : value;
    if (!(filter instanceof PDFDict)) continue;
    const name = filter.lookupMaybe(PDFName.of('CFM'), PDFName)?.decodeText();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Where the encryption dictionary disagrees with itself about the cipher.
 *
 * `/V` and `/R` are what this app's guard reads to name a cipher, while a reader
 * that follows the crypt filter dictionary obeys `/CFM` instead — and the engine
 * in this browser writes `/V 5 /R 6 /Length 256` beside `/CFM /AESV2`, a 128-bit
 * AES filter. One label, two strengths, and the file is the only place the truth
 * can be checked (E5, E13).
 */
function cryptFilterMismatch(doc: PDFDocument, cipherLabel: string): string | null {
  const dict = encryptDictOf(doc);
  if (!dict) return null;
  const revision = dict.lookupMaybe(PDFName.of('V'), PDFNumber)?.asNumber();
  if (revision === undefined) return null;
  const expected = requiredCryptFilter(revision);
  const names = [...new Set(cryptFilterNames(doc))];
  const quoted = names.map((name) => `/${name}`).join(', ');
  if (expected === undefined) {
    return names.length > 0 && names.some((name) => name !== 'RC4')
      ? `/V ${revision} means RC4, but the file also declares a crypt filter of ${quoted}; a reader that follows /CFM will not use RC4.`
      : null;
  }
  if (names.length === 0) {
    return `/V ${revision} declares ${expected === 'AESV3' ? 'AES-256' : 'AES-128'}, but the file carries no /CF crypt filter, so a reader that needs /CFM has nothing to obey.`;
  }
  const wrong = names.filter((name) => name !== expected);
  if (wrong.length === 0) return null;
  return `/V and /R record ${cipherLabel}, but the file's own crypt filter declares ${wrong.map((name) => `/${name}`).join(', ')} — ${wrong.length === 1 && wrong[0] === 'AESV2' ? 'a 128-bit AES filter' : 'a different cipher'}. Readers split on which half they obey, so this copy does not carry ${cipherLabel} everywhere.`;
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
      warnings.push(opensFreely
        ? 'The page content came out of the engine unchanged, so the restrictions are recorded in the file but the text inside it was not rewritten as ciphertext. This file opens on the empty password and a tool that ignores /Encrypt can read the page just as easily.'
        : 'The page content came out of the engine unchanged, so the password and restrictions are recorded in the file but the text inside it was not rewritten as ciphertext. Readers will prompt for the password; a tool that ignores /Encrypt can still read the page.');
    }
    const filterMismatch = cryptFilterMismatch(written, cipherLabel);
    if (filterMismatch) warnings.push(filterMismatch);
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
