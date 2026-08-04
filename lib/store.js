import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from '../config.js';
import { mirrorRecord, fetchAllRecords } from './supabase.js';

function mirror(record) {
  mirrorRecord(record).catch((err) =>
    console.warn(`Supabase mirror failed for ${record.taskGid}: ${err.message}`)
  );
}

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const filePath = path.join(dataDir, 'records.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function save(records) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

export function upsertRecord(record) {
  const records = load();
  const index = records.findIndex((r) => r.taskGid === record.taskGid);
  const now = new Date().toISOString();
  if (index >= 0) {
    records[index] = { ...records[index], ...record, updatedAt: now };
  } else {
    records.push({ ...record, createdAt: now, updatedAt: now });
  }
  save(records);
  const saved = index >= 0 ? records[index] : records[records.length - 1];
  mirror(saved);
  return saved;
}

export function searchRecords(query) {
  const records = load().sort((a, b) => (b.processedAt || '').localeCompare(a.processedAt || ''));
  if (!query) return records;
  const needle = query.toLowerCase();
  return records.filter((r) =>
    [r.contactName, r.taskName, r.contactId, r.fileName, r.folderName]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  );
}

function shiftDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const toUTC = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(toIso) - toUTC(fromIso)) / 86400000);
}

// A "Refer" SmartSearch carries a deliberate dummy expiry (01/01/2000) written by
// an Asana rule, so reviewers can tell Refer from Pass. It never had a genuine
// 5-year expiry, so it must never raise an expiry reminder. Timezone conversion
// on the Insightly side can land the marker a day either side of 2000-01-01, so
// treat the whole window as dummy rather than matching one exact date.
export function isReferExpiry(record) {
  const expiry = String(record?.expiryDate || '');
  if (!expiry) return false;
  if (expiry >= cfg.referDummyFrom && expiry <= cfg.referDummyTo) return true;
  return false;
}

export function recordsWithReminders({ includeRefer = false } = {}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  return load()
    .filter((r) => r.expiryDate)
    .filter((r) => includeRefer || !isReferExpiry(r))
    .map((r) => {
      const dueDate = shiftDays(r.expiryDate, -cfg.reminderDaysBefore);
      let status;
      if (isReferExpiry(r)) status = 'refer';
      else if (todayIso > r.expiryDate) status = 'expired';
      else if (todayIso >= dueDate) status = 'due';
      else status = 'upcoming';
      if (r.reminderDismissed && (status === 'due' || status === 'expired')) status = 'dismissed';
      return {
        ...r,
        isRefer: isReferExpiry(r),
        reminder: { dueDate, status, daysToExpiry: daysBetween(todayIso, r.expiryDate) },
      };
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

export function dismissReminder(taskGid, dismissed = true) {
  const records = load();
  const record = records.find((r) => r.taskGid === taskGid);
  if (!record) return null;
  record.reminderDismissed = dismissed;
  record.updatedAt = new Date().toISOString();
  save(records);
  mirror(record);
  return record;
}

export function allRecords() {
  return load();
}

export async function hydrateFromSupabase() {
  try {
    const remote = await fetchAllRecords();
    if (!remote) return { hydrated: false, reason: 'Supabase not configured' };
    const byKey = new Map(load().map((r) => [r.taskGid, r]));
    let applied = 0;
    for (const record of remote) {
      const existing = byKey.get(record.taskGid);
      if (!existing || String(record.updatedAt || '') > String(existing.updatedAt || '')) {
        byKey.set(record.taskGid, { ...existing, ...record });
        applied++;
      }
    }
    save([...byKey.values()]);
    return { hydrated: true, remote: remote.length, applied };
  } catch (err) {
    return { hydrated: false, reason: err.message };
  }
}
