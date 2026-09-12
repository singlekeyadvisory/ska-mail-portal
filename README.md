# Single Key Advisory Mail — portal

Source of truth for **mail.singlekeyadvisory.com**: the portal front-end, the
shell that serves it, and the mail runner that collects and sends mail.

Three Vercel projects build from three folders of this one repo.

| Folder | Vercel project | What it is |
|---|---|---|
| `shell/` | `ska-helpdesk` | `index.html`, `app2.part`, service worker, manifest, icons. Holds the live domain. |
| `app/` | `ska-helpdesk-app` | `app1.part` — the first half of the front-end module. |
| `runner/` | `ska-mail-runner` | The three serverless functions. `/api/mail-run` is on a 10-minute cron. |

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before changing anything —
in particular the bit about the front-end being two halves of a single ES
module, because the ordering rule there is not optional.

## Making a change

```bash
git switch -c my-change
# edit shell/app2.part (or app/app1.part, or runner/api/*.js)
npm run manifest        # record the new hashes
npm run verify          # same script CI runs - run it before you push
git commit -am "..." && git push -u origin my-change
```

Open a pull request. Vercel posts a preview URL per affected project and GitHub
runs the `verify` check. Test on the preview. Merge — production deploys itself.

`main` is protected: nothing lands without `verify` passing, so a broken bundle
cannot reach the live site by way of a merge.

Full walkthrough, including what the gate does and does not catch:
[`docs/DEPLOYING.md`](docs/DEPLOYING.md).

## Commands

| | |
|---|---|
| `npm run verify` | The full gate. Hashes, bundle parse, runner parse, version agreement, live app1 URL, conflict markers. |
| `npm run manifest` | Rewrite `MANIFEST.json` after an intended change. |
| `npm run drift` | Compare this branch against what is actually live right now. |

## Why this repo exists

Before it, the front-end had **no complete copy anywhere except the running
site**. Each deployment's source was a patch script that fetched the previous
live version, applied find/replace pairs, and asserted md5s at both ends. The
md5 discipline was sound and caught real errors — but if the Vercel project or
the previous deployment had gone away, so had the code.

The runner was in a worse state: its deployed source was three 48-byte stubs,
with the real code pulled at build time from a *public* Supabase Storage bucket.

Everything is now a plain file here, hash-verified in CI. Vercel remains the
place it runs; it is no longer the only place it exists.

## What is still not in here

- **Database.** Tables, RLS policies, RPCs and pg_cron jobs live in Supabase and
  are not versioned. This is the largest remaining gap.
- **Secrets.** The runner's five environment variables are set on the Vercel
  project and belong there, not in git.
