// Points the download links at the files in the newest GitHub release and shows its version and size, so a
// new release needs no change to the page. Without JavaScript, or if GitHub doesn't answer, the links stay on
// the release page, which works too. The repository comes from the download button's link in index.html.

// When the Chrome Web Store approves the extension, put its page's address here: step 2 then shows
// "Add to Chrome" instead of the steps for adding it by hand.
const CHROME_WEB_STORE = '';

const download = document.getElementById('download');
const repo = new URL(download.href).pathname.split('/').slice(1, 3).join('/');

function show(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.hidden = false;
}

function megabytes(bytes) {
  const mb = bytes / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

async function useLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  if (res.status === 404) {
    // Nothing released yet. Drafts and pre-releases don't count as the latest release.
    download.removeAttribute('href');
    download.classList.add('is-soon');
    download.querySelector('.label').textContent = 'Coming soon';
    return;
  }
  if (!res.ok) return; // e.g. GitHub's hourly limit for this visitor: keep the release-page links
  const release = await res.json();
  const dmg = release.assets.find((a) => a.name.endsWith('.dmg'));
  const extension = release.assets.find((a) => a.name.endsWith('-chrome.zip'));
  if (dmg) {
    download.href = dmg.browser_download_url;
    show('release-version', `Version ${release.tag_name.replace(/^v/, '')}`);
    show('release-size', megabytes(dmg.size));
  }
  if (extension) document.getElementById('extension-zip').href = extension.browser_download_url;
}

// Phones, tablets and PCs get a note; an iPad asking for the desktop site says "Macintosh" but has touch.
const onMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
document.getElementById('not-mac').hidden = onMac;

if (CHROME_WEB_STORE) {
  document.getElementById('chrome-store').href = CHROME_WEB_STORE;
  document.getElementById('extension-store').hidden = false;
  document.getElementById('extension-manual').hidden = true;
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  });
}

useLatestRelease().catch(() => {});
