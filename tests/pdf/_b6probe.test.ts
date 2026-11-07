/* Scratch probe for the B6 audit — deleted before hand-off. */
import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { extractPageImages } from '@/lib/pdf/core/images-out';

const require = createRequire(import.meta.url);
const WORKER_SRC = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.worker.mjs')).href;
Object.defineProperty(pdfjs.GlobalWorkerOptions, 'workerSrc', {
  configurable: true,
  get: () => WORKER_SRC,
  set: () => undefined,
});

/* minimal canvas shim: putImageData/getImageData over a flat buffer, toBlob -> PNG */
const surfaces = new WeakMap<HTMLCanvasElement, { w: number; h: number; data: Uint8ClampedArray }>();
function surf(canvas: HTMLCanvasElement) {
  const w = Math.max(1, canvas.width | 0);
  const h = Math.max(1, canvas.height | 0);
  let s = surfaces.get(canvas);
  if (!s || s.w !== w || s.h !== h) {
    s = { w, h, data: new Uint8ClampedArray(w * h * 4) };
    surfaces.set(canvas, s);
  }
  return s;
}

function pngBytes(w: number, h: number, data: Uint8ClampedArray): Uint8Array {
  // Stored (uncompressed) deflate for simplicity.
  const stride = w * 4 + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    v.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // zlib header + stored blocks
  const blocks: Uint8Array[] = [];
  const max = 65000;
  for (let at = 0; at < raw.length; at += max) {
    const part = raw.subarray(at, Math.min(raw.length, at + max));
    const head = new Uint8Array(5);
    head[0] = at + max >= raw.length ? 1 : 0;
    head[1] = part.length & 0xff;
    head[2] = (part.length >>> 8) & 0xff;
    head[3] = ~part.length & 0xff;
    head[4] = (~part.length >>> 8) & 0xff;
    blocks.push(head, part);
  }
  const adler = (() => {
    let a = 1;
    let b = 0;
    for (const byte of raw) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    const v = new Uint8Array(4);
    v[0] = (b >>> 8) & 0xff;
    v[1] = b & 0xff;
    v[2] = (a >>> 8) & 0xff;
    v[3] = a & 0xff;
    return v;
  })();
  const zlib = new Uint8Array(2 + blocks.reduce((n, x) => n + x.length, 0) + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (const part of blocks) {
    zlib.set(part, at);
    at += part.length;
  }
  zlib.set(adler, at);
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function (this: HTMLCanvasElement) {
    const canvas = this;
    return {
      canvas,
      getImageData: (x: number, y: number, w: number, h: number) => {
        const s = surf(canvas);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const from = ((y + row) * s.w + (x + col)) * 4;
            const to = (row * w + col) * 4;
            data[to] = s.data[from];
            data[to + 1] = s.data[from + 1];
            data[to + 2] = s.data[from + 2];
            data[to + 3] = s.data[from + 3];
          }
        }
        return { data, width: w, height: h };
      },
      putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) => {
        const s = surf(canvas);
        for (let row = 0; row < img.height; row++) {
          for (let col = 0; col < img.width; col++) {
            const to = ((dy + row) * s.w + (dx + col)) * 4;
            const from = (row * img.width + col) * 4;
            s.data[to] = img.data[from];
            s.data[to + 1] = img.data[from + 1];
            s.data[to + 2] = img.data[from + 2];
            s.data[to + 3] = img.data[from + 3];
          }
        }
      },
      drawImage: () => undefined,
      fillRect: () => undefined,
      set fillStyle(_v: string) {},
    };
  };
  proto.toBlob = function (
    this: HTMLCanvasElement,
    cb: (b: Blob | null) => void,
    type?: string,
  ) {
    const s = surf(this);
    cb(new Blob([pngBytes(s.w, s.h, s.data)], { type: type ?? 'image/png' }));
  };
  if (typeof (globalThis as Record<string, unknown>).ImageData === 'undefined') {
    class ShimImageData {
      width: number;

      height: number;

      data: Uint8ClampedArray;

      constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
        if (typeof a === 'number') {
          this.width = a;
          this.height = b;
          this.data = new Uint8ClampedArray(a * b * 4);
        } else {
          this.data = a;
          this.width = b;
          this.height = c ?? Math.max(1, Math.floor(a.length / 4 / b));
        }
      }
    }
    Object.defineProperty(globalThis, 'ImageData', { value: ShimImageData, writable: true, configurable: true });
  }
});

