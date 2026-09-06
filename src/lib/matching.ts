import type { MatchMode, Participant, PrayerGroup, TargetSize } from './types';

/** Fisher-Yates. sort(() => Math.random() - 0.5) 는 분포가 치우쳐서 쓰지 않습니다. */
function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 총 n명을 목표 인원 기준으로 나눌 때의 "조별 인원 배열"을 먼저 계산합니다.
 *
 * 목표 인원으로 딱 떨어지는 조를 만들고, 남는 사람은 조를 따로 만들지 않고
 * **깍두기로 기존 조에 한 명씩 끼워 넣습니다.** 그래서 정원에 미달하는 조는
 * 절대 생기지 않고, 남는 인원 수만큼만 한 명 더 많은 조가 됩니다.
 *
 *   2인 기준: 7명 → 3,2,2      (1명이 1조에 합류)
 *   3인 기준: 7명 → 4,3        (1명이 1조에 합류)
 *             8명 → 4,4        (2명이 1·2조에 각각 합류)
 */
export function computeGroupSizes(n: number, targetSize: TargetSize): number[] {
  if (n <= 0) return [];
  if (n < targetSize) return [n]; // 정원보다 적으면 그냥 한 조로

  const groupCount = Math.floor(n / targetSize);
  const sizes: number[] = new Array(groupCount).fill(targetSize);
  const leftover = n % targetSize;

  if (leftover === 0) return sizes;

  if (leftover <= groupCount) {
    for (let i = 0; i < leftover; i++) sizes[i] += 1;
    return sizes;
  }

  // 남는 사람이 조 수보다 많은 경우(3인 기준 5명뿐입니다).
  // 한 조에 다 몰아넣어 5인 조를 만드느니 작은 조를 하나 두는 편이 낫습니다.
  sizes.push(leftover);
  return sizes;
}

/**
 * 인원이 많은 팀부터 한 명씩 번갈아 뽑아 일렬로 세웁니다.
 * 배치가 어려운(= 같은 팀 사람이 많은) 사람을 먼저 처리하려는 순서입니다.
 */
function hardestFirst(members: Participant[]): Participant[] {
  const buckets = new Map<string, Participant[]>();
  for (const m of shuffle(members)) {
    const bucket = buckets.get(m.team);
    if (bucket) bucket.push(m);
    else buckets.set(m.team, [m]);
  }

  const lines = [...buckets.values()];
  const ordered: Participant[] = [];
  while (lines.some((line) => line.length > 0)) {
    lines.sort((a, b) => b.length - a.length);
    for (const line of lines) {
      const next = line.shift();
      if (next) ordered.push(next);
    }
  }
  return ordered;
}

type Slot = { size: number; members: Participant[] };

// 같은 팀은 어떤 경우에도 피하고 싶고, 성별은 그다음입니다.
// 팀 제약을 어기느니 성별이 겹치는 편이 낫도록 자릿수를 벌려 둡니다.
const SAME_TEAM_PENALTY = 100;
const SAME_GENDER_PENALTY = 10;

function penaltyOf(slot: Slot, member: Participant, mixGender: boolean): number {
  let score = 0;
  for (const existing of slot.members) {
    if (existing.team === member.team) score += SAME_TEAM_PENALTY;
    if (mixGender && existing.gender === member.gender) score += SAME_GENDER_PENALTY;
  }
  // 덜 찬 조부터 채워 한쪽으로 쏠리지 않게 합니다.
  score += slot.members.length;
  return score;
}

/**
 * 한 명씩 "가장 덜 겹치는 조"에 넣는 그리디 배치.
 * 같은 팀이 절대 겹치지 않는다고 보장하지는 못하지만
 * (예: 한 팀이 전체의 절반을 넘으면 수학적으로 불가능합니다)
 * 겹치는 횟수를 최소에 가깝게 유지합니다.
 */
function assignGreedily(
  ordered: Participant[],
  sizes: number[],
  mixGender: boolean,
): Slot[] {
  const slots: Slot[] = sizes.map((size) => ({ size, members: [] }));

  for (const member of ordered) {
    let best: Slot | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    // 점수가 같은 조가 여럿일 때 늘 앞쪽 조가 뽑히지 않도록 순서를 섞습니다.
    for (const slot of shuffle(slots)) {
      if (slot.members.length >= slot.size) continue;
      const score = penaltyOf(slot, member, mixGender);
      if (score < bestScore) {
        bestScore = score;
        best = slot;
      }
    }

    best?.members.push(member);
  }

  return slots;
}

/** 한 조 안에서 같은 팀이 겹친 쌍의 수. 낮을수록 좋은 매칭입니다. */
function countTeamCollisions(slots: Slot[]): number {
  let collisions = 0;
  for (const slot of slots) {
    for (let i = 0; i < slot.members.length; i++) {
      for (let j = i + 1; j < slot.members.length; j++) {
        if (slot.members[i].team === slot.members[j].team) collisions++;
      }
    }
  }
  return collisions;
}

/** 성별까지 겹친 정도. 팀 충돌이 같을 때의 2차 기준입니다. */
function countGenderCollisions(slots: Slot[]): number {
  let collisions = 0;
  for (const slot of slots) {
    for (let i = 0; i < slot.members.length; i++) {
      for (let j = i + 1; j < slot.members.length; j++) {
        if (slot.members[i].gender === slot.members[j].gender) collisions++;
      }
    }
  }
  return collisions;
}

/** 그리디는 시작 순서를 타므로 여러 번 돌려 가장 좋은 결과를 고릅니다. */
const ATTEMPTS = 40;

/**
 * 참가자 명단을 조로 나눕니다.
 * @param members    참가자 목록
 * @param targetSize 2인 1조 / 3인 1조
 * @param mode       팀+성별 섞기(mix) · 팀만 섞기(team) · 완전 랜덤(random)
 */
export function createPrayerGroups(
  members: Participant[],
  targetSize: TargetSize,
  mode: MatchMode = 'mix',
): PrayerGroup[] {
  if (members.length === 0) return [];

  const sizes = computeGroupSizes(members.length, targetSize);

  let bestSlots: Slot[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < (mode === 'random' ? 1 : ATTEMPTS); attempt++) {
    const slots =
      mode === 'random'
        ? (() => {
            const pool = shuffle(members);
            let cursor = 0;
            return sizes.map((size) => {
              const slot = { size, members: pool.slice(cursor, cursor + size) };
              cursor += size;
              return slot;
            });
          })()
        : assignGreedily(hardestFirst(members), sizes, mode === 'mix');

    const score =
      countTeamCollisions(slots) * SAME_TEAM_PENALTY +
      (mode === 'mix' ? countGenderCollisions(slots) * SAME_GENDER_PENALTY : 0);

    if (score < bestScore) {
      bestScore = score;
      bestSlots = slots;
      if (score === 0) break; // 더 좋아질 수 없습니다.
    }
  }

  return (bestSlots ?? []).map((slot, index) => ({
    groupNumber: index + 1,
    members: slot.members,
  }));
}
