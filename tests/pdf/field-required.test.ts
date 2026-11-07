/**
 * A required field that names itself (worker: protect's undiscoverable password).
 *
 * `protect` asks for an open password through a tool-level `validate`, so the
 * sentence appeared under the primary action while three password boxes sat in the
 * panel with nothing marking which one was meant — measured in a real browser, the
 * CTA stayed disabled after a caller typed into the first box. A field now carries
 * its own requirement, optionally per-state, plus the imperative sentence to show.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { validateFields } from '@/lib/pdf/core/guard';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { FieldControl } from '@/components/tools/pdf/shared/FieldControls';
import type { ToolValues } from '@/lib/pdf/tools/types';

const empty: ToolValues = { userPassword: '', ownerPassword: '' };

describe('a required field', () => {
  const protect = getPdfTool('protect')!;
  const open = protect.fields!.find((f) => f.key === 'userPassword')!;
  const owner = protect.fields!.find((f) => f.key === 'ownerPassword')!;

  it('is refused on the box itself, in the tool’s own words', () => {
    const issues = validateFields(protect.fields, { ...empty, mode: 'user' });
    const hit = issues.find((i) => i.key === 'userPassword');
    expect(hit?.message).toMatch(/password readers must type/i);
    expect(hit?.code).toBe('REQUIRED');
    // The default sentence ("<label> is required.") is a status report; this tool
    // says what to type, which is the part that made the field findable.
    expect(hit?.message).not.toBe('Open password is required.');
  });

  it('is not demanded while the field is hidden', () => {
    // mode 'owner' hides the open password, so it must not block the run (E18).
    expect(validateFields(protect.fields, { ...empty, mode: 'owner' })
      .some((i) => i.key === 'userPassword')).toBe(false);
  });

  it('can be required only in one state', () => {
    const demanded = owner.required as (v: ToolValues) => boolean;
    expect(demanded({ mode: 'owner' })).toBe(true);
    expect(demanded({ mode: 'both' })).toBe(false);
    expect(validateFields(protect.fields, { ...empty, mode: 'owner' })
      .find((i) => i.key === 'ownerPassword')?.message).toMatch(/owner password/i);
    expect(validateFields(protect.fields, { ...empty, mode: 'both' })
      .some((i) => i.key === 'ownerPassword')).toBe(false);
  });

  it('falls back to the plain sentence when a tool gives no wording', () => {
    const issues = validateFields(
      [{ key: 'word', label: 'Keyword', type: 'text', required: true }],
      { word: '   ' },
    );
    expect(issues[0].message).toBe('Keyword is required.');
  });

  it('does not invent a requirement from a predicate that throws', () => {
    // A field the form cannot reason about must not silently block the run.
    const fields = [{
      key: 'word',
      label: 'Keyword',
      type: 'text' as const,
      required: () => {
        throw new Error('half-filled state');
      },
    }];
    expect(validateFields(fields, { word: '' })).toEqual([]);
  });
});

/**
 * The message only helps if the person who cannot see it hears it. A red line
 * under a box is decoration to a screen reader focused on that box, so the
 * association has to exist in the DOM, not just in the layout.
 */
describe('a field message is bound to its control', () => {
  const password = { key: 'userPassword', label: 'Open password', type: 'password' } as const;
  const values = { userPassword: '' };

  it('points the input at the sentence that explains it', () => {
    const { container } = render(createElement(FieldControl, {
      field: password,
      values,
      onChange: () => {},
      issue: 'Enter the password readers must type to open this PDF.',
    }));
    const input = container.querySelector('input')!;
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBe('tool-field-userPassword-issue');
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/readers must type/i);
  });

  it('lists both the notice and the issue when a field has two', () => {
    const { container } = render(createElement(FieldControl, {
      field: password,
      values,
      onChange: () => {},
      notice: 'The rebuild kept every page.',
      issue: 'Enter the password readers must type to open this PDF.',
    }));
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual([
      'tool-field-userPassword-notice',
      'tool-field-userPassword-issue',
    ]);
    expect(document.getElementById('tool-field-userPassword-notice')).not.toBeNull();
  });

  it('says nothing about a description it did not render', () => {
    const { container } = render(createElement(FieldControl, {
      field: password,
      values,
      onChange: () => {},
    }));
    // A dangling aria-describedby is worse than none: it announces an empty id.
    expect(container.querySelector('input')!.getAttribute('aria-describedby')).toBeNull();
  });
});
