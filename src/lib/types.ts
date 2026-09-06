export type Gender = '형제' | '자매';

export type Participant = {
  id: string;
  name: string;
  team: string;
  gender: Gender;
  created_at: string;
};

/** 매칭 방식 */
export type MatchMode =
  | 'mix'    // 같은 팀을 최대한 피하고 성별도 섞음 (기본값)
  | 'team'   // 같은 팀만 피함 (성별은 신경쓰지 않음)
  | 'random'; // 아무 조건 없이 완전 랜덤

export type TargetSize = 2 | 3;

export type PrayerGroup = {
  groupNumber: number;
  members: Participant[];
};

export const MATCH_MODE_LABEL: Record<MatchMode, string> = {
  mix: '팀 + 성별 섞기',
  team: '팀만 섞기',
  random: '완전 랜덤',
};

export const GENDERS: Gender[] = ['형제', '자매'];

export const TEAMS: string[] = (
  process.env.NEXT_PUBLIC_TEAMS ??
  '영등포쪽방촌팀,단비팀,통일선교팀,운영팀,국장,교역자'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
