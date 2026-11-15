/**
 * A textarea sized for what it holds.
 *
 * The bookmark outline is one entry per line and the whole content of that card,
 * and it opened four rows high: typed 40 entries, the fifth line was cut through
 * the middle of its glyphs and the rest was behind a scrollbar
 * (`docs/research/bookmarks-round.md`, shot `edges-forty-typed.png`). The field
 * contract now carries a `rows` hint, and a field that does not ask for one keeps
 * the old four — which is the control: this is a per-field size, not a new default.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { FieldControl } from '@/components/tools/pdf/shared/FieldControls';

describe('a textarea field', () => {
  it('opens as tall as the field asks', () => {
    const outline = getPdfTool('bookmarks')!.fields!.find((field) => field.key === 'outline')!;
    expect(outline.type).toBe('textarea');
    expect(outline.rows).toBe(12);
    const { container } = render(createElement(FieldControl, {
      field: outline,
      values: { outline: 'Chapter 1\n  Section 1.1' },
      onChange: () => {},
    }));
    expect(container.querySelector('textarea')!.rows).toBe(12);
  });

  it('keeps the four-row default for a field that does not ask', () => {
    const plain = { key: 'note', label: 'Note', type: 'textarea' } as const;
    const { container } = render(createElement(FieldControl, {
      field: plain,
      values: { note: 'x' },
      onChange: () => {},
    }));
    expect(container.querySelector('textarea')!.rows).toBe(4);
  });
});
