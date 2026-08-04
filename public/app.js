const app = document.getElementById('app');
const barLeft = document.getElementById('barLeft');
const barDots = document.getElementById('barDots');
const barRight = document.getElementById('barRight');

const state = {
  config: null,
  tasks: null,
  current: null,
  precheck: null,
  steps: [],
  result: null,
  error: null,
  view: 'queue',
  processing: false,
  dueReminders: 0,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeUrl = (u) => {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? esc(s) : '';
};

function stepReachable(n) {
  if (n === 0) return true;
  if (n === 1) return !!state.current;
  if (n === 2) return state.processing || state.steps.length > 0;
  if (n === 3) return !!state.result;
  return false;
}

function goToStep(n) {
  if (!stepReachable(n)) return;
  if (n === 0) showQueue();
  else if (n === 1) showReview();
  else if (n === 2) renderProcessView();
  else if (n === 3) showSummary();
}

function setStep(index) {
  document.querySelectorAll('.step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === index);
    el.classList.toggle('done', n < index);
    el.classList.toggle('clickable', stepReachable(n) && n !== index);
  });
  barDots.innerHTML = [0, 1, 2, 3]
    .map((i) => `<span class="bar-dot ${i === index ? 'active' : ''}"></span>`)
    .join('');
}

function setBar(leftHtml, rightHtml) {
  barLeft.innerHTML = leftHtml;
  barRight.innerHTML = rightHtml;
}

function withCsrf(options = {}) {
  return { ...options, headers: { ...(options.headers || {}), 'X-Requested-With': 'smartsearch-auto' } };
}

