/**
 * Removes metadata containers from an image the app just encoded. A canvas
 * re-encode starts from bare pixels, so the camera's EXIF (and its GPS
 * position) is already gone; but some encoders write a small EXIF block of
 * their own (colour space, size). The Worker refuses any EXIF/XMP at all, so
 * this drops what an encoder might add, whatever it holds:
 *
 *   JPEG  APP1 (EXIF, XMP), APP13 (IPTC), COM, APP2 MPF; nothing after EOI
 *   WebP  EXIF and "XMP " chunks, and their flags in VP8X
 *
 * Anything it can't parse comes back unchanged (the Worker then decides).
 */
type Bytes = Uint8Array<ArrayBuffer>;

export function stripImageMetadata(bytes: Bytes): Bytes {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes) ?? bytes;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return stripWebp(bytes) ?? bytes;
  return bytes;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function stripJpeg(b: Bytes): Bytes | null {
  const keep: Bytes[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    const start = i;
    while (b[i] === 0xff) i++;
    const m = b[i];
    if (m === undefined) return null;
    i++;
    if (m === 0xd9) {
      keep.push(b.subarray(start, i));
      return concat(keep);
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      keep.push(b.subarray(start, i));
      continue;
    }
    const len = ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
    if (len < 2 || i + len > b.length) return null;
    const end = i + len;
    const isMpf = m === 0xe2 && ascii(b, i + 2, 4) === 'MPF\0';
    const drop = m === 0xe1 || m === 0xed || m === 0xfe || isMpf;
    i = end;
    if (m === 0xda) {
      // the scan runs to the next real marker
      while (i < b.length) {
        if (b[i] === 0xff) {
          const next = b[i + 1];
          if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next === 0xff) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
    }
    if (!drop) keep.push(b.subarray(start, i));
  }
  return null;
}

function stripWebp(b: Bytes): Bytes | null {
  const le32 = (at: number) =>
    ((b[at] ?? 0) |
      ((b[at + 1] ?? 0) << 8) |
      ((b[at + 2] ?? 0) << 16) |
      ((b[at + 3] ?? 0) << 24)) >>>
    0;
  const chunks: Bytes[] = [];
  let i = 12;
  const total = Math.min(b.length, le32(4) + 8);
  while (i + 8 <= total) {
    const fourcc = ascii(b, i, 4);
    const size = le32(i + 4);
    const end = i + 8 + size + (size & 1);
    if (end > total) return null;
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const c = b.slice(i, end);
      // VP8X: clear the "has EXIF" (0x08) and "has XMP" (0x04) flags
      if (fourcc === 'VP8X') c[8] = (c[8] ?? 0) & ~0x0c;
      chunks.push(c);
    }
    i = end;
  }
  const body = concat(chunks);
  const size = body.length + 4;
  const header = new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    size & 0xff,
    (size >> 8) & 0xff,
    (size >> 16) & 0xff,
    (size >>> 24) & 0xff,
    0x57,
    0x45,
    0x42,
    0x50,
  ]);
  return concat([header, body]);
}
