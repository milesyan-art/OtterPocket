import { siteName, type CaptureImage, type ItemKind, type SourceInfo } from '@otterpocket/shared';
import type { Rect } from './messages';

/** What sits under the pointer, looking through the invisible overlays many sites put over images. */
export type Target =
  | { type: 'video'; el: HTMLVideoElement }
  | { type: 'image'; el: Element; url: string }
  /** Canvas, SVG and other things we can only screenshot. */
  | { type: 'element'; el: Element };

export interface Point {
  x: number;
  y: number;
}

export function resolveTarget(point: Point, srcUrl?: string, mediaType?: string): Target | null {
  for (const el of document.elementsFromPoint(point.x, point.y)) {
    if (el === document.body || el === document.documentElement) break;
    if (el.localName.startsWith('otter-pocket-')) continue; // our own overlay and button
    if (el instanceof HTMLVideoElement && el.videoWidth > 0) return { type: 'video', el };
    if (el instanceof HTMLImageElement && (el.currentSrc || el.src)) return { type: 'image', el, url: bestImageUrl(el) };
    if (el instanceof HTMLCanvasElement || el instanceof SVGSVGElement) return { type: 'element', el };
    const background = backgroundImageUrl(el);
    if (background) return { type: 'image', el, url: background };
  }
  // e.g. an image inside an iframe: Chrome still told us its URL.
  if (srcUrl && mediaType === 'image') return { type: 'image', el: document.body, url: srcUrl };
  return null;
}

/** The video under the pointer, or else the biggest one on screen (preferring one that is playing). */
export async function findMainVideo(point: Point): Promise<HTMLVideoElement | null> {
  const under = document.elementsFromPoint(point.x, point.y).find((el) => el instanceof HTMLVideoElement);
  if (under instanceof HTMLVideoElement && under.videoWidth > 0) return under;
  return largestVideo();
}

/**
 * The biggest video that can be seen, preferring one that is playing. Being inside the window isn't enough:
 * a carousel (an Instagram post with several pictures) keeps its other slides beside the one shown and
 * crops them away, and a video slide there must not count while a picture is showing.
 */
