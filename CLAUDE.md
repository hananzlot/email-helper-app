# Email Helper App — Development Guide

## Project Location
- **Local path**: `~/Documents/email-helper-app`
- **GitHub**: `github.com/hananzlot/email-helper-app`
- **Deployed**: `emaihelper.netlify.app`
- **Cowork mount**: Always select `~/Documents/email-helper-app` — do NOT use `~/Email Helper/email-helper-app` (that is an outdated copy)

## Architecture
- **Next.js App Router** with TypeScript, deployed on Netlify
- **Supabase** backend (auth, sender priorities, reply queue, triage results, notification rules)
- **Gmail API** via `googleapis` — full CRUD, thread fetching, reply detection
- **Multi-account support** with unified view merging all connected Gmail accounts

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
