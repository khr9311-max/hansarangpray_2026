'use server';

import { revalidatePath } from 'next/cache';
import { isAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { getActiveRound, getParticipants } from '@/lib/queries';
import { addLateParticipants } from '@/lib/matching';
import { toDisplaySnapshot } from '@/lib/display';

type DrawResult =
  | { status: 'success'; snapshot: ReturnType<typeof toDisplaySnapshot> }
  | { status: 'error'; message: string; requiresAdmin?: boolean };

/** 추첨 직전에 최신 명단을 확인하고, 기존 조를 유지한 채 미배정자만 저장합니다. */
export async function prepareDrawAction(): Promise<DrawResult> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const round = await getActiveRound(true);
      if (!round) return { status: 'error', message: '관리자 화면에서 먼저 매칭을 확정해 주세요.' };
      const participants = await getParticipants(true);
      const snapshot = toDisplaySnapshot(participants, round);
      if (!snapshot.pendingCount) return { status: 'success', snapshot };

      if (!(await isAdmin())) {
        return {
          status: 'error', requiresAdmin: true,
          message: `아직 배정되지 않은 참가자가 ${snapshot.pendingCount}명 있습니다. 이 브라우저에서 관리자 로그인 후 다시 추첨해 주세요.`,
        };
      }

      const matchedIds = new Set(round.groups.flatMap((group) => group.members.map((m) => m.id)));
      const groups = addLateParticipants(round.groups, participants, round.targetSize, round.mode);
      const assignments = groups.flatMap((group) => group.members
        .filter((member) => !matchedIds.has(member.id))
        .map((member) => ({ participant_id: member.id, group_number: group.groupNumber })));

      const { error } = await createAdminClient().rpc('append_prayer_members', {
        p_round_id: round.id,
        p_assignments: assignments,
      });
      if (error?.code === '40001') continue; // 동시 신청·다른 진행자의 배정을 반영해 재시도
      if (error) throw error;

      revalidatePath('/admin');
      revalidatePath('/display');
      revalidatePath('/me', 'layout');
      return { status: 'success', snapshot: toDisplaySnapshot(participants, { ...round, groups }) };
    }
    return { status: 'error', message: '신청 명단이 변경되었습니다. 잠시 후 추첨 버튼을 다시 눌러 주세요.' };
  } catch (error) {
    console.error('[prepareDrawAction]', error);
    return { status: 'error', message: '추가 참가자 배정을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
