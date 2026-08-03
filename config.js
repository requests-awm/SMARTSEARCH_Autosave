import 'dotenv/config';

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();

export const cfg = {
  port: Number(env('PORT', '3000')),

  asanaPat: env('ASANA_PAT'),
  workspaceGid: env('ASANA_WORKSPACE_GID', '666438144056'),
  projectGid: env('ASANA_PROJECT_GID', '1211423560008759'),
  sectionGid: env('ASANA_SECTION_GID', '1211963770737272'),
  urlFieldGid: env('ASANA_URL_FIELD_GID', '1211976904388076'),

  requiredFieldNames: env('REQUIRED_FIELD_NAMES', 'aU_SmartSearch_Conducted_Date')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  conductedFieldName: env('CONDUCTED_FIELD_NAME', 'aU_SmartSearch_Conducted_Date'),
  expiryFieldName: env('EXPIRY_FIELD_NAME', 'aU_SmartSearch_Expiry_Date'),
  expiryYears: Number(env('EXPIRY_YEARS', '5')),
  reminderDaysBefore: Number(env('REMINDER_DAYS_BEFORE', '2')),

  ssoSecret: env('SSO_SHARED_SECRET'),
  ssoAud: env('SSO_AUD'),
  ssoEnforced: env('SSO_ENFORCED', 'true').toLowerCase() !== 'false',
  cookieSecure: env('COOKIE_SECURE', 'false').toLowerCase() === 'true',

  supabaseUrl: env('SUPABASE_URL'),
  supabaseServiceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseSchema: env('SUPABASE_SCHEMA', 'awm_smartsearch'),

  schedulerEnabled: env('SCHEDULER_ENABLED', 'false').toLowerCase() === 'true',
  reminderEmailTo: env('REMINDER_EMAIL_TO', 'zubayr.fish@ascotwm.com'),
  reminderEmailFrom: env('REMINDER_EMAIL_FROM', 'operations.support@ascotwm.com'),
  reminderEmailHour: Number(env('REMINDER_EMAIL_HOUR', '8')),
  smtpHost: env('SMTP_HOST', 'smtp.gmail.com'),
  smtpPort: Number(env('SMTP_PORT', '465')),
  smtpUser: env('SMTP_USER'),
  smtpPass: env('SMTP_PASS'),
  gmailClientId: env('GMAIL_CLIENT_ID'),
  gmailClientSecret: env('GMAIL_CLIENT_SECRET'),
  gmailRefreshToken: env('GMAIL_REFRESH_TOKEN'),
  gmailFromEmail: env('GMAIL_FROM_EMAIL'),

  insightlyApiKey: env('INSIGHTLY_API_KEY'),
  insightlyBaseUrl: env('INSIGHTLY_API_URL', 'https://api.na1.insightly.com/v3.1'),
  insightlyUrlField: env('INSIGHTLY_URL_FIELD', 'SmartSearch_URL__c'),
  insightlyExpiryField: env('INSIGHTLY_EXPIRY_FIELD', 'SmartSearch_Expiry_Date__c'),

  driveId: env('GDRIVE_SHARED_DRIVE_ID', '0AI3XFY5Ifk7VUk9PVA'),
  folderTemplate: env('GDRIVE_FOLDER_TEMPLATE', 'A - Anti-Money Laundering - {CONTACT_ID} - DUAL'),
  googleServiceAccountFile: env('GOOGLE_SERVICE_ACCOUNT_FILE'),
  googleOAuthClientId: env('GOOGLE_OAUTH_CLIENT_ID'),
  googleOAuthClientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET'),
  googleOAuthRefreshToken: env('GOOGLE_OAUTH_REFRESH_TOKEN'),
};

export function missingCredentials() {
  const missing = [];
  if (!cfg.asanaPat) missing.push('ASANA_PAT');
  if (!cfg.insightlyApiKey) missing.push('INSIGHTLY_API_KEY');
  const hasOAuth = cfg.googleOAuthClientId && cfg.googleOAuthClientSecret && cfg.googleOAuthRefreshToken;
  if (!cfg.googleServiceAccountFile && !hasOAuth) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_FILE (or GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN)');
  }
  return missing;
}
