# How the portal is put together

## Three Vercel projects, one repo

| Folder | Vercel project | Serves | Domain |
|---|---|---|---|
| `shell/` | `ska-helpdesk` | `index.html`, `app2.part`, `sw.js`, manifest, icons | **mail.singlekeyadvisory.com** |
| `app/` | `ska-helpdesk-app` | `app1.part` | `ska-helpdesk-app.vercel.app` |
| `runner/` | `ska-mail-runner` | `/api/mail-run`, `/api/admin`, `/api/drive` | `ska-mail-runner.vercel.app` |

Each Vercel project has its **Root Directory** set to its folder, so a change
under `runner/` does not rebuild the front-end and vice versa.

There is no build step. The files in each folder are exactly the files that get
served. That is deliberate — see below.

## The front-end is two halves of one module

`index.html` fetches `app1.part` and `app2.part`, concatenates them, and
evaluates the result as a single strict ES module. Practical consequences:

- Declaration order matters across the file boundary. If app2 uses something
  app1 declares, **app1 must be live first.**
- A syntax error is only visible in the joined text. CI joins them and parses.
- `app1.part` is fetched cross-origin. Vercel serves static files with
  `access-control-allow-origin: *` by default, which is why it works with no
  config, and why neither front-end folder needs a `vercel.json`.
- Vercel sets each static file's `ETag` to its md5. `sw.js` uses those ETags to
  detect a new build, and `tools/check-drift.mjs` uses them to compare the repo
  against live.

## What used to be here instead

Until this repo existed, each deployment's entire source was a `build.mjs` that

1. fetched the **previous live version** from the public URL,
2. asserted its md5,
3. applied a list of find/replace pairs,
4. asserted the result's md5,
5. wrote that to `public/`.

The md5 assertions were good and caught real mistakes. But the source of truth
was *the last deployment*, so there was no full copy of the front-end anywhere
except the running site. Losing the Vercel project, or having a build run when
the previous deployment was unreachable, would have meant losing the code.

The runner was worse: its deployed source was three 48-byte stubs, and the real
code was fetched at build time from a **public** Supabase Storage bucket.

Both are now plain files in this repo. The md5 discipline survives as
`MANIFEST.json` plus `tools/verify.mjs`; what has gone is the dependency on the
previous deployment still being alive.

## The runner

`runner/api/mail-run.js` runs every 10 minutes (`runner/vercel.json` `crons`).
It pulls new mail per mailbox using a Gmail history cursor, sends queued
outbound mail, applies retention, and writes a row to `helpdesk.mail_run_log`.

Its five secrets live in Vercel project env vars and are **not** in this repo:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
`GCP_WIF_AUDIENCE`, `GCP_SERVICE_ACCOUNT`.

Database objects — tables, RLS policies, RPCs, pg_cron jobs — live in Supabase
and are not versioned here. That is the next gap worth closing.
