import 'dotenv/config';
import http from 'node:http';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('GOOGLE_OAUTH_CLIENT_ID / SECRET missing in .env');
  process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://localhost:${PORT}/callback`;
const scope = 'https://www.googleapis.com/auth/drive';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/callback') return res.end();
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code received — try again.');
    return;
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (tokens.refresh_token) {
    res.end('Done! You can close this tab — the refresh token was printed in the terminal.');
    console.log('\nNEW_DRIVE_REFRESH_TOKEN=' + tokens.refresh_token);
  } else {
    res.end('Token exchange failed — see terminal.');
    console.error('Exchange failed:', JSON.stringify(tokens).slice(0, 300));
  }
  server.close();
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => {
  console.log('Sign in with the Google account that has access to the Ascot Wealth Management shared drive.');
  console.log('Open this URL in your browser:\n');
  console.log(authUrl + '\n');
});
