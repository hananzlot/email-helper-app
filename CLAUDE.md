# Email Helper App — Development Guide

## HIGHEST PRIORITY — READ FIRST
**NEVER GUESS. ALWAYS DEEP-ANALYZE BEFORE CONCLUDING.**
Before proposing a fix, trace the full data flow end-to-end. Read every file in the chain. Verify assumptions by reading the actual code — do not assume behavior based on function names or comments. If a bug report says "X doesn't work," investigate *why* by following the data from source to UI before writing a single line of code.

## Project Location
- **Local path**: `~/Documents/email-helper-app`
- **GitHub**: `github.com/hananzlot/email-helper-app`
- **Deployed**: `emaihelper.netlify.app`
- **Netlify site ID**: `5bf49f8a-1f8c-4b69-9be5-d00df037977e`
- **Cowork mount**: Always select `~/Documents/email-helper-app` — do NOT use `~/Email Helper/email-helper-app` (that is an outdated copy)

## Architecture
- **Next.js App Router** with TypeScript, deployed on Netlify
- **Supabase** backend (auth, sender priorities, reply queue, triage results, notification rules)
  - Project ID: `ybyhqkfyfovcuxhiejgx`
  - URL: `https://ybyhqkfyfovcuxhiejgx.supabase.co`
  - Dashboard: `https://supabase.com/dashboard/project/ybyhqkfyfovcuxhiejgx`
  - SQL Editor: `https://supabase.com/dashboard/project/ybyhqkfyfovcuxhiejgx/sql/new`
  - Env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - Env vars are stored in **Netlify environment variables** (no local `.env.local` file)
- **Gmail API** via `googleapis` — full CRUD, thread fetching, reply detection
  - Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - OAuth callback: `https://emaihelper.netlify.app/api/emailHelperV2/auth/callback`
- **Multi-account support** with unified view merging all connected Gmail accounts
- **Encryption**: `ENCRYPTION_KEY` env var for token encryption at rest

## Key Files
- `src/app/dashboard/page.tsx` — Main UI (all tabs, components, state)
- `src/lib/triage.ts` — Triage engine (scoring, categorization, auto-archive)
- `src/lib/gmail.ts` — Gmail API wrapper
- `src/app/api/emailHelperV2/` — All API routes (gmail, queue, senders, triage, accounts, auth, cron)
- `src/app/globals.css` — CSS variables and theme

## Tab Structure
Home | Triage | Follow Up | Snoozed | Cleanup | Sent | All Mail
(Priorities, Accounts, and Action History are in the Settings ⚙ gear menu in the header — not the tab bar)
(All Mail tab has no count badge to avoid confusion with categorised tab counts)

## Important Rules

### CRITICAL: Tabs Only Show Unread Emails
All tabs (Top Tiers, Easy-Clear, Follow Up, Snoozed, Sent, All Mail) MUST only display **unread** emails.
Read emails are excluded from all tab views and tab counts.
Read emails can ONLY be found via the **global search box**.
This is a core UX rule — do not change without explicit instruction.

### CRITICAL: Backend-First for Data Operations
Always prefer server-side SQL/Supabase queries over client-side JavaScript when dealing with:
- Large data sets (grouping, counting, filtering, sorting)
- Bulk updates or deletes
- Aggregations across many rows
- Any operation on cached inbox data (45k+ rows per user)
The client should receive ready-to-render results, not raw data to process.
Supabase returns max 1000 rows per query — use `.range()` pagination to fetch all rows when needed.

### CRITICAL: Efficient Sync with Fast-Forward
When syncing inbox messages from Gmail to cache:
- Use a **sync queue** for coordinating across users and cron jobs
- Each sync call processes one page (100 messages) from Gmail
- If ALL messages on a page are already cached, **fast-forward** — skip up to 50 pages per call by only fetching `listMessages` (IDs + nextPageToken) without metadata
- Save `resume_page_token` so next call picks up where it left off
- The queue processor (PUT /sync-queue) and direct sync (/inbox-cache/sync) both use fast-forward
- Cron processes the queue every 30 minutes with a 12-minute time budget
- Client polls the queue while the user is on the page
- Per-user Gmail quota: 250 calls/min — stay under with 2-3s delays between pages

### CRITICAL: User Data Isolation
All features and updates MUST ensure full user isolation at all times:
- Every Supabase query MUST filter by `user_id` — never return or modify another user's data
- API routes use `getRequestContext(request)` to extract the authenticated `user_id` from cookies
- Gmail API calls use per-user OAuth tokens scoped to `user_id` + `account_email`
- The cron job processes all users but stores results per `user_id`
- localStorage keys are shared per domain — do NOT store user-specific sensitive data there
- Auth uses `getUserByEmail()` (not `listUsers()`) to prevent duplicate user creation
- When adding new tables or features, always include `user_id` in the schema and filter by it

### Every new feature MUST be documented in the Home tab How-To section
When adding any new feature, update the `HomeTab` component's "How Email Helper works" guide
and/or the "Pro tips" section so users can discover and learn it. This is critical for UX.

### Sender Tier System
- Tier A: VIPs (top priority, green)
- Tier B: Important (yellow)
- Tier C: Regular (blue) — goes to Triage
- Tier D: Low priority (gray) — goes to Cleanup
- Unknown senders also go to Cleanup

### Queue System
- Reply queue items have statuses: active, snoozed, done
- PUT `/api/emailHelperV2/queue` supports both `id` (Supabase UUID) and `message_id` (Gmail ID)
- POST `/api/emailHelperV2/queue` creates new queue entries (used when snoozing from tabs without existing entries)

### Multi-Account
- Module-level `_currentAccount` with `withAccount()` for API routing
- `setCurrentAccount()` must be called before API calls for a specific account
- Always restore `savedAccount` after multi-account operations

### Auto-Archive
- Per-sender `auto_archive_updates` flag in sender_priorities table
- Triage engine auto-archives non-reply-needed messages from senders with this flag
- Toggle available in Priorities tab sender table

### CSS Variables
- `--accent`: primary blue (#4f46e5)
- `--urgent` / `--urgent-bg`: indigo (#6366f1 / #eef2ff)
- `--important` / `--important-bg`: amber
- `--normal` / `--normal-bg`: green
- `--bg`: page background (#f8f9fa)

### File Sync Warning
- The local project at `~/Documents/email-helper-app` is the **source of truth** that feeds GitHub and Netlify deployments.
- **ALWAYS `git pull origin main` before making any edits** to ensure the local file matches GitHub.
- If the local file is outdated, fetch from origin and overwrite it before making changes.
- After editing, commit and push: `git add <files> && git commit -m "message" && git push origin main`

## Build & Deploy
```bash
npm run build   # Build the app
git push         # Auto-deploys to Netlify
```

## Supabase Tables
- `sender_priorities` — sender email, display_name, tier, reply_count, auto_archive_updates, aliases, accounts_seen
- `reply_queue` — message_id, thread_id, account_email, sender, subject, summary, priority, status, snoozed_until
- `triage_results` — cached triage output per user/account
- `notification_rules` — pattern-based rules with priority scores
- `connected_accounts` — multi-account OAuth tokens
- `emailHelperV2_action_history` — undo-able action log (user_id, action, action_label, message_ids, account_email, subjects, undo_action, undone)
