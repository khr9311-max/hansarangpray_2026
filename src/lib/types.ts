export type Participant = {
  edit_version: number;
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

export const TARGET_SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type TargetSize = (typeof TARGET_SIZES)[number];

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
  '영등포쪽방촌팀,단비팀,통일선교팀,전도팀,운영팀,국장,교역자'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
