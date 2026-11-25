/**
 * The rotate tool's pane tells the truth about the angle.
 *
 * The strip is the only page imagery the rail owns, and it used to paint the
 * file as it stood while the run wrote `source + turn` — on a sheet whose own
 * `/Rotate` is 90 and the 270 chip picked, the tile showed a landscape sheet and
 * the download came back an upright one. The stripe now previews the *sum*, on
 * the picked tiles only, and says the angle it will carry.
 *
 * The rasteriser is mocked at its own boundary (`thumbnails(options.rotateBy)`),
 * because the pixels it makes are pinned by `rotate-preview.test.ts`; here the
 * question is whether the rail asks for the right angle for the right sheet.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { PdfToolPanel } from '@/components/tools/pdf/shared/PdfToolPanel';
import { thumbnails } from '@/lib/pdf/core/render';

/** Page 4 of the fixture carries `/Rotate 90`, as `colour.pdf` does. */
const ROTATIONS = [0, 0, 0, 90];

vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => ({
    numPages: 4,
    fingerprint: 'rotate-pane',
    page: async (n: number) => ({
      rotate: [0, 0, 0, 90][n - 1],
      getViewport: () => ({ width: 420, height: 595, rotation: 0 }),
      cleanup: () => {},
    }),
    renderToCanvas: async () => ({}),
    destroy: async () => {},
  })),
  thumbnails: vi.fn(async (_session: unknown, options: { pages?: number[] }) =>
    (options.pages ?? []).map(() => ''),
  ),
}));

beforeAll(() => {
  // `thumbnails` hands back no URL in this double, and jsdom has no raster, so a
  // tile would sit on its "drawing" state forever without an empty data URL.
  HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
});

afterEach(() => {
  cleanup();
  useFileStore.setState({ file: null, files: [], metadata: null });
  useProcessStore.setState({ phase: 'idle', error: null, errorHint: null, report: null, progress: 0, statusMessage: '' });
  vi.clearAllMocks();
});

/** A four-sheet file, the last one stored at `/Rotate 90`. */
async function rotatedPdf(name = 'colour.pdf'): Promise<File> {
  const { PDFDocument, degrees } = await import('@maxwbh/pdf-lib');
  const doc = await PDFDocument.create();
  for (let index = 0; index < 4; index += 1) {
    const page = doc.addPage([420, 595]);
    if (ROTATIONS[index]) page.setRotation(degrees(ROTATIONS[index]));
  }
  const saved = await doc.save();
  return new File([saved as unknown as BlobPart], name, { type: 'application/pdf' });
}

function load(file: File): void {
  act(() => {
    useFileStore.setState({ file, files: [file], metadata: null });
  });
}

/** Open the options panel, where the pages field and its strip live. */
async function openOptions(): Promise<void> {
  const disclosure = await screen.findByRole('button', { name: /more option/ });
  fireEvent.click(disclosure);
  await screen.findByLabelText('Pages in this file');
}

/** What the last raster request asked for, page by page. */
function askedTurns(): Record<string, number | undefined> {
  const calls = (thumbnails as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const out: Record<string, number | undefined> = {};
  for (const [, options] of calls as [unknown, { pages?: number[]; rotateBy?: number }][]) {
    for (const page of options.pages ?? []) out[String(page)] = options.rotateBy;
  }
  return out;
}

describe('the rotate pane previews the angle it will write', () => {
  it('paints the picked sheet at the sum of its own /Rotate and the chip', async () => {
    load(await rotatedPdf());
    render(<PdfToolPanel toolId="rotate" />);
    await openOptions();

    // The field starts at `all`, so every tile is picked and every tile previews
    // the 90° the run would apply.
    await waitFor(() => expect(askedTurns()['4']).toBe(90));

    fireEvent.click(screen.getByRole('button', { name: 'none' }));
    await waitFor(() => expect(askedTurns()['4']).toBe(0));

    // Picking the stored-90 sheet alone: the tile for page 4 is asked for at 270
    // on top of its own 90, and the angle it will *carry* is on the tile.
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    await waitFor(() => expect(askedTurns()['4']).toBe(90));
    const tile = () => screen.getByRole('button', { name: /^Page 4/ });
    // Its own 90 plus the default 90 chip: the sheet would come out at 180.
    await waitFor(() => expect(tile()).toHaveAttribute('data-turn-to', '180'));

    fireEvent.click(screen.getByRole('button', { name: '270° ←' }));
    await waitFor(() => expect(askedTurns()['4']).toBe(270));
    // 90 + 270 = 360 → 0: the sheet comes back upright, and the tile says so
    // rather than showing the landscape the file holds now.
    await waitFor(() => expect(tile()).toHaveAttribute('data-turn-to', '0'));
    expect(tile()).toHaveAccessibleName('Page 4, turned to 0°');
    // The unpicked sheets are not turned in the picture, because they are not
    // turned in the file.
    expect(askedTurns()['3']).toBe(0);
    expect(screen.getByRole('button', { name: 'Page 3' })).not.toHaveAttribute('data-turn-to');
  });

  it('offers the strip with a footer hint when the selection is empty', async () => {
    load(await rotatedPdf());
    render(<PdfToolPanel toolId="rotate" />);
    await openOptions();

    fireEvent.click(screen.getByRole('button', { name: 'none' }));
    expect(screen.getByText(/pick pages to turn/)).toBeInTheDocument();
  });
});

describe('the rotate rail', () => {
  it('prints each section’s words once', async () => {
    load(await rotatedPdf());
    render(<PdfToolPanel toolId="rotate" />);
    await openOptions();

    // A section with one field whose label is the section's own words printed
    // them twice, one line apart: `ROTATION` over `Rotation`, `PAGES` over `Pages`.
    const exact = (words: string) =>
      screen.getAllByText((_, node) => node?.textContent?.trim() === words && node.children.length === 0);
    expect(exact('Rotation')).toHaveLength(1);
    expect(exact('Pages')).toHaveLength(1);
  });

  it('disables the run over an empty selection and says which pages', async () => {
    load(await rotatedPdf());
    render(<PdfToolPanel toolId="rotate" />);
    await openOptions();

    // Siblings (`extract-pages`, `remove-pages`) refuse before the click; this one
    // left the verb live over nothing and reported the refusal afterwards.
    fireEvent.click(screen.getByRole('button', { name: 'none' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rotate' })).toBeDisabled(),
    );
    expect(screen.getByText(/Choose which pages to rotate\./)).toBeInTheDocument();
  });

  it('says a straightened sheet in the singular', async () => {
    load(await rotatedPdf());
    render(<PdfToolPanel toolId="rotate" />);
    await openOptions();

    fireEvent.click(screen.getByRole('button', { name: 'none' }));
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    fireEvent.click(screen.getByRole('button', { name: '270° ←' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    // "1 of the selected 1 page were" — the verb agreed with nothing, and the
    // second verb of the same sentence agreed with nothing either: the card that
    // dev server 5292 printed read "… was upside-down or sideways before this turn and
    // are now upright." The whole line is pinned now, not the half of it.
    expect(
      await screen.findByText(
        '1 of the selected 1 page was upside-down or sideways before this turn and is now upright.',
      ),
    ).toBeInTheDocument();
  });
});
