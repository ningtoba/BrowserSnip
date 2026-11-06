/**
 * Tools whose control surface is a bespoke React panel rather than a generated
 * form: they draw on the page, so they own both the sidebar and the main pane.
 *
 * These ids existed before the registry was introduced, and they are the ones a
 * returning visitor or a saved bookmark is most likely to use, so they stay
 * registered here even though their interaction is not expressible as a field
 * list. Their `run` is intentionally absent: the panel drives
 * `usePDFEngine`/`useProcessStore` directly, and `runPdfTool` refuses with that
 * explanation rather than producing a file the pane never asked for.
 *
 * Because the generated rail cannot describe them, the honesty has to live in
 * the definition: `promise` says what pressing the button gets you, and `notes`
 * say what the pane will *not* do — the same contract the field-driven tools get
 * from their validators.
 */
import type { PdfToolDefinition } from './types';

export const legacyTools: PdfToolDefinition[] = [
  {
    id: 'sign',
    name: 'Sign PDF',
    description: 'Draw, type or upload a signature and place it on any page',
    icon: '✍️',
    category: 'security',
    keywords: ['signature', 'initials', 'draw', 'sign document'],
    surface: 'custom',
    outputSuffix: '_signed.pdf',
    actionLabel: 'Place signature',
    promise: 'Your mark, placed where you drop it, drawn into the page in this tab.',
    notes: [
      'This places a visual signature: the picture or typed name is drawn onto the page. It is not a cryptographic signature — a later edit leaves no trace. "Digital sign PDF" adds a PKCS#7 signature that does.',
      'Nothing is uploaded; the document never leaves this tab.',
    ],
  },
  {
    id: 'pdf-crop',
    name: 'Crop PDF',
    description: 'Drag a crop rectangle or type exact margins in points, mm or inches',
    icon: '✂️',
    category: 'edit',
    keywords: ['trim margins', 'cut edges', 'bounds', 'mediabox'],
    surface: 'custom',
    outputSuffix: '_cropped.pdf',
    actionLabel: 'Crop',
    promise: 'The page shows only the rectangle you keep, on every page you select.',
    notes: [
      'Cropping sets the page’s visible box. Ink outside it is hidden, not deleted: the file barely shrinks, and text you cropped away can still be extracted. Use redaction to remove content for good.',
      'Margins are applied per page in the page’s own units, so mixed page sizes each keep their own geometry.',
    ],
  },
  {
    id: 'scan-to-pdf',
    name: 'Scan to PDF',
    description: 'Capture pages with your camera and build one clean PDF from them',
    icon: '📸',
    category: 'organize',
    // The pane fills the page from the camera or from photos picked off disk, so
    // a PDF must never be demanded of it — the shared gate would answer
    // "that is not a PDF" to the very files this tool takes (E2).
    inputKind: 'image',
    accept: '.jpg,.jpeg,.png,.webp,.heic,.heif,image/*',
    keywords: ['camera', 'document scanner', 'edge detection', 'perspective'],
    surface: 'custom',
    outputSuffix: '_scan.pdf',
    actionLabel: 'Generate PDF',
    promise: 'One PDF from the pages you capture, each page a picture of the paper.',
    notes: [
      'Camera access is requested only when you start a scan; frames never leave the tab.',
      'Captures are photographs: each page is an image with no text layer, so the result cannot be searched or selected until you run OCR on it.',
      'This pane does not find the edges of the paper or correct perspective. It straightens tones (greyscale plus contrast) when enhancement is on; crop the page or re-shoot if the document fills too little of the frame.',
    ],
  },
  {
    id: 'compare',
    name: 'Compare PDFs',
    description: 'View two PDFs side by side and highlight every difference',
    icon: '🔍',
    category: 'security',
    keywords: ['diff', 'changes', 'versions', 'redline'],
    multiFile: true,
    minFiles: 2,
    maxFiles: 2,
    surface: 'custom',
    outputSuffix: '_comparison.pdf',
    actionLabel: 'Compare',
    promise: 'Both files rendered side by side, with the pixels that differ marked up.',
    notes: [
      'Differences are found by rendering each page and comparing pixels at your sensitivity setting, not by reading text: a reflowed paragraph counts as a change and a swapped-in synonym may not.',
      'Only the pages both files have are compared. If one document is shorter, the extra pages are reported and left out of the result.',
      'Both PDFs are opened in this tab; nothing is uploaded.',
    ],
  },
];
