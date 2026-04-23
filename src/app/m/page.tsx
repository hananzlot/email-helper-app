'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { GmailMessage } from '@/types';

type Tab = 'important' | 'sent' | 'accounts';

type ConnectedAccount = {
  email: string;
  is_primary: boolean;
  is_active_inbox: boolean;
  created_at: string;
};

type QueueItem = {
  id: string;
  message_id: string;
  thread_id: string | null;
  account_email: string;
  sender: string;
  sender_email: string;
  subject: string;
  summary: string;
  status: 'active' | 'snoozed' | 'done' | 'later';
  priority: string;
  priority_score: number;
  tier: string | null;
  reply_count: number;
  snoozed_until: string | null;
  received: string;
  gmail_url: string | null;
};

type ApiRes<T> = { success: boolean; data?: T; error?: string };

type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

type ComposeState = {
  mode: ComposeMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  threadId?: string;
  quotedHtml?: string;
  showCc: boolean;
  showBcc: boolean;
  account: string;
};

type ThreadHeader = { name: string; value: string };
type RawThreadMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: { headers?: ThreadHeader[] };
};

type RowMessage = {
  id: string;
  threadId: string;
  account: string;
  sender: string;
  senderEmail: string;
  subject: string;
  preview: string;
  date: string;
  isUnread: boolean;
  tier: string | null;
  // All message_ids that belong to this row — usually 1, but when we group a
  // thread's queue items together this holds every queued message in the thread
  // so archive/delete apply to the whole thread at once.
  messageIds: string[];
  threadCount: number;
};

async function api<T = unknown>(
  path: string,
  opts: { account?: string; method?: string; body?: unknown } = {}
): Promise<T> {
  const url = new URL(`/api/emailHelperV2/${path}`, window.location.origin);
  if (opts.account) url.searchParams.set('account', opts.account);
  const init: RequestInit = {
    credentials: 'include',
    method: opts.method || 'GET',
  };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url.toString(), init);
  let json: ApiRes<T>;
  try {
    json = (await res.json()) as ApiRes<T>;
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!json.success) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data as T;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainToHtml(text: string): string {
  return htmlEscape(text).replace(/\r?\n/g, '<br>');
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yr = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], yr ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function senderInitial(name: string): string {
  const cleaned = (name || '').trim().replace(/^"|"$/g, '');
  if (!cleaned) return '?';
  const ch = cleaned[0];
  return /[a-zA-Z0-9]/.test(ch) ? ch.toUpperCase() : '?';
}

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 55%)`;
}

function cleanName(raw: string): string {
  return (raw || '').trim().replace(/^"|"$/g, '');
}

function fallbackName(name: string, email: string): string {
  const c = cleanName(name);
  if (c && c.toLowerCase() !== (email || '').toLowerCase()) return c;
  const local = (email || '').split('@')[0];
  return local || email || '(unknown)';
}

function tierBadge(tier: string | null | undefined): string {
  switch (tier) {
    case 'A': return '#10b981';
    case 'B': return '#f59e0b';
    case 'C': return '#3b82f6';
    default: return '#9ca3af';
  }
}

function pickHeader(headers: ThreadHeader[] | undefined, name: string): string {
  if (!headers) return '';
  const lc = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === lc) return h.value || '';
  return '';
}

function parseAddress(s: string): { name: string; email: string } {
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: s.trim() };
}

function buildReplySubject(mode: ComposeMode, original: string): string {
  const stripped = (original || '').replace(/^(Re:|Fwd:|Fw:)\s*/i, '').trim();
  if (mode === 'forward') return `Fwd: ${stripped}`;
  if (mode === 'reply' || mode === 'replyAll') return `Re: ${stripped}`;
  return original || '';
}

function buildQuoted(orig: GmailMessage): string {
  const fromLine = `On ${orig.date}, ${cleanName(orig.sender) || orig.senderEmail} &lt;${htmlEscape(orig.senderEmail)}&gt; wrote:`;
  const body = orig.bodyHtml || (orig.body ? plainToHtml(orig.body) : '');
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:10px;color:#555;">${fromLine}<br><br>${body}</div>`;
}

function PullToRefresh({
  onRefresh,
  children,
  label = 'Refreshing...',
  scrollRef,
}: {
  onRefresh: () => Promise<void> | void;
  children: React.ReactNode;
  label?: string;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const ref = scrollRef || localRef;
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = (e: React.TouchEvent) => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollTop > 0) {
      startY.current = null;
      return;
    }
    startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current === null || refreshing) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta > 0) {
      const damped = Math.min(110, delta * 0.55);
      setPull(damped);
    }
  };
  const onTouchEnd = async () => {
    const dist = pull;
    setPull(0);
    startY.current = null;
    if (dist > 60 && !refreshing) {
      setRefreshing(true);
      try { await onRefresh(); } finally { setRefreshing(false); }
    }
  };

  return (
    <div
      ref={ref}
      className="ptr-scroll"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div
        className="ptr-indicator"
        style={{
          height: refreshing ? 44 : pull,
          opacity: refreshing ? 1 : Math.min(1, pull / 60),
        }}
      >
        <span className={refreshing ? 'spin' : ''}>⟳</span>
        <span style={{ marginLeft: 8 }}>{refreshing ? label : pull > 60 ? 'Release to refresh' : 'Pull to refresh'}</span>
      </div>
      {children}
    </div>
  );
}

