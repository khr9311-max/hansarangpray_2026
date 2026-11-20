import 'server-only';
import { sheetRequest, SheetsError, sheetFailureFacts } from './server';

export type SheetSubmission = { requestId: string; name: string; team: string; prayer: string };
type BatchResult = { requestId: string; participantId: string };
type PendingSubmission = {
  submission: SheetSubmission;
  promise: Promise<string>;
  resolve: (participantId: string) => void;
  reject: (error: unknown) => void;
  deadline: number;
  settled: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
type Batch = { items: PendingSubmission[]; attempts: number; readyAt: number };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const COALESCE_MS = 400;
const MAX_BATCH_SIZE = 50;
const MAX_PENDING = 500;
const TOTAL_DEADLINE_MS = 150000;
const MAX_ATTEMPTS = 3;
const pendingById = new Map<string, PendingSubmission>();
const arrivals: PendingSubmission[] = [];
const batches: Batch[] = [];
let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
let active = false;

function timeoutError() {
  return new SheetsError('CONNECTION', '접수 확인이 지연되었습니다. 같은 신청으로 다시 시도해 주세요.');
}

function finish(item: PendingSubmission, error: unknown, participantId?: string) {
  if (item.settled) return;
  item.settled = true;
  clearTimeout(item.expiryTimer);
  if (pendingById.get(item.submission.requestId) === item) pendingById.delete(item.submission.requestId);
  if (error) item.reject(error);
  else item.resolve(participantId!);
}

function validateSubmission(value: SheetSubmission) {
  if (!value || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 20
    || typeof value.team !== 'string' || !value.team.trim() || value.team.length > 200
    || typeof value.prayer !== 'string' || !value.prayer.trim() || value.prayer.length > 500) {
    throw new SheetsError('22023', '신청 정보를 확인해 주세요.');
  }
}

function validateResult(value: unknown, items: PendingSubmission[]): Map<string, string> {
  if (!Array.isArray(value) || value.length !== items.length) throw new SheetsError('STORAGE', '접수 결과를 확인하지 못했습니다.');
  const expected = new Set(items.map(item => item.submission.requestId));
  const result = new Map<string, string>(), participantIds = new Set<string>();
  for (const row of value as BatchResult[]) {
    if (!row || typeof row.requestId !== 'string' || !expected.has(row.requestId) || result.has(row.requestId)
      || typeof row.participantId !== 'string' || !UUID.test(row.participantId) || participantIds.has(row.participantId)) {
      throw new SheetsError('STORAGE', '접수 결과를 확인하지 못했습니다.');
    }
    result.set(row.requestId, row.participantId);
    participantIds.add(row.participantId);
  }
  return result;
}

async function runBatch(batch: Batch) {
  const items = batch.items.filter(item => !item.settled);
  if (!items.length) return;
  const remainingMs = Math.min(...items.map(item => item.deadline)) - Date.now();
  if (remainingMs <= 0) {
    for (const item of items) finish(item, timeoutError());
    return;
  }
  batch.attempts++;
  try {
    const response = await sheetRequest<unknown>('submit_batch', {
      submissions: items.map(item => item.submission),
    }, { timeoutMs: Math.min(45000, remainingMs) });
    const result = validateResult(response, items);
    for (const item of items) finish(item, null, result.get(item.submission.requestId));
  } catch (error) {
    const retryable = error instanceof SheetsError && ['503', '429', 'CONNECTION'].includes(error.code);
    const delayMs = 500 * 2 ** (batch.attempts - 1) + Math.floor(Math.random() * 251);
    const waiting = items.filter(item => !item.settled && item.deadline > Date.now() + delayMs);
    if (retryable && batch.attempts < MAX_ATTEMPTS && waiting.length) {
      // Retry at the end so a contended batch cannot starve later arrivals.
      batches.push({ items: waiting, attempts: batch.attempts, readyAt: Date.now() + delayMs });
      for (const item of items) if (!waiting.includes(item)) finish(item, timeoutError());
    } else {
      if (typeof process !== 'undefined' && process.env.SHEETS_DIAGNOSTICS === 'true') {
        console.warn(JSON.stringify({ event: 'sheets_submission_batch_failed', batchSize: items.length, attempts: batch.attempts,
          elapsedMs: Math.max(0, Date.now() - Math.min(...items.map(item => item.deadline)) + TOTAL_DEADLINE_MS), ...sheetFailureFacts(error) }));
      }
      for (const item of items) finish(item, error);
    }
  }
}

function pump() {
  if (active) return;
  clearTimeout(wakeTimer);
  wakeTimer = undefined;
  for (let index = batches.length - 1; index >= 0; index--) {
    if (batches[index].items.every(item => item.settled)) batches.splice(index, 1);
  }
  if (!batches.length) return;
  const readyIndex = batches.findIndex(batch => batch.readyAt <= Date.now());
  if (readyIndex < 0) {
    const nextAt = Math.min(...batches.map(batch => batch.readyAt));
    wakeTimer = setTimeout(pump, Math.max(1, nextAt - Date.now()));
    return;
  }
  const batch = batches.splice(readyIndex, 1)[0];
  active = true;
  void runBatch(batch).finally(() => { active = false; pump(); });
}

function flush() {
  clearTimeout(coalesceTimer);
  coalesceTimer = undefined;
  while (arrivals.length) {
    const items = arrivals.splice(0, MAX_BATCH_SIZE).filter(item => !item.settled);
    if (items.length) batches.push({ items, attempts: 0, readyAt: Date.now() });
  }
  pump();
}

/** Coalesces live requests only; success always waits for a verified Sheets save. */
export function submitToSheets(value: SheetSubmission): Promise<string> {
  try { validateSubmission(value); } catch (error) { return Promise.reject(error); }
  const submission = { requestId: value.requestId, name: value.name, team: value.team, prayer: value.prayer };
  const previous = pendingById.get(submission.requestId);
  if (previous) {
    if (JSON.stringify(previous.submission) === JSON.stringify(submission)) return previous.promise;
    return Promise.reject(new SheetsError('22023', '같은 신청 요청의 내용이 변경되었습니다. 접수 결과를 확인한 뒤 다시 시도해 주세요.'));
  }
  if (pendingById.size >= MAX_PENDING) return Promise.reject(new SheetsError('503', '접수 요청이 많습니다. 잠시 후 다시 시도해 주세요.'));
  let resolve!: PendingSubmission['resolve'], reject!: PendingSubmission['reject'];
  const promise = new Promise<string>((accept, refuse) => { resolve = accept; reject = refuse; });
  const item: PendingSubmission = { submission, promise, resolve, reject, deadline: Date.now() + TOTAL_DEADLINE_MS, settled: false };
  item.expiryTimer = setTimeout(() => finish(item, timeoutError()), TOTAL_DEADLINE_MS);
  pendingById.set(submission.requestId, item);
  arrivals.push(item);
  if (arrivals.length >= MAX_BATCH_SIZE) flush();
  else if (coalesceTimer === undefined) coalesceTimer = setTimeout(flush, COALESCE_MS);
  return promise;
}
