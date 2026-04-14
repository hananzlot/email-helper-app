/**
 * MBOX format assembly.
 * Each message starts with "From <sender> <date>" followed by the raw RFC 2822 content.
 * Messages are separated by blank lines.
 */

/**
 * Convert a base64url-encoded raw Gmail message to an MBOX entry.
 * Gmail's raw format is base64url (RFC 4648 §5) — needs conversion to standard base64.
 */
export function rawMessageToMbox(raw: string, internalDate: string): string {
  // Decode base64url to get RFC 2822 message
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const messageBytes = Buffer.from(base64, 'base64').toString('utf-8');

  // Extract sender from the From header for the MBOX "From " line
  const fromMatch = messageBytes.match(/^From:\s*(.+?)$/mi);
  const sender = fromMatch
    ? (fromMatch[1].match(/<(.+?)>/) || [null, fromMatch[1]])[1]?.trim() || 'unknown'
    : 'unknown';

  // Convert internalDate (epoch ms) to POSIX asctime format: "Thu Jan 01 00:00:00 2026"
  const date = new Date(parseInt(internalDate));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const asctime = `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} ${date.getUTCFullYear()}`;

  // Escape "From " lines within the message body (MBOX convention: prefix with >)
  const escapedMessage = messageBytes.replace(/^From /gm, '>From ');

  return `From ${sender} ${asctime}\n${escapedMessage}\n\n`;
}

/**
 * Assemble multiple raw messages into an MBOX buffer.
 */
export function assembleMbox(messages: { raw: string; internalDate: string }[]): Buffer {
  const parts = messages.map(m => rawMessageToMbox(m.raw, m.internalDate));
  return Buffer.from(parts.join(''), 'utf-8');
}

/** Max MBOX file size before splitting into parts (~50MB) */
export const MAX_MBOX_SIZE = 50 * 1024 * 1024;
