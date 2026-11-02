import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  // WXT's default `.output` is hidden in Finder and in Chrome's "Load unpacked" picker.
  outDir: 'dist',
  // `npx wxt zip` writes dist/otter-pocket-<version>-chrome.zip, the file uploaded to the Chrome Web Store.
  zip: { name: 'otter-pocket' },
  manifest: {
    name: 'Otter Pocket',
    description: 'The web clipper for Otter Pocket, a reference board for artists: save images, video frames and pages, each linked to its source.',
    // The store asks why each one is needed: keep those answers in step with this list.
    permissions: ['contextMenus', 'storage', 'unlimitedStorage', 'alarms', 'scripting'],
    // Needed to read images from any site, screenshot the visible tab, and talk to the local app.
    host_permissions: ['<all_urls>'],
    // Chrome remembers the keys a user chose by these names, and the desktop app reads them: keep them once shipped.
    commands: {
      'capture-image': {
        suggested_key: { default: 'Alt+Shift+A' },
        description: 'Save image: click an image or video on the page to save it',
      },
      'capture-video-frame': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save the frame of the video that is playing',
      },
      // No key until the user picks one in chrome://extensions/shortcuts.
      'bookmark-page': {
        description: 'Save this page as a bookmark',
      },
      'capture-area': {
        description: 'Capture area: drag over part of the page to save it as a picture',
      },
    },
  },
});
