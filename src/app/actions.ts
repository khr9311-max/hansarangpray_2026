'use server';

import { createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { allowParticipantEdit, rememberParticipantAccess, validEditToken } from '@/lib/participant-access';
import { TEAMS } from '@/lib/types';

export type SubmitState = {
  status: 'idle' | 'success' | 'error';
  message: string;
  participantId?: string;
};

const MAX_NAME = 20;
const MAX_PRAYER = 500;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function submitParticipant(
  _prevState: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const id = String(formData.get('participant_id') ?? '');
  const editToken = String(formData.get('edit_token') ?? '');
  if (id && !(await allowParticipantEdit(id, editToken))) {
    return { status: 'error', message: '수정 권한이 만료되었습니다. 운영자에게 본인용 수정 링크를 요청해 주세요.' };
  }
  const submissionId = String(formData.get('submission_id') ?? '');
  if (!id && !UUID.test(submissionId)) {
    return { status: 'error', message: '신청 정보를 준비하지 못했습니다. 화면을 새로고침한 후 다시 시도해 주세요.' };
  }
  const name = String(formData.get('name') ?? '').trim();
  const team = String(formData.get('team') ?? '').trim();
  const shareInGroup = formData.get('share_in_group') === 'on';
  const prayerRequest = shareInGroup
    ? '기도제목은 매칭된 조 안에서 직접 나눌게요.'
    : String(formData.get('prayer_request') ?? '').trim();

  if (!name || !team || !prayerRequest) {
    return { status: 'error', message: '모든 항목을 입력해 주세요.' };
  }
  if (name.length > MAX_NAME) {
    return { status: 'error', message: `이름은 ${MAX_NAME}자 이내로 입력해 주세요.` };
  }
  if (prayerRequest.length > MAX_PRAYER) {
    return {
      status: 'error',
      message: `기도제목은 ${MAX_PRAYER}자 이내로 입력해 주세요.`,
    };
  }
  // 드롭다운을 우회한 값이 들어오지 않도록 서버에서 한 번 더 확인합니다.
  if (!TEAMS.includes(team)) {
    return { status: 'error', message: '팀을 다시 선택해 주세요.' };
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = id
      ? await supabase.rpc('prayer_edit', { p_id: id, p_version: Number(formData.get('edit_version')), p_name: name, p_team: team, p_prayer: prayerRequest })
      : await supabase.rpc('prayer_submit', { p_request_id: submissionId, p_name: name, p_team: team, p_prayer: prayerRequest });
    if (error?.code === '40001') return { status: 'error', message: '다른 화면에서 이미 수정되었습니다. 새로고침 후 최신 내용을 확인해 주세요.' };

    if (error || !data) {
      console.error('[submitParticipant]', error);
      return {
        status: 'error',
        message: '접수 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.',
      };
    }

    const participantId = id || String(data);
    // 관리자 권한으로만 수정한 경우 본인용 권한을 새로 부여하지 않습니다.
    // 전달받은 유효한 수정 링크는 저장 후 같은 브라우저에서 계속 쓸 수 있습니다.
    if (!id || validEditToken(id, editToken)) await rememberParticipantAccess(participantId);
    revalidatePath('/admin'); revalidatePath('/display'); revalidatePath('/me', 'layout');
    revalidatePath(`/edit/${participantId}`);
    return {
      status: 'success',
      message: id ? '신청 정보가 수정되었습니다. 기존 조는 그대로 유지됩니다.' : shareInGroup ? '참가 신청이 접수되었습니다.' : '기도제목이 접수되었습니다.',
      participantId,
    };
  } catch (err) {
    console.error('[submitParticipant exception]', err);
    return {
      status: 'error',
      message: '서버 연결에 실패했습니다. 데이터베이스 상태를 확인해 주세요.',
    };
  }
}
