/** Ambient types for `utif`, which ships JavaScript without declarations. */
declare module 'utif' {
  /**
   * An opaque decoded IFD handle; fields are populated by `decodeImage`.
   *
   * `w` and `h` are deliberately NOT declared. UTIF sets them on no real file —
   * the dimensions arrive as `c`/`l` (and `data.length` after decode) — so
   * typing them as `number` let `ifd.w` compile while reading `undefined` at
   * runtime, which is how PDF→TIFF produced 0x0 canvases. Read dimensions
   * through `core/images.ts` → `tiffPageDimensions`, which returns honest nulls.
   */
  export interface UtifIFD {
    bpp: number;
    samples: number;
    config: number;
    compression: number;
  }

  export interface Utif {
    /** Parse the header and every IFD; does not touch pixel data. */
    decode(buffer: ArrayBuffer): UtifIFD[];
    /** Decompress one IFD's strips/tiles into `ifd.data`. */
    decodeImage(buffer: ArrayBuffer, ifd: UtifIFD): void;
    /** Normalise any supported sample layout to 8-bit RGBA. */
    toRGBA8(ifd: UtifIFD): Uint8Array;
    /** Encode RGBA bytes into a baseline little-endian TIFF string. */
    encodeImage(data: Uint8Array, width: number, height: number): string;
    /** Convenience: Latin-1 string → `ArrayBuffer`. */
    str2ab(str: string): ArrayBuffer;
  }

  const UTIF: Utif;
  export default UTIF;
}
