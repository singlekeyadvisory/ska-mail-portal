// Regenerate MANIFEST.json from the deployable files on disk.
//   node tools/manifest.mjs          -> print, exit 1 if it differs from the file
//   node tools/manifest.mjs --write  -> rewrite MANIFEST.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
// pathToFileURL, not `file://${argv[1]}` - on Windows argv[1] is a backslashed
// drive path (B:\...\manifest.mjs) which never equals import.meta.url, so the
// main block below silently never ran and --write did nothing.
import { pathToFileURL } from 'node:url';

export const TRACKED = [
  'shell/index.html', 'shell/app2.part', 'shell/sw.js', 'shell/manifest.webmanifest',
  'shell/icon-192.png', 'shell/icon-512.png', 'shell/icon-maskable.png', 'shell/apple-touch-icon.png',
  'app/app1.part',
  'runner/api/mail-run.js', 'runner/api/admin.js', 'runner/api/drive.js',
  'runner/index.html', 'runner/vercel.json'
];

export const md5 = b => createHash('md5').update(b).digest('hex');

export function build() {
  const files = {};
  for (const p of TRACKED) {
    const b = readFileSync(p);
    files[p] = { md5: md5(b), bytes: b.length };
  }
  return { version: readFileSync('VERSION', 'utf8').trim(), files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const next = build();
  const json = JSON.stringify(next, null, 2) + '\n';
  if (process.argv.includes('--write')) {
    writeFileSync('MANIFEST.json', json);
    console.log('MANIFEST.json written (' + TRACKED.length + ' files, version ' + next.version + ')');
  } else if (!existsSync('MANIFEST.json') || readFileSync('MANIFEST.json', 'utf8') !== json) {
    console.error('MANIFEST.json is out of date. Run: npm run manifest');
    process.exit(1);
  } else {
    console.log('MANIFEST.json is current.');
  }
}