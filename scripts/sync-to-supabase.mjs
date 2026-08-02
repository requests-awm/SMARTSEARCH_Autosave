import { allRecords } from '../lib/store.js';
import { mirrorRecord, mirrorStatus, supabaseEnabled } from '../lib/supabase.js';

if (!supabaseEnabled()) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env');
  process.exit(1);
}

const status = await mirrorStatus();
if (!status.reachable) {
  console.error(`Supabase table not reachable: ${status.error}`);
  console.error('Has Colin created the awm_smartsearch schema and run supabase/migration.sql?');
  process.exit(1);
}

const records = allRecords();
console.log(`Syncing ${records.length} local record(s) to Supabase (${status.rows} already there)...`);
let ok = 0, failed = 0;
for (const record of records) {
  try {
    await mirrorRecord(record);
    ok++;
  } catch (err) {
    failed++;
    console.error(`  FAILED ${record.taskGid} (${record.contactName}): ${err.message}`);
  }
}
console.log(`Done: ${ok} synced, ${failed} failed.`);
