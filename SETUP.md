# Email Helper — Setup Guide

## Prerequisites
- Node.js 18+
- A Google Cloud project
- A Supabase project
- A Netlify account
- A GitHub repository

---

## Step 1: Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the **Gmail API**:
   - APIs & Services → Library → Search "Gmail API" → Enable
4. Configure the **OAuth consent screen**:
   - APIs & Services → OAuth consent screen
   - Choose **External** (so anyone can sign up)
   - Fill in the app name: "Email Helper"
   - Add your email as a test user (required during development)
   - Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.send`, `gmail.labels`, `openid`, `email`, `profile`
5. Create **OAuth 2.0 credentials**:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/callback` (development)
     - `https://your-app.netlify.app/api/auth/callback` (production)
   - Copy the **Client ID** and **Client Secret**

## Step 2: Supabase Setup

1. Go to [Supabase](https://supabase.com/) and create a new project
2. Go to **SQL Editor** and paste the contents of `supabase-schema.sql`, then run it
3. Go to **Settings → API** and copy:
   - Project URL (`NEXT_PUBLIC_SUPABASE_URL`)
   - Anon public key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
   - Service role key (`SUPABASE_SERVICE_ROLE_KEY`)

## Step 3: Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Step 4: Run Locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 and click "Sign in with Google."

## Step 5: Deploy to Netlify

1. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USER/email-helper-app.git
   git push -u origin main
   ```

2. In Netlify:
   - Import from Git → Select your repo
   - Build command: `npm run build`
   - Publish directory: `.next`
   - Install the **@netlify/plugin-nextjs** plugin
   - Add all environment variables from `.env.local` to Netlify's environment settings
   - Update `NEXT_PUBLIC_APP_URL` to your Netlify URL

3. Update Google Cloud redirect URI:
   - Go back to Google Cloud Console → Credentials
   - Add `https://your-app.netlify.app/api/auth/callback` as an authorized redirect URI

## Step 6: Go to Production

To leave "testing" mode on Google Cloud:
1. OAuth consent screen → Publishing status → Publish App
2. Submit for Google verification (required for >100 users)
3. You'll need a privacy policy URL and terms of service URL

---

## Architecture

```
┌─────────────────────────────────────┐
│           Netlify (CDN)             │
│  Next.js App (React + API Routes)  │
├─────────────────────────────────────┤
│                                     │
│  /api/auth/login    → Google OAuth  │
│  /api/auth/callback → Token store   │
│  /api/gmail         → Gmail API     │
│                                     │
├──────────────┬──────────────────────┤
│              │                      │
│   Supabase   │    Gmail API         │
│   (Auth +    │    (Read, Write,     │
│    Database) │     Send, Delete)    │
│              │                      │
└──────────────┴──────────────────────┘
```

## API Reference

### GET /api/gmail?action=ACTION&account=EMAIL

| Action   | Params            | Description                   |
|----------|-------------------|-------------------------------|
| profile  |                   | Get Gmail profile             |
| inbox    | q, max, pageToken | List inbox messages           |
| message  | id, format        | Get single message            |
| thread   | id                | Get thread                    |
| search   | q, max, pageToken | Search messages               |
| labels   |                   | List all labels               |
| drafts   | max               | List drafts                   |

### POST /api/gmail

| Action      | Body                              | Description           |
|-------------|-----------------------------------|-----------------------|
| archive     | { messageIds }                    | Archive messages      |
| trash       | { messageIds }                    | Move to trash         |
| delete      | { messageIds }                    | Permanently delete    |
| markRead    | { messageIds }                    | Mark as read          |
| markUnread  | { messageIds }                    | Mark as unread        |
| star        | { messageIds }                    | Star messages         |
| unstar      | { messageIds }                    | Unstar messages       |
| addLabel    | { messageIds, labelId }           | Add label             |
| removeLabel | { messageIds, labelId }           | Remove label          |
| send        | { to, subject, body, cc?, ... }   | Send email            |
| createDraft | { to, subject, body, cc?, ... }   | Create draft          |
| updateDraft | { draftId, to, subject, body }    | Update draft          |
| deleteDraft | { draftId }                       | Delete draft          |
