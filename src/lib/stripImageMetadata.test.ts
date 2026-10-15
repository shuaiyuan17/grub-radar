import { checkImage } from '../../worker/lib/imageGuard';
import {
  containsExif,
  exifBody,
  jpeg,
  segment,
  vp8x,
  webp,
  webpParts,
  xmpBody,
} from '../../worker/test/images';
import { stripImageMetadata } from './stripImageMetadata';

const enc = new TextEncoder();
const strip = (b: Uint8Array) => stripImageMetadata(new Uint8Array(b));

describe('stripImageMetadata', () => {
  it('takes EXIF (with its GPS position), XMP, IPTC and comments out of a JPEG', () => {
    const dirty = jpeg({
      width: 800,
      height: 600,
      before: [
        segment(0xe1, exifBody({ gps: true })),
        segment(0xe1, xmpBody()),
        segment(0xed, enc.encode('Photoshop 3.0\0')),
        segment(0xfe, enc.encode('hello')),
      ],
    });
    expect(checkImage(dirty).ok).toBe(false);
    const clean = strip(dirty);
    expect(containsExif(clean)).toBe(false);
    expect(checkImage(clean)).toEqual({ ok: true, type: 'image/jpeg', width: 800, height: 600 });
  });

  it('keeps everything else of a JPEG byte for byte, and drops bytes after the end', () => {
    const plain = jpeg();
    expect(strip(plain)).toEqual(plain);
    expect(strip(jpeg({ after: [1, 2, 3] }))).toEqual(plain);
    const icc = segment(0xe2, [...enc.encode('ICC_PROFILE\0'), 1, 1]);
    expect(strip(jpeg({ before: [icc] }))).toEqual(jpeg({ before: [icc] }));
  });

  it('takes EXIF and XMP chunks out of a WebP and clears their VP8X flags', () => {
    const { chunk, vp8l } = webpParts;
    const dirty = webp({
      chunks: [
        vp8x(640, 480, 0x08 | 0x04),
        vp8l(640, 480),
        chunk('EXIF', exifBody()),
        chunk('XMP ', xmpBody()),
      ],
    });
    expect(checkImage(dirty).ok).toBe(false);
    const clean = strip(dirty);
    expect(containsExif(clean)).toBe(false);
    expect(checkImage(clean)).toEqual({ ok: true, type: 'image/webp', width: 640, height: 480 });
  });

  it('leaves what it can’t parse alone (the Worker judges it)', () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    expect(strip(junk)).toEqual(junk);
    const truncated = jpeg().subarray(0, 12);
    expect(strip(truncated)).toEqual(truncated);
  });
});