export async function largestVideo(): Promise<HTMLVideoElement | null> {
  const videos = [...document.querySelectorAll('video')].filter(
    (video) => video.videoWidth > 0 && video.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
  );
  const shown = await shownRects(videos);
  const screen = innerWidth * innerHeight;
  let best: HTMLVideoElement | null = null;
  let bestScore = 0;
  for (const video of videos) {
    const r = shown.get(video);
    const area = r ? r.width * r.height : 0;
    const box = video.getBoundingClientRect();
    // Mostly out of sight is the edge of something else (a neighbouring slide), unless it is bigger than the screen.
    if (area === 0 || (area < (box.width * box.height) / 2 && area < screen / 2)) continue;
    const score = area * (video.paused ? 1 : 4);
    if (score > bestScore) {
      best = video;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The part of each element that can be seen, measured by Chrome itself: inside the window and inside every
 * box that crops what overflows it. Takes a frame; falls back to just the window if no frame comes.
 */
function shownRects(elements: Element[]): Promise<Map<Element, DOMRectReadOnly>> {
  if (elements.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const done = (rects: Map<Element, DOMRectReadOnly>) => {
      clearTimeout(timer);
      observer.disconnect();
      resolve(rects);
    };
    // The first report covers every element observed before it.
    const observer = new IntersectionObserver((entries) => done(new Map(entries.map((e) => [e.target, e.intersectionRect]))));
    const timer = setTimeout(() => {
      const rects = elements.map((el) => [el, visibleRect(el)] as const);
      done(new Map(rects.map(([el, r]) => [el, r ? new DOMRectReadOnly(r.x, r.y, r.width, r.height) : new DOMRectReadOnly()])));
    }, 500);
    elements.forEach((el) => observer.observe(el));
  });
}

/** The highest-resolution candidate from srcset / <picture>, not just the size the page happened to show. */
export function bestImageUrl(img: HTMLImageElement): string {
  let best = img.currentSrc || img.src;
  let bestValue = 0;
  const srcsets = [img.srcset, ...[...(img.closest('picture')?.querySelectorAll('source') ?? [])].map((s) => s.srcset)];
  for (const srcset of srcsets) {
    // Entries are separated by ", "; URLs themselves may contain bare commas (e.g. Cloudinary).
    for (const entry of (srcset ?? '').split(/,\s+/)) {
      const [url, descriptor = '1x'] = entry.trim().split(/\s+/);
      const value = parseFloat(descriptor);
      if (url && value > bestValue) {
        best = url;
        bestValue = value;
      }
    }
  }
  return new URL(best, document.baseURI).href;
}

function backgroundImageUrl(el: Element): string | null {
  const url = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage)?.[1];
  return url ? new URL(url, document.baseURI).href : null;
}

/** Draws the current frame at the video's native resolution. Throws if the page forbids it. */
export function grabVideoFrame(video: HTMLVideoElement): CaptureImage {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('The video has no frame to save yet.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(video, 0, 0, width, height);
  // A cross-origin video taints the canvas, so reading it back (looksBlack first) throws a SecurityError.
  if (looksBlack(canvas)) throw new Error("The frame came out black. If the video is copy-protected, its frames can't be saved.");
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/** Copy-protected video draws as solid black. */
function looksBlack(source: HTMLCanvasElement): boolean {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 16;
  const ctx = probe.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, 16, 16);
  const pixels = ctx.getImageData(0, 0, 16, 16).data;
  // Alpha is always opaque here, so any channel above near-black means a real picture.
  return pixels.every((value, i) => i % 4 === 3 || value <= 8);
}

/** The part of an element that is on screen, for screenshot fallbacks. */
export function visibleRect(el: Element): Rect | null {
  const r = el.getBoundingClientRect();
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  const width = Math.min(innerWidth, r.right) - x;
  const height = Math.min(innerHeight, r.bottom) - y;
  return width > 4 && height > 4 ? { x, y, width, height } : null;
}

/**
 * A few words of visible text next to the image (its caption, or the text just before it).
 * Becomes a #:~:text= link so "open source" scrolls straight to the image, not the top of the page.
 */
export function nearbyText(el: Element): string | undefined {
  const caption = el.closest('figure')?.querySelector('figcaption')?.textContent?.trim();
  const text = caption || precedingText(el);
  if (!text) return undefined;
  return text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ') || undefined;
}

function precedingText(el: Element): string | undefined {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      const ok =
        (node.textContent ?? '').trim().length >= 30 &&
        parent !== null &&
        !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName) &&
        parent.checkVisibility();
      return ok ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  walker.currentNode = el;
  return walker.previousNode()?.textContent ?? undefined;
}

function meta(name: string): string | undefined {
  const el = document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`);
  return el?.content?.trim() || undefined;
}

/** Where this document was first loaded, before any in-page navigation. */
const loadedUrl = performance.getEntriesByType('navigation')[0]?.name ?? location.href;

/**
 * The share tags in <head> (og:title, og:image…) describe the page as it was first loaded.
 * YouTube and other single-page sites move to the next video or post without reloading and
 * leave those tags behind, so only trust them while they still describe the current address.
 */
function headTagsAreCurrent(): boolean {
  if (describes(location.href, loadedUrl)) return true; // no in-page navigation since load
  const ogUrl = meta('og:url');
  return ogUrl !== undefined && describes(ogUrl, location.href);
}

/** Same path, and every query parameter of `url` (like YouTube's ?v=) has the same value in `other`. */
function describes(url: string, other: string): boolean {
  try {
    const a = new URL(url, document.baseURI);
    const b = new URL(other, document.baseURI);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '');
    return path(a) === path(b) && [...a.searchParams].every(([key, value]) => b.searchParams.get(key) === value);
  } catch {
    return false;
  }
}

export function pageImageUrl(): string | undefined {
  const url = headTagsAreCurrent() ? (meta('og:image') ?? meta('og:image:url') ?? meta('twitter:image')) : youTubeThumbnail();
  return url ? new URL(url, document.baseURI).href : undefined;
}

/** The thumbnail of the YouTube video open now: what its og:image would say after a reload. */
function youTubeThumbnail(): string | undefined {
  const onWatchPage = siteName(location.href).endsWith('youtube.com') && location.pathname === '/watch';
  const id = onWatchPage ? new URLSearchParams(location.search).get('v') : null;
  return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/maxresdefault.jpg` : undefined;
}

export function pageTitle(): string {
  return (headTagsAreCurrent() ? meta('og:title') : undefined) ?? documentTitle();
}

/** The tab title without an unread count or the site's name: "(3) Etude - YouTube" → "Etude". */
function documentTitle(): string {
  const title = document.title.replace(/^\(\d+\+?\)\s+/, '');
  const site = meta('og:site_name');
  const suffix = site && [' - ', ' | ', ' – ', ' — ', ' · '].map((sep) => sep + site).find((s) => title.endsWith(s));
  return (suffix ? title.slice(0, -suffix.length) : title).trim() || document.title;
}

const PROFILE_HOSTS = ['instagram.com', 'behance.net', 'artstation.com', 'dribbble.com', 'x.com', 'twitter.com', 'tiktok.com', 'vimeo.com', 'threads.net', 'cara.app'];

/** A profile page (one path segment on a portfolio/social site, or a YouTube @handle) is probably an artist. */
export function guessPageKind(): ItemKind {
  if (headTagsAreCurrent() && meta('og:type') === 'profile') return 'artist';
  const host = siteName(location.href);
  const segments = location.pathname.split('/').filter(Boolean);
  if (host.endsWith('youtube.com') && segments[0]?.startsWith('@')) return 'artist';
  if (PROFILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) && segments.length === 1) return 'artist';
  return 'article';
}

/** Where we are, with everything needed to come back. */
export function baseSource(): SourceInfo {
  return {
    pageUrl: location.href,
    pageTitle: pageTitle(),
    site: siteName(location.href),
    faviconUrl: faviconUrl(),
    originUrl: pinterestOrigin(),
  };
}

function faviconUrl(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]');
  return link?.href || new URL('/favicon.ico', location.origin).href;
}

/** A Pinterest pin links out to where the image really came from. Best effort: Pinterest's markup changes. */
function pinterestOrigin(): string | undefined {
  if (!/(^|\.)pinterest\./.test(location.hostname) || !location.pathname.startsWith('/pin/')) return undefined;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[rel~="nofollow"][href^="http"]')) {
    const host = new URL(a.href).hostname;
    if (!/pinterest\.|pinimg\.com$/.test(host) && a.checkVisibility()) return a.href;
  }
  return undefined;
}