function SwipeableRow({
  onArchive,
  onDelete,
  onTap,
  children,
}: {
  onArchive: () => void;
  onDelete: () => void;
  onTap: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const moved = useRef(false);
  const decided = useRef<'h' | 'v' | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    moved.current = false;
    decided.current = null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null || startY.current === null) return;
    const dxNow = e.touches[0].clientX - startX.current;
    const dyNow = e.touches[0].clientY - startY.current;
    if (decided.current === null) {
      if (Math.abs(dxNow) > 8 || Math.abs(dyNow) > 8) {
        decided.current = Math.abs(dxNow) > Math.abs(dyNow) ? 'h' : 'v';
      }
    }
    if (decided.current === 'h') {
      moved.current = true;
      setDx(Math.max(-220, Math.min(60, dxNow)));
    }
  };
  const onTouchEnd = () => {
    const finalDx = dx;
    startX.current = null;
    startY.current = null;
    if (decided.current === 'h') {
      if (finalDx <= -160) {
        setDx(-9999);
        setTimeout(onDelete, 180);
        return;
      }
      if (finalDx <= -70) {
        setDx(-9999);
        setTimeout(onArchive, 180);
        return;
      }
      setDx(0);
    } else if (!moved.current) {
      onTap();
    }
    decided.current = null;
  };

  const showDelete = dx <= -160;
  const offscreen = rowRef.current?.offsetWidth || 500;
  const xPx = dx === -9999 ? -offscreen : dx;

  return (
    <div className="row-outer" ref={rowRef}>
      <div className={`row-actions ${showDelete ? 'is-delete' : ''}`}>
        <span className="row-action-label">{showDelete ? 'Delete' : 'Archive'}</span>
      </div>
      <div
        className="row-inner"
        style={{
          transform: `translateX(${xPx}px)`,
          transition: startX.current === null ? 'transform 0.18s ease-out' : 'none',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => { if (!moved.current && Math.abs(dx) < 4) onTap(); }}
      >
        {children}
      </div>
    </div>
  );
}

