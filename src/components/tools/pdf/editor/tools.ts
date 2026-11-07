/**
 * The annotation palette: what each tool is called, how it gathers geometry,
 * which PDF annotation subtype it produces, and the appearance it starts with.
 *
 * The order of `TOOLS` is the order of the palette grid; `select` is rendered
 * apart from the creating tools but lives in the same table so a tool id always
 * resolves to exactly one description.
 */
import type { EditorToolId, ToolMeta, ToolStyle } from './types';

/** Built-in stamp names. Written verbatim to `/S`, so no spaces (PDF names). */
export const BUILT_IN_STAMPS: { value: string; label: string }[] = [
  { value: 'Approved', label: 'Approved' },
  { value: 'NotApproved', label: 'Not approved' },
  { value: 'AsIs', label: 'As is' },
  { value: 'Confidential', label: 'Confidential' },
  { value: 'Draft', label: 'Draft' },
  { value: 'Experimental', label: 'Experimental' },
  { value: 'Expired', label: 'Expired' },
  { value: 'Final', label: 'Final' },
  { value: 'NotForPublicRelease', label: 'Not for public release' },
  { value: 'Sold', label: 'Sold' },
  { value: 'TopSecret', label: 'Top secret' },
  { value: 'Void', label: 'Void' },
];

/** Quick colour choices, echoing the highlighter palette people expect. */
export const SWATCHES: string[] = [
  '#FFEB3B',
  '#FF9800',
  '#E91E63',
  '#DC2626',
  '#8B5CF6',
  '#2563EB',
  '#059669',
  '#1B1B18',
  '#FFFFFF',
];

const style = (over: Partial<ToolStyle> = {}): ToolStyle => ({
  color: '#FFEB3B',
  fillColor: '#FFFFFF',
  filled: false,
  strokeWidth: 1.5,
  opacity: 1,
  fontSize: 12,
  stampName: 'Approved',
  ...over,
});

/** Default appearance per tool — the starting point of the per-style state. */
export function defaultStyleFor(tool: EditorToolId): ToolStyle {
  switch (tool) {
    case 'highlight':
      return style({ color: '#FFEB3B', opacity: 0.4 });
    case 'underline':
      return style({ color: '#1B1B18', strokeWidth: 1 });
    case 'strike':
      return style({ color: '#DC2626', strokeWidth: 1 });
    case 'note':
      return style({ color: '#FFF3A3', opacity: 1 });
    case 'freetext':
      return style({ color: '#1B1B18', fillColor: '#FFFFFF', filled: true, strokeWidth: 0.8, fontSize: 12 });
    case 'ink':
      return style({ color: '#DC2626', strokeWidth: 2.25 });
    case 'square':
    case 'circle':
      return style({ color: '#2563EB', fillColor: '#2563EB', filled: false, strokeWidth: 2 });
    case 'line':
      return style({ color: '#1B1B18', strokeWidth: 1.5 });
    case 'arrow':
      return style({ color: '#DC2626', strokeWidth: 2 });
    case 'polygon':
    case 'polyline':
      return style({ color: '#059669', fillColor: '#059669', filled: false, strokeWidth: 2 });
    case 'stamp':
      return style({ color: '#AA0000', opacity: 0.85, stampName: 'Approved' });
    case 'image':
    case 'signature':
      return style({ color: '#1B1B18', opacity: 1 });
    case 'link':
      return style({ color: '#2563EB', strokeWidth: 1 });
    case 'redact':
      return style({ color: '#000000', filled: true, opacity: 1 });
    case 'select':
    default:
      return style({ color: '#1B1B18' });
  }
}

