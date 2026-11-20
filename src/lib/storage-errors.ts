export type FailureReason = 'NETWORK' | 'TIMEOUT' | 'BODY_READ' | 'HTTP_5XX' | 'HTTP_RATE_LIMIT' | 'HTTP_CLIENT'
  | 'GOOGLE_CONCURRENCY' | 'GOOGLE_RATE_LIMIT' | 'GOOGLE_SERVER' | 'HTML_CONFIG' | 'INVALID_JSON'
  | 'BACKEND' | 'BACKEND_LOCK';
type FailureFacts = { reason: FailureReason; httpStatus?: number };
const SAFE_CODES = new Set(['CONNECTION', 'CONFIG', 'STORAGE', '22023', '40001', 'P0002', '401', '403', '404', '409', '429', '500', '502', '503', '504', 'UNAUTHORIZED']);
const SAFE_REASONS = new Set<FailureReason>(['NETWORK', 'TIMEOUT', 'BODY_READ', 'HTTP_5XX', 'HTTP_RATE_LIMIT', 'HTTP_CLIENT',
  'GOOGLE_CONCURRENCY', 'GOOGLE_RATE_LIMIT', 'GOOGLE_SERVER', 'HTML_CONFIG', 'INVALID_JSON', 'BACKEND', 'BACKEND_LOCK']);

export class StorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly failure?: FailureFacts) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Safe for aggregate diagnostics: never includes messages, URLs, IDs or payloads. */
export function storageFailureFacts(error: unknown): { code: string; reason: string; httpStatus?: number } {
  if (!(error instanceof StorageError)) return { code: 'OTHER', reason: 'UNEXPECTED' };
  const status = error.failure?.httpStatus;
  return {
    code: SAFE_CODES.has(error.code) ? error.code : 'OTHER',
    reason: error.failure?.reason && SAFE_REASONS.has(error.failure.reason) ? error.failure.reason : 'UNCLASSIFIED',
    ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
  };
}
