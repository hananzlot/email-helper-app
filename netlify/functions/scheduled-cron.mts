// Runs 3x daily at 8am, 2pm, 8pm UTC
export default async () => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://emaihelper.netlify.app";
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyhqkfyfovcuxhiejgx.supabase.co";

  // 1. Run the regular cron (scan sent, follow-ups, cache cleanup)
  try {
    const cronRes = await fetch(`${appUrl}/api/emailHelperV2/cron`);
    const cronData = await cronRes.json().catch(() => ({}));
    console.log("Cron result:", JSON.stringify(cronData).slice(0, 500));
  } catch (e) {
    console.error("Cron failed:", e);
  }

  // 2. Submit sync jobs for all connected accounts
  try {
    const accountsRes = await fetch(`${supabaseUrl}/rest/v1/emailHelperV2_gmail_accounts?select=user_id,email&status=eq.connected`, {
      headers: { apikey: srk, Authorization: `Bearer ${srk}` },
    });
    const accounts = await accountsRes.json().catch(() => []);

    // Submit each account to the queue
    for (const account of accounts) {
      try {
        // Insert pending job directly into Supabase (bypass auth)
        await fetch(`${supabaseUrl}/rest/v1/emailHelperV2_sync_queue`, {
          method: "POST",
          headers: {
            apikey: srk, Authorization: `Bearer ${srk}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            user_id: account.user_id,
            account_email: account.email,
            status: "pending",
            priority: 5,
          }),
        });
      } catch {}
    }
    console.log(`Submitted ${accounts.length} sync jobs to queue`);
  } catch (e) {
    console.error("Queue submission failed:", e);
  }

  // 3. Process the queue — one page at a time, rate-limited
  // Process up to 200 pages total (across all accounts) per cron run
  let pagesProcessed = 0;
  const maxPages = 200;

  while (pagesProcessed < maxPages) {
    try {
      const res = await fetch(`${appUrl}/api/emailHelperV2/sync-queue`, { method: "PUT" });
      const data = await res.json();

      if (!data.success || data.data?.idle) {
        console.log("Queue idle or empty — stopping");
        break;
      }

      if (data.data?.status === "error") {
        console.log(`Job error: ${data.data.error}`);
        continue;
      }

      pagesProcessed++;
      if (pagesProcessed % 20 === 0) {
        console.log(`Processed ${pagesProcessed} pages...`);
      }

      if (data.data?.status === "done") {
        console.log(`Job ${data.data.jobId} complete`);
      }

      // Rate limit: wait 3 seconds between pages
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error("Queue processing error:", e);
      break;
    }
  }

  console.log(`Queue processing done: ${pagesProcessed} pages processed`);
};

export const config = {
  schedule: "*/30 * * * *",
};
