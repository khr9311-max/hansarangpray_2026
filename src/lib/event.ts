import 'server-only';
import { cache } from 'react';
import { createAdminClient, createServerClient } from './supabase/server';
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

export const getEventSnapshot = cache(async (): Promise<EventSnapshot> => {
  const { data, error } = await createServerClient().rpc('prayer_snapshot');
  if (error || !data) throw new Error('행사 정보를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.');
  return data as EventSnapshot;
});

export async function eventCommand(revision: number, operation: string, payload = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('화면을 새로고침해 주세요.');
  const { error } = await createAdminClient().rpc('prayer_command', {
    p_revision: revision, p_operation: operation, p_payload: payload,
  });
  if (error?.code === '40001') throw new Error('다른 기기의 조작 또는 새 신청이 반영되었습니다. 갱신된 결과를 확인하고 다시 눌러 주세요.');
  if (error) { console.error('[eventCommand]', error); throw new Error('처리하지 못했습니다. 최신 결과를 확인하고 다시 시도해 주세요.'); }
}

export async function appendParticipants(revision: number): Promise<number> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('화면을 새로고침해 주세요.');
  const { data, error } = await createAdminClient().rpc('prayer_append', { p_revision: revision });
  if (error?.code === '40001') throw new Error('다른 기기의 조작 또는 새 신청이 반영되었습니다. 갱신된 결과를 확인하고 다시 눌러 주세요.');
  if (error?.code === 'P0002') throw new Error('먼저 초기화 후 조 편성으로 첫 조를 만들어 주세요.');
  if (error) { console.error('[appendParticipants]', error); throw new Error('추가 참여자를 반영하지 못했습니다. 다시 시도해 주세요.'); }
  return Number(data);
}
