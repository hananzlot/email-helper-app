'use client';

import React, { useState, useEffect, useCallback } from 'react';
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

async function apiDelete(path: string, data: Record<string, unknown> = {}) {
  const res = await fetch(withAccount(`/api/emailHelperV2/${path}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

// ============ CONFIRM MODAL ============

function ConfirmModal({ title, message, confirmLabel, confirmColor, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; confirmColor: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl p-6 max-w-sm mx-4 w-full">
        <h3 className="text-lg font-bold mb-2">{title}</h3>
        <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="px-5 py-2.5 text-sm font-medium rounded-xl border" style={{ borderColor: 'var(--border)' }}>
            Cancel
          </button>
          <button onClick={onConfirm} className="px-5 py-2.5 text-sm font-semibold rounded-xl text-white" style={{ background: confirmColor }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ EMAIL PREVIEW MODAL ============

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&apos;': "'", '&#x2F;': '/', '&nbsp;': ' ' };
  return text.replace(/&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match) => entities[match] || match);
}

function EmailPreviewModal({ messageId, accountEmail, onClose, onAction, showToast, onSnooze }: {
  messageId: string;
  accountEmail?: string;
  onClose: () => void;
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  onSnooze?: (messageId: string, hours: number, label: string, accountEmail?: string) => void;
}) {
  const [email, setEmail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [clickedBtn, setClickedBtn] = useState<string | null>(null);

  function flashAction(name: string, fn: () => void) {
    setClickedBtn(name);
    fn();
    setTimeout(() => setClickedBtn(null), 600);
  }
  const iframeRef = useCallback((node: HTMLIFrameElement | null) => {
    if (node && (email?.bodyHtml || email?.body)) {
      const doc = node.contentDocument;
      if (doc) {
        // Detect if the content is actual HTML or plain text that was used as fallback
        const content = email.bodyHtml || email.body || '';
        const isHtml = /<[a-z][\s\S]*>/i.test(content);
        const displayContent = isHtml ? content : content.replace(/\n/g, '<br>');
        doc.open();
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; margin: 0; padding: 16px; word-wrap: break-word; overflow-wrap: break-word; }
          img { max-width: 100%; height: auto; }
          a { color: #2563eb; }
          table { max-width: 100%; }
          pre, code { white-space: pre-wrap; word-wrap: break-word; }
          blockquote { border-left: 3px solid #d1d5db; margin: 8px 0; padding-left: 12px; color: #6b7280; }
        </style></head><body>${displayContent}</body></html>`);
        doc.close();
        const resize = () => {
          if (node.contentDocument?.body) {
            node.style.height = Math.min(window.innerHeight * 0.55, Math.max(150, node.contentDocument.body.scrollHeight + 32)) + 'px';
          }
        };
        setTimeout(resize, 100);
        setTimeout(resize, 500);
        node.contentWindow?.addEventListener('load', resize);
      }
    }
  }, [email?.bodyHtml, email?.body]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      // Temporarily switch to the correct account if needed
      const savedAccount = _currentAccount;
      if (accountEmail && accountEmail !== _currentAccount) {
        setCurrentAccount(accountEmail);
      }
      try {
        const res = await gmailGet('message', { id: messageId, format: 'full' });
        if (res.success) setEmail(res.data);
        else setError(res.error || 'Failed to load email');
      } catch (e) { setError(String(e)); }
      finally {
        // Restore original account
        if (accountEmail && accountEmail !== savedAccount) {
          setCurrentAccount(savedAccount);
        }
        setLoading(false);
      }
    })();
  }, [messageId, accountEmail]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const attachmentIcon = (mime: string) => {
    if (mime.startsWith('image/')) return '🖼';
    if (mime.includes('pdf')) return '📄';
    if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
    if (mime.includes('document') || mime.includes('word')) return '📝';
    if (mime.includes('zip') || mime.includes('compressed')) return '📦';
    return '📎';
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal header — subject + date/time */}
        <div className="flex items-start justify-between gap-3 p-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-bold truncate">{email?.subject || 'Loading...'}</h3>
              {email?.date && (() => {
                const d = new Date(email.date);
                const formatted = isNaN(d.getTime()) ? email.date : d.toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
                return <span className="text-xs flex-shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full" style={{ background: '#f1f5f9', color: '#475569' }}>{formatted}</span>;
              })()}
            </div>
          </div>
          <button onClick={onClose} className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-lg hover:bg-gray-100" style={{ color: 'var(--muted)' }}>&times;</button>
        </div>

        {/* Modal body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-center py-16" style={{ color: 'var(--muted)' }}>Loading email...</div>
          ) : error ? (
            <div className="text-center py-8 text-red-600">{error}</div>
          ) : email ? (
            <>
              {/* Header details */}
              <div className="px-5 pt-4 pb-3 flex flex-col gap-1.5" style={{ background: '#f8fafc' }}>
                <div className="flex items-center gap-2">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0" style={{ background: 'var(--accent)' }}>
                    {(email.sender || '?')[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-sm">{email.sender}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>&lt;{email.senderEmail}&gt;</div>
                  </div>
                </div>
                {email.to && <div className="text-xs pl-12" style={{ color: 'var(--muted)' }}><span className="font-semibold">To:</span> {email.to}</div>}
                {email.cc && <div className="text-xs pl-12" style={{ color: 'var(--muted)' }}><span className="font-semibold">Cc:</span> {email.cc}</div>}
              </div>

              {/* Attachments */}
              {email.attachments && email.attachments.length > 0 && (
                <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border)', background: '#fffbeb' }}>
                  <div className="text-xs font-semibold mb-2" style={{ color: '#92400e' }}>
                    {email.attachments.length} Attachment{email.attachments.length > 1 ? 's' : ''}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {email.attachments.map((att: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs" style={{ background: 'white', borderColor: '#fbbf24' }}>
                        <span className="text-base">{attachmentIcon(att.mimeType)}</span>
                        <div>
                          <div className="font-medium truncate" style={{ maxWidth: 180 }}>{att.filename}</div>
                          <div style={{ color: 'var(--muted)' }}>{formatSize(att.size)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Email body */}
              <div className="p-5">
                {(email.bodyHtml || email.body) ? (
                  <iframe
                    ref={iframeRef}
                    sandbox="allow-same-origin"
                    className="w-full border rounded-lg"
                    style={{ borderColor: 'var(--border)', background: 'white', minHeight: 150 }}
                    title="Email content"
                  />
                ) : (
                  <div className="text-sm text-center py-8" style={{ color: 'var(--muted)' }}>No body content</div>
                )}
              </div>
              {/* Inline Reply Composer */}
              {replyOpen && (
                <div className="px-5 pb-4">
                  <ReplyComposer
                    to={email.senderEmail}
                    subject={email.subject}
                    threadId={email.threadId}
                    messageId={email.id}
                    showToast={showToast}
                    onSent={() => { setReplyOpen(false); showToast('Reply sent', `To: ${email.senderEmail}`); }}
                    onCancel={() => setReplyOpen(false)}
                  />
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Sticky action bar */}
        {email && !loading && (
          <div className="border-t p-3 flex gap-2 flex-wrap items-center" style={{ borderColor: 'var(--border)', background: '#f8fafc' }}>
            <button onClick={() => setReplyOpen(!replyOpen)}
              className="px-4 py-2 text-xs font-semibold rounded-lg text-white transition-transform active:scale-90" style={{ background: 'var(--accent)' }}>
              {replyOpen ? 'Cancel Reply' : 'Reply'}
            </button>
            <button onClick={() => flashAction('archive', () => { onAction('archive', [messageId], undefined, accountEmail || _currentAccount); setTimeout(onClose, 300); })}
              className="px-3 py-2 text-xs font-medium rounded-lg border transition-all active:scale-90"
              style={{ borderColor: 'var(--border)', background: clickedBtn === 'archive' ? '#dcfce7' : undefined, color: clickedBtn === 'archive' ? '#166534' : undefined }}>
              {clickedBtn === 'archive' ? 'Archived!' : 'Archive'}
            </button>
            <button onClick={() => flashAction('markRead', () => { onAction(email.isUnread ? 'markRead' : 'markUnread', [messageId], undefined, accountEmail || _currentAccount); setTimeout(onClose, 400); })}
              className="px-3 py-2 text-xs font-medium rounded-lg border transition-all active:scale-90"
              style={{ borderColor: 'var(--border)', background: clickedBtn === 'markRead' ? '#dbeafe' : undefined, color: clickedBtn === 'markRead' ? '#1e40af' : undefined }}>
              {clickedBtn === 'markRead' ? 'Marked read!' : (email.isUnread ? 'Mark Read' : 'Mark Unread')}
            </button>
            <button onClick={() => flashAction('followUp', () => {
              // Star the message so it appears in the Follow-Up tab
              onAction('star', [messageId], undefined, accountEmail || _currentAccount);
            })}
              className="px-3 py-2 text-xs font-medium rounded-lg border transition-all active:scale-90"
              style={{ borderColor: '#fbbf24', background: clickedBtn === 'followUp' ? '#fef3c7' : undefined, color: clickedBtn === 'followUp' ? '#92400e' : '#b45309' }}>
              {clickedBtn === 'followUp' ? 'Added to Follow Up!' : 'Follow Up'}
            </button>
            <button onClick={() => flashAction('star', () => { onAction('star', [messageId], undefined, accountEmail || _currentAccount); })}
              className="px-3 py-2 text-xs font-medium rounded-lg border transition-all active:scale-90"
              style={{ borderColor: 'var(--border)', background: clickedBtn === 'star' ? '#fef3c7' : undefined, color: clickedBtn === 'star' ? '#92400e' : undefined }}>
              {clickedBtn === 'star' ? 'Starred!' : 'Star'}
            </button>
            {onSnooze && (
              <SnoozeDropdown onSnooze={(hours, label) => { onSnooze(messageId, hours, label, accountEmail || _currentAccount); showToast('Snoozed', `Will reappear ${label}`); setTimeout(onClose, 300); }} />
            )}
            <button onClick={() => flashAction('trash', () => { onAction('trash', [messageId], undefined, accountEmail || _currentAccount); setTimeout(onClose, 300); })}
              className="px-3 py-2 text-xs font-medium rounded-lg border transition-all active:scale-90"
              style={{ borderColor: 'var(--border)', color: clickedBtn === 'trash' ? '#fff' : '#ef4444', background: clickedBtn === 'trash' ? '#ef4444' : undefined }}>
              {clickedBtn === 'trash' ? 'Trashed!' : 'Trash'}
            </button>
            <button onClick={() => setConfirmDelete(true)}
              className="px-3 py-2 text-xs font-medium rounded-lg border text-red-700 transition-transform active:scale-90" style={{ borderColor: '#fca5a5' }}>Delete</button>
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setConfirmDelete(false)} />
          <div className="relative z-10">
            <ConfirmModal
              title="Permanently Delete"
              message="This will permanently delete this message from Gmail. This cannot be undone."
              confirmLabel="Delete Forever"
              confirmColor="#dc2626"
              onConfirm={() => { onAction('delete', [messageId], undefined, accountEmail || _currentAccount); setConfirmDelete(false); onClose(); }}
              onCancel={() => setConfirmDelete(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ============ TIER DROPDOWN ============

function TierDropdown({ currentTier, senderEmail, senderName, onTierChanged }: {
  currentTier: string;
  senderEmail: string;
  senderName: string;
  onTierChanged: (newTier: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);

  const tiers = [
    { value: 'A', label: 'Tier A', desc: 'Top priority', bg: '#dcfce7', color: '#166534', border: '#86efac' },
    { value: 'B', label: 'Tier B', desc: 'Important', bg: '#fef3c7', color: '#92400e', border: '#fbbf24' },
    { value: 'C', label: 'Tier C', desc: 'Low priority', bg: '#e0f2fe', color: '#075985', border: '#7dd3fc' },
    { value: 'D', label: 'Tier D', desc: 'Noise', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' },
  ];

  const current = tiers.find(t => t.value === currentTier) || { value: currentTier || '?', label: currentTier ? `Tier ${currentTier}` : 'No tier', bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' };

  function toggleOpen() {
    if (open) { setOpen(false); return; }
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const menuHeight = 200; // approximate height of 4 tier options
      const spaceBelow = window.innerHeight - rect.bottom;
      // Open upward if not enough space below
      if (spaceBelow < menuHeight) {
        setMenuPos({ top: rect.top - menuHeight - 4, left: rect.left });
      } else {
        setMenuPos({ top: rect.bottom + 4, left: rect.left });
      }
    }
    setOpen(true);
  }

  async function changeTier(newTier: string) {
    setOpen(false);
    if (newTier === currentTier) return;
    try {
      const res = await apiPut('senders', { sender_email: senderEmail, tier: newTier, display_name: senderName || senderEmail });
      if (res.success) {
        onTierChanged(newTier);
      }
    } catch (e) {
      console.error('Failed to change tier:', e);
    }
  }

  return (
    <div className="relative inline-block">
      <button ref={btnRef} onClick={toggleOpen}
        className="text-[10px] font-bold px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity"
        style={{ background: current.bg, color: current.color, border: `1px solid ${current.border}` }}>
        {current.label} ▾
      </button>
      {open && menuPos && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="fixed z-[70] rounded-lg border shadow-lg py-1 min-w-[160px]"
            style={{ background: 'white', borderColor: 'var(--border)', top: menuPos.top, left: menuPos.left }}>
            {tiers.map((t) => (
              <button key={t.value} onClick={() => changeTier(t.value)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center gap-2"
                style={{ fontWeight: t.value === currentTier ? 700 : 400 }}>
                <span className="w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center flex-shrink-0"
                  style={{ background: t.bg, color: t.color }}>{t.value}</span>
                <div>
                  <div className="font-medium">{t.label}</div>
                  <div style={{ color: 'var(--muted)' }}>{t.desc}</div>
                </div>
                {t.value === currentTier && <span className="ml-auto">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============ MAIN DASHBOARD ============

type Tab = 'inbox' | 'reply-queue' | 'snoozed' | 'cleanup' | 'sent' | 'follow-up' | 'priorities' | 'accounts';

interface ConnectedAccount {
  email: string;
  is_primary: boolean;
  is_active_inbox: boolean;
  display_name: string | null;
  created_at: string;
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('reply-queue');
  const [account, setAccount] = useState<string>('');
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [profile, setProfile] = useState<{ emailAddress: string } | null>(null);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ title: string; subtitle?: string } | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [bgTaskLabel, setBgTaskLabel] = useState<string | null>(null);
  const [triageVersion, setTriageVersion] = useState(0);
  const [userId, setUserId] = useState<string>('');
  // Track which messages are animating out and their animation type
  const [animatingOut, setAnimatingOut] = useState<Record<string, 'trash' | 'delete' | 'archive'>>({});
  // Unified view — shows all accounts merged (default)
  const [unified, setUnified] = useState(true);
  // Email preview modal — shared across all tabs
  const [previewMessageId, setPreviewMessageId] = useState<string | null>(null);
  const [previewAccount, setPreviewAccount] = useState<string | undefined>(undefined);
  // Auth error state — show login prompt instead of auto-redirect loop
  const [authError, setAuthError] = useState(false);
  // Tab counts — each tab reports its count for display in tab bar
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});

  function openPreview(messageId: string, acctEmail?: string) {
    setPreviewMessageId(messageId);
    setPreviewAccount(acctEmail);
  }

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
    setUnified(false);
    setAccount(newAccount);
    setCurrentAccount(newAccount);
    document.cookie = `email_helper_account=${newAccount};path=/;max-age=${60*60*24*30};samesite=lax`;
    setMessages([]);
    setProfile(null);
    showToast('Switched account', newAccount);
  }

  function switchToUnified() {
    setUnified(true);
    setMessages([]);
    setProfile(null);
    showToast('Unified view', 'Showing all accounts');
    loadUnifiedInbox();
  }

  // Load inbox for a single account, optionally run silent triage after
  // silent=true skips the loading spinner (for background refreshes)
  const loadInbox = useCallback(async (silentTriage = false, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [profileRes, inboxRes] = await Promise.all([
        gmailGet('profile'),
        gmailGet('inbox', { q: 'in:inbox', max: '50' }),
      ]);
      if (!profileRes.success && (profileRes.error?.includes('Not authenticated') || profileRes.error?.includes('auth failed'))) {
        setAuthError(true);
        setLoading(false);
        return;
      }
      if (profileRes.success) setProfile(profileRes.data);
      if (inboxRes.success && inboxRes.data?.messages) {
        const msgs = inboxRes.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: account }));
        setMessages(msgs);
      } else {
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to load inbox:', err);
    } finally {
      setLoading(false);
    }
    // Silent triage: score new unread emails in background
    if (silentTriage) {
      try {
        const res = await apiPost('triage', { action: 'triage' });
        if (res.success && res.data.total_unread > 0) {
          setTriageVersion(v => v + 1);
        }
      } catch { /* silent */ }
    }
  }, [account]);

  // Load inbox from ALL accounts and merge, optionally run silent triage
  // silent=true skips the loading spinner (for background refreshes)
  const loadUnifiedInbox = useCallback(async (silentTriage = false, silent = false) => {
    if (accounts.length === 0) return;
    if (!silent) setLoading(true);
    try {
      const savedAccount = _currentAccount;
      const primaryAcct = accounts.find(a => a.is_primary)?.email || accounts[0].email;
      setCurrentAccount(primaryAcct);
      const profileRes = await gmailGet('profile');
      if (!profileRes.success && (profileRes.error?.includes('Not authenticated') || profileRes.error?.includes('auth failed'))) {
        setAuthError(true);
        setLoading(false);
        return;
      }
      if (profileRes.success) setProfile(profileRes.data);

      // Fetch inbox from each account in parallel
      const allMessages: GmailMessage[] = [];
      await Promise.all(accounts.map(async (acct) => {
        setCurrentAccount(acct.email);
        try {
          const res = await gmailGet('inbox', { q: 'in:inbox', max: '30' });
          if (res.success && res.data?.messages) {
            for (const msg of res.data.messages) {
              allMessages.push({ ...msg, accountEmail: acct.email });
            }
          }
        } catch (e) {
          console.error(`Failed to load inbox for ${acct.email}:`, e);
        }
      }));

      allMessages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setMessages(allMessages);
      setCurrentAccount(savedAccount);
    } catch (err) {
      console.error('Failed to load unified inbox:', err);
    } finally {
      setLoading(false);
    }
    // Silent triage for each account in background
    if (silentTriage) {
      for (const acct of accounts) {
        try {
          setCurrentAccount(acct.email);
          const res = await apiPost('triage', { action: 'triage' });
          if (res.success && res.data.total_unread > 0) {
            setTriageVersion(v => v + 1);
          }
        } catch { /* silent */ }
      }
      setCurrentAccount(_currentAccount);
    }
  }, [accounts]);

  // Track whether we've done the first load (to avoid flashing spinner on re-loads)
  const hasLoadedRef = React.useRef(false);

  // Initial load + triage on first load
  // Re-runs when accounts populate so unified view loads all accounts
  useEffect(() => {
    if (!account) return;
    const isFirstLoad = !hasLoadedRef.current;

    if (unified && accounts.length > 1) {
      // All accounts ready — load unified (show spinner only on first load)
      hasLoadedRef.current = true;
      loadUnifiedInbox(true, !isFirstLoad);
    } else if (unified && accounts.length <= 1) {
      // Accounts not loaded yet — load single account quietly if we already showed data
      if (isFirstLoad) {
        hasLoadedRef.current = true;
        loadInbox(true);
      }
      // Otherwise skip — wait for accounts to populate and trigger unified load
    } else {
      hasLoadedRef.current = true;
      loadInbox(true, !isFirstLoad);
    }
  }, [account, unified, accounts.length]);

  // Auto-refresh every 2 minutes with silent triage
  useEffect(() => {
    if (!account) return;
    const interval = setInterval(() => {
      if (unified && accounts.length > 1) {
        loadUnifiedInbox(true);
      } else {
        loadInbox(true);
      }
    }, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [account, unified, accounts.length, loadInbox, loadUnifiedInbox]);

  function showToast(title: string, subtitle?: string) {
    setToast({ title, subtitle });
    setTimeout(() => setToast(null), 3500);
  }

  async function handleAction(action: string, messageIds: string[], label?: string, overrideAccount?: string) {
    setActionLoading(messageIds[0]);
    try {
      const params: Record<string, unknown> = { action, messageIds };
      if (label) params.labelId = label;
      // If an override account is provided, temporarily switch the API context
      const savedAccount = _currentAccount;
      if (overrideAccount && overrideAccount !== _currentAccount) {
        setCurrentAccount(overrideAccount);
      }
      const res = await gmailPost(action, params);
      if (overrideAccount) setCurrentAccount(savedAccount);
      if (res.success) {
        const actionLabels: Record<string, string> = {
          archive: 'Archived', trash: 'Trashed', delete: 'Deleted',
          markRead: 'Marked read', markUnread: 'Marked unread',
          star: 'Starred', unstar: 'Unstarred',
          addLabel: 'Label added', removeLabel: 'Label removed',
        };
        showToast(actionLabels[action] || action, `${messageIds.length} message${messageIds.length > 1 ? 's' : ''}`);
        // Animate out for destructive actions
        if (['trash', 'delete', 'archive'].includes(action)) {
          const animType = action as 'trash' | 'delete' | 'archive';
          const anims: Record<string, 'trash' | 'delete' | 'archive'> = {};
          messageIds.forEach(id => { anims[id] = animType; });
          setAnimatingOut(prev => ({ ...prev, ...anims }));
          setTimeout(() => {
            setMessages((prev) => prev.filter((m) => !messageIds.includes(m.id)));
            setAnimatingOut(prev => {
              const next = { ...prev };
              messageIds.forEach(id => delete next[id]);
              return next;
            });
          }, 400);
          // Also mark reply queue items as done
          for (const msgId of messageIds) {
            apiPut('queue', { message_id: msgId, status: 'done' }).catch(() => {});
          }
          setTriageVersion(v => v + 1);
        } else {
          // Non-destructive: update immediately
          if (action === 'markRead') {
            setMessages(prev => prev.map(m => messageIds.includes(m.id) ? { ...m, isUnread: false } : m));
            // Also mark reply queue items as done so they disappear from Triage
            for (const msgId of messageIds) {
              apiPut('queue', { message_id: msgId, status: 'done' }).catch(() => {});
            }
            setTriageVersion(v => v + 1); // trigger Triage tab reload
          } else if (action === 'markUnread') {
            setMessages(prev => prev.map(m => messageIds.includes(m.id) ? { ...m, isUnread: true } : m));
          }
        }
      } else {
        showToast('Error', res.error);
      }
    } catch (err) {
      showToast('Error', String(err));
    } finally {
      setActionLoading(null);
    }
  }

  // Snooze any message — creates/updates a reply queue entry with snoozed status
  async function snoozeFromPreview(messageId: string, hours: number, label: string, accountEmail?: string) {
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    // Try to update existing queue entry by message_id
    const res = await apiPut('queue', { message_id: messageId, status: 'snoozed', snoozed_until: until });
    if (!res.success) {
      // No existing queue entry — create one via upsert
      // We need basic info about the message; use what we have
      await apiPost('queue', { message_id: messageId, account_email: accountEmail || _currentAccount, status: 'snoozed', snoozed_until: until });
    }
    setTriageVersion(v => v + 1); // reload snoozed tab
  }

  async function runTriage() {
    setTriageLoading(true);
    const accts = (unified && accounts.length > 1) ? accounts : [{ email: _currentAccount }];
    setBgTaskLabel(`Triaging ${accts.length} account${accts.length > 1 ? 's' : ''}...`);
    try {
      const savedAccount = _currentAccount;
      let totalEmails = 0, totalPriority = 0, totalCleanup = 0;
      for (let i = 0; i < accts.length; i++) {
        setBgTaskLabel(`Triaging account ${i + 1}/${accts.length}...`);
        setCurrentAccount(accts[i].email);
        const res = await apiPost('triage', { action: 'triage' });
        if (res.success) {
          const data = res.data;
          totalEmails += data.total_unread;
          totalPriority += data.categories.reply_needed.length + data.categories.important_notifications.length;
          totalCleanup += data.categories.low_priority.length;
        }
      }
      setCurrentAccount(savedAccount);
      showToast(`Triage complete`, `${totalEmails} emails: ${totalPriority} priority, ${totalCleanup} cleanup`);
      setTriageVersion(v => v + 1);
    } catch (err) {
      showToast('Triage failed', String(err));
    } finally {
      setTriageLoading(false);
      setBgTaskLabel(null);
    }
  }

  async function scanSentMail() {
    setTriageLoading(true);
    const accts = (unified && accounts.length > 1) ? accounts : [{ email: _currentAccount }];
    setBgTaskLabel(`Scanning sent mail (${accts.length} account${accts.length > 1 ? 's' : ''})...`);
    try {
      const savedAccount = _currentAccount;
      let totalSenders = 0, totalReplies = 0;
      for (let i = 0; i < accts.length; i++) {
        setBgTaskLabel(`Scanning sent mail ${i + 1}/${accts.length}...`);
        setCurrentAccount(accts[i].email);
        const res = await apiPost('triage', { action: 'scan_sent' });
        if (res.success) {
          totalSenders += res.data.sendersFound;
          totalReplies += res.data.totalReplies;
        }
      }
      setCurrentAccount(savedAccount);
      showToast('Scan complete', `Found ${totalSenders} senders, ${totalReplies} replies`);
    } catch (err) {
      showToast('Scan failed', String(err));
    } finally {
      setTriageLoading(false);
      setBgTaskLabel(null);
    }
  }

  // Callback for tabs to report their item count
  const reportTabCount = useCallback((tabId: string, count: number) => {
    setTabCounts(prev => prev[tabId] === count ? prev : { ...prev, [tabId]: count });
  }, []);

  // Report All Mail count from loaded messages
  useEffect(() => {
    const unread = messages.filter(m => m.isUnread).length;
    reportTabCount('inbox', unread);
  }, [messages, reportTabCount]);

  // Load all tab counts upfront (not just when each tab is visited)
  const loadAllTabCounts = useCallback(async () => {
    try {
      // Fetch queue data for Triage + Snoozed counts
      const queueRes = await apiGet('queue');
      if (queueRes.success) {
        const items = queueRes.data || [];
        const activeSignal = items.filter((q: any) => q.status === 'active' && q.priority !== 'low').length;
        const snoozed = items.filter((q: any) => q.status === 'snoozed').length;
        reportTabCount('reply-queue', activeSignal);
        reportTabCount('snoozed', snoozed);
      }

      // Fetch sender tiers for Cleanup count (from current messages)
      const sendersRes = await apiGet('senders');
      if (sendersRes.success && sendersRes.data) {
        const tiers: Record<string, string> = {};
        for (const s of sendersRes.data) tiers[s.sender_email.toLowerCase()] = s.tier;
        // Count noise emails from messages
        const noReply = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster'];
        const auto = ['notification', 'newsletter', 'digest', 'updates@', 'info@', 'support@', 'hello@', 'team@', 'news@', 'marketing@', 'promo'];
        const cleanupCount = messages.filter(m => {
          const lower = m.senderEmail.toLowerCase();
          const tier = tiers[lower];
          if (tier === 'A' || tier === 'B' || tier === 'C') return false;
          if (tier === 'D') return true;
          if (noReply.some(p => lower.includes(p))) return true;
          if (auto.some(p => lower.includes(p))) return true;
          if (!tier) return true;
          return false;
        }).length;
        reportTabCount('cleanup', cleanupCount);
        reportTabCount('priorities', sendersRes.data.length);
      }

      // Fetch follow-up count (starred sent + awaiting reply)
      const starredRes = await gmailGet('search', { q: 'in:sent is:starred', max: '50' });
      const sentRes = await gmailGet('search', { q: 'in:sent newer_than:7d', max: '30' });
      let followUpCount = 0;
      if (starredRes.success) followUpCount += (starredRes.data?.messages || []).length;
      if (sentRes.success) {
        const sentMsgs = sentRes.data?.messages || [];
        const awaitingCount = sentMsgs.filter((msg: any) => {
          const hoursSince = (Date.now() - new Date(msg.date).getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24) return false;
          if (hoursSince > 48) return true;
          return !msg.subject?.startsWith('Re:');
        }).length;
        followUpCount += awaitingCount;
      }
      reportTabCount('follow-up', followUpCount);
    } catch (e) {
      console.error('Failed to load tab counts:', e);
    }
  }, [messages, reportTabCount]);

  // Load tab counts on initial page load and whenever messages change
  useEffect(() => {
    if (account && messages.length > 0) {
      loadAllTabCounts();
    }
  }, [account, messages.length, loadAllTabCounts]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'reply-queue', label: 'Triage' },
    { id: 'follow-up', label: 'Follow Up' },
    { id: 'snoozed', label: 'Snoozed' },
    { id: 'cleanup', label: 'Cleanup' },
    { id: 'sent', label: 'Sent' },
    { id: 'inbox', label: 'All Mail' },
    { id: 'priorities', label: 'Priorities' },
    { id: 'accounts', label: 'Accounts' },
  ];

  // Auth error — show login prompt instead of redirect loop
  if (authError) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-2xl font-bold mb-3">Email Helper</h1>
        <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
          Your session has expired or you need to sign in.
        </p>
        <a
          href="/api/emailHelperV2/auth/login"
          className="inline-block px-6 py-3 rounded-xl text-white font-semibold"
          style={{ background: '#4f46e5' }}
        >
          Sign in with Google
        </a>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Email Helper</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Inbox Command Center</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Account Switcher with Unified toggle */}
          {accounts.length > 1 ? (
            <select
              value={unified ? '__unified__' : account}
              onChange={(e) => {
                if (e.target.value === '__unified__') switchToUnified();
                else switchAccount(e.target.value);
              }}
              className="text-sm px-3 py-2 rounded-lg border font-medium appearance-none cursor-pointer"
              style={{ background: unified ? '#ede9fe' : 'var(--normal-bg)', borderColor: unified ? '#8b5cf6' : 'var(--border)', color: unified ? '#5b21b6' : '#065f46' }}
            >
              <option value="__unified__">All Accounts (Unified)</option>
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
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b-2 mb-6 overflow-x-auto" style={{ borderColor: 'var(--border)' }}>
        {tabs.map((tab) => {
          const count = tabCounts[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-5 py-3 text-sm font-medium transition-all border-b-2 -mb-[2px] whitespace-nowrap flex items-center gap-1.5"
              style={{
                color: activeTab === tab.id ? 'var(--accent)' : 'var(--muted)',
                borderBottomColor: activeTab === tab.id ? 'var(--accent)' : 'transparent',
              }}
            >
              {tab.label}
              {count != null && count > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none"
                  style={{
                    background: activeTab === tab.id ? 'var(--accent)' : '#e2e8f0',
                    color: activeTab === tab.id ? 'white' : '#64748b',
                  }}>
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Background task banner — visible across all tabs */}
      {bgTaskLabel && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl mb-4 animate-pulse" style={{ background: '#eef2ff', border: '1px solid #c7d2fe' }}>
          <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#6366f1', borderTopColor: 'transparent' }} />
          <span className="text-sm font-medium" style={{ color: '#4338ca' }}>{bgTaskLabel}</span>
          <span className="text-xs ml-auto" style={{ color: '#6366f1' }}>You can keep working</span>
        </div>
      )}

      {/* Tab content — fixed width container prevents layout shift between tabs */}
      <div className="w-full" style={{ minHeight: '60vh' }}>
        {activeTab === 'inbox' && (
          <InboxTab messages={messages} loading={loading} actionLoading={actionLoading}
            onAction={handleAction} onRefresh={unified && accounts.length > 1 ? loadUnifiedInbox : loadInbox} showToast={showToast} animatingOut={animatingOut} onPreview={openPreview} />
        )}
        {activeTab === 'reply-queue' && <ReplyQueueTab onAction={handleAction} showToast={showToast} reloadKey={triageVersion} onPreview={openPreview} reportCount={(c: number) => reportTabCount('reply-queue', c)} />}
        {activeTab === 'follow-up' && <FollowUpTab accounts={accounts} unified={unified} onPreview={openPreview} showToast={showToast} onAction={handleAction} reportCount={(c: number) => reportTabCount('follow-up', c)} />}
        {activeTab === 'snoozed' && <SnoozedTab onAction={handleAction} showToast={showToast} onPreview={openPreview} reloadKey={triageVersion} reportCount={(c: number) => reportTabCount('snoozed', c)} />}
        {activeTab === 'cleanup' && <CleanupTab messages={messages} onAction={handleAction} showToast={showToast} onPreview={openPreview} reportCount={(c: number) => reportTabCount('cleanup', c)} />}
        {activeTab === 'sent' && <SentMailTab accounts={accounts} unified={unified} onPreview={openPreview} showToast={showToast} />}
        {activeTab === 'priorities' && <PrioritiesTab onScanSent={scanSentMail} scanning={triageLoading} showToast={showToast} />}
        {activeTab === 'accounts' && <AccountsTab currentAccount={account} accounts={accounts} onSwitch={switchAccount} onRefresh={loadAccounts} showToast={showToast} onRunTriage={runTriage} onScanSent={scanSentMail} triageLoading={triageLoading} bgTaskLabel={bgTaskLabel} />}
      </div>

      {/* Email Preview Modal */}
      {previewMessageId && <EmailPreviewModal messageId={previewMessageId} accountEmail={previewAccount} onClose={() => setPreviewMessageId(null)} onAction={handleAction} showToast={showToast} onSnooze={snoozeFromPreview} />}

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

function InboxTab({ messages, loading, actionLoading, onAction, onRefresh, showToast, animatingOut, onPreview }: {
  messages: GmailMessage[]; loading: boolean; actionLoading: string | null;
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void; onRefresh: () => void;
  showToast: (title: string, subtitle?: string) => void;
  animatingOut: Record<string, 'trash' | 'delete' | 'archive'>;
  onPreview: (messageId: string, accountEmail?: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ ids: string[]; count: number } | null>(null);
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
          <button onClick={() => setConfirmAction({ ids: selectedIds, count: selected.size })} className="px-3 py-2 text-xs font-medium rounded-lg border text-red-700 font-bold" style={{ borderColor: '#fca5a5' }}>Delete ({selected.size})</button>
        </>)}
        <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>{messages.length} messages</span>
      </div>
      {loading ? (
        <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
          <p className="text-sm">Loading your inbox...</p>
        </div>
      ) : messages.length === 0 ? (
        <div className="text-center py-16" style={{ color: 'var(--muted)' }}><p className="text-lg mb-2">Inbox Zero!</p><p className="text-sm">No messages.</p></div>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((msg) => (
            <div key={msg.id}
              className={`rounded-xl border transition-all hover:shadow-sm ${
                animatingOut[msg.id] === 'trash' ? 'animate-trash-out' :
                animatingOut[msg.id] === 'delete' ? 'animate-delete-out' :
                animatingOut[msg.id] === 'archive' ? 'animate-archive-out' : ''
              }`}
              style={{ background: selected.has(msg.id) ? '#eff6ff' : 'var(--card)', borderColor: selected.has(msg.id) ? 'var(--accent)' : 'var(--border)', opacity: actionLoading === msg.id ? 0.5 : 1 }}>
              <div className="flex items-start gap-3 p-4">
                <input type="checkbox" checked={selected.has(msg.id)} onChange={() => toggleSelect(msg.id)} className="mt-1 rounded" />
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onPreview(msg.id, msg.accountEmail)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate">{msg.sender}</span>
                    <div className="flex items-center gap-2">
                      {msg.isUnread && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} />}
                      <span className="text-xs whitespace-nowrap" style={{ color: 'var(--muted)' }}>{new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                    </div>
                  </div>
                  <div className="text-sm font-medium truncate">{msg.subject}</div>
                  <div className="text-xs truncate mt-0.5" style={{ color: 'var(--muted)' }}>
                    {msg.accountEmail && <span className="inline-block mr-1 px-1.5 py-0 rounded text-[9px] font-medium" style={{ background: '#f3f4f6', color: '#6b7280' }}>{msg.accountEmail.split('@')[0]}</span>}
                    {decodeHtmlEntities(msg.snippet)}
                  </div>
                </div>
              </div>
              {/* Action bar */}
              <div className="flex gap-1 px-4 pb-3 flex-wrap">
                <button onClick={() => { setReplyingTo(replyingTo === msg.id ? null : msg.id); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>Reply</button>
                <button onClick={() => onAction('archive', [msg.id])} className="px-2 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Archive</button>
                <button onClick={() => onAction(msg.isUnread ? 'markRead' : 'markUnread', [msg.id])}
                  className="px-2 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                  {msg.isUnread ? 'Mark Read' : 'Mark Unread'}
                </button>
                <button onClick={() => onAction('star', [msg.id])} className="px-2 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Star</button>
                <button onClick={() => onAction('trash', [msg.id])} className="px-2 py-1.5 text-xs rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                <button onClick={() => setConfirmAction({ ids: [msg.id], count: 1 })}
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
      {confirmAction && (
        <ConfirmModal
          title="Permanently Delete"
          message={`This will permanently delete ${confirmAction.count} message${confirmAction.count > 1 ? 's' : ''} from Gmail. This cannot be undone.`}
          confirmLabel="Delete Forever"
          confirmColor="#dc2626"
          onConfirm={() => { onAction('delete', confirmAction.ids); setConfirmAction(null); setSelected(new Set()); }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}

// ============ SNOOZE DROPDOWN ============

function SnoozeDropdown({ onSnooze }: { onSnooze: (hours: number, label: string) => void }) {
  const [open, setOpen] = useState(false);

  const options = [
    { label: 'in 1 hour', hours: 1 },
    { label: 'in 3 hours', hours: 3 },
    { label: 'tomorrow morning', hours: (() => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return (tomorrow.getTime() - Date.now()) / (1000 * 60 * 60);
    })() },
    { label: 'next Monday', hours: (() => {
      const d = new Date();
      const daysUntilMon = ((8 - d.getDay()) % 7) || 7;
      d.setDate(d.getDate() + daysUntilMon);
      d.setHours(9, 0, 0, 0);
      return (d.getTime() - Date.now()) / (1000 * 60 * 60);
    })() },
    { label: 'in 1 week', hours: 168 },
  ];

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="px-3 py-1.5 text-xs font-medium rounded-lg"
        style={{ background: '#fef9c3', color: '#854d0e' }}>
        Snooze ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[160px]"
            style={{ background: 'white', borderColor: 'var(--border)' }}>
            {options.map((opt) => (
              <button key={opt.label} onClick={() => { onSnooze(opt.hours, opt.label); setOpen(false); }}
                className="w-full text-left px-4 py-2 text-xs hover:bg-gray-50 transition-colors">
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============ REPLY QUEUE TAB ============

function ReplyQueueTab({ onAction, showToast, reloadKey, onPreview, reportCount }: {
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  reloadKey: number;
  onPreview: (messageId: string, accountEmail?: string) => void;
  reportCount?: (count: number) => void;
}) {
  const [queue, setQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<string | null>(null);

  useEffect(() => { loadQueue(); }, [reloadKey]);

  async function loadQueue() {
    setLoading(true);
    const res = await apiGet('queue');
    if (res.success) {
      setQueue(res.data);
      const items = res.data || [];
      // Only count active signal items (exclude low priority — those go to Cleanup)
      const activeSignalCount = items.filter((q: any) => q.status === 'active' && q.priority !== 'low').length;
      reportCount?.(activeSignalCount);
    }
    setLoading(false);
  }

  async function updateStatus(id: string, status: string, snoozedUntil?: string) {
    const payload: Record<string, unknown> = { id, status };
    if (snoozedUntil) payload.snoozed_until = snoozedUntil;
    const res = await apiPut('queue', payload);
    if (res.success) {
      setQueue(prev => prev.map(q => q.id === id ? { ...q, status, snoozed_until: snoozedUntil || q.snoozed_until } : q));
      showToast(`Marked ${status}`);
    }
  }

  // Downgrade a sender to lower tier (moves them to Cleanup)
  async function downgradeSender(email: string, name: string, queueId: string) {
    try {
      const res = await apiPut('senders', { sender_email: email, tier: 'D', display_name: name || email });
      if (res.success) {
        // Remove from queue view since they're now low-priority
        setQueue(prev => prev.filter(q => q.id !== queueId));
        showToast(`Downgraded to Tier D`, `${name || email} will now appear in Cleanup`);
      } else {
        showToast('Failed to downgrade', res.error);
      }
    } catch (e) {
      showToast('Failed to downgrade', String(e));
    }
  }

  function snoozeItem(id: string, hours: number, label: string) {
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    updateStatus(id, 'snoozed', until);
    showToast(`Snoozed`, `Will reappear ${label}`);
  }

  // Queue action: perform Gmail action and remove from queue view
  async function queueAction(action: string, messageId: string, queueId: string, accountEmail: string) {
    onAction(action, [messageId], undefined, accountEmail);
    // Remove from queue display and mark as done
    if (['trash', 'delete', 'archive', 'markRead'].includes(action)) {
      setQueue(prev => prev.filter(q => q.id !== queueId));
      updateStatus(queueId, 'done');
    }
  }

  // Auto-reactivate snoozed items whose time is up
  useEffect(() => {
    const now = new Date().toISOString();
    queue.forEach(q => {
      if (q.status === 'snoozed' && q.snoozed_until && q.snoozed_until <= now) {
        updateStatus(q.id, 'active');
      }
    });
  }, [queue]);

  // Filter out low-priority items — those belong in Cleanup, not here
  const signalQueue = queue.filter(q => q.priority !== 'low');
  const active = signalQueue.filter(q => q.status === 'active');
  const snoozed = signalQueue.filter(q => q.status === 'snoozed');

  const priorityColors: Record<string, { border: string; bg: string; label: string }> = {
    urgent: { border: 'var(--urgent)', bg: 'var(--urgent-bg)', label: 'Reply Now' },
    important: { border: 'var(--important)', bg: 'var(--important-bg)', label: 'Reply Today' },
    normal: { border: 'var(--normal)', bg: 'var(--normal-bg)', label: 'When Free' },
  };

  if (loading) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      <p className="text-sm">Loading your priority emails...</p>
    </div>
  );

  if (signalQueue.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No priority emails in triage</p>
      <p className="text-sm">Triage runs automatically every 2 minutes. Only high-priority senders (Tier A/B) and emails needing replies appear here. You can also run it manually from the Accounts tab.</p>
    </div>
  );

  // Count emails per tier for badges
  const tierCounts = { A: 0, B: 0, C: 0 };
  active.forEach(q => {
    const t = q.tier as 'A' | 'B' | 'C';
    if (t in tierCounts) tierCounts[t]++;
  });

  const filteredActive = tierFilter ? active.filter(q => q.tier === tierFilter) : active;

  return (
    <div>
      {/* Tier filter badges */}
      <div className="flex gap-2 mb-4">
        {([
          { tier: null, label: 'All', bg: '#f3f4f6', color: '#374151', border: '#d1d5db', activeBg: '#374151', activeColor: '#fff' },
          { tier: 'A', label: `Tier A (${tierCounts.A})`, bg: '#dcfce7', color: '#166534', border: '#86efac', activeBg: '#166534', activeColor: '#fff' },
          { tier: 'B', label: `Tier B (${tierCounts.B})`, bg: '#fef3c7', color: '#92400e', border: '#fbbf24', activeBg: '#92400e', activeColor: '#fff' },
          { tier: 'C', label: `Tier C (${tierCounts.C})`, bg: '#e0f2fe', color: '#075985', border: '#7dd3fc', activeBg: '#075985', activeColor: '#fff' },
        ] as const).map(b => {
          const isActive = tierFilter === b.tier;
          return (
            <button key={b.label} onClick={() => setTierFilter(b.tier)}
              className="px-3 py-1.5 text-xs font-semibold rounded-full transition-all"
              style={{
                background: isActive ? b.activeBg : b.bg,
                color: isActive ? b.activeColor : b.color,
                border: `1.5px solid ${isActive ? b.activeBg : b.border}`,
              }}>
              {b.label}
            </button>
          );
        })}
      </div>

      {/* Active items grouped by priority — low priority goes to Cleanup tab */}
      {['urgent', 'important', 'normal'].map(priority => {
        const items = filteredActive.filter(q => q.priority === priority);
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
                      <TierDropdown currentTier={q.tier || ''} senderEmail={q.sender_email} senderName={q.sender}
                        onTierChanged={(newTier) => {
                          // If downgraded to C/D, remove from queue view
                          if (newTier === 'C' || newTier === 'D') {
                            setQueue(prev => prev.filter(item => item.id !== q.id));
                            showToast(`Moved to Cleanup`, `${q.sender} is now Tier ${newTier}`);
                          } else {
                            setQueue(prev => prev.map(item => item.id === q.id ? { ...item, tier: newTier } : item));
                            showToast(`Updated to Tier ${newTier}`, q.sender);
                          }
                        }} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-sm font-medium cursor-pointer hover:underline" onClick={() => onPreview(q.message_id, q.account_email)}>{q.subject}</span>
                      {q.received && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: '#f1f5f9', color: '#64748b' }}>
                          {new Date(q.received).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(q.summary || '')}</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                      {q.account_email} &middot; Score: {q.priority_score}/10
                      {q.reply_count > 0 && <> &middot; <span style={{ color: '#6366f1' }}>{q.reply_count} replies sent</span></>}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3 flex-wrap">
                  <button onClick={() => onPreview(q.message_id, q.account_email)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg" style={{ background: '#f1f5f9', color: '#334155' }}>
                    Preview</button>
                  <button onClick={() => setReplyingTo(replyingTo === q.id ? null : q.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>Reply</button>
                  <SnoozeDropdown onSnooze={(hours, label) => snoozeItem(q.id, hours, label)} />
                  <button onClick={() => queueAction('archive', q.message_id, q.id, q.account_email)} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                  <button onClick={() => queueAction('markRead', q.message_id, q.id, q.account_email)} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Mark Read</button>
                  <button onClick={() => queueAction('trash', q.message_id, q.id, q.account_email)} className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                  <button onClick={() => setConfirmDelete(q.id + '::' + q.message_id + '::' + q.account_email)}
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
                      onSent={() => { setReplyingTo(null); queueAction('archive', q.message_id, q.id, q.account_email); }}
                      onCancel={() => setReplyingTo(null)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {confirmDelete && (() => {
        const [qId, msgId, acctEmail] = confirmDelete.split('::');
        return (
          <ConfirmModal
            title="Permanently Delete"
            message="This will permanently delete this message from Gmail. This cannot be undone."
            confirmLabel="Delete Forever"
            confirmColor="#dc2626"
            onConfirm={() => { queueAction('delete', msgId, qId, acctEmail); setConfirmDelete(null); }}
            onCancel={() => setConfirmDelete(null)}
          />
        );
      })()}
    </div>
  );
}

// ============ CLEANUP TAB ============

function CleanupTab({ messages, onAction, showToast, onPreview, reportCount }: { messages: GmailMessage[]; onAction: (action: string, ids: string[], label?: string) => void; showToast: (title: string, subtitle?: string) => void; onPreview: (messageId: string, accountEmail?: string) => void; reportCount?: (count: number) => void; }) {
  const [expandedSender, setExpandedSender] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'tier' | 'count' | 'name'>('tier');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [senderTiers, setSenderTiers] = useState<Record<string, string>>({});
  const [senderReplyCounts, setSenderReplyCounts] = useState<Record<string, number>>({});
  const [tiersLoaded, setTiersLoaded] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  // Load sender priorities to know who is noise vs signal
  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet('senders');
        if (res.success && res.data) {
          const tiers: Record<string, string> = {};
          const counts: Record<string, number> = {};
          for (const s of res.data) {
            tiers[s.sender_email.toLowerCase()] = s.tier;
            counts[s.sender_email.toLowerCase()] = s.reply_count || 0;
          }
          setSenderTiers(tiers);
          setSenderReplyCounts(counts);
        }
      } catch (e) { console.error('Failed to load sender tiers for cleanup:', e); }
      setTiersLoaded(true);
    })();
  }, []);

  // Promote a sender to a higher tier (moves them out of Cleanup into Triage)
  async function promoteSender(email: string, name: string, newTier: string) {
    try {
      const res = await apiPut('senders', { sender_email: email, tier: newTier, display_name: name || email });
      if (res.success) {
        setSenderTiers(prev => ({ ...prev, [email.toLowerCase()]: newTier }));
        showToast(`Promoted to Tier ${newTier}`, `${name || email} will now appear in Inbox (Triage)`);
      } else {
        showToast('Failed to promote', res.error);
      }
    } catch (e) {
      showToast('Failed to promote', String(e));
    }
  }

  // Noise detection helpers
  const noReplyPatterns = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster'];
  const automatedPatterns = ['notification', 'newsletter', 'digest', 'updates@', 'info@', 'support@', 'hello@', 'team@', 'news@', 'marketing@', 'promo'];

  function isNoiseSender(email: string): boolean {
    const lower = email.toLowerCase();
    const tier = senderTiers[lower];
    // Signal senders (Tier A/B/C) go to Reply Queue / Triage, not here
    if (tier === 'A' || tier === 'B' || tier === 'C') return false;
    // Tier D = low priority = cleanup
    if (tier === 'D') return true;
    // No-reply / automated senders = always noise
    if (noReplyPatterns.some(p => lower.includes(p))) return true;
    if (automatedPatterns.some(p => lower.includes(p))) return true;
    // Unknown senders (not in priority list at all) = cleanup
    if (!tier) return true;
    return false;
  }

  // Filter messages to only noise senders
  const cleanupMessages = tiersLoaded ? messages.filter(m => isNoiseSender(m.senderEmail)) : [];

  // Report count to parent
  useEffect(() => { reportCount?.(cleanupMessages.length); }, [cleanupMessages.length]);

  // Group filtered messages by sender email
  const senderGroups: Record<string, { name: string; email: string; messages: GmailMessage[] }> = {};
  for (const msg of cleanupMessages) {
    const key = msg.senderEmail.toLowerCase();
    if (!senderGroups[key]) {
      senderGroups[key] = { name: msg.sender, email: msg.senderEmail, messages: [] };
    }
    senderGroups[key].messages.push(msg);
  }

  const groups = Object.values(senderGroups);
  const tierOrder: Record<string, number> = { D: 0 };
  if (sortBy === 'tier') {
    groups.sort((a, b) => {
      const tierA = senderTiers[a.email.toLowerCase()] || '';
      const tierB = senderTiers[b.email.toLowerCase()] || '';
      const orderA = tierOrder[tierA] ?? 1; // no tier = after D
      const orderB = tierOrder[tierB] ?? 1;
      if (orderA !== orderB) return orderA - orderB;
      // Within same tier, sort by reply count (most sent first), then by message count
      const rcA = senderReplyCounts[a.email.toLowerCase()] || 0;
      const rcB = senderReplyCounts[b.email.toLowerCase()] || 0;
      if (rcB !== rcA) return rcB - rcA;
      return b.messages.length - a.messages.length;
    });
  } else if (sortBy === 'count') {
    groups.sort((a, b) => {
      if (b.messages.length !== a.messages.length) return b.messages.length - a.messages.length;
      const rcA = senderReplyCounts[a.email.toLowerCase()] || 0;
      const rcB = senderReplyCounts[b.email.toLowerCase()] || 0;
      return rcB - rcA;
    });
  } else {
    groups.sort((a, b) => a.name.localeCompare(b.name));
  }

  function toggleGroup(email: string) {
    setSelectedGroups(prev => {
      const next = new Set(prev);
      if (next.has(email)) {
        next.delete(email);
        // Also deselect individual messages from this sender
        const group = senderGroups[email.toLowerCase()];
        if (group) {
          setSelectedMessages(prev2 => {
            const next2 = new Set(prev2);
            group.messages.forEach(m => next2.delete(m.id));
            return next2;
          });
        }
      } else {
        next.add(email);
      }
      return next;
    });
  }

  function toggleMessage(id: string) {
    setSelectedMessages(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAllGroups() {
    if (selectedGroups.size === groups.length) {
      setSelectedGroups(new Set());
      setSelectedMessages(new Set());
    } else {
      setSelectedGroups(new Set(groups.map(g => g.email)));
    }
  }

  // Collect all selected message IDs (from selected groups + individually selected messages)
  function getSelectedIds(): string[] {
    const ids = new Set<string>();
    // Add all messages from selected groups
    for (const email of selectedGroups) {
      const group = senderGroups[email.toLowerCase()];
      if (group) group.messages.forEach(m => ids.add(m.id));
    }
    // Add individually selected messages
    for (const id of selectedMessages) ids.add(id);
    return Array.from(ids);
  }

  const selectedIds = getSelectedIds();
  const selectedCount = selectedIds.length;

  if (!tiersLoaded) return <div className="text-center py-16" style={{ color: 'var(--muted)' }}>Loading cleanup data...</div>;

  if (cleanupMessages.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No low-priority emails to clean up</p>
      <p className="text-sm">Only showing noise senders (Tier C/D, unknown, automated). Your important senders are in the Reply Queue.</p>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={selectAllGroups}
            className="px-3 py-1.5 text-xs rounded-lg border font-medium"
            style={{ borderColor: 'var(--border)', background: selectedGroups.size === groups.length ? 'var(--accent)' : 'transparent', color: selectedGroups.size === groups.length ? 'white' : 'var(--muted)' }}>
            {selectedGroups.size === groups.length ? 'Deselect All' : 'Select All'}
          </button>
          <div>
            <p className="text-sm font-semibold">{groups.length} senders</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{cleanupMessages.length} low-priority messages</p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Sort:</span>
          <button onClick={() => setSortBy('tier')}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ background: sortBy === 'tier' ? 'var(--accent)' : 'transparent', color: sortBy === 'tier' ? 'white' : 'var(--muted)', borderColor: 'var(--border)' }}>
            By Tier
          </button>
          <button onClick={() => setSortBy('count')}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ background: sortBy === 'count' ? 'var(--accent)' : 'transparent', color: sortBy === 'count' ? 'white' : 'var(--muted)', borderColor: 'var(--border)' }}>
            Most emails
          </button>
          <button onClick={() => setSortBy('name')}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ background: sortBy === 'name' ? 'var(--accent)' : 'transparent', color: sortBy === 'name' ? 'white' : 'var(--muted)', borderColor: 'var(--border)' }}>
            A→Z
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedCount > 0 && (
        <div className="mb-4 p-3 rounded-xl flex items-center justify-between gap-3" style={{ background: '#eff6ff', border: '2px solid var(--accent)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
            {selectedCount} message{selectedCount > 1 ? 's' : ''} selected
            {selectedGroups.size > 0 && ` (${selectedGroups.size} sender${selectedGroups.size > 1 ? 's' : ''})`}
          </span>
          <div className="flex gap-2">
            <button onClick={() => { onAction('markRead', selectedIds); setSelectedGroups(new Set()); setSelectedMessages(new Set()); }}
              className="px-4 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', background: 'white' }}>
              Mark Read
            </button>
            <button onClick={() => { onAction('archive', selectedIds); setSelectedGroups(new Set()); setSelectedMessages(new Set()); }}
              className="px-4 py-2 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>
              Archive All
            </button>
            <button onClick={() => { onAction('trash', selectedIds); setSelectedGroups(new Set()); setSelectedMessages(new Set()); }}
              className="px-4 py-2 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--urgent)' }}>
              Trash All
            </button>
            <button onClick={() => setConfirmDeleteAll(true)}
              className="px-4 py-2 text-xs font-semibold rounded-lg text-white" style={{ background: '#991b1b' }}>
              Delete All
            </button>
          </div>
        </div>
      )}

      {/* Sender list */}
      <div className="flex flex-col gap-2">
        {groups.map(group => {
          const isExpanded = expandedSender === group.email;
          const isGroupSelected = selectedGroups.has(group.email);
          const allIds = group.messages.map(m => m.id);
          return (
            <div key={group.email} className="rounded-xl border overflow-hidden transition-all"
              style={{ background: isGroupSelected ? '#eff6ff' : 'var(--card)', borderColor: isGroupSelected ? 'var(--accent)' : 'var(--border)' }}>
              {/* Sender row */}
              <div className="flex items-center gap-3 p-4">
                <input type="checkbox" checked={isGroupSelected} onChange={() => toggleGroup(group.email)}
                  className="rounded flex-shrink-0" style={{ accentColor: 'var(--accent)' }} />
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0 cursor-pointer"
                  onClick={() => setExpandedSender(isExpanded ? null : group.email)}
                  style={{ background: group.messages.length >= 5 ? 'var(--urgent)' : group.messages.length >= 3 ? 'var(--important)' : 'var(--accent)' }}>
                  {group.messages.length}
                </div>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedSender(isExpanded ? null : group.email)}>
                  <div className="font-semibold text-sm truncate">{group.name}</div>
                  <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{group.email}</div>
                </div>
                <div className="flex gap-2 flex-shrink-0 items-center">
                  <TierDropdown
                    currentTier={senderTiers[group.email.toLowerCase()] || ''}
                    senderEmail={group.email}
                    senderName={group.name}
                    onTierChanged={(newTier) => {
                      setSenderTiers(prev => ({ ...prev, [group.email.toLowerCase()]: newTier }));
                      if (newTier === 'A' || newTier === 'B') {
                        showToast(`Promoted to Tier ${newTier}`, `${group.name} will appear in Inbox (Triage)`);
                      } else {
                        showToast(`Updated to Tier ${newTier}`, group.name);
                      }
                    }}
                  />
                  <SnoozeDropdown onSnooze={(hours, label) => {
                    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
                    for (const m of group.messages) {
                      apiPost('queue', { message_id: m.id, account_email: m.accountEmail || _currentAccount, status: 'snoozed', snoozed_until: until, sender: group.name, sender_email: group.email, subject: m.subject });
                    }
                    showToast('Snoozed', `${group.messages.length} message${group.messages.length > 1 ? 's' : ''} will reappear ${label}`);
                  }} />
                  <button onClick={() => onAction('archive', allIds)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                    Archive
                  </button>
                  <button onClick={() => onAction('trash', allIds)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>
                    Trash
                  </button>
                  <span className="text-xs self-center cursor-pointer" onClick={() => setExpandedSender(isExpanded ? null : group.email)}
                    style={{ color: 'var(--muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded messages */}
              {isExpanded && (
                <div className="border-t px-4 pb-3" style={{ borderColor: 'var(--border)', background: '#f8fafc' }}>
                  {group.messages.map(msg => {
                    const isMsgSelected = isGroupSelected || selectedMessages.has(msg.id);
                    return (
                      <div key={msg.id} className="flex items-center justify-between py-2 text-xs border-b" style={{ borderColor: 'var(--border)', background: isMsgSelected ? '#dbeafe' : 'transparent' }}>
                        <div className="flex items-center gap-2 flex-1 min-w-0 mr-2">
                          <input type="checkbox" checked={isMsgSelected} onChange={() => toggleMessage(msg.id)}
                            disabled={isGroupSelected} className="rounded flex-shrink-0" style={{ accentColor: 'var(--accent)' }} />
                          <div className="min-w-0 cursor-pointer" onClick={() => onPreview(msg.id, msg.accountEmail)}>
                            <div className="font-medium truncate hover:underline">{msg.subject}</div>
                            <div className="truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(msg.snippet)}</div>
                          </div>
                        </div>
                        <div className="flex gap-1 flex-shrink-0 items-center">
                          <span className="text-[10px] self-center mr-1" style={{ color: 'var(--muted)' }}>{new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          <button onClick={() => onAction('markRead', [msg.id])} className="px-2 py-0.5 rounded border text-[10px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Read</button>
                          <button onClick={() => onAction('archive', [msg.id])} className="px-2 py-0.5 rounded border text-[10px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                          <button onClick={() => onAction('trash', [msg.id])} className="px-2 py-0.5 rounded border text-[10px] text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Delete All confirmation */}
      {confirmDeleteAll && (
        <ConfirmModal
          title="Permanently Delete All Selected"
          message={`This will permanently delete ${selectedCount} message${selectedCount > 1 ? 's' : ''} from Gmail. This cannot be undone.`}
          confirmLabel={`Delete ${selectedCount} Forever`}
          confirmColor="#991b1b"
          onConfirm={() => { onAction('delete', selectedIds); setSelectedGroups(new Set()); setSelectedMessages(new Set()); setConfirmDeleteAll(false); }}
          onCancel={() => setConfirmDeleteAll(false)}
        />
      )}
    </div>
  );
}

// ============ SENT MAIL TAB ============

// Normalize subject: strip Re:/Fwd:/FW: prefixes for conversation grouping
function normalizeSubject(subject: string): string {
  return (subject || '(no subject)').replace(/^(re|fwd|fw)\s*:\s*/gi, '').replace(/^(re|fwd|fw)\s*:\s*/gi, '').trim() || '(no subject)';
}

// Extract clean email from "Name <email>" or just "email"
function extractEmail(to: string): string {
  const match = to.match(/<([^>]+)>/);
  return (match ? match[1] : to).toLowerCase().trim();
}

interface ConversationGroup {
  normalizedSubject: string;
  messages: GmailMessage[];
  recipients: { name: string; email: string }[];
  mostRecent: GmailMessage;
  hasAwaiting: boolean;
  totalSent: number;
}

function SentMailTab({ accounts, unified, onPreview, showToast }: {
  accounts: ConnectedAccount[];
  unified: boolean;
  onPreview: (messageId: string, accountEmail?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
}) {
  const [sentMessages, setSentMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'conversations' | 'recipients'>('conversations');
  const [senderPriorities, setSenderPriorities] = useState<Record<string, number>>({});
  const [expandedConvo, setExpandedConvo] = useState<string | null>(null);

  useEffect(() => { loadSentMail(); }, []);

  async function loadSentMail() {
    setLoading(true);
    try {
      // Load sender reply counts for badges
      const sendersRes = await apiGet('senders');
      if (sendersRes.success && sendersRes.data) {
        const counts: Record<string, number> = {};
        for (const s of sendersRes.data) counts[s.sender_email.toLowerCase()] = s.reply_count || 0;
        setSenderPriorities(counts);
      }

      // Fetch sent mail from all accounts if unified, otherwise current
      const allSent: GmailMessage[] = [];
      if (unified && accounts.length > 1) {
        const savedAccount = _currentAccount;
        for (const acct of accounts) {
          setCurrentAccount(acct.email);
          try {
            const res = await gmailGet('search', { q: 'in:sent', max: '30' });
            if (res.success && res.data?.messages) {
              for (const msg of res.data.messages) {
                allSent.push({ ...msg, accountEmail: acct.email });
              }
            }
          } catch (e) { console.error(`Failed to load sent for ${acct.email}:`, e); }
        }
        setCurrentAccount(savedAccount);
      } else {
        const res = await gmailGet('search', { q: 'in:sent', max: '50' });
        if (res.success && res.data?.messages) {
          for (const msg of res.data.messages) {
            allSent.push({ ...msg, accountEmail: _currentAccount });
          }
        }
      }

      // Sort by date descending
      allSent.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setSentMessages(allSent);
    } catch (err) {
      console.error('Failed to load sent mail:', err);
    } finally {
      setLoading(false);
    }
  }

  // Detect "awaiting reply" — sent more than 24h ago, no reply in thread
  function isAwaitingReply(msg: GmailMessage): boolean {
    const sentDate = new Date(msg.date);
    const hoursSince = (Date.now() - sentDate.getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) return false;
    if (hoursSince > 48) return true;
    return !msg.subject?.startsWith('Re:');
  }

  // Build conversation groups by normalized subject
  const conversationMap: Record<string, ConversationGroup> = {};
  for (const msg of sentMessages) {
    const normSubj = normalizeSubject(msg.subject);
    if (!conversationMap[normSubj]) {
      conversationMap[normSubj] = {
        normalizedSubject: normSubj,
        messages: [],
        recipients: [],
        mostRecent: msg,
        hasAwaiting: false,
        totalSent: 0,
      };
    }
    const group = conversationMap[normSubj];
    group.messages.push(msg);
    group.totalSent++;
    if (isAwaitingReply(msg)) group.hasAwaiting = true;
    // Track unique recipients
    const toField = (msg as any).to || '';
    const toEmail = extractEmail(toField);
    const toName = toField.split('<')[0]?.replace(/"/g, '').trim() || toEmail;
    if (toEmail && !group.recipients.find(r => r.email === toEmail)) {
      group.recipients.push({ name: toName, email: toEmail });
    }
    // Keep most recent
    if (new Date(msg.date) > new Date(group.mostRecent.date)) {
      group.mostRecent = msg;
    }
  }
  const conversations = Object.values(conversationMap).sort(
    (a, b) => new Date(b.mostRecent.date).getTime() - new Date(a.mostRecent.date).getTime()
  );

  // Group by recipient for the "By Recipient" view
  const recipientGroups: Record<string, { name: string; email: string; messages: GmailMessage[] }> = {};
  for (const msg of sentMessages) {
    const toField = (msg as any).to || '';
    const toEmail = extractEmail(toField);
    const toName = toField.split('<')[0]?.replace(/"/g, '').trim() || msg.sender || toEmail;
    const key = toEmail || 'unknown';
    if (!recipientGroups[key]) {
      recipientGroups[key] = { name: toName, email: key, messages: [] };
    }
    recipientGroups[key].messages.push(msg);
  }
  const groups = Object.values(recipientGroups).sort((a, b) => b.messages.length - a.messages.length);

  if (loading) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      <p className="text-sm">Loading sent mail...</p>
    </div>
  );

  if (sentMessages.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No sent messages found</p>
    </div>
  );

  const awaitingCount = sentMessages.filter(isAwaitingReply).length;

  // Get aggregate sent count for a list of recipient emails
  function getSentCount(emails: string[]): number {
    let total = 0;
    for (const e of emails) total += senderPriorities[e.toLowerCase()] || 0;
    return total;
  }

  return (
    <div>
      {/* Header bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold">{conversations.length} conversations ({sentMessages.length} messages)</p>
          {awaitingCount > 0 && (
            <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: '#fef3c7', color: '#92400e' }}>
              {awaitingCount} awaiting reply
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setViewMode('conversations')}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ background: viewMode === 'conversations' ? 'var(--accent)' : 'transparent', color: viewMode === 'conversations' ? 'white' : 'var(--muted)', borderColor: 'var(--border)' }}>
            Conversations
          </button>
          <button onClick={() => setViewMode('recipients')}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ background: viewMode === 'recipients' ? 'var(--accent)' : 'transparent', color: viewMode === 'recipients' ? 'white' : 'var(--muted)', borderColor: 'var(--border)' }}>
            By Recipient
          </button>
          <button onClick={loadSentMail}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Conversations view — grouped by normalized subject */}
      {viewMode === 'conversations' && (
        <div className="flex flex-col gap-2">
          {conversations.map((convo) => {
            const isExpanded = expandedConvo === convo.normalizedSubject;
            const sentCount = getSentCount(convo.recipients.map(r => r.email));
            const recipientList = convo.recipients.map(r => r.name || r.email).join(', ');
            const latestMsg = convo.mostRecent;
            return (
              <div key={convo.normalizedSubject} className="rounded-xl border overflow-hidden transition-shadow hover:shadow-sm"
                style={{
                  background: convo.hasAwaiting ? '#fffbeb' : 'var(--card)',
                  borderColor: convo.hasAwaiting ? '#fbbf24' : 'var(--border)',
                  borderLeftWidth: convo.hasAwaiting ? 4 : 1,
                  borderLeftColor: convo.hasAwaiting ? '#f59e0b' : 'var(--border)',
                }}>
                {/* Conversation header — click to expand */}
                <div className="p-4 cursor-pointer" onClick={() => setExpandedConvo(isExpanded ? null : convo.normalizedSubject)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">To: {recipientList}</span>
                        {convo.recipients.length > 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ background: '#e0f2fe', color: '#075985' }}>
                            {convo.recipients.length} recipients
                          </span>
                        )}
                        {convo.hasAwaiting && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap" style={{ background: '#fef3c7', color: '#92400e' }}>
                            Awaiting reply
                          </span>
                        )}
                        {sentCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ background: '#ede9fe', color: '#6366f1' }}>
                            {sentCount} emails sent
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-sm font-medium truncate">{convo.normalizedSubject}</span>
                        {convo.totalSent > 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap flex-shrink-0" style={{ background: '#f0fdf4', color: '#166534' }}>
                            {convo.totalSent} messages
                          </span>
                        )}
                        <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0" style={{ background: '#f1f5f9', color: '#64748b' }}>
                          {new Date(latestMsg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(latestMsg.snippet || '')}</div>
                      {latestMsg.accountEmail && accounts.length > 1 && (
                        <div className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>via {latestMsg.accountEmail}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {convo.totalSent > 1 && (
                        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); onPreview(latestMsg.id, latestMsg.accountEmail); }}
                        className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                        Preview
                      </button>
                    </div>
                  </div>
                </div>
                {/* Expanded messages within conversation */}
                {isExpanded && convo.messages.length > 1 && (
                  <div className="border-t divide-y" style={{ borderColor: 'var(--border)' }}>
                    {convo.messages.map((msg, idx) => (
                      <div key={msg.id} className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors"
                        onClick={() => onPreview(msg.id, msg.accountEmail)}>
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0" style={{ background: 'var(--accent)' }}>
                          {idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium">To: {(msg as any).to || 'Unknown'}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: '#f1f5f9', color: '#64748b' }}>
                              {msg.subject?.startsWith('Fwd:') || msg.subject?.startsWith('FW:') ? 'Forwarded' : msg.subject?.startsWith('Re:') ? 'Reply' : 'New'}
                            </span>
                            {isAwaitingReply(msg) && (
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#f59e0b' }} />
                            )}
                          </div>
                          <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(msg.snippet || '')}</div>
                        </div>
                        <span className="text-[10px] whitespace-nowrap flex-shrink-0" style={{ color: 'var(--muted)' }}>
                          {new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Grouped by recipient view */}
      {viewMode === 'recipients' && (
        <div className="flex flex-col gap-3">
          {groups.map((group) => {
            const sentCount = senderPriorities[group.email.replace(/.*</, '').replace(/>.*/, '')] || 0;
            const hasAwaiting = group.messages.some(isAwaitingReply);
            return (
              <div key={group.email} className="rounded-xl border overflow-hidden" style={{ background: 'var(--card)', borderColor: hasAwaiting ? '#fbbf24' : 'var(--border)' }}>
                <div className="flex items-center justify-between p-4" style={{ background: hasAwaiting ? '#fffbeb' : '#f8fafc' }}>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0" style={{ background: 'var(--accent)' }}>
                      {(group.name || '?')[0]?.toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{group.name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: '#e0f2fe', color: '#075985' }}>
                          {group.messages.length} sent
                        </span>
                        {sentCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: '#ede9fe', color: '#6366f1' }}>
                            {sentCount} emails sent
                          </span>
                        )}
                        {hasAwaiting && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ background: '#fef3c7', color: '#92400e' }}>
                            Awaiting reply
                          </span>
                        )}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>{group.email}</div>
                    </div>
                  </div>
                </div>
                <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {group.messages.slice(0, 5).map((msg) => (
                    <div key={msg.id} className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors"
                      onClick={() => onPreview(msg.id, msg.accountEmail)}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{msg.subject || '(no subject)'}</span>
                          {isAwaitingReply(msg) && (
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#f59e0b' }} />
                          )}
                        </div>
                        <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(msg.snippet || '')}</div>
                      </div>
                      <span className="text-[10px] whitespace-nowrap flex-shrink-0" style={{ color: 'var(--muted)' }}>
                        {new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  ))}
                  {group.messages.length > 5 && (
                    <div className="px-4 py-2 text-xs text-center" style={{ color: 'var(--muted)' }}>
                      + {group.messages.length - 5} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============ SNOOZED TAB ============

function SnoozedTab({ onAction, showToast, onPreview, reloadKey, reportCount }: {
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  onPreview: (messageId: string, accountEmail?: string) => void;
  reloadKey: number;
  reportCount?: (count: number) => void;
}) {
  const [snoozedItems, setSnoozedItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadSnoozed(); }, [reloadKey]);

  async function loadSnoozed() {
    setLoading(true);
    const res = await apiGet('queue');
    if (res.success) {
      const snoozed = (res.data || []).filter((q: any) => q.status === 'snoozed');
      // Sort by snoozed_until (soonest first)
      snoozed.sort((a: any, b: any) => {
        const aTime = a.snoozed_until ? new Date(a.snoozed_until).getTime() : Infinity;
        const bTime = b.snoozed_until ? new Date(b.snoozed_until).getTime() : Infinity;
        return aTime - bTime;
      });
      setSnoozedItems(snoozed);
      reportCount?.(snoozed.length);
    }
    setLoading(false);
  }

  async function reactivate(id: string) {
    const res = await apiPut('queue', { id, status: 'active' });
    if (res.success) {
      setSnoozedItems(prev => prev.filter(q => q.id !== id));
      showToast('Reactivated', 'Moved back to Triage');
      reportCount?.(snoozedItems.length - 1);
    }
  }

  async function dismiss(id: string, messageId: string, accountEmail: string) {
    onAction('markRead', [messageId], undefined, accountEmail);
    const res = await apiPut('queue', { id, status: 'done' });
    if (res.success) {
      setSnoozedItems(prev => prev.filter(q => q.id !== id));
      showToast('Dismissed');
      reportCount?.(snoozedItems.length - 1);
    }
  }

  if (loading) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      <p className="text-sm">Loading snoozed emails...</p>
    </div>
  );

  if (snoozedItems.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No snoozed emails</p>
      <p className="text-sm">Snooze emails from the Triage tab to deal with them later.</p>
    </div>
  );

  const now = new Date();

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold">{snoozedItems.length} snoozed email{snoozedItems.length !== 1 ? 's' : ''}</p>
        <button onClick={loadSnoozed} className="px-3 py-1 text-xs rounded-full border font-medium" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Refresh</button>
      </div>
      <div className="flex flex-col gap-2">
        {snoozedItems.map((q: any) => {
          const snoozeTime = q.snoozed_until ? new Date(q.snoozed_until) : null;
          const isOverdue = snoozeTime && snoozeTime <= now;
          const timeLabel = snoozeTime
            ? snoozeTime.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'Unknown';
          const hoursLeft = snoozeTime ? Math.max(0, Math.round((snoozeTime.getTime() - now.getTime()) / (1000 * 60 * 60))) : 0;

          return (
            <div key={q.id} className="p-4 rounded-xl border" style={{
              background: isOverdue ? '#fef3c7' : 'var(--card)',
              borderColor: isOverdue ? '#fbbf24' : 'var(--border)',
              borderLeftWidth: 4,
              borderLeftColor: isOverdue ? '#f59e0b' : '#8b5cf6',
            }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{q.sender}</span>
                    {q.tier && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold" style={{
                        background: q.tier === 'A' ? '#dcfce7' : q.tier === 'B' ? '#fef3c7' : '#e0f2fe',
                        color: q.tier === 'A' ? '#166534' : q.tier === 'B' ? '#92400e' : '#075985',
                      }}>
                        Tier {q.tier}
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium mt-0.5 cursor-pointer hover:underline" onClick={() => onPreview(q.message_id, q.account_email)}>
                    {q.subject}
                  </div>
                  <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(q.summary || '')}</div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{
                      background: isOverdue ? '#fee2e2' : '#ede9fe',
                      color: isOverdue ? '#dc2626' : '#7c3aed',
                    }}>
                      {isOverdue ? 'Overdue — was due ' : 'Wakes up '}{timeLabel}
                    </span>
                    {!isOverdue && hoursLeft > 0 && (
                      <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                        ({hoursLeft < 24 ? `${hoursLeft}h` : `${Math.round(hoursLeft / 24)}d`} left)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0 items-center">
                  <button onClick={() => onPreview(q.message_id, q.account_email)}
                    className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Preview</button>
                  <button onClick={() => reactivate(q.id)}
                    className="px-2 py-1 text-xs rounded-lg border font-medium" style={{ borderColor: '#8b5cf6', color: '#7c3aed' }}>Wake Up</button>
                  <SnoozeDropdown onSnooze={(hours, label) => {
                    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
                    apiPut('queue', { id: q.id, status: 'snoozed', snoozed_until: until });
                    setSnoozedItems(prev => prev.map(item => item.id === q.id ? { ...item, snoozed_until: until } : item));
                    showToast('Re-snoozed', `Will reappear ${label}`);
                  }} />
                  <button onClick={() => { onAction('archive', [q.message_id], undefined, q.account_email); dismiss(q.id, q.message_id, q.account_email); }}
                    className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                  <button onClick={() => { onAction('trash', [q.message_id], undefined, q.account_email); dismiss(q.id, q.message_id, q.account_email); }}
                    className="px-2 py-1 text-xs rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                  <button onClick={() => dismiss(q.id, q.message_id, q.account_email)}
                    className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Dismiss</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ FOLLOW-UP TAB ============

function FollowUpTab({ accounts, unified, onPreview, showToast, onAction, reportCount }: {
  accounts: ConnectedAccount[];
  unified: boolean;
  onPreview: (messageId: string, accountEmail?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  reportCount?: (count: number) => void;
}) {
  const [starredSent, setStarredSent] = useState<GmailMessage[]>([]);
  const [awaitingReply, setAwaitingReply] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedConvo, setExpandedConvo] = useState<string | null>(null);

  useEffect(() => { loadFollowUps(); }, []);

  // Check if a sent message has gotten a reply by looking at the actual thread
  async function checkThreadForReply(msg: GmailMessage, myEmail: string): Promise<boolean> {
    try {
      const threadRes = await gmailGet('thread', { id: msg.threadId });
      if (!threadRes.success || !threadRes.data?.messages) return false;
      const sentDate = new Date(msg.date);
      // Look for any message in the thread that is:
      // 1. After our sent message
      // 2. NOT from us (i.e., it's a reply from the recipient)
      for (const threadMsg of threadRes.data.messages) {
        const headers = threadMsg.payload?.headers || [];
        const from = (headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '').toLowerCase();
        const msgDate = new Date(headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || 0);
        // Skip our own messages
        if (from.includes(myEmail.toLowerCase())) continue;
        // If this message is after our sent message, they replied
        if (msgDate > sentDate) return true;
      }
      return false;
    } catch {
      return false; // On error, assume no reply (show as awaiting)
    }
  }

  async function loadFollowUps() {
    setLoading(true);
    try {
      const allStarred: GmailMessage[] = [];
      const allAwaiting: GmailMessage[] = [];

      const loadForAccount = async (acctEmail?: string) => {
        const myEmail = acctEmail || _currentAccount;

        // Load starred sent messages (user-flagged)
        const starredRes = await gmailGet('search', { q: 'in:sent is:starred', max: '30' });
        if (starredRes.success && starredRes.data?.messages) {
          for (const msg of starredRes.data.messages) {
            allStarred.push({ ...msg, accountEmail: myEmail });
          }
        }

        // Load recent sent messages to detect actual awaiting replies
        const sentRes = await gmailGet('search', { q: 'in:sent newer_than:7d', max: '30' });
        if (sentRes.success && sentRes.data?.messages) {
          // Only check messages older than 24h (too soon otherwise)
          const candidates = sentRes.data.messages.filter((msg: GmailMessage) => {
            const hoursSince = (Date.now() - new Date(msg.date).getTime()) / (1000 * 60 * 60);
            return hoursSince >= 24;
          });

          // Check threads in parallel (batches of 5 to avoid rate limits)
          for (let i = 0; i < candidates.length; i += 5) {
            const batch = candidates.slice(i, i + 5);
            const results = await Promise.all(
              batch.map(async (msg: GmailMessage) => {
                // Skip if already in starred list
                if (allStarred.find(s => s.id === msg.id)) return null;
                const hasReply = await checkThreadForReply(msg, myEmail);
                if (!hasReply) return { ...msg, accountEmail: myEmail };
                return null;
              })
            );
            for (const r of results) {
              if (r) allAwaiting.push(r);
            }
          }
        }
      };

      if (unified && accounts.length > 1) {
        const savedAccount = _currentAccount;
        for (const acct of accounts) {
          setCurrentAccount(acct.email);
          await loadForAccount(acct.email);
        }
        setCurrentAccount(savedAccount);
      } else {
        await loadForAccount();
      }

      allStarred.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      allAwaiting.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setStarredSent(allStarred);
      setAwaitingReply(allAwaiting);
      reportCount?.(allStarred.length + allAwaiting.length);
    } catch (err) {
      console.error('Failed to load follow-ups:', err);
    } finally {
      setLoading(false);
    }
  }

  // Group messages by normalized subject for conversation view
  function groupByConversation(msgs: GmailMessage[]) {
    const groups: Record<string, { subject: string; messages: GmailMessage[]; recipients: string[] }> = {};
    for (const msg of msgs) {
      const normSubj = normalizeSubject(msg.subject);
      if (!groups[normSubj]) {
        groups[normSubj] = { subject: normSubj, messages: [], recipients: [] };
      }
      groups[normSubj].messages.push(msg);
      const to = (msg as any).to || '';
      const toEmail = extractEmail(to);
      if (toEmail && !groups[normSubj].recipients.includes(toEmail)) {
        groups[normSubj].recipients.push(toEmail);
      }
    }
    return Object.values(groups);
  }

  async function unstarMessage(msgId: string, acctEmail?: string) {
    onAction('unstar', [msgId], undefined, acctEmail || _currentAccount);
    setStarredSent(prev => prev.filter(m => m.id !== msgId));
    showToast('Removed from follow-up');
    reportCount?.((starredSent.length - 1) + awaitingReply.length);
  }

  if (loading) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      <p className="text-sm">Loading follow-ups...</p>
    </div>
  );

  const totalItems = starredSent.length + awaitingReply.length;
  if (totalItems === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No follow-ups needed</p>
      <p className="text-sm">Star a sent email or use the "Follow Up" button in previews to track conversations here.</p>
    </div>
  );

  const starredConversations = groupByConversation(starredSent);
  const awaitingConversations = groupByConversation(awaitingReply);

  return (
    <div>
      {/* Summary */}
      <div className="flex items-center gap-3 mb-4">
        <p className="text-sm font-semibold">{totalItems} conversations to follow up</p>
        {starredSent.length > 0 && (
          <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: '#fef3c7', color: '#92400e' }}>
            {starredSent.length} flagged
          </span>
        )}
        {awaitingReply.length > 0 && (
          <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: '#fee2e2', color: '#991b1b' }}>
            {awaitingReply.length} awaiting reply
          </span>
        )}
        <button onClick={loadFollowUps} className="ml-auto px-3 py-1 text-xs rounded-full border font-medium" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Refresh</button>
      </div>

      {/* Flagged for follow-up (starred sent) */}
      {starredConversations.length > 0 && (
        <div className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#92400e' }}>Flagged by you</div>
          <div className="flex flex-col gap-2">
            {starredConversations.map((convo) => {
              const latest = convo.messages[0];
              const isExpanded = expandedConvo === `s-${convo.subject}`;
              const daysSince = Math.floor((Date.now() - new Date(latest.date).getTime()) / (1000 * 60 * 60 * 24));
              return (
                <div key={`s-${convo.subject}`} className="rounded-xl border overflow-hidden"
                  style={{ background: '#fffbeb', borderColor: '#fbbf24', borderLeftWidth: 4, borderLeftColor: '#f59e0b' }}>
                  <div className="p-4 cursor-pointer" onClick={() => setExpandedConvo(isExpanded ? null : `s-${convo.subject}`)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm">To: {convo.recipients.join(', ')}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ background: '#fef3c7', color: '#92400e' }}>
                            {daysSince === 0 ? 'Today' : daysSince === 1 ? '1 day ago' : `${daysSince} days ago`}
                          </span>
                          {convo.messages.length > 1 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: '#f0fdf4', color: '#166534' }}>
                              {convo.messages.length} messages
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium mt-0.5 truncate">{convo.subject}</div>
                        <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(latest.snippet || '')}</div>
                        {latest.accountEmail && accounts.length > 1 && (
                          <div className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>via {latest.accountEmail}</div>
                        )}
                      </div>
                      <div className="flex gap-2 flex-shrink-0 items-center">
                        <button onClick={(e) => { e.stopPropagation(); onPreview(latest.id, latest.accountEmail); }}
                          className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                          Preview
                        </button>
                        <div onClick={(e) => e.stopPropagation()}>
                          <SnoozeDropdown onSnooze={(hours, label) => {
                            const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
                            apiPost('queue', { message_id: latest.id, account_email: latest.accountEmail || _currentAccount, status: 'snoozed', snoozed_until: until, sender: convo.recipients.join(', '), subject: convo.subject });
                            showToast('Snoozed', `Will reappear ${label}`);
                          }} />
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); onAction('archive', [latest.id], undefined, latest.accountEmail); showToast('Archived'); }}
                          className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                          Archive
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onAction('trash', [latest.id], undefined, latest.accountEmail); showToast('Trashed'); }}
                          className="px-2 py-1 text-xs rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>
                          Trash
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); unstarMessage(latest.id, latest.accountEmail); }}
                          className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: '#fbbf24', color: '#92400e' }}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                  {isExpanded && convo.messages.length > 1 && (
                    <div className="border-t divide-y" style={{ borderColor: '#fde68a' }}>
                      {convo.messages.map((msg, idx) => (
                        <div key={msg.id} className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-amber-50"
                          onClick={() => onPreview(msg.id, msg.accountEmail)}>
                          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0" style={{ background: '#f59e0b' }}>
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium">To: {(msg as any).to || 'Unknown'}</span>
                            <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(msg.snippet || '')}</div>
                          </div>
                          <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                            {new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Awaiting reply (auto-detected) */}
      {awaitingConversations.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#991b1b' }}>Awaiting reply (auto-detected)</div>
          <div className="flex flex-col gap-2">
            {awaitingConversations.map((convo) => {
              const latest = convo.messages[0];
              const daysSince = Math.floor((Date.now() - new Date(latest.date).getTime()) / (1000 * 60 * 60 * 24));
              const urgencyColor = daysSince > 5 ? '#dc2626' : daysSince > 3 ? '#f59e0b' : '#64748b';
              return (
                <div key={`a-${convo.subject}`} className="p-4 rounded-xl border cursor-pointer hover:shadow-sm transition-shadow"
                  onClick={() => onPreview(latest.id, latest.accountEmail)}
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', borderLeftWidth: 3, borderLeftColor: urgencyColor }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">To: {convo.recipients.join(', ')}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ background: daysSince > 5 ? '#fee2e2' : daysSince > 3 ? '#fef3c7' : '#f1f5f9', color: urgencyColor }}>
                          {daysSince === 0 ? 'Today' : daysSince === 1 ? '1 day' : `${daysSince} days`} — no reply
                        </span>
                        {convo.messages.length > 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: '#f0fdf4', color: '#166534' }}>
                            {convo.messages.length} messages
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-medium mt-0.5 truncate">{convo.subject}</div>
                      <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{decodeHtmlEntities(latest.snippet || '')}</div>
                      {latest.accountEmail && accounts.length > 1 && (
                        <div className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>via {latest.accountEmail}</div>
                      )}
                    </div>
                    <div className="flex gap-2 flex-shrink-0 items-center">
                      <button onClick={(e) => { e.stopPropagation(); onPreview(latest.id, latest.accountEmail); }}
                        className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                        Preview
                      </button>
                      <div onClick={(e) => e.stopPropagation()}>
                        <SnoozeDropdown onSnooze={(hours, label) => {
                          const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
                          apiPost('queue', { message_id: latest.id, account_email: latest.accountEmail || _currentAccount, status: 'snoozed', snoozed_until: until, sender: convo.recipients.join(', '), subject: convo.subject });
                          showToast('Snoozed', `Will reappear ${label}`);
                        }} />
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); onAction('archive', [latest.id], undefined, latest.accountEmail); showToast('Archived'); }}
                        className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                        Archive
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); onAction('trash', [latest.id], undefined, latest.accountEmail); showToast('Trashed'); }}
                        className="px-2 py-1 text-xs rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>
                        Trash
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ PRIORITIES TAB ============

// Detect potential duplicate senders by name similarity
function findSenderDuplicates(senders: any[]): { primary: any; secondary: any; reason: string }[] {
  const suggestions: { primary: any; secondary: any; reason: string }[] = [];
  const seen = new Set<string>();

  // Group by normalized first name
  const nameGroups: Record<string, any[]> = {};
  for (const s of senders) {
    const name = (s.display_name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const firstName = name.split(/\s+/)[0];
    if (!firstName || firstName.length < 3) continue;
    if (!nameGroups[firstName]) nameGroups[firstName] = [];
    nameGroups[firstName].push(s);
  }

  // Check groups with 2+ senders for likely duplicates
  for (const [, group] of Object.entries(nameGroups)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const key = [a.sender_email, b.sender_email].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        // Check if same domain or same last name
        const aDomain = a.sender_email.split('@')[1]?.toLowerCase();
        const bDomain = b.sender_email.split('@')[1]?.toLowerCase();
        const aName = (a.display_name || '').toLowerCase().trim();
        const bName = (b.display_name || '').toLowerCase().trim();
        const aLast = aName.split(/\s+/).slice(1).join(' ');
        const bLast = bName.split(/\s+/).slice(1).join(' ');

        let reason = '';
        if (aLast && bLast && aLast === bLast) {
          reason = `Same name "${a.display_name}"`;
        } else if (aDomain === bDomain && aName === bName) {
          reason = `Same name, same domain`;
        } else if (aLast && bLast && (aLast.includes(bLast) || bLast.includes(aLast))) {
          reason = `Similar name "${a.display_name}" / "${b.display_name}"`;
        }

        if (reason) {
          // Primary = the one with more replies
          const [primary, secondary] = (a.reply_count || 0) >= (b.reply_count || 0) ? [a, b] : [b, a];
          suggestions.push({ primary, secondary, reason });
        }
      }
    }
  }
  return suggestions;
}

function PrioritiesTab({ onScanSent, scanning, showToast }: {
  onScanSent: () => void; scanning: boolean;
  showToast: (title: string, subtitle?: string) => void;
}) {
  const [senders, setSenders] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [addEmail, setAddEmail] = useState('');
  const [addName, setAddName] = useState('');
  const [addTier, setAddTier] = useState('A');
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterTier, setFilterTier] = useState<string>('all');
  const [expandedSender, setExpandedSender] = useState<string | null>(null);
  const [senderEmails, setSenderEmails] = useState<any[]>([]);
  const [senderEmailsLoading, setSenderEmailsLoading] = useState(false);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadSenderEmails(senderEmail: string) {
    if (expandedSender === senderEmail) {
      setExpandedSender(null);
      return;
    }
    setExpandedSender(senderEmail);
    setSenderEmails([]);
    setSenderEmailsLoading(true);
    try {
      const res = await gmailGet('search', { q: `from:${senderEmail}`, max: '4' });
      if (res.success && res.data?.messages) {
        setSenderEmails(res.data.messages);
      }
    } catch (e) {
      console.error('Failed to load sender emails:', e);
    }
    setSenderEmailsLoading(false);
  }

  async function loadData() {
    setLoading(true);
    const [s, r] = await Promise.all([apiGet('senders'), apiGet('rules')]);
    if (s.success) setSenders(s.data);
    if (r.success) setRules(r.data);
    setLoading(false);
  }

  async function changeTier(email: string, newTier: string) {
    const res = await apiPut('senders', { sender_email: email, tier: newTier });
    if (res.success) {
      setSenders(prev => prev.map(s => s.sender_email === email ? { ...s, tier: newTier } : s));
      showToast(`${email} → Tier ${newTier}`);
    } else {
      showToast('Error', res.error);
    }
  }

  async function removeSender(email: string) {
    const res = await apiDelete('senders', { sender_email: email });
    if (res.success) {
      setSenders(prev => prev.filter(s => s.sender_email !== email));
      showToast('Removed', email);
    } else {
      showToast('Error', res.error);
    }
  }

  async function addSender() {
    if (!addEmail.trim()) return;
    const res = await apiPost('senders', {
      senders: [{
        sender_email: addEmail.trim().toLowerCase(),
        display_name: addName.trim() || addEmail.trim(),
        reply_count: 0,
        tier: addTier,
      }],
    });
    if (res.success) {
      showToast('Added', `${addEmail} as Tier ${addTier}`);
      setAddEmail('');
      setAddName('');
      setShowAddForm(false);
      loadData();
    } else {
      showToast('Error', res.error);
    }
  }

  async function mergeSenders(primaryEmail: string, secondaryEmail: string) {
    setMerging(`${primaryEmail}|${secondaryEmail}`);
    try {
      const res = await apiPut('senders', { action: 'merge', primary_email: primaryEmail, secondary_email: secondaryEmail });
      if (res.success) {
        showToast('Senders merged', `${secondaryEmail} → ${primaryEmail}`);
        loadData();
      } else {
        showToast('Error', res.error);
      }
    } catch (e) {
      showToast('Error', String(e));
    }
    setMerging(null);
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

  const tierColors: Record<string, string> = { A: '#dcfce7', B: '#fef3c7', C: '#e0f2fe', D: '#f1f5f9' };
  const tierText: Record<string, string> = { A: '#166534', B: '#92400e', C: '#075985', D: '#475569' };
  const tiers = ['A', 'B', 'C', 'D'];
  const filteredSenders = filterTier === 'all' ? senders : senders.filter(s => s.tier === filterTier);

  return (
    <div className="flex flex-col gap-6">
      {/* Sender Priority Table */}
      <div className="rounded-xl border p-5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold">Sender Priorities</h3>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{senders.length} senders ranked by reply frequency</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowAddForm(!showAddForm)}
              className="px-4 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              {showAddForm ? 'Cancel' : '+ Add Sender'}
            </button>
            <button onClick={onScanSent} disabled={scanning} className="px-4 py-2 text-xs font-medium rounded-lg text-white" style={{ background: scanning ? 'var(--muted)' : 'var(--accent)' }}>
              {scanning ? 'Scanning...' : 'Scan Sent Mail'}
            </button>
          </div>
        </div>

        {/* Add sender form */}
        {showAddForm && (
          <div className="mb-4 p-4 rounded-lg border" style={{ background: '#f8fafc', borderColor: 'var(--accent)' }}>
            <div className="flex gap-2 flex-wrap items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs font-medium block mb-1">Email</label>
                <input type="email" value={addEmail} onChange={e => setAddEmail(e.target.value)} placeholder="person@example.com"
                  className="w-full px-3 py-2 text-sm rounded-lg border" style={{ borderColor: 'var(--border)' }} />
              </div>
              <div className="flex-1 min-w-[150px]">
                <label className="text-xs font-medium block mb-1">Name (optional)</label>
                <input type="text" value={addName} onChange={e => setAddName(e.target.value)} placeholder="John Smith"
                  className="w-full px-3 py-2 text-sm rounded-lg border" style={{ borderColor: 'var(--border)' }} />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Tier</label>
                <select value={addTier} onChange={e => setAddTier(e.target.value)}
                  className="px-3 py-2 text-sm rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                  {tiers.map(t => <option key={t} value={t}>Tier {t}</option>)}
                </select>
              </div>
              <button onClick={addSender} className="px-4 py-2 text-sm font-medium rounded-lg text-white" style={{ background: 'var(--accent)' }}>Add</button>
            </div>
          </div>
        )}

        {/* Filter by tier */}
        <div className="flex gap-2 mb-3">
          <button onClick={() => setFilterTier('all')}
            className="px-3 py-1 text-xs rounded-full border font-medium"
            style={{ background: filterTier === 'all' ? 'var(--accent)' : 'transparent', color: filterTier === 'all' ? 'white' : 'var(--muted)', borderColor: 'var(--border)' }}>
            All ({senders.length})
          </button>
          {tiers.map(t => {
            const count = senders.filter(s => s.tier === t).length;
            return (
              <button key={t} onClick={() => setFilterTier(t)}
                className="px-3 py-1 text-xs rounded-full border font-medium"
                style={{ background: filterTier === t ? tierColors[t] : 'transparent', color: filterTier === t ? tierText[t] : 'var(--muted)', borderColor: 'var(--border)' }}>
                {t} ({count})
              </button>
            );
          })}
        </div>

        {/* Sender linking suggestions */}
        {(() => {
          const suggestions = findSenderDuplicates(senders).filter(s => {
            const key = [s.primary.sender_email, s.secondary.sender_email].sort().join('|');
            return !dismissedSuggestions.has(key);
          });
          if (suggestions.length === 0) return null;
          return (
            <div className="mb-4 rounded-xl border p-4" style={{ background: '#fefce8', borderColor: '#fbbf24' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold" style={{ color: '#92400e' }}>Possible duplicate senders detected</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#fef3c7', color: '#92400e' }}>
                  {suggestions.length} suggestion{suggestions.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {suggestions.slice(0, 5).map((s) => {
                  const key = [s.primary.sender_email, s.secondary.sender_email].sort().join('|');
                  const isMerging = merging === key;
                  return (
                    <div key={key} className="flex items-center justify-between p-3 rounded-lg border" style={{ background: 'white', borderColor: '#fde68a' }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs mb-1" style={{ color: '#92400e' }}>{s.reason}</div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium">{s.primary.display_name}</span>
                          <span className="text-xs" style={{ color: 'var(--muted)' }}>{s.primary.sender_email} ({s.primary.reply_count})</span>
                          <span style={{ color: 'var(--muted)' }}>&amp;</span>
                          <span className="font-medium">{s.secondary.display_name}</span>
                          <span className="text-xs" style={{ color: 'var(--muted)' }}>{s.secondary.sender_email} ({s.secondary.reply_count})</span>
                        </div>
                      </div>
                      <div className="flex gap-2 flex-shrink-0 ml-3">
                        <button onClick={() => mergeSenders(s.primary.sender_email, s.secondary.sender_email)}
                          disabled={!!isMerging}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg text-white" style={{ background: isMerging ? 'var(--muted)' : '#16a34a' }}>
                          {isMerging ? 'Merging...' : 'Merge'}
                        </button>
                        <button onClick={() => setDismissedSuggestions(prev => new Set([...prev, key]))}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {filteredSenders.length === 0 ? (
          <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
            {senders.length === 0 ? 'No sender data yet. Click "Scan Sent Mail" to learn who you reply to most.' : 'No senders in this tier.'}
          </p>
        ) : (
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table className="w-full text-sm">
              <thead><tr className="text-xs uppercase" style={{ color: 'var(--muted)' }}>
                <th className="text-left p-2">Sender</th><th className="p-2 text-center">Emails Sent</th><th className="p-2">Tier</th><th className="p-2"></th>
              </tr></thead>
              <tbody>
                {filteredSenders.slice(0, 100).map((s: any) => {
                  const isExpanded = expandedSender === s.sender_email;
                  return (
                    <React.Fragment key={s.sender_email}>
                      <tr className="border-t cursor-pointer hover:bg-gray-50" style={{ borderColor: 'var(--border)' }}>
                        <td className="p-2" onClick={() => loadSenderEmails(s.sender_email)}>
                          <div className="flex items-center gap-1">
                            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{isExpanded ? '▼' : '▶'}</span>
                            <div>
                              <div className="font-medium text-sm">{s.display_name}</div>
                              <div className="text-xs" style={{ color: 'var(--muted)' }}>{s.sender_email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="p-2 text-center font-semibold">{s.reply_count}</td>
                        <td className="p-2">
                          <div className="flex gap-1">
                            {tiers.map(t => (
                              <button key={t} onClick={() => changeTier(s.sender_email, t)}
                                className="text-[10px] font-bold px-2 py-0.5 rounded-full transition-all"
                                style={{
                                  background: s.tier === t ? tierColors[t] : 'transparent',
                                  color: s.tier === t ? tierText[t] : 'var(--muted)',
                                  border: `1px solid ${s.tier === t ? tierText[t] + '40' : 'var(--border)'}`,
                                }}>
                                {t}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="p-2">
                          <button onClick={() => removeSender(s.sender_email)} className="text-xs px-2 py-0.5 rounded border text-red-400 hover:text-red-600" style={{ borderColor: 'var(--border)' }}>✕</button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr><td colSpan={4} className="p-0">
                          <div className="px-4 py-3" style={{ background: '#f8fafc', borderBottom: '1px solid var(--border)' }}>
                            {senderEmailsLoading ? (
                              <div className="text-xs py-3 text-center" style={{ color: 'var(--muted)' }}>Loading recent emails...</div>
                            ) : senderEmails.length === 0 ? (
                              <div className="text-xs py-3 text-center" style={{ color: 'var(--muted)' }}>No recent emails found from this sender</div>
                            ) : (
                              <div className="flex flex-col gap-2">
                                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Last {senderEmails.length} emails</div>
                                {senderEmails.map((msg: any) => (
                                  <div key={msg.id} className="flex items-start gap-3 p-2.5 rounded-lg border" style={{ background: 'white', borderColor: 'var(--border)' }}>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium truncate">{msg.subject}</div>
                                      <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                        {decodeHtmlEntities(msg.snippet)}
                                      </div>
                                    </div>
                                    <div className="text-[10px] flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                                      {new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
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

function AccountsTab({ currentAccount, accounts, onSwitch, onRefresh, showToast, onRunTriage, onScanSent, triageLoading, bgTaskLabel }: {
  currentAccount: string;
  accounts: ConnectedAccount[];
  onSwitch: (email: string) => void;
  onRefresh: () => void;
  showToast: (title: string, subtitle?: string) => void;
  onRunTriage: () => void;
  onScanSent: () => void;
  triageLoading: boolean;
  bgTaskLabel: string | null;
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

      {/* Manual Tools */}
      <div className="rounded-xl border p-6" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <h3 className="font-semibold mb-2">Manual Tools</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>Triage runs automatically every 2 minutes. Use these to run manually.</p>
        <div className="flex gap-3 flex-wrap">
          <button onClick={onRunTriage} disabled={triageLoading}
            className="px-4 py-2 text-sm font-semibold rounded-lg text-white"
            style={{ background: triageLoading ? 'var(--muted)' : 'var(--urgent)' }}>
            {bgTaskLabel?.includes('Triaging') ? 'Triaging...' : 'Triage Inbox'}
          </button>
          <button onClick={onScanSent} disabled={triageLoading}
            className="px-4 py-2 text-sm font-semibold rounded-lg text-white"
            style={{ background: triageLoading ? 'var(--muted)' : 'var(--accent)' }}>
            {bgTaskLabel?.includes('Scanning') ? 'Scanning...' : 'Scan Sent Mail'}
          </button>
        </div>
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
        <a href="/api/emailHelperV2/auth/logout" className="text-sm underline" style={{ color: 'var(--muted)' }}>Sign out of all accounts</a>
      </div>
    </div>
  );
}
