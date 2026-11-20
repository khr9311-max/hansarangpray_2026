import { NextRequest, NextResponse } from 'next/server';
import { rememberPrayerAccess, validPrayerCheckToken } from '@/lib/prayer-access';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get('token');
  if (validPrayerCheckToken(id, token)) await rememberPrayerAccess(id, token);

  // Keep the browser's host so the cookie also works behind proxies and aliases.
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: `/me/${encodeURIComponent(id)}`,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
