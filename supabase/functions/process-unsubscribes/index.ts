// Supabase Edge Function: Process pending unsubscribe queue
// Invoked by pg_cron every 5 minutes
// Processes up to 3 minutes of pending unsubscribes (5s pacing = ~36 max per run)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UNSUB_TABLE = "emailHelperV2_unsubscribe_log";
const APP_URL = Deno.env.get("APP_URL") || "https://emaihelper.netlify.app";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const BUDGET_MS = 3 * 60 * 1000;
  const PUT_TIMEOUT_MS = 20_000; // 20s timeout per PUT call
  const start = Date.now();
  let processed = 0;
  const results: { sender: string; status: string }[] = [];

  while (Date.now() - start < BUDGET_MS) {
    const { data: pending } = await supabase
      .from(UNSUB_TABLE)
      .select("id")
      .eq("status", "pending")
      .order("attempted_at", { ascending: true })
      .limit(1)
      .single();

    if (!pending) break;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUT_TIMEOUT_MS);

      const putRes = await fetch(`${APP_URL}/api/emailHelperV2/unsubscribe`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const putData = await putRes.json().catch(() => ({}));

      if (putData.data?.idle) break;

      if (putData.data?.status === "quota_retry") {
        results.push({ sender: "quota", status: "quota_retry" });
        break;
      }

      processed++;
      results.push({
        sender: putData.data?.senderEmail || "?",
        status: putData.data?.status || "?",
      });

      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      const errMsg = String(e);
      if (errMsg.includes("abort")) {
        // PUT timed out — skip this item (it'll be reset to pending by the stuck-recovery logic)
        results.push({ sender: "timeout", status: "skipped" });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      results.push({ sender: "error", status: errMsg });
      break;
    }
  }

  return new Response(
    JSON.stringify({ processed, elapsed_ms: Date.now() - start, results }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
