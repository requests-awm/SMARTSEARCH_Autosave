import { cfg } from '../config.js';

const BASE = 'https://app.asana.com/api/1.0';

async function asana(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.asanaPat}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.errors?.map((e) => e.message).join('; ') || res.statusText;
    throw new Error(`Asana ${res.status}: ${detail}`);
  }
  return body.data;
}

const TASK_FIELDS =
  'name,completed,permalink_url,created_at,memberships.section.gid,memberships.section.name,custom_fields.gid,custom_fields.name,custom_fields.type,custom_fields.display_value,custom_fields.date_value,custom_fields.text_value';

export function getSectionTasks() {
  return asana(`/sections/${cfg.sectionGid}/tasks?limit=100&opt_fields=${TASK_FIELDS}`);
}

export function getTask(taskGid) {
  return asana(`/tasks/${taskGid}?opt_fields=${TASK_FIELDS}`);
}

export function getAttachments(taskGid) {
  return asana(
    `/tasks/${taskGid}/attachments?opt_fields=name,download_url,permanent_url,size,created_at,resource_subtype`
  );
}

export function setTaskUrlField(taskGid, url) {
  return asana(`/tasks/${taskGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { custom_fields: { [cfg.urlFieldGid]: url } } }),
  });
}

export async function setDateField(taskGid, fieldGid, isoDate) {
  try {
    return await asana(`/tasks/${taskGid}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { custom_fields: { [fieldGid]: { date: isoDate } } } }),
    });
  } catch {
    return asana(`/tasks/${taskGid}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { custom_fields: { [fieldGid]: isoDate } } }),
    });
  }
}

export function completeTask(taskGid) {
  return asana(`/tasks/${taskGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { completed: true } }),
  });
}

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function plusYears(isoDate, years) {
  const match = String(isoDate).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const targetYear = Number(y) + years;
  const day = m === '02' && d === '29' && !isLeapYear(targetYear) ? '28' : d;
  return `${targetYear}-${m}-${day}`;
}

export function extractContactId(taskName) {
  const runs = String(taskName || '').match(/\d+/g) || [];
  if (!runs.length) return null;
  return runs.reduce((longest, run) => (run.length > longest.length ? run : longest), runs[0]);
}

export function fieldByName(task, name) {
  const target = name.toLowerCase();
  return (task.custom_fields || []).find((f) => (f.name || '').toLowerCase().includes(target)) || null;
}

export function fieldIsFilled(field) {
  if (!field) return false;
  return field.display_value !== null && field.display_value !== undefined && String(field.display_value).trim() !== '';
}

export function summarizeTask(task, attachments) {
  const requiredFields = cfg.requiredFieldNames.map((name) => {
    const field = fieldByName(task, name);
    return {
      requiredName: name,
      found: !!field,
      actualName: field?.name || null,
      value: field?.display_value ?? null,
      filled: fieldIsFilled(field),
    };
  });
  const contactId = extractContactId(task.name);
  const urlField = (task.custom_fields || []).find((f) => f.gid === cfg.urlFieldGid);
  const isPdf = (a) => /\.pdf$/i.test(a.name || '');
  const hasPdf = attachments.some(isPdf);
  const conductedField = fieldByName(task, cfg.conductedFieldName);
  const conductedDate = conductedField?.date_value?.date || null;
  const expiryField = fieldByName(task, cfg.expiryFieldName);
  const expiryDate = expiryField?.date_value?.date || null;

  // A "Refer" result is flagged two ways: the task sits in the Refer section, or
  // an Asana rule has already stamped the dummy 01/01/2000 expiry. Either marks
  // the task as Refer, which must not be processed as a normal pass.
  const sections = (task.memberships || [])
    .map((m) => ({ gid: m.section?.gid || null, name: m.section?.name || '' }))
    .filter((s) => s.gid || s.name);
  const inReferSection = sections.some(
    (s) => s.gid === cfg.referSectionGid || /refer/i.test(s.name)
  );
  const hasDummyExpiry = !!expiryDate && expiryDate >= cfg.referDummyFrom && expiryDate <= cfg.referDummyTo;
  const isRefer = inReferSection || hasDummyExpiry;

  return {
    gid: task.gid,
    name: task.name,
    permalink: task.permalink_url,
    completed: task.completed,
    contactId,
    conductedDate,
    expiryDate,
    expiryFieldGid: expiryField?.gid || null,
    expiryExpected: conductedDate ? plusYears(conductedDate, cfg.expiryYears) : null,
    expiryWillBeSet: !expiryDate && !!conductedDate,
    expiryWillBeCorrected:
      !!expiryDate && !!conductedDate && expiryDate !== plusYears(conductedDate, cfg.expiryYears),
    requiredFields,
    allFieldsFilled: requiredFields.every((f) => f.filled),
    urlFieldValue: urlField?.display_value || null,
    alreadyProcessed: fieldIsFilled(urlField),
    attachmentCount: attachments.length,
    hasPdf,
    attachments: attachments.map((a) => ({
      gid: a.gid,
      name: a.name,
      permanentUrl: a.permanent_url,
      hasDownload: !!a.download_url,
      isPdf: isPdf(a),
      size: a.size ?? null,
    })),
    customFields: (task.custom_fields || []).map((f) => ({
      gid: f.gid,
      name: f.name,
      value: f.display_value ?? null,
      filled: fieldIsFilled(f),
    })),
    sections,
    inReferSection,
    hasDummyExpiry,
    isRefer,
    eligible: !!contactId && requiredFields.every((f) => f.filled) && hasPdf && !isRefer,
  };
}
