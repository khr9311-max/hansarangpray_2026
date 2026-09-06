export type Participant = {
  id: string;
  name: string;
  team: string;
  prayer_request: string;
  created_at: string;
};

/** 매칭 방식 */
export type MatchMode =
  | 'team'    // 같은 팀을 최대한 피함 (기본값)
  | 'random'; // 아무 조건 없이 완전 랜덤

export type TargetSize = 2 | 3 | 4;

export type PrayerGroup = {
  groupNumber: number;
  members: Participant[];
};

export const MATCH_MODE_LABEL: Record<MatchMode, string> = {
  team: '팀 섞기',
  random: '완전 랜덤',
};

export const TEAMS: string[] = (
  process.env.NEXT_PUBLIC_TEAMS ??
  '영등포쪽방촌팀,단비팀,통일선교팀,운영팀,국장,교역자'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
