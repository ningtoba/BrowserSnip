/**
 * What a refused batch *shows* — the screen half of round 071.
 *
 * Two things were measured on the dev build with a real HEIC beside a real JPEG:
 * the HEIC's card painted the browser's torn-image glyph (an `<img>` that failed
 * is still a URL, so the card's own honest placeholder was unreachable for every
 * image input), and the second refused file kept reading "READING" over a
 * "counting pages…" it was never going to answer, because only the first name in
 * the joined sentence was blamed for the run.
 *
 * Both are fired the way the browser fires them: `error` on the element, and a
 * message that quotes both names. The controls keep the *good* file's card on its
 * `<img>` so "placeholder" cannot pass by being the only branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileCards } from '@/components/tools/pdf/shared/FileCards';
import { filesAtFault } from '@/hooks/usePdfTool';
import type { FileRunState } from '@/stores/process-store';

afterEach(cleanup);

function picture(name: string, type = 'image/heic'): File {
  return new File([new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70])], name, { type });
}

function renderCards(files: File[], states: Record<string, FileRunState> = {}) {
  return render(
    <FileCards
      files={files}
      states={states}
      reorderable={false}
      imageInput
      onRemove={() => {}}
      onReorder={() => {}}
    />,
  );
}

describe('a card for a picture this browser cannot open', () => {
  it('falls back to the format placeholder instead of the browser’s torn-image glyph', () => {
    renderCards([picture('real.heic')]);
    const thumb = document.querySelector('[data-card-thumb]') as HTMLElement;
    expect(thumb.tagName).toBe('IMG');
    fireEvent.error(thumb);
    const after = document.querySelector('[data-card-thumb]') as HTMLElement;
    expect(after.tagName).not.toBe('IMG');
    expect(after.getAttribute('data-card-thumb')).toBe('placeholder');
    // The extension is what tells the reader which format to convert *from*.
    expect(after.textContent).toBe('heic');
  });

  it('keeps the picture when it does load, so the placeholder is not the only branch', () => {
    renderCards([picture('photo.jpg', 'image/jpeg')]);
    const thumb = document.querySelector('[data-card-thumb]') as HTMLImageElement;
    fireEvent.load(thumb);
    const after = document.querySelector('[data-card-thumb]') as HTMLImageElement;
    expect(after.tagName).toBe('IMG');
    expect(after.getAttribute('data-card-thumb')).toBe('image');
  });

  it('stops the second refused file as well as the first it quotes', () => {
    const files = [picture('real.heic'), picture('photo.jpg', 'image/jpeg')];
    const message = '"real.heic" could not be decoded: this browser has no decoder for HEIC/HEIF. '
      + '"photo.jpg" is a JPEG image, not a HEIC/HEIF image.';
    const states = Object.fromEntries(
      filesAtFault(files, message).map((f) => [f.name, { percent: 0, error: message }]),
    );
    renderCards(files, states);
    // Both cards blame the run; neither is left reading a count that never came.
    expect(screen.getAllByText('Stopped')).toHaveLength(2);
    expect(screen.queryByText('Reading')).toBeNull();
    expect(screen.getAllByText(/pages unknown/)).toHaveLength(2);
    expect(screen.queryByText(/counting pages/)).toBeNull();
  });

  it('blames only the file the message names, and never a guess among several', () => {
    const files = [picture('a.heic'), picture('b.heic')];
    expect(filesAtFault(files, '"b.heic" could not be decoded').map((f) => f.name)).toEqual(['b.heic']);
    // An unquoted message is answerable only when there is one file to blame.
    expect(filesAtFault(files, 'No readable HEIC image(s) was added.').map((f) => f.name)).toEqual([]);
    expect(filesAtFault([files[0]], 'No readable HEIC image(s) was added.').map((f) => f.name)).toEqual(['a.heic']);
  });
});

describe('the cards instrument itself', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reaches the placeholder through a real error event, not a prop', () => {
    renderCards([picture('real.heic')]);
    const thumb = document.querySelector('[data-card-thumb="image"]') as HTMLImageElement;
    expect(thumb).toBeTruthy();
    fireEvent.error(thumb);
    expect(document.querySelector('[data-card-thumb="placeholder"]')).toBeTruthy();
  });
});
