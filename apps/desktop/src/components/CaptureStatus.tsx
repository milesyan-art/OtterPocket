import { useEffect, useReducer, useState } from 'react';
import { CHECK_IN_SECONDS } from '@otterpocket/shared';
import { api, onExtensionSeen, onServerStatus, type ExtensionContact, type LibraryInfo } from '../api';
import { Icon } from './Icon';

/** After this long without a check-in, Chrome has been closed or the extension removed. */
const STALE_MS = CHECK_IN_SECONDS * 5 * 1000;
/** How long a fresh app waits for the first check-in. Chrome before 120 checks in once a minute. */
const FIRST_CHECK_IN_MS = 75_000;

type State = 'connected' | 'looking' | 'missing' | 'offline';

const LABELS: Record<State, string> = {
  connected: 'Chrome connected',
  looking: 'Looking for Chrome…',
  missing: 'Chrome not connected',
  offline: "Can't receive captures",
};

/** The extension's commands (see wxt.config.ts), with the keys it suggests until Chrome says otherwise. */
const SHORTCUTS = [
  { command: 'capture-image', does: 'Save image: point at one and click', suggested: 'Alt+Shift+A' },
  { command: 'capture-video-frame', does: "Save the playing video's frame", suggested: 'Alt+Shift+S' },
];

/** Whether the Chrome extension is installed and reaching the app, and, on hover, how to save from Chrome. */
export function CaptureStatus({ library }: { library: LibraryInfo }) {
  const [contact, setContact] = useState<ExtensionContact | null>(null);
  // The server keeps trying a busy port, so this changes on its own once the other copy quits.
  const [serverError, setServerError] = useState(library.serverError);
  const [openedAt] = useState(Date.now);
  // Being connected wears off with time alone, so look again every few seconds.
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const keepNewest = (next: ExtensionContact | null) => setContact((c) => (next && (!c || next.at > c.at) ? next : c));
    api.extensionContact().then(keepNewest, () => undefined);
    const unlisten = onExtensionSeen(keepNewest);
    const unlistenServer = onServerStatus(setServerError);
    const timer = window.setInterval(tick, 5000);
    return () => {
      window.clearInterval(timer);
      void unlisten.then((stop) => stop());
      void unlistenServer.then((stop) => stop());
    };
  }, []);

  useEffect(() => setServerError(library.serverError), [library.serverError]);

  const now = Date.now();
  const state: State = serverError
    ? 'offline'
    : contact && now - contact.at < STALE_MS
      ? 'connected'
      : !contact && now - openedAt < FIRST_CHECK_IN_MS
        ? 'looking'
        : 'missing';
  const shortcuts = contact?.hello?.shortcuts;
  const unassigned = state === 'connected' && SHORTCUTS.some(({ command }) => shortcuts?.[command] === '');

  return (
    <div className={`capture-status ${state}`}>
      <span className="dot" />
      <span className="capture-label">{LABELS[state]}</span>
      <div className="capture-help">
        <button className={`help-button${unassigned ? ' attention' : ''}`} aria-label="How to save from Chrome" aria-describedby="capture-help">
          <Icon name="help" size={15} />
        </button>
        <div className="capture-popover" id="capture-help" role="tooltip">
          <div className="capture-card">
            {state === 'offline' && (
              <div className="capture-problem">
                <h4>Captures can't reach this app</h4>
                <p>Another copy of Otter Pocket may be open. Quit it, and this one connects by itself within a few seconds.</p>
                <p className="capture-detail">{serverError}</p>
              </div>
            )}
            {state === 'missing' && (
              <div className="capture-problem">
                <h4>Chrome isn't connected</h4>
                <p>
                  {contact
                    ? `Otter Pocket last heard from Chrome ${ago(contact.at)}. Open Chrome to save from the web.`
                    : 'Add the Otter Pocket web clipper to Chrome and keep Chrome open. It checks in with this app every 30 seconds.'}
                </p>
              </div>
            )}
            {state === 'looking' && (
              <div className="capture-problem">
                <p>Waiting for the web clipper to check in. This takes up to a minute after the app opens.</p>
              </div>
            )}

            <span className="capture-heading">Save from Chrome</span>
            <ul className="capture-steps">
              <li>
                <span className="capture-keys">Right-click</span>
                <span>
                  an image or video → <b>Save to Otter Pocket</b>
                </span>
              </li>
              {SHORTCUTS.map(({ command, does, suggested }) => {
                const keys = shortcuts ? shortcuts[command] : suggested;
                return (
                  <li key={command}>
                    <span className="capture-keys">
                      {keys ? keyNames(keys).map((key, i) => <kbd key={i}>{key}</kbd>) : <span className="unset">No shortcut</span>}
                    </span>
                    <span>{does}</span>
                  </li>
                );
              })}
            </ul>
            {unassigned && (
              <p className="capture-note">Chrome left a shortcut unset, usually because another extension uses those keys. Choose one at chrome://extensions/shortcuts.</p>
            )}
            {state === 'connected' && contact && (
              <p className="capture-foot">
                Otter Pocket for Chrome{contact.hello ? ` ${contact.hello.version}` : ''} · checked in {ago(contact.at)}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const MAC_KEYS: Record<string, string> = { Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Ctrl: '⌃', MacCtrl: '⌃' };

/** Chrome reports "Alt+Shift+S" on most systems and "⌥⇧S" on a Mac; both become one key per <kbd>. */
function keyNames(shortcut: string): string[] {
  return shortcut.includes('+') ? shortcut.split('+').map((key) => MAC_KEYS[key] ?? key) : Array.from(shortcut);
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(at: number): string {
  const seconds = (Date.now() - at) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return relative.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return relative.format(-Math.round(seconds / 3600), 'hour');
  return relative.format(-Math.round(seconds / 86400), 'day');
}
