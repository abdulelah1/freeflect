// Minimal types for the parts of gifenc (no bundled types) that we use.
declare module 'gifenc' {
  export type Palette = number[][]
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts: { palette?: Palette; delay?: number; repeat?: number }): void
    finish(): void
    bytes(): Uint8Array
  }
  export function GIFEncoder(): Encoder
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette): Uint8Array
}
