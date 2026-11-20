import 'server-only';
import { StorageError } from '../storage-errors';

export function supabaseUrl(): string {
  return process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
}

function rpcUrl(): string {
  let base: URL;
  try {
    base = new URL(supabaseUrl());
  } catch {
    throw new StorageError('CONFIG', 'Supabase 연결 주소를 확인해 주세요.');
  }
  const hosted = base.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(base.hostname) && !base.port;
  const local = process.env.SUPABASE_ALLOW_LOCAL === 'true' && base.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if ((!hosted && !local) || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw new StorageError('CONFIG', 'Supabase 연결 주소를 확인해 주세요.');
  }
  return new URL('/rest/v1/rpc/prayer_storage', base).toString();
}

/** Call the service-role-only RPC without passing project credentials to callers. */
export async function supabaseRequest<T>(operation: string, payload: object = {}): Promise<T> {
  const url = rpcUrl();
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new StorageError('CONFIG', 'Supabase 서버 키가 설정되지 않았습니다.');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;

  const signal = AbortSignal.timeout(8000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ p_operation: operation, p_payload: payload }),
      cache: 'no-store', redirect: 'error', signal,
    });
  } catch {
    throw new StorageError('CONNECTION', '데이터베이스 연결이 지연되었습니다.', { reason: signal.aborted ? 'TIMEOUT' : 'NETWORK' });
  }
  if (response.status === 429 || response.status === 408 || response.status >= 500) {
    const reason = response.status === 429 ? 'HTTP_RATE_LIMIT' : response.status === 408 ? 'TIMEOUT' : 'HTTP_5XX';
    throw new StorageError(response.status === 429 ? '429' : 'CONNECTION', '데이터베이스 연결이 지연되었습니다.', { reason, httpStatus: response.status });
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new StorageError('CONNECTION', '데이터베이스 응답이 지연되었습니다.', { reason: signal.aborted ? 'TIMEOUT' : 'BODY_READ', httpStatus: response.status });
  }
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    throw new StorageError(response.ok ? 'CONNECTION' : 'STORAGE', '데이터베이스 응답을 확인하지 못했습니다.', { reason: 'INVALID_JSON', httpStatus: response.status });
  }
  if (!response.ok) {
    const code = (result as { code?: unknown } | null)?.code;
    if (code === '55P03' || code === '57014') {
      throw new StorageError('CONNECTION', '데이터베이스 처리가 지연되었습니다.', { reason: 'BACKEND_LOCK', httpStatus: response.status });
    }
    const errorCode = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : String(response.status);
    throw new StorageError(errorCode, '데이터베이스 요청을 처리하지 못했습니다.', { reason: 'BACKEND', httpStatus: response.status });
  }
  return result as T;
}
