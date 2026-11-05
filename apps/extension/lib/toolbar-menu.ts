import { ACTIONS } from './actions';
import { ask, type CaptureMode, type StatusResponse } from './messages';
import { largestVideo } from './page';
import { createHost } from './panel';
import { getSettings, setHiddenOn, updateSettings } from './settings';
import { ICONS, MENU_STYLE, el, icon, keycaps } from './ui';

const STYLE = `
:host { all: initial; }
@media print { :host { display: none !important; } }
* { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
[hidden] { display: none !important; }
button { margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
${MENU_STYLE}
/* At the top right, just under Chrome's toolbar and the Otter Pocket button in it. */
.menu { position: fixed; top: 8px; right: 8px; z-index: 2147483647; outline: none; animation: in 90ms cubic-bezier(.2,.9,.3,1); }
@keyframes in { from { opacity: 0; transform: translateY(-3px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .menu { animation: none; } }
.head { display: flex; align-items: center; gap: 8px; padding: 7px 8px 5px; }
.head .title { flex: 1; padding: 0; }
.status { display: flex; align-items: center; gap: 6px; color: #7c7c87; font-size: 11px; }
.status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #7c7c87; }
.status.online::before { background: #6fd39b; }
.status.offline::before { background: #ffb98a; }
.aside { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.item .aside svg { width: 13px; height: 13px; }
.switch { position: relative; flex: none; width: 28px; height: 16px; border-radius: 8px; background: #3a3a42; }
.switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
}
/* Slides only when flipped, not when the saved setting first arrives: that one is already there. */
.switch { visibility: hidden; }
.known .switch { visibility: visible; }
.flipped .switch { transition: background .15s; }
.flipped .switch::after { transition: transform .15s; }
[aria-checked="true"] .switch { background: #8fb3ff; }
[aria-checked="true"] .switch::after { transform: translateX(12px); }
@media (prefers-reduced-motion: reduce) { .flipped .switch, .flipped .switch::after { transition: none; } }
.note { margin: 0 8px 4px 34px; color: #a3a3ae; font-size: 11.5px; }
.note button { color: #8fb3ff; }
.note button:hover { text-decoration: underline; }
.tip { padding: 2px 8px 0; color: #7c7c87; font-size: 11.5px; line-height: 1.35; }
.tip b { color: #a3a3ae; font-weight: 600; white-space: nowrap; }
`;

let open: { host: HTMLElement; close(): void } | null = null;

/**
 * The toolbar button's menu. It is drawn in the page, like the floating button's menu, rather than in Chrome's
 * popup window, whose frame Chrome draws: so the two menus look the same. Clicking the button again closes it,
 * as do Escape and a click anywhere else.
 */
export function toggleToolbarMenu(run: (mode: CaptureMode) => void): void {
  if (open?.host.isConnected) return open.close();
  open?.close();

  const { host, root } = createHost(STYLE);
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onOutside, true);
    host.remove();
    if (open?.host === host) open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onOutside = (e: PointerEvent) => {
    if (!e.composedPath().includes(host)) close();
  };
  open = { host, close };

  const item = (path: string, label: string, ...extra: Node[]) =>
    el('button', { className: 'item', type: 'button', role: 'menuitem' }, icon(path), el('span', { className: 'label', textContent: label }), ...extra);

  const status = el('span', { className: 'status', textContent: 'Checking…' });
  const actions = ACTIONS.map((action) => {
    const keys = el('span', { className: 'keys' });
    const button = item(action.icon, action.label, keys);
    button.addEventListener('click', () => {
      close();
      run(action.mode);
    });
    return { action, button, keys };
  });
  const video = actions.find(({ action }) => action.mode === 'video')!.button;

  const dockItem = item(ICONS.dock, 'Floating button', el('span', { className: 'switch' }));
  dockItem.role = 'menuitemcheckbox';
  dockItem.title = 'An Otter Pocket button beside the scrollbar on every page';
  dockItem.classList.add('quiet');
  const showHere = el('button', { type: 'button', textContent: 'Show here' });
  const note = el('div', { className: 'note' }, `Hidden on ${location.hostname}. `, showHere);
  note.hidden = true;
  const shortcuts = item(ICONS.keyboard, 'Keyboard shortcuts', el('span', { className: 'aside' }, 'Change', icon(ICONS.external)));
  shortcuts.classList.add('quiet');

  const menu = el(
    'div',
    { className: 'menu', role: 'menu', ariaLabel: 'Otter Pocket', tabIndex: -1 },
    el('div', { className: 'head' }, el('span', { className: 'title', textContent: 'Otter Pocket' }), status),
    ...actions.map(({ button }) => button),
    el('div', { className: 'sep' }),
    dockItem,
    note,
    shortcuts,
    el('div', { className: 'sep' }),
    el('div', { className: 'tip' }, 'Or right-click any image or video → ', el('b', { textContent: 'Save to Otter Pocket' })),
  );
  root.append(menu);
  menu.focus({ preventScroll: true });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onOutside, true);

  ask<StatusResponse>({ type: 'get-status' }).then(
    (s) => {
      status.classList.add(s.online ? 'online' : 'offline');
      status.textContent = s.online ? 'Connected' : s.queued ? `App closed · ${s.queued} waiting` : 'App closed';
      status.title = s.online ? 'The Otter Pocket app is open and receiving' : 'Captures wait here until the Otter Pocket app opens';
    },
    () => (status.textContent = 'Unavailable'),
  );
  ask<Record<string, string>>({ type: 'get-shortcuts' }).then(
    (keys) => actions.forEach(({ action, keys: slot }) => slot.replaceChildren(...keycaps(keys[action.command]))),
    () => {},
  );
  void largestVideo().then((found) => {
    video.disabled = found === null;
    video.title = found ? '' : 'No video on screen';
  });

  // The floating button, and a way back on a site where it was hidden from its own menu.
  let floating = false;
  let hiddenHere = false;
  const showSetting = () => {
    dockItem.ariaChecked = String(floating);
    note.hidden = !(floating && hiddenHere);
  };
  void getSettings().then((settings) => {
    floating = settings.floatingButton;
    hiddenHere = settings.hiddenSites.includes(location.hostname);
    showSetting();
    dockItem.classList.add('known');
  });
  dockItem.addEventListener('click', () => {
    dockItem.classList.add('flipped');
    floating = !floating;
    showSetting();
    void updateSettings({ floatingButton: floating });
  });
  showHere.addEventListener('click', () => {
    hiddenHere = false;
    showSetting();
    void setHiddenOn(location.hostname, false);
  });
  shortcuts.addEventListener('click', () => {
    close();
    void ask({ type: 'open-shortcuts' });
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.item:not(:disabled)')];
    const at = items.indexOf(root.activeElement as HTMLButtonElement);
    const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  });
}
