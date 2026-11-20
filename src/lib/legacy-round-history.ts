import 'server-only';

import type { RoundHistoryEntry } from './event';
import type { ActiveRound } from './queries';
import { sheetRequest } from './sheets/server';
import { usesSupabase } from './storage';
import type { MatchMode, Participant, PrayerGroup, TargetSize } from './types';

type LegacySnapshot = {
  participants: Participant[];
  match_rounds: { id: string; mode: MatchMode; target_size: TargetSize; created_at: string; is_active: boolean }[];
  match_groups: { id: string; round_id: string; group_number: number }[];
  match_members: { group_id: string; participant_id: string; seq: number }[];
};

export function hasLegacyRoundSource(): boolean {
  return usesSupabase() && Boolean(process.env.GOOGLE_SHEETS_WEB_APP_URL && process.env.GOOGLE_SHEETS_API_SECRET);
}

export async function getLegacyRoundHistory(): Promise<RoundHistoryEntry[]> {
  if (!hasLegacyRoundSource()) return [];
  return sheetRequest<RoundHistoryEntry[]>('history');
}

export async function getLegacyRoundEntry(id: string): Promise<(ActiveRound & { isActive: boolean }) | null> {
  if (!hasLegacyRoundSource()) return null;

  // The frozen deployment exposes history summaries and a coherent export.
  const snapshot = await sheetRequest<LegacySnapshot>('export');
  const round = snapshot.match_rounds.find(row => row.id === id);
  if (!round) return null;

  const participants = new Map(snapshot.participants.map(person => [person.id, person]));
  const groupsById = new Map<string, PrayerGroup>();
  for (const group of snapshot.match_groups) {
    if (group.round_id === id) groupsById.set(group.id, { groupNumber: group.group_number, members: [] });
  }

  const members = snapshot.match_members.filter(member => groupsById.has(member.group_id));
  members.sort((a, b) => a.seq - b.seq || a.participant_id.localeCompare(b.participant_id));
  for (const member of members) {
    const group = groupsById.get(member.group_id);
    const person = participants.get(member.participant_id);
    if (!group || !person) continue;
    const { id, name, team, prayer_request, created_at, edit_version } = person;
    group.members.push({ id, name, team, prayer_request, created_at, edit_version });
  }

  const groups = [...groupsById.values()].filter(group => group.members.length > 0);
  if (groups.length === 0) return null;
  groups.sort((a, b) => a.groupNumber - b.groupNumber);

  return {
    id: round.id, mode: round.mode, targetSize: round.target_size, createdAt: round.created_at,
    isActive: round.is_active, groups,
  };
}
