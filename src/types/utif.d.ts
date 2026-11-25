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
    /**
     * `ExtraSamples` (tag 338), as the directory states it: `[1]` means the colour
     * samples have already been multiplied by the alpha (associated), `[2]` means
     * they have not (unassociated), and no entry means the file says nothing.
     * `toRGBA8` copies the samples either way, so a caller that hands them to a
     * straight-alpha canvas has to ask this first.
     */
    t338?: number[];
  }

  export interface Utif {
    /** Parse the header and every IFD; does not touch pixel data. */
    decode(buffer: ArrayBuffer): UtifIFD[];
    /** Decompress one IFD's strips/tiles into `ifd.data`. */
    decodeImage(buffer: ArrayBuffer, ifd: UtifIFD): void;
    /** Normalise any supported sample layout to 8-bit RGBA. */
    toRGBA8(ifd: UtifIFD): Uint8Array;
    /**
     * The header and IFD directories for a set of tag maps (`t256`, `t273`, …).
     *
     * Big-endian `MM` bytes with NO pixel data: `t273` names an offset the caller
     * then fills in, which is exactly what `encodeImage` does by appending RGBA
     * at byte 1000. Verified against utif 3.1.0 (`UTIF.js:65`).
     */
    encode(ifds: readonly Record<string, unknown>[]): ArrayBuffer;
    /** Baseline TIFF for one RGBA frame: `encode` plus its pixels at offset 1000. */
    encodeImage(rgba: Uint8Array, width: number, height: number): ArrayBuffer;
    /** Convenience: Latin-1 string → `ArrayBuffer`. */
    str2ab(str: string): ArrayBuffer;
  }

  const UTIF: Utif;
  export default UTIF;
}
