// Writes the two files the app's Update button reads, from a signed release build (npm run desktop:release):
// the update itself, and latest.json, which says which version is newest and holds its signature.
// Usage: npm run desktop:update-feed -- "One line about what changed"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const conf = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
const { version } = conf;
const endpoint = conf.plugins.updater.endpoints[0];
if (!endpoint.endsWith('/releases/latest/download/latest.json')) {
  throw new Error(`Expected the updater endpoint to be a GitHub "latest release" link, got ${endpoint}`);
}
// The update sits next to latest.json, in the release tagged with this version.
const base = process.env.UPDATE_FEED_BASE ?? endpoint.replace(/latest\/download\/latest\.json$/, `download/v${version}/`);

const bundle = 'apps/desktop/src-tauri/target/release/bundle/macos';
const out = 'apps/desktop/src-tauri/target/release/update-feed';
const name = `Otter-Pocket-${version}.app.tar.gz`;
mkdirSync(out, { recursive: true });
copyFileSync(`${bundle}/Otter Pocket.app.tar.gz`, `${out}/${name}`);

const feed = {
  version,
  notes: process.argv[2] ?? '',
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature: readFileSync(`${bundle}/Otter Pocket.app.tar.gz.sig`, 'utf8').trim(),
      url: `${base}${name}`,
    },
  },
};
writeFileSync(`${out}/latest.json`, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`Wrote ${out}/${name} and ${out}/latest.json for version ${version}`);
