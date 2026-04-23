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
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS env var is not set.\n\n' +
      'Set it to the absolute path of your service-account JSON key file:\n' +
      '  export GOOGLE_APPLICATION_CREDENTIALS=/Users/you/Downloads/risc-key.json\n\n' +
      'See the SETUP comment at the bottom of this file for how to create one.'
    );
  }
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  if (!tokenResp.token) throw new Error('Failed to obtain Google access token');
  return tokenResp.token;
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
 * SETUP — one-time service-account creation
 * ==========================================
 *
 * 1. Open Google Cloud Console for your project:
 *    https://console.cloud.google.com/iam-admin/serviceaccounts
 *
 * 2. Click "+ CREATE SERVICE ACCOUNT"
 *    Name: clearbox-risc
 *    ID:   clearbox-risc
 *    Click CREATE AND CONTINUE.
 *
 * 3. Grant access:
 *    In the "Grant this service account access to project" step, add the role:
 *      "RISC Configuration Admin"   (or search "RISC")
 *    If the role isn't shown, first enable the RISC API:
 *      https://console.cloud.google.com/apis/library/risc.googleapis.com
 *    Then come back and try again.
 *    Click CONTINUE → DONE.
 *
 * 4. Download a JSON key:
 *    Click on the new service account in the list → KEYS tab → ADD KEY → Create new key → JSON.
 *    A .json file downloads. Save it somewhere safe (e.g. ~/Downloads/clearbox-risc-key.json).
 *    DO NOT commit it to git.
 *
 * 5. Set the env var (this terminal only — add to ~/.zshrc to persist):
 *      export GOOGLE_APPLICATION_CREDENTIALS=/Users/you/Downloads/clearbox-risc-key.json
 *
 * 6. Run:
 *      node scripts/register-risc.mjs              # register the stream
 *      node scripts/register-risc.mjs verify       # send a test event
 *      node scripts/register-risc.mjs status       # confirm config
 */
