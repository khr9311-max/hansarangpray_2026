'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { EVENT_CACHE_TAG } from '@/lib/event';
import { canCheckPrayer } from '@/lib/prayer-access';
import { storageRequest, StorageError } from '@/lib/storage';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function savePrayerCheck(input: { id: string; roundId: string; week: number; checked: boolean }): Promise<{ error?: string }> {
  if (!input || typeof input.id !== 'string' || !UUID.test(input.id) || typeof input.roundId !== 'string' || !UUID.test(input.roundId)
    || !Number.isInteger(input.week) || input.week < 1 || input.week > 4 || typeof input.checked !== 'boolean') {
    return { error: '기도 체크 정보를 확인해 주세요.' };
  }
  const { id, roundId, week, checked } = input;
  try {
    if (!(await canCheckPrayer(id))) return { error: '신청한 기기나 본인용 기도 체크 링크에서 다시 열어 주세요.' };
    await storageRequest<boolean>('check_prayer', { id, roundId, week, checked });
    revalidateTag(EVENT_CACHE_TAG);
    revalidatePath('/me', 'layout');
    return {};
  } catch (error) {
    if (error instanceof StorageError && (error.code === '40001' || error.code === 'P0002')) {
      return { error: '조 편성이 변경되었습니다. 화면을 새로고침한 뒤 다시 체크해 주세요.' };
    }
    return { error: '기도 체크를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
