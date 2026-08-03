import fs from 'node:fs';

const RESERVED = new Set(['PORT']);

const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
const out = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (RESERVED.has(key) || !value) continue;
  out.push(`${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
}
fs.writeFileSync('env.yaml', out.join('\n') + '\n');
console.log(`env.yaml written with ${out.length} variables (PORT excluded — Cloud Run injects it).`);
console.log('Deploy with:');
console.log('  gcloud run deploy smartsearch-auto --source . --region europe-west2 --max-instances 1 --env-vars-file env.yaml');
