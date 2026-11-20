import 'server-only';
import { cache } from 'react';
import { unstable_cache, revalidateTag } from 'next/cache';
import { storageRequest, StorageError, usesSupabase } from './storage';
import type { MatchMode, Participant, TargetSize } from './types';
import type { ActiveRound } from './queries';

export type EventSnapshot = {
  revision: number; drawStartedAt: string | null; serverTime: string;
  participants: Participant[]; round: ActiveRound | null;
};

export type RoundHistoryEntry = {
  id: string;
  mode: MatchMode;
  targetSize: TargetSize;
  createdAt: string;
  groupCount: number;
  memberCount: number;
  isActive: boolean;
};

export function readRevision(formData: FormData): number {
  const raw = formData.get('revision');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('화면을 새로고침한 뒤 다시 눌러 주세요.');
  }
  return Number(raw);
}

export const EVENT_CACHE_TAG = 'prayer-event';
const cacheScope = [
  process.env.PRAYER_STORAGE_BACKEND ?? 'sheets',
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.GOOGLE_SHEETS_WEB_APP_URL ?? '',
];
const eventCache = { revalidate: 2, tags: [EVENT_CACHE_TAG] };

// Share reads across phones. Backend revision checks still protect every write.
const readSnapshot = unstable_cache(
  () => storageRequest<EventSnapshot>('snapshot'),
  ['prayer-snapshot', ...cacheScope],
  eventCache,
);
export const getEventSnapshot = cache(async (): Promise<EventSnapshot> => ({
  ...await readSnapshot(), serverTime: new Date().toISOString(),
}));

export const getRoundHistory = unstable_cache(
  () => storageRequest<RoundHistoryEntry[]>('history'),
  ['prayer-round-history', ...cacheScope],
  eventCache,
);

const readStoredRevision = unstable_cache(
  () => storageRequest<{ revision: number }>('revision'),
  ['prayer-revision', ...cacheScope],
  eventCache,
);

export async function getEventRevision(): Promise<number> {
  const { revision } = usesSupabase() ? await readStoredRevision() : await getEventSnapshot();
  if (!Number.isSafeInteger(revision) || revision < 0) throw new StorageError('STORAGE', '행사 상태를 확인하지 못했습니다.');
  return revision;
}

function commandError(error: unknown): never {
  if (error instanceof StorageError && error.code === '40001') {
    throw new Error('다른 기기의 조작 또는 새 신청이 반영되었습니다. 갱신된 결과를 확인하고 다시 눌러 주세요.');
  }
  if (error instanceof StorageError && error.code === 'P0002') {
    throw new Error('현재 사용할 수 있는 편성이 없습니다. 목록을 새로고침해 주세요.');
  }
  throw new Error('처리하지 못했습니다. 최신 결과를 확인하고 다시 시도해 주세요.');
}

export async function eventCommand(revision: number, operation: string, payload = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('화면을 새로고침해 주세요.');
  try {
    await storageRequest('command', { revision, operation, payload });
    revalidateTag(EVENT_CACHE_TAG);
  } catch (error) { commandError(error); }
}

export async function appendParticipants(revision: number): Promise<number> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('화면을 새로고침해 주세요.');
  try {
    const count = await storageRequest<number>('append', { revision });
    revalidateTag(EVENT_CACHE_TAG);
    return count;
  } catch (error) { commandError(error); }
}
