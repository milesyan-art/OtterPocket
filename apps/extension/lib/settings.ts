import { browser } from 'wxt/browser';

/** The user's choices, kept in Chrome's synced storage so they follow them to their other computers. */
export interface Settings {
  /** The Otter Pocket button by the scrollbar of every page. Off until the user turns it on. */
  floatingButton: boolean;
  /** Hostnames where the user hid the floating button. */
  hiddenSites: string[];
}

const DEFAULTS: Settings = { floatingButton: false, hiddenSites: [] };
const KEYS = Object.keys(DEFAULTS);

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEYS);
  return { ...DEFAULTS, ...stored } as Settings;
}

export function updateSettings(change: Partial<Settings>): Promise<void> {
  return browser.storage.sync.set(change);
}

export function onSettingsChanged(listener: (settings: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && KEYS.some((key) => key in changes)) void getSettings().then(listener);
  });
}

export async function setHiddenOn(site: string, hidden: boolean): Promise<void> {
  const others = (await getSettings()).hiddenSites.filter((s) => s !== site);
  await updateSettings({ hiddenSites: hidden ? [...others, site] : others });
}
