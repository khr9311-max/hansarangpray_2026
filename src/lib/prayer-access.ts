import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { validEditToken } from './participant-access';
import { PRAYER_ACCESS_SECONDS } from './prayer-weeks';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cookieName = (id: string) => `jjak_prayer_${id}`;

export function prayerCheckToken(id: string, expires = Date.now() + PRAYER_ACCESS_SECONDS * 1000) {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error('관리자 설정을 확인해 주세요.');
  const signature = createHmac('sha256', secret).update(`participant-prayer-check:${id}:${expires}`).digest('hex');
  return `${expires}.${signature}`;
}

export function validPrayerCheckToken(id: string, token: unknown): token is string {
  if (!UUID.test(id) || typeof token !== 'string' || !/^\d{13}\.[a-f0-9]{64}$/.test(token)) return false;
  const expires = Number(token.split('.')[0]);
  if (expires <= Date.now()) return false;
  return timingSafeEqual(Buffer.from(prayerCheckToken(id, expires)), Buffer.from(token));
}

/** Only participant proof grants a write, including on devices logged in as an admin. */
export async function canCheckPrayer(id: string) {
  if (!UUID.test(id)) return false;
  const jar = await cookies();
  return validPrayerCheckToken(id, jar.get(cookieName(id))?.value)
    || validEditToken(id, jar.get(`jjak_edit_${id}`)?.value);
}

export async function rememberPrayerAccess(id: string, token = prayerCheckToken(id)) {
  const expires = new Date(Number(token.split('.')[0]));
  (await cookies()).set(cookieName(id), token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    path: `/me/${id}`, expires,
  });
}
