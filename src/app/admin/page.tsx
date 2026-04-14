'use client';

import { useState, useEffect, useCallback } from 'react';

const DEFAULT_SETTINGS = {
  max_emails_per_account: 100000,
  cron_schedule: '0 8,14,20 * * *',
  cache_freshness_minutes: 0,
  triage_auto_interval_minutes: 2,
};

type Settings = typeof DEFAULT_SETTINGS;

interface FeedbackEntry {
  id: string;
  user_email: string;
  type: 'bug' | 'feature' | 'feedback';
  message: string;
  status: 'new' | 'reviewed' | 'resolved';
  admin_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export default function AdminPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [activeSection, setActiveSection] = useState<'settings' | 'feedback'>('settings');
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackFilter, setFeedbackFilter] = useState<'all' | 'new' | 'reviewed' | 'resolved'>('all');

  const loadFeedback = useCallback(async () => {
    setFeedbackLoading(true);
    try {
      const res = await fetch('/api/emailHelperV2/feedback?admin=true', {
        headers: { 'x-admin-auth': 'true' },
      }).then(r => r.json());
      if (res.success) setFeedback(res.data || []);
    } catch {}
    setFeedbackLoading(false);
  }, []);

  async function updateFeedback(id: string, updates: { status?: string; admin_notes?: string }) {
    await fetch('/api/emailHelperV2/feedback', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-auth': 'true' },
      body: JSON.stringify({ id, ...updates }),
    });
    loadFeedback();
  }

  useEffect(() => {
    try {
      const stored = localStorage.getItem('clearbox_admin_settings');
      if (stored) setSettings(JSON.parse(stored));
    } catch {}
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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <p className="text-sm" style={{ color: '#64748b' }}>Manage Clearbox settings and user feedback</p>
        </div>
        <a href="/dashboard" className="text-sm underline" style={{ color: '#4f46e5' }}>Back to Dashboard</a>
      </div>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setActiveSection('settings')}
          className="px-4 py-2 text-sm font-semibold rounded-lg transition-all"
          style={{ background: activeSection === 'settings' ? '#4f46e5' : '#f1f5f9', color: activeSection === 'settings' ? 'white' : '#64748b' }}>
          Settings
        </button>
        <button onClick={() => { setActiveSection('feedback'); loadFeedback(); }}
          className="px-4 py-2 text-sm font-semibold rounded-lg transition-all"
          style={{ background: activeSection === 'feedback' ? '#4f46e5' : '#f1f5f9', color: activeSection === 'feedback' ? 'white' : '#64748b' }}>
          User Feedback
          {feedback.filter(f => f.status === 'new').length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 text-[10px] font-bold rounded-full text-white" style={{ background: '#ef4444' }}>
              {feedback.filter(f => f.status === 'new').length}
            </span>
          )}
        </button>
      </div>

      {activeSection === 'settings' && <div className="flex flex-col gap-4">
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
      </div>}

      {activeSection === 'feedback' && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            {(['all', 'new', 'reviewed', 'resolved'] as const).map(f => (
              <button key={f} onClick={() => setFeedbackFilter(f)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border transition-all capitalize"
                style={{
                  borderColor: feedbackFilter === f ? '#4f46e5' : '#e2e8f0',
                  background: feedbackFilter === f ? '#eef2ff' : 'white',
                  color: feedbackFilter === f ? '#4f46e5' : '#64748b',
                }}>
                {f} {f !== 'all' && <span className="ml-1 opacity-70">({feedback.filter(fb => fb.status === f).length})</span>}
              </button>
            ))}
            <button onClick={loadFeedback} disabled={feedbackLoading}
              className="ml-auto px-3 py-1.5 text-xs font-medium rounded-lg border hover:bg-gray-50"
              style={{ borderColor: '#e2e8f0', color: '#64748b' }}>
              {feedbackLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {feedback.filter(f => feedbackFilter === 'all' || f.status === feedbackFilter).length === 0 ? (
            <div className="text-center py-12" style={{ color: '#94a3b8' }}>
              <p className="text-sm">{feedbackLoading ? 'Loading feedback...' : 'No feedback yet'}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {feedback
                .filter(f => feedbackFilter === 'all' || f.status === feedbackFilter)
                .map(entry => (
                  <FeedbackCard key={entry.id} entry={entry} onUpdate={updateFeedback} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FeedbackCard({ entry, onUpdate }: { entry: FeedbackEntry; onUpdate: (id: string, updates: { status?: string; admin_notes?: string }) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(entry.admin_notes || '');

  const typeStyle = entry.type === 'bug' ? { bg: '#fef2f2', color: '#dc2626', label: 'Bug' }
    : entry.type === 'feature' ? { bg: '#f0fdf4', color: '#059669', label: 'Feature' }
    : { bg: '#eef2ff', color: '#4f46e5', label: 'Feedback' };

  const statusStyle = entry.status === 'new' ? { bg: '#fef3c7', color: '#d97706' }
    : entry.status === 'reviewed' ? { bg: '#dbeafe', color: '#2563eb' }
    : { bg: '#dcfce7', color: '#16a34a' };

  return (
    <div className="p-4 rounded-xl border" style={{ background: 'white', borderColor: '#e2e8f0' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full" style={{ background: typeStyle.bg, color: typeStyle.color }}>{typeStyle.label}</span>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full capitalize" style={{ background: statusStyle.bg, color: statusStyle.color }}>{entry.status}</span>
            <span className="text-[10px]" style={{ color: '#94a3b8' }}>{new Date(entry.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </div>
          <div className="text-xs mb-1" style={{ color: '#64748b' }}>{entry.user_email}</div>
          <div className="text-sm whitespace-pre-wrap" style={{ color: '#1e293b' }}>{entry.message}</div>
        </div>
        <button onClick={() => setExpanded(!expanded)}
          className="px-2 py-1 text-[10px] font-medium rounded border hover:bg-gray-50 flex-shrink-0"
          style={{ borderColor: '#e2e8f0', color: '#64748b' }}>
          {expanded ? 'Close' : 'Actions'}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: '#f1f5f9' }}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Admin notes..."
            className="w-full px-3 py-2 text-xs rounded-lg border resize-none mb-2 focus:outline-none focus:ring-2"
            style={{ borderColor: '#e2e8f0', minHeight: 60 }}
          />
          <div className="flex gap-2">
            {entry.status !== 'reviewed' && (
              <button onClick={() => onUpdate(entry.id, { status: 'reviewed', admin_notes: notes })}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: '#2563eb' }}>
                Mark Reviewed
              </button>
            )}
            {entry.status !== 'resolved' && (
              <button onClick={() => onUpdate(entry.id, { status: 'resolved', admin_notes: notes })}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: '#16a34a' }}>
                Mark Resolved
              </button>
            )}
            {notes !== (entry.admin_notes || '') && (
              <button onClick={() => onUpdate(entry.id, { admin_notes: notes })}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: '#e2e8f0', color: '#64748b' }}>
                Save Notes
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