/* ── hand-built image XObjects ────────────────────────────────────────────── */

type Part = string | Uint8Array;

function assemble(objects: Part[][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = (text: string) => Uint8Array.from(Buffer.from(text, 'latin1'));
  const offsets: number[] = [];
  const pdf = '%PDF-1.7\n';
  let length = pdf.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const head = enc(`${index + 1} 0 obj\n`);
    chunks.push(head);
    length += head.length;
    for (const part of body) {
      const bytes = typeof part === 'string' ? enc(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    }
    const tail = enc('\nendobj\n');
    chunks.push(tail);
    length += tail.length;
  });
  const start = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const all = [enc(pdf), ...chunks, enc(xref)];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface ImageSpec {
  name: string;
  colorSpace: string;
  bits: number;
  extra?: string;
  data: number[] | Uint8Array;
}

function matrixPdf(specs: ImageSpec[]): Uint8Array {
  const w = 4;
  const h = 4;
  const xobjectEntries = specs.map((spec, index) => `/${spec.name} ${4 + index} 0 R`).join(' ');
  const objects: Part[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << ${xobjectEntries} >> >> >>`],
  ];
  for (const spec of specs) {
    const body = typeof spec.data === 'object' ? Uint8Array.from(spec.data) : Uint8Array.from(spec.data);
    const dict =
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${spec.colorSpace} ` +
      `/BitsPerComponent ${spec.bits}${spec.extra ? ` ${spec.extra}` : ''} /Length ${body.length} >>\nstream\n`;
    objects.push([dict, body, '\nendstream']);
  }
  return assemble(objects);
}

/** Pack LSB-first samples, one row padded to a whole byte (PDF rule). */
function packBits(values: number[], bits: number, width: number): number[] {
  const out: number[] = [];
  const perRow = Math.ceil((width * bits) / 8);
  for (let y = 0; y < values.length / width; y++) {
    const row = new Array<number>(perRow).fill(0);
    for (let x = 0; x < width; x++) {
      const value = values[y * width + x];
      const bit = x * bits;
      for (let b = bits - 1; b >= 0; b--) {
        const mask = 1 << b;
        if (value & mask) {
          const position = bit + (bits - 1 - b);
          row[Math.floor(position / 8)] |= 1 << (7 - (position % 8));
        }
      }
    }
    out.push(...row);
  }
  return out;
}

const PALETTE = Buffer.from([
  0x10, 0x20, 0x30,
  0x40, 0x50, 0x60,
  0x70, 0x80, 0x90,
  0xa0, 0xb0, 0xc0,
]).toString('hex');

describe('probe: extract-images over the colour spaces a real PDF carries', () => {
  it('reports what survives', async () => {
    const bytes = matrixPdf([
      { name: 'Idx', colorSpace: `[/Indexed /DeviceRGB 3 <${PALETTE}>]`, bits: 8, data: [0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 1, 2, 2, 3, 3] },
      { name: 'Bi', colorSpace: '/DeviceGray', bits: 1, data: packBits([1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1], 1, 4) },
      { name: 'G4', colorSpace: '/DeviceGray', bits: 4, data: packBits([0, 5, 10, 15, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 4, 4) },
      { name: 'G8', colorSpace: '/DeviceGray', bits: 8, data: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160] },
      { name: 'RGB', colorSpace: '/DeviceRGB', bits: 8, data: Array.from({ length: 48 }, (_, i) => 20 + i * 4) },
      { name: 'CMY', colorSpace: '/DeviceCMYK', bits: 8, data: Array.from({ length: 64 }, (_, i) => (i * 7) % 256) },
      { name: 'B16', colorSpace: '/DeviceRGB', bits: 16, data: Array.from({ length: 96 }, (_, i) => (i * 5) % 256) },
      { name: 'Icc', colorSpace: '[/ICCBased 99 0 R]', bits: 8, data: Array.from({ length: 48 }, (_, i) => i) },
    ]);
    const doc = await PDFDocument.load(bytes);
    const images = await extractPageImages(doc, 1, { minSide: 0, skipMasks: false });
    // eslint-disable-next-line no-console
    const summary = images.map((image) => `${image.name}/${image.extension}/${image.width}x${image.height}/${image.bytes.length}b`);
    console.log(`SURVIVED ${JSON.stringify(summary)}`);
    expect(images.length).toBeGreaterThan(0);
  });
});
