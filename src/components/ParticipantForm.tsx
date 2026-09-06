'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { submitParticipant, type SubmitState } from '@/app/actions';
import { TEAMS } from '@/lib/types';

const initialState: SubmitState = { status: 'idle', message: '' };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-xl bg-brand-600 px-4 py-4 text-lg font-semibold text-white transition active:scale-[0.99] disabled:opacity-50"
    >
      {pending ? '보내는 중…' : '기도제목 보내기'}
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

        {state.participantId && (
          <Link
            href={`/me/${state.participantId}`}
            className="mt-6 inline-block w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white"
          >
            내 기도짝 확인하기 →
          </Link>
        )}
        {state.participantId && (
          <p className="mt-3 text-xs text-slate-400">
            매칭이 확정되면 이 링크에서 기도짝의 기도제목을 볼 수 있어요.
            <br />
            링크를 저장해 두세요.
          </p>
        )}
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

      <div>
        <label
          htmlFor="prayer_request"
          className="mb-2 block text-sm font-semibold text-slate-700"
        >
          기도제목
        </label>
        <textarea
          id="prayer_request"
          name="prayer_request"
          required
          rows={5}
          maxLength={500}
          placeholder="함께 기도하고 싶은 내용을 적어 주세요."
          className="w-full resize-none rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-2 text-xs text-slate-400">
          송출 화면에는 이름만 나갑니다. 기도제목은 매칭된 기도짝끼리만 개인 링크로 볼 수
          있어요.
        </p>
      </div>

      {state.status === 'error' && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
          {state.message}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}
