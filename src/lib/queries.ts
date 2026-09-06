import 'server-only';

import { createServerClient } from './supabase/server';
import {
  GENDERS,
  type MatchMode,
  type Participant,
  type PrayerGroup,
  type TargetSize,
} from './types';

export type ActiveRound = {
  id: string;
  mode: MatchMode;
  targetSize: TargetSize;
  createdAt: string;
  groups: PrayerGroup[];
};

/** 현재 송출 중인(확정된) 매칭 회차를 조 단위로 가져옵니다. 없으면 null. */
export async function getActiveRound(): Promise<ActiveRound | null> {
  const supabase = createServerClient();

  const { data: round, error: roundError } = await supabase
    .from('match_rounds')
    .select('id, mode, target_size, created_at')
    .eq('is_active', true)
    .maybeSingle();

  // 송출 화면이 행사 중에 죽으면 안 되므로 던지지 않고 대기 화면으로 넘깁니다.
  // 대신 스키마 미적용 같은 설정 오류가 조용히 묻히지 않도록 로그를 남깁니다.
  if (roundError) {
    console.error('[getActiveRound]', roundError);
    return null;
  }
  if (!round) return null;

  const { data: groups, error } = await supabase
    .from('match_groups')
    .select('group_number, match_members(seq, participants(*))')
    .eq('round_id', round.id)
    .order('group_number', { ascending: true });
  if (error) throw error;

  return {
    id: round.id,
    mode: round.mode as MatchMode,
    targetSize: round.target_size as TargetSize,
    createdAt: round.created_at,
    groups: (groups ?? []).map((group) => ({
      groupNumber: group.group_number as number,
      members: (group.match_members ?? [])
        .slice()
        .sort((a, b) => (a.seq as number) - (b.seq as number))
        .map((m) => m.participants as unknown as Participant)
        .filter(Boolean),
    })),
  };
}

export async function getParticipants(): Promise<Participant[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('participants')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Participant[];
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

/** 성별 인원 수. GENDERS 순서를 유지해 화면에서 자리가 흔들리지 않게 합니다. */
export function countByGender(participants: Participant[]) {
  return GENDERS.map((gender) => ({
    gender,
    count: participants.filter((p) => p.gender === gender).length,
  }));
}
