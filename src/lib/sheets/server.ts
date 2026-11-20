import 'server-only';

type FailureReason = 'NETWORK' | 'TIMEOUT' | 'BODY_READ' | 'HTTP_5XX' | 'HTTP_RATE_LIMIT' | 'HTTP_CLIENT'
  | 'GOOGLE_CONCURRENCY' | 'GOOGLE_RATE_LIMIT' | 'GOOGLE_SERVER' | 'HTML_CONFIG' | 'INVALID_JSON'
  | 'BACKEND' | 'BACKEND_LOCK';
type FailureFacts = { reason: FailureReason; httpStatus?: number };
const SAFE_CODES = new Set(['CONNECTION', 'CONFIG', 'STORAGE', '22023', '40001', 'P0002', '401', '403', '404', '409', '429', '500', '502', '503', '504', 'UNAUTHORIZED']);
const SAFE_REASONS = new Set<FailureReason>(['NETWORK', 'TIMEOUT', 'BODY_READ', 'HTTP_5XX', 'HTTP_RATE_LIMIT', 'HTTP_CLIENT',
  'GOOGLE_CONCURRENCY', 'GOOGLE_RATE_LIMIT', 'GOOGLE_SERVER', 'HTML_CONFIG', 'INVALID_JSON', 'BACKEND', 'BACKEND_LOCK']);

export class SheetsError extends Error {
  constructor(public readonly code: string, message: string, public readonly failure?: FailureFacts) {
    super(message);
    this.name = 'SheetsError';
  }
}

/** Safe for aggregate diagnostics: never includes messages, URLs, IDs or payloads. */
export function sheetFailureFacts(error: unknown): { code: string; reason: string; httpStatus?: number } {
  if (!(error instanceof SheetsError)) return { code: 'OTHER', reason: 'UNEXPECTED' };
  const status = error.failure?.httpStatus;
  return {
    code: SAFE_CODES.has(error.code) ? error.code : 'OTHER',
    reason: error.failure?.reason && SAFE_REASONS.has(error.failure.reason) ? error.failure.reason : 'UNCLASSIFIED',
    ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
  };
}

function googleHtmlFailure(body: string, responseUrl: string): FailureReason | undefined {
  let hostname: string;
  try { hostname = new URL(responseUrl).hostname; } catch { return; }
  if (!['script.google.com', 'script.googleusercontent.com'].includes(hostname)
    || !/<(?:!doctype\s+html|html|head|body|title)\b/i.test(body)) return;
  const text = body.slice(0, 65536)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:apos|#39|#x27);/gi, "'").replace(/\u2019/g, "'")
    .replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  // An authentication/permission page is a deployment problem even if it also
  // mentions quotas or generic server errors in explanatory text.
  if (/\b(?:sign[ -]?in|log[ -]?in|access[ _-]denied|permission[ _-]denied|forbidden|unauthori[sz]ed|not authori[sz]ed|insufficient permissions?|authorization (?:is )?required|requires authorization|you (?:do not|don't) have (?:permission|access)|you need (?:access|permission)|iam)\b|로그인|액세스\s*권한|(?:액세스|접근)(?:가|이)?\s*거부|권한(?:이\s*(?:없|필요)|\s*(?:거부|부족))|승인이\s*필요/i.test(text)) return;
  if (/\b(?:for one day|per day|daily quota)\b|일일\s*(?:할당량|한도)/i.test(text)) return;
  if (/there are too many scripts running simultaneously for this google user account|too many simultaneous (?:executions|invocations)|동시에\s*실행(?:\s*중인|하는)?\s*스크립트가\s*너무\s*많/i.test(text)) return 'GOOGLE_CONCURRENCY';
  if (/script invoked too many times per second for this google user account|service invoked too many times in a short time|\btoo many requests\b|quota (?:exceeded|limit exceeded).{0,200}(?:per minute|per second|rate limit)|요청이\s*너무\s*많|짧은\s*(?:시간|기간).{0,100}(?:호출|요청).{0,50}너무\s*많/i.test(text)) return 'GOOGLE_RATE_LIMIT';
  if (/\bwe're sorry[,.]?\s+(?:but\s+)?a server error (?:has )?occurred\b|죄송합니다[.,]?\s*서버\s*오류가\s*발생/i.test(text)) return 'GOOGLE_SERVER';
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
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US' },
      body: JSON.stringify({ secret, operation, payload }),
      cache: 'no-store', redirect: 'follow', signal,
    });
  } catch {
    throw new SheetsError('CONNECTION', '구글시트 연결이 지연되었습니다. 잠시 후 다시 시도해 주세요.', { reason: signal.aborted ? 'TIMEOUT' : 'NETWORK' });
  }
  if (!response.ok) {
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      throw new SheetsError(response.status === 429 ? '429' : 'CONNECTION', '구글시트 서버에 연결하지 못했습니다.', {
        reason: response.status === 429 ? 'HTTP_RATE_LIMIT' : response.status === 408 ? 'TIMEOUT' : 'HTTP_5XX', httpStatus: response.status,
      });
    }
    throw new SheetsError(String(response.status), 'Apps Script 웹 앱의 배포와 접근 설정을 확인해 주세요.', { reason: 'HTTP_CLIENT', httpStatus: response.status });
  }
  let body: string;
  try { body = await response.text(); }
  catch {
    throw new SheetsError('CONNECTION', '구글시트 연결이 지연되었습니다. 잠시 후 다시 시도해 주세요.', { reason: signal.aborted ? 'TIMEOUT' : 'BODY_READ', httpStatus: response.status });
  }
  let result: { ok: boolean; data?: T; error?: { code?: string; message?: string } };
  try { result = JSON.parse(body); }
  catch {
    const temporary = googleHtmlFailure(body, response.url || url);
    if (temporary) throw new SheetsError('CONNECTION', '구글시트가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.', { reason: temporary, httpStatus: response.status });
    throw new SheetsError('CONFIG', 'Apps Script 웹 앱의 배포와 접근 설정을 확인해 주세요.', {
      reason: /<html\b|<!doctype\s+html/i.test(body) ? 'HTML_CONFIG' : 'INVALID_JSON', httpStatus: response.status,
    });
  }
  if (result?.ok !== true) {
    const lockTimeout = result?.error?.code === '503' && typeof result.error.message === 'string'
      && result.error.message.startsWith('다른 신청을 처리하고 있습니다.');
    throw new SheetsError(String(result?.error?.code ?? 'STORAGE'), '구글시트 요청을 처리하지 못했습니다.', { reason: lockTimeout ? 'BACKEND_LOCK' : 'BACKEND', httpStatus: response.status });
  }
  return result.data as T;
}
