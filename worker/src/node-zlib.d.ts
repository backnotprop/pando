// node:zlib as the door's pack reading uses it (nodejs_compat provides it at runtime).
declare module "node:zlib" {
  /** With `info`, also how many input bytes the zlib stream took (the rest is ignored). */
  export function inflateSync(data: Uint8Array, options: { info: true }): { buffer: Uint8Array; engine: { bytesWritten: number } };
  export function inflateSync(data: Uint8Array): Uint8Array;
}
