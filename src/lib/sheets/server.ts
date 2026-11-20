import 'server-only';

export class SheetsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SheetsError';
  }
}

function backendUrl(): string {
  const value = process.env.GOOGLE_SHEETS_WEB_APP_URL;
  if (!value) throw new SheetsError('CONFIG', '구글시트 연결 주소가 설정되지 않았습니다.');
  const url = new URL(value);
  const local = process.env.GOOGLE_SHEETS_ALLOW_LOCAL === 'true'
    && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local && (url.protocol !== 'https:' || url.hostname !== 'script.google.com'
    || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname))) {
    throw new SheetsError('CONFIG', '올바른 Apps Script 웹 앱 배포 주소가 필요합니다.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new SheetsError('CONFIG', '구글시트 연결 주소에는 추가 매개변수를 사용할 수 없습니다.');
  }
  return url.toString();
}

/** Server-only transport. Never send the secret or the raw sheet to the browser. */
export async function sheetRequest<T>(operation: string, payload: object = {}, options: { timeoutMs?: number } = {}): Promise<T> {
  const url = backendUrl();
  const secret = process.env.GOOGLE_SHEETS_API_SECRET;
  if (!secret || secret.length < 32) throw new SheetsError('CONFIG', '구글시트 연결 비밀키가 설정되지 않았습니다.');
  const timeoutMs = options.timeoutMs ?? 45000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000) throw new SheetsError('CONFIG', '저장소 연결 제한 시간이 올바르지 않습니다.');
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, operation, payload }),
      cache: 'no-store', redirect: 'follow', signal,
    });
  } catch {
    throw new SheetsError('CONNECTION', '구글시트 연결이 지연되었습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (!response.ok) throw new SheetsError('CONNECTION', '구글시트 서버에 연결하지 못했습니다.');
  let result: { ok: boolean; data?: T; error?: { code?: string; message?: string } };
  try { result = await response.json(); }
  catch {
    if (signal.aborted) throw new SheetsError('CONNECTION', '구글시트 연결이 지연되었습니다. 잠시 후 다시 시도해 주세요.');
    throw new SheetsError('CONFIG', 'Apps Script 웹 앱의 배포와 접근 설정을 확인해 주세요.');
  }
  if (result?.ok !== true) {
    throw new SheetsError(String(result?.error?.code ?? 'STORAGE'), '구글시트 요청을 처리하지 못했습니다.');
  }
  return result.data as T;
}
