/**
 * Round 052 rig: `unlock`, driven through the shipped `runPdfTool`.
 *
 * Four cases the card makes a claim about, each saved beside its source so a
 * reader-side census can compare them object for object:
 *
 *   1. a locked file that actually carries structure (annotations, a link, two
 *      form fields with values, an outline, `/PageLabels`, an enclosure, `/Info`)
 *      unlocked with its **user** password — the card says all of that "stays
 *      where it was";
 *   2. the same file unlocked with its **owner** password — the field help says
 *      "Either the user or the owner password works";
 *   3. an owner-only file (`/P` restrictions, empty user secret) with **no**
 *      password typed — the card says "A restricted-but-openable one needs no
 *      password at all";
 *   4. an unencrypted file — the tool must say so rather than rebuild it.
 *
 * The triage fixture is four sheets of ink with none of (1)'s objects, so on it
 * alone three of those sentences cannot be measured at all.
 *
 *   UNLOCK_ROUND_DIR=/tmp/r52 npx vitest run --config docs/research/unlock-round.vitest.config.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { isToolInputError } from '@/lib/pdf/core/guard';

const DIR = process.env.UNLOCK_ROUND_DIR ?? '/tmp/r52';
const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
const USER = 'hunter2';
const OWNER = 'hunter2';

const bytesAt = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
/** The structured fixture lives in the roster; only its copies land in `DIR`. */
const STRUCTURE = join(FIXTURES, 'structure-aes-256-user.pdf');

async function unlock(path: string, password: string, tag: string) {
  const name = path.split('/').pop() as string;
  const outcome = await runPdfTool({
    toolId: 'unlock',
    files: [new File([bytesAt(path) as BlobPart], name, { type: 'application/pdf' })],
    values: password ? { password } : {},
    password: password || undefined,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  const out = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  writeFileSync(join(DIR, `before-${tag}-out.pdf`), out);
  return { out, outcome, tag };
}

describe('unlock cases', () => {
  it('keeps the structure of a locked file, unlocked with the user secret', async () => {
    const { out, outcome, tag } = await unlock(STRUCTURE, USER, 'structure');
    writeFileSync(join(DIR, `before-${tag}.json`), JSON.stringify({
      bytes: out.length, message: outcome.message, warnings: outcome.warnings,
    }, null, 1));
    expect(out.length).toBeGreaterThan(1000);
  }, 180_000);

  it('unlocks with the owner secret too, as the field help promises', async () => {
    const { out, outcome, tag } = await unlock(STRUCTURE, OWNER, 'owner');
    writeFileSync(join(DIR, `before-${tag}.json`), JSON.stringify({
      bytes: out.length, message: outcome.message, warnings: outcome.warnings,
    }, null, 1));
    expect(out.length).toBeGreaterThan(1000);
  }, 180_000);

  it('needs no password on a restricted-but-openable file', async () => {
    const { out, outcome, tag } = await unlock(join(FIXTURES, 'aes-256-owner.pdf'), '', 'openable');
    writeFileSync(join(DIR, `before-${tag}.json`), JSON.stringify({
      bytes: out.length, message: outcome.message, warnings: outcome.warnings,
    }, null, 1));
    expect(out.length).toBeGreaterThan(1000);
  }, 180_000);

  it('says what it can do with 40-bit RC4 and with /R 5', async () => {
    for (const name of ['structure-rc4-40.pdf', 'structure-aes-256-r5.pdf']) {
      const outcome = await runPdfTool({
        toolId: 'unlock',
        files: [new File([bytesAt(join(DIR, name)) as BlobPart], name, { type: 'application/pdf' })],
        values: { password: USER },
        onProgress: () => undefined,
        onLog: () => undefined,
      }).then((value) => value, (error: unknown) => error as Error);
      const record = isToolInputError(outcome)
        ? { refused: true, message: outcome.message }
        : {
          refused: false,
          bytes: (await (outcome as { outputs: { blob: Blob }[] }).outputs[0].blob.arrayBuffer()).byteLength,
          message: (outcome as { message: string }).message,
        };
      writeFileSync(join(DIR, `before-${name}.json`), JSON.stringify(record, null, 1));
      // eslint-disable-next-line no-console
      console.log(name, JSON.stringify(record));
    }
  }, 180_000);

  it('answers an unencrypted file rather than rewriting it', async () => {
    const source = join(FIXTURES, 'plain.pdf');
    const { out, outcome, tag } = await unlock(source, '', 'plain');
    writeFileSync(join(DIR, `before-${tag}.json`), JSON.stringify({
      bytes: out.length, message: outcome.message, warnings: outcome.warnings,
    }, null, 1));
    expect(Buffer.from(out).equals(Buffer.from(bytesAt(source)))).toBe(true);
  }, 180_000);
});
