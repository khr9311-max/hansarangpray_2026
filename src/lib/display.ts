import type { Participant, PrayerGroup } from './types';

export type DisplayMember = { id: string; name: string };
export type DisplayRound = {
  id: string;
  groups: { groupNumber: number; members: DisplayMember[] }[];
};

export function toDisplaySnapshot(
  participants: Participant[],
  round: { id: string; groups: PrayerGroup[] } | null,
) {
  const matchedIds = new Set(round?.groups.flatMap((group) => group.members.map((m) => m.id)));
  return {
    participants: participants.map((p, i) => ({ id: `p${i}`, name: p.name })),
    pendingCount: round ? participants.filter((p) => !matchedIds.has(p.id)).length : 0,
    round: round && {
      id: round.id,
      groups: round.groups.map((group) => ({
        groupNumber: group.groupNumber,
        members: group.members.map((m, i) => ({ id: `${group.groupNumber}-${i}`, name: m.name })),
      })),
    },
  };
}
