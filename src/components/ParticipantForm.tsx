'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { submitParticipant, type SubmitState } from '@/app/actions';
import { GENDERS, TEAMS } from '@/lib/types';

const initialState: SubmitState = { status: 'idle', message: '' };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-xl bg-brand-600 px-4 py-4 text-lg font-semibold text-white transition active:scale-[0.99] disabled:opacity-50"
    >
      {pending ? '보내는 중…' : '신청하기'}
    </button>
  );
}

export default function ParticipantForm() {
  const [state, formAction] = useActionState(submitParticipant, initialState);

  // 제출이 끝나면 폼을 감춰 같은 사람이 두 번 넣는 일을 막습니다.
  if (state.status === 'success') {
    return (
      <div className="rounded-2xl border border-brand-100 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 text-5xl">🙏</div>
        <h2 className="text-xl font-bold text-slate-900">{state.message}</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-500">
          잠시 후 앞 화면에 짝이 안내됩니다.
          <br />
          화면을 보며 함께 기도해 주세요.
        </p>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-semibold text-slate-700">
          이름
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={20}
          autoComplete="name"
          placeholder="홍길동"
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>

      <div>
        <label htmlFor="team" className="mb-2 block text-sm font-semibold text-slate-700">
          팀
        </label>
        <select
          id="team"
          name="team"
          required
          defaultValue=""
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          <option value="" disabled>
            팀을 선택하세요
          </option>
          {TEAMS.map((team) => (
            <option key={team} value={team}>
              {team}
            </option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend className="mb-2 block text-sm font-semibold text-slate-700">성별</legend>
        <div className="grid grid-cols-2 gap-2">
          {GENDERS.map((gender) => (
            <label
              key={gender}
              className="relative flex cursor-pointer items-center justify-center rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-600 transition has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:font-semibold has-[:checked]:text-brand-700"
            >
              <input
                type="radio"
                name="gender"
                value={gender}
                required
                className="sr-only"
              />
              {gender}
            </label>
          ))}
        </div>
      </fieldset>

      {state.status === 'error' && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
          {state.message}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}
