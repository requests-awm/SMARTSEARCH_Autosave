import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, missingCredentials } from './config.js';
import { getSectionTasks, getAttachments, summarizeTask } from './lib/asana.js';
import { precheck, runPipeline } from './lib/pipeline.js';
import {
  searchRecords,
  recordsWithReminders,
  dismissReminder,
  allRecords,
  upsertRecord,
  hydrateFromSupabase,
} from './lib/store.js';
import { sweepContactsWithSmartSearch } from './lib/insightly.js';
import { dueReminders, buildReminderEmail, sendReminderEmail } from './lib/email.js';
import fs from 'node:fs';
import { ssoMiddleware } from './lib/sso.js';
import { registerGoogleLoginRoutes } from './lib/googlelogin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(500).json({ error: err.message }));

app.get(['/healthz', '/health'], (req, res) => res.json({ ok: true }));
app.get('/favicon.svg', (req, res) =>
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg'))
);
registerGoogleLoginRoutes(app, wrap);

if (cfg.ssoEnforced) {
  if (!cfg.ssoSecret) {
    console.error('FATAL: SSO_SHARED_SECRET is not set in .env — SSO is enforced and the app cannot start.');
    console.error('Set SSO_SHARED_SECRET (and SSO_AUD), or set SSO_ENFORCED=false to explicitly disable.');
    process.exit(1);
  }
  app.use(ssoMiddleware);
} else {
  console.warn('WARNING: SSO_ENFORCED=false — the app is running WITHOUT authentication.');
}

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (!filePath.endsWith('.svg')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/api/config', (req, res) => {
  res.json({
    projectGid: cfg.projectGid,
    sectionGid: cfg.sectionGid,
    requiredFieldNames: cfg.requiredFieldNames,
    folderTemplate: cfg.folderTemplate,
    insightlyUrlField: cfg.insightlyUrlField,
    insightlyExpiryField: cfg.insightlyExpiryField,
    missingCredentials: missingCredentials(),
  });
});

app.get(
  '/api/tasks',
  wrap(async (req, res) => {
    const tasks = await getSectionTasks();
    const open = tasks.filter((t) => !t.completed);
    const summaries = [];
    for (const task of open) {
      const attachments = await getAttachments(task.gid);
      summaries.push(summarizeTask(task, attachments));
    }
    res.json({ tasks: summaries });
  })
);

app.get(
  '/api/tasks/:gid/precheck',
  wrap(async (req, res) => {
    res.json(await precheck(req.params.gid));
  })
);

app.get('/api/records', (req, res) => {
  res.json({ records: searchRecords(String(req.query.q || '')) });
});

app.get('/api/reminders', (req, res) => {
  const records = recordsWithReminders();
  res.json({
    reminders: records,
    dueCount: records.filter((r) => r.reminder.status === 'due' || r.reminder.status === 'expired').length,
    daysBefore: cfg.reminderDaysBefore,
  });
});

app.post(
  '/api/reminders/backfill',
  wrap(async (req, res) => {
    const existingContactIds = new Set(allRecords().map((r) => String(r.contactId)));
    const { scanned, contacts } = await sweepContactsWithSmartSearch();
    let added = 0;
    let skipped = 0;
    for (const contact of contacts) {
      if (existingContactIds.has(contact.contactId)) {
        skipped++;
        continue;
      }
      if (!contact.expiryDate) {
        skipped++;
        continue;
      }
      upsertRecord({
        taskGid: `insightly-${contact.contactId}`,
        taskName: `Insightly backfill — ${contact.contactName}`,
        contactId: contact.contactId,
        contactName: contact.contactName,
        expiryDate: contact.expiryDate,
        insightlyUrl: contact.insightlyUrl,
        insightlyExpiry: contact.expiryRaw,
        source: 'insightly_backfill',
        reminderDismissed: false,
      });
      added++;
    }
    res.json({ scanned, withSmartSearch: contacts.length, added, skipped });
  })
);

app.get('/api/reminders/email-preview', (req, res) => {
  const records = dueReminders();
  const { subject, html, text } = buildReminderEmail(records, new Date().toISOString().slice(0, 10));
  res.json({ to: cfg.reminderEmailTo, from: cfg.reminderEmailFrom, subject, html, text, count: records.length });
});

