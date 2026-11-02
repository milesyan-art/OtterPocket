import { browser } from 'wxt/browser';
import type { CaptureImage, CaptureRequest, CollectionSummary, ItemKind, SourceInfo } from '@otterpocket/shared';

export type CaptureMode = 'pointer' | 'image' | 'video' | 'page' | 'area';

/** Background → content script. */
export interface BeginCaptureMessage {
  type: 'begin-capture';
  mode: CaptureMode;
  /** From the context menu: the image or video the user right-clicked, when Chrome knows it. */
  srcUrl?: string;
  mediaType?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Content script / popup → background. */
export type BackgroundMessage =
  | { type: 'get-status' }
  | { type: 'fetch-image'; url: string }
  /** `thumbnail`: a smaller JPEG, for a page's picture rather than a reference. */
  | { type: 'crop-visible'; rect: Rect; viewport: { width: number; height: number }; thumbnail?: boolean }
  | { type: 'save-capture'; request: CaptureRequest }
  | { type: 'start-capture'; tabId: number; mode: CaptureMode }
  /** Replies with each command's keys, '' where none is set. */
  | { type: 'get-shortcuts' };

export interface StatusResponse {
  /** Whether the desktop app answered just now. */
  online: boolean;
  collections: CollectionSummary[];
  lastTargetId: string;
  queued: number;
}

export interface SaveResponse {
  result: 'saved' | 'queued';
  targetName: string;
}

/** What the save panel is about to send, before the user picks a target and writes why. */
export interface Draft {
  kind: ItemKind;
  title?: string;
  source: SourceInfo;
  image?: CaptureImage;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

/** Sends a message to the background and unwraps its Reply. */
export async function ask<T>(message: BackgroundMessage): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as Reply<T> | undefined;
  if (!reply) throw new Error('The extension did not answer. Try reloading the page.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
