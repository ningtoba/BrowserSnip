/**
 * Registry integrity.
 *
 * The registry is now the single source of truth for the whole PDF surface: the
 * dashboard cards, the sidebar form, the route table and the download filename
 * all derive from it. A mistake here is invisible to `tsc` — a duplicated id
 * silently shadows a tool, and a tool with neither `run` nor a custom pane
 * renders an empty page — so the invariants are asserted instead.
 */
import { describe, expect, it } from 'vitest';
import { PDF_CATEGORIES, PDF_TOOLS, getPdfTool, hasCustomMainView, mainViewFor, searchTools, suffixFor } from '@/lib/pdf/tools/registry';
import { TOOLS, TOOL_CATEGORIES } from '@/lib/constants';

const CATEGORIES = PDF_CATEGORIES.map((category) => category.id);

describe('pdf tool registry', () => {
  it('has no duplicate ids', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const tool of PDF_TOOLS) {
      if (seen.has(tool.id)) clashes.push(`${tool.id} (${seen.get(tool.id)} and ${tool.category})`);
      else seen.set(tool.id, tool.category);
    }
    expect(clashes).toEqual([]);
  });

  it('keeps every id lower-case kebab so routes are stable', () => {
    const bad = PDF_TOOLS.filter((tool) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.id)).map((tool) => tool.id);
    expect(bad).toEqual([]);
  });

  it('puts every tool in a category that the dashboard renders', () => {
    const orphans = PDF_TOOLS.filter((tool) => !CATEGORIES.includes(tool.category)).map((tool) => tool.id);
    expect(orphans).toEqual([]);
  });

  it('gives every tool a way to produce output', () => {
    const dead = PDF_TOOLS.filter(
      (tool) => !tool.run && !tool.mainComponent && !hasCustomMainView(tool.id) && tool.id !== 'edit-pdf' && tool.id !== 'edit-pdf-text',
    ).map((tool) => tool.id);
    expect(dead).toEqual([]);
  });

  it('names every tool with a description users would recognise', () => {
    const thin = PDF_TOOLS.filter(
      (tool) => tool.description.trim().split(/\s+/).length < 4 || tool.name.trim().length === 0 || !tool.icon,
    ).map((tool) => tool.id);
    expect(thin).toEqual([]);
  });

  it('declares a download suffix for every tool', () => {
    const missing = PDF_TOOLS.filter((tool) => !tool.outputSuffix).map((tool) => tool.id);
    expect(missing).toEqual([]);
  });

  it('names suffixes so a download always has a usable filename', () => {
    // Either a fragment appended to the stem (`_merged.pdf`, `_images`) or a
    // whole extension replacing it (`.zip`). Underscores and a leading dash are
    // both used by the catalogue.
    const shape = /^[._-]?[a-z0-9_-]+(?:\.[a-z0-9]+)?$/i;
    const bad = PDF_TOOLS.filter((tool) => !shape.test(tool.outputSuffix)).map(
      (tool) => `${tool.id}:${tool.outputSuffix}`,
    );
    expect(bad).toEqual([]);
  });

  it('resolves multi-file tools to a sane file count', () => {
    const broken = PDF_TOOLS.filter(
      (tool) => tool.minFiles !== undefined && tool.maxFiles !== undefined && tool.minFiles > tool.maxFiles,
    ).map((tool) => tool.id);
    expect(broken).toEqual([]);
    const singles = PDF_TOOLS.filter((tool) => (tool.minFiles ?? 1) > 1 && !tool.multiFile).map((tool) => tool.id);
    expect(singles).toEqual([]);
  });

  it('only declares engines that the provider knows', () => {
    const known = new Set(['pymupdf', 'ghostscript', 'cpdf']);
    const unknown = PDF_TOOLS.flatMap((tool) => tool.engines ?? []).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('points every declared field at a unique key', () => {
    for (const tool of PDF_TOOLS) {
      const keys = (tool.fields ?? []).map((field) => field.key);
      expect(new Set(keys).size, `${tool.id} has duplicate field keys`).toBe(keys.length);
    }
  });

  it('exposes the full catalogue through the dashboard registry', () => {
    // Every PDF id must appear in TOOLS, otherwise the card never renders and
    // the route answers "Tool not found".
    const dashboardIds = new Set(TOOLS.filter((tool) => tool.category !== 'video').map((tool) => tool.id));
    const missing = PDF_TOOLS.map((tool) => tool.id).filter((id) => !dashboardIds.has(id));
    expect(missing).toEqual([]);
    expect(dashboardIds.size).toBe(PDF_TOOLS.length);
  });

  it('gives each PDF category a heading, an icon and a blurb', () => {
    for (const category of PDF_CATEGORIES) {
      expect(category.label).toBeTruthy();
      expect(category.icon).toBeTruthy();
      expect(category.blurb).toBeTruthy();
      expect(TOOL_CATEGORIES.some((entry) => entry.id === category.id)).toBe(true);
      expect(PDF_TOOLS.filter((tool) => tool.category === category.id).length).toBeGreaterThan(0);
    }
  });

  it('looks tools up by id and rejects unknown ones', () => {
    expect(getPdfTool('merge')?.name).toMatch(/merge/i);
    expect(getPdfTool('no-such-tool')).toBeUndefined();
    expect(getPdfTool(undefined)).toBeUndefined();
  });

  it('suffixes output names with an extension for every single-PDF tool', () => {
    // A tool that returns `{ kind: 'pdf' }` relies on the suffix for its
    // extension, so those must end in `.pdf`. Tools that emit their own named
    // files (images, csv, zip) are allowed a bare fragment.
    const multiFileTools = new Set(['bates-numbering', 'pdfs-to-zip', 'extract-images', 'extract-attachments']);
    const barePdf = PDF_TOOLS.filter((tool) => {
      if (!tool.run || tool.id === 'split') return false;
      // Any suffix that already carries an extension names a usable file.
      if (/\.[a-z0-9]+$/i.test(tool.outputSuffix)) return false;
      // Report-style tools have no primary download at all.
      if (tool.surface === 'none' && tool.outputSuffix.endsWith('.txt')) return false;
      return !multiFileTools.has(tool.id) && !tool.id.startsWith('pdf-to-');
    }).map((tool) => `${tool.id}:${tool.outputSuffix}`);
    expect(barePdf).toEqual([]);
    expect(suffixFor('merge')).toBe('_merged.pdf');
    expect(suffixFor('no-such-tool')).toBe('_processed.pdf');
  });

  it('finds tools by keyword and by category label', () => {
    expect(searchTools('booklet').map((tool) => tool.id)).toContain('booklet');
    expect(searchTools('AES').length).toBeGreaterThan(0);
    expect(searchTools('').length).toBe(PDF_TOOLS.length);
    expect(searchTools('zzzz-nothing')).toEqual([]);
  });

  it('loads the bespoke editors lazily', () => {
    // A main view must be registered for each editor surface, or the route
    // renders the generic viewer with no way to annotate.
    for (const id of ['organize', 'edit-pdf', 'form-filler', 'form-creator', 'sign', 'pdf-crop', 'scan-to-pdf', 'compare']) {
      expect(mainViewFor(id), `${id} has no main view`).toBeTruthy();
    }
  });
});
