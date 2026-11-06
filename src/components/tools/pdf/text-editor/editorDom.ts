/**
 * The editing surface's DOM bridge.
 *
 * `TextEditor.tsx` shows one paragraph in a `contentEditable` box. This module
 * builds that box from the model's styled runs and reads it back. Both directions
 * use `createElement` + `textContent`, never an HTML string, so a document whose
 * text is `<img src=x onerror=…>` renders as those literal characters instead of
 * executing anything in the page's own origin.
 */
import {
  paragraphsFromDom,
  resolveRun,
  type DocParagraph,
  type DomNode,
  type EditorStyle,
  type Run,
} from './model';

/** Replace `root`'s children with the block's rich text. */
export function mountParagraphs(root: HTMLElement, paragraphs: DocParagraph[], base: EditorStyle): void {
  root.replaceChildren();
  for (const paragraph of paragraphs) {
    const block = document.createElement('div');
    block.dataset.paragraph = '1';
    const style = { ...base, ...paragraph.style };
    block.style.textAlign = style.align;
    const indent = Math.max(0, style.indent) + paragraph.listLevel * 14;
    if (indent > 0) block.style.marginLeft = `${indent}pt`;
    if (base.firstLineIndent !== 0) block.style.textIndent = `${base.firstLineIndent}pt`;
    if (paragraph.runs.length === 0 || paragraph.runs.every((run) => run.text.length === 0)) {
      block.append(document.createElement('br'));
    }
    for (const run of paragraph.runs) block.append(runElement(run, style));
    root.append(block);
  }
}

function runElement(run: Run, base: EditorStyle): HTMLElement {
  let node: HTMLElement = document.createElement('span');
  node.textContent = run.text;
  const style = resolveRun(run, base);
  const inline: string[] = [];
  if (style.color !== base.color) {
    inline.push(`color:${style.color}`);
    node.dataset.color = style.color;
  }
  if (style.size !== base.size) {
    inline.push(`font-size:${style.size}pt`);
    node.dataset.size = String(style.size);
  }
  if (inline.length > 0) node.setAttribute('style', inline.join(';'));
  const decorations = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean);
  if (decorations.length > 0) {
    const wrapper = document.createElement('u');
    wrapper.style.textDecorationLine = decorations.join(' ') as DecorationValue;
    wrapper.append(node);
    node = wrapper;
  }
  if (style.superscript || style.subscript) {
    const shift = document.createElement(style.superscript ? 'sup' : 'sub');
    shift.append(node);
    node = shift;
  }
  if (style.italic) {
    const wrapper = document.createElement('i');
    wrapper.append(node);
    node = wrapper;
  }
  if (style.bold) {
    const wrapper = document.createElement('b');
    wrapper.append(node);
    node = wrapper;
  }
  return node;
}

/** Read the box back into styled paragraphs. */
export function readParagraphs(root: HTMLElement): DocParagraph[] {
  return paragraphsFromDom(Array.from(root.childNodes).map(toDomNode).filter((node): node is DomNode => node !== null));
}

function toDomNode(node: Node): DomNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return text.length > 0 ? { tag: '#text', text } : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const view = window.getComputedStyle(element);
  const decoration = view.textDecorationLine ?? '';
  const sizeAttribute = element.dataset.size;
  const childNodes = Array.from(element.childNodes).map(toDomNode).filter((child): child is DomNode => child !== null);
  // Unknown markup (a paste from anywhere) is walked, never dropped, so no word
  // can disappear just because the editor does not model its tag. Formatting is
  // read from the tag first and the computed style second: a browser reports the
  // same thing either way, and a headless DOM is more reliable about tags.
  return {
    tag,
    bold: ['b', 'strong'].includes(tag) || Number(view.fontWeight) >= 600,
    italic: ['i', 'em'].includes(tag) || view.fontStyle === 'italic',
    underline: tag === 'u' || decoration.includes('underline'),
    strike: ['s', 'strike', 'del'].includes(tag) || decoration.includes('line-through'),
    superscript: tag === 'sup',
    subscript: tag === 'sub',
    color: element.dataset.color ?? (element.dataset.size !== undefined ? rgbToHex(view.color) : undefined),
    size: sizeAttribute ? Number(sizeAttribute) : undefined,
    align: alignOf(view.textAlign),
    indent: element.style.marginLeft ? pointsOf(view.marginLeft) : undefined,
    list: tag === 'li' ? 'bullet' : undefined,
    children: childNodes,
  };
}

function alignOf(value: string): DomNode['align'] {
  if (value === 'center' || value === 'right' || value === 'justify') return value;
  // A paragraph div with no explicit alignment reports `start`.
  return value === 'start' || value === 'left' ? 'left' : 'left';
}

/** CSS lengths come back in the unit they were written in; the model speaks points. */
function pointsOf(cssLength: string): number {
  const value = Number.parseFloat(cssLength);
  if (!Number.isFinite(value)) return 0;
  if (cssLength.trim().toLowerCase().endsWith('px')) return value * 0.75;
  return value;
}

function rgbToHex(value: string): string | undefined {
  const parts = value.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return undefined;
  const [r, g, b] = parts.map(Number);
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** The CSS `text-decoration-line` values this module ever writes. */
type DecorationValue = 'underline' | 'line-through' | 'underline line-through';
