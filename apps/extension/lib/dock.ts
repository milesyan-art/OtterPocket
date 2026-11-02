import { browser } from 'wxt/browser';
import otterIcon from '../public/icon/48.png?inline';
import { ACTIONS } from './actions';
import { ask, type CaptureMode } from './messages';
import { largestVideo } from './page';
import { CAPTURE_TAG, showMessage } from './panel';
import { getSettings, onSettingsChanged, setHiddenOn, updateSettings, type Settings } from './settings';
import { ICONS, el, icon, keycaps } from './ui';

const DOCK_TAG = 'otter-pocket-dock';
/** Where the user last dragged the button to, as a fraction of the window's height. Per computer: screens differ. */
const POSITION_KEY = 'dockPosition';
/** Below the middle: clear of site headers and the save panel at the top, and of chat bubbles in the corner. */
const DEFAULT_POSITION = 0.6;
const TAB_HEIGHT = 46;
/** Long enough that passing over the button on the way to the scrollbar doesn't open the menu. */
const OPEN_DELAY = 80;
const CLOSE_DELAY = 300;
/** Smaller windows (sign-in popups, narrow side windows) have no room to spare. */
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;

const STYLE = `
:host { all: initial; }
@media print { :host { display: none !important; } }
* { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
[hidden] { display: none !important; }
button { margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.dock { position: fixed; right: 0; z-index: 2147483646; width: 42px; height: ${TAB_HEIGHT}px; }
.tab {
  position: absolute; inset: 0; display: grid; place-items: center; border-radius: 10px 0 0 10px; touch-action: none;
  background: #16191f; box-shadow: 0 2px 10px rgba(0,0,0,.28), inset 0 0 0 1px rgba(255,255,255,.08);
}
.tab img { width: 30px; height: 30px; border-radius: 7px; pointer-events: none; -webkit-user-drag: none; }
.tab:focus-visible { outline: 2px solid #8fb3ff; outline-offset: 2px; }
.dock.dragging .tab { cursor: grabbing; }
.menu {
  position: absolute; right: calc(100% + 8px); width: 268px; padding: 4px 6px 6px; border-radius: 12px;
  background: #1a1a1e; color: #ececf0; border: 1px solid #3a3a42; box-shadow: 0 14px 40px rgba(0,0,0,.4);
  font-size: 13px; line-height: 1.3; animation: in 90ms cubic-bezier(.2,.9,.3,1);
}
/* Bridges the gap to the button, so the pointer can cross it without the menu closing. */
.menu::after { content: ""; position: absolute; top: 0; bottom: 0; left: 100%; width: 10px; }
@keyframes in { from { opacity: 0; transform: translateX(3px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .menu { animation: none; } }
.title { padding: 7px 8px 5px; color: #7c7c87; font-size: 11px; font-weight: 600; }
.item { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border-radius: 7px; text-align: left; }
.item svg { width: 16px; height: 16px; flex: none; color: #a3a3ae; }
.item .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item:hover, .item:focus-visible { background: #2a2a31; outline: none; }
.item:hover svg, .item:focus-visible svg { color: #ececf0; }
.item:disabled { opacity: .4; background: none; cursor: default; }
.item.quiet { color: #a3a3ae; font-size: 12.5px; }
.keys { display: flex; gap: 3px; }
kbd {
  min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; border: 1px solid #3a3a42; background: #232328;
  color: #a3a3ae; font: 500 11px/16px Inter, -apple-system, BlinkMacSystemFont, sans-serif; text-align: center;
}
.sep { height: 1px; margin: 5px 2px; background: #2a2a31; }
`;

export interface Dock {
  /** Steps aside while a capture is running, so it is never in a screenshot. True when it was showing. */
  setBusy(busy: boolean): boolean;
}

/**
 * The floating button: an Otter Pocket tab at the right edge, next to the scrollbar, off until the user turns it on.
 * Clicking it starts Save image; resting on it opens the other ways to save and a way to hide it. It can be
 * dragged up and down, out of the way of a site's own controls.
 */
