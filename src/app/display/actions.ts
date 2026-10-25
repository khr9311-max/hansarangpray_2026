'use server';
import { revalidatePath } from 'next/cache';
import { isAdmin } from '@/lib/auth';
import { eventCommand } from '@/lib/event';

export async function prepareDrawAction(revision: number) {
  if (!(await isAdmin())) return { status: 'error' as const, requiresAdmin: true, message: '관리자 로그인 후 추첨을 시작해 주세요.' };
  try {
    await eventCommand(revision, 'draw');
    revalidatePath('/display'); revalidatePath('/admin'); revalidatePath('/me', 'layout');
    return { status: 'success' as const };
  } catch (error) {
    return { status: 'error' as const, message: error instanceof Error ? error.message : '추첨을 시작하지 못했습니다.' };
  }
}
