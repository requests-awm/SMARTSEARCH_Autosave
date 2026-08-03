# SmartSearch Auto — Handover Document

**Live at:** https://smartsearch.ascotwm.com
**Repo:** https://github.com/requests-awm/SMARTSEARCH_Autosave
**Owner:** Operations (operations.support@ascotwm.com)

---

## 1. What it is

SmartSearch Auto replaces the old "SmartSearch URL Insightly Upload" Zapier workflow.
When compliance support actions a SmartSearch for a client, this app takes the PDF from
the Asana task and files it everywhere it needs to go — Google Drive, Asana, Insightly —
then completes the task and tracks the 5-year expiry.

## 2. The business flow

**Manual (support does this):**
1. Action the SmartSearch, download the PDF
2. Attach the PDF to the client's Asana task (project *Ee - SmartSearch DYNAMIC*)
3. Fill `aU_SmartSearch_Conducted_Date` on the task
4. Move the task to the **No Further Action Required** section

**Automated (this app, per task, on "Process & Upload"):**
1. Verifies: conducted date filled, PDF attached, Insightly contact ID in the task name
2. Calculates expiry = conducted date **+ 5 years** and writes/corrects
   `aU_SmartSearch_Expiry_Date` on the task (fills empty, fixes wrong values)
3. Looks up the contact in Insightly (record ID = the number in the task name)
4. Finds the client folder `A - Anti-Money Laundering - {ID} - DUAL` in the shared drive
5. Renames the PDF to `{Salutation}-{First}-{Last}-{ID}-{ConductedDate}.pdf`
   (e.g. `Mrs-Sarah-Owens-119614858-2026-07-28.pdf`) and uploads it there
6. Writes the Drive link into the Asana field `aU_SmartSearch_URL`
7. Writes the same link + expiry (`DD-MMM-YY`) into Insightly
   (`SmartSearch_URL__c`, `SmartSearch_Expiry_Date__c`) and **reads the contact back
   to verify the save landed** — the run fails loudly if not
8. Saves a full record locally and to Supabase
9. Marks the Asana task complete

## 3. The interface

Cream-styled review UI with a stepper: **Queue → Review & Checks → Process → Summary**.

- **Queue** — open tasks in the watched section with eligibility pills
  (Ready / fields missing / no PDF / expiry auto-set or auto-correct)
- **Review & Checks** — per-task compliance-style check cards plus live lookups:
  does the Insightly contact exist, does the AML Drive folder exist. The Process
  button only unlocks when everything passes
- **Process** — streams each pipeline step live with per-step results
- **Summary** — links to the uploaded file and proof of the verified Insightly write
- **🗂 Records** — searchable history of every processed client (name / ID / filename)
- **🔔 Reminders** — clients flagged 2 days before SmartSearch expiry, with dismiss/restore,
  an on-demand email button, and an Insightly backfill button

## 4. Sign-in (how access works)

Two layers:

1. **Google IAP** (in front of Cloud Run): visitors must sign in with a Google account;
   IAM grants `domain:ascotwm.com` the *IAP-secured Web App User* role, so **every
   @ascotwm.com employee gets in, nobody else**. No OAuth clients/secrets to manage —
   Google runs the sign-in screen.
2. **The app itself** re-verifies IAP's signed identity assertion (ES256 against
   Google's public keys) and rejects non-@ascotwm.com identities as defense in depth
   (`IAP_ENABLED=true` on the service).

For local development / automation there's a parallel token system: `npm run token`
mints an HS256 JWT (signed with `SSO_SHARED_SECRET`), used as
`http://localhost:3000/?sso_token=<jwt>` — exchanged for a 12h HttpOnly cookie.

## 5. Data storage

- **Working store:** `data/records.json` inside the container (fast, simple)
- **Source of truth:** Supabase (shared AWM instance), schema `awm_smartsearch`,
  table `smartsearch_records` — RLS on, service-role only, soft-delete columns,
  built to AWM shared-DB standards
- Every write mirrors to Supabase immediately; **on boot the app re-hydrates the local
  store from Supabase** (Cloud Run disks are ephemeral — this is why records survive
  restarts). `npm run sync-supabase` reconciles manually if ever needed
- Currently ~1,217 records: app-processed tasks + a one-off backfill of every Insightly
  contact that already had SmartSearch data

## 6. Reminders & the daily email

- A record becomes **due** 2 days before its expiry date (`REMINDER_DAYS_BEFORE`)
- Daily scheduler (gate: `SCHEDULER_ENABLED=true`) emails a branded digest of all
  due/expired clients to `REMINDER_EMAIL_TO` (currently zubayr.fish@ascotwm.com),
  once per day after 8:00 UTC, via the Gmail API (`GMAIL_*` OAuth creds,
  sends as requests@ascotwm.com). Dismissed reminders are excluded
