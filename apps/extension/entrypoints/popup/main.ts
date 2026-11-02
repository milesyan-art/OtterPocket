import { browser } from 'wxt/browser';
import { ACTIONS } from '../../lib/actions';
import { ask, type StatusResponse } from '../../lib/messages';
import { getSettings, setHiddenOn, updateSettings } from '../../lib/settings';
import { ICONS, el, icon, keycaps, type IconName } from '../../lib/ui';

const statusEl = document.getElementById('status')!;
const actionsEl = document.getElementById('actions')!;
const problemEl = document.getElementById('problem')!;
const dockSwitch = document.getElementById('dock') as HTMLInputElement;
const dockNote = document.getElementById('dock-note')!;

for (const slot of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  slot.replaceWith(icon(ICONS[slot.dataset.icon as IconName]));
}

ask<StatusResponse>({ type: 'get-status' }).then(
  (status) => {
    statusEl.classList.add(status.online ? 'online' : 'offline');
    statusEl.textContent = status.online ? 'Connected' : status.queued ? `App closed · ${status.queued} waiting` : 'App closed';
    statusEl.title = status.online ? 'The Otter Pocket app is open and receiving' : 'Captures wait here until the Otter Pocket app opens';
  },
  () => (statusEl.textContent = 'Unavailable'),
);

void (async () => {
  const [[tab], commands, settings] = await Promise.all([
    browser.tabs.query({ active: true, currentWindow: true }),
    browser.commands.getAll(),
    getSettings(),
  ]);
  const shortcuts = new Map(commands.map((c) => [c.name, c.shortcut]));
  const url = tab?.url ? new URL(tab.url) : null;
  const capturable = tab?.id != null && url !== null && canCapture(url);

  for (const action of ACTIONS) {
    const row = el(
      'button',
      { className: 'row', type: 'button', disabled: !capturable },
      icon(action.icon),
      el('span', { className: 'label', textContent: action.label }),
      el('span', { className: 'keys' }, ...keycaps(shortcuts.get(action.command))),
    );
    row.addEventListener('click', async () => {
      try {
        await ask({ type: 'start-capture', tabId: tab!.id!, mode: action.mode });
        window.close();
      } catch {
        showProblem("Can't capture on this page. Try reloading it.");
      }
    });
    actionsEl.append(row);
  }
  if (!capturable) showProblem("Chrome doesn't let extensions capture on this page.");

  // The floating button, and a way back for a site where it was hidden from its own menu.
  const site = url && /^https?:$/.test(url.protocol) ? url.hostname : null;
  let hiddenHere = site !== null && settings.hiddenSites.includes(site);
  const showNote = () => {
    dockNote.hidden = !(dockSwitch.checked && hiddenHere);
    document.getElementById('dock-note-text')!.textContent = `Hidden on ${site}.`;
  };
  dockSwitch.checked = settings.floatingButton;
  showNote();
  dockSwitch.addEventListener('change', () => {
    void updateSettings({ floatingButton: dockSwitch.checked });
    showNote();
  });
  document.getElementById('show-here')!.addEventListener('click', async () => {
    if (!site) return;
    await setHiddenOn(site, false);
    hiddenHere = false;
    showNote();
  });
})();

// Shortcuts belong to Chrome: only its own page can change them, or remove one that clashes with a site's.
document.getElementById('shortcuts')!.addEventListener('click', () => {
  void browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

function showProblem(text: string): void {
  problemEl.textContent = text;
  problemEl.hidden = false;
}

/** Chrome keeps extensions off its own pages and the Web Store. */
function canCapture(url: URL): boolean {
  if (!/^(https?|file):$/.test(url.protocol)) return false;
  return url.hostname !== 'chromewebstore.google.com' && !(url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
}
