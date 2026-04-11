// Runs 3x daily at 8am, 2pm, 8pm UTC
export default async () => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://emaihelper.netlify.app";
  const res = await fetch(`${appUrl}/api/emailHelperV2/cron`);
  const data = await res.json();
  console.log("Cron result:", JSON.stringify(data));
};

export const config = {
  schedule: "0 8,14,20 * * *",
};