async function api(path, options) {
  const res = await fetch(path, withCsrf(options));
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function refreshReminderBadge() {
  try {
    const data = await api('/api/reminders');
    state.dueReminders = data.dueCount;
    const badge = document.getElementById('reminderBadge');
    badge.textContent = data.dueCount;
    badge.hidden = data.dueCount === 0;
  } catch { /* badge is non-critical */ }
}

/* ---------------- queue ---------------- */

async function showQueue() {
  state.view = 'queue';
  setStep(0);
  setBar('<span>⚠</span><span>↥</span>', '<button class="btn btn-outline" id="refreshBtn">↻ Refresh</button>');
  document.getElementById('refreshBtn').onclick = () => { state.tasks = null; showQueue(); };

  const configBanner = state.config?.missingCredentials?.length
    ? `<div class="banner">⚠ Missing credentials in <strong>.env</strong>: ${esc(state.config.missingCredentials.join(', '))}. The queue and pipeline need these to run.</div>`
    : '';
  const reminderBanner = state.dueReminders > 0
    ? `<div class="banner" id="reminderBanner" style="cursor:pointer">🔔 <strong>${state.dueReminders}</strong> SmartSearch expiry reminder${state.dueReminders === 1 ? '' : 's'} need attention — click to view.</div>`
    : '';

  app.innerHTML = `
    <div>
      <div class="eyebrow">Ee - SmartSearch Dynamic · Processed Form Uploader</div>
      <div class="page-title">SmartSearch Upload Queue</div>
      <div class="page-sub">Tasks are checked for the required custom fields and a SmartSearch PDF attachment before processing.</div>
    </div>
    ${configBanner}
    ${reminderBanner}
    <div id="taskList">
      <div class="card"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%;margin-top:10px"></div></div>
    </div>`;
  document.getElementById('reminderBanner')?.addEventListener('click', showReminders);

  if (!state.tasks) {
    try {
      const data = await api('/api/tasks');
      state.tasks = data.tasks;
    } catch (err) {
      document.getElementById('taskList').innerHTML =
        `<div class="banner red">Could not load tasks from Asana: ${esc(err.message)}</div>`;
      return;
    }
  }
  renderTaskList();
}

function taskStatusPill(t) {
  if (t.alreadyProcessed) return '<span class="pill violet">✓ URL already populated</span>';
  if (t.eligible) return '<span class="pill mint">✓ Ready to process</span>';
  const problems = [];
  if (!t.contactId) problems.push('No contact ID');
  if (!t.allFieldsFilled) problems.push('Fields missing');
  if (!t.hasPdf) problems.push('No PDF attachment');
  return `<span class="pill red">✕ ${esc(problems.join(' · '))}</span>`;
}

function renderTaskList() {
  const list = document.getElementById('taskList');
  if (!state.tasks.length) {
    list.innerHTML = `<div class="card empty-state"><div class="big">🗂</div>No open tasks in this section right now.</div>`;
    return;
  }
  list.innerHTML = state.tasks
    .map(
      (t) => `
      <div class="card task-card" data-gid="${t.gid}" style="margin-bottom:12px">
        <div class="task-top">
          <div class="task-name">${esc(t.name)}</div>
          <div class="task-go">Review →</div>
        </div>
        <div class="task-chips">
          ${t.contactId ? `<span class="badge gray"># ${esc(t.contactId)}</span>` : ''}
          ${taskStatusPill(t)}
          <span class="pill">${t.attachmentCount} attachment${t.attachmentCount === 1 ? '' : 's'}</span>
          ${t.expiryWillBeCorrected ? `<span class="pill amber">Expiry auto-correct → ${esc(t.expiryExpected)}</span>` : t.expiryDate ? `<span class="pill">Expiry ${esc(t.expiryDate)}</span>` : t.expiryWillBeSet ? `<span class="pill amber">Expiry auto-set → ${esc(t.expiryExpected)}</span>` : ''}
        </div>
      </div>`
    )
    .join('');
  list.querySelectorAll('.task-card').forEach((el) => {
    el.onclick = () => {
      const picked = state.tasks.find((t) => t.gid === el.dataset.gid);
      if (state.current?.gid !== picked.gid && !state.processing) {
        state.steps = [];
        state.result = null;
        state.error = null;
      }
      state.current = picked;
      showReview();
    };
  });
}

/* ---------------- review ---------------- */

function checkCard({ ok, warn, question, findings, findingsLabel, goodLabel, badLabel, warnLabel }) {
  const mark = ok ? '✓' : warn ? '△' : '✕';
  const markCls = ok ? '' : warn ? 'warn' : 'bad';
  return `
    <div class="card">
      <div class="review-head">
        <span class="review-tag">🛡 Please Review</span>
        <span class="review-check ${markCls}">${mark}</span>
      </div>
      <div class="review-q">${question}</div>
      ${findings && findings.length ? `<div class="findings-label">${esc(findingsLabel || 'Findings')}</div>
        <ul class="findings">${findings.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
      <div class="assess-label">Assessment:</div>
      <div class="options">
        <span class="option ${ok ? 'selected-good' : ''}">✓ ${esc(goodLabel)}</span>
        ${warn && warnLabel ? `<span class="option ${!ok ? 'selected-warn' : ''}">△ ${esc(warnLabel)}</span>` : ''}
        <span class="option ${!ok && !warn ? 'selected-bad' : ''}">✕ ${esc(badLabel)}</span>
      </div>
    </div>`;
}

async function showReview() {
  const t = state.current;
  state.view = 'review';
  setStep(1);
  state.precheck = null;

  const fieldRows = (icon, label, value, empty) => `
    <div class="field-row">
      <div class="field-ico">${icon}</div>
      <div class="field-body">
        <div class="field-label">${esc(label)}</div>
        <div class="field-value ${empty ? 'empty' : ''}">${value}</div>
      </div>
    </div>`;

  app.innerHTML = `
    <div class="card">
      <div class="identity-head">
        <div class="identity-name">${esc(t.name)} <span class="badge violet">📋 Asana</span></div>
        ${t.alreadyProcessed ? '<span class="badge mint">Processed</span>' : '<span class="badge gray">Pending</span>'}
      </div>
      <div class="identity-meta">Task Review · SmartSearch Upload</div>
      <div class="field-list">
        ${fieldRows('#', 'Insightly Contact ID', t.contactId ? esc(t.contactId) : 'not found in task name', !t.contactId)}
        ${fieldRows('🗓', 'SmartSearch Conducted Date', t.conductedDate ? esc(t.conductedDate) : 'not set', !t.conductedDate)}
        ${fieldRows('🗓', 'SmartSearch Expiry Date', t.expiryWillBeCorrected ? `${esc(t.expiryDate)} — will be corrected to ${esc(t.expiryExpected)}` : t.expiryDate ? esc(t.expiryDate) : (t.expiryWillBeSet ? `will be auto-set to ${esc(t.expiryExpected)}` : 'not set'), !t.expiryDate)}
        ${fieldRows('📎', 'PDF Attachment', (() => { const pdf = t.attachments.find((a) => a.isPdf) || t.attachments[0]; return pdf ? esc(pdf.name) : 'none'; })(), !t.hasPdf)}
        ${fieldRows('🔗', 'SmartSearch PDF Doc URL', t.urlFieldValue ? `<a href="${safeUrl(t.urlFieldValue)}" target="_blank">${esc(t.urlFieldValue)}</a>` : 'will be populated on process', !t.urlFieldValue)}
      </div>
      <div style="margin-top:14px">
        <div class="findings-label">Documents on File</div>
        <div class="doc-chips">
          <a class="doc-chip" href="${safeUrl(t.permalink)}" target="_blank">🡕 Asana task</a>
          ${t.attachments.map((a) => a.permanentUrl ? `<a class="doc-chip" href="${safeUrl(a.permanentUrl)}" target="_blank">🡕 ${esc(a.name)}</a>` : '').join('')}
        </div>
      </div>
    </div>

    ${checkCard({
      ok: t.allFieldsFilled,
      question: `Are the required <strong>custom fields</strong> filled in?`,
      findingsLabel: 'Field values',
      findings: t.requiredFields.map((f) =>
        `${esc(f.requiredName)}: ${f.filled ? `<strong>${esc(f.value)}</strong>` : '<em>empty</em>'}`),
      goodLabel: 'Yes — fields complete',
      badLabel: 'No — fields missing',
    })}

    ${checkCard({
      ok: !!t.expiryDate && !t.expiryWillBeCorrected,
      warn: t.expiryWillBeSet || t.expiryWillBeCorrected,
      question: `Is the <strong>SmartSearch Expiry Date</strong> correct (conducted date + 5 years)?`,
      findingsLabel: 'Dates',
      findings: [
        `Conducted: ${t.conductedDate ? `<strong>${esc(t.conductedDate)}</strong>` : '<em>empty</em>'}`,
        `Expiry: ${t.expiryDate ? `<strong>${esc(t.expiryDate)}</strong>` : '<em>empty</em>'}`,
        ...(t.expiryWillBeCorrected
          ? [`Will be auto-corrected to <strong>${esc(t.expiryExpected)}</strong> during processing`]
          : []),
        ...(t.expiryWillBeSet ? [`Will be auto-set to <strong>${esc(t.expiryExpected)}</strong> during processing`] : []),
      ],
      goodLabel: 'Yes — expiry correct',
      warnLabel: t.expiryWillBeCorrected ? 'Auto-correct on process' : 'Auto-set on process',
      badLabel: 'No — cannot compute',
    })}

    ${checkCard({
      ok: t.hasPdf,
      question: `Does the task have the <strong>SmartSearch PDF attachment</strong>?`,
      findingsLabel: 'Attachments found',
      findings: t.attachments.map((a) => `${esc(a.name)}${a.isPdf ? ' <strong>(PDF)</strong>' : ''}`),
      goodLabel: 'Yes — PDF present',
      badLabel: 'No — PDF missing',
    })}

    <div class="card">
      <div class="review-head"><span class="review-tag">🛡 Please Review</span></div>
      <div class="review-q">External record checks — <strong>Insightly</strong> &amp; <strong>Google Drive</strong></div>
      <div class="standing-grid" id="standingGrid">
        <div class="standing"><div class="standing-top"><span class="standing-title">Insightly Contact</span></div><div class="skeleton" style="margin-top:8px"></div></div>
        <div class="standing"><div class="standing-top"><span class="standing-title">AML Drive Folder</span></div><div class="skeleton" style="margin-top:8px"></div></div>
      </div>
    </div>

    ${t.alreadyProcessed ? `<div class="banner">⚠ The SmartSearch URL field on this task is already populated. Processing again will upload the PDF and overwrite the URL in Asana and Insightly.</div>` : ''}
  `;

  setBar(
    '<button class="btn btn-ghost" id="backBtn">← Back</button>',
    `<button class="btn btn-primary" id="processBtn" disabled>Checking records…</button>`
  );
  document.getElementById('backBtn').onclick = showQueue;

  const processBtn = document.getElementById('processBtn');
  const grid = document.getElementById('standingGrid');

  const standingBox = (title, ok, main, sub) => `
    <div class="standing">
      <div class="standing-top">
        <span class="standing-title">${esc(title)}</span>
        <span class="badge ${ok ? 'mint' : 'red'}">${ok ? 'Found' : 'Not found'}</span>
      </div>
      <div class="standing-sub">${main}${sub ? `<br>${sub}` : ''}</div>
    </div>`;

  try {
    const pc = await api(`/api/tasks/${t.gid}/precheck`);
    state.precheck = pc;
    const contactOk = pc.contact && !pc.contact.error;
    const folderOk = pc.folder && !pc.folder.error;
    grid.innerHTML =
      standingBox('Insightly Contact', contactOk,
        contactOk ? `<strong>${esc(pc.contact.name)}</strong> · #${esc(pc.contact.id)}` : esc(pc.contact?.error || 'No contact ID on task'),
        contactOk
          ? (pc.contact.currentSmartSearchUrl
              ? `SmartSearch URL on file: <a href="${safeUrl(pc.contact.currentSmartSearchUrl)}" target="_blank">view</a>${pc.contact.currentSmartSearchExpiry ? ` · expiry ${esc(pc.contact.currentSmartSearchExpiry)}` : ''} — will be overwritten`
              : 'SmartSearch URL on file: <em>empty</em> — will be set on process')
          : '') +
      standingBox('AML Drive Folder', folderOk,
        folderOk ? `<a href="${safeUrl(pc.folder.link)}" target="_blank">${esc(pc.folder.name)}</a>` : esc(pc.folder?.error || `Looked for "${pc.folderName || ''}"`));

    const ready = t.eligible && contactOk && folderOk;
    processBtn.textContent = ready ? 'Process & Upload →' : 'Checks failed — cannot process';
    processBtn.disabled = !ready;
    if (ready) processBtn.onclick = () => runProcess();
  } catch (err) {
    grid.innerHTML = `<div class="banner red" style="grid-column:1/-1">Precheck failed: ${esc(err.message)}</div>`;
    processBtn.textContent = 'Checks failed — cannot process';
  }
}

/* ---------------- process ---------------- */

const STEP_ORDER = [
  ['load', 'Load task & verify checks'],
  ['expiry', 'Calculate & update expiry date (+5 years)'],
  ['contact', 'Find Insightly contact'],
  ['folder', 'Find AML folder in Google Drive'],
  ['download', 'Download attachment from Asana'],
  ['upload', 'Upload PDF to client folder'],
  ['asana', 'Populate SmartSearch URL in Asana'],
  ['insightly', 'Update SmartSearch URL & expiry in Insightly'],
  ['save', 'Save record to local store'],
  ['complete', 'Mark Asana task complete'],
];

function renderProcessView() {
  const t = state.current;
  state.view = 'process';
  setStep(2);

  app.innerHTML = `
    <div>
      <div class="eyebrow">Processing</div>
      <div class="page-title">${esc(t.name)}</div>
      <div class="page-sub">${state.processing ? 'Running the SmartSearch upload pipeline — keep this tab open.' : 'Pipeline run for this task.'}</div>
    </div>
    <div class="card"><div class="steps-list" id="stepsList"></div></div>
    <div id="processResult"></div>`;
  renderSteps();

  if (state.processing) {
    setBar('<span style="font-size:12px">Do not close while running</span>', '');
  } else if (state.result) {
    document.getElementById('processResult').innerHTML =
      `<div class="banner" style="background:var(--mint-bg);border-color:var(--mint-border);color:var(--mint-text)">✓ Pipeline finished successfully.</div>`;
    setBar('<button class="btn btn-ghost" id="backBtn">← Back to review</button>',
      '<button class="btn btn-primary" id="summaryBtn">View summary →</button>');
    document.getElementById('backBtn').onclick = showReview;
    document.getElementById('summaryBtn').onclick = showSummary;
  } else {
    document.getElementById('processResult').innerHTML =
      `<div class="banner red">✕ Pipeline stopped: ${esc(state.error || 'unknown error')}</div>`;
    setBar('<button class="btn btn-ghost" id="backBtn">← Back to review</button>',
      '<button class="btn btn-outline" id="retryBtn">↻ Retry</button>');
    document.getElementById('backBtn').onclick = showReview;
    document.getElementById('retryBtn').onclick = runProcess;
  }
}

async function runProcess() {
  const t = state.current;
  state.steps = STEP_ORDER.map(([id, label]) => ({ id, label, status: 'pending', detail: '' }));
  state.result = null;
  state.error = null;
  state.processing = true;
  renderProcessView();

  try {
    const res = await fetch(`/api/tasks/${t.gid}/process`, withCsrf({ method: 'POST' }));
    if (!res.ok) throw new Error(`Processing request rejected (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        handleEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    state.error = err.message;
  }

  state.processing = false;
  refreshReminderBadge();
  if (state.view === 'process') {
    if (state.result) showSummary();
    else renderProcessView();
  }
}

function handleEvent(event) {
  if (event.done) {
    if (event.ok) state.result = event.result;
    else state.error = event.error;
    return;
  }
  const step = state.steps.find((s) => s.id === event.step);
  if (step) {
    step.status = event.status;
    step.detail = event.detail || '';
  }
  renderSteps();
}

function renderSteps() {
  const el = document.getElementById('stepsList');
  if (!el) return;
  const icons = { pending: '·', running: '<span class="spinner"></span>', done: '✓', error: '✕' };
  el.innerHTML = state.steps
    .map(
      (s) => `
      <div class="pstep ${s.status}">
        <div class="pstep-ico">${icons[s.status]}</div>
        <div>
          <div class="pstep-label">${esc(s.label)}</div>
          ${s.detail ? `<div class="pstep-detail">${esc(s.detail)}</div>` : ''}
        </div>
      </div>`
    )
    .join('');
}

/* ---------------- summary ---------------- */

function showSummary() {
  const r = state.result;
  state.view = 'summary';
  setStep(3);
  app.innerHTML = `
    <div class="card summary-hero">
      <div class="ico">✓</div>
      <h2>SmartSearch upload complete</h2>
      <p>All systems updated for contact #${esc(r.contactId)} · Asana task marked complete</p>
    </div>
    <div class="card">
      <div class="field-list" style="border-top:none;padding-top:0">
        <div class="field-row"><div class="field-ico">👤</div><div class="field-body"><div class="field-label">Insightly Contact</div><div class="field-value">${esc(r.contactName)} · #${esc(r.contactId)}</div></div></div>
        <div class="field-row"><div class="field-ico">📄</div><div class="field-body"><div class="field-label">Uploaded File</div><div class="field-value">${esc(r.fileName)}</div></div></div>
        <div class="field-row"><div class="field-ico">📁</div><div class="field-body"><div class="field-label">Drive Folder</div><div class="field-value">${esc(r.folderName)}</div></div></div>
        <div class="field-row"><div class="field-ico">🔗</div><div class="field-body"><div class="field-label">SmartSearch URL (written to Asana)</div><div class="field-value"><a href="${safeUrl(r.driveLink)}" target="_blank">${esc(r.driveLink)}</a></div></div></div>
        <div class="field-row"><div class="field-ico">✅</div><div class="field-body"><div class="field-label">Insightly SmartSearch URL ${r.insightlyVerified ? '· read back &amp; verified' : ''}</div><div class="field-value">${r.insightlyVerified ? '<span class="badge mint">✓ Verified</span> ' : '<span class="badge red">Not verified</span> '}${r.insightlyUrl ? `<a href="${safeUrl(r.insightlyUrl)}" target="_blank">${esc(r.insightlyUrl)}</a>` : ''}</div></div></div>
        <div class="field-row"><div class="field-ico">🗓</div><div class="field-body"><div class="field-label">Expiry written to Insightly</div><div class="field-value ${r.expiry ? '' : 'empty'}">${esc(r.expiry || 'no expiry date on task')}</div></div></div>
      </div>
      <div style="margin-top:14px">
        <div class="doc-chips">
          <a class="doc-chip" href="${safeUrl(r.driveLink)}" target="_blank">🡕 View in Drive</a>
          <a class="doc-chip" href="${safeUrl(r.taskPermalink)}" target="_blank">🡕 Asana task</a>
        </div>
      </div>
    </div>`;
  setBar('', '<button class="btn btn-primary" id="doneBtn">Back to Queue →</button>');
  document.getElementById('doneBtn').onclick = () => {
    state.tasks = null;
    state.current = null;
    state.steps = [];
    state.result = null;
    state.error = null;
    showQueue();
  };
}

/* ---------------- records ---------------- */

async function showRecords() {
  state.view = 'records';
  setStep(-1);
  app.innerHTML = `
    <div>
      <div class="eyebrow">Local Store · data/records.json</div>
      <div class="page-title">Processed Records</div>
      <div class="page-sub">Everything the automation has uploaded and updated — searchable until Supabase integration.</div>
    </div>
    <input class="search-box" id="recordSearch" placeholder="Search client name, contact ID or file…" autocomplete="off" />
    <div id="recordList"></div>`;
  setBar('<button class="btn btn-ghost" id="backBtn">← Back to Queue</button>', '');
  document.getElementById('backBtn').onclick = showQueue;

  const input = document.getElementById('recordSearch');
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadRecords(input.value), 250);
  };
  input.focus();
  await loadRecords('');
}

async function loadRecords(q) {
  const list = document.getElementById('recordList');
  if (!list) return;
  try {
    const data = await api('/api/records?q=' + encodeURIComponent(q || ''));
    if (!data.records.length) {
      list.innerHTML = `<div class="card empty-state"><div class="big">🗂</div>${q ? 'No records match your search.' : 'No processed records yet — run a task through the pipeline first.'}</div>`;
      return;
    }
    list.innerHTML = data.records.map(recordCard).join('');
  } catch (err) {
    list.innerHTML = `<div class="banner red">Could not load records: ${esc(err.message)}</div>`;
  }
}

function recordCard(r) {
  return `
    <div class="card" style="margin-bottom:12px">
      <div class="task-top">
        <div class="task-name">${esc(r.contactName || r.taskName)}</div>
        <span class="badge gray"># ${esc(r.contactId)}</span>
      </div>
      <div class="task-chips">
        ${r.insightlyVerified
          ? '<span class="pill mint">✓ Insightly verified</span>'
          : r.source === 'insightly_backfill'
            ? '<span class="pill">⤓ Backfilled from Insightly</span>'
            : '<span class="pill red">✕ Insightly not verified</span>'}
        <span class="pill">Expiry ${esc(r.expiryDate || '—')}</span>
        <span class="pill">Processed ${esc((r.processedAt || '').slice(0, 10))}</span>
      </div>
      <div class="field-list" style="margin-top:12px">
        <div class="field-row"><div class="field-ico">📄</div><div class="field-body"><div class="field-label">File · Folder</div><div class="field-value">${esc(r.fileName || '—')}${r.folderName ? ` · ${esc(r.folderName)}` : ''}</div></div></div>
        <div class="field-row"><div class="field-ico">🔗</div><div class="field-body"><div class="field-label">Insightly SmartSearch URL</div><div class="field-value">${r.insightlyUrl ? `<a href="${safeUrl(r.insightlyUrl)}" target="_blank">${esc(r.insightlyUrl)}</a>` : '<em>empty</em>'}</div></div></div>
      </div>
      <div class="record-links">
        ${r.driveUrl ? `<a class="doc-chip" href="${safeUrl(r.driveUrl)}" target="_blank">🡕 Drive file</a>` : ''}
        ${r.taskUrl ? `<a class="doc-chip" href="${safeUrl(r.taskUrl)}" target="_blank">🡕 Asana task</a>` : ''}
      </div>
    </div>`;
}

/* ---------------- reminders ---------------- */

async function showReminders() {
  state.view = 'reminders';
  setStep(-1);
  app.innerHTML = `
    <div>
      <div class="eyebrow">Expiry Monitor</div>
      <div class="page-title">SmartSearch Expiry Reminders</div>
      <div class="page-sub" id="reminderSub">Clients are flagged before their SmartSearch expires.</div>
    </div>
    <div id="backfillStatus"></div>
    <div id="reminderList"><div class="card"><div class="skeleton" style="width:60%"></div></div></div>`;
  setBar(
    '<button class="btn btn-ghost" id="backBtn">← Back to Queue</button>',
    '<button class="btn btn-outline" id="emailBtn">✉ Email reminders</button><button class="btn btn-outline" id="backfillBtn">⟳ Backfill from Insightly</button>'
  );
  document.getElementById('backBtn').onclick = showQueue;
  document.getElementById('emailBtn').onclick = async () => {
    const btn = document.getElementById('emailBtn');
    const status = document.getElementById('backfillStatus');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const r = await api('/api/reminders/send-email', { method: 'POST' });
      status.innerHTML = r.sent
        ? `<div class="banner" style="background:var(--mint-bg);border-color:var(--mint-border);color:var(--mint-text)">✓ Reminder email sent to ${esc(r.to)} — ${r.count} client${r.count === 1 ? '' : 's'}.</div>`
        : `<div class="banner">Nothing sent: ${esc(r.reason)}</div>`;
    } catch (err) {
      status.innerHTML = `<div class="banner red">Email failed: ${esc(err.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = '✉ Email reminders';
  };
  document.getElementById('backfillBtn').onclick = async () => {
    const btn = document.getElementById('backfillBtn');
    const status = document.getElementById('backfillStatus');
    btn.disabled = true;
    btn.textContent = 'Scanning Insightly…';
    status.innerHTML = '<div class="banner">⏳ Sweeping all Insightly contacts for SmartSearch expiry dates — this can take a minute.</div>';
    try {
      const r = await api('/api/reminders/backfill', { method: 'POST' });
      status.innerHTML = `<div class="banner" style="background:var(--mint-bg);border-color:var(--mint-border);color:var(--mint-text)">✓ Scanned ${r.scanned} contacts · ${r.withSmartSearch} with SmartSearch data · ${r.added} added to reminders · ${r.skipped} skipped (already tracked or no parseable expiry)</div>`;
      await refreshReminderBadge();
      showRemindersList();
    } catch (err) {
      status.innerHTML = `<div class="banner red">Backfill failed: ${esc(err.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = '⟳ Backfill from Insightly';
  };

  await showRemindersList();
}

async function showRemindersList() {
  const list = document.getElementById('reminderList');
  if (!list) return;
  try {
    const data = await api('/api/reminders');
    document.getElementById('reminderSub').textContent =
      `Clients are flagged ${data.daysBefore} days before their SmartSearch expiry date.`;
    if (!data.reminders.length) {
      list.innerHTML = `<div class="card empty-state"><div class="big">🔔</div>No tracked expiries yet — records appear here after processing.</div>`;
      return;
    }
    const attention = data.reminders.filter((r) => r.reminder.status === 'due' || r.reminder.status === 'expired');
    const upcoming = data.reminders.filter((r) => r.reminder.status === 'upcoming');
    const dismissed = data.reminders.filter((r) => r.reminder.status === 'dismissed');
    const CAP = 50;
    const capped = (items, render) =>
      items.slice(0, CAP).map(render).join('') +
      (items.length > CAP ? `<div class="standing-sub" style="text-align:center;padding:8px 0">…and ${items.length - CAP} more (sorted by soonest expiry)</div>` : '');
    list.innerHTML = `
      ${attention.length ? `<div class="findings-label" style="margin-bottom:8px">Needs attention (${attention.length})</div>${attention.map((r) => reminderCard(r, true)).join('')}` : ''}
      ${upcoming.length ? `<div class="findings-label" style="margin:14px 0 8px">Upcoming (${upcoming.length})</div>${capped(upcoming, (r) => reminderCard(r, false))}` : ''}
      ${dismissed.length ? `<div class="findings-label" style="margin:14px 0 8px">Dismissed (${dismissed.length})</div>${capped(dismissed, (r) => reminderCard(r, false, true))}` : ''}`;
    list.querySelectorAll('[data-dismiss]').forEach((btn) => {
      btn.onclick = async () => {
        await api(`/api/records/${btn.dataset.dismiss}/dismiss-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dismissed: btn.dataset.restore !== '1' }),
        });
        await refreshReminderBadge();
        showRemindersList();
      };
    });
  } catch (err) {
    list.innerHTML = `<div class="banner red">Could not load reminders: ${esc(err.message)}</div>`;
  }
}

