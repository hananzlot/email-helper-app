// Runs every 30 minutes
export default async () => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://emaihelper.netlify.app";
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyhqkfyfovcuxhiejgx.supabase.co";

  // 1. Run the regular cron (scan sent, follow-ups, cache cleanup)
  try {
    const cronRes = await fetch(`${appUrl}/api/emailHelperV2/cron`);
    const cronData = await cronRes.json().catch(() => ({}));
    console.log("Cron:", JSON.stringify(cronData).slice(0, 300));
  } catch (e) {
    console.error("Cron failed:", e);
  }

  // 2. Direct sync for all connected accounts (no queue overhead)
  try {
    const accountsRes = await fetch(`${supabaseUrl}/rest/v1/emailHelperV2_gmail_accounts?select=user_id,email&status=eq.connected`, {
      headers: { apikey: srk, Authorization: `Bearer ${srk}` },
    });
    const accounts = await accountsRes.json().catch(() => []);
    console.log(`Syncing ${accounts.length} accounts...`);

    const maxPagesPerAccount = 200;
    const maxMinutesTotal = 12; // Stay under 15-min Netlify limit
    const startTime = Date.now();

    for (const account of accounts) {
      // Check time budget
      if ((Date.now() - startTime) > maxMinutesTotal * 60 * 1000) {
        console.log("Time budget exceeded — stopping");
        break;
      }

      let pagesProcessed = 0;
      let totalCached = 0;
      let consecutiveEmpty = 0;

      while (pagesProcessed < maxPagesPerAccount) {
        // Time check per iteration
        if ((Date.now() - startTime) > maxMinutesTotal * 60 * 1000) break;

        try {
          const syncRes = await fetch(`${appUrl}/api/emailHelperV2/inbox-cache/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: account.user_id,
              account_email: account.email,
            }),
          });
          const data = await syncRes.json();

          if (!data.success) {
            console.log(`${account.email}: error — ${data.error?.slice(0, 80)}`);
            // Quota error — wait 30 seconds then continue to next account
            if (data.error?.includes("Quota")) {
              await new Promise(r => setTimeout(r, 30000));
            }
            break;
          }

          const cached = data.data?.cachedThisPage || 0;
          const skipped = data.data?.skippedPages || 0;
          totalCached += cached;
          pagesProcessed += 1 + skipped;

          if (cached === 0) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 5) {
              // 5 empty pages in a row after fast-forward — likely done or in deep cache
              break;
            }
          } else {
            consecutiveEmpty = 0;
          }

          if (data.data?.done) {
            console.log(`${account.email}: sync complete! +${totalCached} new, ${pagesProcessed} pages`);
            break;
          }

          // Rate limit: 2 second delay between pages
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.error(`${account.email}: sync call failed — ${e}`);
          break;
        }
      }

      if (pagesProcessed > 0 && totalCached > 0) {
        console.log(`${account.email}: +${totalCached} new messages in ${pagesProcessed} pages`);
      }
    }
  } catch (e) {
    console.error("Sync loop failed:", e);
  }

  console.log(`Done in ${Math.round((Date.now() - Date.now()) / 1000)}s`);
};

export const config = {
  schedule: "*/30 * * * *",
};
