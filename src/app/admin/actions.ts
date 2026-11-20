'use server';

import { revalidatePath } from 'next/cache';
import { assertAdmin, signIn, signOut } from '@/lib/auth';
import { appendParticipants, eventCommand, getEventSnapshot, readRevision } from '@/lib/event';
import { createPrayerGroups } from '@/lib/matching';
import { TARGET_SIZES, type MatchMode, type TargetSize } from '@/lib/types';

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

async function mutate(formData: FormData, operation: string, payload = {}) {
  try {
    await assertAdmin();
    await eventCommand(readRevision(formData), operation, payload);
    revalidatePath('/admin'); revalidatePath('/display'); revalidatePath('/me', 'layout');
    if (operation === 'publish') return { message: '새 조 편성을 저장했습니다. 잠시 후 출력 화면에 결과가 공개됩니다.' };
    if (operation === 'restore') return { message: '선택한 편성으로 돌아갔습니다. 잠시 후 출력 화면에 결과가 공개됩니다.' };
    if (operation === 'draw') return { message: '잠시 후 출력 화면에 현재 조가 다시 공개됩니다.' };
    return { message: '처리되었습니다.' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '처리하지 못했습니다.' };
  }
}

export async function startMatchingDrawAction(formData: FormData) {
  try {
    await assertAdmin();
    const targetSize = Number(formData.get('target_size')) as TargetSize;
    const mode = String(formData.get('mode')) as MatchMode;
    if (!TARGET_SIZES.includes(targetSize) || !['team', 'random'].includes(mode)) return { error: '매칭 설정을 확인해 주세요.' };
    const revision = readRevision(formData);
    const snapshot = await getEventSnapshot();
    if (snapshot.revision !== revision) return { error: '신청 또는 편성이 변경되었습니다. 갱신된 명단을 확인하고 다시 눌러 주세요.' };
    if (!snapshot.participants.length) return { error: '접수된 참가자가 없습니다.' };
    if (snapshot.round && formData.get('confirm') !== '재편성') return { error: '새 조 편성 확인란을 선택해 주세요.' };
    const groups = createPrayerGroups(snapshot.participants, targetSize, mode);
    return mutate(formData, 'publish', {
      target: targetSize, mode, confirm: formData.get('confirm'), draw: true,
      assignments: groups.flatMap(g => g.members.map(m => ({ participant_id: m.id, group_number: g.groupNumber }))),
    });
  } catch { return { error: '매칭을 준비하지 못했습니다. 새로고침 후 다시 시도해 주세요.' }; }
}
export async function drawAction(formData: FormData) { return mutate(formData, 'draw'); }
export async function restoreRoundAction(formData: FormData) {
  const roundId = formData.get('round_id');
  if (typeof roundId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(roundId)) {
    return { error: '되돌아갈 편성을 선택해 주세요.' };
  }
  return mutate(formData, 'restore', { roundId });
}
export async function unpublishAction(formData: FormData) { return mutate(formData, 'unpublish'); }
export async function deleteParticipantAction(formData: FormData) { return mutate(formData, 'delete', { id: formData.get('id') }); }
export async function resetAllAction(formData: FormData) {
  if (formData.get('confirm') !== '삭제') return { error: '삭제라고 입력해 주세요.' };
  return mutate(formData, 'reset', { confirm: '삭제' });
}

export async function applyParticipantsAction(formData: FormData) {
  try {
    await assertAdmin();
    const count = await appendParticipants(readRevision(formData));
    revalidatePath('/admin'); revalidatePath('/display'); revalidatePath('/me', 'layout');
    return { message: count ? `${count}명을 기존 조에 추가했습니다. 기존 조원은 그대로입니다.` : '추가로 반영할 참여자가 없습니다. 기존 결과를 유지합니다.' };
  } catch (error) { return { error: error instanceof Error ? error.message : '추가 참여자를 반영하지 못했습니다.' }; }
}
