# Deploying

## The short version

1. Branch off `main`.
2. Change the file you mean to change (`shell/app2.part`, `app/app1.part`,
   `runner/api/*.js`, …).
3. Bump `VERSION` **and** `APP_VERSION` in `shell/app2.part` if the portal's
   version badge should move. They must agree or the gate fails.
4. `npm run manifest` — records the new hashes.
5. `npm run verify` — run it locally before you push; it is the same script CI runs.
6. Push, open a PR. Vercel posts three preview URLs and GitHub runs `verify`.
7. Test on the preview URL.
8. Merge. Vercel deploys production automatically.

## What the gate actually checks

| Check | Why it exists |
|---|---|
| Every artifact's md5 matches `MANIFEST.json` | Catches a truncated or half-written file. A one-byte change with a stale manifest fails. |
| `app1.part + app2.part` parses as one ES module | The two halves are concatenated at runtime. A syntax error is invisible in either half and blanks the whole portal. |
| Runner functions parse | Same idea for the three serverless functions. |
| `APP_VERSION` == `VERSION` | The portal has previously told people they were on an older build than they were. |
| `index.html`'s app1 URL returns 200 | The shell loads app1 cross-origin by absolute URL. A typo there is a blank page and nothing else would notice. |
| No merge-conflict markers | Cheap, and exactly the thing you miss at 1am. |

The gate does **not** catch a control that renders but has lost its event
handler. Nothing automated does. Click the preview.

## Previews: one real limitation

`shell/index.html` loads app1 from an absolute production URL:

```
https://ska-helpdesk-app-single-key-advisory.vercel.app/app1.part
```

So a **preview of `shell/` still loads app1 from production.** Consequences:

- Changing only app2 / index / sw — the preview is accurate. This is most changes.
- Changing only app1 — test it at the `ska-helpdesk-app` preview URL on its own.
- Changing **both** — the shell preview will pair your new app2 with the *old*
  app1. Merge and deploy app1 first (this has always been the rule: app1 ships
  first whenever it adds a global), then verify the shell preview.

Fixing this properly means serving app1 from the shell project so previews are
self-contained. Worth doing; it touches `index.html` and `sw.js`, so it is its
own change, not a footnote to this one.

## If someone deploys without committing

`npm run drift` compares the repo against live, using each file's ETag (Vercel
sets it to the md5, so it costs one HEAD per file). If it reports drift, pull
the live bytes into the repo *before* shipping anything else — otherwise the
next merge silently reverts whatever was hand-deployed.

## Rolling back

Vercel keeps every deployment. Instant Rollback in the dashboard reverts
production in seconds without touching git. Then revert the commit so the repo
matches live again, or `drift` will flag it forever.
