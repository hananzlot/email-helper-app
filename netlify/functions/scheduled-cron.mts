// Runs every 30 minutes
export default async () => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://emaihelper.netlify.app";
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyhqkfyfovcuxhiejgx.supabase.co";
  const cronSecret = process.env.CRON_SECRET || "";

  const authHeaders = { Authorization: `Bearer ${cronSecret}` };

  // 1. Run the regular cron (scan sent, follow-ups, cache cleanup)
  try {
    const cronRes = await fetch(`${appUrl}/api/emailHelperV2/cron`, { headers: authHeaders });
    const cronData = await cronRes.json().catch(() => ({}));
    console.log("Cron:", JSON.stringify(cronData).slice(0, 300));
  } catch (e) {
    console.error("Cron failed:", e);
  }

  // 2. Submit sync jobs for all connected accounts
  try {
    const accountsRes = await fetch(`${supabaseUrl}/rest/v1/emailHelperV2_gmail_accounts?select=user_id,email&status=eq.connected`, {
      headers: { apikey: srk, Authorization: `Bearer ${srk}` },
    });
    const accounts = await accountsRes.json().catch(() => []);

    for (const account of accounts) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/emailHelperV2_sync_queue`, {
          method: "POST",
          headers: { apikey: srk, Authorization: `Bearer ${srk}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: account.user_id, account_email: account.email, status: "pending", priority: 5 }),
        });
      } catch {}
    }
    console.log(`Submitted ${accounts.length} sync jobs`);
  } catch (e) {
    console.error("Queue submission failed:", e);
  }

  // 3. Process the queue — each PUT handles one page with fast-forward (skips 50 cached pages)
  const maxMinutes = 12;
  const startTime = Date.now();
  let pagesProcessed = 0;
  let consecutiveErrors = 0;

  while ((Date.now() - startTime) < maxMinutes * 60 * 1000) {
    try {
      const res = await fetch(`${appUrl}/api/emailHelperV2/sync-queue`, { method: "PUT", headers: authHeaders });
      const data = await res.json();

      if (!data.success || data.data?.idle) {
        console.log("Queue idle — stopping");
        break;
      }

      if (data.data?.status === "error") {
        consecutiveErrors++;
        console.log(`Job error (${consecutiveErrors}): ${data.data.error?.slice(0, 80)}`);
        if (consecutiveErrors >= 10) {
          console.log("10 consecutive errors — pausing 2 minutes then resuming");
          await new Promise(r => setTimeout(r, 2 * 60 * 1000));
          consecutiveErrors = 0;
        } else if (data.data.error?.includes("Quota")) {
          await new Promise(r => setTimeout(r, 30000));
        }
        continue;
      }
      consecutiveErrors = 0;

      pagesProcessed++;
      const skipped = data.data?.skippedPages || 0;
      if (skipped > 0) pagesProcessed += skipped;

      if (pagesProcessed % 20 === 0) {
        console.log(`Processed ${pagesProcessed} pages (incl fast-forward)...`);
      }

      if (data.data?.status === "done") {
        console.log(`Job complete`);
      }

      // Rate limit: 2s between pages
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error("Queue error:", e);
      break;
    }
  }

  console.log(`Done: ${pagesProcessed} pages in ${Math.round((Date.now() - startTime) / 1000)}s`);
};

export const config = {
  schedule: "*/30 * * * *",
};
