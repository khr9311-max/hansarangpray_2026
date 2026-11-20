import 'server-only';
import { cache } from 'react';
import { unstable_cache, revalidateTag } from 'next/cache';
import { sheetRequest, SheetsError } from './sheets/server';
import type { Participant } from './types';
import type { ActiveRound } from './queries';

export type EventSnapshot = {
  revision: number; drawStartedAt: string | null; serverTime: string;
  participants: Participant[]; round: ActiveRound | null;
};

export function readRevision(formData: FormData): number {
  const raw = formData.get('revision');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('화면을 새로고침한 뒤 다시 눌러 주세요.');
  }
  return Number(raw);
}

export const EVENT_CACHE_TAG = 'prayer-sheets-event';

// Share reads across phones. Backend revision checks still protect every write.
const readSnapshot = unstable_cache(
  () => sheetRequest<EventSnapshot>('snapshot'),
  ['prayer-sheets-snapshot-v1', process.env.GOOGLE_SHEETS_WEB_APP_URL ?? 'unconfigured'],
  { revalidate: 2, tags: [EVENT_CACHE_TAG] },
);
export const getEventSnapshot = cache(async (): Promise<EventSnapshot> => ({
  ...await readSnapshot(), serverTime: new Date().toISOString(),
}));

function commandError(error: unknown): never {
  if (error instanceof SheetsError && error.code === '40001') {
    throw new Error('다른 기기의 조작 또는 새 신청이 반영되었습니다. 갱신된 결과를 확인하고 다시 눌러 주세요.');
  }
  if (error instanceof SheetsError && error.code === 'P0002') {
    throw new Error('먼저 초기화 후 조 편성으로 첫 조를 만들어 주세요.');
  }
  throw new Error('처리하지 못했습니다. 최신 결과를 확인하고 다시 시도해 주세요.');
}

export async function eventCommand(revision: number, operation: string, payload = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('화면을 새로고침해 주세요.');
  try {
    await sheetRequest('command', { revision, operation, payload });
    revalidateTag(EVENT_CACHE_TAG);
  } catch (error) { commandError(error); }
}

export async function appendParticipants(revision: number): Promise<number> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('화면을 새로고침해 주세요.');
  try {
    const count = await sheetRequest<number>('append', { revision });
    revalidateTag(EVENT_CACHE_TAG);
    return count;
  } catch (error) { commandError(error); }
}