- Known data-quality note: ~30 backfilled contacts carry placeholder expiry dates
  (31 Dec 1999 / 1 Jan 2000) plus a couple of test contacts — dismiss them in the UI
  or clean them in Insightly, or they'll appear in every digest

## 7. Deployment & infrastructure

- **Cloud Run** service `smartsearch-autosave`, region `europe-west1`, project
  `myeventerimporter`, `--max-instances 1` (keeps the local store consistent)
- **Custom domain** `smartsearch.ascotwm.com` via Cloud Run domain mapping
  (Google-managed cert)
- **CD:** pushes to `main` on GitHub auto-deploy via Cloud Build trigger
- **Env vars** live on the service (never in the image). To change one:
  `gcloud run services update smartsearch-autosave --region europe-west1 --update-env-vars KEY=value`
  To sync everything from a local `.env`: `node scripts/make-env-yaml.mjs` then deploy
  with `--env-vars-file env.yaml`
- **Health check:** `GET /health` (unauthenticated). Note: `/healthz` is reserved by
  Google's frontend on Cloud Run and never reaches the app
- **Container:** Node 22 alpine, non-root user, graceful SIGTERM shutdown,
  security headers (CSP, nosniff, frame-deny), 0 npm vulnerabilities at handover

## 8. Configuration quick reference (env vars)

| Var | Meaning |
|---|---|
| `ASANA_PAT`, `ASANA_SECTION_GID` | Asana access + which section is watched |
| `ASANA_URL_FIELD_GID` | Custom field that receives the Drive link |
| `REQUIRED_FIELD_NAMES`, `EXPIRY_FIELD_NAME`, `EXPIRY_YEARS` | Eligibility + expiry rules |
| `INSIGHTLY_API_KEY`, `INSIGHTLY_URL_FIELD`, `INSIGHTLY_EXPIRY_FIELD` | Insightly write-back |
| `GOOGLE_OAUTH_*` | Drive upload (OAuth refresh token) |
| `GMAIL_*` | Reminder email sending |
| `GDRIVE_SHARED_DRIVE_ID`, `GDRIVE_FOLDER_TEMPLATE` | Where PDFs get filed |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SCHEMA` | Records mirror |
| `SSO_SHARED_SECRET`, `SSO_AUD` | Token signing (rotate = kill all sessions) |
| `IAP_ENABLED` | Trust Google IAP identities (production) |
| `SCHEDULER_ENABLED`, `REMINDER_EMAIL_TO`, `REMINDER_DAYS_BEFORE` | Reminder emails |
| `ALLOWED_EMAIL_DOMAIN` | Who counts as staff (ascotwm.com) |

## 9. Runbook

| Task | How |
|---|---|
| Run locally | `npm install`, fill `.env`, `npm start`, sign in via `npm run token` URL |
| Deploy | push to `main` (auto), or `gcloud run deploy … --env-vars-file env.yaml` |
| Change email recipient | update `REMINDER_EMAIL_TO` env var on the service |
| Pause daily emails | set `SCHEDULER_ENABLED=false` |
| Point at a different Asana section | change `ASANA_SECTION_GID` |
| Records missing after restart | check boot log line `Store hydrated from Supabase: N records` |
| "Invalid schema" from Supabase | schema must be in PostgREST's exposed list; if dashboard and API disagree, check `SELECT rolconfig FROM pg_roles WHERE rolname='authenticator'` and reload with `NOTIFY pgrst, 'reload config';` / `'reload schema'` |
| Rotate the SSO secret | new value in env on portal+app together; all sessions invalidate |
| Someone outside ascotwm.com needs access | add them in IAM: IAP-secured Web App User on the service |

## 10. Key files

| Path | What |
|---|---|
| `server.js` | Express app, routes, security headers, scheduler |
| `lib/pipeline.js` | The 9-step automation |
| `lib/asana.js` / `lib/insightly.js` / `lib/gdrive.js` | API clients |
| `lib/store.js` / `lib/supabase.js` | Records store + mirror/hydration |
| `lib/email.js` | Reminder digest build + Gmail/SMTP send |
| `lib/sso.js` / `lib/iap.js` / `lib/googlelogin.js` | The three auth paths |
| `public/` | Frontend (vanilla JS, cream design system) |
| `supabase/migration.sql` | Idempotent DB migration |
| `docs/SSO_PORTAL_SPEC.md` | Token contract if a central SSO portal is ever wired |
| `scripts/` | Token minting, env.yaml generation, Supabase sync |
