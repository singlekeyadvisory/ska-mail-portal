# One-time wiring

Done once. Recorded here so it can be redone from scratch if it ever has to be.

## 1. Push this repo

Repo: `ska-ibos/ska-mail-portal`, **private**, default branch `main`.

## 2. Link each Vercel project to the repo

For each of `ska-helpdesk`, `ska-helpdesk-app`, `ska-mail-runner`:

**Settings → Git → Connect Git Repository →** `ska-ibos/ska-mail-portal`

Then **Settings → Build & Deployment → Root Directory**:

| Project | Root Directory |
|---|---|
| `ska-helpdesk` | `shell` |
| `ska-helpdesk-app` | `app` |
| `ska-mail-runner` | `runner` |

Leave Framework Preset as **Other** and Build Command / Output Directory
**empty**. There is no build. Vercel serves the folder as-is, which is how
production behaves today — the live files already come back with
`access-control-allow-origin: *` and `cache-control: public, max-age=0,
must-revalidate` from Vercel's defaults, so no `vercel.json` is needed for the
two front-end folders.

Tick **"Only build if there are changes in the Root Directory"** on each so one
commit does not rebuild all three.

Do **not** remove the runner's five environment variables. They stay on the
Vercel project.

## 3. Protect `main`

GitHub → Settings → Branches → Add rule for `main`:

- Require a pull request before merging
- Require status checks to pass → **`verify`**
- Require branches to be up to date before merging

This is what makes the gate real. Without it `verify` is advisory and anyone can
push straight to `main`, which deploys production.

## 4. Prove it before trusting it

1. Open a PR that changes nothing but `VERSION` and `APP_VERSION`.
2. Confirm `verify` runs and passes, and that a preview URL appears.
3. Open the preview, sign in, check the version badge.
4. Merge. Confirm production deploys and `npm run drift` reports no drift.
5. Then open a deliberately broken PR — an unbalanced brace in `app2.part` —
   and confirm `verify` fails and merge is blocked. Close it without merging.

Step 5 is the one people skip. A gate nobody has watched fail is not a gate.
