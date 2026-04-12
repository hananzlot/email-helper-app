// Runs 3x daily at 8am, 2pm, 8pm UTC
export default async () => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://emaihelper.netlify.app";

  // 1. Run the regular cron (scan sent, follow-ups)
  try {
    const cronRes = await fetch(`${appUrl}/api/emailHelperV2/cron`);
    const cronData = await cronRes.json().catch(() => ({}));
    console.log("Cron result:", JSON.stringify(cronData));
  } catch (e) {
    console.error("Cron failed:", e);
  }

  // 2. Chain inbox cache sync for all accounts
  //    Each call processes one page (200 messages) and returns the next page token
  try {
    // Get all connected accounts from the cron results or fetch directly
    const accountsRes = await fetch(`${appUrl}/rest/v1/emailHelperV2_gmail_accounts?select=user_id,email&status=eq.connected`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ""}`,
      },
    });
    const accounts = await accountsRes.json().catch(() => []);

    for (const account of accounts) {
      let pages = 0;
      const maxPages = 100; // 100 pages x 200 = 20,000 messages per account per cron run
      let nextToken: string | null = null;
      let isFirstCall = true;

      do {
        try {
          // First call: no pageToken = auto-resume from saved position
          const syncBody: Record<string, string> = {
            user_id: account.user_id,
            account_email: account.email,
          };
          if (!isFirstCall && nextToken) {
            syncBody.pageToken = nextToken;
          }

          const syncRes = await fetch(`${appUrl}/api/emailHelperV2/inbox-cache/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(syncBody),
          });
          const syncData = await syncRes.json();
          isFirstCall = false;

          if (!syncData.success) {
            console.log(`Sync error for ${account.email}:`, syncData.error);
            break;
          }

          nextToken = syncData.data.nextPageToken;
          pages++;

          if (pages % 10 === 0 || syncData.data.cachedThisPage > 0) {
            console.log(`${account.email}: page ${pages}, +${syncData.data.cachedThisPage} new, skipped ${syncData.data.skippedExisting}`);
          }

          if (syncData.data.done) {
            console.log(`${account.email}: sync complete!`);
            break;
          }
        } catch (e) {
          console.error(`Sync call failed for ${account.email}:`, e);
          break;
        }
      } while (nextToken && pages < maxPages);

      console.log(`${account.email}: processed ${pages} pages`);
    }
  } catch (e) {
    console.error("Inbox sync failed:", e);
  }
};

export const config = {
  schedule: "0 8,14,20 * * *",
};
