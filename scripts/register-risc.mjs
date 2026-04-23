#!/usr/bin/env node
/**
 * One-shot Google RISC (Cross-Account Protection) receiver registration.
 *
 * Tells Google: "Send security events for my OAuth users to https://clearbox.pro/api/emailHelperV2/auth/risc"
 *
 * USAGE:
 *   1. Create a service account in Google Cloud Console (see SETUP at the bottom of this file)
 *   2. Download its JSON key file
 *   3. export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json
 *   4. node scripts/register-risc.mjs                  # registers
 *   5. node scripts/register-risc.mjs verify           # sends a test event
 *   6. node scripts/register-risc.mjs status           # shows current config
 *   7. node scripts/register-risc.mjs delete           # unregisters
 */
import { GoogleAuth } from 'google-auth-library';

const RECEIVER_URL = process.env.RISC_RECEIVER_URL || 'https://clearbox.pro/api/emailHelperV2/auth/risc';

const EVENTS = [
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
];

async function getAccessToken() {
  // Path 1: Bring-your-own access token (e.g. from OAuth Playground).
  // Use this when org policy blocks service-account JSON keys.
  // Strip all whitespace — terminal line-wrap can inject newlines mid-token.
  if (process.env.RISC_ACCESS_TOKEN) return process.env.RISC_ACCESS_TOKEN.replace(/\s+/g, '');

  // Path 2: Service account JSON key.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) throw new Error('Failed to obtain Google access token from service account');
    return tokenResp.token;
  }

  throw new Error(
    'No credentials found. Set ONE of these env vars:\n\n' +
    '  RISC_ACCESS_TOKEN=ya29.xxx           # one-shot token from OAuth Playground (easiest)\n' +
    '  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json   # service-account JSON key\n\n' +
    'See the SETUP comment at the bottom of this file.'
  );
}

async function callRisc(method, path, body) {
  const token = await getAccessToken();
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
  if (!res.ok) {
    throw new Error(`RISC ${method} /${path} failed: ${res.status} ${res.statusText}\n${JSON.stringify(parsed, null, 2)}`);
  }
  return parsed;
}

async function register() {
  console.log(`Registering receiver: ${RECEIVER_URL}`);
  const result = await callRisc('POST', 'stream:update', {
    delivery: {
      delivery_method: 'https://schemas.openid.net/secevent/risc/delivery-method/push',
      url: RECEIVER_URL,
    },
    events_requested: EVENTS,
  });
  console.log('\n✓ Stream registered.\n');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nNext: run `node scripts/register-risc.mjs verify` to send a test event.');
}

async function verify() {
  const state = `clearbox-test-${Date.now()}`;
  console.log(`Sending test event with state: ${state}`);
  await callRisc('POST', 'stream:verify', { state });
  console.log('\n✓ Test event dispatched.');
  console.log('\nWithin ~10 seconds, your receiver should log a "verification_acknowledged" event.');
  console.log('Check Netlify function logs for /api/emailHelperV2/auth/risc.');
  console.log(`Look for state="${state}" in the JWT payload.`);
}

async function status() {
  const result = await callRisc('GET', 'stream', null);
  console.log('Current RISC stream configuration:\n');
  console.log(JSON.stringify(result, null, 2));
}

async function unregister() {
  // Empty events_requested = unsubscribe from everything
  await callRisc('POST', 'stream:update', {
    delivery: {
      delivery_method: 'https://schemas.openid.net/secevent/risc/delivery-method/push',
      url: RECEIVER_URL,
    },
    events_requested: [],
  });
  console.log('✓ Stream unregistered (events_requested cleared).');
}

const cmd = process.argv[2] || 'register';
const handler = { register, verify, status, delete: unregister }[cmd];
if (!handler) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Valid commands: register | verify | status | delete');
  process.exit(1);
}

handler().catch((err) => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});

/*
 * SETUP — pick ONE of these auth paths
 * =====================================
 *
 * PATH A — OAuth Playground access token (no installs, fastest)
 * --------------------------------------------------------------
 * Use this when org policy blocks service-account JSON keys.
 *
 * 1. Enable the RISC API:
 *    https://console.cloud.google.com/apis/library/risc.googleapis.com  → ENABLE
 *
 * 2. Grant your own Google account the RISC role:
 *    https://console.cloud.google.com/iam-admin/iam
 *    Click GRANT ACCESS → New principals: your-email@gmail.com
 *    Role: "RISC Configuration Admin" → SAVE
 *
 * 3. Get a one-shot access token from OAuth Playground:
 *    https://developers.google.com/oauthplayground/
 *    a) Top-right gear icon → check "Use your own OAuth credentials" → leave blank, save
 *    b) Left side, scroll to bottom → "Input your own scopes":
 *       https://www.googleapis.com/auth/cloud-platform
 *    c) Click "Authorize APIs" → sign in with the same Google account from step 2
 *    d) Click "Exchange authorization code for tokens"
 *    e) Copy the "Access token" value (starts with `ya29.`)
 *
 * 4. Run:
 *      export RISC_ACCESS_TOKEN=ya29.paste_token_here
 *      node scripts/register-risc.mjs           # register
 *      node scripts/register-risc.mjs verify    # send test event
 *      node scripts/register-risc.mjs status    # confirm
 *
 * The token expires in 1 hour. That's fine — registration is one-time. Re-run
 * with a fresh token if you need to make changes later.
 *
 *
 * PATH B — Service account JSON key (if org policy allows)
 * ---------------------------------------------------------
 * 1. https://console.cloud.google.com/iam-admin/serviceaccounts → CREATE
 *    Name: clearbox-risc → role: RISC Configuration Admin → DONE
 * 2. Click the service account → KEYS → ADD KEY → JSON → CREATE
 *    Move the downloaded file outside the repo:
 *      mkdir -p ~/.config/google && mv ~/Downloads/clearbox-risc-*.json ~/.config/google/clearbox-risc-key.json
 * 3. export GOOGLE_APPLICATION_CREDENTIALS=~/.config/google/clearbox-risc-key.json
 * 4. node scripts/register-risc.mjs
 */
