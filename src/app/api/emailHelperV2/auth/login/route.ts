import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAuthUrl } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get('state') || 'login';

  const authUrl = getGoogleAuthUrl(state);
  return NextResponse.redirect(authUrl);
}