/** Every palette entry in display order. */
export const TOOLS: ToolMeta[] = [
  {
    id: 'select',
    label: 'Select',
    icon: '🖱️',
    hint: 'Click a mark to select it, drag to move it, Delete removes it.',
    gesture: 'none',
    kind: 'Popup',
  },
  {
    id: 'highlight',
    label: 'Highlight',
    icon: '🖍️',
    hint: 'Drag across the words — the mark snaps to each text line it crosses.',
    gesture: 'markup',
    kind: 'Highlight',
  },
  {
    id: 'underline',
    label: 'Underline',
    icon: 'U',
    hint: 'Drag across text; the underline follows the snapped text line.',
    gesture: 'markup',
    kind: 'Underline',
  },
  {
    id: 'strike',
    label: 'Strike out',
    icon: 'S',
    hint: 'Drag across text to strike the lines you touch.',
    gesture: 'markup',
    kind: 'StrikeOut',
  },
  {
    id: 'note',
    label: 'Note',
    icon: '📌',
    hint: 'Click to drop a sticky note, then type its comment.',
    gesture: 'box',
    kind: 'Text',
  },
  {
    id: 'freetext',
    label: 'Text box',
    icon: 'T',
    hint: 'Drag a box (or click for a default one) and type into it.',
    gesture: 'box',
    kind: 'FreeText',
  },
  {
    id: 'ink',
    label: 'Pen',
    icon: '✏️',
    hint: 'Draw freehand on the page.',
    gesture: 'path',
    kind: 'Ink',
  },
  {
    id: 'square',
    label: 'Rectangle',
    icon: '⬜',
    hint: 'Drag a rectangle. Toggle Fill for a solid shape.',
    gesture: 'box',
    kind: 'Square',
  },
  {
    id: 'circle',
    label: 'Ellipse',
    icon: '⭕',
    hint: 'Drag an ellipse. Toggle Fill for a solid shape.',
    gesture: 'box',
    kind: 'Circle',
  },
  {
    id: 'line',
    label: 'Line',
    icon: '📏',
    hint: 'Drag from one point to another.',
    gesture: 'segment',
    kind: 'Line',
  },
  {
    id: 'arrow',
    label: 'Arrow',
    icon: '↗',
    hint: 'Drag in the direction the arrow should point.',
    gesture: 'segment',
    kind: 'Arrow',
  },
  {
    id: 'polygon',
    label: 'Shape',
    icon: '🔷',
    hint: 'Click corners, then press Enter or double-click to close the shape.',
    gesture: 'vertices',
    kind: 'Polygon',
  },
  {
    id: 'polyline',
    label: 'Freeform',
    icon: '〰️',
    hint: 'Click points, then press Enter or double-click to finish the line.',
    gesture: 'vertices',
    kind: 'PolyLine',
  },
  {
    id: 'stamp',
    label: 'Stamp',
    icon: '💮',
    hint: 'Pick a stamp below, then click or drag where it should land.',
    gesture: 'place',
    kind: 'Stamp',
  },
  {
    id: 'image',
    label: 'Image',
    icon: '🖼️',
    hint: 'Click where it should go, choose a PNG or JPEG, and it lands on that spot.',
    gesture: 'place',
    kind: 'Stamp',
  },
  {
    id: 'signature',
    label: 'Signature',
    icon: '✍️',
    hint: 'Click where it should go, draw it in the pad, and it lands on that spot.',
    gesture: 'place',
    kind: 'Stamp',
  },
  {
    id: 'link',
    label: 'Link',
    icon: '🔗',
    hint: 'Drag the clickable area, then choose a page or a URL.',
    gesture: 'box',
    kind: 'Link',
  },
  {
    id: 'redact',
    label: 'Redact',
    icon: '⬛',
    hint: 'Drag over text to remove it permanently on export.',
    gesture: 'box',
    kind: 'Redact',
  },
];

/** Whether this tool puts something on the page, as opposed to editing it. */
export function isPlacementTool(tool: EditorToolId): boolean {
  return TOOL_BY_ID[tool]?.gesture !== 'none';
}

