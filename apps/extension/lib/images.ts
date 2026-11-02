import type { CaptureImage } from '@otterpocket/shared';
import type { Rect } from './messages';

/** Formats the desktop app stores as-is; anything else is re-encoded as PNG. */
const STORABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);

export async function blobToDataUrl(blob: Blob, type = blob.type || 'image/png'): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** Decodes an image blob, checking it really is an image and reading its pixel size. */
export async function imageFromBlob(blob: Blob): Promise<CaptureImage> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  try {
    if (STORABLE_TYPES.has(blob.type)) return { dataUrl: await blobToDataUrl(blob), width, height };
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    return { dataUrl: await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' })), width, height };
  } finally {
    bitmap.close();
  }
}

/** A page's screenshot standing in for its preview picture needs no more than this. */
const THUMBNAIL_WIDTH = 1600;

/**
 * Cuts `rect` (CSS pixels of a viewport `viewportWidth` wide) out of a full-tab screenshot. A `thumbnail`
 * is scaled down to THUMBNAIL_WIDTH and stored as JPEG: a page's picture, not a reference to study.
 */
export async function cropScreenshot(
  screenshotDataUrl: string,
  rect: Rect,
  viewportWidth: number,
  thumbnail = false,
): Promise<CaptureImage> {
  const bitmap = await createImageBitmap(await (await fetch(screenshotDataUrl)).blob());
  try {
    const scale = bitmap.width / viewportWidth; // device pixel ratio, including browser zoom
    const sx = clamp(Math.round(rect.x * scale), 0, bitmap.width - 1);
    const sy = clamp(Math.round(rect.y * scale), 0, bitmap.height - 1);
    const sw = clamp(Math.round(rect.width * scale), 1, bitmap.width - sx);
    const sh = clamp(Math.round(rect.height * scale), 1, bitmap.height - sy);
    const shrink = thumbnail ? Math.min(1, THUMBNAIL_WIDTH / sw) : 1;
    const width = Math.max(1, Math.round(sw * shrink));
    const height = Math.max(1, Math.round(sh * shrink));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
    const blob = await canvas.convertToBlob(thumbnail ? { type: 'image/jpeg', quality: 0.85 } : { type: 'image/png' });
    return { dataUrl: await blobToDataUrl(blob), width, height };
  } finally {
    bitmap.close();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
