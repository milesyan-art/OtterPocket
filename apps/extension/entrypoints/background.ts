import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { CHECK_IN_SECONDS } from '@otterpocket/shared';
import { ACTIONS } from '../lib/actions';
import { checkIn, getStatus, saveCapture } from '../lib/app-client';
import { cropScreenshot, imageFromBlob } from '../lib/images';
import type { BackgroundMessage, BeginCaptureMessage, CaptureMode, PageMessage, Reply } from '../lib/messages';

const MENU_ID = 'save-to-otter-pocket';
const CHECK_IN_ALARM = 'check-in';
/** Chrome's own popup, for the pages Chrome won't let an extension draw on. */
const FALLBACK_POPUP = 'toolbar-popup.html';

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_ID,
      title: 'Save to Otter Pocket',
      contexts: ['image', 'video', 'page', 'link', 'selection'],
    });
    // The app shows the extension as connected straight away, not at the next alarm.
    void checkIn();
  });

  void browser.alarms.create(CHECK_IN_ALARM, { periodInMinutes: CHECK_IN_SECONDS / 60 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CHECK_IN_ALARM) void checkIn();
  });
  browser.runtime.onStartup.addListener(() => void checkIn());

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id == null) return;
    void startCapture(tab.id, 'pointer', info.srcUrl, info.mediaType);
  });

  // The toolbar button opens our menu in the page, like the floating button's. Chrome's own pages and the
  // Web Store can't be drawn on, so there it opens Chrome's popup instead, until the tab goes somewhere else.
  browser.action.onClicked.addListener((tab) => void openToolbarMenu(tab));
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading') void browser.action.setPopup({ tabId, popup: '' });
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const mode = ACTIONS.find((action) => action.command === command)?.mode;
    if (mode && tab?.id != null) void startCapture(tab.id, mode);
  });

  browser.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
    handle(message, sender).then(
      (value) => sendResponse({ ok: true, value } satisfies Reply<unknown>),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply<unknown>),
    );
    return true; // keep the channel open for the async reply
  });
});

async function handle(message: BackgroundMessage, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'get-status':
      return getStatus();
    case 'fetch-image': {
      // The background can read cross-origin images that the page itself could not.
      const res = await fetch(message.url, { credentials: 'include', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Image request failed (${res.status})`);
      return imageFromBlob(await res.blob());
    }
    case 'crop-visible': {
      const windowId = sender.tab?.windowId;
      if (windowId == null) throw new Error('No tab to capture');
      const screenshot = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
      return cropScreenshot(screenshot, message.rect, message.viewport.width, message.thumbnail);
    }
    case 'save-capture':
      return saveCapture(message.request);
    case 'start-capture':
      return startCapture(message.tabId, message.mode);
    case 'open-shortcuts':
      // Shortcuts belong to Chrome: only its own page can change them, or remove one that clashes with a site's.
      await browser.tabs.create({ url: 'chrome://extensions/shortcuts', index: (sender.tab?.index ?? -1) + 1 });
      return null;
    case 'get-shortcuts': {
      // Content scripts can't read commands themselves.
      const commands = await browser.commands.getAll();
      return Object.fromEntries(commands.filter((c) => c.name).map((c) => [c.name!, c.shortcut ?? '']));
    }
  }
}

async function startCapture(tabId: number, mode: CaptureMode, srcUrl?: string, mediaType?: string): Promise<void> {
  const message: BeginCaptureMessage = { type: 'begin-capture', mode, srcUrl, mediaType };
  await sendToPage(tabId, message);
}

async function openToolbarMenu(tab: Browser.tabs.Tab): Promise<void> {
  if (tab.id == null) return;
  try {
    await sendToPage(tab.id, { type: 'toggle-menu' });
  } catch {
    // Set for this tab only: if Chrome won't open it now, the next click on the button does.
    await browser.action.setPopup({ tabId: tab.id, popup: FALLBACK_POPUP });
    await browser.action.openPopup({ windowId: tab.windowId }).catch(() => {});
  }
}

async function sendToPage(tabId: number, message: PageMessage): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // Tabs that were open before the extension was installed have no content script yet.
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
    await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  }
}
