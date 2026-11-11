/**
 * Name and number trees, walked the way the format allows.
 *
 * ISO 32000-1 §7.9.6 and §7.9.7 give one structure under two names: a tree node is a
 * dictionary holding either a flat array of key/value pairs (`/Names` for a name tree,
 * `/Nums` for a number tree) or a `/Kids` array of nodes of the same shape, and both
 * forms may appear together. The value of a pair is **either the object itself or a
 * reference to it** — pdf-lib always writes a reference, MuPDF writes the object inline,
 * pikepdf and pypdf do both depending on the call.
 *
 * This module exists because three readers in this app need exactly that walk and each
 * used to carry its own: `core/attachments.ts` (embedded files), and in
 * `core/bookmarks.ts` `readOutline` (named destinations) and `readPageLabels` (page
 * numbering). Two of the three wrote a parallel implementation that recognised only the
 * shape this repo's own writer emits, which is the failure
 * `docs/research/foreign-structure-audit.md` measured: a `/Kids` label tree read back as
 * `1, 2, 3` for a file MuPDF labels `i, II, c`, and a named destination behind a
 * reference read as having no page at all.
 *
 * The pairs come back **as stored**, with the value undereferenced, because removal
 * needs to splice the array it came from, and a caller that only ever sees the resolved
 * object cannot tell an inline value from a reference — which is how a file
 * specification written inline by MuPDF used to survive "remove all".
 */
import type { PDFDocument, PDFObject } from '@maxwbh/pdf-lib';
import { PDFArray, PDFDict, PDFName, PDFRef, context } from './doc';

/** One key/value pair, taken from whichever `/Names` or `/Nums` array holds it. */
export interface TreePair {
  /** The key as stored: a string object in a name tree, a number in a number tree. */
  key: PDFObject | undefined;
  /** The value as stored — still a `PDFRef` when the producer wrote one. */
  value: PDFObject | undefined;
  /** The array the pair sits in, so a caller can undo exactly this entry. */
  host: PDFArray;
}

/**
 * Follow one indirection without asking pdf-lib what class the object should be.
 *
 * The fork's `lookupMaybe` throws `UnexpectedObjectTypeError` on a class mismatch
 * rather than answering `undefined`, so asking for a `PDFDict` at a key that holds a
 * stream took the whole listing down with an engine sentence in the user's face. A
 * reader of foreign files asks what something *is* and moves on when it is not what it
 * hoped.
 */
export function followRef(
  doc: PDFDocument,
  value: PDFObject | undefined,
): PDFObject | undefined {
  return value instanceof PDFRef ? context(doc).lookup(value) : value;
}

/** The dictionary at `value`, when that is what it is. */
export function asDict(value: PDFObject | undefined): PDFDict | undefined {
  return value instanceof PDFDict ? value : undefined;
}

/**
 * The dictionary stored at `key` on `owner`, following a reference.
 *
 * Every tree in the format reaches its nodes this way — `/PageLabels`, `/Dests`,
 * `/EmbeddedFiles` — and the value may be the dictionary itself or `12 0 R`, which
 * is the difference this module exists to stop each reader rediscovering.
 */
export function dictAt(
  doc: PDFDocument,
  owner: PDFDict | undefined,
  key: string,
): PDFDict | undefined {
  if (!owner) return undefined;
  return asDict(followRef(doc, owner.get(PDFName.of(key))));
}

/** One dictionary a descent reached, and the path of edges that got there. */
export interface DescentNode {
  /** The dictionary itself. */
  dict: PDFDict;
  /** `''` at the root, then one `<edge>/<name>` step per hop: `Kids/1`, `XObject/Fm0`. */
  via: string;
  /** Hops taken from `root`. */
  depth: number;
}

/** A step a descent may take out of one dictionary. */
export interface DescentEdge {
  /** The name the format gives this edge; it is what shows up in `DescentNode.via`. */
  name: string;
  /** The child **as stored** — a dictionary, or a reference to one. */
  value: PDFObject | undefined;
}

/**
 * Visit a dictionary, then every dictionary `edges` reaches from it, in pre-order.
 *
 * Pre-order — a node before its children, children in edge order — because the
 * callers splice the arrays they were handed and depend on stored order. Each
 * dictionary is visited **once** however many names point at it, which is what
 * ends a cycle (`/A → /B → /A`) rather than hanging the tab; `maxDepth` bounds the
 * work a wide fan-out costs.
 *
 * This is the one descent the readers in this app share. The format hands a walk
 * to a reader through two different-looking edges — a tree node's `/Kids`, a Form
 * XObject's `/Resources` — and both are "follow this reference, read what you find,
 * do not visit it twice, stop at the bound". Writing that rule out twice is how a
 * JavaScript name tree and a resource inventory each came to stop one dictionary
 * short of what the file holds.
 */
export function descend(
  doc: PDFDocument,
  root: PDFDict | undefined,
  edges: (node: DescentNode) => DescentEdge[],
  maxDepth = 32,
): DescentNode[] {
  const visited: DescentNode[] = [];
  if (!root) return visited;
  const seen = new Set<PDFDict>();

  const walk = (node: DescentNode): void => {
    if (seen.has(node.dict) || node.depth > maxDepth) return;
    seen.add(node.dict);
    visited.push(node);
    for (const edge of edges(node)) {
      const dict = asDict(followRef(doc, edge.value));
      if (!dict) continue;
      walk({
        dict,
        via: node.via ? `${node.via}/${edge.name}` : edge.name,
        depth: node.depth + 1,
      });
    }
  };

  walk({ dict: root, via: '', depth: 0 });
  return visited;
}

/**
 * Every pair in a name or number tree, in document order.
 *
 * `/Kids` subtrees are walked recursively, a node's own pairs come before its
 * children's, and a node already visited ends that branch rather than hanging the tab —
 * foreign files have been seen to point a kid back at its own parent.
 */
export function collectTreePairs(
  doc: PDFDocument,
  root: PDFDict | undefined,
  maxDepth = 32,
): TreePair[] {
  const pairs: TreePair[] = [];
  for (const { dict } of descend(doc, root, (node) => kidsOf(doc, node.dict), maxDepth)) {
    // A node's pairs are under `/Names` in a name tree and `/Nums` in a number tree;
    // no producer seen here writes both, and the order below decides nothing because
    // the keys of the two are different object types.
    const entries = arrayAt(doc, dict, 'Names') ?? arrayAt(doc, dict, 'Nums');
    if (!entries) continue;
    for (let i = 0; i + 1 < entries.size(); i += 2) {
      pairs.push({ key: entries.get(i), value: entries.get(i + 1), host: entries });
    }
  }
  return pairs;
}

/** The `/Kids` array of a tree node: the only edge a name or number tree descends. */
function kidsOf(doc: PDFDocument, node: PDFDict): DescentEdge[] {
  const kids = arrayAt(doc, node, 'Kids');
  if (!kids) return [];
  const edges: DescentEdge[] = [];
  for (let i = 0; i < kids.size(); i++) edges.push({ name: `Kids/${i}`, value: kids.get(i) });
  return edges;
}

/** The array stored at `key`, following a reference, or `undefined`. */
function arrayAt(doc: PDFDocument, node: PDFDict, key: string): PDFArray | undefined {
  const value = followRef(doc, node.get(PDFName.of(key)));
  return value instanceof PDFArray ? value : undefined;
}
