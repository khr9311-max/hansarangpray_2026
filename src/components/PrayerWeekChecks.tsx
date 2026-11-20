'use client';

import { useOptimistic, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { savePrayerCheck } from '@/app/me/[id]/actions';
import { PRAYER_WEEKS } from '@/lib/prayer-weeks';

type WeekChecks = readonly [boolean, boolean, boolean, boolean];

export default function PrayerWeekChecks({
  id,
  roundId,
  checks,
}: {
  id: string;
  roundId: string;
  checks: WeekChecks;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const saving = useRef(false);
  const [optimisticChecks, updateChecks] = useOptimistic(
    checks,
    (current, update: { week: number; checked: boolean }): WeekChecks => [
      update.week === 1 ? update.checked : current[0],
      update.week === 2 ? update.checked : current[1],
      update.week === 3 ? update.checked : current[2],
      update.week === 4 ? update.checked : current[3],
    ],
  );

  function changeWeek(week: number, checked: boolean) {
    if (saving.current) return;
    saving.current = true;
    setError('');
    startTransition(async () => {
      updateChecks({ week, checked });
      try {
        const result = await savePrayerCheck({ id, roundId, week, checked });
        if (result.error) setError(result.error);
        else router.refresh();
      } catch {
        setError('저장하지 못했습니다. 잠시 후 다시 체크해 주세요.');
      } finally {
        // useOptimistic restores the saved values if this update fails.
        saving.current = false;
      }
    });
  }

  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <fieldset disabled={pending} className="min-w-0 disabled:opacity-60">
        <legend className="text-sm font-semibold text-slate-700">기도 체크</legend>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PRAYER_WEEKS.map((week, index) => {
            const checked = optimisticChecks[index];
            return <label key={week} className={`flex cursor-pointer flex-col items-start gap-2 rounded-xl border px-3 py-3 text-xs ${checked ? 'border-brand-200 bg-brand-50' : 'border-slate-200 bg-white'}`}>
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={event => changeWeek(week, event.currentTarget.checked)}
                  aria-label={`${week}주차 기도 체크`}
                  className="h-5 w-5 shrink-0 accent-brand-600"
                />
                <span className="font-semibold text-slate-700">{week}주차</span>
              </span>
              <span className={checked ? 'text-brand-700' : 'text-slate-400'}>{checked ? '기도했어요' : '미체크'}</span>
            </label>;
          })}
        </div>
      </fieldset>
      {pending && <p role="status" className="mt-2 text-xs text-slate-500">저장 중…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
