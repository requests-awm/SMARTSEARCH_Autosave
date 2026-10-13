import { cfg } from '../config.js';
import { createProjectTask, getProjectTasksSince } from './asana.js';
import { recordsWithReminders, setExpiryTask } from './store.js';
import { getContact } from './insightly.js';

const TITLE_PREFIX = 'SmartSearch renewal';
const inFlight = new Set();

const DEFAULT_ASSIGNEE = 'zubayr.fish@ascotwm.com';
const TEAM_ASSIGNEES = [
  { keywords: ['royal'], assignee: 'michael.morris@ascotwm.com' },
  { keywords: ['solo'], assignee: 'ayanda.nyawose@ascotwm.com' },
  { keywords: ['hurricane', 'catriona'], assignee: 'chenise.henry-edwards@ascotwm.com' },
  { keywords: ['quest'], assignee: 'bongiwe.sithebe@ascotwm.com' },
  { keywords: ['blue'], assignee: 'waseem.seralker@ascotwm.com' },
];

export function assigneeForSubTeam(subTeam) {
  const text = String(subTeam || '').toLowerCase().trim();
  const team = TEAM_ASSIGNEES.find((t) => t.keywords.some((k) => text.includes(k)));
  return team ? team.assignee : DEFAULT_ASSIGNEE;
}

async function lookupSubTeam(contactId) {
  try {
    const contact = await getContact(contactId);
    const field = (contact?.CUSTOMFIELDS || []).find((f) => f.FIELD_NAME === cfg.insightlySubTeamField);
    const value = String(field?.FIELD_VALUE ?? '').trim();
    return value && value !== '-' ? value : null;
  } catch (err) {
    console.warn(`Sub team lookup failed for ${contactId}: ${err.message}`);
    return null;
  }
}

const taskName = (r) =>
  `${TITLE_PREFIX} — ${r.contactName || r.taskName} (${r.contactId}) — expires ${r.expiryDate}`;

function taskNotes(r, subTeam) {
  return [
    `SmartSearch for ${r.contactName || r.taskName} expires on ${r.expiryDate}. A new SmartSearch is required.`,
    '',
    `Insightly contact ID: ${r.contactId}`,
    `Sub team: ${subTeam || 'not set in Insightly'}`,
    r.insightlyUrl ? `Previous SmartSearch: ${r.insightlyUrl}` : null,
    r.driveUrl && r.driveUrl !== r.insightlyUrl ? `Drive file: ${r.driveUrl}` : null,
    r.taskUrl ? `Original Asana task: ${r.taskUrl}` : null,
    '',
    'Created automatically by SmartSearch Auto.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// The local record store is wiped on Cloud Run restarts, so Asana itself is the
// source of truth for "has a renewal task already been raised for this expiry".
async function existingRenewalTasks() {
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const tasks = await getProjectTasksSince(since);
  return tasks.filter((t) => (t.name || '').startsWith(TITLE_PREFIX));
}

const findExisting = (tasks, r) =>
  tasks.find((t) => t.name.includes(`(${r.contactId})`) && t.name.includes(r.expiryDate));

export async function createExpiryTask(record, existing) {
  if (record.expiryTaskGid) {
    return { created: false, gid: record.expiryTaskGid, url: record.expiryTaskUrl };
  }
  if (inFlight.has(record.taskGid)) throw new Error('Renewal task creation already in progress');
  inFlight.add(record.taskGid);
  try {
    const match = findExisting(existing ?? (await existingRenewalTasks()), record);
    if (match) {
      setExpiryTask(record.taskGid, match.gid, match.permalink_url);
      return { created: false, gid: match.gid, url: match.permalink_url };
    }
    const subTeam = await lookupSubTeam(record.contactId);
    const task = await createProjectTask({
      name: taskName(record),
      notes: taskNotes(record, subTeam),
      dueOn: record.expiryDate,
      sectionGid: cfg.expiryTaskSectionGid,
      assignee: assigneeForSubTeam(subTeam),
    });
    setExpiryTask(record.taskGid, task.gid, task.permalink_url);
    return { created: true, gid: task.gid, url: task.permalink_url };
  } finally {
    inFlight.delete(record.taskGid);
  }
}

// Already-expired records are left to the manual button so that switching this on
// doesn't raise a burst of tasks for old backfilled clients.
export async function createDueExpiryTasks() {
  const due = recordsWithReminders().filter(
    (r) =>
      !r.expiryTaskGid &&
      !r.reminderDismissed &&
      r.reminder.daysToExpiry >= 0 &&
      r.reminder.daysToExpiry <= cfg.expiryTaskDaysBefore
  );
  const result = { due: due.length, created: 0, linked: 0, failed: 0 };
  if (!due.length) return result;
  const existing = await existingRenewalTasks();
  for (const record of due) {
    try {
      const outcome = await createExpiryTask(record, existing);
      if (outcome.created) result.created++;
      else result.linked++;
    } catch (err) {
      result.failed++;
      console.warn(`Renewal task failed for ${record.contactId}: ${err.message}`);
    }
  }
  return result;
}