function MessageRow({ row, onTap, onArchive, onDelete }: {
  row: RowMessage;
  onTap: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const name = fallbackName(row.sender, row.senderEmail);
  const emailLocal = (row.senderEmail || '').split('@')[0];
  const initial = senderInitial(emailLocal || name);
  const color = avatarColor(row.senderEmail || name);
  return (
    <SwipeableRow onTap={onTap} onArchive={onArchive} onDelete={onDelete}>
      <div className={`mrow ${row.isUnread ? 'unread' : ''}`}>
        <div className="mrow-avatar" style={{ background: color }}>{initial}</div>
        <div className="mrow-body">
          <div className="mrow-top">
            <span className="mrow-sender">{name}</span>
            <span className="mrow-date">{row.date}</span>
          </div>
          <div className="mrow-subj">
            {row.tier && <span className="mrow-tier" style={{ background: tierBadge(row.tier) }}>{row.tier}</span>}
            {row.subject || '(no subject)'}
            {row.threadCount > 1 && <span className="mrow-count">{row.threadCount}</span>}
          </div>
          <div className="mrow-preview">{row.preview}</div>
        </div>
      </div>
    </SwipeableRow>
  );
}

function ThreadView({
  threadId,
  account,
  initialSubject,
  onClose,
  onAction,
  onCompose,
}: {
  threadId: string;
  account: string;
  initialSubject: string;
  onClose: () => void;
  onAction: (kind: 'archive' | 'delete' | 'markUnread', messageIds: string[]) => Promise<void>;
  onCompose: (mode: 'reply' | 'replyAll' | 'forward', orig: GmailMessage) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const thread = await api<{ messages?: RawThreadMessage[] }>(
          `gmail?action=thread&id=${encodeURIComponent(threadId)}`,
          { account }
        );
        const ids = (thread.messages || []).map((m) => m.id);
        const msgs = await Promise.all(
          ids.map((id) =>
            api<GmailMessage>(`gmail?action=message&format=full&id=${encodeURIComponent(id)}`, { account })
              .catch(() => null)
          )
        );
        if (!cancelled) setMessages(msgs.filter((m): m is GmailMessage => !!m));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load thread');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [threadId, account]);

  useEffect(() => {
    if (!messages.length) return;
    const unreadIds = messages.filter(m => m.isUnread).map(m => m.id);
    if (!unreadIds.length) return;
    api('gmail', { account, method: 'POST', body: { action: 'markRead', messageIds: unreadIds } }).catch(() => {});
  }, [messages, account]);

  const last = messages[messages.length - 1];
  const subject = messages[0]?.subject || initialSubject;

  const doAction = async (kind: 'archive' | 'delete' | 'markUnread') => {
    if (!messages.length || busy) return;
    setBusy(true);
    try {
      const ids = messages.map(m => m.id);
      await onAction(kind, ids);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay">
      <div className="overlay-bar">
        <button className="iconbtn" onClick={onClose} aria-label="Back">‹</button>
        <div className="overlay-title">{subject || '(no subject)'}</div>
        <div className="overlay-bar-spacer" />
        <button className="iconbtn" onClick={() => doAction('markUnread')} disabled={busy} aria-label="Mark unread">⊙</button>
        <button className="iconbtn" onClick={() => doAction('archive')} disabled={busy} aria-label="Archive">↧</button>
        <button className="iconbtn danger" onClick={() => doAction('delete')} disabled={busy} aria-label="Delete">✕</button>
      </div>
      <div className="overlay-body">
        {loading && <div className="state">Loading thread…</div>}
        {error && <div className="state error">{error}</div>}
        {!loading && !error && messages.map((m, idx) => (
          <ThreadMessage key={m.id} msg={m} expanded={idx === messages.length - 1} />
        ))}
      </div>
      {!loading && !error && last && (
        <div className="thread-actions">
          <button className="primary" onClick={() => onCompose('reply', last)}>Reply</button>
          <button onClick={() => onCompose('replyAll', last)}>Reply all</button>
          <button onClick={() => onCompose('forward', last)}>Forward</button>
        </div>
      )}
    </div>
  );
}

function ThreadMessage({ msg, expanded: initialExpanded }: { msg: GmailMessage; expanded: boolean }) {
  const [open, setOpen] = useState(initialExpanded);
  const name = fallbackName(msg.sender, msg.senderEmail);
  const html = msg.bodyHtml || (msg.body ? plainToHtml(msg.body) : msg.snippet || '');
  return (
    <div className="tmsg">
      <div className="tmsg-head" onClick={() => setOpen(o => !o)}>
        <div className="tmsg-avatar" style={{ background: avatarColor(msg.senderEmail || name) }}>
          {senderInitial(name)}
        </div>
        <div className="tmsg-meta">
          <div className="tmsg-from"><strong>{name}</strong> <span className="muted">&lt;{msg.senderEmail}&gt;</span></div>
          <div className="muted small">to {msg.to || 'me'}</div>
        </div>
        <div className="muted small">{formatDate(msg.date)}</div>
      </div>
      {open ? (
        <div className="tmsg-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="tmsg-snippet">{msg.snippet}</div>
      )}
    </div>
  );
}

function ComposeSheet({
  state,
  onChange,
  onClose,
  onSent,
  accounts,
}: {
  state: ComposeState;
  onChange: (s: ComposeState) => void;
  onClose: () => void;
  onSent: () => void;
  accounts: ConnectedAccount[];
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (sending) return;
    if (!state.to.trim()) { setError('Recipient required'); return; }
    setSending(true);
    setError(null);
    try {
      const html = plainToHtml(state.body) + (state.quotedHtml || '');
      await api('gmail', {
        account: state.account,
        method: 'POST',
        body: {
          action: 'send',
          to: state.to.trim(),
          subject: state.subject,
          body: html,
          cc: state.cc.trim() || undefined,
          bcc: state.bcc.trim() || undefined,
          inReplyTo: state.inReplyTo,
          threadId: state.threadId,
        },
      });
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="overlay compose">
      <div className="overlay-bar">
        <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        <div className="overlay-title">
          {state.mode === 'new' ? 'New message' : state.mode === 'forward' ? 'Forward' : 'Reply'}
        </div>
        <div className="overlay-bar-spacer" />
        <button className="primary small" onClick={send} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className="overlay-body compose-body">
        {accounts.length > 1 && (
          <div className="compose-row">
            <label>From</label>
            <select
              value={state.account}
              onChange={(e) => onChange({ ...state, account: e.target.value })}
            >
              {accounts.map(a => <option key={a.email} value={a.email}>{a.email}</option>)}
            </select>
          </div>
        )}
        <div className="compose-row">
          <label>To</label>
          <input
            type="email"
            value={state.to}
            onChange={(e) => onChange({ ...state, to: e.target.value })}
            placeholder="recipient@example.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="compose-toggles">
            {!state.showCc && <button onClick={() => onChange({ ...state, showCc: true })}>Cc</button>}
            {!state.showBcc && <button onClick={() => onChange({ ...state, showBcc: true })}>Bcc</button>}
          </div>
        </div>
        {state.showCc && (
          <div className="compose-row">
            <label>Cc</label>
            <input value={state.cc} onChange={(e) => onChange({ ...state, cc: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
        )}
        {state.showBcc && (
          <div className="compose-row">
            <label>Bcc</label>
            <input value={state.bcc} onChange={(e) => onChange({ ...state, bcc: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
        )}
        <div className="compose-row">
          <label>Subject</label>
          <input value={state.subject} onChange={(e) => onChange({ ...state, subject: e.target.value })} />
        </div>
        <textarea
          className="compose-body-text"
          value={state.body}
          onChange={(e) => onChange({ ...state, body: e.target.value })}
          placeholder="Write your message…"
        />
        {state.quotedHtml && (
          <div className="compose-quoted" dangerouslySetInnerHTML={{ __html: state.quotedHtml }} />
        )}
        {error && <div className="state error">{error}</div>}
      </div>
    </div>
  );
}

export default function MobilePage() {
  const [tab, setTab] = useState<Tab>('important');
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [activeAccount, setActiveAccount] = useState<string>('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [important, setImportant] = useState<QueueItem[]>([]);
  const [importantLoading, setImportantLoading] = useState(true);

  const [sent, setSent] = useState<GmailMessage[]>([]);
  const [sentLoading, setSentLoading] = useState(true);
  const [sentToken, setSentToken] = useState<string | null>(null);
  const [sentLoadingMore, setSentLoadingMore] = useState(false);

  const [openThread, setOpenThread] = useState<{ id: string; account: string; subject: string } | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await api<ConnectedAccount[]>('accounts');
      setAccounts(data);
      setAccountsLoaded(true);
      setActiveAccount(prev => {
        if (prev && data.find(a => a.email === prev)) return prev;
        const primary = data.find(a => a.is_primary) || data[0];
        return primary?.email || '';
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load accounts';
      if (msg.toLowerCase().includes('not authenticated')) setAuthError(msg);
      setAccountsLoaded(true);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const loadImportant = useCallback(async () => {
    setImportantLoading(true);
    try {
      const data = await api<QueueItem[]>('queue');
      const filtered = (data || []).filter(it =>
        it.status === 'active' && (it.tier === 'A' || it.tier === 'B' || it.tier === 'C')
      );
      setImportant(filtered);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load queue';
      if (msg.toLowerCase().includes('not authenticated')) setAuthError(msg);
    } finally {
      setImportantLoading(false);
    }
  }, []);

  const loadSent = useCallback(async (account: string, append: boolean, pageToken?: string) => {
    if (!account) return;
    if (append) setSentLoadingMore(true); else setSentLoading(true);
    try {
      let path = `gmail?action=inbox&q=${encodeURIComponent('in:sent')}&max=50`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await api<{ messages: GmailMessage[]; nextPageToken?: string | null }>(path, { account });
      const tagged = (data.messages || []).map(m => ({ ...m, accountEmail: account }));
      setSent(prev => append ? [...prev, ...tagged] : tagged);
      setSentToken(data.nextPageToken || null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load sent';
      if (msg.toLowerCase().includes('not authenticated')) setAuthError(msg);
      else showToast(msg);
    } finally {
      if (append) setSentLoadingMore(false); else setSentLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!accountsLoaded || !activeAccount) return;
    loadImportant();
    loadSent(activeAccount, false);
  }, [accountsLoaded, activeAccount, loadImportant, loadSent]);

  // Group queue items into one row per thread. The latest message (by received
  // date) represents the thread; rows sort newest-first by that date.
  const importantRows: RowMessage[] = useMemo(() => {
    const byThread = new Map<string, { latest: QueueItem; all: QueueItem[] }>();
    for (const it of important) {
      const key = `${it.account_email}|${it.thread_id || it.message_id}`;
      const existing = byThread.get(key);
      if (!existing) {
        byThread.set(key, { latest: it, all: [it] });
      } else {
        existing.all.push(it);
        const prev = Date.parse(existing.latest.received) || 0;
        const cur = Date.parse(it.received) || 0;
        if (cur > prev) existing.latest = it;
      }
    }
    const rows: (RowMessage & { _ts: number })[] = [];
    for (const { latest, all } of byThread.values()) {
      rows.push({
        id: latest.message_id,
        threadId: latest.thread_id || latest.message_id,
        account: latest.account_email,
        sender: latest.sender,
        senderEmail: latest.sender_email,
        subject: latest.subject,
        preview: latest.summary || '',
        date: formatDate(latest.received),
        isUnread: true,
        tier: latest.tier,
        messageIds: all.map(q => q.message_id),
        threadCount: all.length,
        _ts: Date.parse(latest.received) || 0,
      });
    }
    rows.sort((a, b) => b._ts - a._ts);
    return rows.map(({ _ts, ...r }) => r);
  }, [important]);

  const sentRows: RowMessage[] = useMemo(() =>
    sent.map(m => {
      const firstTo = parseAddress((m.to || '').split(',')[0] || '');
      const display = firstTo.name || firstTo.email || m.to || '(no recipient)';
      return {
        id: m.id,
        threadId: m.threadId,
        account: m.accountEmail || activeAccount,
        sender: `To: ${display}`,
        senderEmail: firstTo.email || m.senderEmail,
        subject: m.subject,
        preview: m.snippet || '',
        date: formatDate(m.date),
        isUnread: m.isUnread,
        tier: null,
        messageIds: [m.id],
        threadCount: 1,
      };
    }),
    [sent, activeAccount]
  );

  const performGmailAction = async (
    action: 'archive' | 'delete' | 'markRead' | 'markUnread',
    messageIds: string[],
    account: string
  ) => {
    await api('gmail', { account, method: 'POST', body: { action, messageIds } });
  };

  const onArchive = async (row: RowMessage) => {
    const prev = important;
    const ids = row.messageIds.length ? row.messageIds : [row.id];
    if (tab === 'important') setImportant(p => p.filter(i => !ids.includes(i.message_id)));
    if (tab === 'sent') setSent(p => p.filter(m => !ids.includes(m.id)));
    try {
      await performGmailAction('archive', ids, row.account);
      if (tab === 'important') {
        await Promise.all(ids.map(mid =>
          api('queue', { method: 'PUT', body: { message_id: mid, status: 'done' } }).catch(() => {})
        ));
      }
      showToast('Archived');
    } catch (e) {
      if (tab === 'important') setImportant(prev);
      showToast(e instanceof Error ? e.message : 'Archive failed');
    }
  };

  const onDelete = async (row: RowMessage) => {
    const prev = important;
    const ids = row.messageIds.length ? row.messageIds : [row.id];
    if (tab === 'important') setImportant(p => p.filter(i => !ids.includes(i.message_id)));
    if (tab === 'sent') setSent(p => p.filter(m => !ids.includes(m.id)));
    try {
      await performGmailAction('delete', ids, row.account);
      if (tab === 'important') {
        await Promise.all(ids.map(mid =>
          api('queue', { method: 'PUT', body: { message_id: mid, status: 'done' } }).catch(() => {})
        ));
      }
      showToast('Deleted');
    } catch (e) {
      if (tab === 'important') setImportant(prev);
      showToast(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleThreadAction = async (
    kind: 'archive' | 'delete' | 'markUnread',
    messageIds: string[]
  ) => {
    if (!openThread) return;
    try {
      await performGmailAction(kind, messageIds, openThread.account);
      if (kind === 'archive' || kind === 'delete') {
        setImportant(p => p.filter(i => !messageIds.includes(i.message_id)));
        setSent(p => p.filter(m => !messageIds.includes(m.id)));
        if (tab === 'important') {
          await api('queue', { method: 'PUT', body: { message_id: messageIds[0], status: 'done' } }).catch(() => {});
        }
      }
      if (kind === 'markUnread') {
        setSent(p => p.map(m => messageIds.includes(m.id) ? { ...m, isUnread: true } : m));
      }
      showToast(kind === 'archive' ? 'Archived' : kind === 'delete' ? 'Deleted' : 'Marked unread');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const openCompose = (mode: ComposeMode, orig?: GmailMessage) => {
    const account = orig?.accountEmail || (openThread?.account) || activeAccount;
    if (mode === 'new') {
      setCompose({
        mode, to: '', cc: '', bcc: '', subject: '', body: '',
        showCc: false, showBcc: false, account,
      });
      return;
    }
    if (!orig) return;
    const fromAddr = parseAddress(orig.sender || `<${orig.senderEmail}>`);
    const subject = buildReplySubject(mode, orig.subject);
    if (mode === 'forward') {
      setCompose({
        mode, to: '', cc: '', bcc: '', subject, body: '',
        quotedHtml: buildQuoted(orig),
        showCc: false, showBcc: false, account,
      });
      return;
    }
    const toAddr = fromAddr.email;
    let cc = '';
    if (mode === 'replyAll') {
      const others = (orig.to || '').split(',').map(s => parseAddress(s).email).filter(Boolean);
      const ccs = (orig.cc || '').split(',').map(s => parseAddress(s).email).filter(Boolean);
      const all = [...others, ...ccs].filter(e => e.toLowerCase() !== account.toLowerCase() && e.toLowerCase() !== toAddr.toLowerCase());
      cc = Array.from(new Set(all)).join(', ');
    }
    setCompose({
      mode, to: toAddr, cc, bcc: '', subject, body: '\n\n',
      quotedHtml: buildQuoted(orig),
      inReplyTo: orig.id,
      threadId: orig.threadId,
      showCc: !!cc, showBcc: false, account,
    });
  };

  const refreshImportant = async () => { await loadImportant(); };
  const refreshSent = async () => {
    if (!activeAccount) return;
    if (sentToken) await loadSent(activeAccount, true, sentToken);
    else await loadSent(activeAccount, false);
  };

  const setPrimary = async (email: string) => {
    try {
      await api('accounts', { method: 'PUT', body: { email, action: 'set_primary' } });
      showToast('Primary updated');
      await loadAccounts();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed');
    }
  };

  const removeAccount = async (email: string) => {
    if (accounts.length <= 1) { showToast('Cannot remove your only account'); return; }
    if (!confirm(`Disconnect ${email}?`)) return;
    try {
      await api('accounts', { method: 'DELETE', body: { email } });
      showToast('Disconnected');
      await loadAccounts();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed');
    }
  };

  const addAccount = () => {
    window.location.href = '/api/emailHelperV2/auth/login?state=add_account';
  };

  const useDesktop = () => {
    try { localStorage.setItem('clearbox_use_desktop', '1'); } catch {}
    window.location.href = '/dashboard';
  };

  if (authError) {
    return (
      <div className="m-root">
        <style>{styles}</style>
        <div className="state error" style={{ marginTop: 80, textAlign: 'center' }}>
          <div style={{ fontSize: 18, marginBottom: 12 }}>Sign in to continue</div>
          <button className="primary" onClick={() => { window.location.href = '/api/emailHelperV2/auth/login?state=login'; }}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-root">
      <style>{styles}</style>
      <header className="m-header">
        <div className="m-title">Clearbox</div>
        {tab === 'sent' && accounts.length > 1 && (
          <select
            className="m-account-pick"
            value={activeAccount}
            onChange={(e) => setActiveAccount(e.target.value)}
          >
            {accounts.map(a => <option key={a.email} value={a.email}>{a.email}</option>)}
          </select>
        )}
        <button className="m-desktop-link" onClick={useDesktop}>Desktop</button>
      </header>

      <main className="m-main">
        {tab === 'important' && (
          <PullToRefresh onRefresh={refreshImportant} label="Refreshing">
            {importantLoading ? (
              <div className="state">Loading…</div>
            ) : importantRows.length === 0 ? (
              <div className="state">No important items.</div>
            ) : (
              importantRows.map(row => (
                <MessageRow
                  key={`${row.account}|${row.id}`}
                  row={row}
                  onTap={() => setOpenThread({ id: row.threadId, account: row.account, subject: row.subject })}
                  onArchive={() => onArchive(row)}
                  onDelete={() => onDelete(row)}
                />
              ))
            )}
          </PullToRefresh>
        )}

        {tab === 'sent' && (
          <PullToRefresh onRefresh={refreshSent} label={sentToken ? 'Loading more…' : 'Refreshing'}>
            {sentLoading ? (
              <div className="state">Loading…</div>
            ) : sentRows.length === 0 ? (
              <div className="state">No sent messages.</div>
            ) : (
              <>
                {sentRows.map(row => (
                  <MessageRow
                    key={`${row.account}|${row.id}`}
                    row={row}
                    onTap={() => setOpenThread({ id: row.threadId, account: row.account, subject: row.subject })}
                    onArchive={() => onArchive(row)}
                    onDelete={() => onDelete(row)}
                  />
                ))}
                <div className="state small">
                  {sentLoadingMore ? 'Loading more…' : sentToken ? 'Pull down to load more' : 'End of list'}
                </div>
              </>
            )}
          </PullToRefresh>
        )}

        {tab === 'accounts' && (
          <PullToRefresh onRefresh={loadAccounts}>
            <div className="acct-list">
              {accounts.map(a => (
                <div key={a.email} className="acct-row">
                  <div className="acct-info">
                    <div className="acct-email">{a.email}</div>
                    <div className="acct-meta">
                      {a.is_primary && <span className="badge primary">Primary</span>}
                      {a.is_active_inbox && <span className="badge">Active inbox</span>}
                    </div>
                  </div>
                  <div className="acct-actions">
                    {!a.is_primary && (
                      <button onClick={() => setPrimary(a.email)}>Make primary</button>
                    )}
                    <button className="danger" onClick={() => removeAccount(a.email)}>Remove</button>
                  </div>
                </div>
              ))}
              <button className="primary acct-add" onClick={addAccount}>+ Add Gmail account</button>
            </div>
          </PullToRefresh>
        )}
      </main>

      {(tab === 'important' || tab === 'sent') && (
        <button className="fab" onClick={() => openCompose('new')} aria-label="Compose">＋</button>
      )}

      <nav className="m-tabs">
        <button className={tab === 'important' ? 'on' : ''} onClick={() => setTab('important')}>
          <div className="t-ico">★</div>
          <div>Important</div>
        </button>
        <button className={tab === 'sent' ? 'on' : ''} onClick={() => setTab('sent')}>
          <div className="t-ico">↗</div>
          <div>Sent</div>
        </button>
        <button className={tab === 'accounts' ? 'on' : ''} onClick={() => setTab('accounts')}>
          <div className="t-ico">⚙</div>
          <div>Accounts</div>
        </button>
      </nav>

      {openThread && (
        <ThreadView
          threadId={openThread.id}
          account={openThread.account}
          initialSubject={openThread.subject}
          onClose={() => setOpenThread(null)}
          onAction={handleThreadAction}
          onCompose={(mode, orig) => openCompose(mode, orig)}
        />
      )}

      {compose && (
        <ComposeSheet
          state={compose}
          onChange={setCompose}
          accounts={accounts}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null);
            showToast('Sent');
            if (tab === 'sent') setTimeout(() => loadSent(activeAccount, false), 1500);
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const styles = `
.m-root {
  --accent: #4f46e5;
  --bg: #f8f9fa;
  --bg-elev: #ffffff;
  --text: #1f2328;
  --muted: #6b7280;
  --border: #e5e7eb;
  --danger: #dc2626;
  position: fixed; inset: 0;
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.m-header {
  display: flex; align-items: center; gap: 8px;
  padding: env(safe-area-inset-top) 12px 0 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  height: calc(env(safe-area-inset-top) + 52px);
  flex-shrink: 0;
  position: relative; z-index: 10;
}
.m-title { font-weight: 700; font-size: 18px; flex: 1; }
.m-account-pick {
  font-size: 13px; max-width: 160px; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 6px; background: white;
}
.m-desktop-link {
  font-size: 12px; padding: 6px 10px; background: transparent;
  border: 1px solid var(--border); border-radius: 6px; color: var(--muted);
}

.m-main {
  flex: 1; min-height: 0; position: relative; overflow: hidden;
}

.ptr-scroll {
  position: absolute; inset: 0;
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding-bottom: calc(env(safe-area-inset-bottom) + 90px);
}
.ptr-indicator {
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--muted);
  overflow: hidden; transition: height 0.18s ease, opacity 0.18s ease;
}
.spin { display: inline-block; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.row-outer { position: relative; background: var(--bg-elev); }
.row-actions {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: flex-end;
  padding-right: 24px; background: #f59e0b; color: white; font-weight: 600;
}
.row-actions.is-delete { background: var(--danger); }
.row-action-label { font-size: 14px; }
.row-inner {
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  position: relative; z-index: 1;
  touch-action: pan-y;
}

.mrow {
  display: flex; gap: 12px; padding: 10px 14px;
}
.mrow.unread .mrow-sender { font-weight: 700; color: #111; }
.mrow.unread .mrow-subj { font-weight: 600; }
.mrow-avatar {
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 16px;
  flex-shrink: 0;
}
.mrow-body { flex: 1; min-width: 0; }
.mrow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.mrow-sender {
  font-size: 14.5px; color: #444;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 70%;
}
.mrow-date { font-size: 11.5px; color: var(--muted); flex-shrink: 0; }
.mrow-subj {
  font-size: 14px; color: #333;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 1px;
}
.mrow-preview {
  font-size: 13px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mrow-tier {
  display: inline-block; padding: 0 5px;
  border-radius: 3px; color: white; font-size: 10px; font-weight: 700;
  margin-right: 6px; vertical-align: 1px;
}

.mrow-count {
  display: inline-block; margin-left: 6px;
  padding: 0 6px; min-width: 18px;
  border-radius: 9px; background: #e2e8f0; color: #475569;
  font-size: 11px; font-weight: 600; text-align: center;
  vertical-align: 1px;
}

.state { padding: 24px; text-align: center; color: var(--muted); }
.state.small { padding: 12px; font-size: 12px; }
.state.error { color: var(--danger); }

.fab {
  position: absolute;
  right: 18px;
  bottom: calc(env(safe-area-inset-bottom) + 76px);
  width: 56px; height: 56px; border-radius: 28px;
  background: var(--accent); color: white;
  font-size: 26px; line-height: 56px;
  border: none; box-shadow: 0 6px 16px rgba(0,0,0,0.2);
  z-index: 20;
}

.m-tabs {
  display: flex; align-items: stretch;
  background: var(--bg-elev); border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom);
  flex-shrink: 0;
  z-index: 10;
}
.m-tabs button {
  flex: 1; background: none; border: none; padding: 8px 0;
  color: var(--muted); font-size: 11px;
}
.m-tabs button.on { color: var(--accent); }
.t-ico { font-size: 20px; line-height: 1.2; }

.overlay {
  position: fixed; inset: 0; background: var(--bg);
  z-index: 100; display: flex; flex-direction: column;
}
.overlay-bar {
  display: flex; align-items: center; gap: 4px;
  padding: env(safe-area-inset-top) 8px 0 8px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  height: calc(env(safe-area-inset-top) + 52px);
  flex-shrink: 0;
}
.overlay-title {
  font-weight: 600; font-size: 15px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 0 1 auto;
}
.overlay-bar-spacer { flex: 1; }
.overlay-body {
  flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding-bottom: calc(env(safe-area-inset-bottom) + 80px);
}

.iconbtn {
  background: none; border: none;
  width: 38px; height: 38px;
  font-size: 22px; color: #333;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px;
}
.iconbtn:active { background: var(--border); }
.iconbtn.danger { color: var(--danger); }
.iconbtn:disabled { opacity: 0.4; }

.tmsg { background: var(--bg-elev); border-bottom: 1px solid var(--border); padding: 12px 14px; }
.tmsg-head { display: flex; align-items: center; gap: 10px; }
.tmsg-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 14px;
  flex-shrink: 0;
}
.tmsg-meta { flex: 1; min-width: 0; }
.tmsg-from { font-size: 14px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.tmsg-snippet {
  font-size: 13px; color: var(--muted); margin-top: 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tmsg-body {
  font-size: 14px; line-height: 1.5; margin-top: 12px;
  word-break: break-word; overflow-wrap: break-word;
}
.tmsg-body img { max-width: 100%; height: auto; }
.tmsg-body table { max-width: 100%; }

.thread-actions {
  position: absolute; left: 0; right: 0;
  bottom: env(safe-area-inset-bottom);
  display: flex; gap: 8px; padding: 10px 12px;
  background: var(--bg-elev); border-top: 1px solid var(--border);
}
.thread-actions button {
  flex: 1; padding: 12px 0; font-size: 14px; font-weight: 500;
  border: 1px solid var(--border); background: var(--bg-elev);
  border-radius: 8px;
}
.thread-actions button.primary {
  background: var(--accent); color: white; border-color: var(--accent);
}

.compose-body { padding: 8px 0 80px; }
.compose-row {
  display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 10px 14px;
  position: relative;
}
.compose-row label {
  width: 50px; color: var(--muted); font-size: 13px;
  flex-shrink: 0;
}
.compose-row input, .compose-row select {
  flex: 1; border: none; outline: none;
  font-size: 15px; background: transparent; color: var(--text);
  font-family: inherit;
}
.compose-toggles { display: flex; gap: 4px; }
.compose-toggles button {
  border: 1px solid var(--border); background: transparent;
  padding: 4px 8px; font-size: 12px; border-radius: 4px;
  color: var(--muted);
}
.compose-body-text {
  width: 100%; min-height: 220px;
  border: none; outline: none;
  padding: 14px; font-size: 15px; line-height: 1.5;
  background: transparent; color: var(--text);
  font-family: inherit; resize: vertical;
}
.compose-quoted {
  padding: 8px 14px 24px;
  font-size: 13px; color: var(--muted);
  border-top: 1px dashed var(--border);
  margin-top: 8px;
}

.primary {
  background: var(--accent); color: white;
  border: none; padding: 10px 16px;
  border-radius: 8px; font-weight: 600; font-size: 14px;
}
.primary.small { padding: 7px 14px; font-size: 13px; }
.primary:disabled { opacity: 0.5; }
button.danger { color: var(--danger); border-color: var(--danger); }

.acct-list { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.acct-row {
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px;
}
.acct-info { margin-bottom: 8px; }
.acct-email { font-weight: 600; font-size: 14px; }
.acct-meta { display: flex; gap: 6px; margin-top: 4px; }
.badge {
  font-size: 11px; padding: 2px 6px; border-radius: 3px;
  background: var(--border); color: var(--muted);
}
.badge.primary { background: var(--accent); color: white; }
.acct-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.acct-actions button {
  flex: 1;
  padding: 10px; font-size: 13px;
  border: 1px solid var(--border); background: var(--bg-elev); border-radius: 6px;
}
.acct-add { width: 100%; padding: 14px !important; margin-top: 8px; }

.toast {
  position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom) + 90px);
  transform: translateX(-50%);
  background: rgba(20,20,20,0.92); color: white;
  padding: 10px 16px; border-radius: 22px;
  font-size: 13px; z-index: 200;
  pointer-events: none;
}
`;
