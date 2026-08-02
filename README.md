# SmartSearch Auto

Local replacement for the "SmartSearch URL Insightly Upload" Zap, with a review interface.

## What it does

Watches the **No Further Action Required** section of the **Ee - SmartSearch DYNAMIC** Asana project. For each open task it checks:

1. `aU_SmartSearch_Conducted_Date` is filled (`REQUIRED_FIELD_NAMES` in `.env`)
2. The task has a PDF attachment
3. A contact ID can be extracted from the task name

When you hit **Process & Upload** it runs the pipeline:

1. Auto-sets `aU_SmartSearch_Expiry_Date` to conducted date + 5 years if it's empty
2. Looks up the Insightly contact by record ID
3. Finds the client's `A - Anti-Money Laundering - {CONTACT_ID} - DUAL` folder in the shared drive
4. Downloads the PDF attachment and uploads it to that folder
5. Writes the Drive link into the Asana **aU_SmartSearch_URL** custom field
6. Updates `SmartSearch_URL__c` and `SmartSearch_Expiry_Date__c` (formatted `DD-MMM-YY`) on the Insightly contact
7. Marks the Asana task complete

## Setup

```
npm install
copy .env.example .env
```

Fill in `.env`:

- **ASANA_PAT** — personal access token from https://app.asana.com/0/my-apps
- **INSIGHTLY_API_KEY** — from Insightly User Settings → API. Check the pod in `INSIGHTLY_API_URL` matches your instance (na1, eu1, ...)
- **Google Drive** — either a service account JSON key file (the service account must be a member of the shared drive) or an OAuth client + refresh token with `drive` scope
- **REQUIRED_FIELD_NAMES** — the two custom fields that must be filled before a task is eligible, comma-separated. Defaults to just `SmartSearch Expiry Date`; add the second field name

## Run

```
npm start
```

Open http://localhost:3000

## Supabase (shared AWM instance)

Records mirror to the `awm_smartsearch` schema automatically (best-effort; local `data/records.json` stays the source of truth until the schema is live). Go-live steps per `~/.claude/shared-db/STANDARDS_AND_RULES.md`:

1. Register `awm_smartsearch` in the Notion Tool Registry
2. Ask Colin to create the `awm_smartsearch` schema (and expose it in the API settings)
3. Run `supabase/migration.sql` in the Supabase SQL editor
4. Run `npm run sync-supabase` to push all existing local records
5. Confirm RLS back to Colin

## Reminder backfill

The 🔔 Reminders screen has **⟳ Backfill from Insightly** — sweeps every Insightly contact and imports those with a SmartSearch expiry date, so pre-app clients get reminders too. Safe to re-run; already-tracked clients are skipped.

## Deployment (Docker)

```
docker compose up -d --build
```

- Config comes from `.env` (never baked into the image — `.dockerignore` excludes it)
- `data/records.json` persists via the `./data` volume mount
- Health endpoint: `GET /healthz` (unauthenticated; used by the container healthcheck)
- Runs as non-root `node` user; graceful shutdown on SIGTERM
- Behind an HTTPS reverse proxy set `COOKIE_SECURE=true` (adds the Secure flag to the SSO cookie); `trust proxy` is already enabled
- Security headers (CSP, nosniff, frame deny, no-referrer) are set on every response

## Flow in the UI

**Queue** → lists section tasks with eligibility pills → **Review & Checks** → shows the field/attachment checks plus live Insightly + Drive lookups → **Process** → streams each pipeline step → **Summary** → links to the uploaded file and updated records.
