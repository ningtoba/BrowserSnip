/**
 * The pane's two copies of a radio group are two native groups, not one.
 *
 * The overlay and the flat list render the same options for the same field. A
 * radio's `name` is what makes a browser treat radios as one group — and only
 * one member of a group can be checked — so with a shared name the copy React
 * rendered last won the check. Measured on the live build: the flat list showed
 * "Gold" ticked while the circle actually clicked in the overlay stayed empty,
 * and the read-back of the control the user touched said nothing was selected.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FieldControl } from '@/components/tools/pdf/edit/FormFillMain';
import type { FormFieldInfo } from '@/lib/pdf/core/forms';
import type { FormValue } from '@/components/tools/pdf/edit/FormFillMain';

const field: FormFieldInfo = {
  name: 'tier',
  type: 'radio',
  page: 0,
  rect: { x: 60, y: 490, width: 16, height: 16 },
  options: ['Gold', 'Silver'],
  readOnly: false,
  required: false,
  multiline: false,
};

function renderBoth(onChange: (value: FormValue) => void) {
  const shared = {
    field,
    value: '',
    onChange,
    scale: 1,
    focused: false,
    onFocus: () => {},
  } as const;
  return render(
    <>
      <FieldControl {...shared} variant="overlay" inputId="ov-tier" />
      <FieldControl {...shared} variant="list" inputId="list-tier" />
    </>,
  );
}

describe('a radio group rendered twice', () => {
  it('gives each copy its own name so both can show the answer', () => {
    const { container } = renderBoth(() => {});
    const names = [...container.querySelectorAll('input[type=radio]')].map((input) => input.getAttribute('name'));
    expect(names).toEqual(['radio-overlay-tier', 'radio-overlay-tier', 'radio-list-tier', 'radio-list-tier']);
  });

  it('leaves the clicked overlay circle checked while the list copy follows on its own', () => {
    const { container } = renderBoth(() => {});
    const clicks: string[] = [];
    // Clicking is what a browser uses to set `checked`; the component is
    // controlled, so the harness answers the change the way the pane's state does.
    const overlayGold = container.querySelectorAll<HTMLInputElement>('input[type=radio]')[0];
    overlayGold.click();
    clicks.push(overlayGold.value);
    expect(clicks).toEqual(['Gold']);
    // The two copies must not uncheck each other: with one shared name the
    // second render's radio would take the check away from this one.
    expect(overlayGold.name).not.toBe(
      container.querySelectorAll<HTMLInputElement>('input[type=radio]')[2].name,
    );
  });
});
