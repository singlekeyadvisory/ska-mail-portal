// Gate that runs on every pull request and every push to main.
// Everything here exists because something once went wrong without it.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACKED, md5, build } from './manifest.mjs';

let failed = 0;
const ok   = m => console.log('  ok    ' + m);
const bad  = m => { console.error('  FAIL  ' + m); failed++; };
const step = m => console.log('\n' + m);

// --- 1. manifest -------------------------------------------------------------
step('1. artifact hashes match MANIFEST.json');
const man = JSON.parse(readFileSync('MANIFEST.json', 'utf8'));
const now = build();
for (const p of TRACKED) {
  const e = man.files[p], g = now.files[p];
  if (!e) bad(p + ' is not in MANIFEST.json - run: npm run manifest');
  else if (e.md5 !== g.md5) bad(p + '\n          manifest ' + e.md5 + '\n          on disk  ' + g.md5 + '\n          If the change is intended, run: npm run manifest');
  else ok(p.padEnd(30) + e.md5);
}

// --- 2. the joined bundle parses --------------------------------------------
// app1.part and app2.part are concatenated by index.html into ONE ES module.
// A syntax error is only visible in the joined file, never in either half, and
// it takes the whole portal down - blank screen, no error the user can act on.
step('2. app1.part + app2.part parses as one ES module');
const joined = readFileSync('app/app1.part', 'utf8') + readFileSync('shell/app2.part', 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'skaverify-'));
const jf  = join(dir, 'joined.mjs');
writeFileSync(jf, joined);
try {
  execFileSync(process.execPath, ['--check', jf], { stdio: 'pipe' });
  ok('parses clean (' + joined.length.toLocaleString() + ' chars)');
} catch (e) {
  bad('the joined bundle does NOT parse:\n' + (e.stderr || e.stdout || e).toString().split('\n').slice(0, 12).join('\n'));
}

// --- 3. runner functions parse ----------------------------------------------
step('3. runner functions parse');
for (const f of ['runner/api/mail-run.js', 'runner/api/admin.js', 'runner/api/drive.js']) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(f); }
  catch (e) { bad(f + '\n' + (e.stderr || e).toString().split('\n').slice(0, 8).join('\n')); }
}

// --- 4. version agreement ----------------------------------------------------
// APP_VERSION drifting behind the changelog is a real bug we have already hit:
// the portal tells people they are on an older build than they actually are.
step('4. APP_VERSION matches VERSION');
const want = readFileSync('VERSION', 'utf8').trim();
const m = readFileSync('shell/app2.part', 'utf8').match(/const APP_VERSION\s*=\s*'([^']+)'/);
if (!m) bad("could not find APP_VERSION in shell/app2.part");
else if (m[1] !== want) bad("VERSION says '" + want + "' but app2.part says APP_VERSION='" + m[1] + "'");
else ok("both say '" + want + "'");
if (man.version !== want) bad("MANIFEST.json version '" + man.version + "' != VERSION '" + want + "'");

// --- 5. cross-project reference ---------------------------------------------
// index.html loads app1.part from the OTHER Vercel project by absolute URL.
// If that URL is ever edited to something that does not exist, the portal is
// a blank page and nothing in the build would notice.
step('5. index.html points at a reachable app1.part');
const idx = readFileSync('shell/index.html', 'utf8');
const urls = [...idx.matchAll(/https:\/\/[^'"\s]*app1\.part/g)].map(x => x[0]);
if (!urls.length) bad('index.html contains no app1.part URL at all');
else {
  for (const u of [...new Set(urls)]) {
    try {
      const r = await fetch(u, { method: 'HEAD' });
      r.ok ? ok(u + '  ->  ' + r.status) : bad(u + '  ->  ' + r.status);
    } catch (e) { bad(u + '  ->  ' + e.message); }
  }
}

// --- 6. nothing half-merged --------------------------------------------------
step('6. no conflict markers in shipped files');
for (const p of TRACKED) {
  if (p.endsWith('.png')) continue;
  const t = readFileSync(p, 'utf8');
  if (/^(<<<<<<< |=======$|>>>>>>> )/m.test(t)) bad(p + ' contains a merge conflict marker');
}
if (!failed) ok('clean');

console.log('\n' + (failed ? failed + ' CHECK(S) FAILED' : 'all checks passed'));
process.exit(failed ? 1 : 0);
