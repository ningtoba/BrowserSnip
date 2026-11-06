/**
 * Tools whose control surface is a bespoke React panel rather than a generated
 * form: they draw on the page, so they own both the sidebar and the main pane.
 *
 * These ids existed before the registry was introduced, and they are the ones a
 * returning visitor or a saved bookmark is most likely to use, so they stay
 * registered here even though their interaction is not expressible as a field
 * list. Their `run` is intentionally absent: the panel drives
 * `usePDFEngine`/`useProcessStore` directly.
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
  },
  {
    id: 'scan-to-pdf',
    name: 'Scan to PDF',
    description: 'Capture pages with your camera, auto-detect the edges and correct the perspective',
    icon: '📸',
    category: 'organize',
    keywords: ['camera', 'document scanner', 'edge detection', 'perspective'],
    surface: 'custom',
    outputSuffix: '_scan.pdf',
    notes: ['Camera access is requested only when you start a scan; frames never leave the tab.'],
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
  },
];
