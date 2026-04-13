'use client';

import { useState, useEffect } from 'react';

const DEFAULT_SETTINGS = {
  max_emails_per_account: 100000,
  cron_schedule: '0 8,14,20 * * *',
  cache_freshness_minutes: 0,
  triage_auto_interval_minutes: 2,
};

type Settings = typeof DEFAULT_SETTINGS;

export default function AdminPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('clearbox_admin_settings');
      if (stored) setSettings(JSON.parse(stored));
    } catch {}
    // Check if already authenticated this session
    if (sessionStorage.getItem('clearbox_admin_auth') === 'true') setAuthenticated(true);
  }, []);

  function save() {
    localStorage.setItem('clearbox_admin_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/emailHelperV2/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthenticated(true);
        sessionStorage.setItem('clearbox_admin_auth', 'true');
      } else {
        alert('Incorrect password');
      }
    } catch {
      alert('Auth check failed');
    }
  }

  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: '#f8f9fa' }}>
        <form onSubmit={handleAuth} className="max-w-sm w-full mx-auto p-4 sm:p-6 rounded-xl border bg-white shadow-sm">
          <h1 className="text-xl font-bold mb-4">Admin Access</h1>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="w-full px-4 py-2 text-sm rounded-lg border mb-3 focus:outline-none focus:ring-2"
            style={{ borderColor: '#d1d5db' }}
            autoFocus
          />
          <button type="submit" className="w-full px-4 py-2 text-sm font-semibold rounded-lg text-white" style={{ background: '#4f46e5' }}>
            Sign In
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Admin Settings</h1>
          <p className="text-sm" style={{ color: '#64748b' }}>Configure system-wide settings for Clearbox</p>
        </div>
        <a href="/dashboard" className="text-sm underline" style={{ color: '#4f46e5' }}>Back to Dashboard</a>
      </div>

      <div className="flex flex-col gap-4">
        {/* Max emails per account */}
        <div className="p-4 rounded-xl border" style={{ background: 'white', borderColor: '#e2e8f0' }}>
          <label className="block text-sm font-semibold mb-1">Max Emails Per Account</label>
          <p className="text-xs mb-2" style={{ color: '#64748b' }}>Maximum number of emails to fetch and cache per Gmail account. Higher = slower initial load but more complete data.</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={settings.max_emails_per_account}
              onChange={(e) => setSettings({ ...settings, max_emails_per_account: Number(e.target.value) })}
              className="w-40 px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2"
              style={{ borderColor: '#d1d5db' }}
              min={1000}
              max={500000}
              step={1000}
            />
            <span className="text-xs" style={{ color: '#64748b' }}>Current: {settings.max_emails_per_account.toLocaleString()}</span>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {[10000, 50000, 100000, 200000, 500000].map(v => (
              <button key={v} onClick={() => setSettings({ ...settings, max_emails_per_account: v })}
                className="px-2.5 py-1 text-[10px] rounded-full border font-medium"
                style={{ borderColor: settings.max_emails_per_account === v ? '#4f46e5' : '#e2e8f0', background: settings.max_emails_per_account === v ? '#eef2ff' : 'white', color: settings.max_emails_per_account === v ? '#4f46e5' : '#64748b' }}>
                {(v / 1000)}k
              </button>
            ))}
          </div>
        </div>

        {/* Triage auto-refresh interval */}
        <div className="p-4 rounded-xl border" style={{ background: 'white', borderColor: '#e2e8f0' }}>
          <label className="block text-sm font-semibold mb-1">Triage Auto-Refresh Interval</label>
          <p className="text-xs mb-2" style={{ color: '#64748b' }}>How often (in minutes) the inbox auto-refreshes and re-runs triage in the background.</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={settings.triage_auto_interval_minutes}
              onChange={(e) => setSettings({ ...settings, triage_auto_interval_minutes: Number(e.target.value) })}
              className="w-24 px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2"
              style={{ borderColor: '#d1d5db' }}
              min={1}
              max={30}
            />
            <span className="text-xs" style={{ color: '#64748b' }}>minutes</span>
          </div>
        </div>

        {/* Cron schedule */}
        <div className="p-4 rounded-xl border" style={{ background: 'white', borderColor: '#e2e8f0' }}>
          <label className="block text-sm font-semibold mb-1">Background Cron Schedule</label>
          <p className="text-xs mb-2" style={{ color: '#64748b' }}>Cron expression for the background job that scans sent mail and computes follow-ups. Runs on Netlify.</p>
          <input
            type="text"
            value={settings.cron_schedule}
            onChange={(e) => setSettings({ ...settings, cron_schedule: e.target.value })}
            className="w-full px-3 py-2 text-sm rounded-lg border font-mono focus:outline-none focus:ring-2"
            style={{ borderColor: '#d1d5db' }}
            placeholder="0 8,14,20 * * *"
          />
          <p className="text-[10px] mt-1" style={{ color: '#94a3b8' }}>Note: Changing this requires redeploying the Netlify scheduled function.</p>
        </div>

        {/* System info */}
        <div className="p-4 rounded-xl border" style={{ background: '#f8fafc', borderColor: '#e2e8f0' }}>
          <label className="block text-sm font-semibold mb-2">System Info</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs" style={{ color: '#475569' }}>
            <div>Supabase Project: <span className="font-mono">ybyhqkfyfovcuxhiejgx</span></div>
            <div>Netlify Site: <span className="font-mono">emaihelper</span></div>
            <div>Deploy: <span className="font-mono">auto on push to main</span></div>
            <div>Cron: <span className="font-mono">3x daily (8am, 2pm, 8pm UTC)</span></div>
          </div>
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3">
          <button onClick={save}
            className="px-6 py-2.5 text-sm font-semibold rounded-lg text-white transition-all hover:shadow-md"
            style={{ background: '#4f46e5' }}>
            Save Settings
          </button>
          {saved && <span className="text-sm font-medium" style={{ color: '#16a34a' }}>Saved!</span>}
        </div>
      </div>
    </div>
  );
}
