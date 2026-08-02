import { createClient } from '@supabase/supabase-js';
import { cfg } from '../config.js';

const TABLE = 'smartsearch_records';
let client = null;

export function supabaseEnabled() {
  return !!(cfg.supabaseUrl && cfg.supabaseServiceKey);
}

function getClient() {
  if (!client) {
    client = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
      db: { schema: cfg.supabaseSchema },
      auth: { persistSession: false },
    });
  }
  return client;
}

export function toRow(record) {
  return {
    record_key: record.taskGid,
    insightly_id: String(record.contactId ?? ''),
    contact_name: record.contactName ?? null,
    task_name: record.taskName ?? null,
    task_url: record.taskUrl ?? null,
    conducted_date: record.conductedDate ?? null,
    expiry_date: record.expiryDate ?? null,
    drive_url: record.driveUrl ?? null,
    file_name: record.fileName ?? null,
    folder_name: record.folderName ?? null,
    insightly_url: record.insightlyUrl ?? null,
    insightly_verified: !!record.insightlyVerified,
    insightly_expiry: record.insightlyExpiry ?? null,
    source: record.source || 'app_pipeline',
    processed_at: record.processedAt ?? null,
    reminder_dismissed: !!record.reminderDismissed,
    updated_at: new Date().toISOString(),
  };
}

export async function mirrorRecord(record) {
  if (!supabaseEnabled()) return { skipped: 'supabase not configured' };
  const { error } = await getClient().from(TABLE).upsert(toRow(record), { onConflict: 'record_key' });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function mirrorStatus() {
  if (!supabaseEnabled()) return { configured: false };
  const { count, error } = await getClient().from(TABLE).select('*', { count: 'exact', head: true });
  if (error) {
    const detail = [error.message, error.code, error.hint].filter(Boolean).join(' | ') ||
      `schema "${cfg.supabaseSchema}" not reachable — likely not created or not exposed in the API settings yet`;
    return { configured: true, reachable: false, error: detail };
  }
  return { configured: true, reachable: true, rows: count };
}
