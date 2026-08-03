import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { cfg } from '../config.js';
import { recordsWithReminders } from './store.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ukDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

export function dueReminders() {
  return recordsWithReminders()
    .filter((r) => r.reminder.status === 'due' || r.reminder.status === 'expired')
    .sort((a, b) => a.reminder.daysToExpiry - b.reminder.daysToExpiry);
}

export function buildReminderEmail(records, todayIso) {
  const expired = records.filter((r) => r.reminder.daysToExpiry < 0);
  const dueSoon = records.filter((r) => r.reminder.daysToExpiry >= 0);
  const subject = `SmartSearch Expiry Reminders — ${records.length} client${records.length === 1 ? '' : 's'} need attention (${ukDate(todayIso)})`;

  const daysLabel = (d) =>
    d < 0 ? `expired ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago` : d === 0 ? 'expires today' : `${d} day${d === 1 ? '' : 's'} left`;

  const row = (r) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${esc(r.contactName || r.taskName)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${esc(r.contactId)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${ukDate(r.expiryDate)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:${r.reminder.daysToExpiry < 0 ? '#c0392b' : '#b8860b'};font-weight:bold;">${daysLabel(r.reminder.daysToExpiry)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${r.insightlyUrl ? `<a href="${esc(r.insightlyUrl)}">PDF</a>` : '—'}</td>
    </tr>`;

  const section = (title, list) =>
    list.length
      ? `<h3 style="margin:22px 0 8px;color:#2e2a24;">${title} (${list.length})</h3>
         <table style="border-collapse:collapse;width:100%;font-size:13px;background:#fff;border:1px solid #eee;">
           <tr style="background:#f6f3ec;text-align:left;">
             <th style="padding:8px 12px;">Client</th><th style="padding:8px 12px;">Insightly ID</th>
             <th style="padding:8px 12px;">Expiry</th><th style="padding:8px 12px;">Status</th><th style="padding:8px 12px;">SmartSearch</th>
           </tr>${list.map(row).join('')}</table>`
      : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto;color:#2e2a24;">
    <div style="background:#101c33;color:#fff;padding:16px 22px;border-radius:8px 8px 0 0;">
      <strong style="letter-spacing:1px;">ASCOT WEALTH MANAGEMENT</strong>
      <div style="font-size:12px;color:#c9a227;margin-top:2px;">SmartSearch Auto — Expiry Reminders</div>
    </div>
    <div style="background:#faf8f3;border:1px solid #eae4d8;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
      <p style="font-size:13.5px;">The following <strong>${records.length}</strong> client${records.length === 1 ? '' : 's'} ${records.length === 1 ? 'has' : 'have'} a SmartSearch expiring within ${cfg.reminderDaysBefore} days or already expired. A new SmartSearch should be actioned for each.</p>
      ${section('Expired', expired)}
      ${section('Expiring soon', dueSoon)}
      <p style="font-size:12px;color:#8f887c;margin-top:20px;">Sent automatically by SmartSearch Auto. Dismissed reminders are excluded. Manage reminders in the app → 🔔 Reminders.</p>
    </div>
  </div>`;

  const text = [
    `SmartSearch Expiry Reminders — ${records.length} client(s) need attention`,
    '',
    ...records.map(
      (r) => `- ${r.contactName || r.taskName} (#${r.contactId}) — expiry ${ukDate(r.expiryDate)} — ${daysLabel(r.reminder.daysToExpiry)}`
    ),
  ].join('\n');

  return { subject, html, text };
}

function gmailConfigured() {
  return !!(cfg.gmailClientId && cfg.gmailClientSecret && cfg.gmailRefreshToken);
}

async function sendViaGmailApi({ subject, html, text }) {
  const auth = new google.auth.OAuth2(cfg.gmailClientId, cfg.gmailClientSecret);
  auth.setCredentials({ refresh_token: cfg.gmailRefreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const from = cfg.gmailFromEmail || cfg.reminderEmailFrom;
  const boundary = 'awm-smartsearch-' + Date.now().toString(36);
  const message = [
    `From: "SmartSearch Auto" <${from}>`,
    `To: ${cfg.reminderEmailTo}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundary}--`,
  ].join('\r\n');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(message).toString('base64url') },
  });
  return { messageId: res.data.id, via: 'gmail-api', from };
}

async function sendViaSmtp({ subject, html, text }) {
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });
  const info = await transporter.sendMail({
    from: `"SmartSearch Auto" <${cfg.reminderEmailFrom}>`,
    to: cfg.reminderEmailTo,
    subject,
    html,
    text,
  });
  return { messageId: info.messageId, via: 'smtp', from: cfg.reminderEmailFrom };
}

export async function sendReminderEmail() {
  const records = dueReminders();
  if (!records.length) return { sent: false, reason: 'no due reminders' };
  const todayIso = new Date().toISOString().slice(0, 10);
  const email = buildReminderEmail(records, todayIso);
  let result;
  if (gmailConfigured()) {
    result = await sendViaGmailApi(email);
  } else if (cfg.smtpUser && cfg.smtpPass) {
    result = await sendViaSmtp(email);
  } else {
    throw new Error('No email credentials — set GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN or SMTP_USER/SMTP_PASS in .env');
  }
  return { sent: true, to: cfg.reminderEmailTo, count: records.length, ...result };
}