/**
 * The tool the palette holds when a gesture ends. One rule, no pin: a created
 * mark hands control back to Select, so the next click moves or edits the thing
 * the user just made; a gesture that created nothing leaves the pen in the
 * hand, because losing the tool after a failed drag reads as the app ignoring
 * them.
 *
 * The rule is a function rather than a line in a click handler so the palette,
 * the drag path and the tests cannot each have their own opinion about it.
 */
export function toolAfterGesture(tool: EditorToolId, created: boolean): EditorToolId {
  return created ? 'select' : tool;
}

/** The sentence the footer says about that rule, once, instead of per tool. */
export const AFTER_CREATE_NOTE = 'After one placement the tool hands control back to Select.';

/**
 * Inspector sections for the palette.
 *
 * Eighteen buttons in one grid is a wall; six named groups is a tool chest. The
 * ids are also what the quick-mode chips preselect (`panel: 'markup'`), so a
 * group name is a public-ish string, not a layout detail. `paletteIsGrouped`
 * keeps the promise that every tool appears in exactly one group.
 */
export interface ToolGroup {
  id: string;
  label: string;
  tools: EditorToolId[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'markup', label: 'Read and mark up', tools: ['select', 'highlight', 'underline', 'strike'] },
  { id: 'words', label: 'Words', tools: ['note', 'freetext'] },
  { id: 'draw', label: 'Freehand', tools: ['ink', 'line', 'arrow', 'polygon', 'polyline'] },
  { id: 'shapes', label: 'Shapes', tools: ['square', 'circle'] },
  { id: 'place', label: 'Stamps, images, signatures', tools: ['stamp', 'image', 'signature'] },
  { id: 'page', label: 'Page edits', tools: ['link', 'redact'] },
];

export function toolGroupById(id: string | null | undefined): ToolGroup | undefined {
  if (!id) return undefined;
  return TOOL_GROUPS.find((group) => group.id === id);
}

export const TOOL_BY_ID: Record<EditorToolId, ToolMeta> = TOOLS.reduce(
  (acc, meta) => {
    acc[meta.id] = meta;
    return acc;
  },
  {} as Record<EditorToolId, ToolMeta>,
);

/** Which group a tool belongs to, for opening the right inspector section. */
export const GROUP_FOR_TOOL: Record<EditorToolId, string> = TOOL_GROUPS.reduce(
  (acc, group) => {
    for (const tool of group.tools) acc[tool] = group.id;
    return acc;
  },
  {} as Record<EditorToolId, string>,
);

export function toolsOfGroup(group: ToolGroup): ToolMeta[] {
  return group.tools.map((id) => TOOL_BY_ID[id]).filter(Boolean);
}

/** Every palette entry in exactly one group, and every group entry in the palette. */
export function paletteIsGrouped(): boolean {
  const seen = new Set<EditorToolId>();
  for (const group of TOOL_GROUPS) {
    for (const id of group.tools) {
      if (!TOOL_BY_ID[id] || seen.has(id)) return false;
      seen.add(id);
    }
  }
  return seen.size === TOOLS.length;
}

/** Tools whose geometry comes from snapping to real text. */
export const MARKUP_TOOLS: EditorToolId[] = ['highlight', 'underline', 'strike'];

/** Tools that take an interior colour from the Fill toggle. */
export const FILLABLE_TOOLS: EditorToolId[] = ['square', 'circle', 'polygon', 'freetext'];

/** Tools whose stroke width matters. */
export const STROKED_TOOLS: EditorToolId[] = [
  'underline',
  'strike',
  'ink',
  'square',
  'circle',
  'line',
  'arrow',
  'polygon',
  'polyline',
  'freetext',
];

/** Tools that expose a font size. */
export const TEXT_TOOLS: EditorToolId[] = ['freetext', 'note'];

/** Tools whose marks carry editable text and can be re-opened by double-click. */
export const EDITABLE_TEXT_TOOLS: EditorToolId[] = ['freetext', 'note'];
