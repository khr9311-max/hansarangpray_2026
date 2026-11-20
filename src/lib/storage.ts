import 'server-only';
import { StorageError } from './storage-errors';
import { sheetRequest } from './sheets/server';
import { submitToSheets, type SheetSubmission } from './sheets/submissions';
import { supabaseRequest } from './supabase/server';

export { StorageError, storageFailureFacts } from './storage-errors';

export function usesSupabase(): boolean {
  const backend = process.env.PRAYER_STORAGE_BACKEND;
  if (backend === 'supabase') return true;
  if (!backend || backend === 'sheets') return false;
  throw new StorageError('CONFIG', '지원하는 행사 저장소를 선택해 주세요.');
}

export function storageRequest<T>(operation: string, payload: object = {}): Promise<T> {
  return usesSupabase() ? supabaseRequest<T>(operation, payload) : sheetRequest<T>(operation, payload);
}

export function retryableStorageError(error: unknown): boolean {
  return error instanceof StorageError && ['503', '429', 'CONNECTION'].includes(error.code);
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function verifiedSupabaseSubmission(submission: SheetSubmission): Promise<string> {
  const id = await supabaseRequest<unknown>('submit', submission);
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new StorageError('CONNECTION', '접수 결과를 확인하지 못했습니다.', { reason: 'INVALID_JSON' });
  }
  return id;
}

export async function submitRegistration(submission: SheetSubmission): Promise<string> {
  if (!usesSupabase()) return submitToSheets(submission);
  // Retry once with the original request ID if the commit acknowledgement was lost.
  try {
    return await verifiedSupabaseSubmission(submission);
  } catch (error) {
    if (!retryableStorageError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
    return verifiedSupabaseSubmission(submission);
  }
}
