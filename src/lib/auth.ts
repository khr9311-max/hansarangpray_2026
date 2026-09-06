import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'jjak_admin';
const MAX_AGE = 60 * 60 * 12; // 12시간

function expectedToken(): string {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD 가 설정되지 않았습니다.');
  return createHmac('sha256', password).update('jjak-gido-admin').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** 비밀번호가 맞으면 세션 쿠키를 심고 true 를 돌려줍니다. */
export async function signIn(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD ?? '';
  if (!expected || !safeEqual(password, expected)) return false;

  (await cookies()).set(COOKIE_NAME, expectedToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
  return true;
}

export async function signOut() {
  (await cookies()).delete(COOKIE_NAME);
}

export async function isAdmin(): Promise<boolean> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    return safeEqual(token, expectedToken());
  } catch {
    return false;
  }
}

/** 서버 액션 첫 줄에서 호출해 권한을 강제합니다. */
export async function assertAdmin() {
  if (!(await isAdmin())) throw new Error('관리자 인증이 필요합니다.');
}
