'use server';

import { revalidatePath } from 'next/cache';
import { assertAdmin, signIn, signOut } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { createPrayerGroups } from '@/lib/matching';
import type { MatchMode, Participant, TargetSize } from '@/lib/types';

export type AdminState = { status: 'idle' | 'error'; message: string };

export async function loginAction(
  _prevState: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const password = String(formData.get('password') ?? '');
  if (await signIn(password)) {
    revalidatePath('/admin');
    return { status: 'idle', message: '' };
  }
  return { status: 'error', message: '비밀번호가 올바르지 않습니다.' };
}

export async function logoutAction() {
  await signOut();
  revalidatePath('/admin');
}

/** 매칭을 실행하고 결과를 새 회차로 확정합니다. (/display 에 즉시 반영) */
export async function runMatchingAction(formData: FormData) {
  await assertAdmin();

  const targetSize = Number(formData.get('target_size')) as TargetSize;
  const mode = String(formData.get('mode')) as MatchMode;
  if (![2, 3, 4].includes(targetSize)) throw new Error('조 인원이 올바르지 않습니다.');
  if (!['team', 'random'].includes(mode)) throw new Error('매칭 방식이 올바르지 않습니다.');

  const supabase = createAdminClient();

  const { data: participants, error: fetchError } = await supabase
    .from('participants')
    .select('*')
    .order('created_at', { ascending: true });
  if (fetchError) throw fetchError;
  if (!participants?.length) throw new Error('접수된 참가자가 없습니다.');

  const groups = createPrayerGroups(participants as Participant[], targetSize, mode);

  // 이전 회차를 내리고 새 회차를 활성화합니다. (활성 회차는 항상 하나)
  const { error: deactivateError } = await supabase
    .from('match_rounds')
    .update({ is_active: false })
    .eq('is_active', true);
  if (deactivateError) throw deactivateError;

  const { data: round, error: roundError } = await supabase
    .from('match_rounds')
    .insert({ mode, target_size: targetSize, is_active: true })
    .select('id')
    .single();
  if (roundError) throw roundError;

  const { data: insertedGroups, error: groupError } = await supabase
    .from('match_groups')
    .insert(
      groups.map((g) => ({ round_id: round.id, group_number: g.groupNumber })),
    )
    .select('id, group_number');
  if (groupError) throw groupError;

  const groupIdByNumber = new Map(
    insertedGroups.map((g) => [g.group_number as number, g.id as string]),
  );
  const memberRows = groups.flatMap((g) =>
    g.members.map((member, seq) => ({
      group_id: groupIdByNumber.get(g.groupNumber)!,
      participant_id: member.id,
      seq,
    })),
  );

  const { error: memberError } = await supabase.from('match_members').insert(memberRows);
  if (memberError) throw memberError;

  revalidatePath('/admin');
  revalidatePath('/display');
}

/** 확정된 매칭을 화면에서 내립니다. (참가자 명단은 유지) */
export async function unpublishAction() {
  await assertAdmin();

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('match_rounds')
    .update({ is_active: false })
    .eq('is_active', true);
  if (error) throw error;

  revalidatePath('/admin');
  revalidatePath('/display');
}

export async function deleteParticipantAction(formData: FormData) {
  await assertAdmin();

  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('참가자 ID 가 없습니다.');

  const supabase = createAdminClient();
  const { error } = await supabase.from('participants').delete().eq('id', id);
  if (error) throw error;

  revalidatePath('/admin');
  revalidatePath('/display');
}

/**
 * 행사 종료 후 개인정보 일괄 삭제.
 * 참가자와 매칭 기록을 모두 지웁니다. (되돌릴 수 없음)
 */
export async function resetAllAction(formData: FormData) {
  await assertAdmin();

  if (String(formData.get('confirm') ?? '') !== '삭제') {
    throw new Error('확인 문구가 일치하지 않습니다.');
  }

  const supabase = createAdminClient();
  // match_groups/match_members 는 ON DELETE CASCADE 로 함께 지워집니다.
  const { error: roundError } = await supabase
    .from('match_rounds')
    .delete()
    .not('id', 'is', null);
  if (roundError) throw roundError;

  const { error: participantError } = await supabase
    .from('participants')
    .delete()
    .not('id', 'is', null);
  if (participantError) throw participantError;

  revalidatePath('/admin');
  revalidatePath('/display');
}
