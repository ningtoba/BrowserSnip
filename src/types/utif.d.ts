/** Ambient types for `utif`, which ships JavaScript without declarations. */
declare module 'utif' {
  /** An opaque decoded IFD handle; fields are populated by `decodeImage`. */
  export interface UtifIFD {
    w: number;
    h: number;
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
