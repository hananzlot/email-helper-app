'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { GmailMessage } from '@/types';

type Tab = 'important' | 'recent' | 'sent' | 'accounts';

// Locally-persisted snapshot of an Important-tab item the user manually
// marked as read. Lets the user find and restore something they didn't mean
// to clear. Kept in localStorage (not Supabase) to avoid adding another
// store of email metadata at rest.
type RecentReadItem = {
  message_id: string;
  thread_id: string | null;
  account_email: string;
  sender: string;
  sender_email: string;
  subject: string;
  summary: string;
  tier: string | null;
  received: string;      // original received timestamp (ISO)
  marked_read_at: string;// when the user marked it read (ISO)
};

const RECENT_READ_KEY = 'clearbox_recent_read';
const RECENT_READ_MAX = 50;

function loadRecentRead(): RecentReadItem[] {
  try {
    const raw = localStorage.getItem(RECENT_READ_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => x && typeof x.message_id === 'string') : [];
  } catch { return []; }
}

function saveRecentRead(items: RecentReadItem[]) {
  try {
    localStorage.setItem(RECENT_READ_KEY, JSON.stringify(items.slice(0, RECENT_READ_MAX)));
  } catch { /* storage full or disabled — non-fatal */ }
}

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
  // The account that owns the original thread. When the user picks a
  // different `account` (cross-account reply), we drop threadId / inReplyTo
  // at send time because Gmail can't find the thread in the sending mailbox —
  // the conversation history is preserved via the inline quoted block instead.
  threadAccount?: string;
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
  opts: { account?: string; method?: string; body?: unknown; timeoutMs?: number } = {}
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
  const ctrl = opts.timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  if (ctrl) init.signal = ctrl.signal;
  let res: Response;
  try {
    res = await fetch(url.toString(), init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Request timed out — check your Sent folder before retrying');
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * Decode HTML entities in plain-text contexts. The reply_queue summaries and
 * Gmail snippets sometimes arrive with entities like &#39; or &amp; that the
 * triage/summarization pipeline left in. Rendering those via React's text
 * binding shows the raw entity instead of the character — fix at display time
 * rather than migrating the DB. Decode &amp; last so we don't double-decode
 * sequences like &amp;quot;.
 */
function decodeHtmlEntities(s: string): string {
  if (!s) return s;
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
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
  // Only treat the bare input as an email if it actually looks like one.
  // Without this guard a display-name-only string ("Twilio Support") would
  // get returned as the email and produce "To: Twilio Support" — Gmail 400.
  const trimmed = s.trim();
  if (trimmed.includes('@')) return { name: '', email: trimmed };
  return { name: trimmed, email: '' };
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

/**
 * Build a quoted block containing every message in a thread, oldest first.
 * Used for cross-account replies: when the user sends from an account that
 * doesn't own the original thread, we strip threadId/inReplyTo (Gmail can't
 * find the thread in the sending mailbox) and rely on this inline block to
 * carry the conversation history into the recipient's view.
 */
function buildQuotedThread(messages: GmailMessage[]): string {
  if (!messages.length) return '';
  const sorted = [...messages].sort((a, b) => {
    const ta = Date.parse(a.date || '') || 0;
    const tb = Date.parse(b.date || '') || 0;
    return ta - tb;
  });
  const blocks = sorted.map(m => {
    const fromLine = `On ${m.date}, ${cleanName(m.sender) || m.senderEmail} &lt;${htmlEscape(m.senderEmail)}&gt; wrote:`;
    const body = m.bodyHtml || (m.body ? plainToHtml(m.body) : '');
    return `<div style="margin-top:12px;">${fromLine}<br><br>${body}</div>`;
  });
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:10px;color:#555;">${blocks.join('')}</div>`;
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
  onMarkRead,
  onTap,
  children,
}: {
  onArchive: () => void;
  onDelete: () => void;
  // Right-swipe action. When omitted, rightward swipes don't trigger anything
  // and the row resists pulling right (keeps the visual asymmetric).
  onMarkRead?: () => void;
  onTap: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const moved = useRef(false);
  const decided = useRef<'h' | 'v' | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // When the touch starts on an interactive child (a button, or anything
  // with data-no-row-tap), suppress the row-level tap so the child's own
  // click handler runs unimpeded. Horizontal swipes still work.
  const skipTap = useRef(false);

  const touchStartedOnInteractive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest('button, a, input, [data-no-row-tap]');
  };

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    moved.current = false;
    decided.current = null;
    skipTap.current = touchStartedOnInteractive(e.target);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null || startY.current === null) return;
    const dxNow = e.touches[0].clientX - startX.current;
    const dyNow = e.touches[0].clientY - startY.current;
    if (decided.current === null) {
      if (Math.abs(dxNow) > 8 || Math.abs(dyNow) > 8) {
        decided.current = Math.abs(dxNow) > Math.abs(dyNow) ? 'h' : 'v';
        // Vertical drags must also count as "moved" so onTouchEnd doesn't
        // treat a scroll gesture as a tap and open the row underneath.
        moved.current = true;
      }
    }
    if (decided.current === 'h') {
      const maxRight = onMarkRead ? 220 : 60;
      setDx(Math.max(-220, Math.min(maxRight, dxNow)));
    }
  };
  const onTouchEnd = () => {
    const finalDx = dx;
    startX.current = null;
    startY.current = null;
    if (decided.current === 'h') {
      // Long left = archive, short left = delete (swap of the prior order).
      if (finalDx <= -160) {
        setDx(-9999);
        setTimeout(onArchive, 180);
        return;
      }
      if (finalDx <= -70) {
        setDx(-9999);
        setTimeout(onDelete, 180);
        return;
      }
      if (onMarkRead && finalDx >= 70) {
        setDx(9999);
        setTimeout(onMarkRead, 180);
        return;
      }
      setDx(0);
    } else if (decided.current === null && !skipTap.current) {
      // Pure tap — no horizontal swipe and no vertical scroll. Vertical scroll
      // sets decided.current to 'v', which used to fall into the swipe-or-tap
      // else branch and accidentally open the message under the user's finger.
      onTap();
    }
    decided.current = null;
  };

  // Pick which action the user is currently committing to so the under-row
  // panel reads as a real preview, not a static label. Right swipes flip to
  // 'mark' immediately so the green reveal tracks the finger.
  const mode: 'mark' | 'delete' | 'archive' =
    dx > 0 ? 'mark'
    : dx <= -160 ? 'archive'
    : 'delete';
  const offscreen = rowRef.current?.offsetWidth || 500;
  const xPx = dx === -9999 ? -offscreen : dx === 9999 ? offscreen : dx;
  const actionBg = mode === 'mark' ? '#10b981' : mode === 'archive' ? '#f59e0b' : 'var(--danger)';
  const actionLabel = mode === 'mark' ? 'Mark read' : mode === 'archive' ? 'Archive' : 'Delete';

  return (
    <div className="row-outer" ref={rowRef}>
      <div
        className="row-actions"
        style={{
          background: actionBg,
          justifyContent: mode === 'mark' ? 'flex-start' : 'flex-end',
          paddingLeft: mode === 'mark' ? 24 : 0,
          paddingRight: mode === 'mark' ? 0 : 24,
        }}
      >
        <span className="row-action-label">{actionLabel}</span>
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
        onClick={(e) => {
          if (moved.current || Math.abs(dx) >= 4) return;
          // Desktop-only fallback: touch devices fire onTap from onTouchEnd.
          // Skip if the click originated on an interactive child so buttons
          // inside the row handle their own clicks.
          if (touchStartedOnInteractive(e.target)) return;
          onTap();
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MessageRow({ row, onTap, onArchive, onDelete, onMarkRead, onChangeTier }: {
  row: RowMessage;
  onTap: () => void;
  onArchive: () => void;
  onDelete: () => void;
  // Optional — only the Important tab wires this. Right-swipe is a no-op when
  // omitted (Sent rows have no unread state, Recent rows are already read).
  onMarkRead?: () => void;
  // When present, the tier badge becomes a tappable picker. Only wired on the
  // Important tab — Sent rows have no tier so this never surfaces there.
  onChangeTier?: (senderEmail: string, senderName: string, newTier: 'A' | 'B' | 'C' | 'D') => void;
}) {
  const name = fallbackName(row.sender, row.senderEmail);
  const emailLocal = (row.senderEmail || '').split('@')[0];
  const initial = senderInitial(emailLocal || name);
  const color = avatarColor(row.senderEmail || name);
  const [tierOpen, setTierOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const tierBtnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <SwipeableRow onTap={onTap} onArchive={onArchive} onDelete={onDelete} onMarkRead={onMarkRead}>
      <div className={`mrow ${row.isUnread ? 'unread' : ''}`}>
        <div className="mrow-avatar" style={{ background: color }}>{initial}</div>
        <div className="mrow-body">
          <div className="mrow-top">
            <span className="mrow-sender">{name}</span>
            <span className="mrow-date">{row.date}</span>
          </div>
          <div className="mrow-subj">
            {row.tier && onChangeTier ? (
              // data-no-row-tap tells SwipeableRow to ignore taps that start
              // inside this wrapper, so the button gets its click event
              // and the thread doesn't open underneath.
              <span className="mrow-tier-wrap" data-no-row-tap>
                <button
                  ref={tierBtnRef}
                  type="button"
                  className="mrow-tier mrow-tier-btn"
                  style={{ background: tierBadge(row.tier) }}
                  onClick={() => {
                    // The picker is portaled to document.body to escape the
                    // .mrow-subj overflow:hidden clip and .row-inner stacking
                    // context. Anchor it from the button's viewport position.
                    if (!tierOpen) {
                      const rect = tierBtnRef.current?.getBoundingClientRect();
                      if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
                    }
                    setTierOpen(o => !o);
                  }}
                  aria-label={`Change tier (currently ${row.tier})`}
                >
                  {row.tier}<span className="mrow-tier-caret">▾</span>
                </button>
                {tierOpen && menuPos && typeof document !== 'undefined' && createPortal(
                  <>
                    <div
                      className="mrow-tier-scrim"
                      data-no-row-tap
                      onClick={() => setTierOpen(false)}
                    />
                    <div
                      className="mrow-tier-menu"
                      data-no-row-tap
                      style={{ top: menuPos.top, left: menuPos.left }}
                    >
                      {(['A','B','C','D'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          className={`mrow-tier-opt ${t === row.tier ? 'active' : ''}`}
                          onClick={() => {
                            setTierOpen(false);
                            if (t !== row.tier) onChangeTier(row.senderEmail, name, t);
                          }}
                        >
                          <span className="mrow-tier-chip" style={{ background: tierBadge(t) }}>{t}</span>
                          <span>{t === 'A' ? 'Top priority' : t === 'B' ? 'Important' : t === 'C' ? 'Normal' : 'Low / Cleanup'}</span>
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body,
                )}
              </span>
            ) : row.tier ? (
              <span className="mrow-tier" style={{ background: tierBadge(row.tier) }}>{row.tier}</span>
            ) : null}
            {decodeHtmlEntities(row.subject) || '(no subject)'}
            {row.threadCount > 1 && <span className="mrow-count">{row.threadCount}</span>}
          </div>
          <div className="mrow-preview">{decodeHtmlEntities(row.preview)}</div>
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
  onMessagesRead,
}: {
  threadId: string;
  account: string;
  initialSubject: string;
  onClose: () => void;
  onAction: (kind: 'archive' | 'delete' | 'markRead' | 'markUnread', messageIds: string[]) => Promise<void>;
  onCompose: (mode: 'reply' | 'replyAll' | 'forward', orig: GmailMessage, threadMessages?: GmailMessage[], threadAccount?: string) => void;
  // Fires whenever the user explicitly marks messages as read via the
  // Mark-as-read button in the thread toolbar. The parent uses this to drop
  // matching queue items from the Important list so the thread doesn't
  // linger there once the user has handled it. Opening a thread does NOT
  // auto-mark it read — that's only ever a user action.
  onMessagesRead?: (messageIds: string[]) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Track read state locally so the toolbar toggle reflects user actions
  // immediately, without re-fetching the thread.
  const [unreadOverride, setUnreadOverride] = useState<Map<string, boolean>>(new Map());

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

  const last = messages[messages.length - 1];
  const subject = messages[0]?.subject || initialSubject;

  // Toggle reflects what the button will do next: if any message is unread,
  // the next action is "Mark read"; otherwise "Mark unread".
  const isUnread = (m: GmailMessage) => unreadOverride.get(m.id) ?? m.isUnread;
  const hasUnread = messages.some(isUnread);

  const doAction = async (kind: 'archive' | 'delete' | 'markRead' | 'markUnread') => {
    if (!messages.length || busy) return;
    setBusy(true);
    try {
      const ids = messages.map(m => m.id);
      await onAction(kind, ids);
      if (kind === 'markRead' || kind === 'markUnread') {
        const next = new Map(unreadOverride);
        for (const id of ids) next.set(id, kind === 'markUnread');
        setUnreadOverride(next);
        if (kind === 'markRead') onMessagesRead?.(ids);
      } else {
        onClose();
      }
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
        {hasUnread ? (
          <button className="iconbtn" onClick={() => doAction('markRead')} disabled={busy} title="Mark as read" aria-label="Mark as read">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l9 6 9-6"/><rect x="3" y="6" width="18" height="14" rx="2"/></svg>
          </button>
        ) : (
          <button className="iconbtn" onClick={() => doAction('markUnread')} disabled={busy} title="Mark as unread" aria-label="Mark as unread">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 6l-10 7L2 6"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>
          </button>
        )}
        <button className="iconbtn" onClick={() => doAction('archive')} disabled={busy} title="Archive" aria-label="Archive">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
        </button>
        <button className="iconbtn danger" onClick={() => doAction('delete')} disabled={busy} title="Delete" aria-label="Delete">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
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
          <button className="primary" onClick={() => onCompose('reply', last, messages, account)}>Reply</button>
          <button onClick={() => onCompose('replyAll', last, messages, account)}>Reply all</button>
          <button onClick={() => onCompose('forward', last, messages, account)}>Forward</button>
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

type Suggestion = { name: string; email: string };

type SenderRow = {
  sender_email: string;
  display_name: string | null;
  reply_count: number | null;
};

function RecipientInput({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: Suggestion[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokens = value.split(',');
  const lastToken = (tokens[tokens.length - 1] || '').trim().toLowerCase();

  const matches = useMemo(() => {
    if (!suggestions.length) return [];
    // No filter typed yet → show top contacts (sorted by reply_count is the
    // suggestions-prop responsibility) so the dropdown is useful from the
    // moment the user focuses an empty field.
    const pool = lastToken
      ? suggestions.filter(s =>
          s.email.toLowerCase().includes(lastToken) ||
          (s.name || '').toLowerCase().includes(lastToken))
      : suggestions;
    // Hide entries already added in earlier tokens so we don't suggest dups.
    const usedEmails = new Set(
      tokens.slice(0, -1)
        .map(t => parseAddress(t).email.toLowerCase())
        .filter(Boolean),
    );
    return pool.filter(s => !usedEmails.has(s.email.toLowerCase())).slice(0, 6);
  }, [lastToken, suggestions, tokens]);

  const pick = (s: Suggestion) => {
    const before = tokens.slice(0, -1).map(t => t.trim()).filter(Boolean);
    const formatted = s.name && s.name !== s.email ? `${s.name} <${s.email}>` : s.email;
    const next = (before.length ? before.join(', ') + ', ' : '') + formatted + ', ';
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="recipient-wrap">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer close so a tap on a suggestion can register before the
          // dropdown unmounts. mousedown/touchstart handlers also block this
          // by calling preventDefault, but the timer is a safety net.
          blurTimer.current = setTimeout(() => setOpen(false), 180);
        }}
      />
      {open && matches.length > 0 && (
        <div className="recipient-suggestions">
          {matches.map(s => (
            <button
              key={s.email}
              type="button"
              className="recipient-suggestion"
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onTouchStart={(e) => { e.preventDefault(); pick(s); }}
            >
              {s.name && s.name !== s.email && <span className="rs-name">{s.name}</span>}
              <span className="rs-email">{s.email}</span>
            </button>
          ))}
        </div>
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
  suggestions,
}: {
  state: ComposeState;
  onChange: (s: ComposeState) => void;
  onClose: () => void;
  onSent: () => void;
  accounts: ConnectedAccount[];
  suggestions: Suggestion[];
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [undoBody, setUndoBody] = useState<string | null>(null);

  const aiRewrite = async (style: string) => {
    if (aiBusy) return;
    if (!state.body.trim()) {
      setError('Write something first, then ask AI to rewrite it');
      setAiOpen(false);
      return;
    }
    setError(null);
    setAiBusy(style);
    setAiOpen(false);
    const previous = state.body;
    try {
      const res = await fetch('/api/emailHelperV2/ai-rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: state.body, style }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'AI rewrite failed');
      onChange({ ...state, body: json.data.rewritten });
      setUndoBody(previous);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI rewrite failed');
    } finally {
      setAiBusy(null);
    }
  };

  const undoRewrite = () => {
    if (undoBody === null) return;
    onChange({ ...state, body: undoBody });
    setUndoBody(null);
  };

  const send = async () => {
    if (sending) return;
    if (!state.to.trim()) { setError('Recipient required'); return; }
    setSending(true);
    setError(null);
    try {
      const html = plainToHtml(state.body) + (state.quotedHtml || '');
      // Cross-account reply: when the sending account doesn't own the original
      // thread, drop threadId / inReplyTo so Gmail doesn't try (and fail) to
      // look up the thread in the wrong mailbox. The conversation history is
      // already inlined as quoted HTML in the body, so the recipient still
      // sees full context — they just won't get native Gmail threading on
      // our side.
      const sameAccount = !state.threadAccount || state.threadAccount === state.account;
      const threadId = sameAccount ? state.threadId : undefined;
      const inReplyTo = sameAccount ? state.inReplyTo : undefined;
      // 30s ceiling — if iOS suspends the PWA tab mid-request the fetch hangs
      // forever and the Send button reads "Sending…" until the user reopens the app.
      await api('gmail', {
        account: state.account,
        method: 'POST',
        timeoutMs: 30_000,
        body: {
          action: 'send',
          to: state.to.trim(),
          subject: state.subject,
          body: html,
          cc: state.cc.trim() || undefined,
          bcc: state.bcc.trim() || undefined,
          inReplyTo,
          threadId,
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
        {/* Error is shown twice — once at the top so it's visible right under the
            Send button, once at the bottom for long replies where the quoted
            thread pushes the form off-screen. The bottom copy used to be the
            only one and was effectively invisible. */}
        {error && <div className="state error compose-error-top">{error}</div>}
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
          <RecipientInput
            value={state.to}
            onChange={(v) => onChange({ ...state, to: v })}
            suggestions={suggestions}
            placeholder="recipient@example.com"
          />
          <div className="compose-toggles">
            {!state.showCc && <button onClick={() => onChange({ ...state, showCc: true })}>Cc</button>}
            {!state.showBcc && <button onClick={() => onChange({ ...state, showBcc: true })}>Bcc</button>}
          </div>
        </div>
        {state.showCc && (
          <div className="compose-row">
            <label>Cc</label>
            <RecipientInput
              value={state.cc}
              onChange={(v) => onChange({ ...state, cc: v })}
              suggestions={suggestions}
            />
          </div>
        )}
        {state.showBcc && (
          <div className="compose-row">
            <label>Bcc</label>
            <RecipientInput
              value={state.bcc}
              onChange={(v) => onChange({ ...state, bcc: v })}
              suggestions={suggestions}
            />
          </div>
        )}
        <div className="compose-row">
          <label>Subject</label>
          <input value={state.subject} onChange={(e) => onChange({ ...state, subject: e.target.value })} />
        </div>
        <div className="compose-toolbar">
          <div className="ai-wrap">
            <button
              type="button"
              className="ai-btn"
              onClick={() => setAiOpen(o => !o)}
              disabled={!!aiBusy}
            >
              {aiBusy ? `AI: ${aiBusy}…` : '✨ AI rewrite'}
            </button>
            {undoBody !== null && !aiBusy && (
              <button type="button" className="ai-undo" onClick={undoRewrite}>Undo</button>
            )}
            {aiOpen && (
              <>
                <div className="ai-scrim" onClick={() => setAiOpen(false)} />
                <div className="ai-menu">
                  <button onMouseDown={(e) => { e.preventDefault(); aiRewrite('improve'); }}>Improve</button>
                  <button onMouseDown={(e) => { e.preventDefault(); aiRewrite('formal'); }}>Make formal</button>
                  <button onMouseDown={(e) => { e.preventDefault(); aiRewrite('casual'); }}>Make casual</button>
                  <button onMouseDown={(e) => { e.preventDefault(); aiRewrite('shorter'); }}>Shorter</button>
                  <button onMouseDown={(e) => { e.preventDefault(); aiRewrite('longer'); }}>Longer</button>
                </div>
              </>
            )}
          </div>
        </div>
        <textarea
          className="compose-body-text"
          value={state.body}
          onChange={(e) => onChange({ ...state, body: e.target.value })}
          placeholder="Write your message…"
          disabled={!!aiBusy}
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
  const [sentTokens, setSentTokens] = useState<Record<string, string | null>>({});
  const [sentLoadingMore, setSentLoadingMore] = useState(false);

  const [openThread, setOpenThread] = useState<{ id: string; account: string; subject: string } | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  // Recipient suggestions sourced from sender_priorities (people who've emailed us)
  // plus our own connected accounts. Loaded once after auth.
  const [senders, setSenders] = useState<SenderRow[]>([]);
  const [recentRead, setRecentRead] = useState<RecentReadItem[]>([]);

  // Hydrate recent-read from localStorage on first mount (client-only).
  useEffect(() => { setRecentRead(loadRecentRead()); }, []);

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

  const loadSenders = useCallback(async () => {
    try {
      const data = await api<SenderRow[]>('senders');
      setSenders(data || []);
    } catch {
      // Non-fatal: compose still works, just without autocomplete
    }
  }, []);

  useEffect(() => {
    if (!accountsLoaded || authError) return;
    loadSenders();
  }, [accountsLoaded, authError, loadSenders]);

  // Sort senders by reply_count desc so most-contacted appear first when
  // the recipient field is focused with no filter typed. Connected accounts
  // are added on top so the user can easily address themselves.
  const recipientSuggestions: Suggestion[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const a of accounts) {
      const key = a.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: a.email, email: a.email });
    }
    const sorted = [...senders].sort((a, b) => (b.reply_count || 0) - (a.reply_count || 0));
    for (const s of sorted) {
      const email = (s.sender_email || '').trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: (s.display_name || '').trim() || email, email });
    }
    return out;
  }, [senders, accounts]);

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

  const fetchSentPage = useCallback(async (email: string, pageToken?: string) => {
    let path = `gmail?action=inbox&q=${encodeURIComponent('in:sent')}&max=50`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    try {
      const data = await api<{ messages: GmailMessage[]; nextPageToken?: string | null }>(path, { account: email });
      const tagged = (data.messages || []).map(m => ({ ...m, accountEmail: email }));
      return { email, messages: tagged, nextPageToken: data.nextPageToken || null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load sent';
      if (msg.toLowerCase().includes('not authenticated')) setAuthError(msg);
      return { email, messages: [] as GmailMessage[], nextPageToken: null as string | null };
    }
  }, []);

  const loadSentMail = useCallback(async () => {
    if (accounts.length === 0) return;
    setSentLoading(true);
    try {
      const results = await Promise.all(accounts.map(a => fetchSentPage(a.email)));
      const allSent: GmailMessage[] = [];
      const tokens: Record<string, string | null> = {};
      for (const r of results) {
        allSent.push(...r.messages);
        tokens[r.email] = r.nextPageToken;
      }
      allSent.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setSent(allSent);
      setSentTokens(tokens);
    } finally {
      setSentLoading(false);
    }
  }, [accounts, fetchSentPage]);

  const loadMoreSent = useCallback(async () => {
    if (sentLoadingMore) return;
    const entries = Object.entries(sentTokens).filter(([, t]) => !!t) as [string, string][];
    if (entries.length === 0) return;
    setSentLoadingMore(true);
    try {
      const results = await Promise.all(entries.map(([email, token]) => fetchSentPage(email, token)));
      const additions: GmailMessage[] = [];
      const tokenUpdates: Record<string, string | null> = {};
      for (const r of results) {
        additions.push(...r.messages);
        tokenUpdates[r.email] = r.nextPageToken;
      }
      setSent(prev => {
        const seen = new Set(prev.map(m => `${m.accountEmail}:${m.id}`));
        const merged = [...prev];
        for (const m of additions) {
          const key = `${m.accountEmail}:${m.id}`;
          if (!seen.has(key)) { merged.push(m); seen.add(key); }
        }
        merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        return merged;
      });
      setSentTokens(prev => ({ ...prev, ...tokenUpdates }));
    } finally {
      setSentLoadingMore(false);
    }
  }, [sentTokens, sentLoadingMore, fetchSentPage]);

  const hasMoreSent = useMemo(() => Object.values(sentTokens).some(t => !!t), [sentTokens]);

  useEffect(() => {
    if (!accountsLoaded || accounts.length === 0) return;
    loadImportant();
    loadSentMail();
  }, [accountsLoaded, accounts, loadImportant, loadSentMail]);

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

  const refreshSent = async () => {
    if (hasMoreSent && sent.length > 0) {
      await loadMoreSent();
    } else {
      await loadSentMail();
    }
  };

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

  // Right-swipe handler on the Important tab. Mirrors the ThreadView markRead
  // path: hits Gmail, then calls markImportantDone to clear the queue row and
  // capture a Recent-read snapshot so the user can restore it.
  const onMarkRead = async (row: RowMessage) => {
    const ids = row.messageIds.length ? row.messageIds : [row.id];
    try {
      await performGmailAction('markRead', ids, row.account);
      markImportantDone(ids);
      showToast('Marked read');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Mark read failed');
    }
  };

  // Change a sender's global tier. Updates server-side via PUT /senders and
  // reflects the change on every queue row from that sender. If the new tier is
  // 'D' (low / cleanup) the rows leave the Important list, since Important
  // only shows A/B/C per the tier rules.
  const changeSenderTier = useCallback(async (
    senderEmail: string,
    senderName: string,
    newTier: 'A' | 'B' | 'C' | 'D',
  ) => {
    const normalized = (senderEmail || '').toLowerCase();
    if (!normalized) return;
    try {
      const res = await fetch('/api/emailHelperV2/senders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sender_email: normalized, tier: newTier, display_name: senderName || senderEmail }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to change tier');
      if (newTier === 'D') {
        setImportant(p => p.filter(q => (q.sender_email || '').toLowerCase() !== normalized));
        showToast('Moved to Cleanup');
      } else {
        setImportant(p => p.map(q =>
          (q.sender_email || '').toLowerCase() === normalized ? { ...q, tier: newTier } : q
        ));
        showToast(`Tier set to ${newTier}`);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to change tier');
    }
  }, [showToast]);

  // Drop any Important-tab queue items whose Gmail message is now read, and
  // mark their queue rows done server-side so they don't reappear on reload.
  // Also records a snapshot of each removed item in the Recent-read list
  // (local-only) so the user can get back to something they cleared by mistake.
  const markImportantDone = useCallback((messageIds: string[]) => {
    const ids = new Set(messageIds);
    const toRemove = important.filter(q => ids.has(q.message_id));
    if (toRemove.length === 0) return;
    setImportant(p => p.filter(q => !ids.has(q.message_id)));
    for (const q of toRemove) {
      api('queue', { method: 'PUT', body: { message_id: q.message_id, status: 'done' } }).catch(() => {});
    }
    const now = new Date().toISOString();
    const snapshots: RecentReadItem[] = toRemove.map(q => ({
      message_id: q.message_id,
      thread_id: q.thread_id,
      account_email: q.account_email,
      sender: q.sender,
      sender_email: q.sender_email,
      subject: q.subject,
      summary: q.summary,
      tier: q.tier,
      received: q.received,
      marked_read_at: now,
    }));
    setRecentRead(prev => {
      const byId = new Set(snapshots.map(s => s.message_id));
      const next = [...snapshots, ...prev.filter(r => !byId.has(r.message_id))].slice(0, RECENT_READ_MAX);
      saveRecentRead(next);
      return next;
    });
  }, [important]);

  // Restore a Recently-read item back to Important: mark the message unread
  // in Gmail, re-activate the queue row, and remove the snapshot.
  const restoreRecent = useCallback(async (item: RecentReadItem) => {
    try {
      await api('gmail', {
        account: item.account_email,
        method: 'POST',
        body: { action: 'markUnread', messageIds: [item.message_id] },
      });
      await api('queue', {
        method: 'PUT',
        body: { message_id: item.message_id, status: 'active' },
      });
      setRecentRead(prev => {
        const next = prev.filter(r => r.message_id !== item.message_id);
        saveRecentRead(next);
        return next;
      });
      setImportant(prev => prev.some(q => q.message_id === item.message_id) ? prev : [
        {
          id: item.message_id,
          message_id: item.message_id,
          thread_id: item.thread_id,
          account_email: item.account_email,
          sender: item.sender,
          sender_email: item.sender_email,
          subject: item.subject,
          summary: item.summary,
          status: 'active',
          priority: 'normal',
          priority_score: item.tier === 'A' ? 9 : item.tier === 'B' ? 7 : 5,
          tier: item.tier,
          reply_count: 0,
          snoozed_until: null,
          received: item.received,
          gmail_url: null,
        },
        ...prev,
      ]);
      showToast('Restored to Important');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Restore failed');
    }
  }, [showToast]);

  const clearRecentRead = useCallback(() => {
    setRecentRead([]);
    saveRecentRead([]);
  }, []);

  const handleThreadAction = async (
    kind: 'archive' | 'delete' | 'markRead' | 'markUnread',
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
      if (kind === 'markRead') {
        setSent(p => p.map(m => messageIds.includes(m.id) ? { ...m, isUnread: false } : m));
      }
      if (kind === 'markUnread') {
        setSent(p => p.map(m => messageIds.includes(m.id) ? { ...m, isUnread: true } : m));
      }
      showToast(
        kind === 'archive' ? 'Archived'
        : kind === 'delete' ? 'Deleted'
        : kind === 'markRead' ? 'Marked read'
        : 'Marked unread'
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const openCompose = (mode: ComposeMode, orig?: GmailMessage, threadMessages?: GmailMessage[], threadAccount?: string) => {
    const account = threadAccount || orig?.accountEmail || (openThread?.account) || activeAccount;
    if (mode === 'new') {
      setCompose({
        mode, to: '', cc: '', bcc: '', subject: '', body: '',
        showCc: false, showBcc: false, account,
      });
      return;
    }
    if (!orig) return;
    const subject = buildReplySubject(mode, orig.subject);
    // For replies prefer the full thread so cross-account sends still carry
    // the conversation in the body. Forward gets just the original message
    // (the user is starting a new conversation, not continuing one).
    const quotedHtml = (mode !== 'forward' && threadMessages && threadMessages.length > 1)
      ? buildQuotedThread(threadMessages)
      : buildQuoted(orig);
    if (mode === 'forward') {
      setCompose({
        mode, to: '', cc: '', bcc: '', subject, body: '',
        quotedHtml,
        showCc: false, showBcc: false, account,
        threadAccount,
      });
      return;
    }
    // senderEmail is the structured email address extracted from the From header
    // upstream in lib/gmail.ts. orig.sender is the *display name* only — feeding
    // it to parseAddress without angle brackets used to produce a bogus To header.
    const toAddr = orig.senderEmail;
    let cc = '';
    if (mode === 'replyAll') {
      const valid = (e: string) => e.includes('@');
      const others = (orig.to || '').split(',').map(s => parseAddress(s).email).filter(valid);
      const ccs = (orig.cc || '').split(',').map(s => parseAddress(s).email).filter(valid);
      const all = [...others, ...ccs].filter(e => e.toLowerCase() !== account.toLowerCase() && e.toLowerCase() !== toAddr.toLowerCase());
      cc = Array.from(new Set(all)).join(', ');
    }
    setCompose({
      mode, to: toAddr, cc, bcc: '', subject, body: '\n\n',
      quotedHtml,
      inReplyTo: orig.id,
      threadId: orig.threadId,
      showCc: !!cc, showBcc: false, account,
      threadAccount,
    });
  };

  const refreshImportant = async () => { await loadImportant(); };

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
                  onMarkRead={() => onMarkRead(row)}
                  onChangeTier={changeSenderTier}
                />
              ))
            )}
          </PullToRefresh>
        )}

        {tab === 'recent' && (
          <>
            <div className="recent-hdr">
              <div className="recent-title">
                Recently marked read
                <span className="recent-count">{recentRead.length}</span>
              </div>
              {recentRead.length > 0 && (
                <button className="recent-clear" onClick={clearRecentRead}>Clear all</button>
              )}
            </div>
            {recentRead.length === 0 ? (
              <div className="state">
                Nothing here yet. When you mark a message in Important as read, it&rsquo;ll appear here so you can get back to it.
              </div>
            ) : (
              recentRead.map(item => (
                <div key={`${item.account_email}|${item.message_id}`} className="recent-row-wrap">
                  <MessageRow
                    row={{
                      id: item.message_id,
                      threadId: item.thread_id || item.message_id,
                      account: item.account_email,
                      sender: item.sender,
                      senderEmail: item.sender_email,
                      subject: item.subject,
                      preview: item.summary || '',
                      date: formatDate(item.marked_read_at),
                      isUnread: false,
                      tier: item.tier,
                      messageIds: [item.message_id],
                      threadCount: 1,
                    }}
                    onTap={() => setOpenThread({
                      id: item.thread_id || item.message_id,
                      account: item.account_email,
                      subject: item.subject,
                    })}
                    onArchive={() => {
                      performGmailAction('archive', [item.message_id], item.account_email).catch(() => {});
                      setRecentRead(prev => { const n = prev.filter(r => r.message_id !== item.message_id); saveRecentRead(n); return n; });
                      showToast('Archived');
                    }}
                    onDelete={() => {
                      performGmailAction('delete', [item.message_id], item.account_email).catch(() => {});
                      setRecentRead(prev => { const n = prev.filter(r => r.message_id !== item.message_id); saveRecentRead(n); return n; });
                      showToast('Deleted');
                    }}
                  />
                  <button
                    className="recent-restore"
                    onClick={() => restoreRecent(item)}
                    aria-label="Restore to Important"
                  >Restore</button>
                </div>
              ))
            )}
            <div className="state small">Keeps the last {RECENT_READ_MAX} on this device.</div>
          </>
        )}

        {tab === 'sent' && (
          <PullToRefresh onRefresh={refreshSent} label={hasMoreSent ? 'Loading more…' : 'Refreshing'}>
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
                  {sentLoadingMore ? 'Loading more…' : hasMoreSent ? 'Pull down to load more' : 'End of list'}
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
        <button className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>
          <div className="t-ico">⟲</div>
          <div>Recent</div>
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
          onMessagesRead={markImportantDone}
        />
      )}

      {compose && (
        <ComposeSheet
          state={compose}
          onChange={setCompose}
          accounts={accounts}
          suggestions={recipientSuggestions}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null);
            // After a successful reply/replyAll/forward, drop back to the
            // inbox: the user expects "I'm done with this thread" once they
            // hit send. New compose (no thread open) just closes the sheet.
            if (compose.mode !== 'new') setOpenThread(null);
            showToast('Sent');
            if (tab === 'sent') setTimeout(() => { loadSentMail(); }, 1500);
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

.mrow-tier-wrap { position: relative; display: inline-block; margin-right: 6px; }
.mrow-tier-btn {
  border: none; padding: 1px 6px 1px 7px;
  display: inline-flex; align-items: center; gap: 2px;
  cursor: pointer; font-family: inherit;
}
.mrow-tier-caret { font-size: 8px; opacity: 0.85; margin-left: 1px; }
.mrow-tier-scrim {
  position: fixed; inset: 0; z-index: 1000; background: transparent;
}
.mrow-tier-menu {
  position: fixed; z-index: 1001;
  background: white; border: 1px solid var(--border);
  border-radius: 10px; box-shadow: 0 10px 24px rgba(0,0,0,0.14);
  min-width: 200px; max-width: calc(100vw - 24px);
  overflow: hidden; padding: 4px 0;
}
.mrow-tier-opt {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 8px 12px;
  background: white; border: none; text-align: left;
  font-size: 13px; color: var(--text); cursor: pointer;
}
.mrow-tier-opt.active { background: #f1f5f9; font-weight: 600; }
.mrow-tier-opt:active { background: #e2e8f0; }
.mrow-tier-chip {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 4px;
  color: white; font-size: 11px; font-weight: 700;
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

.recent-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px 8px; gap: 8px;
}
.recent-title { font-size: 15px; font-weight: 600; color: var(--text); }
.recent-count {
  display: inline-block; margin-left: 8px;
  padding: 1px 8px; border-radius: 999px;
  background: #eef2ff; color: #3730a3;
  font-size: 11px; font-weight: 700;
}
.recent-clear {
  border: 1px solid var(--border); background: transparent;
  color: var(--muted); font-size: 12px;
  padding: 4px 10px; border-radius: 999px;
}
.recent-row-wrap { position: relative; }
.recent-restore {
  position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
  border: 1px solid var(--accent); background: white; color: var(--accent);
  font-size: 12px; font-weight: 600;
  padding: 5px 10px; border-radius: 999px;
  z-index: 2;
}
.recent-restore:active { background: #eef2ff; }
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
.compose-error-top {
  position: sticky;
  top: 0;
  z-index: 5;
  margin: 0 0 8px;
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #991b1b;
  font-size: 14px;
  text-align: left;
}
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

.recipient-wrap { flex: 1; position: relative; }
.recipient-wrap input { width: 100%; }
.recipient-suggestions {
  position: absolute; left: -14px; right: -14px; top: calc(100% + 8px);
  background: white; border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  z-index: 60; max-height: 240px; overflow-y: auto;
}
.recipient-suggestion {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  width: 100%; padding: 10px 14px;
  background: white; border: none; text-align: left;
  border-bottom: 1px solid var(--border); cursor: pointer;
}
.recipient-suggestion:last-child { border-bottom: none; }
.recipient-suggestion:active { background: #eef2ff; }
.recipient-suggestion .rs-name { font-size: 14px; font-weight: 600; color: var(--text); }
.recipient-suggestion .rs-email { font-size: 12px; color: var(--muted); }
.compose-toggles { display: flex; gap: 4px; }
.compose-toggles button {
  border: 1px solid var(--border); background: transparent;
  padding: 4px 8px; font-size: 12px; border-radius: 4px;
  color: var(--muted);
}
.compose-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
}
.ai-wrap { position: relative; display: flex; align-items: center; gap: 8px; }
.ai-btn {
  border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3;
  font-size: 13px; font-weight: 600;
  padding: 6px 12px; border-radius: 999px;
}
.ai-btn:active { background: #e0e7ff; }
.ai-btn:disabled { opacity: 0.6; }
.ai-undo {
  border: none; background: transparent; color: var(--accent);
  font-size: 13px; font-weight: 600; padding: 4px 6px;
}
.ai-scrim { position: fixed; inset: 0; z-index: 70; }
.ai-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 71;
  background: white; border: 1px solid var(--border);
  border-radius: 10px; box-shadow: 0 10px 24px rgba(0,0,0,0.14);
  min-width: 180px; overflow: hidden;
}
.ai-menu button {
  display: block; width: 100%; text-align: left;
  background: white; border: none;
  padding: 10px 14px; font-size: 14px; color: var(--text);
  border-bottom: 1px solid var(--border);
}
.ai-menu button:last-child { border-bottom: none; }
.ai-menu button:active { background: #eef2ff; }

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
