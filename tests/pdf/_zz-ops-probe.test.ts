import { describe, expect, it } from 'vitest';
import { OPS } from 'pdfjs-dist';

describe('ops', () => {
  it('lists operator names', () => {
    const wanted = ['f', 'f*', 'B', 'B*', 'S', 'b', 'b*', 's', 'Do', 'BI', 'sh', 'Tj', 'TJ', "'", '"'];
    const keys = Object.keys(OPS as Record<string, number>);
    process.stderr.write('HAS_MNEMONICS ' + JSON.stringify(wanted.filter((w) => w in (OPS as Record<string, number>))) + '\n');
    process.stderr.write('KEYS ' + JSON.stringify(keys) + '\n');
    expect(keys.length).toBeGreaterThan(10);
  });
});
