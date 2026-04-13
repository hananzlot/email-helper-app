import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

// Simple in-memory rate limiter: max 5 attempts per IP per 15 minutes
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

/**
 * POST /api/emailHelperV2/admin/auth
 * Server-side admin password verification.
 * Rate limited: 5 attempts per IP per 15 minutes.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json({ error: 'Admin access not configured' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body;
  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Missing password' }, { status: 400 });
  }

  // Timing-safe comparison to prevent timing attacks
  const a = Buffer.from(createHmac('sha256', 'admin-check').update(password).digest('hex'));
  const b = Buffer.from(createHmac('sha256', 'admin-check').update(adminPassword).digest('hex'));

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  return NextResponse.json({ success: true });
}
