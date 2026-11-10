/**
 * The inert-field census for the whole catalogue: which rail fields does the
 * tool's OWN output path read?
 *
 * Report-only — nothing here is fixed, and the two pinned lists below are the
 * schedule (`docs/research/inert-field-sweep.md` holds the reading). Run with
 * `npx vitest run tests/pdf/inert-field-sweep.test.ts`.
 *
 * A field counts as READ when its key reaches the values bag inside the tool's
 * `run` body — either spelled there (`numberValue(values, 'opacity')`), named by a
 * field constant (`numberOf(context.values, OPACITY, notes)`), or spelled inside a
 * function the run calls, one level deep (`selection(values, …)` reads `pages`,
 * `layoutOptions(context)` reads `pageSize`/`margin`/`font`). Anything else is a
 * control whose value the file never sees.
 *
 * `pane` marks the other failure mode: the definition declares the field, but the
 * id answers on a hand-written surface that owns its own state, so the rail value
 * is never rendered and the pane's copy is what runs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_CATALOGUE, hasCustomMainView } from '@/lib/pdf/tools/registry';
import type { PdfToolDefinition, ToolField } from '@/lib/pdf/tools/types';

const CHOICE_TYPES = ['select', 'toggle', 'segmented', 'multiselect'];
const VALUE_TYPES = [...CHOICE_TYPES, 'slider', 'number', 'pages'];

function sources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk('src');
  return out;
}

/** `const NAME: ToolField = { key: 'x' }`, and the shared field factories. */
const FACTORY_KEYS: Record<string, string> = {
  pagesField: 'pages',
  pageSizeField: 'pageSize',
  marginField: 'margin',
  orientationField: 'orientation',
  qualityField: 'quality',
};

function constantsIn(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(/const ([A-Z][A-Z0-9_]*)[^=;]*=\s*\{[\s\S]{0,400}?key:\s*'([^']+)'/g)) {
    out.set(match[1]!, match[2]!);
  }
  for (const match of source.matchAll(/const ([A-Z][A-Z0-9_]*)[^=;]*=\s*([A-Za-z]+)\(/g)) {
    const key = FACTORY_KEYS[match[2]!];
    if (key && !out.has(match[1]!)) out.set(match[1]!, key);
  }
  return out;
}

/** The source of every named function/const-arrow in the tree, by name. */
function definitions(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const text of files.values()) {
    for (const match of text.matchAll(/(?:function|const|let)\s+([A-Za-z][A-Za-z0-9_]*)/g)) {
      const name = match[1]!;
      // The body starts at the first `{` after the header's closing paren or `=>`.
      const header = text.indexOf('(', (match.index ?? 0) + match[0].length);
      const arrow = text.indexOf('=>', (match.index ?? 0) + match[0].length);
      let from = -1;
      if (header >= 0 && (arrow < 0 || header < arrow)) {
        let depth = 0;
        for (let at = header; at < text.length; at++) {
          if (text[at] === '(') depth++;
          else if (text[at] === ')') {
            depth--;
            if (depth === 0) { from = at; break; }
          }
        }
      } else if (arrow >= 0) {
        from = arrow;
      }
      if (from < 0) continue;
      // A window, not a brace match: the return-type annotation carries braces of
      // its own, and this is a heuristic sweep, not a parser.
      const body = text.slice(from, from + 1500);
      if (!out.has(name) || out.get(name)!.length < body.length) out.set(name, body);
    }
  }
  return out;
}

/** Text from an opening brace to its match. */
function sliceBraced(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '{') depth++;
    else if (text[at] === '}') {
      depth--;
      if (depth === 0) return text.slice(open, at + 1);
    }
  }
  return text.slice(open, open + 2000);
}

/** A run body plus every function it reaches, transitively. */
function closure(run: string, defs: Map<string, string>): string {
  const seen = new Set<string>();
  let text = run;
  let queue = [run];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const next: string[] = [];
    for (const match of current.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      const body = defs.get(name);
      if (!body) continue;
      next.push(body);
    }
    text += '\n' + next.join('\n');
    queue.push(...next);
  }
  return text;
}

