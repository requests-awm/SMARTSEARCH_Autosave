import { cfg } from '../config.js';
import {
  getTask,
  getAttachments,
  setTaskUrlField,
  setDateField,
  completeTask,
  plusYears,
  summarizeTask,
} from './asana.js';
import { findClientFolder, folderNameFor, uploadToFolder } from './gdrive.js';
import { getContact, updateContactSmartSearch, contactDisplayName } from './insightly.js';
import { upsertRecord } from './store.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatExpiry(isoDate) {
  if (!isoDate) return null;
  const match = String(isoDate).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${d}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

function sanitizeFileName(name) {
  return String(name).replace(/[\/\\?%*:|"<>]/g, '_').trim();
}

export function buildPdfName(contact, contactId, conductedDate) {
  const stem = [contact?.SALUTATION, contact?.FIRST_NAME, contact?.LAST_NAME, contactId, conductedDate]
    .filter(Boolean)
    .join('-')
    .replace(/[\/\\?%*:|"<>.,']/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return stem ? `${stem}.pdf` : null;
}

export async function loadTaskSummary(taskGid) {
  const [task, attachments] = await Promise.all([getTask(taskGid), getAttachments(taskGid)]);
  return summarizeTask(task, attachments);
}

export async function precheck(taskGid) {
  const summary = await loadTaskSummary(taskGid);
  const result = { summary, contact: null, folder: null, folderName: null };
  if (summary.contactId) {
    result.folderName = folderNameFor(summary.contactId);
    const [contact, folder] = await Promise.allSettled([
      getContact(summary.contactId),
      findClientFolder(summary.contactId),
    ]);
    const customField = (c, name) =>
      (c.CUSTOMFIELDS || []).find((f) => f.FIELD_NAME === name || f.CUSTOM_FIELD_ID === name)?.FIELD_VALUE || null;
    result.contact =
      contact.status === 'fulfilled' && contact.value
        ? {
            id: contact.value.CONTACT_ID,
            name: contactDisplayName(contact.value),
            currentSmartSearchUrl: customField(contact.value, cfg.insightlyUrlField),
            currentSmartSearchExpiry: customField(contact.value, cfg.insightlyExpiryField),
          }
        : { error: contact.status === 'rejected' ? contact.reason.message : 'Contact not found' };
    result.folder =
      folder.status === 'fulfilled' && folder.value
        ? { id: folder.value.id, name: folder.value.name, link: folder.value.webViewLink }
        : { error: folder.status === 'rejected' ? folder.reason.message : 'Folder not found' };
  }
  return result;
}

export async function runPipeline(taskGid, emit) {
  const step = async (id, label, fn) => {
    emit({ step: id, label, status: 'running' });
    try {
      const detail = await fn();
      emit({ step: id, label, status: 'done', detail: detail || '' });
      return true;
    } catch (err) {
      emit({ step: id, label, status: 'error', detail: err.message });
      throw err;
    }
  };

  const ctx = {};
  try {
    await step('load', 'Load task & verify checks', async () => {
      ctx.summary = await loadTaskSummary(taskGid);
      const s = ctx.summary;
      if (!s.contactId) throw new Error('No contact ID found in the task name');
      const missing = s.requiredFields.filter((f) => !f.filled).map((f) => f.requiredName);
      if (missing.length) throw new Error(`Custom field(s) not filled: ${missing.join(', ')}`);
      if (!s.hasPdf) throw new Error('Task has no PDF attachment');
      ctx.attachment =
        s.attachments.find((a) => a.isPdf && a.hasDownload) ||
        s.attachments.find((a) => a.isPdf) ||
        s.attachments[0];
      return `Contact ID ${s.contactId} · ${s.attachmentCount} attachment(s)`;
    });

    await step('expiry', `Calculate & update expiry date (+${cfg.expiryYears} years)`, async () => {
      const s = ctx.summary;
      if (!s.conductedDate) throw new Error('Conducted date missing — cannot compute expiry');
      if (!s.expiryFieldGid) throw new Error(`Field "${cfg.expiryFieldName}" not found on task`);
      const expected = plusYears(s.conductedDate, cfg.expiryYears);
      if (s.expiryDate === expected) return `Already correct: ${expected}`;
      const previous = s.expiryDate;
      await setDateField(taskGid, s.expiryFieldGid, expected);
      s.expiryDate = expected;
      return previous
        ? `Corrected ${previous} → ${expected} (conducted ${s.conductedDate} + ${cfg.expiryYears} years)`
        : `Set to ${expected} (conducted ${s.conductedDate} + ${cfg.expiryYears} years)`;
    });

    await step('contact', 'Find Insightly contact', async () => {
      ctx.contact = await getContact(ctx.summary.contactId);
      if (!ctx.contact) throw new Error(`Contact ${ctx.summary.contactId} not found in Insightly`);
      return contactDisplayName(ctx.contact);
    });

    await step('folder', 'Find AML folder in Google Drive', async () => {
      ctx.folder = await findClientFolder(ctx.summary.contactId);
      if (!ctx.folder) throw new Error(`No folder matching "${folderNameFor(ctx.summary.contactId)}"`);
      return ctx.folder.name;
    });

    await step('download', 'Download attachment from Asana', async () => {
      const attachments = await getAttachments(taskGid);
      const source = attachments.find((a) => a.gid === ctx.attachment.gid) || attachments[0];
      if (!source?.download_url) throw new Error('Attachment has no downloadable URL');
      const res = await fetch(source.download_url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      ctx.fileBuffer = Buffer.from(await res.arrayBuffer());
      ctx.fileName =
        buildPdfName(ctx.contact, ctx.summary.contactId, ctx.summary.conductedDate) ||
        sanitizeFileName(source.name || `SmartSearch_${ctx.summary.contactId}.pdf`);
      return `${ctx.fileName} · ${(ctx.fileBuffer.length / 1024).toFixed(0)} KB`;
    });

    await step('upload', 'Upload PDF to client folder', async () => {
      ctx.driveFile = await uploadToFolder(ctx.folder.id, ctx.fileName, ctx.fileBuffer);
      return ctx.driveFile.webViewLink;
    });

    await step('asana', 'Populate SmartSearch PDF Doc URL in Asana', async () => {
      await setTaskUrlField(taskGid, ctx.driveFile.webViewLink);
      return `Field ${cfg.urlFieldGid} updated`;
    });

    await step('insightly', 'Update SmartSearch URL & expiry in Insightly', async () => {
      const expiry = formatExpiry(ctx.summary.expiryDate);
      await updateContactSmartSearch(ctx.summary.contactId, ctx.driveFile.webViewLink, expiry);
      const readBack = await getContact(ctx.summary.contactId);
      const urlField = (readBack?.CUSTOMFIELDS || []).find(
        (f) => f.FIELD_NAME === cfg.insightlyUrlField || f.CUSTOM_FIELD_ID === cfg.insightlyUrlField
      );
      ctx.insightlyUrl = urlField?.FIELD_VALUE || null;
      ctx.insightlyVerified = ctx.insightlyUrl === ctx.driveFile.webViewLink;
      if (!ctx.insightlyVerified) {
        throw new Error(
          `Verification failed — Insightly ${cfg.insightlyUrlField} reads back as: ${ctx.insightlyUrl || '(empty)'}`
        );
      }
      return `Verified ✓ ${cfg.insightlyUrlField} = ${ctx.insightlyUrl}${expiry ? ` · expiry ${expiry}` : ''}`;
    });

    await step('save', 'Save record to local store', async () => {
      ctx.record = upsertRecord({
        taskGid,
        taskName: ctx.summary.name,
        taskUrl: ctx.summary.permalink,
        contactId: ctx.summary.contactId,
        contactName: contactDisplayName(ctx.contact),
        conductedDate: ctx.summary.conductedDate,
        expiryDate: ctx.summary.expiryDate,
        driveUrl: ctx.driveFile.webViewLink,
        fileName: ctx.fileName,
        folderName: ctx.folder.name,
        insightlyUrl: ctx.insightlyUrl,
        insightlyVerified: ctx.insightlyVerified,
        insightlyExpiry: formatExpiry(ctx.summary.expiryDate),
        source: 'app_pipeline',
        processedAt: new Date().toISOString(),
        reminderDismissed: false,
      });
      return `Saved ${ctx.record.contactName} (#${ctx.record.contactId})`;
    });

    await step('complete', 'Mark Asana task complete', async () => {
      await completeTask(taskGid);
      return 'Task completed';
    });

    emit({
      done: true,
      ok: true,
      result: {
        driveLink: ctx.driveFile.webViewLink,
        fileName: ctx.fileName,
        folderName: ctx.folder.name,
        contactId: ctx.summary.contactId,
        contactName: contactDisplayName(ctx.contact),
        expiry: formatExpiry(ctx.summary.expiryDate),
        expiryDate: ctx.summary.expiryDate,
        taskPermalink: ctx.summary.permalink,
        insightlyUrl: ctx.insightlyUrl,
        insightlyVerified: ctx.insightlyVerified,
      },
    });
  } catch (err) {
    emit({ done: true, ok: false, error: err.message });
  }
}
