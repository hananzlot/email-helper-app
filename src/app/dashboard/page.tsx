'use client';

import { useState, useEffect, useCallback } from 'react';
import type { TriagedEmail, SenderPriority, NotificationRule, GmailMessage } from '@/types';

// ============ API HELPERS ============

async function gmailGet(action: string, params: Record<string, string> = {}) {
  const searchParams = new URLSearchParams({ action, ...params });
  const res = await fetch(`/api/emailHelperV2/gmail?${searchParams}`);
  return res.json();
}

async function gmailPost(action: string, data: Record<string, unknown> = {}) {
  const res = await fetch('/api/emailHelperV2/gmail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...data }),
  });
  return res.json();
}

// ============ MAIN DASHBOARD ============

type Tab = 'inbox' | 'reply-queue' | 'cleanup' | 'priorities' | 'accounts';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('inbox');
  const [account, setAccount] = useState<string>('');
  const [profile, setProfile] = useState<{ emailAddress: string } | null>(null);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ title: string; subtitle?: string } | null>(null);

  // Load account from URL params first, then cookies
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Primary login flow — account comes in the URL
    const urlAccount = params.get('account');
    if (urlAccount) {
      setAccount(urlAccount);
      // Store in cookie for future page loads
      document.cookie = `email_helper_account=${urlAccount};path=/;max-age=${60*60*24*30};samesite=lax`;
      // Clean URL
      window.history.replaceState({}, '', '/dashboard');
      return;
    }

    // Check for newly added account
    const added = params.get('account_added');
    if (added) {
      showToast('Account connected', added);
      window.history.replaceState({}, '', '/dashboard');
    }

    // Fall back to cookie
    const cookies = document.cookie.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      if (k && v) acc[k] = decodeURIComponent(v);
      return acc;
    }, {} as Record<string, string>);
    if (cookies.email_helper_account) {
      setAccount(cookies.email_helper_account);
    }
  }, []);

  // Fetch inbox when account changes
  useEffect(() => {
    if (!account) return;
    loadInbox();
  }, [account]);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, inboxRes] = await Promise.all([
        gmailGet('profile'),
        gmailGet('inbox', { q: 'in:inbox is:unread', max: '30' }),
      ]);
      if (profileRes.success) setProfile(profileRes.data);
      if (inboxRes.success) setMessages(inboxRes.data.messages);
    } catch (err) {
      console.error('Failed to load inbox:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  function showToast(title: string, subtitle?: string) {
    setToast({ title, subtitle });
    setTimeout(() => setToast(null), 3000);
  }

  // ============ GMAIL ACTIONS ============

  async function handleAction(action: string, messageIds: string[], label?: string) {
    setActionLoading(messageIds[0]);
    try {
      const params: Record<string, unknown> = { action, messageIds };
      if (label) params.labelId = label;
      const res = await gmailPost(action, params);
      if (res.success) {
        showToast(`${action} completed`, `${messageIds.length} message(s)`);
        // Remove from list
        setMessages((prev) => prev.filter((m) => !messageIds.includes(m.id)));
      } else {
        showToast('Error', res.error);
      }
    } catch (err) {
      showToast('Error', String(err));
    } finally {
      setActionLoading(null);
    }
  }

  // ============ RENDER ============

  const tabs: { id: Tab; label: string }[] = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'reply-queue', label: 'Reply Queue' },
    { id: 'cleanup', label: 'Cleanup' },
    { id: 'priorities', label: 'My Priorities' },
    { id: 'accounts', label: 'Accounts' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold">Email Helper</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Inbox Command Center
          </p>
        </div>
        {profile && (
          <div className="text-sm px-4 py-2 rounded-lg" style={{ background: 'var(--normal-bg)', color: '#065f46' }}>
            Connected: <strong>{profile.emailAddress}</strong>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b-2 mb-6" style={{ borderColor: 'var(--border)' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-6 py-3 text-sm font-medium transition-all border-b-2 -mb-[2px]"
            style={{
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--muted)',
              borderBottomColor: activeTab === tab.id ? 'var(--accent)' : 'transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'inbox' && (
        <InboxTab
          messages={messages}
          loading={loading}
          actionLoading={actionLoading}
          onAction={handleAction}
          onRefresh={loadInbox}
        />
      )}
      {activeTab === 'reply-queue' && <ReplyQueueTab />}
      {activeTab === 'cleanup' && <CleanupTab messages={messages} onAction={handleAction} />}
      {activeTab === 'priorities' && <PrioritiesTab />}
      {activeTab === 'accounts' && <AccountsTab currentAccount={account} />}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl text-white text-sm font-medium shadow-lg z-50 text-center"
          style={{ background: '#1e293b' }}>
          <div className="font-semibold">{toast.title}</div>
          {toast.subtitle && <div className="text-xs opacity-70 mt-0.5">{toast.subtitle}</div>}
        </div>
      )}
    </div>
  );
}

