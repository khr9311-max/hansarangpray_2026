import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/** 서버에서 읽기용으로 쓰는 익명 클라이언트 (RLS 적용). */
export function createServerClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * 관리자 전용 클라이언트. service_role 키는 RLS 를 우회하므로
 * 반드시 서버 액션 안에서, 비밀번호 검증을 통과한 뒤에만 사용하세요.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다.');

  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false },
  });
}
