#!/usr/bin/env node
/**
 * Interactive RISC registration — handles its own OAuth flow.
 *
 * Reads GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET from .env.local, spins up
 * a local HTTP server, prints an authorization URL for you to open, captures
 * the code Google redirects back, exchanges it for an access token with the
 * `risc.config` scope, then registers the receiver and (optionally) sends a
 * test event.
 *
 * One-time prerequisite: in Google Cloud Console → Credentials → your OAuth
 * client, add this redirect URI:
 *   http://localhost:8765/callback
 *
 * Then run:
 *   node scripts/register-risc-interactive.mjs              # register
 *   node scripts/register-risc-interactive.mjs verify       # send test event
 *   node scripts/register-risc-interactive.mjs status       # show config
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env.local');
const REDIRECT_URI = 'http://localhost:8765/callback';
const RECEIVER_URL = process.env.RISC_RECEIVER_URL || 'https://clearbox.pro/api/emailHelperV2/auth/risc';
const SCOPE = 'https://www.googleapis.com/auth/risc.config';

const EVENTS = [
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
];

function loadEnv() {
  const raw = readFileSync(ENV_PATH, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing from .env.local');
  }
  return env;
}

function buildAuthUrl(clientId, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    access_type: 'online',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function awaitAuthCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:8765');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(`<h1>Error: ${error}</h1><p>Check the terminal for details.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h1>State mismatch</h1>');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h1>No code returned</h1>');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(`
        <!doctype html>
        <html><head><title>Clearbox RISC — done</title>
        <style>body{font:16px -apple-system;max-width:480px;margin:80px auto;text-align:center;color:#1f2937}
        .ok{color:#059669;font-size:48px}h1{margin:8px 0}p{color:#6b7280}</style>
        </head><body>
        <div class="ok">✓</div>
        <h1>Auth complete</h1>
        <p>You can close this tab and return to the terminal.</p>
        </body></html>
      `);
      server.close();
      resolve(code);
    });
    server.listen(8765, '127.0.0.1');
    server.on('error', reject);
  });
}

async function exchangeCodeForToken(env, code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function callRisc(method, path, token, body) {
  const res = await fetch(`https://risc.googleapis.com/v1beta/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`RISC ${method} /${path} failed: ${res.status}\n${JSON.stringify(parsed, null, 2)}`);
  return parsed;
}

async function getToken() {
  const env = loadEnv();
  const state = Math.random().toString(36).slice(2);
  const authUrl = buildAuthUrl(env.GOOGLE_CLIENT_ID, state);

  console.log('Open this URL in your browser to authorize:\n');
  console.log(`  ${authUrl}\n`);
  console.log('Waiting for callback at http://localhost:8765/callback ...');

  const code = await awaitAuthCode(state);
  console.log('✓ Got authorization code, exchanging for access token...');
  const token = await exchangeCodeForToken(env, code);
  console.log('✓ Access token obtained.\n');
  return token;
}

async function register() {
  const token = await getToken();
  console.log(`Registering receiver: ${RECEIVER_URL}`);
  const result = await callRisc('POST', 'stream:update', token, {
    delivery: {
      delivery_method: 'https://schemas.openid.net/secevent/risc/delivery-method/push',
      url: RECEIVER_URL,
    },
    events_requested: EVENTS,
  });
  console.log('\n✓ Stream registered.\n');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nNext: run `node scripts/register-risc-interactive.mjs verify` to send a test event.');
}

async function verify() {
  const token = await getToken();
  const state = `clearbox-test-${Date.now()}`;
  console.log(`Sending test event with state: ${state}`);
  await callRisc('POST', 'stream:verify', token, { state });
  console.log('\n✓ Test event dispatched.');
  console.log(`\nWithin ~10 seconds your /api/emailHelperV2/auth/risc endpoint should log:`);
  console.log(`  "verification_acknowledged"  (look for state="${state}" in the JWT)`);
  console.log('\nCheck Netlify function logs to confirm.');
}

async function status() {
  const token = await getToken();
  const result = await callRisc('GET', 'stream', token);
  console.log('Current RISC stream configuration:\n');
  console.log(JSON.stringify(result, null, 2));
}

const cmd = process.argv[2] || 'register';
const handler = { register, verify, status }[cmd];
if (!handler) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Valid commands: register | verify | status');
  process.exit(1);
}

handler().catch((err) => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
