import 'server-only';
import { getEventSnapshot } from './event';

import { createServerClient } from './supabase/server';
import type { MatchMode, Participant, PrayerGroup, TargetSize } from './types';

export type ActiveRound = {
  id: string;
  mode: MatchMode;
  targetSize: TargetSize;
  createdAt: string;
  groups: PrayerGroup[];
};

export async function getActiveRound(_strict = false): Promise<ActiveRound | null> {
  return (await getEventSnapshot()).round;
}
export async function getParticipants(_strict = false): Promise<Participant[]> {
  return (await getEventSnapshot()).participants;
}

/** 개인 링크(`/me/[id]`)용. 본인 이름 표시에만 씁니다. */
export async function getParticipant(id: string): Promise<Participant | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('participants')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[getParticipant]', error);
    return null;
  }
  return (data as Participant) ?? null;
}

/**
 * 이 참가자가 속한 조를 현재 확정된 회차에서 찾습니다.
 * 아직 매칭 전이거나 회차가 내려간 상태면 null.
 */
export async function getMyGroup(participantId: string): Promise<PrayerGroup | null> {
  const round = await getActiveRound();
  if (!round) return null;
  return round.groups.find((g) => g.members.some((m) => m.id === participantId)) ?? null;
}

/** 팀별 인원 수를 많은 순으로. */
export function countByTeam(participants: Participant[]) {
  const counts = new Map<string, number>();
  for (const p of participants) {
    counts.set(p.team, (counts.get(p.team) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([team, count]) => ({ team, count }))
    .sort((a, b) => b.count - a.count);
}
