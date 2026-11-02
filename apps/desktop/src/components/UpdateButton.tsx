import { useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Icon } from './Icon';

/** The first look waits a little, so it never slows the app down while it opens. */
const FIRST_CHECK_MS = 10_000;
/** How often an app that stays open looks again. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type State =
  | { kind: 'none' }
  | { kind: 'ready'; update: Update }
  | { kind: 'installing'; update: Update; progress: number | null }
  | { kind: 'failed'; update: Update; reason: string };

/**
 * "Update to 0.1.2" at the foot of the sidebar once a newer version is published. One click downloads it,
 * checks its signature against the key built into this app, installs it and reopens the app.
 */
export function UpdateButton() {
  const [state, setState] = useState<State>({ kind: 'none' });
  const found = useRef<Update | null>(null);

  useEffect(() => {
    // A development build isn't an installed app: there is nothing to replace.
    if (import.meta.env.DEV) return;
    let stopped = false;
    const look = async () => {
      if (found.current) return;
      try {
        const update = await check();
        if (!update) return;
        if (stopped || found.current) {
          void update.close();
          return;
        }
        found.current = update;
        setState({ kind: 'ready', update });
      } catch {
        // Offline, or the update feed couldn't be read: look again next time without bothering anyone.
      }
    };
    const first = window.setTimeout(look, FIRST_CHECK_MS);
    const timer = window.setInterval(look, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  if (state.kind === 'none') return null;
  const { update } = state;

  const install = async () => {
    setState({ kind: 'installing', update, progress: null });
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress' && total > 0) {
          received += event.data.chunkLength;
          setState({ kind: 'installing', update, progress: received / total });
        }
      });
      await relaunch();
    } catch (e) {
      setState({ kind: 'failed', update, reason: String(e) });
    }
  };

  if (state.kind === 'installing') {
    return (
      <button className="update-button" disabled>
        {state.progress === null ? 'Updating…' : `Updating… ${Math.round(state.progress * 100)}%`}
      </button>
    );
  }
  if (state.kind === 'failed') {
    return (
      <button className="update-button failed" onClick={() => void install()} title={state.reason}>
        Couldn't update. Try again
      </button>
    );
  }
  return (
    <button className="update-button" onClick={() => void install()} title={update.body || undefined}>
      <Icon name="download" size={15} />
      Update to {update.version}
    </button>
  );
}
