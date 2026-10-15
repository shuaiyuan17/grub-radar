import { PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, type PhotoType } from '../contracts/photos';
import { stripImageMetadata } from './stripImageMetadata';

/**
 * Gets a photo from the picker ready to upload, entirely in the browser:
 *
 *   1. decode it, turned the right way up (EXIF orientation applied):
 *      createImageBitmap with imageOrientation 'from-image', or an <img> where
 *      that isn't available. Whatever the browser can decode works: Safari
 *      reads HEIC, most others don't (that's a friendly error, not a crash).
 *   2. scale it to at most 1600px on the long edge
 *   3. draw it on a canvas and encode that as WebP, or JPEG where the browser
 *      can't encode WebP (older Safari hands back PNG when asked for WebP)
 *   4. step the quality down until it's around 150-300 KB (never over 1 MB)
 *
 * Step 3 is the privacy step: the canvas holds pixels only, so the camera's
 * metadata, including the GPS position of where it was taken, doesn't survive
 * it. stripImageMetadata then drops anything the encoder itself added.
 */

export const TARGET_BYTES = 300 * 1024;
const QUALITIES = [0.82, 0.74, 0.66, 0.58, 0.5];
/** Headroom under the server's 1 MB, for the rare photo that won't shrink. */
const HARD_LIMIT = PHOTO_MAX_BYTES - 16 * 1024;

export type PhotoErrorKind = 'unreadable' | 'too_big';

export class PhotoProcessError extends Error {
  readonly kind: PhotoErrorKind;
  constructor(kind: PhotoErrorKind, message: string) {
    super(message);
    this.name = 'PhotoProcessError';
    this.kind = kind;
  }
}

export interface PreparedPhoto {
  blob: Blob;
  type: PhotoType;
  width: number;
  height: number;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

/** The size that fits `max` on the long edge (never upscaled). */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.min(max, Math.round(width * scale))),
    height: Math.max(1, Math.min(max, Math.round(height * scale))),
  };
}

async function decodeWithBitmap(file: Blob): Promise<Decoded> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => {
      bitmap.close();
    },
  };
}

/** <img> applies EXIF orientation itself (CSS image-orientation: from-image is the default). */
async function decodeWithImg(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close: () => {
      URL.revokeObjectURL(url);
    },
  };
}

async function decode(file: Blob): Promise<Decoded> {
  try {
    return await decodeWithBitmap(file);
  } catch {
    try {
      return await decodeWithImg(file);
    } catch {
      throw new PhotoProcessError('unreadable', 'this browser can’t read that image');
    }
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

/** Encodes as WebP when the browser can, else JPEG. */
async function encode(
  canvas: HTMLCanvasElement,
  quality: number,
  prefer: PhotoType,
): Promise<{ blob: Blob; type: PhotoType } | null> {
  if (prefer === 'image/webp') {
    const webp = await toBlob(canvas, 'image/webp', quality);
    // unsupported types come back as PNG (or not at all)
    if (webp?.type === 'image/webp') return { blob: webp, type: 'image/webp' };
  }
  const jpeg = await toBlob(canvas, 'image/jpeg', quality);
  return jpeg?.type === 'image/jpeg' ? { blob: jpeg, type: 'image/jpeg' } : null;
}

export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const decoded = await decode(file);
  try {
    if (!decoded.width || !decoded.height)
      throw new PhotoProcessError('unreadable', 'that image has no size');
    let { width, height } = fitWithin(decoded.width, decoded.height);
    let prefer: PhotoType = 'image/webp';
    // a few rounds: each tries the quality ladder; if even the lowest is over
    // the hard limit (a very noisy photo), shrink and go again
    for (let round = 0; round < 4; round++) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new PhotoProcessError('unreadable', 'no canvas');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded.source, 0, 0, width, height);

      let best: { blob: Blob; type: PhotoType } | null = null;
      for (const q of QUALITIES) {
        const out = await encode(canvas, q, prefer);
        if (!out) throw new PhotoProcessError('unreadable', 'this browser can’t encode photos');
        prefer = out.type;
        best = out;
        if (out.blob.size <= TARGET_BYTES) break;
      }
      canvas.width = 0;
      canvas.height = 0;
      if (best && best.blob.size <= HARD_LIMIT) {
        const clean = stripImageMetadata(new Uint8Array(await best.blob.arrayBuffer()));
        return {
          blob: new Blob([clean], { type: best.type }),
          type: best.type,
          width,
          height,
        };
      }
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }
    throw new PhotoProcessError('too_big', 'couldn’t get that photo small enough');
  } finally {
    decoded.close();
  }
}
