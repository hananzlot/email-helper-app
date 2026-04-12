'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { GmailMessage } from '@/types';

// ============ TYPES ============

interface ActionHistoryEntry {
  id: string;
  action: string;
  label: string;
  messageIds: string[];
  accountEmail: string;
  subjects: string[];
  timestamp: number;
  undoAction?: string; // The reverse action (e.g., markRead → markUnread)
  undone?: boolean;
}

// Reverse actions for undo
const REVERSE_ACTIONS: Record<string, string> = {
  markRead: 'markUnread',
  markUnread: 'markRead',
  star: 'unstar',
  unstar: 'star',
  archive: 'unarchive',
  trash: 'untrash',
};

// ============ ADMIN SETTINGS ============
function getMaxEmails(): number {
  try {
    const stored = localStorage.getItem('clearbox_admin_settings');
    if (stored) return JSON.parse(stored).max_emails_per_account || 100000;
  } catch {}
  return 100000;
}

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

// Clean snippet text — strip forwarded headers, quoted reply text, email addresses, and noise
function cleanSnippet(text: string): string {
  if (!text) return '';
  let s = text;
  // Remove "---------- Forwarded message ----------" and everything after
  s = s.replace(/-{5,}\s*Forwarded message\s*-{5,}[\s\S]*/i, '');
  // Remove "On <date>, <person> wrote:" quoted reply headers
  s = s.replace(/On\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\S]*wrote:\s*/gi, '');
  // Remove email headers like "From: ... Date: ... Subject: ... To: ..."
  s = s.replace(/\b(From|Date|Subject|To|Cc|Sent|Received):\s*[^\n]*/gi, '');
  // Remove email addresses in angle brackets
  s = s.replace(/<[^>]+@[^>]+>/g, '');
  // Remove standalone email addresses
  s = s.replace(/\S+@\S+\.\S+/g, '');
  // Remove "Re:" "Fwd:" "FW:" prefixes
  s = s.replace(/^(Re|Fwd|FW)\s*:\s*/gi, '');
  // Remove lines that are just dashes
  s = s.replace(/-{3,}/g, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // If result is too short after cleanup, return original (decoded)
  if (s.length < 10) return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
  return decodeHtmlEntities(s);
}

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
  const [replyAllMode, setReplyAllMode] = useState(false);
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
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>
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

  const [attachmentLoading, setAttachmentLoading] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<{ url: string; filename: string; mimeType: string } | null>(null);

  const attachmentIcon = (mime: string) => {
    if (mime.startsWith('image/')) return '🖼';
    if (mime.includes('pdf')) return '📄';
    if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
    if (mime.includes('document') || mime.includes('word')) return '📝';
    if (mime.includes('zip') || mime.includes('compressed')) return '📦';
    return '📎';
  };

  async function openAttachment(att: { filename: string; mimeType: string; attachmentId: string }) {
    setAttachmentLoading(att.attachmentId);
    try {
      const savedAccount = _currentAccount;
      if (accountEmail && accountEmail !== _currentAccount) setCurrentAccount(accountEmail);
      const res = await gmailGet('attachment', { id: messageId, attachmentId: att.attachmentId });
      if (accountEmail && accountEmail !== savedAccount) setCurrentAccount(savedAccount);

      if (!res.success || !res.data?.data) {
        showToast('Error', 'Could not load attachment');
        return;
      }
      // Gmail returns base64url — convert to standard base64
      const base64 = res.data.data.replace(/-/g, '+').replace(/_/g, '/');
      const dataUrl = `data:${att.mimeType};base64,${base64}`;

      // For images and PDFs, show inline preview
      if (att.mimeType.startsWith('image/') || att.mimeType === 'application/pdf') {
        setPreviewAttachment({ url: dataUrl, filename: att.filename, mimeType: att.mimeType });
      } else {
        // For other files, trigger download
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = att.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Downloaded', att.filename);
      }
    } catch (err) {
      console.error('Attachment fetch error:', err);
      showToast('Error', 'Failed to load attachment');
    } finally {
      setAttachmentLoading(null);
    }
  }

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
                      <button key={i} onClick={() => openAttachment(att)}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left hover:shadow-md transition-shadow"
                        style={{ background: 'white', borderColor: '#fbbf24', cursor: 'pointer', opacity: attachmentLoading === att.attachmentId ? 0.6 : 1 }}>
                        <span className="text-base">{attachmentLoading === att.attachmentId ? '⏳' : attachmentIcon(att.mimeType)}</span>
                        <div>
                          <div className="font-medium truncate" style={{ maxWidth: 180 }}>{att.filename}</div>
                          <div style={{ color: 'var(--muted)' }}>{formatSize(att.size)} · Click to {att.mimeType.startsWith('image/') || att.mimeType.includes('pdf') ? 'preview' : 'download'}</div>
                        </div>
                      </button>
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
                    accountEmail={accountEmail}
                    replyAll={replyAllMode}
                    cc={replyAllMode ? (email.cc || email.to || '').split(',').map((e: string) => e.trim()).filter((e: string) => e && !e.toLowerCase().includes(email.senderEmail.toLowerCase()) && !(accountEmail && e.toLowerCase().includes(accountEmail.toLowerCase()))).join(', ') : undefined}
                    onSent={() => { setReplyOpen(false); setReplyAllMode(false); showToast('Reply sent', `To: ${email.senderEmail}`); }}
                    onCancel={() => { setReplyOpen(false); setReplyAllMode(false); }}
                  />
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Sticky action bar */}
        {email && !loading && (
          <div className="border-t p-3 flex gap-2 flex-wrap items-center" style={{ borderColor: 'var(--border)', background: '#f8fafc' }}>
            <button onClick={() => { setReplyAllMode(false); setReplyOpen(!replyOpen); }}
              className="px-4 py-2 text-xs font-semibold rounded-lg text-white transition-transform active:scale-90" style={{ background: 'var(--accent)' }}>
              {replyOpen && !replyAllMode ? 'Cancel Reply' : 'Reply'}
            </button>
            <button onClick={() => { setReplyAllMode(true); setReplyOpen(!replyOpen || !replyAllMode); }}
              className="px-3 py-2 text-xs font-semibold rounded-lg transition-transform active:scale-90 border"
              style={{ borderColor: 'var(--accent)', color: replyOpen && replyAllMode ? '#fff' : 'var(--accent)', background: replyOpen && replyAllMode ? 'var(--accent)' : undefined }}>
              {replyOpen && replyAllMode ? 'Cancel' : 'Reply All'}
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

      {/* Attachment preview overlay */}
      {previewAttachment && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/60" onClick={() => setPreviewAttachment(null)} />
          <div className="relative z-10 bg-white rounded-xl shadow-2xl max-w-3xl max-h-[85vh] overflow-auto" style={{ minWidth: 300 }}>
            <div className="sticky top-0 flex items-center justify-between p-3 border-b bg-white rounded-t-xl" style={{ borderColor: 'var(--border)' }}>
              <span className="font-medium text-sm truncate">{previewAttachment.filename}</span>
              <div className="flex gap-2">
                <a href={previewAttachment.url} download={previewAttachment.filename}
                  className="px-3 py-1 text-xs font-medium rounded-lg text-white" style={{ background: 'var(--accent)' }}>
                  Download
                </a>
                <button onClick={() => setPreviewAttachment(null)} className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>✕</button>
              </div>
            </div>
            <div className="p-4 flex items-center justify-center">
              {previewAttachment.mimeType.startsWith('image/') ? (
                <img src={previewAttachment.url} alt={previewAttachment.filename} className="max-w-full max-h-[70vh] rounded-lg" />
              ) : previewAttachment.mimeType === 'application/pdf' ? (
                <iframe src={previewAttachment.url} className="w-full rounded-lg" style={{ height: '70vh' }} title={previewAttachment.filename} />
              ) : (
                <div className="text-sm py-8" style={{ color: 'var(--muted)' }}>Preview not available for this file type</div>
              )}
            </div>
          </div>
        </div>
      )}

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

type Tab = 'home' | 'inbox' | 'reply-queue' | 'snoozed' | 'cleanup' | 'sent' | 'follow-up' | 'priorities' | 'accounts' | 'search-reviews';
// Note: 'priorities' and 'accounts' are accessible via the Settings gear menu, not the tab bar.

interface ConnectedAccount {
  email: string;
  is_primary: boolean;
  is_active_inbox: boolean;
  display_name: string | null;
  created_at: string;
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  // Returning users land on Top Tiers tab
  useEffect(() => {
    if (localStorage.getItem('email_helper_visited')) setActiveTab('reply-queue');
  }, []);
  const [layoutMode, setLayoutMode] = useState<'cards' | 'split'>('split');
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  const [account, setAccount] = useState<string>('');
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [profile, setProfile] = useState<{ emailAddress: string } | null>(null);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<{ loaded: number; total: number | null; phase: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ title: string; subtitle?: string; undoAction?: () => void; expiresAt?: number } | null>(null);
  // Pending undo actions — delayed destructive operations that can be cancelled
  const [pendingUndo, setPendingUndo] = useState<{ key: string; timer: NodeJS.Timeout; action: () => Promise<void> } | null>(null);
  // Quick reply templates
  const [quickReplyTemplates, setQuickReplyTemplates] = useState<{ id: string; label: string; body: string }[]>([]);
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
  // Global search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GmailMessage[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  const [searchSelectedIds, setSearchSelectedIds] = useState<Set<string>>(new Set());
  const [searchSelectionActive, setSearchSelectionActive] = useState<GmailMessage[]>([]);
  // Auth error state — show login prompt instead of auto-redirect loop
  const [authError, setAuthError] = useState(false);
  // Tab counts — each tab reports its count for display in tab bar
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  // Action history — log of all actions taken, with undo support
  // Persisted to Supabase (encrypted) so history survives refreshes (7-day window)
  const [actionHistory, setActionHistory] = useState<ActionHistoryEntry[]>([]);
  const [showActionHistory, setShowActionHistory] = useState(false);
  // Load action history from Supabase on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/emailHelperV2/action-history');
        if (res.ok) {
          const json = await res.json();
          if (json.data) setActionHistory(json.data);
        }
      } catch {}
    })();
  }, []);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

  // Global search — searches Gmail via API across all accounts
  async function performSearch(query: string) {
    if (!query.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const q = query.toLowerCase();
    const seenIds = new Set<string>();

    // Step 1: Instant results from in-memory messages
    const localResults = messages.filter(m =>
      m.sender?.toLowerCase().includes(q) ||
      m.senderEmail?.toLowerCase().includes(q) ||
      m.subject?.toLowerCase().includes(q) ||
      m.snippet?.toLowerCase().includes(q)
    );
    localResults.forEach(m => seenIds.add(m.id));
    if (localResults.length > 0) {
      setSearchResults(localResults.slice(0, 50));
    }

    // Step 2: Search Supabase cache for messages not already found
    try {
      const cacheRes = await apiGet('inbox-cache');
      if (cacheRes.success && cacheRes.data?.messages?.length > 0) {
        const cacheMatches = cacheRes.data.messages
          .filter((m: { sender: string; sender_email: string; subject: string; snippet: string; gmail_id: string }) =>
            !seenIds.has(m.gmail_id) && (
              m.sender?.toLowerCase().includes(q) ||
              m.sender_email?.toLowerCase().includes(q) ||
              m.subject?.toLowerCase().includes(q) ||
              m.snippet?.toLowerCase().includes(q)
            )
          )
          .map((m: { gmail_id: string; thread_id: string; sender: string; sender_email: string; subject: string; snippet: string; date: string; is_unread: boolean; label_ids: string[]; account_email: string }) => ({
            id: m.gmail_id, threadId: m.thread_id, sender: m.sender, senderEmail: m.sender_email,
            subject: m.subject, snippet: m.snippet, date: m.date, isUnread: m.is_unread,
            labelIds: m.label_ids, accountEmail: m.account_email, body: '', bodyHtml: '', to: '', cc: '',
          } as GmailMessage));
        cacheMatches.forEach((m: GmailMessage) => seenIds.add(m.id));
        if (cacheMatches.length > 0) {
          setSearchResults(prev => [...prev, ...cacheMatches].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 100));
        }
      }
    } catch {}

    // Step 3: Also search Gmail API for messages not found locally or in cache
    try {
      const gmailQuery = `{from:${query} subject:${query}}`;
      const gmailResults: GmailMessage[] = [];

      if (unified && accounts.length > 1) {
        const savedAccount = _currentAccount;
        for (const acct of accounts) {
          setCurrentAccount(acct.email);
          try {
            const res = await gmailGet('search', { q: gmailQuery, max: '20' });
            if (res.success && res.data?.messages) {
              for (const msg of res.data.messages) {
                if (!seenIds.has(msg.id)) {
                  gmailResults.push({ ...msg, accountEmail: acct.email });
                  seenIds.add(msg.id);
                }
              }
            }
          } catch (e) { console.error(`Search failed for ${acct.email}:`, e); }
        }
        setCurrentAccount(savedAccount);
      } else {
        const res = await gmailGet('search', { q: gmailQuery, max: '30' });
        if (res.success && res.data?.messages) {
          for (const msg of res.data.messages) {
            if (!seenIds.has(msg.id)) {
              gmailResults.push({ ...msg, accountEmail: _currentAccount });
              seenIds.add(msg.id);
            }
          }
        }
      }

      if (gmailResults.length > 0) {
        setSearchResults(prev => {
          const merged = [...prev, ...gmailResults].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return merged.slice(0, 100);
        });
      }
    } catch (err) {
      console.error('Gmail search error:', err);
    } finally {
      setSearchLoading(false);
    }
  }

  // Debounced search — triggers after 400ms of no typing
  function handleSearchInput(value: string) {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimerRef.current = setTimeout(() => performSearch(value), 400);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchSelectedIds(new Set());
  }

  const splitSupportedTabs: Tab[] = ['inbox', 'reply-queue', 'follow-up', 'snoozed', 'cleanup', 'sent', 'search-reviews'];
  const [splitPreviewId, setSplitPreviewId] = useState<string | null>(null);
  const [splitPreviewAccount, setSplitPreviewAccount] = useState<string | undefined>(undefined);

  // Draggable split pane width (percentage of container), persisted in localStorage
  const [splitLeftPct, setSplitLeftPct] = useState<number>(40);
  useEffect(() => {
    try { const saved = localStorage.getItem('clearbox_split_pct'); if (saved) setSplitLeftPct(Number(saved)); }
    catch {}
  }, []);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  function handleSplitDragStart(e: React.MouseEvent) {
    e.preventDefault();
    isDraggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(70, Math.max(20, pct));
      setSplitLeftPct(clamped);
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save to localStorage
      try {
        const el = splitContainerRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          // Read current state — we can't access splitLeftPct here due to closure, so read from DOM
        }
      } catch {}
      setSplitLeftPct(prev => { try { localStorage.setItem('clearbox_split_pct', String(prev)); } catch {} return prev; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function openPreview(messageId: string, acctEmail?: string) {
    // In split mode on supported tabs, show in side panel instead of modal
    if (layoutMode === 'split' && !isMobile && splitSupportedTabs.includes(activeTab)) {
      setSplitPreviewId(messageId);
      setSplitPreviewAccount(acctEmail);
      return;
    }
    setPreviewMessageId(messageId);
    setPreviewAccount(acctEmail);
  }

  // Force open the full dialog modal (used on double-click)
  function openDialogPreview(messageId: string, acctEmail?: string) {
    setPreviewMessageId(messageId);
    setPreviewAccount(acctEmail);
  }

  // Auto-select first email in split/pane mode when switching tabs
  useEffect(() => {
    setSplitPreviewId(null);
    setSplitPreviewAccount(undefined);
    if (layoutMode !== 'split' || isMobile) return;
    // Retry until content renders (async tabs like Triage load data after mount)
    let attempts = 0;
    const maxAttempts = 15;
    const trySelect = () => {
      const container = splitContainerRef.current;
      if (!container) return;
      const first = container.querySelector('[data-preview-id]') as HTMLElement | null;
      if (first) {
        setSplitPreviewId(first.getAttribute('data-preview-id') || null);
        setSplitPreviewAccount(first.getAttribute('data-preview-account') || undefined);
      } else if (attempts < maxAttempts) {
        attempts++;
        timer = setTimeout(trySelect, 200);
      }
    };
    let timer = setTimeout(trySelect, 100);
    return () => clearTimeout(timer);
  }, [activeTab, layoutMode, isMobile]);

  // Arrow key navigation in split view
  useEffect(() => {
    if (layoutMode !== 'split' || isMobile) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      // Don't intercept if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const container = splitContainerRef.current;
      if (!container) return;
      // Find all previewable items in the left panel via data attribute
      const items = Array.from(container.querySelectorAll('[data-preview-id]')) as HTMLElement[];
      if (items.length === 0) return;

      e.preventDefault();
      const currentIdx = items.findIndex(el => el.getAttribute('data-preview-id') === splitPreviewId);
      let nextIdx: number;
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx < 0 ? 0 : Math.min(items.length - 1, currentIdx + 1);
      } else {
        nextIdx = currentIdx < 0 ? 0 : Math.max(0, currentIdx - 1);
      }
      const nextEl = items[nextIdx];
      const msgId = nextEl.getAttribute('data-preview-id') || '';
      const acctEmail = nextEl.getAttribute('data-preview-account') || undefined;
      setSplitPreviewId(msgId);
      setSplitPreviewAccount(acctEmail);
      // Scroll into view
      nextEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [layoutMode, isMobile, splitPreviewId]);

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
      const dashError = params.get('error');
      if (dashError) {
        showToast('Error', dashError);
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
    setTabCounts({});
    showToast('Switched account', newAccount);
    // Reload inbox + triage data for the new account
    setTriageVersion(v => v + 1);
    setTimeout(() => loadInbox(true), 50);
  }

  function switchToUnified() {
    setUnified(true);
    setMessages([]);
    setProfile(null);
    setTabCounts({});
    showToast('Unified view', 'Showing all accounts');
    loadUnifiedInbox(true);
  }

  // Save messages to Supabase cache in background (fire-and-forget)
  async function saveToCacheBackground(acctEmail: string, msgs: GmailMessage[]) {
    if (!msgs.length) return;
    const batch = msgs.map(m => ({
      id: m.id, threadId: m.threadId, sender: m.sender, senderEmail: m.senderEmail,
      subject: m.subject, snippet: m.snippet, date: m.date, isUnread: m.isUnread, labelIds: m.labelIds,
    }));
    // Send sequentially in small chunks to avoid Netlify timeout + payload limits
    for (let i = 0; i < batch.length; i += 100) {
      try {
        const res = await fetch(withAccount('/api/emailHelperV2/inbox-cache'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_email: acctEmail, messages: batch.slice(i, i + 100) }),
        }).then(r => r.json());
        if (!res.success) console.error('Cache save failed:', res.error);
      } catch (err) {
        console.error('Cache save error:', err);
      }
    }
  }

  // Load inbox: cache-first for instant display, then refresh from Gmail in background
  // silent=true skips the loading spinner (for background refreshes)
  const loadInbox = useCallback(async (silentTriage = false, silent = false) => {
    if (!silent) setLoading(true);

    // Step 1: Try loading from cache for instant display
    let cacheHit = false;
    let cachedMsgCount = 0;
    try {
      const cacheRes = await apiGet('inbox-cache');
      if (cacheRes.success && cacheRes.data?.messages?.length > 0) {
        const cachedMsgs = cacheRes.data.messages.map((m: { gmail_id: string; thread_id: string; sender: string; sender_email: string; subject: string; snippet: string; date: string; is_unread: boolean; label_ids: string[]; account_email: string }) => ({
          id: m.gmail_id, threadId: m.thread_id, sender: m.sender, senderEmail: m.sender_email,
          subject: m.subject, snippet: m.snippet, date: m.date, isUnread: m.is_unread,
          labelIds: m.label_ids, accountEmail: m.account_email, body: '', bodyHtml: '', to: '', cc: '',
        } as GmailMessage));
        setMessages(cachedMsgs);
        setLoading(false);
        cacheHit = true;
        cachedMsgCount = cachedMsgs.length;
      }
    } catch {
      // Cache unavailable — proceed with full Gmail fetch
    }

    // Step 2: Fetch from Gmail
    try {
      const [profileRes, labelRes, inboxRes] = await Promise.all([
        gmailGet('profile'),
        gmailGet('labelInfo', { labelId: 'INBOX' }),
        gmailGet('inbox', { q: 'in:inbox', max: '200' }),
      ]);
      if (!profileRes.success && (profileRes.error?.includes('Not authenticated') || profileRes.error?.includes('auth failed'))) {
        setAuthError(true);
        setLoading(false);
        setLoadingProgress(null);
        return;
      }
      if (profileRes.success) setProfile(profileRes.data);
      const exactInboxTotal = labelRes.success ? labelRes.data.messagesTotal : 0;

      if (inboxRes.success && inboxRes.data?.messages) {
        const freshMsgs = inboxRes.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: account }));
        saveToCacheBackground(account, freshMsgs);

        if (cacheHit && cachedMsgCount > 200) {
          // Large cache exists — merge newest from Gmail with cache, then resume pagination
          const cachedIds = new Set<string>();
          setMessages(prev => {
            prev.forEach(m => cachedIds.add(m.id));
            freshMsgs.forEach((m: GmailMessage) => cachedIds.add(m.id));
            const newMsgs = freshMsgs.filter((m: GmailMessage) => !cachedIds.has(m.id) || !prev.some(p => p.id === m.id));
            // Always save fresh first page to cache
            if (newMsgs.length === 0) return prev;
            return [...newMsgs, ...prev].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          });
          setLoading(false);

          // Resume pagination if cache didn't cover the full inbox
          const MAX_MESSAGES = getMaxEmails();
          const totalToLoad = Math.min(exactInboxTotal || cachedMsgCount, MAX_MESSAGES);
          if (cachedMsgCount < totalToLoad && inboxRes.data.nextPageToken) {
            setLoadingProgress({ loaded: cachedMsgCount, total: totalToLoad, phase: `Resuming... ${cachedMsgCount.toLocaleString()} cached, loading more...` });
            let nextToken = inboxRes.data.nextPageToken;
            let totalLoaded = cachedMsgCount;
            // Paginate through Gmail, skipping pages we already have in cache
            while (nextToken && totalLoaded < MAX_MESSAGES) {
              let pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '200', pageToken: nextToken });
              // Retry on failure (Gmail rate limit / transient errors)
              let retryFailed = false;
              for (let retry = 0; retry < 3 && !pageRes.success; retry++) {
                await new Promise(r => setTimeout(r, 5000 * (retry + 1)));
                pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '200', pageToken: nextToken });
              }
              if (!pageRes.success || !pageRes.data?.messages?.length) {
                // Try smaller batch to get past problematic page
                pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '50', pageToken: nextToken });
                if (!pageRes.success || !pageRes.data?.messages?.length) break;
              }
              const pageMsgs = pageRes.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: account }));
              // Filter out messages already in cache
              const newPageMsgs = pageMsgs.filter((m: GmailMessage) => !cachedIds.has(m.id));
              if (newPageMsgs.length > 0) {
                setMessages(prev => [...prev, ...newPageMsgs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
                saveToCacheBackground(account, newPageMsgs);
                newPageMsgs.forEach((m: GmailMessage) => cachedIds.add(m.id));
              }
              totalLoaded += pageMsgs.length; // Count all, not just new (for progress)
              nextToken = pageRes.data.nextPageToken;
              const displayTotal = Math.max(totalToLoad, totalLoaded);
              const minutesLeft = nextToken ? Math.max(1, Math.ceil((displayTotal - totalLoaded) / 200 * 0.5)) : 0;
              setLoadingProgress({ loaded: totalLoaded, total: displayTotal, phase: nextToken ? `Loading emails... ~${minutesLeft} min remaining` : `Loaded ${totalLoaded.toLocaleString()} emails` });
            }
            setLoadingProgress(null);
          } else {
            setLoadingProgress(null);
          }
        } else {
          // No cache or small cache — full pagination
          setMessages(freshMsgs);
          const totalToLoad = exactInboxTotal || inboxRes.data.total || freshMsgs.length;
          setLoadingProgress({ loaded: freshMsgs.length, total: totalToLoad, phase: `Loading ${totalToLoad.toLocaleString()} emails...` });
          let nextToken = inboxRes.data.nextPageToken;
          let totalLoaded = freshMsgs.length;
          const MAX_MESSAGES = getMaxEmails();
          if (nextToken && totalToLoad > 200) {
            setLoading(false);
            setLoadingProgress({ loaded: totalLoaded, total: Math.min(totalToLoad, MAX_MESSAGES), phase: `Loading ${Math.min(totalToLoad, MAX_MESSAGES).toLocaleString()} emails...` });
          }
          while (nextToken && totalLoaded < MAX_MESSAGES) {
            const pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '200', pageToken: nextToken });
            if (!pageRes.success || !pageRes.data?.messages?.length) break;
            const pageMsgs = pageRes.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: account }));
            setMessages(prev => [...prev, ...pageMsgs]);
            totalLoaded += pageMsgs.length;
            nextToken = pageRes.data.nextPageToken;
            saveToCacheBackground(account, pageMsgs);
            const displayTotal = Math.max(totalToLoad, totalLoaded);
            const minutesLeft = nextToken ? Math.max(1, Math.ceil((displayTotal - totalLoaded) / 200 * 0.5)) : 0;
            setLoadingProgress({ loaded: totalLoaded, total: displayTotal, phase: nextToken ? `Loading emails... ~${minutesLeft} min remaining` : `Loaded ${totalLoaded.toLocaleString()} emails` });
          }
          setLoadingProgress(null);
        }
      } else if (!cacheHit) {
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to load inbox:', err);
    } finally {
      setLoading(false);
      setLoadingProgress(null);
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

  // Load unified inbox: cache-first, then refresh from Gmail in background
  // silent=true skips the loading spinner (for background refreshes)
  const loadUnifiedInbox = useCallback(async (silentTriage = false, silent = false) => {
    if (accounts.length === 0) return;
    if (!silent) setLoading(true);

    // Step 1: Try loading from cache (returns all accounts)
    let unifiedCacheHit = false;
    let unifiedCacheCount = 0;
    try {
      const cacheRes = await apiGet('inbox-cache');
      if (cacheRes.success && cacheRes.data?.messages?.length > 0) {
        const cachedMsgs = cacheRes.data.messages.map((m: { gmail_id: string; thread_id: string; sender: string; sender_email: string; subject: string; snippet: string; date: string; is_unread: boolean; label_ids: string[]; account_email: string }) => ({
          id: m.gmail_id, threadId: m.thread_id, sender: m.sender, senderEmail: m.sender_email,
          subject: m.subject, snippet: m.snippet, date: m.date, isUnread: m.is_unread,
          labelIds: m.label_ids, accountEmail: m.account_email, body: '', bodyHtml: '', to: '', cc: '',
        } as GmailMessage));
        cachedMsgs.sort((a: GmailMessage, b: GmailMessage) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setMessages(cachedMsgs);
        setLoading(false);
        unifiedCacheHit = true;
        unifiedCacheCount = cachedMsgs.length;
      }
    } catch {}

    // Step 2: Fetch from Gmail
    try {
      const savedAccount = _currentAccount;
      const primaryAcct = accounts.find(a => a.is_primary)?.email || accounts[0].email;
      setCurrentAccount(primaryAcct);
      const profileRes = await gmailGet('profile');
      if (!profileRes.success && (profileRes.error?.includes('Not authenticated') || profileRes.error?.includes('auth failed'))) {
        setAuthError(true);
        setLoading(false);
        setLoadingProgress(null);
        return;
      }
      if (profileRes.success) setProfile(profileRes.data);

      // Fetch first page + label info from each account
      const freshMessages: GmailMessage[] = [];
      const accountTokens: { email: string; nextPageToken?: string }[] = [];
      await Promise.all(accounts.map(async (acct) => {
        setCurrentAccount(acct.email);
        try {
          const res = await gmailGet('inbox', { q: 'in:inbox', max: '200' });
          if (res.success && res.data?.messages) {
            const acctMsgs = res.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: acct.email }));
            freshMessages.push(...acctMsgs);
            saveToCacheBackground(acct.email, acctMsgs);
            if (res.data.nextPageToken) {
              accountTokens.push({ email: acct.email, nextPageToken: res.data.nextPageToken });
            }
          }
        } catch (e) {
          console.error(`Failed to load inbox for ${acct.email}:`, e);
        }
      }));

      if (unifiedCacheHit && unifiedCacheCount > 200) {
        // Large cache — merge newest from Gmail, then resume pagination for uncached
        const cachedIds = new Set<string>();
        setMessages(prev => {
          prev.forEach(m => cachedIds.add(m.id));
          freshMessages.forEach(m => cachedIds.add(m.id));
          const newMsgs = freshMessages.filter(m => !prev.some(p => p.id === m.id));
          if (newMsgs.length === 0) return prev;
          return [...newMsgs, ...prev].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        });
        setCurrentAccount(savedAccount);
        setLoading(false);

        // Resume pagination for accounts that have more uncached messages
        if (accountTokens.length > 0) {
          setLoadingProgress({ loaded: unifiedCacheCount, total: null, phase: `Resuming... ${unifiedCacheCount.toLocaleString()} cached, loading more...` });
          const MAX_PER_ACCOUNT = getMaxEmails();
          let grandTotal = unifiedCacheCount;
          for (const at of accountTokens) {
            let nextToken = at.nextPageToken;
            let loaded = 0;
            while (nextToken && loaded < MAX_PER_ACCOUNT) {
              setCurrentAccount(at.email);
              let pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '200', pageToken: nextToken });
              // Retry on failure (Gmail rate limit / transient errors)
              let retryFailed = false;
              for (let retry = 0; retry < 3 && !pageRes.success; retry++) {
                await new Promise(r => setTimeout(r, 5000 * (retry + 1)));
                pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '200', pageToken: nextToken });
              }
              if (!pageRes.success || !pageRes.data?.messages?.length) {
                // Try smaller batch to get past problematic page
                pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '50', pageToken: nextToken });
                if (!pageRes.success || !pageRes.data?.messages?.length) break;
              }
              const pageMsgs = pageRes.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: at.email }));
              const newPageMsgs = pageMsgs.filter((m: GmailMessage) => !cachedIds.has(m.id));
              if (newPageMsgs.length > 0) {
                setMessages(prev => [...prev, ...newPageMsgs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
                saveToCacheBackground(at.email, newPageMsgs);
                newPageMsgs.forEach((m: GmailMessage) => cachedIds.add(m.id));
              }
              loaded += pageMsgs.length;
              grandTotal += pageMsgs.length;
              nextToken = pageRes.data.nextPageToken;
              setLoadingProgress({ loaded: grandTotal, total: null, phase: `Loading emails... ${grandTotal.toLocaleString()} loaded` });
            }
          }
          setCurrentAccount(savedAccount);
          setLoadingProgress(null);
        } else {
          setLoadingProgress(null);
        }
      } else {
        // No cache — full pagination
        freshMessages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setMessages(freshMessages);
        setCurrentAccount(savedAccount);
        setLoading(false);

        if (accountTokens.length > 0) {
          setLoadingProgress({ loaded: freshMessages.length, total: null, phase: `Loading more emails across ${accounts.length} accounts...` });
        } else {
          setLoadingProgress(null);
        }

        const MAX_PER_ACCOUNT = getMaxEmails();
        let grandTotal = freshMessages.length;
        for (const at of accountTokens) {
          let nextToken = at.nextPageToken;
          let loaded = freshMessages.filter(m => m.accountEmail === at.email).length;
          while (nextToken && loaded < MAX_PER_ACCOUNT) {
            setCurrentAccount(at.email);
            const pageRes = await gmailGet('inbox', { q: 'in:inbox', max: '200', pageToken: nextToken });
            if (!pageRes.success || !pageRes.data?.messages?.length) break;
            const pageMsgs = pageRes.data.messages.map((m: GmailMessage) => ({ ...m, accountEmail: at.email }));
            setMessages(prev => [...prev, ...pageMsgs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
            saveToCacheBackground(at.email, pageMsgs);
            loaded += pageMsgs.length;
            grandTotal += pageMsgs.length;
            nextToken = pageRes.data.nextPageToken;
            const minutesLeft = nextToken ? Math.max(1, Math.ceil((grandTotal * 0.2) / 200 * 0.5)) : 0;
            setLoadingProgress({ loaded: grandTotal, total: null, phase: nextToken ? `Loading emails... ${grandTotal.toLocaleString()} loaded` : `Loaded ${grandTotal.toLocaleString()} emails` });
          }
        }
        setCurrentAccount(savedAccount);
        setLoadingProgress(null);
      }
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
    // Mark user as returning so next login lands on Triage
    if (isFirstLoad) localStorage.setItem('email_helper_visited', '1');
  }, [account, unified, accounts.length]);

  // Auto-refresh every 2 minutes for inbox data
  useEffect(() => {
    if (!account) return;
    const interval = setInterval(() => {
      if (unified && accounts.length > 1) {
        loadUnifiedInbox(true, true);
      } else {
        loadInbox(true, true);
      }
    }, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [account, unified, accounts.length, loadInbox, loadUnifiedInbox]);

  // Background sync state — tracks server-side inbox caching progress
  const [syncProgress, setSyncProgress] = useState<Record<string, { cached: number; total: number; done: boolean; speed: number; eta: string }>>({});
  const syncRunningRef = React.useRef(false);

  // Continuous background sync — runs until all accounts are fully cached
  useEffect(() => {
    if (accounts.length === 0 || !account) return;
    if (syncRunningRef.current) return;
    syncRunningRef.current = true;

    let cancelled = false;

    async function syncAccount(acctEmail: string) {
      let totalCached = 0;
      let messagesThisRun = 0;
      const startTime = Date.now();
      let retries = 0;

      // Show initial "scanning" state immediately
      setSyncProgress(prev => ({
        ...prev,
        [acctEmail]: { cached: 0, total: 0, done: false, speed: 0, eta: 'Starting...' },
      }));

      while (!cancelled && retries < 10) {
        try {
          const res = await fetch(withAccount('/api/emailHelperV2/inbox-cache/sync'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: undefined, account_email: acctEmail }),
          }).then(r => r.json());

          if (!res.success) {
            retries++;
            await new Promise(r => setTimeout(r, 5000 * retries));
            continue;
          }
          retries = 0; // Reset on success

          const { cachedThisPage, totalCached: serverCachedCount, inboxTotal, done } = res.data;
          messagesThisRun += (cachedThisPage || 0);
          // Use the accurate count from server
          if (serverCachedCount && serverCachedCount > 0) {
            totalCached = serverCachedCount;
          } else {
            totalCached += (cachedThisPage || 0);
          }

          // Calculate speed and ETA
          const elapsed = (Date.now() - startTime) / 1000;
          // Cap display: cached can exceed inbox total if old messages were archived/deleted
          const displayCached = Math.min(totalCached, inboxTotal || totalCached);
          const remaining = Math.max(0, (inboxTotal || 0) - totalCached);
          const isSynced = done || totalCached >= (inboxTotal || 0);
          const speed = elapsed > 5 && messagesThisRun > 0 ? Math.round(messagesThisRun / elapsed * 60) : 0;
          const etaMinutes = remaining <= 0 ? 0 : speed > 0 ? Math.ceil(remaining / speed) : Math.ceil(remaining / 200 * 3 / 60);
          const pct = (inboxTotal || 0) > 0 ? Math.min(100, Math.round((totalCached / (inboxTotal || 1)) * 100)) : 0;
          const eta = isSynced ? 'Synced' :
            speed === 0 ? `${pct}% — scanning...` :
            etaMinutes < 60 ? `${pct}% — ~${etaMinutes}m remaining` :
            `${pct}% — ~${Math.floor(etaMinutes / 60)}h ${etaMinutes % 60}m remaining`;

          setSyncProgress(prev => ({
            ...prev,
            [acctEmail]: { cached: displayCached, total: inboxTotal || 0, done: isSynced, speed, eta },
          }));

          if (done) break;
          await new Promise(r => setTimeout(r, 500));
        } catch {
          retries++;
          await new Promise(r => setTimeout(r, 5000 * retries));
        }
      }
    }

    async function runAllSyncs() {
      // Sync accounts sequentially
      for (const acct of accounts) {
        if (cancelled) break;
        await syncAccount(acct.email);
      }
      syncRunningRef.current = false;

      // After initial sync completes, keep checking for new messages every 5 minutes
      if (!cancelled) {
        const keepAlive = setInterval(async () => {
          for (const acct of accounts) {
            // Fetch newest page (no resume token = page 1) to catch new emails
            try {
              await fetch(withAccount('/api/emailHelperV2/inbox-cache/sync'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_email: acct.email, pageToken: null }),
              });
            } catch {}
          }
        }, 5 * 60 * 1000);
        return () => clearInterval(keepAlive);
      }
    }

    // Start after a short delay to let the UI load first
    const timer = setTimeout(runAllSyncs, 3000);
    return () => { cancelled = true; clearTimeout(timer); syncRunningRef.current = false; };
  }, [accounts.length, account]);

  function showToast(title: string, subtitle?: string, undoAction?: () => void) {
    const expiresAt = undoAction ? Date.now() + 5000 : undefined;
    setToast({ title, subtitle, undoAction, expiresAt });
    setTimeout(() => setToast(prev => {
      // Only clear if this is still the same toast
      if (prev?.title === title && prev?.subtitle === subtitle) return null;
      return prev;
    }), undoAction ? 5500 : 3500);
  }

  // Load quick reply templates from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('email_helper_quick_replies');
      if (saved) {
        setQuickReplyTemplates(JSON.parse(saved));
      } else {
        // Default templates
        const defaults = [
          { id: '1', label: 'Acknowledge', body: 'Thanks for sending this over — got it!' },
          { id: '2', label: 'Will review', body: 'Thanks! Let me review and get back to you.' },
          { id: '3', label: 'Schedule call', body: 'Good question — let\'s set up a quick call to discuss. What times work for you this week?' },
          { id: '4', label: 'Loop back', body: 'Appreciate the update. Let me check on this and circle back shortly.' },
          { id: '5', label: 'Approve', body: 'Looks good — approved. Thanks!' },
        ];
        setQuickReplyTemplates(defaults);
        localStorage.setItem('email_helper_quick_replies', JSON.stringify(defaults));
      }
    } catch (e) { console.error('Failed to load quick reply templates:', e); }
  }, []);

  // Advance split preview to next item (used by snooze and other non-handleAction paths)
  function advancePreview(messageId: string) {
    if (splitPreviewId && splitPreviewId === messageId) {
      const container = splitContainerRef.current;
      if (container) {
        const allPreviews = Array.from(container.querySelectorAll('[data-preview-id]')) as HTMLElement[];
        const currentIdx = allPreviews.findIndex(el => el.getAttribute('data-preview-id') === messageId);
        const next = allPreviews[currentIdx + 1] || allPreviews[currentIdx - 1];
        if (next) {
          setSplitPreviewId(next.getAttribute('data-preview-id') || null);
          setSplitPreviewAccount(next.getAttribute('data-preview-account') || undefined);
        } else {
          setSplitPreviewId(null);
        }
      }
    }
  }

  async function handleAction(action: string, messageIds: string[], label?: string, overrideAccount?: string) {
    setActionLoading(messageIds[0]);

    const actionLabels: Record<string, string> = {
      archive: 'Archived', trash: 'Trashed', delete: 'Deleted',
      markRead: 'Marked read', markUnread: 'Marked unread',
      star: 'Starred', unstar: 'Unstarred',
      addLabel: 'Label added', removeLabel: 'Label removed',
    };

    // Log action to history (optimistic local + persist to Supabase)
    const subjects = messages.filter(m => messageIds.includes(m.id)).map(m => m.subject || '(no subject)');
    const tempId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const historyEntry: ActionHistoryEntry = {
      id: tempId,
      action,
      label: actionLabels[action] || action,
      messageIds,
      accountEmail: overrideAccount || _currentAccount,
      subjects: subjects.length > 0 ? subjects : messageIds.map(() => '(email)'),
      timestamp: Date.now(),
      undoAction: REVERSE_ACTIONS[action],
    };
    setActionHistory(prev => [historyEntry, ...prev].slice(0, 500));
    // Persist to Supabase (fire-and-forget, update local id on success)
    fetch('/api/emailHelperV2/action-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action, label: historyEntry.label, messageIds, accountEmail: historyEntry.accountEmail,
        subjects: historyEntry.subjects, undoAction: historyEntry.undoAction,
      }),
    }).then(r => r.json()).then(json => {
      if (json.data?.id) {
        setActionHistory(prev => prev.map(h => h.id === tempId ? { ...h, id: json.data.id } : h));
      }
    }).catch(() => {});

    // Advance split preview to next message if current one is being removed
    if (['archive', 'trash', 'delete', 'markRead'].includes(action)) {
      for (const id of messageIds) advancePreview(id);
    }

    // For undoable actions (archive/trash), animate out immediately but delay the API call
    const isUndoable = ['archive', 'trash'].includes(action);

    if (isUndoable) {
      // Animate out immediately for snappy feel
      const animType = action as 'trash' | 'archive';
      const anims: Record<string, 'trash' | 'delete' | 'archive'> = {};
      messageIds.forEach(id => { anims[id] = animType; });
      setAnimatingOut(prev => ({ ...prev, ...anims }));

      // Store the removed messages so we can restore on undo
      const removedMessages = messages.filter(m => messageIds.includes(m.id));

      setTimeout(() => {
        setMessages(prev => prev.filter(m => !messageIds.includes(m.id)));
        setAnimatingOut(prev => {
          const next = { ...prev };
          messageIds.forEach(id => delete next[id]);
          return next;
        });
      }, 400);

      // Mark queue items as done immediately in UI
      for (const msgId of messageIds) {
        apiPut('queue', { message_id: msgId, status: 'done' }).catch(() => {});
      }
      setTriageVersion(v => v + 1);

      // Cancel any existing pending undo
      if (pendingUndo) {
        clearTimeout(pendingUndo.timer);
        pendingUndo.action(); // Execute the previous pending action immediately
      }

      const undoKey = `${action}-${Date.now()}`;

      // The actual API call — delayed 5 seconds
      const executeAction = async () => {
        const savedAccount = _currentAccount;
        if (overrideAccount && overrideAccount !== _currentAccount) setCurrentAccount(overrideAccount);
        await gmailPost(action, { action, messageIds });
        if (overrideAccount) setCurrentAccount(savedAccount);
        setPendingUndo(prev => prev?.key === undoKey ? null : prev);
      };

      const timer = setTimeout(() => { executeAction(); }, 5000);

      const undoFn = () => {
        clearTimeout(timer);
        // Restore messages to the list
        setMessages(prev => [...removedMessages, ...prev].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
        // Re-activate queue items
        for (const msgId of messageIds) {
          apiPut('queue', { message_id: msgId, status: 'active' }).catch(() => {});
        }
        setTriageVersion(v => v + 1);
        setPendingUndo(null);
        showToast('Undone', `${messageIds.length} message${messageIds.length > 1 ? 's' : ''} restored`);
      };

      setPendingUndo({ key: undoKey, timer, action: executeAction });
      // Remove from inbox cache
      apiDelete('inbox-cache', { account_email: overrideAccount || _currentAccount, gmail_ids: messageIds }).catch(() => {});
      showToast(
        actionLabels[action] || action,
        `${messageIds.length} message${messageIds.length > 1 ? 's' : ''}`,
        undoFn
      );
      setActionLoading(null);
      return;
    }

    // Non-undoable actions: execute immediately
    try {
      const params: Record<string, unknown> = { action, messageIds };
      if (label) params.labelId = label;
      const savedAccount = _currentAccount;
      if (overrideAccount && overrideAccount !== _currentAccount) {
        setCurrentAccount(overrideAccount);
      }
      const res = await gmailPost(action, params);
      if (overrideAccount) setCurrentAccount(savedAccount);
      if (res.success) {
        showToast(actionLabels[action] || action, `${messageIds.length} message${messageIds.length > 1 ? 's' : ''}`);
        if (action === 'delete') {
          const anims: Record<string, 'trash' | 'delete' | 'archive'> = {};
          messageIds.forEach(id => { anims[id] = 'delete'; });
          setAnimatingOut(prev => ({ ...prev, ...anims }));
          setTimeout(() => {
            setMessages(prev => prev.filter(m => !messageIds.includes(m.id)));
            setAnimatingOut(prev => {
              const next = { ...prev };
              messageIds.forEach(id => delete next[id]);
              return next;
            });
          }, 400);
          apiDelete('inbox-cache', { account_email: overrideAccount || _currentAccount, gmail_ids: messageIds }).catch(() => {});
          for (const msgId of messageIds) {
            apiPut('queue', { message_id: msgId, status: 'done' }).catch(() => {});
          }
          setTriageVersion(v => v + 1);
        } else if (action === 'markRead') {
          setMessages(prev => prev.map(m => messageIds.includes(m.id) ? { ...m, isUnread: false } : m));
          for (const msgId of messageIds) {
            apiPut('queue', { message_id: msgId, status: 'done' }).catch(() => {});
          }
          setTriageVersion(v => v + 1);
        } else if (action === 'markUnread') {
          setMessages(prev => prev.map(m => messageIds.includes(m.id) ? { ...m, isUnread: true } : m));
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

  // Undo a history action
  async function undoHistoryAction(entry: ActionHistoryEntry) {
    if (!entry.undoAction || entry.undone) return;
    try {
      const savedAccount = _currentAccount;
      if (entry.accountEmail && entry.accountEmail !== _currentAccount) setCurrentAccount(entry.accountEmail);
      const res = await gmailPost(entry.undoAction, { action: entry.undoAction, messageIds: entry.messageIds });
      if (entry.accountEmail) setCurrentAccount(savedAccount);
      if (res.success) {
        // Mark as undone in history (local + Supabase)
        setActionHistory(prev => prev.map(h => h.id === entry.id ? { ...h, undone: true } : h));
        fetch('/api/emailHelperV2/action-history', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: entry.id, undone: true }),
        }).catch(() => {});
        // Update UI state
        if (entry.undoAction === 'markUnread') {
          setMessages(prev => prev.map(m => entry.messageIds.includes(m.id) ? { ...m, isUnread: true } : m));
        } else if (entry.undoAction === 'markRead') {
          setMessages(prev => prev.map(m => entry.messageIds.includes(m.id) ? { ...m, isUnread: false } : m));
        }
        showToast('Undone', `${entry.label} reversed`);
        setTriageVersion(v => v + 1);
      } else {
        showToast('Undo failed', res.error);
      }
    } catch (err) {
      showToast('Undo failed', String(err));
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
      setTriageVersion(v => v + 1); // Reload Priorities + Triage tabs
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

  // All Mail tab: no count badge — its count doesn't align with
  // the categorised tabs (Triage, Cleanup, etc.) and confuses users.

  // Load all tab counts upfront (not just when each tab is visited)
  const loadAllTabCounts = useCallback(async () => {
    try {
      // Fetch queue data for Triage + Snoozed counts
      const queueRes = await apiGet('queue');
      if (queueRes.success) {
        const items = queueRes.data || [];
        const activeSignal = items.filter((q: any) => q.status === 'active' && q.priority !== 'low' && ['A', 'B', 'C'].includes(q.tier)).length;
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
        // Priorities count stored for the settings menu badge
        reportTabCount('priorities', sendersRes.data.length);
      }

      // Fetch follow-up count — unified mode gets all accounts, single gets one
      const followUpUrl = unified ? '/api/emailHelperV2/follow-ups' : withAccount('/api/emailHelperV2/follow-ups');
      const followUpRes = await fetch(followUpUrl).then(r => r.json());
      if (followUpRes.success && followUpRes.data) {
        const followUpCount = (followUpRes.data.starred_count || 0) + (followUpRes.data.awaiting_count || 0);
        reportTabCount('follow-up', followUpCount);
      }
    } catch (e) {
      console.error('Failed to load tab counts:', e);
    }
  }, [messages, reportTabCount]);

  // Load tab counts on initial page load and whenever messages stabilize
  // Debounce to avoid flickering during pagination (messages change every 200 batch)
  const tabCountTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!account || messages.length === 0) return;
    if (tabCountTimerRef.current) clearTimeout(tabCountTimerRef.current);
    tabCountTimerRef.current = setTimeout(() => {
      loadAllTabCounts();
    }, 1500); // Wait 1.5s after last message batch before recalculating
    return () => { if (tabCountTimerRef.current) clearTimeout(tabCountTimerRef.current); };
  }, [account, messages.length, loadAllTabCounts]);

  // Run background cron on first load to populate follow-up cache & sender priorities
  useEffect(() => {
    if (accounts.length > 0) {
      const cronRanKey = 'email_helper_cron_last';
      const lastRun = localStorage.getItem(cronRanKey);
      const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
      if (!lastRun || Number(lastRun) < eightHoursAgo) {
        localStorage.setItem(cronRanKey, String(Date.now()));
        fetch('/api/emailHelperV2/cron').catch(() => {});
      }
    }
  }, [accounts.length]);

  // Keyboard shortcuts: Cmd+K or / to focus search, Escape to close
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
          input?.focus();
        }, 50);
      }
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
          input?.focus();
        }, 50);
      }
      if (e.key === 'Escape' && searchOpen) {
        closeSearch();
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [searchOpen]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'home', label: 'Home' },
    { id: 'reply-queue', label: 'Top Tiers' },
    { id: 'follow-up', label: 'Follow Up' },
    { id: 'snoozed', label: 'Snoozed' },
    { id: 'cleanup', label: 'Easy-Clear' },
    { id: 'sent', label: 'Sent' },
    { id: 'inbox', label: 'All Mail' },
    ...(searchSelectionActive.length > 0 ? [{ id: 'search-reviews' as Tab, label: `Search Reviews (${searchSelectionActive.length})` }] : []),
  ];

  // Auth error — show login prompt instead of redirect loop
  if (authError) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <div className="flex items-center justify-center gap-2 mb-3">
          <img src="/clearbox-logo.svg" alt="Clearbox" width={64} height={64} className="rounded-xl" />
          <h1 className="text-3xl font-bold">Clearbox</h1>
        </div>
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
    <div className={`w-full mx-auto px-4 py-6 ${layoutMode === 'split' && !isMobile ? 'max-w-full px-6' : 'max-w-4xl'}`}>
      {/* Sticky header + tabs */}
      <div className="sticky top-0 z-30 -mx-4 px-4 pb-0 pt-0" style={{ background: 'var(--bg, #f8fafc)' }}>
        {/* Header */}
        <div className="flex items-start justify-between mb-3 pt-2">
          <div className="flex items-center gap-2.5">
            <img src="/clearbox-logo.svg" alt="Clearbox" width={64} height={64} className="rounded-xl" />
            <div>
              <h1 className="text-2xl font-bold leading-tight">Clearbox</h1>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>Your Inbox Command Center</p>
            </div>
          </div>
          {/* Right column: account, greeting, trust strip, controls */}
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {/* Account Switcher */}
              {accounts.length > 1 ? (
                <select
                  value={unified ? '__unified__' : account}
                  onChange={(e) => {
                    if (e.target.value === '__unified__') switchToUnified();
                    else switchAccount(e.target.value);
                  }}
                  className="text-xs px-2.5 py-1.5 rounded-lg border font-medium appearance-none cursor-pointer"
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
                <div className="text-xs px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--normal-bg)', color: '#065f46' }}>
                  <strong>{profile.emailAddress}</strong>
                </div>
              ) : null}
              {/* Layout toggle — hidden on mobile */}
            {!isMobile && <button
              onClick={() => setLayoutMode(layoutMode === 'cards' ? 'split' : 'cards')}
              className="w-9 h-9 rounded-lg border flex items-center justify-center transition-all hover:shadow-sm"
              title={layoutMode === 'cards' ? 'Switch to split view' : 'Switch to card view'}
              style={{ borderColor: layoutMode === 'split' ? 'var(--accent)' : 'var(--border)', background: layoutMode === 'split' ? '#eff6ff' : 'white', color: layoutMode === 'split' ? 'var(--accent)' : '#94a3b8' }}>
              {layoutMode === 'cards' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
              )}
            </button>}
            {/* Settings gear menu — contains Priorities, Accounts, Action History, Logout */}
            <div className="relative">
              <button
                onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                className="w-9 h-9 rounded-lg border flex items-center justify-center transition-all hover:shadow-sm relative"
                title="Settings"
                style={{ borderColor: showSettingsMenu ? 'var(--accent)' : 'var(--border)', background: showSettingsMenu ? '#eff6ff' : 'white', color: showSettingsMenu ? 'var(--accent)' : '#94a3b8' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                {actionHistory.filter(h => !h.undone && h.undoAction).length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center" style={{ background: '#f59e0b' }}>
                    {actionHistory.filter(h => !h.undone && h.undoAction).length}
                  </span>
                )}
              </button>
              {showSettingsMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSettingsMenu(false)} />
                  <div className="absolute right-0 top-full mt-2 z-50 w-56 rounded-xl border shadow-xl overflow-hidden" style={{ background: 'white', borderColor: 'var(--border)' }}>
                    <button
                      onClick={() => { setActiveTab('priorities'); setShowSettingsMenu(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-gray-50 transition-colors text-left"
                      style={{ color: activeTab === 'priorities' ? 'var(--accent)' : '#334155' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                      Sender Priorities
                      {tabCounts['priorities'] > 0 && (
                        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: '#f1f5f9', color: '#64748b' }}>
                          {tabCounts['priorities']}
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => { setActiveTab('accounts'); setShowSettingsMenu(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-gray-50 transition-colors text-left"
                      style={{ color: activeTab === 'accounts' ? 'var(--accent)' : '#334155' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                      </svg>
                      Accounts
                    </button>
                    <div style={{ height: 1, background: 'var(--border)' }} />
                    <button
                      onClick={() => { setShowActionHistory(true); setShowSettingsMenu(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-gray-50 transition-colors text-left"
                      style={{ color: '#334155' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                      Action History
                      {actionHistory.filter(h => !h.undone && h.undoAction).length > 0 && (
                        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white" style={{ background: '#f59e0b' }}>
                          {actionHistory.filter(h => !h.undone && h.undoAction).length}
                        </span>
                      )}
                    </button>
                    <div style={{ height: 1, background: 'var(--border)' }} />
                    <button
                      onClick={() => { window.location.href = '/api/emailHelperV2/auth/logout'; }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-red-50 transition-colors text-left"
                      style={{ color: '#ef4444' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                      </svg>
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
            </div>{/* close controls row */}
            {/* Greeting + motivation */}
            <div className="text-right">
              <span className="text-sm font-semibold" suppressHydrationWarning>{(() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; })()}</span>
              <span className="text-xs ml-1.5" style={{ color: 'var(--muted)' }} suppressHydrationWarning>
                {(() => {
                  const tc = tabCounts['reply-queue'] || 0;
                  const cc = tabCounts['cleanup'] || 0;
                  const total = tc + (tabCounts['follow-up'] || 0) + (tabCounts['snoozed'] || 0) + cc;
                  return total === 0 ? 'Inbox zero — you\'re on top of it.' : tc === 0 && cc > 0 ? `Just ${cc} low-priority to clean up.` : `${tc} email${tc !== 1 ? 's' : ''} need${tc === 1 ? 's' : ''} your attention.`;
                })()}
              </span>
            </div>
            {/* Trust strip */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-[10px] font-medium" style={{ color: '#64748b' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Emails never stored
              </div>
              <div className="w-px h-2.5" style={{ background: '#cbd5e1' }} />
              <div className="flex items-center gap-1 text-[10px] font-medium" style={{ color: '#64748b' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Every action undoable
              </div>
              <div className="w-px h-2.5" style={{ background: '#cbd5e1' }} />
              <div className="flex items-center gap-1 text-[10px] font-medium" style={{ color: '#64748b' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                {accounts.length} account{accounts.length !== 1 ? 's' : ''} connected
              </div>
              <div className="w-px h-2.5" style={{ background: '#cbd5e1' }} />
              <div className="flex items-center gap-1 text-[10px] font-medium" style={{ color: '#16a34a' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
                AES-256 encrypted
              </div>
              {/* Sync status — inline after encrypted badge */}
              {Object.keys(syncProgress).length > 0 && (
                <>
                  <div className="w-px h-2.5" style={{ background: '#cbd5e1' }} />
                  {Object.values(syncProgress).every(s => s.done) ? (
                    <div className="flex items-center gap-1 text-[10px] font-medium" style={{ color: '#16a34a' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                      Synced
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 border-[1.5px] border-t-transparent rounded-full animate-spin" style={{ borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                      {Object.entries(syncProgress).filter(([, s]) => !s.done).map(([email, s]) => (
                        <div key={email} className="flex items-center gap-1">
                          <div className="w-10 h-0.5 rounded-full overflow-hidden" style={{ background: '#dcfce7' }}>
                            <div className="h-full rounded-full transition-all duration-1000" style={{ background: '#22c55e', width: `${s.total > 0 ? Math.min(100, (s.cached / s.total) * 100) : 0}%` }} />
                          </div>
                          <span className="text-[8px] whitespace-nowrap" style={{ color: '#15803d' }}>{s.eta}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>


        {/* Global Search Bar */}
        <div className="relative mb-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#94a3b8' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => { handleSearchInput(e.target.value); if (!searchOpen) setSearchOpen(true); }}
                onFocus={() => { if (searchQuery) setSearchOpen(true); }}
                placeholder="Search emails by sender or subject..."
                className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border transition-all focus:outline-none focus:ring-2 focus:ring-opacity-50"
                style={{ borderColor: searchOpen ? 'var(--accent)' : 'var(--border)', background: 'white', ...(searchOpen ? { ringColor: 'var(--accent)' } : {}) }}
              />
              {searchQuery && (
                <button onClick={closeSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center text-xs hover:bg-gray-100"
                  style={{ color: 'var(--muted)' }}>✕</button>
              )}
            </div>
            {searchLoading && (
              <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin flex-shrink-0" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            )}
          </div>

          {/* Search Results Dropdown */}
          {searchOpen && searchQuery && (
            <>
              <div className="fixed inset-0 z-20" onClick={closeSearch} />
              <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-xl border shadow-2xl overflow-hidden"
                style={{ background: 'white', borderColor: 'var(--border)', maxHeight: '60vh', overflowY: 'auto' }}>
                {searchLoading && searchResults.length === 0 ? (
                  <div className="p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
                    Searching across {unified && accounts.length > 1 ? `${accounts.length} accounts` : 'your inbox'}...
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
                    No results found for &quot;{searchQuery}&quot;
                  </div>
                ) : (
                  <div>
                    <div className="px-4 py-2 flex items-center justify-between sticky top-0 z-10" style={{ background: '#f8fafc', borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox"
                          checked={searchSelectedIds.size === searchResults.length && searchResults.length > 0}
                          onChange={() => {
                            if (searchSelectedIds.size === searchResults.length) {
                              setSearchSelectedIds(new Set());
                            } else {
                              setSearchSelectedIds(new Set(searchResults.map(m => m.id)));
                            }
                          }}
                          className="rounded flex-shrink-0" style={{ accentColor: 'var(--accent)' }} />
                        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                          {searchSelectedIds.size > 0 ? `${searchSelectedIds.size} selected` : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}
                          {searchLoading && ' (loading more...)'}
                        </span>
                      </div>
                      {searchSelectedIds.size > 0 && (
                        <div className="flex gap-1.5">
                          <button onClick={() => {
                            const selected = searchResults.filter(m => searchSelectedIds.has(m.id));
                            setSearchSelectionActive(selected);
                            setActiveTab('search-reviews');
                            setSearchOpen(false);
                            setSearchQuery('');
                            setSearchSelectedIds(new Set());
                          }}
                            className="px-3 py-1 text-[10px] font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>
                            Open {searchSelectedIds.size} Selected
                          </button>
                          <button onClick={() => {
                            const ids = Array.from(searchSelectedIds);
                            const msgs = searchResults.filter(m => searchSelectedIds.has(m.id));
                            // Group by account for proper action routing
                            const byAccount = new Map<string, string[]>();
                            for (const m of msgs) {
                              const acct = m.accountEmail || _currentAccount;
                              if (!byAccount.has(acct)) byAccount.set(acct, []);
                              byAccount.get(acct)!.push(m.id);
                            }
                            for (const [acct, mIds] of byAccount) handleAction('archive', mIds, undefined, acct);
                            setSearchResults(prev => prev.filter(r => !searchSelectedIds.has(r.id)));
                            setSearchSelectedIds(new Set());
                          }}
                            className="px-3 py-1 text-[10px] font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                          <button onClick={() => {
                            const msgs = searchResults.filter(m => searchSelectedIds.has(m.id));
                            const byAccount = new Map<string, string[]>();
                            for (const m of msgs) {
                              const acct = m.accountEmail || _currentAccount;
                              if (!byAccount.has(acct)) byAccount.set(acct, []);
                              byAccount.get(acct)!.push(m.id);
                            }
                            for (const [acct, mIds] of byAccount) handleAction('trash', mIds, undefined, acct);
                            setSearchResults(prev => prev.filter(r => !searchSelectedIds.has(r.id)));
                            setSearchSelectedIds(new Set());
                          }}
                            className="px-3 py-1 text-[10px] font-medium rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                        </div>
                      )}
                    </div>
                    {searchResults.map((msg) => {
                      const isSelected = searchSelectedIds.has(msg.id);
                      return (
                      <div key={`${msg.id}-${msg.accountEmail}`}
                        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                        style={{ borderBottom: '1px solid var(--border)', background: isSelected ? '#eff6ff' : undefined }}
                        onClick={() => {
                          if (layoutMode === 'split' && !isMobile && splitSupportedTabs.includes(activeTab)) {
                            setSplitPreviewId(msg.id);
                            setSplitPreviewAccount(msg.accountEmail);
                          } else {
                            setPreviewMessageId(msg.id);
                            setPreviewAccount(msg.accountEmail);
                          }
                          closeSearch();
                        }}>
                        <input type="checkbox" checked={isSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => {
                            setSearchSelectedIds(prev => {
                              const next = new Set(prev);
                              next.has(msg.id) ? next.delete(msg.id) : next.add(msg.id);
                              return next;
                            });
                          }}
                          className="rounded flex-shrink-0 mt-1" style={{ accentColor: 'var(--accent)' }} />
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: msg.isUnread ? 'var(--accent)' : '#94a3b8' }}>
                          {(msg.sender || '?')[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-sm truncate" style={{ fontWeight: msg.isUnread ? 700 : 500 }}>{msg.sender}</span>
                            <span className="text-[10px] whitespace-nowrap flex-shrink-0" style={{ color: 'var(--muted)' }}>
                              {new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </span>
                          </div>
                          <div className="text-sm truncate" style={{ fontWeight: msg.isUnread ? 600 : 400 }}>{msg.subject}</div>
                          <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{cleanSnippet(msg.snippet || '')}</div>
                          {msg.accountEmail && accounts.length > 1 && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full mt-0.5 inline-block" style={{ background: '#f1f5f9', color: '#64748b' }}>
                              {msg.accountEmail}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); handleAction('archive', [msg.id], undefined, msg.accountEmail); setSearchResults(prev => prev.filter(r => r.id !== msg.id)); }}
                            className="px-2 py-1 text-[10px] rounded border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                          <button onClick={(e) => { e.stopPropagation(); handleAction('trash', [msg.id], undefined, msg.accountEmail); setSearchResults(prev => prev.filter(r => r.id !== msg.id)); }}
                            className="px-2 py-1 text-[10px] rounded border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Tabs — pill style, responsive, with shadow separator */}
        <div className="flex flex-wrap gap-1.5 pb-3 mb-0"
          style={{ borderBottom: '1px solid var(--border)' }}>
          {tabs.map((tab) => {
            const count = tabCounts[tab.id];
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="px-3.5 py-2 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5"
                style={{
                  background: isActive ? 'var(--accent)' : 'white',
                  color: isActive ? 'white' : '#475569',
                  boxShadow: isActive
                    ? '0 2px 8px rgba(79, 70, 229, 0.3)'
                    : '0 1px 3px rgba(0,0,0,0.08)',
                  border: isActive ? '1.5px solid var(--accent)' : '1.5px solid #e2e8f0',
                }}
              >
                {tab.label}
                {count != null && count > 0 && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none"
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.25)' : '#f1f5f9',
                      color: isActive ? 'white' : '#64748b',
                    }}>
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/* Bottom shadow to visually separate sticky header from scrolling content */}
        <div style={{ height: 4, background: 'linear-gradient(to bottom, rgba(0,0,0,0.04), transparent)', marginBottom: 12 }} />
      </div>

      {/* Background task banner — visible across all tabs */}
      {bgTaskLabel && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl mb-4 animate-pulse" style={{ background: '#eef2ff', border: '1px solid #c7d2fe' }}>
          <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#6366f1', borderTopColor: 'transparent' }} />
          <span className="text-sm font-medium" style={{ color: '#4338ca' }}>{bgTaskLabel}</span>
          <span className="text-xs ml-auto" style={{ color: '#6366f1' }}>You can keep working</span>
        </div>
      )}

      {/* Loading progress ��� intentionally removed from here, shown inline in header */}

      {/* Tab content — fixed width container prevents layout shift between tabs */}
      <div className="w-full" style={{ minHeight: '60vh' }}>
        {(() => {
          const inSplitMode = layoutMode === 'split' && !isMobile && splitSupportedTabs.includes(activeTab);

          // Render tab content
          const tabContent = (
            <>
              {activeTab === 'home' && (
                <HomeTab
                  tabCounts={tabCounts}
                  accounts={accounts}
                  onNavigate={setActiveTab}
                  onRunTriage={runTriage}
                  triageLoading={triageLoading}
                />
              )}
              {activeTab === 'inbox' && (
                <InboxTab messages={messages} loading={loading} actionLoading={actionLoading}
                  onAction={handleAction} onRefresh={unified && accounts.length > 1 ? loadUnifiedInbox : loadInbox} showToast={showToast} animatingOut={animatingOut} onPreview={openPreview} onDialogPreview={openDialogPreview} />
              )}
              {activeTab === 'reply-queue' && <ReplyQueueTab key={`triage-${account}-${unified}`} onAction={handleAction} showToast={showToast} reloadKey={triageVersion} onPreview={openPreview} onDialogPreview={openDialogPreview} reportCount={(c: number) => reportTabCount('reply-queue', c)} quickReplyTemplates={quickReplyTemplates} onAdvancePreview={advancePreview} />}
              {activeTab === 'follow-up' && <FollowUpTab key={`followup-${account}-${unified}`} accounts={accounts} unified={unified} onPreview={openPreview} onDialogPreview={openDialogPreview} showToast={showToast} onAction={handleAction} reportCount={(c: number) => reportTabCount('follow-up', c)} />}
              {activeTab === 'snoozed' && <SnoozedTab key={`snoozed-${account}-${unified}`} onAction={handleAction} showToast={showToast} onPreview={openPreview} onDialogPreview={openDialogPreview} reloadKey={triageVersion} reportCount={(c: number) => reportTabCount('snoozed', c)} />}
              {activeTab === 'cleanup' && <CleanupTab messages={messages} onAction={handleAction} showToast={showToast} onPreview={openPreview} onDialogPreview={openDialogPreview} reportCount={(c: number) => reportTabCount('cleanup', c)} />}
              {activeTab === 'sent' && <SentMailTab key={`sent-${account}-${unified}`} accounts={accounts} unified={unified} onPreview={openPreview} onDialogPreview={openDialogPreview} showToast={showToast} />}
              {activeTab === 'search-reviews' && <SearchReviewsTab messages={searchSelectionActive} onAction={handleAction} showToast={showToast} onPreview={openPreview} onDialogPreview={openDialogPreview} quickReplyTemplates={quickReplyTemplates} onClose={() => { setSearchSelectionActive([]); setActiveTab('reply-queue'); }} onRemove={(id: string) => setSearchSelectionActive(prev => prev.filter(m => m.id !== id))} />}
              {activeTab === 'priorities' && <PrioritiesTab key={`priorities-${triageVersion}`} onScanSent={scanSentMail} scanning={triageLoading} showToast={showToast} />}
              {activeTab === 'accounts' && <AccountsTab currentAccount={account} accounts={accounts} onSwitch={switchAccount} onRefresh={loadAccounts} showToast={showToast} onRunTriage={runTriage} onScanSent={scanSentMail} triageLoading={triageLoading} bgTaskLabel={bgTaskLabel} />}
            </>
          );

          if (!inSplitMode) return tabContent;

          // Split mode: tab on left, drag handle, inline preview on right
          return (
            <>
            {/* Highlight the card whose preview is showing in the right pane */}
            {splitPreviewId && (
              <style>{`[data-preview-id="${splitPreviewId}"] { outline: 2px solid var(--accent) !important; outline-offset: -2px; background: #eff6ff !important; }`}</style>
            )}
            <div ref={splitContainerRef} className="flex rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', height: 'calc(100vh - 220px)', minHeight: 400 }}>
              {/* Left panel — email list / tab content */}
              <div className="overflow-y-auto" style={{ width: `${splitLeftPct}%`, minWidth: 280, background: 'var(--bg)' }}>
                {tabContent}
              </div>
              {/* Drag handle */}
              <div
                onMouseDown={handleSplitDragStart}
                className="flex-shrink-0 flex items-center justify-center group"
                style={{ width: 6, cursor: 'col-resize', background: 'var(--border)', transition: 'background 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--border)')}
                title="Drag to resize"
              >
                <div className="w-0.5 h-8 rounded-full opacity-40 group-hover:opacity-80" style={{ background: 'var(--muted)' }} />
              </div>
              {/* Right panel — email preview */}
              <div className="flex-1 overflow-y-auto" style={{ background: 'var(--card)' }}>
                {splitPreviewId ? (
                  <InlinePreview
                    messageId={splitPreviewId}
                    accountEmail={splitPreviewAccount}
                    onAction={handleAction}
                    showToast={showToast}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full" style={{ color: 'var(--muted)' }}>
                    <div className="text-center">
                      <div className="text-4xl mb-3 opacity-30">📧</div>
                      <p className="text-sm">Select an email to preview</p>
                      <p className="text-xs mt-1">Click any email on the left</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            </>
          );
        })()}
      </div>

      {/* Email Preview Modal — only used in card mode */}
      {previewMessageId && <EmailPreviewModal messageId={previewMessageId} accountEmail={previewAccount} onClose={() => setPreviewMessageId(null)} onAction={handleAction} showToast={showToast} onSnooze={snoozeFromPreview} />}

      {/* Action History Panel */}
      {showActionHistory && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setShowActionHistory(false)}>
          <div className="w-full max-w-sm bg-white shadow-2xl h-full overflow-y-auto border-l"
            style={{ borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b px-4 py-3 flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h2 className="font-bold text-sm">Action History</h2>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>Last 7 days · newest first</p>
              </div>
              <div className="flex gap-2">
                {actionHistory.length > 0 && (
                  <button onClick={() => { setActionHistory([]); fetch('/api/emailHelperV2/action-history', { method: 'DELETE' }).catch(() => {}); }} className="text-xs px-2 py-1 rounded border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                    Clear
                  </button>
                )}
                <button onClick={() => setShowActionHistory(false)} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-100" style={{ color: 'var(--muted)' }}>
                  ✕
                </button>
              </div>
            </div>
            {actionHistory.length === 0 ? (
              <div className="text-center py-16 px-4" style={{ color: 'var(--muted)' }}>
                <div className="text-3xl mb-2 opacity-30">📋</div>
                <p className="text-sm">No actions yet</p>
                <p className="text-xs mt-1">Actions you take (archive, mark read, trash, etc.) will appear here so you can undo them.</p>
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {actionHistory.map((entry) => (
                  <HistoryEntryCard key={entry.id} entry={entry} onUndo={() => undoHistoryAction(entry)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {toast && <UndoToast toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

// ============ HISTORY ENTRY CARD ============

function HistoryEntryCard({ entry, onUndo }: { entry: ActionHistoryEntry; onUndo: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const ago = Math.floor((Date.now() - entry.timestamp) / 1000);
  const timeLabel = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : ago < 86400 ? `${Math.floor(ago / 3600)}h ago` : new Date(entry.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const visibleSubjects = expanded ? entry.subjects : entry.subjects.slice(0, 3);
  const hiddenCount = entry.subjects.length - 3;

  return (
    <div className="px-4 py-3" style={{ opacity: entry.undone ? 0.5 : 1 }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{
                background: entry.undone ? '#f1f5f9' : entry.action === 'trash' || entry.action === 'delete' ? '#fee2e2' : entry.action === 'markRead' ? '#dbeafe' : entry.action === 'archive' ? '#f0fdf4' : '#f3f4f6',
                color: entry.undone ? '#94a3b8' : entry.action === 'trash' || entry.action === 'delete' ? '#dc2626' : entry.action === 'markRead' ? '#2563eb' : entry.action === 'archive' ? '#16a34a' : '#374151',
              }}>
              {entry.undone ? `${entry.label} (undone)` : entry.label}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{timeLabel}</span>
            <span className="text-[10px] font-medium" style={{ color: 'var(--muted)' }}>{entry.subjects.length} email{entry.subjects.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="mt-1">
            {visibleSubjects.map((subj, i) => (
              <div key={i} className="text-xs truncate" style={{ color: 'var(--text)' }}>{subj}</div>
            ))}
            {hiddenCount > 0 && (
              <button onClick={() => setExpanded(!expanded)}
                className="text-xs font-medium mt-0.5 hover:underline"
                style={{ color: 'var(--accent)' }}>
                {expanded ? 'Show less' : `+${hiddenCount} more`}
              </button>
            )}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>{entry.accountEmail}</div>
        </div>
        {entry.undoAction && !entry.undone && (
          <button onClick={onUndo}
            className="px-2.5 py-1 text-xs font-semibold rounded-lg border flex-shrink-0 hover:shadow-sm transition-all"
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)', background: '#eff6ff' }}>
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

// ============ UNDO TOAST ============

function UndoToast({ toast, onDismiss }: {
  toast: { title: string; subtitle?: string; undoAction?: () => void; expiresAt?: number };
  onDismiss: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(5);

  useEffect(() => {
    if (!toast.undoAction || !toast.expiresAt) return;
    const interval = setInterval(() => {
      const left = Math.max(0, Math.ceil((toast.expiresAt! - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) { clearInterval(interval); onDismiss(); }
    }, 200);
    return () => clearInterval(interval);
  }, [toast.expiresAt, toast.undoAction, onDismiss]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in"
      style={{ maxWidth: '90vw' }}>
      <div className="flex items-center gap-4 px-5 py-3 rounded-xl text-white text-sm font-medium shadow-2xl"
        style={{ background: '#1e293b', minWidth: 260 }}>
        <div className="flex-1">
          <div className="font-semibold">{toast.title}</div>
          {toast.subtitle && <div className="text-xs opacity-70 mt-0.5">{toast.subtitle}</div>}
        </div>
        {toast.undoAction && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="relative w-7 h-7">
              <svg className="w-7 h-7 -rotate-90" viewBox="0 0 28 28">
                <circle cx="14" cy="14" r="12" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
                <circle cx="14" cy="14" r="12" fill="none" stroke="white" strokeWidth="2"
                  strokeDasharray={2 * Math.PI * 12}
                  strokeDashoffset={2 * Math.PI * 12 * (1 - secondsLeft / 5)}
                  strokeLinecap="round"
                  style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold">{secondsLeft}</span>
            </div>
            <button onClick={() => { toast.undoAction!(); onDismiss(); }}
              className="px-3 py-1.5 text-xs font-bold rounded-lg transition-all hover:scale-105 active:scale-95"
              style={{ background: '#6366f1', color: 'white' }}>
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ HOME TAB ============

function HomeTab({ tabCounts, accounts, onNavigate, onRunTriage, triageLoading }: {
  tabCounts: Record<string, number>;
  accounts: { email: string; is_primary: boolean }[];
  onNavigate: (tab: Tab) => void;
  onRunTriage: () => void;
  triageLoading: boolean;
}) {
  const triageCount = tabCounts['reply-queue'] || 0;
  const followUpCount = tabCounts['follow-up'] || 0;
  const snoozedCount = tabCounts['snoozed'] || 0;
  const cleanupCount = tabCounts['cleanup'] || 0;
  const hasAccounts = accounts.length > 0;
  const [showGuide, setShowGuide] = useState(false);

  // New user — show onboarding flow
  if (!hasAccounts) {
    return (
      <div className="max-w-lg mx-auto py-8">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold mb-2">Welcome to Clearbox</h2>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Get started in 3 simple steps</p>
        </div>

        {/* Step 1 — big prominent CTA */}
        <div className="p-6 rounded-2xl border-2 mb-4" style={{ borderColor: 'var(--accent)', background: '#eef2ff' }}>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold text-white" style={{ background: 'var(--accent)' }}>1</div>
            <div>
              <div className="font-bold text-base">Connect your Gmail</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>Takes 10 seconds. We never store your emails.</div>
            </div>
          </div>
          <a href="/api/emailHelperV2/auth/login?state=add_account"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-white font-semibold text-sm transition-all hover:shadow-lg active:scale-[0.98]"
            style={{ background: 'var(--accent)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Connect Gmail Account
          </a>
        </div>

        {/* Steps 2 & 3 — dimmed, coming next */}
        <div className="p-4 rounded-xl border mb-3" style={{ borderColor: 'var(--border)', background: 'var(--card)', opacity: 0.6 }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold" style={{ background: '#f1f5f9', color: 'var(--muted)' }}>2</div>
            <div>
              <div className="font-semibold text-sm">We learn who matters to you</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>Clearbox scans who you reply to most and auto-sorts your senders into priority tiers.</div>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-xl border mb-6" style={{ borderColor: 'var(--border)', background: 'var(--card)', opacity: 0.6 }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold" style={{ background: '#f1f5f9', color: 'var(--muted)' }}>3</div>
            <div>
              <div className="font-semibold text-sm">Start clearing your inbox</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>Reply to important emails, bulk-archive the noise, and reach inbox zero.</div>
            </div>
          </div>
        </div>

        {/* Trust strip */}
        <div className="grid grid-cols-3 gap-3 text-center p-4 rounded-xl" style={{ background: '#f8fafc', border: '1px solid var(--border)' }}>
          <div>
            <div className="text-lg font-bold" style={{ color: 'var(--accent)' }}>100%</div>
            <div className="text-[10px]" style={{ color: 'var(--muted)' }}>Private & encrypted</div>
          </div>
          <div>
            <div className="text-lg font-bold" style={{ color: 'var(--accent)' }}>30s</div>
            <div className="text-[10px]" style={{ color: 'var(--muted)' }}>Setup time</div>
          </div>
          <div>
            <div className="text-lg font-bold" style={{ color: 'var(--accent)' }}>1-click</div>
            <div className="text-[10px]" style={{ color: 'var(--muted)' }}>Undo any action</div>
          </div>
        </div>
      </div>
    );
  }

  // Returning user — dashboard view
  // Only count stable items (not cleanup which changes during pagination)
  const priorityCount = triageCount + followUpCount + snoozedCount;

  return (
    <div>
      {/* Summary banner — only shows stable priority count */}
      {priorityCount > 0 && (
        <div className="p-4 rounded-xl mb-6" style={{ background: '#eef2ff', border: '1px solid #c7d2fe' }}>
          <div className="text-lg font-bold" style={{ color: '#4338ca' }}>{priorityCount} priority email{priorityCount !== 1 ? 's' : ''} need{priorityCount === 1 ? 's' : ''} attention</div>
          <div className="text-xs mt-1" style={{ color: '#6366f1' }}>Start with Top Tiers — your most important emails first</div>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <button onClick={() => onNavigate('reply-queue')}
          className="p-4 rounded-xl border text-left transition-all hover:shadow-md"
          style={{ background: triageCount > 0 ? '#eef2ff' : 'var(--card)', borderColor: triageCount > 0 ? '#6366f1' : 'var(--border)' }}>
          <div className="text-2xl font-bold" style={{ color: triageCount > 0 ? '#4338ca' : 'var(--muted)' }}>{triageCount}</div>
          <div className="text-xs font-medium mt-1" style={{ color: triageCount > 0 ? '#6366f1' : 'var(--muted)' }}>
            {triageCount === 0 ? 'All clear!' : 'Needs your reply'}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>Top Tiers</div>
        </button>

        <button onClick={() => onNavigate('follow-up')}
          className="p-4 rounded-xl border text-left transition-all hover:shadow-md"
          style={{ background: followUpCount > 0 ? '#fffbeb' : 'var(--card)', borderColor: followUpCount > 0 ? '#f59e0b' : 'var(--border)' }}>
          <div className="text-2xl font-bold" style={{ color: followUpCount > 0 ? '#b45309' : 'var(--muted)' }}>{followUpCount}</div>
          <div className="text-xs font-medium mt-1" style={{ color: followUpCount > 0 ? '#d97706' : 'var(--muted)' }}>
            {followUpCount === 0 ? 'No pending' : 'Awaiting reply'}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>Follow Up</div>
        </button>

        <button onClick={() => onNavigate('snoozed')}
          className="p-4 rounded-xl border text-left transition-all hover:shadow-md"
          style={{ background: snoozedCount > 0 ? '#f5f3ff' : 'var(--card)', borderColor: snoozedCount > 0 ? '#8b5cf6' : 'var(--border)' }}>
          <div className="text-2xl font-bold" style={{ color: snoozedCount > 0 ? '#6d28d9' : 'var(--muted)' }}>{snoozedCount}</div>
          <div className="text-xs font-medium mt-1" style={{ color: snoozedCount > 0 ? '#7c3aed' : 'var(--muted)' }}>
            {snoozedCount === 0 ? 'Nothing snoozed' : 'Coming back later'}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>Snoozed</div>
        </button>

        <button onClick={() => onNavigate('cleanup')}
          className="p-4 rounded-xl border text-left transition-all hover:shadow-md"
          style={{ background: cleanupCount > 5 ? '#fef2f2' : 'var(--card)', borderColor: cleanupCount > 5 ? '#f87171' : 'var(--border)' }}>
          <div className="text-2xl font-bold" style={{ color: cleanupCount > 5 ? '#dc2626' : 'var(--muted)' }}>{cleanupCount}</div>
          <div className="text-xs font-medium mt-1" style={{ color: cleanupCount > 5 ? '#ef4444' : 'var(--muted)' }}>
            {cleanupCount === 0 ? 'Inbox clean!' : 'Low-priority emails'}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>Easy-Clear</div>
        </button>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={() => onNavigate('reply-queue')}
          className="px-4 py-2.5 text-xs font-semibold rounded-lg text-white transition-all hover:shadow-md active:scale-95"
          style={{ background: 'var(--accent)' }}>
          Go to Top Tiers
        </button>
        <button onClick={onRunTriage}
          disabled={triageLoading}
          className="px-4 py-2.5 text-xs font-semibold rounded-lg border transition-all hover:shadow-md active:scale-95"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)', opacity: triageLoading ? 0.5 : 1 }}>
          {triageLoading ? 'Running...' : 'Run Triage Now'}
        </button>
        <button onClick={() => onNavigate('cleanup')}
          className="px-4 py-2.5 text-xs font-semibold rounded-lg border transition-all hover:shadow-md active:scale-95"
          style={{ borderColor: 'var(--border)', color: '#64748b' }}>
          Easy-Clear Noise
        </button>
      </div>

      {/* Getting started guide */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <button onClick={() => setShowGuide(!showGuide)}
          className="w-full flex items-center justify-between p-4 text-left"
          style={{ background: '#f8fafc' }}>
          <div>
            <span className="font-semibold text-sm">How Clearbox works</span>
            <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}>
              {showGuide ? 'Click to collapse' : 'Click to expand'}
            </span>
          </div>
          <span style={{ color: 'var(--muted)' }}>{showGuide ? '▲' : '▼'}</span>
        </button>

        {showGuide && (
          <div className="p-5 flex flex-col gap-5" style={{ background: 'white' }}>
            {/* Step 1: Accounts */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background: accounts.length > 0 ? '#16a34a' : '#6366f1' }}>
                {accounts.length > 0 ? '✓' : '1'}
              </div>
              <div>
                <div className="font-semibold text-sm mb-1">Connect your Gmail account{accounts.length > 1 ? 's' : ''}</div>
                <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
                  Head to the <button onClick={() => onNavigate('accounts')} className="font-semibold underline" style={{ color: 'var(--accent)' }}>Accounts</button> tab
                  and sign in with Google. You can connect multiple accounts — work email, personal, side projects — and manage them all from one place.
                </p>
                {accounts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {accounts.map(a => (
                      <span key={a.email} className="text-[10px] px-2 py-1 rounded-full font-medium" style={{ background: '#dcfce7', color: '#166534' }}>
                        {a.email} {a.is_primary ? '(primary)' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Step 2: Scan sent mail */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background: '#6366f1' }}>
                2
              </div>
              <div>
                <div className="font-semibold text-sm mb-1">Scan your sent mail</div>
                <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
                  Go to <button onClick={() => onNavigate('priorities')} className="font-semibold underline" style={{ color: 'var(--accent)' }}>Priorities</button> and
                  click <strong>Scan Sent Mail</strong>. This looks at who you've emailed most often in the past 90 days and auto-assigns sender tiers:
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="text-[10px] px-2 py-1 rounded-full font-bold" style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }}>Tier A — VIPs</span>
                  <span className="text-[10px] px-2 py-1 rounded-full font-bold" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fbbf24' }}>Tier B — Important</span>
                  <span className="text-[10px] px-2 py-1 rounded-full font-bold" style={{ background: '#e0f2fe', color: '#075985', border: '1px solid #7dd3fc' }}>Tier C — Regular</span>
                  <span className="text-[10px] px-2 py-1 rounded-full font-bold" style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1' }}>Tier D — Low priority</span>
                </div>
                <p className="text-xs mt-2 leading-relaxed" style={{ color: '#475569' }}>
                  Tiers A, B, and C go to <strong>Top Tiers</strong> (emails that need your attention). Tier D and unknown senders go to <strong>Easy-Clear</strong> (newsletters, notifications, noise).
                  You can change any sender&apos;s tier at any time.
                </p>
              </div>
            </div>

            {/* Step 3: Triage */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background: '#6366f1' }}>
                3
              </div>
              <div>
                <div className="font-semibold text-sm mb-1">Work through your Top Tiers</div>
                <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
                  The <button onClick={() => onNavigate('reply-queue')} className="font-semibold underline" style={{ color: 'var(--accent)' }}>Top Tiers</button> tab
                  shows emails that need your attention, scored and sorted by priority. For each email you can: <strong>Reply</strong> directly,
                  <strong> Snooze</strong> to deal with it later, <strong>Archive</strong> when done, or <strong>Trash</strong> it.
                  Archive and Trash have a 5-second undo window — so go fast.
                </p>
              </div>
            </div>

            {/* Step 4: Follow Up */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background: '#6366f1' }}>
                4
              </div>
              <div>
                <div className="font-semibold text-sm mb-1">Track what you&apos;re waiting on</div>
                <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
                  The <button onClick={() => onNavigate('follow-up')} className="font-semibold underline" style={{ color: 'var(--accent)' }}>Follow Up</button> tab
                  automatically detects sent emails where you haven&apos;t received a reply in 24+ hours. It checks actual Gmail threads, so it&apos;s accurate.
                  You can also star any sent message to manually flag it for follow-up.
                </p>
              </div>
            </div>

            {/* Step 5: Cleanup */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background: '#6366f1' }}>
                5
              </div>
              <div>
                <div className="font-semibold text-sm mb-1">Batch-clean the noise</div>
                <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
                  The <button onClick={() => onNavigate('cleanup')} className="font-semibold underline" style={{ color: 'var(--accent)' }}>Easy-Clear</button> tab
                  groups all low-priority email by sender. Select entire senders and archive or trash dozens of messages in one click.
                  If a sender is showing up here that shouldn&apos;t be, change their tier to promote them to Top Tiers.
                </p>
              </div>
            </div>

            {/* Step 6: Unified view */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background: '#6366f1' }}>
                6
              </div>
              <div>
                <div className="font-semibold text-sm mb-1">Unified view for multiple accounts</div>
                <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
                  If you have more than one Gmail account connected, use the dropdown in the top-right to switch between them or select
                  <strong> All Accounts (Unified)</strong> to see everything merged together. Each email shows which account it came from,
                  and replies go through the correct account automatically.
                </p>
              </div>
            </div>

            {/* Pro tips */}
            <div className="mt-2 p-4 rounded-xl" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <div className="font-semibold text-xs mb-2" style={{ color: '#166534' }}>Pro tips</div>
              <div className="flex flex-col gap-1.5 text-xs" style={{ color: '#15803d' }}>
                <div>• <strong>Snooze</strong> emails you need to deal with but not right now — they&apos;ll pop back into your queue at the time you choose.</div>
                <div>• <strong>Quick Reply</strong> — in Top Tiers, use the &quot;Quick Reply&quot; dropdown to send a template response and auto-archive in one click.</div>
                <div>• <strong>Drag to reorder</strong> — drag Top Tiers cards to rearrange priority. Pin important emails with the 📌 button to keep them at top.</div>
                <div>• <strong>Undo</strong> — after archiving or trashing, you get a 5-second window to undo. Go fast, undo if needed.</div>
                <div>• <strong>Auto-Clean</strong> — in Priorities, enable &quot;Auto-Clean&quot; for high-tier senders whose update emails should be auto-archived during triage.</div>
                <div>• <strong>Merge Senders</strong> — in Priorities, click &quot;Merge Senders&quot; to manually combine duplicate contacts, or use the auto-detected suggestions.</div>
                <div>• <strong>Search</strong> — press <strong>⌘K</strong> (or <strong>/</strong>) to open global search. It searches all emails across all connected accounts by sender or subject.</div>
                <div>• The <strong>Sent</strong> tab groups your outgoing mail into conversations — no more scrolling through duplicates.</div>
                <div>• Top Tiers runs automatically every 2 minutes. You can also trigger it manually from the button above.</div>
              </div>
            </div>

            {/* Privacy & Data Policy */}
            <div className="mt-2 p-4 rounded-xl" style={{ background: '#f0f9ff', border: '1px solid #bae6fd' }}>
              <div className="font-semibold text-xs mb-2" style={{ color: '#0c4a6e' }}>🔒 Your Privacy</div>
              <div className="text-xs leading-relaxed" style={{ color: '#0369a1' }}>
                Clearbox <strong>never reads, stores, or retains the content of your emails</strong>. Full email bodies are fetched directly from Gmail in real time and are never saved to our servers. We only store minimal metadata (sender names, subject lines, and short previews) to power triage and prioritization. When you archive, trash, or de-clutter emails, those actions happen directly through the Gmail API — your email data stays in your Gmail account. You can disconnect any account at any time and all associated metadata will be removed.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ INBOX TAB ============

// ============ REPLY COMPOSER ============

function ReplyComposer({ to, subject, threadId, messageId, onSent, onCancel, showToast, accountEmail, replyAll, cc }: {
  to: string; subject: string; threadId: string; messageId: string;
  onSent: () => void; onCancel: () => void; showToast: (title: string, subtitle?: string) => void;
  accountEmail?: string; replyAll?: boolean; cc?: string;
}) {
  const [body, setBody] = useState('');
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  const [sending, setSending] = useState(false);

  async function sendReply() {
    if (!body.trim()) return;
    setSending(true);
    // Switch to the correct account for sending (the account the email was received on)
    const savedAccount = _currentAccount;
    if (accountEmail && accountEmail !== _currentAccount) {
      setCurrentAccount(accountEmail);
    }
    try {
      const sendPayload: Record<string, unknown> = {
        to,
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        body: body.replace(/\n/g, '<br>'),
        threadId,
        inReplyTo: messageId,
      };
      if (replyAll && cc) sendPayload.cc = cc;
      if (bcc.trim()) sendPayload.bcc = bcc.trim();
      const res = await gmailPost('send', sendPayload);
      if (res.success) {
        showToast('Reply sent', `To: ${to}${replyAll ? ' + all' : ''}${accountEmail ? ` (via ${accountEmail})` : ''}`);
        onSent();
      } else {
        showToast('Send failed', res.error);
      }
    } catch (err) {
      showToast('Send failed', String(err));
    } finally {
      // Restore account
      if (accountEmail && accountEmail !== savedAccount) {
        setCurrentAccount(savedAccount);
      }
      setSending(false);
    }
  }

  return (
    <div className="mt-3 p-3 rounded-lg border" style={{ background: '#f8fafc', borderColor: replyAll ? '#7c3aed' : 'var(--accent)' }}>
      <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
        {replyAll ? '↩ Reply All' : 'Replying'} to <strong>{to}</strong>
        {replyAll && cc && <span className="block mt-1">CC: {cc}</span>}
        {!showBcc && <button onClick={() => setShowBcc(true)} className="ml-2 underline text-xs" style={{ color: 'var(--accent)' }}>+ BCC</button>}
      </div>
      {showBcc && (
        <input
          type="text"
          value={bcc}
          onChange={(e) => setBcc(e.target.value)}
          placeholder="BCC: email@example.com, ..."
          className="w-full p-2 mb-2 rounded-lg border text-xs"
          style={{ borderColor: 'var(--border)' }}
        />
      )}
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

// ============ INLINE PREVIEW (for split view) ============

function InlinePreview({ messageId, accountEmail, onAction, showToast }: {
  messageId: string;
  accountEmail?: string;
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
}) {
  const [email, setEmail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyAllMode, setReplyAllMode] = useState(false);

  const iframeRef = useCallback((node: HTMLIFrameElement | null) => {
    if (node && (email?.bodyHtml || email?.body)) {
      const doc = node.contentDocument;
      if (doc) {
        const content = email.bodyHtml || email.body || '';
        const isHtml = /<[a-z][\s\S]*>/i.test(content);
        const displayContent = isHtml ? content : content.replace(/\n/g, '<br>');
        doc.open();
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>
          body { font-family: -apple-system, system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b; padding: 16px; margin: 0; word-wrap: break-word; }
          a { color: #2563eb; } img { max-width: 100%; height: auto; }
          blockquote { border-left: 3px solid #e2e8f0; margin: 8px 0; padding-left: 12px; color: #64748b; }
        </style></head><body>${displayContent}</body></html>`);
        doc.close();
        setTimeout(() => {
          if (node.contentDocument?.body) {
            node.style.height = Math.max(200, node.contentDocument.body.scrollHeight + 30) + 'px';
          }
        }, 100);
      }
    }
  }, [email]);

  useEffect(() => {
    setLoading(true);
    setReplyOpen(false);
    setReplyAllMode(false);
    const savedAccount = _currentAccount;
    if (accountEmail && accountEmail !== _currentAccount) setCurrentAccount(accountEmail);
    gmailGet('message', { id: messageId, format: 'full' }).then(res => {
      if (accountEmail && accountEmail !== savedAccount) setCurrentAccount(savedAccount);
      if (res.success) {
        setEmail(res.data);
      }
      setLoading(false);
    });
  }, [messageId, accountEmail]);

  if (loading) return (
    <div className="flex items-center justify-center h-full" style={{ color: 'var(--muted)' }}>
      <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
    </div>
  );

  if (!email) return <div className="p-6 text-sm" style={{ color: 'var(--muted)' }}>Could not load email</div>;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <h2 className="font-semibold text-sm mb-1">{email.subject}</h2>
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <span className="font-medium" style={{ color: 'var(--text)' }}>{email.sender}</span>
          <span>&lt;{email.senderEmail}&gt;</span>
          <span className="ml-auto">{new Date(email.date).toLocaleString()}</span>
        </div>
        {email.to && <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>To: {email.to}</div>}
      </div>

      {/* Action bar */}
      <div className="px-4 py-2 border-b flex gap-1.5 flex-wrap" style={{ borderColor: 'var(--border)', background: '#f8fafc' }}>
        <button onClick={() => { setReplyOpen(!replyOpen || replyAllMode); setReplyAllMode(false); }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white"
          style={{ background: replyOpen && !replyAllMode ? '#6366f1' : 'var(--accent)' }}>
          {replyOpen && !replyAllMode ? 'Cancel' : 'Reply'}
        </button>
        <button onClick={() => { setReplyAllMode(true); setReplyOpen(!replyOpen || !replyAllMode); }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border"
          style={{ borderColor: 'var(--accent)', color: replyOpen && replyAllMode ? '#fff' : 'var(--accent)', background: replyOpen && replyAllMode ? '#7c3aed' : undefined }}>
          {replyOpen && replyAllMode ? 'Cancel' : 'Reply All'}
        </button>
        <button onClick={() => { onAction('archive', [messageId], undefined, accountEmail || _currentAccount); showToast('Archived'); }}
          className="px-3 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Archive</button>
        <button onClick={() => { onAction('star', [messageId], undefined, accountEmail || _currentAccount); showToast('Starred'); }}
          className="px-3 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>Star</button>
        <button onClick={() => { onAction('trash', [messageId], undefined, accountEmail || _currentAccount); showToast('Trashed'); }}
          className="px-3 py-1.5 text-xs rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
      </div>

      {/* Reply composer */}
      {replyOpen && (
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <ReplyComposer
            to={email.senderEmail}
            subject={email.subject}
            threadId={email.threadId}
            messageId={email.id}
            showToast={showToast}
            accountEmail={accountEmail}
            replyAll={replyAllMode}
            cc={replyAllMode ? (email.cc || email.to || '').split(',').map((e: string) => e.trim()).filter((e: string) => e && !e.toLowerCase().includes(email.senderEmail.toLowerCase()) && !(accountEmail && e.toLowerCase().includes(accountEmail.toLowerCase()))).join(', ') : undefined}
            onSent={() => { setReplyOpen(false); setReplyAllMode(false); showToast(`Reply${replyAllMode ? ' all' : ''} sent`); }}
            onCancel={() => { setReplyOpen(false); setReplyAllMode(false); }}
          />
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <iframe
          ref={iframeRef}
          className="w-full border-0"
          style={{ minHeight: 200 }}
          sandbox="allow-same-origin"
          title="Email content"
        />
      </div>
    </div>
  );
}

function InboxTab({ messages, loading, actionLoading, onAction, onRefresh, showToast, animatingOut, onPreview, onDialogPreview }: {
  messages: GmailMessage[]; loading: boolean; actionLoading: string | null;
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void; onRefresh: () => void;
  showToast: (title: string, subtitle?: string) => void;
  animatingOut: Record<string, 'trash' | 'delete' | 'archive'>;
  onPreview: (messageId: string, accountEmail?: string) => void;
  onDialogPreview?: (messageId: string, accountEmail?: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ ids: string[]; count: number } | null>(null);
  const [senderTiers, setSenderTiers] = useState<Record<string, string>>({});

  // Load sender tiers for tier dropdown
  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet('senders');
        if (res.success && res.data) {
          const tiers: Record<string, string> = {};
          for (const s of res.data) tiers[s.sender_email.toLowerCase()] = s.tier;
          setSenderTiers(tiers);
        }
      } catch {}
    })();
  }, []);
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
              data-preview-id={msg.id}
              data-preview-account={msg.accountEmail || ''}
              className={`rounded-xl border transition-all hover:shadow-sm ${
                animatingOut[msg.id] === 'trash' ? 'animate-trash-out' :
                animatingOut[msg.id] === 'delete' ? 'animate-delete-out' :
                animatingOut[msg.id] === 'archive' ? 'animate-archive-out' : ''
              }`}
              style={{ background: selected.has(msg.id) ? '#eff6ff' : 'var(--card)', borderColor: selected.has(msg.id) ? 'var(--accent)' : 'var(--border)', opacity: actionLoading === msg.id ? 0.5 : 1 }}>
              <div className="flex items-start gap-3 p-4">
                <input type="checkbox" checked={selected.has(msg.id)} onChange={() => toggleSelect(msg.id)} className="mt-1 rounded" />
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onPreview(msg.id, msg.accountEmail)} onDoubleClick={() => onDialogPreview?.(msg.id, msg.accountEmail)}>
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
                    {cleanSnippet(msg.snippet || '')}
                  </div>
                </div>
              </div>
              {/* Action bar */}
              <div className="flex gap-1 px-4 pb-3 flex-wrap">
                <TierDropdown
                  currentTier={senderTiers[msg.senderEmail.toLowerCase()] || ''}
                  senderEmail={msg.senderEmail}
                  senderName={msg.sender}
                  onTierChanged={(newTier) => {
                    setSenderTiers(prev => ({ ...prev, [msg.senderEmail.toLowerCase()]: newTier }));
                    showToast(`Set to Tier ${newTier}`, msg.sender);
                  }}
                />
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
                    accountEmail={(msg as unknown as Record<string, unknown>).accountEmail as string}
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

// ============ QUICK REPLY DROPDOWN ============

function QuickReplyDropdown({ templates, onSend, senderEmail, senderName, cc, subject }: {
  templates: { id: string; label: string; body: string }[];
  onSend: (body: string, label: string, replyAll?: boolean) => void;
  senderEmail?: string;
  senderName?: string;
  cc?: string;
  subject?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ body: string; label: string; editedBody: string } | null>(null);
  const [replyMode, setReplyMode] = useState<'sender' | 'all' | null>(null);

  // Check if this is a multi-recipient email
  const hasMultipleRecipients = !!(cc && cc.trim());

  function handleTemplateClick(t: { id: string; label: string; body: string }) {
    if (hasMultipleRecipients) {
      // Show reply mode choice first
      setPreview({ body: t.body, label: t.label, editedBody: t.body });
      setReplyMode(null); // Force user to choose
    } else {
      // Single recipient — go straight to preview
      setPreview({ body: t.body, label: t.label, editedBody: t.body });
      setReplyMode('sender');
    }
  }

  async function confirmSend() {
    if (!preview || !replyMode) return;
    setSending(preview.label);
    await onSend(preview.editedBody, preview.label, replyMode === 'all');
    setSending(null);
    setPreview(null);
    setReplyMode(null);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="px-3 py-1.5 text-xs font-medium rounded-lg"
        style={{ background: '#e0f2fe', color: '#0369a1' }}>
        Quick Reply ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setPreview(null); setReplyMode(null); }} />
          <div className="absolute left-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[320px]"
            style={{ background: 'white', borderColor: 'var(--border)' }}>

            {/* Step 1: Template selection */}
            {!preview && (
              <>
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase" style={{ color: 'var(--muted)' }}>Choose a quick reply</div>
                {templates.map((t) => (
                  <button key={t.id} onClick={() => handleTemplateClick(t)}
                    className="w-full text-left px-3 py-2.5 text-xs hover:bg-blue-50 transition-colors flex flex-col gap-0.5">
                    <span className="font-semibold">{t.label}</span>
                    <span className="text-[10px] truncate" style={{ color: 'var(--muted)' }}>{t.body}</span>
                  </button>
                ))}
              </>
            )}

            {/* Step 2: Preview & confirm */}
            {preview && (
              <div className="p-3">
                <div className="text-[10px] font-semibold uppercase mb-2" style={{ color: 'var(--muted)' }}>Preview — {preview.label}</div>

                {/* Recipients */}
                <div className="text-xs mb-2 p-2 rounded" style={{ background: '#f8fafc' }}>
                  <div><span className="font-semibold" style={{ color: 'var(--muted)' }}>To:</span> {senderName || senderEmail || 'Sender'}</div>
                  {subject && <div><span className="font-semibold" style={{ color: 'var(--muted)' }}>Subject:</span> Re: {subject}</div>}
                  {hasMultipleRecipients && replyMode === 'all' && (
                    <div><span className="font-semibold" style={{ color: 'var(--muted)' }}>CC:</span> {cc}</div>
                  )}
                </div>

                {/* Editable body */}
                <textarea
                  value={preview.editedBody}
                  onChange={(e) => setPreview({ ...preview, editedBody: e.target.value })}
                  className="w-full text-xs p-2 rounded border resize-none focus:outline-none focus:ring-1"
                  style={{ borderColor: 'var(--border)', minHeight: '80px' }}
                  rows={4}
                />

                {/* Reply mode choice for multi-recipient */}
                {hasMultipleRecipients && (
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => setReplyMode('sender')}
                      className="flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition-all"
                      style={{
                        borderColor: replyMode === 'sender' ? 'var(--accent)' : 'var(--border)',
                        background: replyMode === 'sender' ? '#eff6ff' : 'white',
                        color: replyMode === 'sender' ? 'var(--accent)' : 'var(--muted)',
                      }}>
                      Reply to Sender
                    </button>
                    <button onClick={() => setReplyMode('all')}
                      className="flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition-all"
                      style={{
                        borderColor: replyMode === 'all' ? '#7c3aed' : 'var(--border)',
                        background: replyMode === 'all' ? '#f5f3ff' : 'white',
                        color: replyMode === 'all' ? '#7c3aed' : 'var(--muted)',
                      }}>
                      Reply All
                    </button>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 mt-3">
                  <button onClick={() => { setPreview(null); setReplyMode(null); }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                    Back
                  </button>
                  <button onClick={confirmSend}
                    disabled={!replyMode || !!sending}
                    className="flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg text-white transition-all"
                    style={{ background: !replyMode ? '#94a3b8' : replyMode === 'all' ? '#7c3aed' : 'var(--accent)', opacity: sending ? 0.5 : 1 }}>
                    {sending ? 'Sending...' : replyMode === 'all' ? 'Send to All & Archive' : 'Send & Archive'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ============ REPLY QUEUE TAB ============

function ReplyQueueTab({ onAction, showToast, reloadKey, onPreview, onDialogPreview, reportCount, quickReplyTemplates, onAdvancePreview }: {
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  reloadKey: number;
  onPreview: (messageId: string, accountEmail?: string) => void;
  onDialogPreview?: (messageId: string, accountEmail?: string) => void;
  reportCount?: (count: number) => void;
  quickReplyTemplates: { id: string; label: string; body: string }[];
  onAdvancePreview?: (messageId: string) => void;
}) {
  const [queue, setQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyAllTo, setReplyAllTo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  // Drag-and-drop reorder state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('email_helper_pinned') || '[]')); }
    catch { return new Set(); }
  });
  const [manualOrder, setManualOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('email_helper_order') || '[]'); }
    catch { return []; }
  });

  useEffect(() => { loadQueue(); }, [reloadKey]);

  async function loadQueue() {
    setLoading(true);
    const res = await apiGet('queue');
    if (res.success) {
      setQueue(res.data);
      const items = res.data || [];
      // Only count active tiered items (A/B/C) — untiered and low-priority go to Easy-Clear
      const activeSignalCount = items.filter((q: any) => q.status === 'active' && q.priority !== 'low' && ['A', 'B', 'C'].includes(q.tier)).length;
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
    // Find the message_id for this queue item to advance preview
    const item = queue.find(q => q.id === id);
    if (item?.message_id) onAdvancePreview?.(item.message_id);
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

  // Pin toggle
  function togglePin(id: string) {
    setPinnedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem('email_helper_pinned', JSON.stringify([...next]));
      return next;
    });
  }

  // Drag-and-drop handlers
  function handleDragStart(id: string) { setDragId(id); }
  function handleDragOver(e: React.DragEvent, id: string) { e.preventDefault(); setDragOverId(id); }
  function handleDragEnd() { setDragId(null); setDragOverId(null); }
  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    // Build current order from grouped items (lead IDs), then swap
    const currentIds = sortedActive.map(g => g.lead.id);
    const fromIdx = currentIds.indexOf(dragId);
    const toIdx = currentIds.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const newOrder = [...currentIds];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, dragId);
    setManualOrder(newOrder);
    localStorage.setItem('email_helper_order', JSON.stringify(newOrder));
    setDragId(null);
    setDragOverId(null);
  }

  // Filter to only tiered items (A/B/C) — untiered and low-priority belong in Easy-Clear
  const signalQueue = queue.filter(q => q.priority !== 'low' && ['A', 'B', 'C'].includes(q.tier));
  const active = signalQueue.filter(q => q.status === 'active');
  const snoozed = signalQueue.filter(q => q.status === 'snoozed');

  // Group active items by thread (thread_id or sender+subject)
  const threadGroups = new Map<string, typeof active>();
  for (const q of active) {
    // Normalize subject: strip Re:/Fwd: prefixes
    const normSubject = (q.subject || '').replace(/^(Re|Fwd|Fw):\s*/gi, '').trim().toLowerCase();
    const groupKey = q.thread_id || `${(q.sender_email || '').toLowerCase()}::${normSubject}`;
    if (!threadGroups.has(groupKey)) threadGroups.set(groupKey, []);
    threadGroups.get(groupKey)!.push(q);
  }
  // Sort items within each group by date (newest first)
  for (const [, items] of threadGroups) {
    items.sort((a, b) => new Date(b.received || 0).getTime() - new Date(a.received || 0).getTime());
  }
  // Build grouped list: use the newest item as the "lead" for sorting, attach children
  const groupedItems = Array.from(threadGroups.values()).map(items => ({
    lead: items[0],
    children: items.slice(1),
    allIds: items.map(i => i.id),
    allMessageIds: items.map(i => i.message_id),
    count: items.length,
  }));

  // Sort groups: pinned first, then manual order, then priority score (using lead item)
  const sortedActive = groupedItems.sort((a, b) => {
    const aPinned = pinnedIds.has(a.lead.id) ? 0 : 1;
    const bPinned = pinnedIds.has(b.lead.id) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    const aIdx = manualOrder.indexOf(a.lead.id);
    const bIdx = manualOrder.indexOf(b.lead.id);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return (b.lead.priority_score || 0) - (a.lead.priority_score || 0);
  });

  // Track expanded thread groups
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

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
      <p className="text-sm">Top Tiers runs automatically every 2 minutes. Only high-priority senders (Tier A/B) and emails needing replies appear here. You can also run it manually from the Accounts tab.</p>
    </div>
  );

  // Count emails per tier for badges
  const tierCounts: Record<string, number> = { A: 0, B: 0, C: 0 };
  active.forEach(q => {
    const t = q.tier as string;
    if (t in tierCounts) tierCounts[t]++;
  });

  const filteredActive = tierFilter ? sortedActive.filter(g => g.lead.tier === tierFilter) : sortedActive;

  return (
    <div>
      {/* Tier filter badges */}
      <div className="flex gap-2 mb-4">
        {([
          { tier: null, label: `All (${active.length})`, bg: '#f3f4f6', color: '#374151', border: '#d1d5db', activeBg: '#374151', activeColor: '#fff' },
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

      {/* Active items grouped by priority + thread — low priority goes to Easy-Clear tab */}
      {['urgent', 'important', 'normal'].map(priority => {
        const groups = filteredActive.filter(g => g.lead.priority === priority);
        if (groups.length === 0) return null;
        const pc = priorityColors[priority];
        return (
          <div key={priority}>
            <p className="text-xs font-semibold uppercase tracking-wide mt-4 mb-2 pb-2 border-b pl-3"
              style={{ color: pc.border, borderLeftWidth: 3, borderLeftColor: pc.border, borderBottomColor: 'var(--border)' }}>
              {pc.label} ({groups.reduce((s, g) => s + g.count, 0)})
            </p>
            {groups.map(group => {
              const q = group.lead;
              const isPinned = pinnedIds.has(q.id);
              const isDragging = dragId === q.id;
              const isDragOver = dragOverId === q.id;
              const isThreadExpanded = expandedThreads.has(q.id);
              const hasThread = group.count > 1;

              // Render a single queue item card (used for lead + children)
              const renderQueueCard = (item: typeof q, isChild = false) => (
                <div key={item.id}
                  data-preview-id={item.message_id}
                  data-preview-account={item.account_email || ''}
                  className={`p-4 rounded-xl border mb-2 transition-all cursor-pointer ${isChild ? 'ml-6 border-l-2' : ''}`}
                  style={{
                    background: isChild ? '#f8fafc' : pc.bg,
                    borderColor: isDragOver && !isChild ? 'var(--accent)' : 'var(--border)',
                    borderLeftWidth: isChild ? 2 : 4,
                    borderLeftColor: isChild ? 'var(--muted)' : (isPinned ? '#f59e0b' : pc.border),
                    opacity: isDragging && !isChild ? 0.4 : 1,
                  }}
                  onClick={() => onPreview(item.message_id, item.account_email)}
                  onDoubleClick={() => onDialogPreview?.(item.message_id, item.account_email)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {!isChild && (
                          <button onClick={(e) => { e.stopPropagation(); togglePin(q.id); }} title={isPinned ? 'Unpin' : 'Pin to top'}
                            className="text-sm flex-shrink-0 transition-transform hover:scale-110"
                            style={{ opacity: isPinned ? 1 : 0.3 }}>
                            📌
                          </button>
                        )}
                        <span className="font-semibold text-sm">{item.sender}</span>
                        {!isChild && (
                          <TierDropdown currentTier={item.tier || ''} senderEmail={item.sender_email} senderName={item.sender}
                            onTierChanged={(newTier) => {
                              if (newTier === 'C' || newTier === 'D') {
                                setQueue(prev => prev.filter(i => !group.allIds.includes(i.id)));
                                showToast(`Moved to Cleanup`, `${item.sender} is now Tier ${newTier}`);
                              } else {
                                setQueue(prev => prev.map(i => group.allIds.includes(i.id) ? { ...i, tier: newTier } : i));
                                showToast(`Updated to Tier ${newTier}`, item.sender);
                              }
                            }} />
                        )}
                        {hasThread && !isChild && (
                          <button onClick={(e) => { e.stopPropagation(); setExpandedThreads(prev => { const next = new Set(prev); next.has(q.id) ? next.delete(q.id) : next.add(q.id); return next; }); }}
                            className="px-2 py-0.5 text-[10px] font-semibold rounded-full border"
                            style={{ borderColor: '#c7d2fe', background: '#eef2ff', color: '#4338ca' }}>
                            {group.count} messages {isThreadExpanded ? '▾' : '▸'}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-sm font-medium">{item.subject}</span>
                        {item.received && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: '#f1f5f9', color: '#64748b' }}>
                            {new Date(item.received).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{cleanSnippet(item.summary || '')}</div>
                    </div>
                    {/* Account, score & reply count — top right */}
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{item.account_email}</span>
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: item.priority_score >= 7 ? '#eef2ff' : '#f1f5f9', color: item.priority_score >= 7 ? '#4338ca' : '#64748b' }}>
                        {item.priority_score}/10
                      </span>
                      {item.reply_count > 0 && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: '#eef2ff', color: '#6366f1' }}>
                          {item.reply_count} {item.reply_count === 1 ? 'reply' : 'replies'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { setReplyingTo(replyingTo === item.id && !replyAllTo ? null : item.id); setReplyAllTo(null); }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: replyingTo === item.id && !replyAllTo ? '#6366f1' : 'var(--accent)' }}>Reply</button>
                    <button onClick={() => { setReplyAllTo(replyAllTo === item.id ? null : item.id); setReplyingTo(replyAllTo === item.id ? null : item.id); }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border" style={{ borderColor: 'var(--accent)', color: replyAllTo === item.id ? '#fff' : 'var(--accent)', background: replyAllTo === item.id ? '#7c3aed' : undefined }}>Reply All</button>
                    {!isChild && quickReplyTemplates.length > 0 && (
                      <QuickReplyDropdown templates={quickReplyTemplates}
                        senderEmail={item.sender_email} senderName={item.sender}
                        cc={item.cc || item.to || ''} subject={item.subject}
                        onSend={async (body, label, replyAll) => {
                        try {
                          const savedAccount = _currentAccount;
                          if (item.account_email && item.account_email !== _currentAccount) setCurrentAccount(item.account_email);
                          const payload: Record<string, unknown> = {
                            to: item.sender_email, subject: item.subject, body,
                            threadId: item.thread_id, inReplyTo: item.message_id,
                          };
                          if (replyAll) {
                            const ccList = (item.cc || item.to || '').split(',').map((e: string) => e.trim())
                              .filter((e: string) => e && !e.toLowerCase().includes(item.sender_email.toLowerCase()) && !(item.account_email && e.toLowerCase().includes(item.account_email.toLowerCase())));
                            if (ccList.length > 0) payload.cc = ccList.join(', ');
                          }
                          const res = await gmailPost('reply', payload);
                          if (item.account_email) setCurrentAccount(savedAccount);
                          if (res.success) {
                            showToast(`Quick reply sent${replyAll ? ' to all' : ''}: ${label}`, item.sender);
                            queueAction('archive', item.message_id, item.id, item.account_email);
                          } else { showToast('Failed to send', res.error); }
                        } catch (e) { showToast('Error', String(e)); }
                      }} />
                    )}
                    <SnoozeDropdown onSnooze={(hours, label) => snoozeItem(item.id, hours, label)} />
                    <button onClick={() => queueAction('archive', item.message_id, item.id, item.account_email)} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                    <button onClick={() => queueAction('markRead', item.message_id, item.id, item.account_email)} className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Mark Read</button>
                    <button onClick={() => queueAction('trash', item.message_id, item.id, item.account_email)} className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                    <button onClick={() => setConfirmDelete(item.id + '::' + item.message_id + '::' + item.account_email)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-700" style={{ borderColor: '#fca5a5' }}>Delete</button>
                  </div>
                  {replyingTo === item.id && (
                    <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                      <ReplyComposer
                        to={item.sender_email} subject={item.subject}
                        threadId={item.thread_id} messageId={item.message_id}
                        showToast={showToast} accountEmail={item.account_email}
                        replyAll={replyAllTo === item.id}
                        cc={replyAllTo === item.id ? (item.cc || item.to || '').split(',').map((e: string) => e.trim()).filter((e: string) => e && !e.toLowerCase().includes(item.sender_email.toLowerCase()) && !(item.account_email && e.toLowerCase().includes(item.account_email.toLowerCase()))).join(', ') : undefined}
                        onSent={() => { setReplyingTo(null); setReplyAllTo(null); queueAction('archive', item.message_id, item.id, item.account_email); }}
                        onCancel={() => { setReplyingTo(null); setReplyAllTo(null); }}
                      />
                    </div>
                  )}
                </div>
              );

              return (
                <div key={q.id}
                  draggable
                  onDragStart={() => handleDragStart(q.id)}
                  onDragOver={(e) => handleDragOver(e, q.id)}
                  onDragEnd={handleDragEnd}
                  onDrop={() => handleDrop(q.id)}
                >
                  {renderQueueCard(q)}
                  {/* Thread children — shown when expanded */}
                  {hasThread && isThreadExpanded && group.children.map(child => renderQueueCard(child, true))}
                </div>
              );
            })}
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

function CleanupTab({ messages, onAction, showToast, onPreview, onDialogPreview, reportCount }: { messages: GmailMessage[]; onAction: (action: string, ids: string[], label?: string) => void; showToast: (title: string, subtitle?: string) => void; onPreview: (messageId: string, accountEmail?: string) => void; onDialogPreview?: (messageId: string, accountEmail?: string) => void; reportCount?: (count: number) => void; }) {
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
        <div className="mb-4 p-3 rounded-xl flex items-center justify-between gap-3 sticky top-0 z-20" style={{ background: '#eff6ff', border: '2px solid var(--accent)' }}>
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
                      <div key={msg.id} className="flex items-center justify-between py-2 text-xs border-b" style={{ borderColor: 'var(--border)', background: isMsgSelected ? '#dbeafe' : 'transparent' }} data-preview-id={msg.id} data-preview-account={msg.accountEmail || ''}>
                        <div className="flex items-center gap-2 flex-1 min-w-0 mr-2">
                          <input type="checkbox" checked={isMsgSelected} onChange={() => toggleMessage(msg.id)}
                            disabled={isGroupSelected} className="rounded flex-shrink-0" style={{ accentColor: 'var(--accent)' }} />
                          <div className="min-w-0 cursor-pointer" onClick={() => onPreview(msg.id, msg.accountEmail)} onDoubleClick={() => onDialogPreview?.(msg.id, msg.accountEmail)}>
                            <div className="font-medium truncate hover:underline">{msg.subject}</div>
                            <div className="line-clamp-2 text-xs" style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{cleanSnippet(msg.snippet || '')}</div>
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

function SentMailTab({ accounts, unified, onPreview, onDialogPreview, showToast }: {
  accounts: ConnectedAccount[];
  unified: boolean;
  onPreview: (messageId: string, accountEmail?: string) => void;
  onDialogPreview?: (messageId: string, accountEmail?: string) => void;
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
                <div className="p-4 cursor-pointer" onClick={() => { setExpandedConvo(isExpanded ? null : convo.normalizedSubject); onPreview(latestMsg.id, latestMsg.accountEmail); }} onDoubleClick={() => onDialogPreview?.(latestMsg.id, latestMsg.accountEmail)} data-preview-id={latestMsg.id} data-preview-account={latestMsg.accountEmail || ''}>
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
                    </div>
                  </div>
                </div>
                {/* Expanded messages within conversation */}
                {isExpanded && convo.messages.length > 1 && (
                  <div className="border-t divide-y" style={{ borderColor: 'var(--border)' }}>
                    {convo.messages.map((msg, idx) => (
                      <div key={msg.id} className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors"
                        onClick={() => onPreview(msg.id, msg.accountEmail)}
                        onDoubleClick={() => onDialogPreview?.(msg.id, msg.accountEmail)} data-preview-id={msg.id} data-preview-account={msg.accountEmail || ''}>
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
                      onClick={() => onPreview(msg.id, msg.accountEmail)}
                      onDoubleClick={() => onDialogPreview?.(msg.id, msg.accountEmail)} data-preview-id={msg.id} data-preview-account={msg.accountEmail || ''}>
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

function SnoozedTab({ onAction, showToast, onPreview, onDialogPreview, reloadKey, reportCount }: {
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  onPreview: (messageId: string, accountEmail?: string) => void;
  onDialogPreview?: (messageId: string, accountEmail?: string) => void;
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
      <p className="text-sm">Snooze emails from the Top Tiers tab to deal with them later.</p>
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
            }} data-preview-id={q.message_id} data-preview-account={q.account_email || ''}>
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
                  <div className="text-sm font-medium mt-0.5 cursor-pointer hover:underline" onClick={() => onPreview(q.message_id, q.account_email)} onDoubleClick={() => onDialogPreview?.(q.message_id, q.account_email)}>
                    {q.subject}
                  </div>
                  <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{cleanSnippet(q.summary || '')}</div>
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

function FollowUpTab({ accounts, unified, onPreview, onDialogPreview, showToast, onAction, reportCount }: {
  accounts: ConnectedAccount[];
  unified: boolean;
  onPreview: (messageId: string, accountEmail?: string) => void;
  onDialogPreview?: (messageId: string, accountEmail?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  reportCount?: (count: number) => void;
}) {
  const [starredSent, setStarredSent] = useState<GmailMessage[]>([]);
  const [awaitingReply, setAwaitingReply] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [bgRefreshing, setBgRefreshing] = useState(false);
  const [expandedConvo, setExpandedConvo] = useState<string | null>(null);
  const [cacheAge, setCacheAge] = useState<string | null>(null);

  // Load follow-ups from Supabase cache only — heavy thread-checking runs in cron, not live
  async function loadFromCache() {
    try {
      // In unified mode, fetch all accounts (no account filter)
      const url = unified ? '/api/emailHelperV2/follow-ups' : withAccount('/api/emailHelperV2/follow-ups');
      const cacheRes = await fetch(url).then(r => r.json());
      if (cacheRes.success && cacheRes.data?.items?.length > 0) {
        const items = cacheRes.data.items as { message_id: string; thread_id: string; sender: string; sender_email: string; subject: string; snippet: string; date: string; account_email: string; type: string }[];
        const starred = items.filter(i => i.type === 'starred').map(i => ({
          id: i.message_id, threadId: i.thread_id, sender: i.sender, senderEmail: i.sender_email,
          subject: i.subject, snippet: i.snippet, date: i.date, accountEmail: i.account_email,
          body: '', bodyHtml: '', to: '', cc: '', labelIds: [], isUnread: false,
        } as GmailMessage));
        const awaiting = items.filter(i => i.type === 'awaiting').map(i => ({
          id: i.message_id, threadId: i.thread_id, sender: i.sender, senderEmail: i.sender_email,
          subject: i.subject, snippet: i.snippet, date: i.date, accountEmail: i.account_email,
          body: '', bodyHtml: '', to: '', cc: '', labelIds: [], isUnread: false,
        } as GmailMessage));
        starred.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        awaiting.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setStarredSent(starred);
        setAwaitingReply(awaiting);
        reportCount?.(starred.length + awaiting.length);
        if (cacheRes.data.computed_at) {
          const age = Math.round((Date.now() - new Date(cacheRes.data.computed_at).getTime()) / (1000 * 60));
          setCacheAge(age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`);
        }
      }
    } catch (e) {
      console.error('Follow-up cache load failed:', e);
    }
  }

  // On mount: load from cache (instant, no heavy Gmail API calls)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadFromCache();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

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
        {bgRefreshing ? (
          <span className="text-xs flex items-center gap-1" style={{ color: 'var(--accent)' }}>
            <span className="w-3 h-3 border border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            Refreshing cache...
          </span>
        ) : cacheAge ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Updated {cacheAge}</span>
        ) : null}
        <button onClick={() => { setBgRefreshing(true); loadFromCache().finally(() => setBgRefreshing(false)); }} disabled={bgRefreshing} className="ml-auto px-3 py-1 text-xs rounded-full border font-medium" style={{ borderColor: 'var(--border)', color: 'var(--muted)', opacity: bgRefreshing ? 0.5 : 1 }}>Refresh</button>
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
                  <div className="p-4 cursor-pointer" onClick={() => setExpandedConvo(isExpanded ? null : `s-${convo.subject}`)} data-preview-id={latest.id} data-preview-account={latest.accountEmail || ''}>
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
                        <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{cleanSnippet(latest.snippet || '')}</div>
                        {latest.accountEmail && accounts.length > 1 && (
                          <div className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>via {latest.accountEmail}</div>
                        )}
                      </div>
                      <div className="flex gap-2 flex-shrink-0 items-center">
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
                          onClick={() => onPreview(msg.id, msg.accountEmail)}
                          onDoubleClick={() => onDialogPreview?.(msg.id, msg.accountEmail)}>
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
                  onDoubleClick={() => onDialogPreview?.(latest.id, latest.accountEmail)}
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', borderLeftWidth: 3, borderLeftColor: urgencyColor }} data-preview-id={latest.id} data-preview-account={latest.accountEmail || ''}>
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
                      <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{cleanSnippet(latest.snippet || '')}</div>
                      {latest.accountEmail && accounts.length > 1 && (
                        <div className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>via {latest.accountEmail}</div>
                      )}
                    </div>
                    <div className="flex gap-2 flex-shrink-0 items-center">
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
                      <button onClick={(e) => { e.stopPropagation(); setAwaitingReply(prev => prev.filter(m => m.id !== latest.id)); reportCount?.((starredSent.length) + (awaitingReply.length - 1)); showToast('Dismissed from follow-up'); }}
                        className="px-2 py-1 text-xs rounded-lg border" style={{ borderColor: '#fbbf24', color: '#92400e' }}>
                        Dismiss
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

// Detect potential duplicate senders by name similarity — returns clustered groups
interface DuplicateCluster {
  name: string;           // Display name (e.g. "Gina Priolo")
  primary: any;           // The sender with most replies (merge target)
  others: any[];          // All other senders to merge into primary
  reason: string;
}

function findSenderDuplicates(senders: any[]): DuplicateCluster[] {
  // Group by normalized full name (first + last)
  const nameGroups: Record<string, any[]> = {};
  for (const s of senders) {
    const name = (s.display_name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (!name || name.length < 3) continue;
    const firstName = name.split(/\s+/)[0];
    if (!firstName || firstName.length < 2) continue;
    if (!nameGroups[firstName]) nameGroups[firstName] = [];
    nameGroups[firstName].push(s);
  }

  const clusters: DuplicateCluster[] = [];

  for (const [, group] of Object.entries(nameGroups)) {
    if (group.length < 2) continue;

    // Build connected clusters within this first-name group using union-find
    // Two senders connect if they share last name, domain, or similar name
    const parent: number[] = group.map((_, i) => i);
    function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
    function union(a: number, b: number) { parent[find(a)] = find(b); }

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aName = (a.display_name || '').toLowerCase().trim();
        const bName = (b.display_name || '').toLowerCase().trim();
        const aLast = aName.split(/\s+/).slice(1).join(' ');
        const bLast = bName.split(/\s+/).slice(1).join(' ');
        const aDomain = a.sender_email.split('@')[1]?.toLowerCase();
        const bDomain = b.sender_email.split('@')[1]?.toLowerCase();

        const matched = (aLast && bLast && aLast === bLast) ||
          (aDomain === bDomain && aName === bName) ||
          (aLast && bLast && (aLast.includes(bLast) || bLast.includes(aLast)));

        if (matched) union(i, j);
      }
    }

    // Collect clusters
    const clusterMap: Record<number, any[]> = {};
    group.forEach((s, i) => {
      const root = find(i);
      if (!clusterMap[root]) clusterMap[root] = [];
      clusterMap[root].push(s);
    });

    for (const members of Object.values(clusterMap)) {
      if (members.length < 2) continue;
      // Primary = highest reply count
      members.sort((a: any, b: any) => (b.reply_count || 0) - (a.reply_count || 0));
      const primary = members[0];
      const others = members.slice(1);
      const displayName = primary.display_name || others[0]?.display_name || 'Unknown';
      clusters.push({
        name: displayName,
        primary,
        others,
        reason: others.length === 1
          ? `Same person, ${others.length + 1} emails`
          : `Same person, ${others.length + 1} email addresses`,
      });
    }
  }

  return clusters;
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
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('email_helper_dismissed_dupes') || '[]')); }
    catch { return new Set(); }
  });
  const [merging, setMerging] = useState<string | null>(null);
  // Manual merge state
  const [showManualMerge, setShowManualMerge] = useState(false);
  const [mergePrimary, setMergePrimary] = useState('');
  const [mergeSecondary, setMergeSecondary] = useState('');

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

  async function mergeSenders(primaryEmail: string, secondaryEmails: string[]) {
    setMerging(primaryEmail);
    try {
      for (const sec of secondaryEmails) {
        const res = await apiPut('senders', { action: 'merge', primary_email: primaryEmail, secondary_email: sec });
        if (!res.success) {
          showToast('Error', res.error);
          setMerging(null);
          return;
        }
      }
      showToast('Senders merged', `${secondaryEmails.length} address${secondaryEmails.length > 1 ? 'es' : ''} → ${primaryEmail}`);
      loadData();
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
  // Sort senders: by interactions (reply_count) DESC, then name ASC
  const sortedSenders = [...senders].sort((a: any, b: any) => {
    const aCount = (a.reply_count || 0);
    const bCount = (b.reply_count || 0);
    if (bCount !== aCount) return bCount - aCount;
    const aName = (a.display_name || a.sender_email || '').toLowerCase();
    const bName = (b.display_name || b.sender_email || '').toLowerCase();
    return aName.localeCompare(bName);
  });
  const filteredSenders = filterTier === 'all' ? sortedSenders : sortedSenders.filter(s => s.tier === filterTier);

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
            <button onClick={() => { setShowManualMerge(!showManualMerge); if (showAddForm) setShowAddForm(false); }}
              className="px-4 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: showManualMerge ? '#16a34a' : 'var(--border)', color: showManualMerge ? '#16a34a' : undefined }}>
              {showManualMerge ? 'Cancel Merge' : 'Merge Senders'}
            </button>
            <button onClick={() => { setShowAddForm(!showAddForm); if (showManualMerge) setShowManualMerge(false); }}
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

        {/* Manual merge form */}
        {showManualMerge && (
          <div className="mb-4 p-4 rounded-lg border" style={{ background: '#f0fdf4', borderColor: '#16a34a' }}>
            <div className="text-xs font-semibold mb-2" style={{ color: '#166534' }}>Merge two senders into one</div>
            <p className="text-[11px] mb-3" style={{ color: '#475569' }}>
              Pick the <strong>primary</strong> sender (the one to keep) and the <strong>secondary</strong> (will be absorbed). Reply counts and tier will be combined.
            </p>
            <div className="flex gap-2 flex-wrap items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="text-[10px] font-medium block mb-1" style={{ color: '#166534' }}>Keep (primary)</label>
                <select value={mergePrimary} onChange={e => setMergePrimary(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border" style={{ borderColor: '#86efac' }}>
                  <option value="">Select sender...</option>
                  {senders.sort((a: any, b: any) => (a.display_name || a.sender_email).localeCompare(b.display_name || b.sender_email)).map((s: any) => (
                    <option key={s.sender_email} value={s.sender_email}>
                      {s.display_name || s.sender_email} — {s.sender_email} ({s.reply_count || 0} replies, Tier {s.tier || '?'})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-shrink-0 text-xs font-bold self-center px-2" style={{ color: '#16a34a' }}>←</div>
              <div className="flex-1 min-w-[200px]">
                <label className="text-[10px] font-medium block mb-1" style={{ color: '#dc2626' }}>Absorb (secondary)</label>
                <select value={mergeSecondary} onChange={e => setMergeSecondary(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border" style={{ borderColor: '#fca5a5' }}>
                  <option value="">Select sender...</option>
                  {senders.filter((s: any) => s.sender_email !== mergePrimary).sort((a: any, b: any) => (a.display_name || a.sender_email).localeCompare(b.display_name || b.sender_email)).map((s: any) => (
                    <option key={s.sender_email} value={s.sender_email}>
                      {s.display_name || s.sender_email} — {s.sender_email} ({s.reply_count || 0} replies, Tier {s.tier || '?'})
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={async () => {
                  if (!mergePrimary || !mergeSecondary) { showToast('Select both senders'); return; }
                  if (mergePrimary === mergeSecondary) { showToast('Cannot merge sender with itself'); return; }
                  await mergeSenders(mergePrimary, [mergeSecondary]);
                  setMergePrimary('');
                  setMergeSecondary('');
                }}
                disabled={!mergePrimary || !mergeSecondary || !!merging}
                className="px-4 py-2 text-xs font-semibold rounded-lg text-white transition-all active:scale-95"
                style={{ background: mergePrimary && mergeSecondary ? '#16a34a' : '#94a3b8' }}>
                {merging ? 'Merging...' : 'Merge'}
              </button>
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

        {/* Sender linking suggestions — clustered by person */}
        {(() => {
          const clusters = findSenderDuplicates(senders).filter(c => {
            const key = [c.primary.sender_email, ...c.others.map((o: any) => o.sender_email)].sort().join('|');
            return !dismissedSuggestions.has(key);
          });
          if (clusters.length === 0) return null;
          return (
            <div className="mb-4 rounded-xl border p-4" style={{ background: '#fefce8', borderColor: '#fbbf24' }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold" style={{ color: '#92400e' }}>Possible duplicate senders</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#fef3c7', color: '#92400e' }}>
                  {clusters.length} {clusters.length === 1 ? 'person' : 'people'}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {clusters.slice(0, 5).map((c) => {
                  const clusterKey = [c.primary.sender_email, ...c.others.map((o: any) => o.sender_email)].sort().join('|');
                  const isMerging = merging === c.primary.sender_email;
                  const allEmails = [c.primary, ...c.others];
                  const totalReplies = allEmails.reduce((sum: number, s: any) => sum + (s.reply_count || 0), 0);
                  return (
                    <div key={clusterKey} className="p-3 rounded-lg border" style={{ background: 'white', borderColor: '#fde68a' }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0" style={{ background: '#f59e0b' }}>
                              {(c.name || '?')[0]?.toUpperCase()}
                            </div>
                            <div>
                              <div className="font-semibold text-sm">{c.name}</div>
                              <div className="text-[10px]" style={{ color: '#92400e' }}>{c.reason} &middot; {totalReplies} total emails sent</div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5 ml-10">
                            {allEmails.map((s: any, idx: number) => (
                              <span key={s.sender_email}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md"
                                style={{
                                  background: idx === 0 ? '#dcfce7' : '#f1f5f9',
                                  border: idx === 0 ? '1px solid #86efac' : '1px solid #e2e8f0',
                                  color: idx === 0 ? '#166534' : '#475569',
                                }}>
                                {idx === 0 && <span className="text-[9px] font-bold">★</span>}
                                {s.sender_email}
                                <span className="opacity-60">({s.reply_count || 0})</span>
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap-2 flex-shrink-0 items-center">
                          <button onClick={() => mergeSenders(c.primary.sender_email, c.others.map((o: any) => o.sender_email))}
                            disabled={isMerging}
                            className="px-4 py-2 text-xs font-semibold rounded-lg text-white transition-all active:scale-95" style={{ background: isMerging ? 'var(--muted)' : '#16a34a' }}>
                            {isMerging ? 'Merging...' : `Merge ${c.others.length === 1 ? '2' : c.others.length + 1} into 1`}
                          </button>
                          <button onClick={() => setDismissedSuggestions(prev => { const next = new Set([...prev, clusterKey]); localStorage.setItem('email_helper_dismissed_dupes', JSON.stringify([...next])); return next; })}
                            className="px-3 py-2 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                            Not same
                          </button>
                        </div>
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
                <th className="text-left p-2">Sender</th><th className="p-2 text-center">Emails Sent</th><th className="p-2">Tier</th><th className="p-2 text-center" title="Auto-archive update-only messages from this sender">Auto-Clean</th><th className="p-2"></th>
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
                        <td className="p-2 text-center">
                          <button
                            onClick={async () => {
                              const newVal = !s.auto_archive_updates;
                              const res = await apiPut('senders', { sender_email: s.sender_email, auto_archive_updates: newVal });
                              if (res.success) {
                                setSenders((prev: any[]) => prev.map((sender: any) => sender.sender_email === s.sender_email ? { ...sender, auto_archive_updates: newVal } : sender));
                                showToast(newVal ? 'Auto-clean ON' : 'Auto-clean OFF', s.display_name);
                              }
                            }}
                            className="text-xs px-2 py-1 rounded-full font-medium transition-all"
                            title={s.auto_archive_updates ? 'Updates from this sender will be auto-archived' : 'Click to auto-archive update-only messages'}
                            style={{
                              background: s.auto_archive_updates ? '#dcfce7' : '#f1f5f9',
                              color: s.auto_archive_updates ? '#166534' : '#94a3b8',
                              border: s.auto_archive_updates ? '1px solid #86efac' : '1px solid #e2e8f0',
                            }}>
                            {s.auto_archive_updates ? 'ON' : 'OFF'}
                          </button>
                        </td>
                        <td className="p-2">
                          <button onClick={() => removeSender(s.sender_email)} className="text-xs px-2 py-0.5 rounded border text-red-400 hover:text-red-600" style={{ borderColor: 'var(--border)' }}>✕</button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr><td colSpan={5} className="p-0">
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
                                        {cleanSnippet(msg.snippet || '')}
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

// ============ SEARCH REVIEWS TAB ============

function SearchReviewsTab({ messages, onAction, showToast, onPreview, onDialogPreview, quickReplyTemplates, onClose, onRemove }: {
  messages: GmailMessage[];
  onAction: (action: string, ids: string[], label?: string, overrideAccount?: string) => void;
  showToast: (title: string, subtitle?: string) => void;
  onPreview: (messageId: string, accountEmail?: string) => void;
  onDialogPreview?: (messageId: string, accountEmail?: string) => void;
  quickReplyTemplates: { id: string; label: string; body: string }[];
  onClose: () => void;
  onRemove: (id: string) => void;
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyAllTo, setReplyAllTo] = useState<string | null>(null);
  const [senderTiers, setSenderTiers] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet('senders');
        if (res.success && res.data) {
          const tiers: Record<string, string> = {};
          for (const s of res.data) tiers[s.sender_email.toLowerCase()] = s.tier;
          setSenderTiers(tiers);
        }
      } catch {}
    })();
  }, []);

  if (messages.length === 0) return (
    <div className="text-center py-16" style={{ color: 'var(--muted)' }}>
      <p className="text-lg mb-2">No search results to review</p>
      <p className="text-sm">Use the search bar to find emails, select them, and click "Open Selected".</p>
    </div>
  );

  const allIds = messages.map(m => m.id);

  return (
    <div>
      {/* Header with bulk actions */}
      <div className="flex items-center justify-between mb-4 p-3 rounded-xl sticky top-0 z-20" style={{ background: '#eff6ff', border: '2px solid var(--accent)' }}>
        <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
          {messages.length} email{messages.length !== 1 ? 's' : ''} to review
        </span>
        <div className="flex gap-2">
          <button onClick={() => {
            const byAccount = new Map<string, string[]>();
            for (const m of messages) { const a = m.accountEmail || _currentAccount; if (!byAccount.has(a)) byAccount.set(a, []); byAccount.get(a)!.push(m.id); }
            for (const [a, ids] of byAccount) onAction('markRead', ids, undefined, a);
          }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', background: 'white' }}>Mark All Read</button>
          <button onClick={() => {
            const byAccount = new Map<string, string[]>();
            for (const m of messages) { const a = m.accountEmail || _currentAccount; if (!byAccount.has(a)) byAccount.set(a, []); byAccount.get(a)!.push(m.id); }
            for (const [a, ids] of byAccount) onAction('archive', ids, undefined, a);
            onClose();
          }}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--accent)' }}>Archive All</button>
          <button onClick={() => {
            const byAccount = new Map<string, string[]>();
            for (const m of messages) { const a = m.accountEmail || _currentAccount; if (!byAccount.has(a)) byAccount.set(a, []); byAccount.get(a)!.push(m.id); }
            for (const [a, ids] of byAccount) onAction('trash', ids, undefined, a);
            onClose();
          }}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: 'var(--urgent)' }}>Trash All</button>
          <button onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Close</button>
        </div>
      </div>

      {/* Email cards — triage style */}
      <div className="flex flex-col gap-2">
        {messages.map(msg => {
          const tier = senderTiers[msg.senderEmail?.toLowerCase()] || '';
          const borderColor = tier === 'A' ? '#22c55e' : tier === 'B' ? '#f59e0b' : tier === 'C' ? '#3b82f6' : 'var(--border)';
          const bgColor = tier === 'A' ? '#f0fdf4' : tier === 'B' ? '#fffbeb' : tier === 'C' ? '#eff6ff' : 'var(--card)';

          return (
            <div key={msg.id}
              data-preview-id={msg.id}
              data-preview-account={msg.accountEmail || ''}
              className="p-4 rounded-xl border transition-all cursor-pointer"
              style={{ background: bgColor, borderColor, borderLeftWidth: 4 }}
              onClick={() => onPreview(msg.id, msg.accountEmail)}
              onDoubleClick={() => onDialogPreview?.(msg.id, msg.accountEmail)}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{msg.sender}</span>
                    <TierDropdown currentTier={tier} senderEmail={msg.senderEmail} senderName={msg.sender}
                      onTierChanged={(newTier) => {
                        setSenderTiers(prev => ({ ...prev, [msg.senderEmail.toLowerCase()]: newTier }));
                        showToast(`Set to Tier ${newTier}`, msg.sender);
                      }} />
                    {msg.isUnread && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--accent)' }} />}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-sm font-medium">{msg.subject}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: '#f1f5f9', color: '#64748b' }}>
                      {new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{cleanSnippet(msg.snippet || '')}</div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {msg.accountEmail && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{msg.accountEmail}</span>}
                  {tier && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: bgColor, color: borderColor, border: `1px solid ${borderColor}` }}>Tier {tier}</span>}
                </div>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { setReplyingTo(replyingTo === msg.id && !replyAllTo ? null : msg.id); setReplyAllTo(null); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white" style={{ background: replyingTo === msg.id && !replyAllTo ? '#6366f1' : 'var(--accent)' }}>Reply</button>
                <button onClick={() => { setReplyAllTo(replyAllTo === msg.id ? null : msg.id); setReplyingTo(replyAllTo === msg.id ? null : msg.id); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border" style={{ borderColor: 'var(--accent)', color: replyAllTo === msg.id ? '#fff' : 'var(--accent)', background: replyAllTo === msg.id ? '#7c3aed' : undefined }}>Reply All</button>
                {quickReplyTemplates.length > 0 && (
                  <QuickReplyDropdown templates={quickReplyTemplates}
                    senderEmail={msg.senderEmail} senderName={msg.sender}
                    cc={msg.cc || msg.to || ''} subject={msg.subject}
                    onSend={async (body, label, replyAll) => {
                      const savedAccount = _currentAccount;
                      if (msg.accountEmail && msg.accountEmail !== _currentAccount) setCurrentAccount(msg.accountEmail);
                      const payload: Record<string, unknown> = { to: msg.senderEmail, subject: msg.subject, body, threadId: msg.threadId, inReplyTo: msg.id };
                      if (replyAll) {
                        const ccList = (msg.cc || msg.to || '').split(',').map((e: string) => e.trim()).filter((e: string) => e && !e.toLowerCase().includes(msg.senderEmail.toLowerCase()) && !(msg.accountEmail && e.toLowerCase().includes(msg.accountEmail.toLowerCase())));
                        if (ccList.length > 0) payload.cc = ccList.join(', ');
                      }
                      const res = await gmailPost('reply', payload);
                      if (msg.accountEmail) setCurrentAccount(savedAccount);
                      if (res.success) { showToast(`Quick reply sent${replyAll ? ' to all' : ''}`, msg.sender); onAction('archive', [msg.id], undefined, msg.accountEmail); onRemove(msg.id); }
                      else showToast('Failed', res.error);
                    }} />
                )}
                <SnoozeDropdown onSnooze={(hours, label) => {
                  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
                  apiPost('queue', { message_id: msg.id, account_email: msg.accountEmail || _currentAccount, status: 'snoozed', snoozed_until: until, sender: msg.sender, sender_email: msg.senderEmail, subject: msg.subject });
                  showToast('Snoozed', `Will reappear ${label}`);
                  onRemove(msg.id);
                }} />
                <button onClick={() => { onAction('archive', [msg.id], undefined, msg.accountEmail); onRemove(msg.id); }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Archive</button>
                <button onClick={() => { onAction('markRead', [msg.id], undefined, msg.accountEmail); }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>Mark Read</button>
                <button onClick={() => { onAction('trash', [msg.id], undefined, msg.accountEmail); onRemove(msg.id); }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-500" style={{ borderColor: 'var(--border)' }}>Trash</button>
                <button onClick={() => setConfirmDelete(msg.id + '::' + (msg.accountEmail || ''))}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border text-red-700" style={{ borderColor: '#fca5a5' }}>Delete</button>
              </div>
              {replyingTo === msg.id && (
                <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                  <ReplyComposer
                    to={msg.senderEmail} subject={msg.subject}
                    threadId={msg.threadId} messageId={msg.id}
                    showToast={showToast} accountEmail={msg.accountEmail}
                    replyAll={replyAllTo === msg.id}
                    cc={replyAllTo === msg.id ? (msg.cc || msg.to || '').split(',').map((e: string) => e.trim()).filter((e: string) => e && !e.toLowerCase().includes(msg.senderEmail.toLowerCase()) && !(msg.accountEmail && e.toLowerCase().includes(msg.accountEmail.toLowerCase()))).join(', ') : undefined}
                    onSent={() => { setReplyingTo(null); setReplyAllTo(null); onAction('archive', [msg.id], undefined, msg.accountEmail); onRemove(msg.id); }}
                    onCancel={() => { setReplyingTo(null); setReplyAllTo(null); }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmDelete && (() => {
        const [msgId, acctEmail] = confirmDelete.split('::');
        return (
          <ConfirmModal
            title="Permanently Delete"
            message="This will permanently delete this message from Gmail. This cannot be undone."
            confirmLabel="Delete Forever"
            confirmColor="#dc2626"
            onConfirm={() => { onAction('delete', [msgId], undefined, acctEmail); onRemove(msgId); setConfirmDelete(null); }}
            onCancel={() => setConfirmDelete(null)}
          />
        );
      })()}
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
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  async function setPrimary(email: string) {
    const res = await apiPut('accounts', { email, action: 'set_primary' });
    if (res.success) {
      showToast('Primary account set', email);
      onRefresh();
    } else {
      showToast('Error', res.error);
    }
  }

  async function disconnectAccount(email: string) {
    setDisconnecting(true);
    const res = await apiDelete('accounts', { email });
    setDisconnecting(false);
    if (res.success) {
      showToast('Account disconnected', email);
      setConfirmDisconnect(null);
      onRefresh();
    } else {
      showToast('Error', res.error || 'Failed to disconnect');
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
                  {accounts.length > 1 && (
                    <button onClick={() => setConfirmDisconnect(a.email)}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium text-red-600 border"
                      style={{ borderColor: '#fca5a5' }}>
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Disconnect confirmation dialog */}
        {confirmDisconnect && (
          <div className="mt-4 p-4 rounded-lg border" style={{ background: '#fef2f2', borderColor: '#fca5a5' }}>
            <p className="text-sm font-medium text-red-800 mb-2">Disconnect {confirmDisconnect}?</p>
            <p className="text-xs text-red-700 mb-3">This will remove the account and all associated triage data and queue items. Your Gmail account itself will not be affected.</p>
            <div className="flex gap-2">
              <button onClick={() => disconnectAccount(confirmDisconnect)} disabled={disconnecting}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg text-white"
                style={{ background: disconnecting ? 'var(--muted)' : '#dc2626' }}>
                {disconnecting ? 'Disconnecting...' : 'Yes, Disconnect'}
              </button>
              <button onClick={() => setConfirmDisconnect(null)}
                className="px-4 py-1.5 text-xs rounded-lg border"
                style={{ borderColor: 'var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manual Tools */}
      <div className="rounded-xl border p-6" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <h3 className="font-semibold mb-2">Manual Tools</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>Top Tiers runs automatically every 2 minutes. Use these to run manually.</p>
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