// ============ INBOX TAB ============

function InboxTab({
  messages,
  loading,
  actionLoading,
  onAction,
  onRefresh,
}: {
  messages: GmailMessage[];
  loading: boolean;
  actionLoading: string | null;
  onAction: (action: string, ids: string[], label?: string) => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === messages.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(messages.map((m) => m.id)));
    }
  }

  const selectedIds = Array.from(selected);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button onClick={onRefresh} disabled={loading}
          className="px-4 py-2 text-sm font-medium rounded-lg text-white"
          style={{ background: 'var(--accent)' }}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
        {messages.length > 0 && (
          <button onClick={selectAll} className="px-3 py-2 text-xs rounded-lg border"
            style={{ borderColor: 'var(--border)' }}>
            {selected.size === messages.length ? 'Deselect All' : 'Select All'}
          </button>
        )}
        {selected.size > 0 && (
          <>
            <button onClick={() => { onAction('archive', selectedIds); setSelected(new Set()); }}
              className="px-3 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              Archive ({selected.size})
            </button>
            <button onClick={() => { onAction('trash', selectedIds); setSelected(new Set()); }}
              className="px-3 py-2 text-xs font-medium rounded-lg border text-red-600" style={{ borderColor: 'var(--border)' }}>
              Trash ({selected.size})
            </button>
            <button onClick={() => { onAction('markRead', selectedIds); setSelected(new Set()); }}
              className="px-3 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              Mark Read ({selected.size})
            </button>
          </>
        )}
        <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>
          {messages.length} unread messages
        </span>
      </div>

      {/* Message List */}
      {loading ? (
        <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
          <p className="text-lg mb-2">Loading inbox...</p>
          <p className="text-sm">Fetching your latest emails from Gmail</p>
        </div>
      ) : messages.length === 0 ? (
        <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
          <p className="text-lg mb-2">Inbox Zero!</p>
          <p className="text-sm">No unread messages. Nice work.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className="flex items-start gap-3 p-4 rounded-xl border transition-all hover:shadow-sm"
              style={{
                background: selected.has(msg.id) ? '#eff6ff' : 'var(--card)',
                borderColor: selected.has(msg.id) ? 'var(--accent)' : 'var(--border)',
                opacity: actionLoading === msg.id ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(msg.id)}
                onChange={() => toggleSelect(msg.id)}
                className="mt-1 rounded"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">{msg.sender}</span>
                  <span className="text-xs whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                    {new Date(msg.date).toLocaleDateString()}
                  </span>
                </div>
                <div className="text-sm font-medium truncate">{msg.subject}</div>
                <div className="text-xs truncate mt-0.5" style={{ color: 'var(--muted)' }}>
                  {msg.snippet}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button onClick={() => onAction('archive', [msg.id])}
                  className="px-2 py-1 text-xs rounded border" style={{ borderColor: 'var(--border)' }}
                  title="Archive">
                  Archive
                </button>
                <button onClick={() => onAction('star', [msg.id])}
                  className="px-2 py-1 text-xs rounded border" style={{ borderColor: 'var(--border)' }}
                  title="Star">
                  Star
                </button>
                <button onClick={() => onAction('trash', [msg.id])}
                  className="px-2 py-1 text-xs rounded border text-red-500" style={{ borderColor: 'var(--border)' }}
                  title="Trash">
                  Trash
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ REPLY QUEUE TAB (placeholder — will be populated by triage) ============

function ReplyQueueTab() {
  return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">Reply Queue</p>
      <p className="text-sm">Run inbox triage to populate your prioritized reply queue.</p>
      <p className="text-sm mt-1">Coming soon: auto-triage with AI prioritization.</p>
    </div>
  );
}

// ============ CLEANUP TAB ============

function CleanupTab({
  messages,
  onAction,
}: {
  messages: GmailMessage[];
  onAction: (action: string, ids: string[], label?: string) => void;
}) {
  // Simple categorization based on common patterns
  const newsletters = messages.filter(
    (m) => m.labelIds.includes('CATEGORY_PROMOTIONS') || /unsubscribe|newsletter/i.test(m.snippet)
  );
  const social = messages.filter((m) => m.labelIds.includes('CATEGORY_SOCIAL'));
  const updates = messages.filter((m) => m.labelIds.includes('CATEGORY_UPDATES'));

  const categories = [
    { label: 'Promotions & Newsletters', items: newsletters, color: 'var(--important)' },
    { label: 'Social Notifications', items: social, color: 'var(--accent)' },
    { label: 'Updates & Automated', items: updates, color: 'var(--muted)' },
  ].filter((c) => c.items.length > 0);

  if (categories.length === 0) {
    return (
      <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
        <p className="text-lg mb-2">Inbox looks clean</p>
        <p className="text-sm">No promotions, social, or update emails found in your current unread messages.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {categories.map((cat) => (
        <div key={cat.label} className="rounded-xl border p-4" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-sm" style={{ color: cat.color }}>{cat.label}</h3>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{cat.items.length} messages</p>
            </div>
            <button
              onClick={() => onAction('archive', cat.items.map((m) => m.id))}
              className="px-4 py-2 text-xs font-medium rounded-lg text-white"
              style={{ background: cat.color }}
            >
              Archive All
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {cat.items.slice(0, 5).map((msg) => (
              <div key={msg.id} className="flex items-center justify-between py-1 text-xs">
                <span className="truncate flex-1">{msg.sender}: {msg.subject}</span>
                <button onClick={() => onAction('archive', [msg.id])}
                  className="ml-2 text-xs px-2 py-0.5 rounded border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                  Archive
                </button>
              </div>
            ))}
            {cat.items.length > 5 && (
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                + {cat.items.length - 5} more
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============ PRIORITIES TAB ============

function PrioritiesTab() {
  return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">Sender Priorities & Notification Rules</p>
      <p className="text-sm">Your sender ranking and notification priority scores will appear here after the first triage run.</p>
      <p className="text-sm mt-1">This data persists in your database across sessions.</p>
    </div>
  );
}

// ============ ACCOUNTS TAB ============

function AccountsTab({ currentAccount }: { currentAccount: string }) {
  return (
    <div className="flex flex-col gap-4">
      {/* Current Account */}
      <div className="rounded-xl border p-6" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <h3 className="font-semibold mb-2">Current Account</h3>
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg" style={{ background: 'var(--normal-bg)' }}>
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--normal)' }} />
          <span className="font-medium">{currentAccount || 'Not connected'}</span>
        </div>
      </div>

      {/* Add Another Account */}
      <div className="rounded-xl border-2 border-dashed p-6" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
        <h3 className="font-semibold mb-2">Connect Another Gmail Account</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
          Add another inbox to scan its sender history or triage it alongside your primary account.
        </p>
        <a
          href="/api/emailHelperV2/auth/login?state=add_account"
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-white text-sm"
          style={{ background: 'var(--accent)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Connect Gmail Account
        </a>
      </div>

      {/* Sign Out */}
      <div className="text-center mt-4">
        <a href="/" className="text-sm underline" style={{ color: 'var(--muted)' }}>Sign out</a>
      </div>
    </div>
  );
}
