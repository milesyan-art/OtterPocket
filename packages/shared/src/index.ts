/**
 * The contract between the Chrome extension (capture) and the desktop app (library).
 * The Rust side mirrors these shapes in apps/desktop/src-tauri/src/models.rs.
 */

/** The desktop app listens here for captures from the extension. */
export const CAPTURE_PORT = 47600;
export const APP_ORIGIN = `http://127.0.0.1:${CAPTURE_PORT}`;

/** The built-in collection for lasting inspirations, independent of any project. */
export const VAULT_ID = 'vault';

/** Fragment key the extension reads to seek a video on sites that have no native time parameter. */
export const SEEK_FRAGMENT_KEY = 'otterpocket-t';

export type ItemKind = 'image' | 'video_frame' | 'artist' | 'article';
export type CollectionKind = 'vault' | 'folder' | 'project';

/**
 * Kinds are detected, never chosen, so labels must stay true when a guess is off: a saved page that isn't
 * clearly an artist's profile is just a "Page".
 */
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  image: 'Image',
  video_frame: 'Video frame',
  artist: 'Artist',
  article: 'Page',
};

/** Everything needed to get back to where a reference came from. */
export interface SourceInfo {
  pageUrl: string;
  pageTitle?: string;
  site?: string;
  faviconUrl?: string;
  /** Direct URL of the image or video file, when known. */
  mediaUrl?: string;
  /** Seconds into the video, for video frames. */
  videoTime?: number;
  /** Visible text near the image; becomes a #:~:text= fragment so the page scrolls to it. */
  textQuote?: string;
  /** Where a re-shared post (e.g. a Pinterest pin) originally came from. */
  originUrl?: string;
}

export interface CaptureImage {
  /** data:image/...;base64,... */
  dataUrl: string;
  width: number;
  height: number;
}

export interface CaptureRequest {
  /** VAULT_ID or a project id. Unknown ids fall back to the Vault. */
  targetId: string;
  kind: ItemKind;
  title?: string;
  why?: string;
  source: SourceInfo;
  image?: CaptureImage;
}

export interface CaptureResponse {
  itemId: string;
  targetId: string;
  targetName: string;
}

export interface CollectionSummary {
  id: string;
  parentId: string | null;
  kind: CollectionKind;
  name: string;
}

export interface AppStatus {
  app: 'otter-pocket';
  version: string;
  collections: CollectionSummary[];
}

/** How often the extension checks in with the app (POST /api/hello), so the app can show it is installed. */
export const CHECK_IN_SECONDS = 30;

/** What the extension says when it checks in. */
export interface ExtensionHello {
  version: string;
  /** Chrome command name → the keys assigned to it, '' when Chrome left it unassigned (a clash). */
  shortcuts: Record<string, string>;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

/** The URL that takes you back to the exact moment or spot a reference was captured from. */
export function buildReturnUrl(source: SourceInfo): string {
  let url: URL;
  try {
    url = new URL(source.pageUrl);
  } catch {
    return source.pageUrl;
  }

  if (source.videoTime != null && source.videoTime >= 0) {
    const seconds = Math.floor(source.videoTime);
    if (YOUTUBE_HOSTS.has(url.hostname)) {
      url.searchParams.set('t', `${seconds}s`);
    } else if (url.hostname === 'vimeo.com' || url.hostname.endsWith('.vimeo.com')) {
      url.hash = `t=${seconds}s`;
    } else if (!url.hash) {
      // Hash-routed apps would break if we replaced their fragment, so only add ours when there is none.
      url.hash = `${SEEK_FRAGMENT_KEY}=${source.videoTime.toFixed(2)}`;
    }
    return url.toString();
  }

  if (source.textQuote) {
    const base = url.toString();
    const separator = url.hash ? '' : '#';
    return `${base}${separator}:~:text=${encodeTextDirective(source.textQuote)}`;
  }

  return url.toString();
}

/** Text fragments use `-`, `,` and `&` as syntax, so those must be escaped too. */
export function encodeTextDirective(text: string): string {
  return encodeURIComponent(text).replace(/-/g, '%2D');
}

/** Reads the seek time our own fragment carries, e.g. `#otterpocket-t=83.40`. */
export function parseSeekFragment(hash: string): number | null {
  const match = new RegExp(`^#(?:.*&)?${SEEK_FRAGMENT_KEY}=([0-9]+(?:\\.[0-9]+)?)`).exec(hash);
  return match ? Number(match[1]) : null;
}

/** 83.4 -> "1:23", 3723 -> "1:02:03" */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** "www.newyorker.com" -> "newyorker.com" */
export function siteName(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return pageUrl;
  }
}
