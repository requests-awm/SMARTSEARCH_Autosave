import { cfg } from '../config.js';

function authHeader() {
  return 'Basic ' + Buffer.from(cfg.insightlyApiKey + ':').toString('base64');
}

async function insightly(path, options = {}) {
  const res = await fetch(cfg.insightlyBaseUrl + path, {
    ...options,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Insightly ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export function getContact(contactId) {
  return insightly(`/Contacts/${contactId}`);
}

export async function updateContactSmartSearch(contactId, url, expiryFormatted) {
  const contact = await getContact(contactId);
  if (!contact) throw new Error(`Insightly contact ${contactId} not found`);

  const customFields = Array.isArray(contact.CUSTOMFIELDS) ? contact.CUSTOMFIELDS : [];
  const updates = [
    { name: cfg.insightlyUrlField, value: url },
    { name: cfg.insightlyExpiryField, value: expiryFormatted },
  ];
  for (const { name, value } of updates) {
    if (value === null || value === undefined) continue;
    const existing = customFields.find((f) => f.FIELD_NAME === name || f.CUSTOM_FIELD_ID === name);
    if (existing) {
      existing.FIELD_VALUE = value;
    } else {
      customFields.push({ FIELD_NAME: name, CUSTOM_FIELD_ID: name, FIELD_VALUE: value });
    }
  }
  contact.CUSTOMFIELDS = customFields;

  return insightly('/Contacts', { method: 'PUT', body: JSON.stringify(contact) });
}

export function contactDisplayName(contact) {
  if (!contact) return null;
  return [contact.FIRST_NAME, contact.LAST_NAME].filter(Boolean).join(' ') || `Contact ${contact.CONTACT_ID}`;
}

export function contactCustomField(contact, name) {
  return (
    (contact?.CUSTOMFIELDS || []).find((f) => f.FIELD_NAME === name || f.CUSTOM_FIELD_ID === name)
      ?.FIELD_VALUE ?? null
  );
}

const MONTH_NUM = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

export function parseInsightlyDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{2,4})$/);
  if (dmy) {
    const month = MONTH_NUM[dmy[2].toLowerCase()];
    if (!month) return null;
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${month}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

export async function sweepContactsWithSmartSearch(onProgress) {
  const pageSize = 500;
  const found = [];
  let skip = 0;
  let scanned = 0;
  while (true) {
    const page = await insightly(`/Contacts?brief=false&top=${pageSize}&skip=${skip}`);
    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;
    for (const contact of page) {
      const expiryRaw = contactCustomField(contact, cfg.insightlyExpiryField);
      const url = contactCustomField(contact, cfg.insightlyUrlField);
      if (!expiryRaw && !url) continue;
      found.push({
        contactId: String(contact.CONTACT_ID),
        contactName: contactDisplayName(contact),
        expiryDate: parseInsightlyDate(expiryRaw),
        expiryRaw: expiryRaw || null,
        insightlyUrl: url || null,
      });
    }
    if (onProgress) onProgress({ scanned, found: found.length });
    if (page.length < pageSize) break;
    skip += pageSize;
  }
  return { scanned, contacts: found };
}
