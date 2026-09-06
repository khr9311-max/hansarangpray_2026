'use server';

import { createServerClient } from '@/lib/supabase/server';
import { TEAMS } from '@/lib/types';

export type SubmitState = {
  status: 'idle' | 'success' | 'error';
  message: string;
  participantId?: string;
};

const MAX_NAME = 20;
const MAX_PRAYER = 500;

export async function submitParticipant(
  _prevState: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const name = String(formData.get('name') ?? '').trim();
  const team = String(formData.get('team') ?? '').trim();
  const prayerRequest = String(formData.get('prayer_request') ?? '').trim();

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

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('participants')
    .insert({ name, team, prayer_request: prayerRequest })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[submitParticipant]', error);
    return {
      status: 'error',
      message: '접수 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.',
    };
  }

  return {
    status: 'success',
    message: '기도제목이 접수되었습니다.',
    participantId: data.id as string,
  };
}