function reminderCard(r, urgent, isDismissed = false) {
  const days = r.reminder.daysToExpiry;
  const daysLabel =
    days < 0 ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
    : days === 0 ? 'expires today'
    : `${days} day${days === 1 ? '' : 's'} to expiry`;
  return `
    <div class="card" style="margin-bottom:10px${urgent ? ';border-color:var(--red-border)' : ''}">
      <div class="reminder-row">
        <div>
          <div class="task-name">${esc(r.contactName || r.taskName)} <span class="badge gray"># ${esc(r.contactId)}</span></div>
          <div class="standing-sub">Expiry <strong>${esc(r.expiryDate)}</strong> · reminder from ${esc(r.reminder.dueDate)}${r.insightlyUrl ? ` · <a href="${safeUrl(r.insightlyUrl)}" target="_blank">SmartSearch PDF</a>` : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="reminder-days ${urgent ? 'due' : 'upcoming'}">${urgent ? '⚠ ' : ''}${daysLabel}</span>
          ${urgent ? `<button class="btn btn-outline" data-dismiss="${esc(r.taskGid)}">Dismiss</button>` : ''}
          ${isDismissed ? `<button class="btn btn-outline" data-dismiss="${esc(r.taskGid)}" data-restore="1">Restore</button>` : ''}
        </div>
      </div>
    </div>`;
}

/* ---------------- boot ---------------- */

(async function boot() {
  document.querySelectorAll('.step').forEach((el) => {
    el.onclick = () => goToStep(Number(el.dataset.step));
  });
  document.getElementById('navRecords').onclick = showRecords;
  document.getElementById('navReminders').onclick = showReminders;
  try {
    state.config = await api('/api/config');
  } catch { state.config = { missingCredentials: [] }; }
  refreshReminderBadge();
  showQueue();
})();
