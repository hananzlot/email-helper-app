import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * POST /api/emailHelperV2/admin/auth
 * Server-side admin password verification.
 * Password checked against ADMIN_PASSWORD env var using timing-safe comparison.
 */
export async function POST(request: NextRequest) {
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
