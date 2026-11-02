import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { CHECK_IN_SECONDS } from '@otterpocket/shared';
import { ACTIONS } from '../lib/actions';
import { checkIn, getStatus, saveCapture } from '../lib/app-client';
import { cropScreenshot, imageFromBlob } from '../lib/images';
import type { BackgroundMessage, BeginCaptureMessage, CaptureMode, Reply } from '../lib/messages';

const MENU_ID = 'save-to-otter-pocket';
const CHECK_IN_ALARM = 'check-in';

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
    case 'get-shortcuts': {
      // Content scripts can't read commands themselves.
      const commands = await browser.commands.getAll();
      return Object.fromEntries(commands.filter((c) => c.name).map((c) => [c.name!, c.shortcut ?? '']));
    }
  }
}

async function startCapture(tabId: number, mode: CaptureMode, srcUrl?: string, mediaType?: string): Promise<void> {
  const message: BeginCaptureMessage = { type: 'begin-capture', mode, srcUrl, mediaType };
  try {
    await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // Tabs that were open before the extension was installed have no content script yet.
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
    await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  }
}
