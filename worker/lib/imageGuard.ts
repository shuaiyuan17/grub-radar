/**
 * The Worker's check on an uploaded photo. It doesn't decode pixels: it reads
 * just enough of the container to know what the file is, how big it claims to
 * be, and whether anything in it could carry metadata.
 *
 *   JPEG  SOI, then marker segments up to EOI. Refused: APP1 (EXIF and XMP
 *         both live there), APP13 (Photoshop/IPTC, which can hold a place),
 *         an APP2 that is an MPF index (extra embedded images, each with
 *         its own EXIF), COM, any segment that runs past the end, and
 *         anything after EOI. Size: from the frame header (SOFn).
 *   WebP  RIFF/WEBP whose size field matches the upload. Refused: EXIF and
 *         "XMP " chunks, a VP8X header whose EXIF/XMP flags are set,
 *         animation, unknown chunks, trailing bytes. Size: from VP8X, VP8 or
 *         VP8L, which must agree when more than one is present.
 *
 * Fail closed: anything this doesn't understand is refused.
 */

export type ImageFormat = 'image/jpeg' | 'image/webp';

export type ImageCheck =
  | { ok: true; type: ImageFormat; width: number; height: number }
  | { ok: false; reason: 'not_image' | 'malformed' | 'metadata'; detail: string };

const bad = (detail: string): ImageCheck => ({ ok: false, reason: 'malformed', detail });
const meta = (detail: string): ImageCheck => ({ ok: false, reason: 'metadata', detail });

/** Which format the first bytes say this is, if it's one we accept. */
export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/** Checks an upload; see the module comment for what passes. */
export function checkImage(bytes: Uint8Array): ImageCheck {
  const type = sniffImage(bytes);
  if (type === 'image/jpeg') return checkJpeg(bytes);
  if (type === 'image/webp') return checkWebp(bytes);
  return { ok: false, reason: 'not_image', detail: 'not a JPEG or WebP' };
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, at: number) => (u24le(b, at) + (b[at + 3] ?? 0) * 0x1000000) >>> 0;

// ---------------------------------------------------------------------------
// JPEG

/** SOFn markers that carry a frame size (C4 DHT, C8 JPG, CC DAC are not frames). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Markers with no length field. */
const standalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

function checkJpeg(b: Uint8Array): ImageCheck {
  let i = 2; // after SOI
  let width = 0;
  let height = 0;
  let sawScan = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return bad(`expected a marker at ${String(i)}`);
    // fill bytes: any number of 0xFF before the marker code
    while (b[i] === 0xff) i++;
    const m = b[i];
    if (m === undefined) return bad('truncated marker');
    i++;
    if (m === 0xd9) {
      // EOI: must be the very end
      if (!sawScan) return bad('no image data');
      if (i !== b.length) return bad('bytes after the end of the image');
      if (!width || !height) return bad('no frame size');
      return { ok: true, type: 'image/jpeg', width, height };
    }
    if (m === 0xd8 || m === 0x00) return bad('unexpected marker');
    if (standalone(m)) continue;
    if (i + 2 > b.length) return bad('truncated segment');
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return bad('segment runs past the end');
    const body = i + 2;
    const end = i + len;

    if (m === 0xe1) return meta('APP1 (EXIF/XMP)');
    if (m === 0xed) return meta('APP13 (IPTC)');
    if (m === 0xfe) return meta('comment');
    if (m === 0xe2 && ascii(b, body, 4) === 'MPF\0') return meta('MPF (embedded images)');
    if (isSof(m)) {
      if (width) return bad('two frames');
      if (len < 8) return bad('short frame header');
      height = u16be(b, body + 1);
      width = u16be(b, body + 3);
    }
    i = end;
    if (m === 0xda) {
      // SOS: entropy-coded data follows, up to the next marker that isn't
      // a stuffed 0xFF00 or a restart marker
      sawScan = true;
      while (i < b.length) {
        if (b[i] === 0xff) {
          const next = b[i + 1];
          if (next === undefined) return bad('truncated scan');
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            i += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        i++;
      }
    }
  }
  return bad('no end of image');
}

// ---------------------------------------------------------------------------
// WebP

/** Chunks a still WebP may carry (EXIF and "XMP " are refused before this). */
const STILL_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP']);

function checkWebp(b: Uint8Array): ImageCheck {
  const riffSize = u32le(b, 4);
  if (riffSize + 8 !== b.length) return bad('RIFF size does not match the upload');
  let i = 12;
  const sizes: { w: number; h: number }[] = [];
  let bitstreams = 0;
  while (i < b.length) {
    if (i + 8 > b.length) return bad('truncated chunk header');
    const fourcc = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const body = i + 8;
    const end = body + size + (size & 1);
    if (end > b.length) return bad(`chunk ${fourcc} runs past the end`);

    if (fourcc === 'EXIF') return meta('EXIF chunk');
    if (fourcc === 'XMP ') return meta('XMP chunk');
    if (fourcc === 'ANIM' || fourcc === 'ANMF') return bad('animated');
    if (!STILL_CHUNKS.has(fourcc)) return bad(`unknown chunk ${JSON.stringify(fourcc)}`);

    if (fourcc === 'VP8X') {
      if (i !== 12) return bad('VP8X must come first');
      if (size < 10) return bad('short VP8X');
      const flags = b[body] ?? 0;
      if (flags & 0x08) return meta('VP8X says EXIF');
      if (flags & 0x04) return meta('VP8X says XMP');
      if (flags & 0x02) return bad('animated');
      sizes.push({ w: u24le(b, body + 4) + 1, h: u24le(b, body + 7) + 1 });
    } else if (fourcc === 'VP8 ') {
      bitstreams++;
      // frame tag (3), start code 9d 01 2a, then 14-bit width and height
      if (size < 10) return bad('short VP8');
      if (b[body + 3] !== 0x9d || b[body + 4] !== 0x01 || b[body + 5] !== 0x2a)
        return bad('bad VP8 start code');
      sizes.push({ w: u16le(b, body + 6) & 0x3fff, h: u16le(b, body + 8) & 0x3fff });
    } else if (fourcc === 'VP8L') {
      bitstreams++;
      // signature 0x2f, then 14 bits width-1, 14 bits height-1
      if (size < 5 || b[body] !== 0x2f) return bad('bad VP8L signature');
      const bits = u32le(b, body + 1);
      sizes.push({ w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 });
    }
    i = end;
  }
  if (bitstreams !== 1) return bad('expected exactly one image');
  const [first] = sizes;
  if (!first || sizes.some((s) => s.w !== first.w || s.h !== first.h))
    return bad('size headers disagree');
  if (!first.w || !first.h) return bad('zero size');
  return { ok: true, type: 'image/webp', width: first.w, height: first.h };
}
