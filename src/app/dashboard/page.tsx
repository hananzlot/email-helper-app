'use client';

import { useState, useEffect, useCallback } from 'react';
import type { GmailMessage } from '@/types';

// ============ API HELPERS ============
// All helpers append ?account= so the server always knows which Gmail account to use.

let _currentAccount = '';

function setCurrentAccount(acct: string) {
  _currentAccount = acct;
}

function withAccount(url: string): string {
  if (!_currentAccount) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}account=${encodeURIComponent(_currentAccount)}`;
}

async function gmailGet(action: string, params: Record<string, string> = {}) {
  const searchParams = new URLSearchParams({ action, ...params });
  const res = await fetch(withAccount(`/api/emailHelperV2/gmail?${searchParams}`));
  return res.json();
}

async function gmailPost(action: string, data: Record<string, unknown> = {}) {
  const res = await fetch(withAccount('/api/emailHelperV2/gmail'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...data }),
  });
  return res.json();
}

async function apiGet(path: string) {
  const res = await fetch(withAccount(`/api/emailHelperV2/${path}`));
  return res.json();
}

async function apiPost(path: string, data: Record<string, unknown> = {}) {
  const res = await fetch(withAccount(`/api/emailHelperV2/${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function apiPut(path: string, data: Record<string, unknown> = {}) {
  const res = await fetch(withAccount(`/api/emailHelperV2/${path}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

// ============ MAIN DASHBOARD ============

type Tab = 'inbox' | 'reply-queue' | 'cleanup' | 'priorities' | 'accounts';

interface ConnectedAccount {
  email: string;
  is_primary: boolean;
  is_active_inbox: boolean;
  display_name: string | null;
  created_at: string;
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('inbox');
  const [account, setAccount] = useState<string>('');
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [profile, setProfile] = useState<{ emailAddress: string } | null>(null);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ title: string; subtitle?: string } | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageVersion, setTriageVersion] = useState(0);
  const [userId, setUserId] = useState<string>('');

  // Load account from URL params first, then cookies
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlAccount = params.get('account');
    if (urlAccount) {
      setAccount(urlAccount);
      setCurrentAccount(urlAccount);
      document.cookie = `email_helper_account=${urlAccount};path=/;max-age=${60*60*24*30};samesite=lax`;
      window.history.replaceState({}, '', '/dashboard');
    } else {
      const added = params.get('account_added');
      if (added) {
        showToast('Account connected', added);
        window.history.replaceState({}, '', '/dashboard');
      }
      const cookies = document.cookie.split(';').reduce((acc, c) => {
        const [k, v] = c.trim().split('=');
        if (k && v) acc[k] = decodeURIComponent(v);
        return acc;
      }, {} as Record<string, string>);
      if (cookies.email_helper_account) {
        setAccount(cookies.email_helper_account);
        setCurrentAccount(cookies.email_helper_account);
      }
    }
    // Load connected accounts list
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const res = await apiGet('accounts');
      if (res.success && res.data) {
        setAccounts(res.data);
      }
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  }

  function switchAccount(newAccount: string) {
    setAccount(newAccount);
    setCurrentAccount(newAccount);
    document.cookie = `email_helper_account=${newAccount};path=/;max-age=${60*60*24*30};samesite=lax`;
    setMessages([]);
    setProfile(null);
    showToast('Switched account', newAccount);
    // loadInbox will fire from the account useEffect
  }

  useEffect(() => {
    if (!account) return;
    loadInbox();
  }, [account]);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, inboxRes] = await Promise.all([
        gmailGet('profile'),
        gmailGet('inbox', { q: 'in:inbox', max: '50' }),
      ]);
      // If not authenticated, redirect to login
      if (!profileRes.success && (profileRes.error?.includes('Not authenticated') || profileRes.error?.includes('auth failed'))) {
        window.location.href = '/api/emailHelperV2/auth/login';
        return;
      }
      if (profileRes.success) setProfile(profileRes.data);
      if (inboxRes.success && inboxRes.data?.messages) {
        setMessages(inboxRes.data.messages);
      } else {
        console.error('Inbox load failed:', inboxRes);
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to load inbox:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  function showToast(title: string, subtitle?: string) {
    setToast({ title, subtitle });
    setTimeout(() => setToast(null), 3500);
  }

  async function handleAction(action: string, messageIds: string[], label?: string) {
    setActionLoading(messageIds[0]);
    try {
      const params: Record<string, unknown> = { action, messageIds };
      if (label) params.labelId = label;
      const res = await gmailPost(action, params);
      if (res.success) {
        showToast(`${action} completed`, `${messageIds.length} message(s)`);
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

  async function runTriage() {
    setTriageLoading(true);
    showToast('Triaging inbox...', 'Scoring emails by sender priority and notification rules');
    try {
      const res = await apiPost('triage', { action: 'triage' });
      if (res.success) {
        const data = res.data;
        const total = data.total_unread;
        const reply = data.categories.reply_needed.length;
        const important = data.categories.important_notifications.length;
        showToast(`Triage complete`, `${total} emails: ${reply} need replies, ${important} important`);
        setTriageVersion(v => v + 1);
        setActiveTab('reply-queue');
      } else {
        showToast('Triage failed', res.error);
      }
    } catch (err) {
      showToast('Triage failed', String(err));
    } finally {
      setTriageLoading(false);
    }
  }

  async function scanSentMail() {
    setTriageLoading(true);
    showToast('Scanning sent mail...', 'Learning who you reply to most');
    try {
      const res = await apiPost('triage', { action: 'scan_sent' });
      if (res.success) {
        showToast('Scan complete', `Found ${res.data.sendersFound} senders, ${res.data.totalReplies} replies`);
        setActiveTab('priorities');
      } else {
        showToast('Scan failed', res.error);
      }
    } catch (err) {
      showToast('Scan failed', String(err));
    } finally {
      setTriageLoading(false);
    }
  }

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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Email Helper</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Inbox Command Center</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Account Switcher */}
          {accounts.length > 1 ? (
            <select
              value={account}
              onChange={(e) => switchAccount(e.target.value)}
              className="text-sm px-3 py-2 rounded-lg border font-medium appearance-none cursor-pointer"
              style={{ background: 'var(--normal-bg)', borderColor: 'var(--border)', color: '#065f46' }}
            >
              {accounts.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.email}{a.is_primary ? ' ★' : ''}
                </option>
              ))}
            </select>
          ) : profile ? (
            <div className="text-sm px-4 py-2 rounded-lg" style={{ background: 'var(--normal-bg)', color: '#065f46' }}>
              <strong>{profile.emailAddress}</strong>
            </div>
          ) : null}
          <button
            onClick={runTriage}
            disabled={triageLoading}
            className="px-4 py-2 text-sm font-semibold rounded-lg text-white"
            style={{ background: triageLoading ? 'var(--muted)' : 'var(--urgent)' }}
          >
            {triageLoading ? 'Working...' : 'Triage Inbox'}
          </button>
        </div>
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

      {activeTab === 'inbox' && (
        <InboxTab messages={messages} loading={loading} actionLoading={actionLoading}
          onAction={handleAction} onRefresh={loadInbox} showToast={showToast} />
      )}
      {activeTab === 'reply-queue' && <ReplyQueueTab onAction={handleAction} showToast={showToast} reloadKey={triageVersion} />}
      {activeTab === 'cleanup' && <CleanupTab messages={messages} onAction={handleAction} />}
      {activeTab === 'priorities' && <PrioritiesTab onScanSent={scanSentMail} scanning={triageLoading} showToast={showToast} />}
      {activeTab === 'accounts' && <AccountsTab currentAccount={account} accounts={accounts} onSwitch={switchAccount} onRefresh={loadAccounts} showToast={showToast} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl text-white text-sm font-medium shadow-lg z-50 text-center"
          style={{ background: '#1e293b', maxWidth: '90vw' }}>
          <div className="font-semibold">{toast.title}</div>
          {toast.subtitle && <div className="text-xs opacity-70 mt-0.5">{toast.subtitle}</div>}
        </div>
      )}
    </div>
  );
}

// ============ INBOX TAB ============

// ============ REPLY COMPOSER ============

function ReplyComposer({ to, subject, threadId, messageId, onSent, onCancel, showToast }: {
  to: string; subject: string; threadId: string; messageId: string;
  onSent: () => void; onCancel: () => void; showToast: (title: string, subtitle?: string) => void;
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  async function sendReply() {
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await gmailPost('send', {
        to,
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        body: body.replace(/\n/g, '<br>'),
        threadId,
        inReplyTo: messageId,
      });
      if (res.success) {
        showToast('Reply sent', `To: ${to}`);
        onSent();
      } else {
        showToast('Send failed', res.error);
      }
    } catch (err) {
      showToast('Send failed', String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3 p-3 rounded-lg border" style={{ background: '#f8fafc', borderColor: 'var(--accent)' }}>
      <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>Replying to <strong>{to}</strong></div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Type your reply..."
        rows={4}
        className="w-full p-3 rounded-lg border text-sm resize-y"
        style={{ borderColor: 'var(--border)' }}
        autoFocus
      />
      <div className="flex gap-2 mt-2">
        <button onClick={sendReply} disabled={sending || !body.trim()}
          className="px-4 py-2 text-xs font-semibold rounded-lg text-white"
          style={{ background: sending ? 'var(--muted)' : 'var(--accent)' }}>
          {sending ? 'Sending...' : 'Send Reply'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Cancel</button>
      </div>
    </div>
  );
}

// ============ INBOX TAB ============

function InboxTab({ messages, loading, actionLoading, onAction, onRefresh, showToast }: {
  messages: GmailMessage[]; loading: boolean; actionLoading: string | null;
  onAction: (action: string, ids: string[], label?: string) => void; onRefresh: () => void;
  showToast: (title: string, subtitle?: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleSelect = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelected(selected.size === messages.length ? new Set() : new Set(messages.map(m => m.id)));
  const selectedIds = Array.from(selected);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button onClick={onRefresh} disabled={loading} className="px-4 py-2 text-sm font-medium rounded-lg text-white" style={{ background: 'var(--accent)' }}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
        {messages.length > 0 && <button onClick={selectAll} className="px-3 py-2 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>{selected.size === messages.length ? 'Deselect All' : 'Select All'}</button>}
        {selected.size > 0 && (<>
          <button onClick={() => { onAction('archive', selectedIds); setSelected(new Set()); }} className="px-3 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)' }}>Archive ({selected.size})</button>
          <button onClick={() => { onAction('markRead', selectedIds); setSelected(new Set()); }} className="px-3 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)' }}>Mark Read ({selected.size})</button>
          <button onClick={() => { onAction('trash', selectedIds); setSelected(new Set()); }} className="px-3 py-2 text-xs font-medium rounded-lg border text-red-600" style={{ borderColor: 'var(--border)' }}>Trash ({selected.size})</button>
          <button onClick={() => { if (confirm('Permanently delete selected messages?')) { onAction('delete', selectedIds); setSelected(new Set()); }}} className="px-3 py-2 text-xs font-medium rounded-lg border text-red-700 font-bold" style={{ borderColor: '#fca5a5' }}>Delete ({selected.size})</button>
        </>)}
        <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>{messages.length} messages</span>
      </div>
      {loading ? (
        <div className="text-center py-16" style={{ color: 'var(--muted)' }}><p className="text-lg mb-2">Loading inbox...</p></div>
      ) : messages.length === 0 ? (
        <div className="text-center py-16" style={{ color: 'var(--muted)' }}><p className="text-lg mb-2">Inbox Zero!</p><p className="text-sm">No messages.</p></div>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((msg) => (
            <div key={msg.id} className="rounded-xl border transition-all hover:shadow-sm"
              style={{ background: selected.has(msg.id) ? '#eff6ff' : 'var(--card)', borderColor: selected.has(msg.id) ? 'var(--accent)' : 'var(--border)', opacity: actionLoading === msg.id ? 0.5 : 1 }}>
              <div className="flex items-start gap-3 p-4">
                <input type="checkbox" checked={selected.has(msg.id)} onChange={() => toggleSelect(msg.id)} className="mt-1 rounded" />
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedId(expandedId === msg.id ? null : msg.id)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate">{msg.sender}</span>
                    <div className="flex items-center gap-2">
                      {msg.isUnread && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} />}
                      <span className="text-xs whitespace-nowrap" style={{ color: 'var(--muted)' }}>{new Date(msg.date).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="text-sm font-medium truncate">{msg.subject}</div>
                  <div className="text-xs truncate mt-0.5" style={{ color: 'var(--muted)' }}>{msg.snippet}</div>
                </div>
              </div>
              {/* Action bar */}
              <div className="flex gap-1 px-4 pb-3 flex-wrap">
                <button onClick={() => { setReplyingTo(replyingTo === msg.id ? null : msg.id); setExpandedId(msg.id); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>Reply</button>
                <button onClick={() => onAction('archive', [msg.id])} className="px-2 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Archive</button>
                <button onClick={() => onAction(msg.isUnread ? 'markRead' : 'markUnread', [msg.id])}
                  className="px-2 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                  {msg.isUnread ? 'Mark Read' : 'Mark Unread'}
                </button>
                <button onClick={() => onAction('star', [msg.id])} className="px-2 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Star</button>
                <button onClick={() => onAction('trash', [msg.id])} className="px-2 py-1.5 text-xs rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                <button onClick={() => { if (confirm('Permanently delete?')) onAction('delete', [msg.id]); }}
                  className="px-2 py-1.5 text-xs rounded-lg border text-red-700" style={{ borderColor: '#fca5a5' }}>Delete</button>
              </div>
              {/* Inline Reply Composer */}
              {replyingTo === msg.id && (
                <div className="px-4 pb-4">
                  <ReplyComposer
                    to={msg.senderEmail}
                    subject={msg.subject}
                    threadId={msg.threadId}
                    messageId={msg.id}
                    showToast={showToast}
                    onSent={() => { setReplyingTo(null); onRefresh(); }}
                    onCancel={() => setReplyingTo(null)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ REPLY QUEUE TAB ============

function ReplyQueueTab({ onAction, showToast, reloadKey }: {
  onAction: (action: string, ids: string[], label?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  reloadKey: number;
}) {
  const [queue, setQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  useEffect(() => { loadQueue(); }, [reloadKey]);

  async function loadQueue() {
    setLoading(true);
    const res = await apiGet('queue');
    if (res.success) setQueue(res.data);
    setLoading(false);
  }

  async function updateStatus(id: string, status: string) {
    const res = await apiPut('queue', { id, status });
    if (res.success) {
      setQueue(prev => prev.map(q => q.id === id ? { ...q, status } : q));
      showToast(`Marked ${status}`);
    }
  }

  const active = queue.filter(q => q.status === 'active');
  const done = queue.filter(q => q.status === 'done');
  const snoozed = queue.filter(q => q.status === 'snoozed');

  const priorityColors: Record<string, { border: string; bg: string; label: string }> = {
    urgent: { border: 'var(--urgent)', bg: 'var(--urgent-bg)', label: 'Reply Now' },
    important: { border: 'var(--important)', bg: 'var(--important-bg)', label: 'Reply Today' },
    normal: { border: 'var(--normal)', bg: 'var(--normal-bg)', label: 'When Free' },
    low: { border: 'var(--low)', bg: 'var(--low-bg)', label: 'Low Priority' },
  };

  if (loading) return <div className="text-center py-16" style={{ color: 'var(--muted)' }}>Loading reply queue...</div>;

  if (queue.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No emails in queue</p>
      <p className="text-sm">Click <strong>Triage Inbox</strong> above to scan and prioritize your unread emails.</p>
    </div>
  );

  const total = queue.length;
  const doneCount = done.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div>
      {/* Progress */}
      <div className="mb-4">
        <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{doneCount} of {total} replies completed</p>
      </div>

      {/* Active items grouped by priority */}
      {['urgent', 'important', 'normal', 'low'].map(priority => {
        const items = active.filter(q => q.priority === priority);
        if (items.length === 0) return null;
        const pc = priorityColors[priority];
        return (
          <div key={priority}>
            <p className="text-xs font-semibold uppercase tracking-wide mt-4 mb-2 pb-2 border-b pl-3"
              style={{ color: pc.border, borderLeftWidth: 3, borderLeftColor: pc.border, borderBottomColor: 'var(--border)' }}>
              {pc.label} ({items.length})
            </p>
            {items.map(q => (
              <div key={q.id} className="p-4 rounded-xl border mb-2" style={{ background: pc.bg, borderColor: 'var(--border)', borderLeftWidth: 4, borderLeftColor: pc.border }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{q.sender}</span>
                      {q.tier && q.tier !== 'N/A' && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: q.tier === 'A' ? '#fee2e2' : q.tier === 'B' ? '#fef3c7' : '#e0f2fe', color: q.tier === 'A' ? '#991b1b' : q.tier === 'B' ? '#92400e' : '#075985' }}>Tier {q.tier}</span>}
                    </div>
                    <div className="text-sm font-medium mt-0.5">{q.subject}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{q.summary}</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{q.account_email} &middot; Score: {q.priority_score}/10</div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3 flex-wrap">
                  <button onClick={() => setReplyingTo(replyingTo === q.id ? null : q.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>Reply</button>
                  <button onClick={() => updateStatus(q.id, 'done')} className="px-3 py-1.5 text-xs font-medium rounded-lg" style={{ background: '#dcfce7', color: '#166534' }}>Done</button>
                  <button onClick={() => updateStatus(q.id, 'snoozed')} className="px-3 py-1.5 text-xs font-medium rounded-lg" style={{ background: '#fef9c3', color: '#854d0e' }}>Snooze</button>
                  <button onClick={() => updateStatus(q.id, 'later')} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Later</button>
                  <button onClick={() => onAction('archive', [q.message_id])} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                  <button onClick={() => onAction('markRead', [q.message_id])} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Mark Read</button>
                  <button onClick={() => onAction('trash', [q.message_id])} className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                  <button onClick={() => { if (confirm('Permanently delete?')) onAction('delete', [q.message_id]); }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-700" style={{ borderColor: '#fca5a5' }}>Delete</button>
                </div>
                {replyingTo === q.id && (
                  <div className="mt-3">
                    <ReplyComposer
                      to={q.sender_email}
                      subject={q.subject}
                      threadId={q.thread_id}
                      messageId={q.message_id}
                      showToast={showToast}
                      onSent={() => { setReplyingTo(null); updateStatus(q.id, 'done'); }}
                      onCancel={() => setReplyingTo(null)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {/* Completed */}
      {done.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide mb-2 pb-2 border-b" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>Completed ({done.length})</p>
          {done.map(q => (
            <div key={q.id} className="p-3 rounded-lg border mb-1 flex items-center justify-between" style={{ opacity: 0.5, borderColor: 'var(--border)' }}>
              <span className="text-sm">{q.sender}: {q.subject}</span>
              <button onClick={() => updateStatus(q.id, 'active')} className="text-xs px-2 py-1 rounded border" style={{ borderColor: 'var(--border)' }}>Reactivate</button>
            </div>
          ))}
        </div>
      )}

      {snoozed.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide mb-2 pb-2 border-b" style={{ color: 'var(--important)', borderColor: 'var(--border)' }}>Snoozed ({snoozed.length})</p>
          {snoozed.map(q => (
            <div key={q.id} className="p-3 rounded-lg border mb-1 flex items-center justify-between" style={{ opacity: 0.6, borderColor: 'var(--border)' }}>
              <span className="text-sm">{q.sender}: {q.subject}</span>
              <button onClick={() => updateStatus(q.id, 'active')} className="text-xs px-2 py-1 rounded border" style={{ borderColor: 'var(--border)' }}>Reactivate</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ CLEANUP TAB ============

function CleanupTab({ messages, onAction }: { messages: GmailMessage[]; onAction: (action: string, ids: string[], label?: string) => void; }) {
  const newsletters = messages.filter(m => m.labelIds.includes('CATEGORY_PROMOTIONS') || /unsubscribe|newsletter/i.test(m.snippet));
  const social = messages.filter(m => m.labelIds.includes('CATEGORY_SOCIAL'));
  const updates = messages.filter(m => m.labelIds.includes('CATEGORY_UPDATES'));

  const categories = [
    { label: 'Promotions & Newsletters', items: newsletters, color: 'var(--important)' },
    { label: 'Social Notifications', items: social, color: 'var(--accent)' },
    { label: 'Updates & Automated', items: updates, color: 'var(--muted)' },
  ].filter(c => c.items.length > 0);

  if (categories.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">Inbox looks clean</p>
      <p className="text-sm">No promotions, social, or update emails found.</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {categories.map(cat => (
        <div key={cat.label} className="rounded-xl border p-4" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between mb-3">
            <div><h3 className="font-semibold text-sm" style={{ color: cat.color }}>{cat.label}</h3><p className="text-xs" style={{ color: 'var(--muted)' }}>{cat.items.length} messages</p></div>
            <button onClick={() => onAction('archive', cat.items.map(m => m.id))} className="px-4 py-2 text-xs font-medium rounded-lg text-white" style={{ background: cat.color }}>Archive All</button>
          </div>
          <div className="flex flex-col gap-1">
            {cat.items.slice(0, 5).map(msg => (
              <div key={msg.id} className="flex items-center justify-between py-1 text-xs">
                <span className="truncate flex-1">{msg.sender}: {msg.subject}</span>
                <button onClick={() => onAction('archive', [msg.id])} className="ml-2 px-2 py-0.5 rounded border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
              </div>
            ))}
            {cat.items.length > 5 && <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>+ {cat.items.length - 5} more</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============ PRIORITIES TAB ============

function PrioritiesTab({ onScanSent, scanning, showToast }: {
  onScanSent: () => void; scanning: boolean;
  showToast: (title: string, subtitle?: string) => void;
}) {
  const [senders, setSenders] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [s, r] = await Promise.all([apiGet('senders'), apiGet('rules')]);
    if (s.success) setSenders(s.data);
    if (r.success) setRules(r.data);
    setLoading(false);
  }

  async function adjustRule(id: string, delta: number) {
    const rule = rules.find((r: any) => r.id === id);
    if (!rule) return;
    const current = rule.user_priority ?? rule.default_priority;
    const newVal = Math.max(0, Math.min(10, current + delta));
    const res = await apiPut('rules', { id, user_priority: newVal });
    if (res.success) {
      setRules(prev => prev.map((r: any) => r.id === id ? { ...r, user_priority: newVal } : r));
      showToast(`${rule.description}: ${newVal}/10`);
    }
  }

  if (loading) return <div className="text-center py-16" style={{ color: 'var(--muted)' }}>Loading priorities...</div>;

  const tierColors: Record<string, string> = { A: '#fee2e2', B: '#fef3c7', C: '#e0f2fe', D: '#f1f5f9' };
  const tierText: Record<string, string> = { A: '#991b1b', B: '#92400e', C: '#075985', D: '#475569' };

  return (
    <div className="flex flex-col gap-6">
      {/* Sender Priority Table */}
      <div className="rounded-xl border p-5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold">Sender Priorities</h3>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{senders.length} senders ranked by reply frequency</p>
          </div>
          <button onClick={onScanSent} disabled={scanning} className="px-4 py-2 text-xs font-medium rounded-lg text-white" style={{ background: scanning ? 'var(--muted)' : 'var(--accent)' }}>
            {scanning ? 'Scanning...' : 'Scan Sent Mail'}
          </button>
        </div>
        {senders.length === 0 ? (
          <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>No sender data yet. Click "Scan Sent Mail" to learn who you reply to most.</p>
        ) : (
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table className="w-full text-sm">
              <thead><tr className="text-xs uppercase" style={{ color: 'var(--muted)' }}><th className="text-left p-2">Sender</th><th className="p-2 text-center">Replies</th><th className="p-2">Tier</th></tr></thead>
              <tbody>
                {senders.slice(0, 100).map((s: any) => (
                  <tr key={s.sender_email} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="p-2"><div className="font-medium text-sm">{s.display_name}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{s.sender_email}</div></td>
                    <td className="p-2 text-center font-semibold">{s.reply_count}</td>
                    <td className="p-2"><span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: tierColors[s.tier] || '#f1f5f9', color: tierText[s.tier] || '#475569' }}>Tier {s.tier}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Notification Rules */}
      <div className="rounded-xl border p-5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <h3 className="font-semibold mb-1">Notification Rules</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>Priority scores for automated emails (0-10). Adjust with +/- buttons.</p>
        <div className="flex flex-col gap-2">
          {rules.map((r: any) => {
            const score = r.user_priority ?? r.default_priority;
            const scoreColor = score >= 7 ? 'var(--urgent)' : score >= 4 ? 'var(--important)' : 'var(--low)';
            return (
              <div key={r.id} className="flex items-center justify-between p-3 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                <div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>{r.category}{r.user_priority !== null ? ' (custom)' : ''}</div>
                  <div className="text-sm font-medium">{r.description}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => adjustRule(r.id, -1)} className="w-7 h-7 rounded-full border flex items-center justify-center text-sm" style={{ borderColor: 'var(--border)' }}>&minus;</button>
                  <span className="text-xl font-bold w-8 text-center" style={{ color: scoreColor }}>{score}</span>
                  <button onClick={() => adjustRule(r.id, 1)} className="w-7 h-7 rounded-full border flex items-center justify-center text-sm" style={{ borderColor: 'var(--border)' }}>+</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============ ACCOUNTS TAB ============

function AccountsTab({ currentAccount, accounts, onSwitch, onRefresh, showToast }: {
  currentAccount: string;
  accounts: ConnectedAccount[];
  onSwitch: (email: string) => void;
  onRefresh: () => void;
  showToast: (title: string, subtitle?: string) => void;
}) {
  async function setPrimary(email: string) {
    const res = await apiPut('accounts', { email, action: 'set_primary' });
    if (res.success) {
      showToast('Primary account set', email);
      onRefresh();
    } else {
      showToast('Error', res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Connected Accounts */}
      <div className="rounded-xl border p-6" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <h3 className="font-semibold mb-4">Connected Accounts</h3>
        {accounts.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No accounts connected yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {accounts.map((a) => (
              <div key={a.email} className="flex items-center justify-between px-4 py-3 rounded-lg border"
                style={{
                  background: a.email === currentAccount ? 'var(--normal-bg)' : 'var(--bg)',
                  borderColor: a.email === currentAccount ? 'var(--normal)' : 'var(--border)',
                }}>
                <div className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: a.email === currentAccount ? 'var(--normal)' : 'var(--border)' }} />
                  <div>
                    <span className="font-medium">{a.email}</span>
                    <div className="flex gap-2 mt-0.5">
                      {a.is_primary && <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent)', color: 'white' }}>Primary</span>}
                      {a.email === currentAccount && <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--normal-bg)', color: '#065f46' }}>Active</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {a.email !== currentAccount && (
                    <button onClick={() => onSwitch(a.email)}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium border"
                      style={{ borderColor: 'var(--border)' }}>
                      Switch
                    </button>
                  )}
                  {!a.is_primary && (
                    <button onClick={() => setPrimary(a.email)}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium text-white"
                      style={{ background: 'var(--accent)' }}>
                      Set Primary
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Connect Another */}
      <div className="rounded-xl border-2 border-dashed p-6" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
        <h3 className="font-semibold mb-2">Connect Another Gmail Account</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>Add another inbox to triage alongside your primary account.</p>
        <a href="/api/emailHelperV2/auth/login?state=add_account"
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-white text-sm"
          style={{ background: 'var(--accent)' }}>
          + Connect Gmail Account
        </a>
      </div>

      <div className="text-center mt-4">
        <a href="/" className="text-sm underline" style={{ color: 'var(--muted)' }}>Sign out</a>
      </div>
    </div>
  );
}
