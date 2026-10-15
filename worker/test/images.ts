/**
 * Hand-built image containers for tests: the structure the Worker's guard
 * reads (markers, chunks, size headers), with filler where pixels would be.
 * Also an EXIF block carrying a GPS position, the thing that must never be
 * stored. Shared by the Worker tests and Playwright (which splices it into a
 * real, decodable JPEG).
 */

const enc = new TextEncoder();
const cat = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** A JPEG marker segment: FF <marker> <length> <body>. */
export const segment = (marker: number, body: Uint8Array | number[]) =>
  cat([0xff, marker, ...be16(body.length + 2)], body);

/** The fictional spot the GPS block points at: 47.6205 N, 122.3493 W. */
export const GPS_FIXTURE = { lat: [47, 37, 13.8], lng: [122, 20, 57.48] } as const;

/**
 * An APP1 segment body: "Exif\0\0" + a little-endian TIFF with IFD0
 * (Orientation, a pointer to the GPS IFD) and a GPS IFD (lat/lng with refs).
 */
export function exifBody(opts: { orientation?: number; gps?: boolean } = {}): Uint8Array {
  const { orientation = 1, gps = true } = opts;
  const ifd0Count = gps ? 2 : 1;
  const ifd0At = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const gpsAt = ifd0At + ifd0Size;
  const gpsSize = 2 + 4 * 12 + 4;
  const latAt = gpsAt + gpsSize;
  const lngAt = latAt + 24;

  const entry = (tag: number, type: number, count: number, value: number[]) => [
    ...le16(tag),
    ...le16(type),
    ...le32(count),
    ...value,
    ...new Array<number>(4 - value.length).fill(0),
  ];
  const rationals = (parts: readonly number[]) =>
    parts.flatMap((v) => [...le32(Math.round(v * 100)), ...le32(100)]);

  const tiff: number[] = [0x49, 0x49, 0x2a, 0x00, ...le32(ifd0At)];
  tiff.push(...le16(ifd0Count), ...entry(0x0112, 3, 1, le16(orientation)));
  if (gps) tiff.push(...entry(0x8825, 4, 1, le32(gpsAt)));
  tiff.push(...le32(0));
  if (gps) {
    tiff.push(
      ...le16(4),
      ...entry(0x0001, 2, 2, [0x4e, 0]), // GPSLatitudeRef 'N'
      ...entry(0x0002, 5, 3, le32(latAt)), // GPSLatitude
      ...entry(0x0003, 2, 2, [0x57, 0]), // GPSLongitudeRef 'W'
      ...entry(0x0004, 5, 3, le32(lngAt)), // GPSLongitude
      ...le32(0),
      ...rationals(GPS_FIXTURE.lat),
      ...rationals(GPS_FIXTURE.lng),
    );
  }
  return cat(enc.encode('Exif\0\0'), tiff);
}

/** An XMP packet as JPEG carries it (APP1, Adobe's namespace header). */
export const xmpBody = () =>
  enc.encode(
    'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><exif:GPSLatitude>47,37.23N</exif:GPSLatitude></x:xmpmeta>',
  );

const JFIF = segment(0xe0, [...enc.encode('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const sof0 = (w: number, h: number) =>
  segment(0xc0, [8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const SOS = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
// entropy-coded filler, with a stuffed 0xFF00 and a restart marker the guard must step over
const SCAN = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a];

/**
 * A JPEG's structure: SOI, APP0, `before` segments, SOF0 with this size, SOS,
 * scan data, EOI, then `after` (bytes that shouldn't be there).
 */
export function jpeg(
  opts: { width?: number; height?: number; before?: Uint8Array[]; after?: number[] } = {},
): Uint8Array {
  const { width = 1200, height = 900, before = [], after = [] } = opts;
  return cat([0xff, 0xd8], JFIF, ...before, sof0(width, height), SOS, SCAN, [0xff, 0xd9], after);
}

const chunk = (fourcc: string, body: Uint8Array | number[]) =>
  cat(enc.encode(fourcc), le32(body.length), body, body.length & 1 ? [0] : []);

const vp8l = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return chunk('VP8L', [0x2f, ...le32(bits), 0, 0, 0]);
};
const vp8 = (w: number, h: number) =>
  chunk('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
/** VP8X with flags (0x08 EXIF, 0x04 XMP, 0x02 animation, 0x10 alpha, 0x20 ICC). */
export const vp8x = (w: number, h: number, flags = 0) =>
  chunk('VP8X', [flags, 0, 0, 0, ...le32(w - 1).slice(0, 3), ...le32(h - 1).slice(0, 3)]);

/** A WebP: RIFF/WEBP around `chunks` (default: one lossless bitstream of this size). */
export function webp(
  opts: {
    width?: number;
    height?: number;
    lossy?: boolean;
    chunks?: Uint8Array[];
    after?: number[];
  } = {},
): Uint8Array {
  const { width = 1200, height = 900, lossy = false, after = [] } = opts;
  const chunks = opts.chunks ?? [lossy ? vp8(width, height) : vp8l(width, height)];
  const body = cat(enc.encode('WEBP'), ...chunks);
  return cat(enc.encode('RIFF'), le32(body.length), body, after);
}

export const webpParts = { chunk, vp8l, vp8, vp8x };

/** Puts an APP1 EXIF segment right after SOI of a real JPEG (what a phone camera does). */
export function withExif(jpegBytes: Uint8Array, body: Uint8Array = exifBody()): Uint8Array {
  return cat(jpegBytes.subarray(0, 2), segment(0xe1, body), jpegBytes.subarray(2));
}

/** True when the bytes contain an "Exif\0\0" header anywhere. */
export function containsExif(b: Uint8Array): boolean {
  const sig = enc.encode('Exif\0\0');
  outer: for (let i = 0; i + sig.length <= b.length; i++) {
    for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer;
    return true;
  }
  return false;
}
