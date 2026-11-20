import { NextResponse } from 'next/server';
import { getEventRevision } from '@/lib/event';

export const dynamic = 'force-dynamic';

/** Public change indicator contains no names, private links or prayer requests. */
export async function GET() {
  try {
    const revision = await getEventRevision();
    return NextResponse.json({ revision }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '잠시 후 다시 시도해 주세요.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