export function createDock(run: (mode: CaptureMode) => void): Dock {
  const host = document.createElement(DOCK_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  // Our clicks and keys are ours: a site shouldn't close its own menus or run hotkeys because of them.
  for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'click'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const tab = el('button', { className: 'tab', type: 'button', ariaLabel: 'Otter Pocket: save image', ariaHasPopup: 'menu' });
  tab.append(el('img', { src: otterIcon, alt: '', draggable: false }));
  const menu = el('div', { className: 'menu', role: 'menu', ariaLabel: 'Otter Pocket' });
  menu.hidden = true;
  const dock = el('div', { className: 'dock' }, menu, tab);
  root.append(el('style', { textContent: STYLE }), dock);

  const item = (path: string, label: string, onClick: () => void) => {
    const button = el('button', { className: 'item', type: 'button', role: 'menuitem' }, icon(path), el('span', { className: 'label', textContent: label }));
    button.addEventListener('click', () => {
      closeMenu();
      onClick();
    });
    return button;
  };
  const actions = ACTIONS.map((action) => {
    const button = item(action.icon, action.label, () => run(action.mode));
    const keys = el('span', { className: 'keys' });
    button.append(keys);
    return { action, button, keys };
  });
  const video = actions.find(({ action }) => action.mode === 'video')!.button;
  const hideHere = item(ICONS.hide, 'Hide on this site', async () => {
    await setHiddenOn(location.hostname, true);
    showMessage(`The floating button is hidden on ${location.hostname}. To show it again, use the Otter Pocket button in Chrome's toolbar.`, 'info');
  });
  const turnOff = item(ICONS.power, 'Turn off floating button', async () => {
    await updateSettings({ floatingButton: false });
    showMessage("The floating button is off. To turn it on again, use the Otter Pocket button in Chrome's toolbar.", 'info');
  });
  hideHere.classList.add('quiet');
  turnOff.classList.add('quiet');
  menu.append(
    el('div', { className: 'title', textContent: 'Otter Pocket' }),
    ...actions.map(({ button }) => button),
    el('div', { className: 'sep' }),
    hideHere,
    turnOff,
  );

  // Showing and hiding.
  let settings: Settings | null = null;
  let busy = false;
  let position = DEFAULT_POSITION;
  const wanted = () =>
    settings !== null &&
    settings.floatingButton &&
    !settings.hiddenSites.includes(location.hostname) &&
    !busy &&
    !document.documentElement.querySelector(`:scope > ${CAPTURE_TAG}`) &&
    innerWidth >= MIN_WIDTH &&
    innerHeight >= MIN_HEIGHT;
  const captureWatcher = new MutationObserver(() => update());
  const update = () => {
    const show = wanted();
    if (show && !host.isConnected) {
      document.documentElement.append(host);
    } else if (!show && host.isConnected) {
      closeMenu();
      host.remove();
    }
    if (show) place();
    if (settings?.floatingButton) captureWatcher.observe(document.documentElement, { childList: true });
    else captureWatcher.disconnect();
  };
  const place = () => {
    dock.style.top = `${clamp(position * innerHeight - TAB_HEIGHT / 2, 8, innerHeight - TAB_HEIGHT - 8)}px`;
  };

  // Only HTML pages: an SVG or XML document opened on its own can't show our element.
  if (document.documentElement instanceof HTMLHtmlElement) {
    void Promise.all([getSettings(), browser.storage.local.get(POSITION_KEY)]).then(([loaded, stored]) => {
      settings = loaded;
      position = (stored[POSITION_KEY] as number | undefined) ?? DEFAULT_POSITION;
      update();
    });
    onSettingsChanged((next) => {
      settings = next;
      update();
    });
    window.addEventListener('resize', update, { passive: true });
  }

  // The menu: opens after resting on the button, closes shortly after leaving it.
  let openTimer = 0;
  let closeTimer = 0;
  let shortcutsLoaded = false;
  const openMenu = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!menu.hidden || dock.classList.contains('dragging')) return;
    // Settles within a frame, while the menu is still fading in.
    void largestVideo().then((found) => {
      video.disabled = found === null;
      video.title = found ? '' : 'No video on screen';
    });
    menu.hidden = false;
    dock.classList.add('open');
    tab.ariaExpanded = 'true';
    const height = menu.offsetHeight;
    const dockTop = dock.getBoundingClientRect().top;
    menu.style.top = `${clamp(dockTop + TAB_HEIGHT / 2 - height / 2, 8, innerHeight - height - 8) - dockTop}px`;
    window.addEventListener('pointerdown', onOutside, true);
    if (!shortcutsLoaded) {
      shortcutsLoaded = true;
      ask<Record<string, string>>({ type: 'get-shortcuts' }).then(
        (shortcuts) => actions.forEach(({ action, keys }) => keys.replaceChildren(...keycaps(shortcuts[action.command]))),
        () => (shortcutsLoaded = false),
      );
    }
  };
  const closeMenu = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    menu.hidden = true;
    dock.classList.remove('open');
    tab.ariaExpanded = 'false';
    window.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (e: PointerEvent) => {
    if (!e.composedPath().includes(host)) closeMenu();
  };
  tab.addEventListener('pointerenter', () => {
    clearTimeout(closeTimer);
    openTimer = window.setTimeout(openMenu, OPEN_DELAY);
  });
  dock.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  dock.addEventListener('pointerleave', () => {
    clearTimeout(openTimer);
    closeTimer = window.setTimeout(closeMenu, CLOSE_DELAY);
  });
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      openMenu();
      actions[0]!.button.focus();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.item:not(:disabled)')];
    const at = items.indexOf(root.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      closeMenu();
      tab.focus();
    }
  });
  dock.addEventListener('focusout', (e) => {
    if (!dock.contains(e.relatedTarget as Node | null)) closeMenu();
  });

  // Click to capture; drag to move.
  let drag: { startY: number; startTop: number; moved: boolean } | null = null;
  let dragged = false;
  tab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { startY: e.clientY, startTop: dock.getBoundingClientRect().top, moved: false };
    tab.setPointerCapture(e.pointerId);
  });
  tab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      closeMenu();
      dock.classList.add('dragging');
    }
    const top = clamp(drag.startTop + dy, 8, innerHeight - TAB_HEIGHT - 8);
    dock.style.top = `${top}px`;
    position = (top + TAB_HEIGHT / 2) / innerHeight;
  });
  tab.addEventListener('pointerup', () => {
    dragged = drag?.moved ?? false;
    drag = null;
    if (!dragged) return;
    dock.classList.remove('dragging');
    void browser.storage.local.set({ [POSITION_KEY]: position });
  });
  tab.addEventListener('click', () => {
    if (dragged) {
      dragged = false;
      return;
    }
    closeMenu();
    run('image');
  });

  return {
    setBusy(next) {
      const wasShowing = host.isConnected;
      busy = next;
      update();
      return wasShowing && !host.isConnected;
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
