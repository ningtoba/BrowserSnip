/**
 * Shared engine modules.
 *
 * `provider` owns the addresses and the trust rules; `auto` resolves an engine
 * on demand — no UI, nothing to enable; the three loader modules (`pymupdf`,
 * `ghostscript`, `cpdf`) turn an address into a live instance and memoise it.
 */
export * from './provider';
export * from './pymupdf';
export * from './ghostscript';
export * from './cpdf';
export * from './auto';
