import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { parseSeekFragment, type CaptureImage } from '@otterpocket/shared';
import { blobToDataUrl } from '../../lib/images';
import { ask, type BeginCaptureMessage, type CaptureMode, type Draft, type PageMessage, type StatusResponse } from '../../lib/messages';
import {
  baseSource,
  findMainVideo,
  grabVideoFrame,
  guessPageKind,
  largestVideo,
  nearbyText,
  pageImageUrl,
  resolveTarget,
  visibleRect,
  type Point,
  type Target,
} from '../../lib/page';
import { createDock, type Dock } from '../../lib/dock';
import { openSavePanel, pickImage, selectArea, showMessage } from '../../lib/panel';
import { toggleToolbarMenu } from '../../lib/toolbar-menu';

let dock: Dock | undefined;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // The background may inject this script again into tabs that predate the extension.
    const flag = '__otterPocketCapture';
    if ((window as unknown as Record<string, boolean>)[flag]) return;
    (window as unknown as Record<string, boolean>)[flag] = true;

    let pointer: Point = { x: innerWidth / 2, y: innerHeight / 2 };
    const track = (e: MouseEvent) => (pointer = { x: e.clientX, y: e.clientY });
    document.addEventListener('contextmenu', track, true);
    document.addEventListener('pointermove', track, { capture: true, passive: true });

    const start = (message: BeginCaptureMessage, fromMenu = false) =>
      capture(message, pointer, fromMenu).catch((e: unknown) => showMessage(e instanceof Error ? e.message : String(e)));
    browser.runtime.onMessage.addListener((message: PageMessage, _sender, sendResponse) => {
      if (message.type === 'toggle-menu') {
        sendResponse(true);
        toggleToolbarMenu((mode) => void start({ type: 'begin-capture', mode }, true));
      } else if (message.type === 'begin-capture') {
        sendResponse(true);
        void start(message);
      }
    });
    dock = createDock((mode) => void start({ type: 'begin-capture', mode }));

    void seekFromFragment();
  },
});

/** `fromMenu`: the toolbar menu was just closed, and is still on screen until the page repaints. */
async function capture(message: BeginCaptureMessage, pointer: Point, fromMenu = false): Promise<void> {
  const status = ask<StatusResponse>({ type: 'get-status' });
  // The floating button and the menu step aside first, so they are never in a screenshot.
  if (dock?.setBusy(true) || fromMenu) await afterRepaint();
  try {
    const draft = await makeDraft(message.mode, message, pointer);
    if (draft) openSavePanel(draft, await status);
  } finally {
    dock?.setBusy(false);
  }
}

/** What to save, or null when the user cancelled picking it. */
async function makeDraft(mode: CaptureMode, message: BeginCaptureMessage, pointer: Point): Promise<Draft | null> {
  switch (mode) {
    case 'image': {
      const picked = await pickImage(pointer);
      if (!picked) return null;
      await afterRepaint(); // make sure our overlay is gone before any screenshot
      return targetDraft(picked);
    }
    case 'area': {
      const rect = await selectArea();
      if (!rect) return null;
      await afterRepaint();
      return { kind: 'image', source: baseSource(), image: await cropVisible(rect) };
    }
    case 'video': {
      const video = await findMainVideo(pointer);
      if (!video) throw new Error('No video on screen. For a picture, use Save image.');
      return videoDraft(video);
    }
    case 'page':
      return pageDraft();
    case 'pointer': {
      const target = resolveTarget(pointer, message.srcUrl, message.mediaType);
      return target ? targetDraft(target) : pageDraft();
    }
  }
}

async function targetDraft(target: Target): Promise<Draft> {
  if (target.type === 'video') return videoDraft(target.el);
  if (target.type === 'element') {
    const rect = visibleRect(target.el);
    if (!rect) throw new Error('Nothing visible to save there.');
    return { kind: 'image', source: baseSource(), image: await cropVisible(rect) };
  }
  return {
    kind: 'image',
    title: target.el instanceof HTMLImageElement ? target.el.alt.trim() || undefined : undefined,
    source: { ...baseSource(), mediaUrl: target.url, textQuote: nearbyText(target.el) },
    image: await imageFromUrl(target.url, target.el),
  };
}

async function videoDraft(video: HTMLVideoElement): Promise<Draft> {
  const videoTime = video.currentTime;
  let image: CaptureImage;
  try {
    image = grabVideoFrame(video);
  } catch (e) {
    // A cross-origin video is only hidden from the page's code, not from the viewer: screenshot the player.
    // Copy-protected video stops here, as Chrome's own Save video frame does. Save what the site shows, never around it.
    if (!(e instanceof DOMException && e.name === 'SecurityError')) throw e;
    const rect = visibleRect(video);
    if (!rect) throw new Error('Scroll the video into view and try again.');
    image = await cropVisible(rect);
  }
  const src = video.currentSrc;
  return {
    kind: 'video_frame',
    source: { ...baseSource(), videoTime, mediaUrl: src && !src.startsWith('blob:') ? src : undefined },
    image,
  };
}

/**
 * Saving the page itself (an artist's profile or any other page) as a bookmark, with its share image when it
 * has one. Without one, what is on screen stands in, so every bookmark has a picture to recognise it by.
 */
async function pageDraft(): Promise<Draft> {
  const imageUrl = pageImageUrl();
  const shared = imageUrl ? await ask<CaptureImage>({ type: 'fetch-image', url: imageUrl }).catch(() => undefined) : undefined;
  const screen = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  const image = shared ?? (await cropVisible(screen, true).catch(() => undefined));
  const source = baseSource();
  const mediaUrl = shared ? imageUrl : undefined;
  return { kind: guessPageKind(), title: source.pageTitle, source: { ...source, mediaUrl }, image };
}

async function imageFromUrl(url: string, el: Element): Promise<CaptureImage> {
  try {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      // Only the page can read its own blob: URLs.
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      const image = { dataUrl: await blobToDataUrl(blob), width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return image;
    }
    return await ask<CaptureImage>({ type: 'fetch-image', url });
  } catch {
    const rect = visibleRect(el);
    if (!rect) throw new Error("Couldn't read that image.");
    return cropVisible(rect);
  }
}

function cropVisible(rect: { x: number; y: number; width: number; height: number }, thumbnail = false): Promise<CaptureImage> {
  return ask<CaptureImage>({ type: 'crop-visible', rect, viewport: { width: innerWidth, height: innerHeight }, thumbnail });
}

function afterRepaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))));
}

/** "Open source" from the app adds #otterpocket-t=83.40 on sites without a native time link; jump there. */
async function seekFromFragment(): Promise<void> {
  const time = parseSeekFragment(location.hash);
  if (time == null) return;
  history.replaceState(history.state, '', location.href.split('#')[0]);
  const deadline = Date.now() + 15_000;
  let video = await largestVideo();
  while (!video && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    video = await largestVideo();
  }
  if (!video) return;
  video.currentTime = time;
  video.pause();
  video.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
