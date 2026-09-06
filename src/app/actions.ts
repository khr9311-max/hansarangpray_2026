'use server';

import { createServerClient } from '@/lib/supabase/server';
import { GENDERS, TEAMS, type Gender } from '@/lib/types';

export type SubmitState = {
  status: 'idle' | 'success' | 'error';
  message: string;
};

const MAX_NAME = 20;

export async function submitParticipant(
  _prevState: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const name = String(formData.get('name') ?? '').trim();
  const team = String(formData.get('team') ?? '').trim();
  const gender = String(formData.get('gender') ?? '').trim() as Gender;

  if (!name || !team || !gender) {
    return { status: 'error', message: '모든 항목을 입력해 주세요.' };
  }
  if (name.length > MAX_NAME) {
    return { status: 'error', message: `이름은 ${MAX_NAME}자 이내로 입력해 주세요.` };
  }
  // 드롭다운을 우회한 값이 들어오지 않도록 서버에서 한 번 더 확인합니다.
  if (!TEAMS.includes(team) || !GENDERS.includes(gender)) {
    return { status: 'error', message: '팀과 성별을 다시 선택해 주세요.' };
  }

  const supabase = createServerClient();
  const { error } = await supabase.from('participants').insert({ name, team, gender });

  if (error) {
    console.error('[submitParticipant]', error);
    return {
      status: 'error',
      message: '접수 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.',
    };
  }

  return { status: 'success', message: '신청이 접수되었습니다.' };
}
