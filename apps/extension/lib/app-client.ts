import { browser } from 'wxt/browser';
import {
  APP_ORIGIN,
  VAULT_ID,
  type AppStatus,
  type CaptureRequest,
  type CaptureResponse,
  type CollectionSummary,
  type ExtensionHello,
} from '@otterpocket/shared';
import type { SaveResponse, StatusResponse } from './messages';

/**
 * Talks to the desktop app's local server. When the app is closed, captures wait in
 * chrome.storage (unlimitedStorage) and are sent the next time it answers.
 */

const QUEUE_KEY = 'queue';
const COLLECTIONS_KEY = 'collections';
const LAST_TARGET_KEY = 'lastTargetId';
const FALLBACK_COLLECTIONS: CollectionSummary[] = [{ id: VAULT_ID, parentId: null, kind: 'vault', name: 'Vault' }];

interface QueuedCapture {
  id: string;
  request: CaptureRequest;
  queuedAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function fetchStatus(): Promise<AppStatus | null> {
  try {
    const res = await fetch(`${APP_ORIGIN}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const status = (await res.json()) as AppStatus;
    await browser.storage.local.set({ [COLLECTIONS_KEY]: status.collections });
    return status;
  } catch {
    return null;
  }
}

/**
 * Tells the app this extension is installed and which shortcuts Chrome gave it, so the app can say
 * whether capturing will work. Then sends anything that waited while the app was closed.
 */
export async function checkIn(): Promise<void> {
  const commands = await browser.commands.getAll();
  const hello: ExtensionHello = {
    version: browser.runtime.getManifest().version,
    shortcuts: Object.fromEntries(commands.filter((c) => c.name).map((c) => [c.name!, c.shortcut ?? ''])),
  };
  try {
    const res = await fetch(`${APP_ORIGIN}/api/hello`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hello),
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) await flushQueue();
  } catch {
    // The app is closed; the next check-in will try again.
  }
}

export async function getStatus(): Promise<StatusResponse> {
  const status = await fetchStatus();
  if (status) void flushQueue();
  const stored = await browser.storage.local.get([COLLECTIONS_KEY, LAST_TARGET_KEY, QUEUE_KEY]);
  return {
    online: status !== null,
    collections: status?.collections ?? (stored[COLLECTIONS_KEY] as CollectionSummary[] | undefined) ?? FALLBACK_COLLECTIONS,
    lastTargetId: (stored[LAST_TARGET_KEY] as string | undefined) ?? VAULT_ID,
    queued: ((stored[QUEUE_KEY] as QueuedCapture[] | undefined) ?? []).length,
  };
}

async function post(request: CaptureRequest): Promise<CaptureResponse> {
  const res = await fetch(`${APP_ORIGIN}/api/captures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new HttpError(res.status, body.error ?? res.statusText);
  }
  return (await res.json()) as CaptureResponse;
}

export async function saveCapture(request: CaptureRequest): Promise<SaveResponse> {
  await browser.storage.local.set({ [LAST_TARGET_KEY]: request.targetId });
  try {
    const saved = await post(request);
    return { result: 'saved', targetName: saved.targetName };
  } catch (e) {
    // The app answered and refused this capture; retrying later would not help.
    if (e instanceof HttpError && e.status < 500) throw e;
    await withQueue((queue) => [...queue, { id: crypto.randomUUID(), request, queuedAt: Date.now() }]);
    const stored = await browser.storage.local.get(COLLECTIONS_KEY);
    const collections = (stored[COLLECTIONS_KEY] as CollectionSummary[] | undefined) ?? FALLBACK_COLLECTIONS;
    return { result: 'queued', targetName: collections.find((c) => c.id === request.targetId)?.name ?? 'Vault' };
  }
}

let flushing: Promise<void> | null = null;

/** Sends queued captures in order, stopping at the first one the app cannot take right now. */
export function flushQueue(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (;;) {
        const [next] = await withQueue((queue) => queue);
        if (!next) break;
        try {
          await post(next.request);
        } catch (e) {
          if (!(e instanceof HttpError && e.status < 500)) break; // app offline: try again later
          console.warn('Otter Pocket: dropping a queued capture the app rejected:', e.message);
        }
        await withQueue((queue) => queue.filter((q) => q.id !== next.id));
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

let queueLock: Promise<unknown> = Promise.resolve();

/** Read-modify-write of the queue, serialized so concurrent saves and flushes don't lose items. */
function withQueue(update: (queue: QueuedCapture[]) => QueuedCapture[]): Promise<QueuedCapture[]> {
  const run = queueLock.then(async () => {
    const stored = await browser.storage.local.get(QUEUE_KEY);
    const queue = (stored[QUEUE_KEY] as QueuedCapture[] | undefined) ?? [];
    const next = update(queue);
    if (next !== queue) await browser.storage.local.set({ [QUEUE_KEY]: next });
    await browser.action.setBadgeText({ text: next.length ? String(next.length) : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#8fb3ff' });
    return next;
  });
  queueLock = run.catch(() => undefined);
  return run;
}
