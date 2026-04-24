import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';

// Cap input so a runaway client can't burn tokens.
const MAX_BODY_CHARS = 8000;

const STYLES: Record<string, string> = {
  improve: 'Polish the draft for clarity, grammar, and flow. Keep meaning and tone intact.',
  formal:  'Rewrite in a formal, professional tone suitable for business email.',
  casual:  'Rewrite in a friendly, conversational tone — natural, warm, not stiff.',
  shorter: 'Make the draft significantly more concise while preserving every key point and the intent.',
  longer:  'Expand the draft with more detail, context, and a slightly fuller explanation.',
};

const SYSTEM_PROMPT = `You rewrite email drafts to match a requested style.

Rules — follow exactly:
- Output ONLY the rewritten email body. No preamble, no explanation, no quotes around the result, no "Here is..." prefix.
- Preserve the original meaning, intent, and any specific facts (names, dates, numbers, links).
- Keep the same language as the input draft.
- Match the user's voice — don't introduce new claims, promises, or content the user didn't write.
- Preserve placeholders like [Name], {{var}}, or TODOs without altering them.
- Do not add a signature, sign-off, or salutation that wasn't already present (unless the requested style explicitly calls for it).
- If the draft is already a single line or fragment, keep the response short — don't pad.
- Plain text only. No markdown, no HTML, no asterisks for emphasis.`;

export async function POST(request: NextRequest) {
  // CSRF: same-origin only
  const origin = request.headers.get('origin');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (origin && appUrl) {
    const expectedOrigin = new URL(appUrl).origin;
    if (origin !== expectedOrigin) {
      return apiError('Cross-origin request blocked', 403);
    }
  }

  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return apiError('AI rewrite is not configured', 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON', 400);
  }

  const draft = typeof (body as { body?: unknown })?.body === 'string'
    ? ((body as { body: string }).body)
    : '';
  const style = typeof (body as { style?: unknown })?.style === 'string'
    ? ((body as { style: string }).style)
    : 'improve';

  if (!draft.trim()) return apiError('Draft is empty', 400);
  if (draft.length > MAX_BODY_CHARS) {
    return apiError(`Draft is too long (max ${MAX_BODY_CHARS} chars)`, 413);
  }

  const styleInstruction = STYLES[style] || STYLES.improve;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Style: ${styleInstruction}\n\n--- Draft ---\n${draft}\n\nReturn ONLY the rewritten email body.`,
      }],
    });

    const block = response.content.find(b => b.type === 'text');
    const rewritten = block?.type === 'text' ? block.text.trim() : '';
    if (!rewritten) return apiError('Empty response from model', 502);

    return apiSuccess({
      rewritten,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return apiError('AI rewrite is rate-limited — try again in a moment', 429);
    }
    if (err instanceof Anthropic.APIError) {
      console.error('ai-rewrite Anthropic error:', err.status, err.message);
      return apiError('AI rewrite failed', 502);
    }
    console.error('ai-rewrite unexpected error:', err);
    return apiError('AI rewrite failed', 500);
  }
}