app.post(
  '/api/reminders/send-email',
  wrap(async (req, res) => {
    res.json(await sendReminderEmail());
  })
);

app.post('/api/records/:taskGid/dismiss-reminder', (req, res) => {
  const record = dismissReminder(req.params.taskGid, req.body?.dismissed !== false);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  res.json({ record });
});

app.post('/api/tasks/:gid/process', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const emit = (event) => res.write(JSON.stringify(event) + '\n');
  runPipeline(req.params.gid, emit)
    .catch((err) => emit({ done: true, ok: false, error: err.message }))
    .finally(() => res.end());
});

const server = app.listen(cfg.port, () => {
  const missing = missingCredentials();
  console.log(`SmartSearch Auto running on http://localhost:${cfg.port}`);
  if (missing.length) console.log(`Missing credentials: ${missing.join(', ')}`);
  hydrateFromSupabase().then((result) =>
    console.log(
      result.hydrated
        ? `Store hydrated from Supabase: ${result.remote} remote records, ${result.applied} applied locally`
        : `Store hydration skipped: ${result.reason}`
    )
  );
});

const emailStateFile = path.join(__dirname, 'data', 'email-state.json');

function reminderSchedulerTick() {
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().getHours();
  let state = {};
  try { state = JSON.parse(fs.readFileSync(emailStateFile, 'utf8')); } catch { /* first run */ }
  if (state.lastSent === today || hour < cfg.reminderEmailHour) return;
  sendReminderEmail()
    .then((result) => {
      if (result.sent) {
        fs.mkdirSync(path.dirname(emailStateFile), { recursive: true });
        fs.writeFileSync(emailStateFile, JSON.stringify({ lastSent: today, ...result }));
        console.log(`Reminder email sent to ${result.to} (${result.count} clients)`);
      }
    })
    .catch((err) => console.warn(`Reminder email failed: ${err.message}`));
}

if (cfg.schedulerEnabled) {
  console.log(`Reminder email scheduler ON — daily to ${cfg.reminderEmailTo} after ${cfg.reminderEmailHour}:00`);
  setInterval(reminderSchedulerTick, 30 * 60 * 1000);
  setTimeout(reminderSchedulerTick, 15000);
} else {
  console.log('Reminder email scheduler OFF (SCHEDULER_ENABLED != true)');
}

const autoFailures = new Map();
let autoTickRunning = false;

async function autoProcessTick() {
  if (autoTickRunning) return;
  autoTickRunning = true;
  try {
    const tasks = (await getSectionTasks()).filter((t) => !t.completed);
    for (const task of tasks) {
      const attachments = await getAttachments(task.gid);
      const summary = summarizeTask(task, attachments);
      if (!summary.eligible || summary.alreadyProcessed) continue;

      const failure = autoFailures.get(summary.gid);
      if (failure && failure.count >= 3 && Date.now() - failure.lastAttempt < 6 * 3600 * 1000) continue;

      console.log(`Auto-processing: ${summary.name}`);
      let error = null;
      await runPipeline(summary.gid, (event) => {
        if (event.done && !event.ok) error = event.error;
        else if (event.status === 'done') console.log(`  ✓ ${event.label}${event.detail ? ` — ${event.detail}` : ''}`);
        else if (event.status === 'error') console.warn(`  ✕ ${event.label} — ${event.detail}`);
      });
      if (error) {
        const prev = autoFailures.get(summary.gid) || { count: 0 };
        autoFailures.set(summary.gid, { count: prev.count + 1, lastAttempt: Date.now() });
        console.warn(`Auto-process FAILED (attempt ${prev.count + 1}) for ${summary.name}: ${error}`);
      } else {
        autoFailures.delete(summary.gid);
        console.log(`Auto-process COMPLETE: ${summary.name}`);
      }
    }
  } catch (err) {
    console.warn(`Auto-process tick error: ${err.message}`);
  } finally {
    autoTickRunning = false;
  }
}

if (cfg.autoProcessEnabled) {
  console.log(`Auto-processing ON — scanning section every ${cfg.autoProcessIntervalMinutes} min`);
  setInterval(autoProcessTick, cfg.autoProcessIntervalMinutes * 60 * 1000);
  setTimeout(autoProcessTick, 20000);
} else {
  console.log('Auto-processing OFF (AUTO_PROCESS_ENABLED != true) — tasks are processed manually in the UI');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
