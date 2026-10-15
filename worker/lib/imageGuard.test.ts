import { describe, expect, it } from 'vitest';
import { exifBody, jpeg, segment, vp8x, webp, webpParts, xmpBody } from '../test/images';
import { checkImage, sniffImage } from './imageGuard';

const enc = new TextEncoder();

describe('checkImage: JPEG', () => {
  it('passes a clean JPEG and reads its size from the frame header', () => {
    expect(checkImage(jpeg({ width: 1600, height: 1200 }))).toEqual({
      ok: true,
      type: 'image/jpeg',
      width: 1600,
      height: 1200,
    });
  });

  it('passes an exact, thumbnail-free JFIF APP0 and Adobe’s APP14, nothing else in APPn', () => {
    // jpeg() starts with JFIF 1.01, no thumbnail
    expect(checkImage(jpeg()).ok).toBe(true);
    const adobe = segment(0xee, [...enc.encode('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
    expect(checkImage(jpeg({ before: [adobe] })).ok).toBe(true);
  });

  it('refuses JFXX and JFIF thumbnails: a thumbnail is a whole JPEG, EXIF and all', () => {
    // a JFXX extension (0x10: thumbnail coded as JPEG) holding a JPEG that carries GPS
    const thumbnail = jpeg({ width: 16, height: 16, before: [segment(0xe1, exifBody())] });
    const jfxx = segment(0xe0, [...enc.encode('JFXX\0'), 0x10, ...thumbnail]);
    expect(checkImage(jpeg({ before: [jfxx] }))).toMatchObject({ ok: false, reason: 'metadata' });
    // even an empty-looking one
    const bare = segment(0xe0, [...enc.encode('JFXX\0'), 0x10]);
    expect(checkImage(jpeg({ before: [bare] }))).toMatchObject({ ok: false, reason: 'metadata' });
    // JFIF with a 2x1 RGB thumbnail after the header
    const jfifThumb = segment(0xe0, [
      ...enc.encode('JFIF\0'),
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      2,
      1,
      255,
      0,
      0,
      0,
      255,
      0,
    ]);
    expect(checkImage(jpeg({ before: [jfifThumb] }))).toMatchObject({
      ok: false,
      reason: 'metadata',
    });
    // JFIF that says "no thumbnail" but carries bytes anyway, or is cut short
    const padded = segment(0xe0, [...enc.encode('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 47, 62]);
    const short = segment(0xe0, [...enc.encode('JFIF\0'), 1, 1]);
    for (const s of [padded, short])
      expect(checkImage(jpeg({ before: [s] }))).toMatchObject({ ok: false, reason: 'metadata' });
  });

  it('refuses every other APPn, whatever it says it is (fail closed)', () => {
    const payloads = [
      // Chrome's canvas adds this one; the app strips it before upload
      segment(0xe2, [...enc.encode('ICC_PROFILE\0'), 1, 1, 0, 0]),
      segment(0xe5, enc.encode('lat=47.6205;lng=-122.3493')),
      segment(0xe3, enc.encode('Meta\0anything')),
      segment(0xef, [1, 2, 3]),
      // APP0 that isn't JFIF, and an Adobe APP14 with room for more
      segment(0xe0, enc.encode('NOTJFIF-47.62N')),
      segment(0xee, [...enc.encode('Adobe'), 0, 100, 0, 0, 0, 0, 1, ...enc.encode('47.62N')]),
    ];
    for (const s of payloads)
      expect(checkImage(jpeg({ before: [s] }))).toMatchObject({ ok: false, reason: 'metadata' });
  });

  it('refuses markers it doesn’t know (JPGn, DHP, …)', () => {
    for (const m of [0xf0, 0xf7, 0xde, 0xdf])
      expect(checkImage(jpeg({ before: [segment(m, [0, 0])] }))).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
  });

  it('refuses EXIF with a GPS position (APP1)', () => {
    const r = checkImage(jpeg({ before: [segment(0xe1, exifBody({ gps: true }))] }));
    expect(r).toMatchObject({ ok: false, reason: 'metadata' });
  });

  it('refuses EXIF even without GPS, and XMP (also APP1)', () => {
    expect(checkImage(jpeg({ before: [segment(0xe1, exifBody({ gps: false }))] }))).toMatchObject({
      ok: false,
      reason: 'metadata',
    });
    expect(checkImage(jpeg({ before: [segment(0xe1, xmpBody())] }))).toMatchObject({
      ok: false,
      reason: 'metadata',
    });
  });

  it('refuses IPTC (APP13), comments, and MPF indexes of extra embedded images', () => {
    const iptc = segment(0xed, enc.encode('Photoshop 3.0\0'));
    const com = segment(0xfe, enc.encode('taken at home'));
    const mpf = segment(0xe2, [...enc.encode('MPF\0'), 0, 0]);
    for (const s of [iptc, com, mpf])
      expect(checkImage(jpeg({ before: [s] }))).toMatchObject({ ok: false, reason: 'metadata' });
  });

  it('refuses EXIF hidden after the image (a second JPEG glued on)', () => {
    const second = jpeg({ before: [segment(0xe1, exifBody())] });
    expect(checkImage(jpeg({ after: [...second] }))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses EXIF placed after the scan (between scans of a progressive JPEG)', () => {
    const base = jpeg();
    // splice an APP1 just before EOI
    const exif = segment(0xe1, exifBody());
    const spliced = new Uint8Array([...base.subarray(0, -2), ...exif, 0xff, 0xd9]);
    expect(checkImage(spliced)).toMatchObject({ ok: false, reason: 'metadata' });
  });

  it('refuses truncated files, segments that run past the end and missing frames', () => {
    const ok = jpeg();
    expect(checkImage(ok.subarray(0, ok.length - 2)).ok).toBe(false);
    expect(checkImage(ok.subarray(0, 10)).ok).toBe(false);
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(checkImage(noFrame).ok).toBe(false);
    const overrun = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x40, 0x00, 1, 2, 3]);
    expect(checkImage(overrun).ok).toBe(false);
  });
});

describe('checkImage: WebP', () => {
  it('passes lossless (VP8L) and lossy (VP8) stills and reads their size', () => {
    expect(checkImage(webp({ width: 1600, height: 900 }))).toEqual({
      ok: true,
      type: 'image/webp',
      width: 1600,
      height: 900,
    });
    expect(checkImage(webp({ width: 640, height: 480, lossy: true }))).toMatchObject({
      ok: true,
      width: 640,
      height: 480,
    });
  });

  it('passes VP8X + ALPH + VP8 when the sizes agree, refuses when they don’t', () => {
    const { chunk, vp8 } = webpParts;
    const alpha = chunk('ALPH', [0, 1, 2]);
    expect(
      checkImage(webp({ chunks: [vp8x(800, 600, 0x10), alpha, vp8(800, 600)] })),
    ).toMatchObject({ ok: true, width: 800, height: 600 });
    expect(checkImage(webp({ chunks: [vp8x(1600, 600), vp8(800, 600)] })).ok).toBe(false);
  });

  it('refuses EXIF and XMP chunks, and a VP8X that says it has them', () => {
    const { chunk, vp8l } = webpParts;
    for (const chunks of [
      [vp8x(100, 100, 0x08), vp8l(100, 100), chunk('EXIF', exifBody())],
      [vp8x(100, 100, 0x04), vp8l(100, 100), chunk('XMP ', xmpBody())],
      // the chunk without the flag, and the flag without the chunk
      [vp8x(100, 100), vp8l(100, 100), chunk('EXIF', exifBody())],
      [vp8x(100, 100, 0x08), vp8l(100, 100)],
    ])
      expect(checkImage(webp({ chunks }))).toMatchObject({ ok: false, reason: 'metadata' });
  });

  it('passes a colour profile (ICCP) only where VP8X declares it, before the image', () => {
    const { chunk, vp8 } = webpParts;
    const iccp = chunk('ICCP', [0, 0, 2, 0]);
    // Chrome's canvas WebP: VP8X, ICCP, VP8
    expect(checkImage(webp({ chunks: [vp8x(64, 48, 0x20), iccp, vp8(64, 48)] })).ok).toBe(true);
    expect(checkImage(webp({ chunks: [vp8x(64, 48), iccp, vp8(64, 48)] })).ok).toBe(false);
    expect(checkImage(webp({ chunks: [iccp, vp8(64, 48)] })).ok).toBe(false);
    expect(checkImage(webp({ chunks: [vp8x(64, 48, 0x20), vp8(64, 48), iccp] })).ok).toBe(false);
  });

  it('refuses reserved VP8X flags', () => {
    const { vp8l } = webpParts;
    for (const flags of [0x01, 0x40, 0x80])
      expect(checkImage(webp({ chunks: [vp8x(10, 10, flags), vp8l(10, 10)] })).ok).toBe(false);
  });

  it('refuses animation, unknown chunks, trailing bytes and a lying RIFF size', () => {
    const { chunk, vp8l } = webpParts;
    expect(checkImage(webp({ chunks: [vp8x(10, 10, 0x02), vp8l(10, 10)] })).ok).toBe(false);
    expect(checkImage(webp({ chunks: [vp8l(10, 10), chunk('ANMF', [0, 0])] })).ok).toBe(false);
    expect(checkImage(webp({ chunks: [vp8l(10, 10), chunk('ZZZZ', [1, 2])] })).ok).toBe(false);
    expect(checkImage(webp({ after: [1, 2, 3, 4] })).ok).toBe(false);
    expect(checkImage(webp({ chunks: [vp8l(10, 10), vp8l(10, 10)] })).ok).toBe(false);
    expect(checkImage(webp({ chunks: [] })).ok).toBe(false);
  });
});

describe('sniffImage', () => {
  it('knows JPEG and WebP by their first bytes and nothing else', () => {
    expect(sniffImage(jpeg())).toBe('image/jpeg');
    expect(sniffImage(webp())).toBe('image/webp');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImage(png)).toBeNull();
    expect(checkImage(png)).toMatchObject({ ok: false, reason: 'not_image' });
    // HEIC: ....ftypheic
    const heic = new Uint8Array([0, 0, 0, 0x18, ...enc.encode('ftypheic'), 0, 0, 0, 0]);
    expect(checkImage(heic)).toMatchObject({ ok: false, reason: 'not_image' });
    expect(checkImage(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')).ok).toBe(false);
    expect(checkImage(new Uint8Array()).ok).toBe(false);
  });
});
