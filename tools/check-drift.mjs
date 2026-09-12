// Compare what is in this repo against what is actually live right now.
// Vercel serves each static file with its md5 as the ETag, so one HEAD per
// file is enough - no downloads.
//
// Drift means somebody deployed without committing. That is the failure this
// whole repo exists to prevent, so it is worth a loud, specific message.
import { readFileSync } from 'node:fs';

const LIVE = {
  'shell/index.html':           'https://ska-helpdesk.vercel.app/index.html',
  'shell/app2.part':            'https://ska-helpdesk.vercel.app/app2.part',
  'shell/sw.js':                'https://ska-helpdesk.vercel.app/sw.js',
  'shell/manifest.webmanifest': 'https://ska-helpdesk.vercel.app/manifest.webmanifest',
  'shell/icon-192.png':         'https://ska-helpdesk.vercel.app/icon-192.png',
  'shell/icon-512.png':         'https://ska-helpdesk.vercel.app/icon-512.png',
  'shell/icon-maskable.png':    'https://ska-helpdesk.vercel.app/icon-maskable.png',
  'shell/apple-touch-icon.png': 'https://ska-helpdesk.vercel.app/apple-touch-icon.png',
  'app/app1.part':              'https://ska-helpdesk-app.vercel.app/app1.part'
};

const man = JSON.parse(readFileSync('MANIFEST.json', 'utf8'));
let drift = 0, checked = 0;
for (const [p, url] of Object.entries(LIVE)) {
  const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!r.ok) { console.log('  ??    ' + p.padEnd(30) + 'live returned ' + r.status); drift++; continue; }
  // Compressible files come back with a weak validator, W/"<md5>". Same hash,
  // different string -- strip the prefix or every text file reads as drift.
  const live = (r.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');
  const repo = man.files[p].md5;
  checked++;
  if (live === repo) console.log('  same  ' + p.padEnd(30) + repo);
  else { console.log('  DRIFT ' + p.padEnd(30) + 'repo ' + repo + '  live ' + live); drift++; }
}
console.log('\n' + checked + ' checked, ' + drift + ' differing');
if (drift) {
  console.log('\nLive does not match this branch. Either main has moved on, or somebody');
  console.log('deployed straight to Vercel without committing. If it is the latter, pull');
  console.log('the live bytes into the repo before shipping anything else, or the next');
  console.log('deploy will quietly revert their change.');
}