/** One tool definition's source, from its `id:` to the next definition. */
function blockOf(source: string, tool: PdfToolDefinition): string {
  const start = source.indexOf(`id: '${tool.id}'`);
  if (start < 0) return '';
  const rest = source.slice(start);
  const next = rest.search(/\n {2}\{\n {4}id: '/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('inert-field sweep', () => {
  it('lists every choice/number field whose value does not reach its own run', () => {
    const files = sources();
    const defs = definitions(files);
    const moduleOf = new Map<string, string>();
    for (const text of files.values()) {
      for (const tool of TOOL_CATALOGUE) {
        if (text.includes(`id: '${tool.id}'`) && !moduleOf.has(tool.id)) moduleOf.set(tool.id, text);
      }
    }

    const dead: string[] = [];
    const paneOwned: string[] = [];
    let choice = 0;
    let valueFields = 0;
    for (const tool of TOOL_CATALOGUE) {
      const source = moduleOf.get(tool.id);
      if (!source) continue;
      const block = blockOf(source, tool);
      const runAt = block.indexOf('async run(');
      const run = runAt < 0 ? '' : block.slice(runAt);
      const consts = constantsIn(source);
      // Everything the run reaches, transitively: a field read three helpers
      // down still reaches the output, and one read by no callee does not.
      const path = closure(run, defs);
      const bespoke = hasCustomMainView(tool.id) || tool.surface === 'custom' || Boolean(tool.mainComponent);
      for (const field of (tool.fields ?? []) as ToolField[]) {
        if (!VALUE_TYPES.includes(field.type)) continue;
        valueFields += 1;
        if (CHOICE_TYPES.includes(field.type)) choice += 1;
        const quoted = `'${field.key}'`;
        const names = [...consts.entries()].filter(([, key]) => key === field.key).map(([name]) => name);
        const property = new RegExp(`values\\.${field.key}\\b`).test(path);
        const read = path.includes(quoted) || property || names.some((name) => new RegExp(`\\b${name}\\b`).test(path));
        if (read) continue;
        const line = `${tool.id}.${field.key} (${field.type}, "${field.label}")${bespoke ? ' [pane]' : ''}`;
        (bespoke ? paneOwned : dead).push(line);
      }
    }
    process.stdout.write(
      `\nFIELDS CHECKED ${valueFields} (choice/toggle ${choice}); unreached ${dead.length + paneOwned.length}`
      + ` = ${dead.length} on generated rails + ${paneOwned.length} on pane-owned surfaces\n`,
    );
    // Pin the census: a NEW key here is a control whose value never reaches the
    // bytes, which is the defect class this sweep exists to catch. Each entry is a
    // scheduled item, not a fixed one — see docs/research/inert-field-sweep.md.
    expect(dead.sort()).toEqual([
      'pdf-to-json.tables (toggle, "Detect tables")',
    ]);
    expect(paneOwned.sort()).toEqual([]);
    process.stdout.write(`\nUNREACHED ON A GENERATED RAIL:\n${dead.map((l) => '  ' + l).join('\n')}\n`);
    process.stdout.write(`\nPANE-OWNED SURFACE (the rail is not rendered; the pane's own state runs):\n${paneOwned.map((l) => '  ' + l).join('\n')}\n`);
    expect(valueFields).toBeGreaterThan(100);
  });
});

/**
 * Second question: how many declared fields belong to a tool whose rail is never
 * mounted, because a hand-written pane owns that surface?
 */
describe('pane-owned surface class', () => {
  it('counts the fields a visitor cannot reach on a bespoke id', () => {
    const workspace = readFileSync('src/components/layout/ToolWorkspace.tsx', 'utf8');
    const registry = readFileSync('src/lib/pdf/tools/registry.ts', 'utf8');
    const paneIds = new Set<string>([
      ...[...workspace.matchAll(/^\s*'([a-z0-9-]+)':\s*lazyPanel/gm)].map((m) => m[1]!),
      ...[...registry.matchAll(/^\s*'([a-z0-9-]+)':\s*lazy\(/gm)].map((m) => m[1]!),
    ]);
    const rows: string[] = [];
    let total = 0;
    for (const tool of TOOL_CATALOGUE) {
      if (!paneIds.has(tool.id)) continue;
      const fields = (tool.fields ?? []) as ToolField[];
      if (fields.length === 0) continue;
      total += fields.length;
      rows.push(`  ${tool.id}: ${fields.length} declared field(s) — ${fields.map((f) => `${f.key}(${f.type})`).join(', ')}`);
    }
    // Which of those declared fields can the pane actually move? A key the pane
    // never mentions is stuck at its declared default: the rail is not mounted, so
    // nothing but the pane can write it.
    const components = [...sources().entries()].filter(([path]) => path.startsWith('src/components'));
    const stuck: string[] = [];
    for (const tool of TOOL_CATALOGUE) {
      if (!paneIds.has(tool.id)) continue;
      const panes = components.filter(([, text]) => text.includes(`usePdfTool('${tool.id}')`) || text.includes(`usePdfTool('${tool.id.replace('-pdf', '')}')`));
      if (panes.length === 0) continue;
      const paneText = panes.map(([, text]) => text).join('\n');
      for (const field of (tool.fields ?? []) as ToolField[]) {
        if (!VALUE_TYPES.includes(field.type)) continue;
        const mentioned = paneText.includes(`'${field.key}'`) || paneText.includes(field.key);
        if (!mentioned) stuck.push(`  ${tool.id}.${field.key} (${field.type}, "${field.label}") — pane ${panes.map(([path]) => path.split('/').pop()).join(', ')} never writes it`);
      }
    }
    process.stdout.write(`\nPANE-OWNED IDS WITH DECLARED FIELDS: ${rows.length}, declaring ${total} fields\n${rows.join('\n')}\n`);
    process.stdout.write(`\nSTUCK AT THE DECLARED DEFAULT ON A PANE SURFACE: ${stuck.length}\n${stuck.join('\n')}\n`);
    expect(total).toBeGreaterThan(0);
  });
});
