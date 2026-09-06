'use client';

import { createBrowserClient } from '@supabase/ssr';

/** 브라우저용 익명 클라이언트. 조회와 Realtime 구독에만 사용합니다. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
