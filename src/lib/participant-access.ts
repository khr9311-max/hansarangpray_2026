import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { isAdmin } from './auth';

export function editToken(id: string, expires = Date.now() + 12 * 60 * 60 * 1000) {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error('관리자 설정을 확인해 주세요.');
  return `${expires}.${createHmac('sha256', secret).update(`participant-edit:${id}:${expires}`).digest('hex')}`;
}

export function validEditToken(id: string, token: unknown) {
  if (typeof token !== 'string') return false;
  const expires = Number(token.split('.')[0]);
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
  const expected = Buffer.from(editToken(id, expires));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function allowParticipantEdit(id: string, token = '') {
  const saved = (await cookies()).get(`jjak_edit_${id}`)?.value ?? '';
  return validEditToken(id, token) || validEditToken(id, saved) || await isAdmin();
}

export async function rememberParticipantAccess(id: string) {
  (await cookies()).set(`jjak_edit_${id}`, editToken(id), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 43200,
  });
}
