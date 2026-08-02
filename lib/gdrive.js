import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { cfg } from '../config.js';

let driveClient = null;

function getDrive() {
  if (driveClient) return driveClient;
  let auth;
  if (cfg.googleOAuthClientId && cfg.googleOAuthClientSecret && cfg.googleOAuthRefreshToken) {
    auth = new google.auth.OAuth2(cfg.googleOAuthClientId, cfg.googleOAuthClientSecret);
    auth.setCredentials({ refresh_token: cfg.googleOAuthRefreshToken });
  } else if (cfg.googleServiceAccountFile) {
    auth = new google.auth.GoogleAuth({
      keyFile: cfg.googleServiceAccountFile,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  } else {
    throw new Error('Google Drive credentials are not configured');
  }
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

export function folderNameFor(contactId) {
  return cfg.folderTemplate.replace('{CONTACT_ID}', contactId);
}

export async function findClientFolder(contactId) {
  const drive = getDrive();
  const name = folderNameFor(contactId).replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name contains '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    corpora: cfg.driveId ? 'drive' : 'allDrives',
    driveId: cfg.driveId || undefined,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 5,
    fields: 'files(id, name, webViewLink)',
  });
  return res.data.files?.[0] || null;
}

export async function uploadToFolder(folderId, filename, buffer, mimeType = 'application/pdf') {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true,
    fields: 'id, name, webViewLink',
  });
  return res.data;
}
