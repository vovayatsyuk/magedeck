// Runs from the `version` npm lifecycle hook, after package.json has been
// bumped and before the release commit is made. Keeps the version Tauri bakes
// into the bundles in step with the one npm just wrote.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.npm_package_version;
if (!version) {
  throw new Error('npm_package_version is not set - run this via `npm version`, not directly.');
}

function edit(path, fn) {
  const before = readFileSync(path, 'utf8');
  const after = fn(before);
  if (after === before) {
    throw new Error(`${path}: no version line matched, so nothing changed. Fix the pattern in scripts/sync-version.mjs.`);
  }
  writeFileSync(path, after);
  console.log(`  ${path} -> ${version}`);
}

console.log(`syncing version ${version}`);

// Patched as text rather than re-serialised, so the compact inline objects in
// this file (trafficLightPosition, bundle.targets) keep their formatting. The
// two-space indent anchors this to the top-level key.
edit('src-tauri/tauri.conf.json', (s) => s.replace(/^(  "version": ")[^"]*(")/m, `$1${version}$2`));

// Only the [package] version starts a line; dependency versions are inline
// (`tauri-build = { version = "2" }`), so the anchor leaves them alone.
edit('src-tauri/Cargo.toml', (s) => s.replace(/^version = "[^"]*"$/m, `version = "${version}"`));

edit('src-tauri/Cargo.lock', (s) =>
  s.replace(/(name = "magedeck"\nversion = ")[^"]*(")/, `$1${version}$2`));
