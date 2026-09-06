'use client';

import { useActionState } from 'react';
import { loginAction, type AdminState } from './actions';

const initialState: AdminState = { status: 'idle', message: '' };

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form
      action={formAction}
      className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
    >
      <h1 className="text-xl font-bold text-slate-900">관리자 로그인</h1>

      <input
        name="password"
        type="password"
        required
        autoFocus
        placeholder="관리자 비밀번호"
        className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />

      {state.status === 'error' && (
        <p className="text-sm text-red-600">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-slate-900 px-4 py-3 font-semibold text-white disabled:opacity-50"
      >
        {pending ? '확인 중…' : '들어가기'}
      </button>
    </form>
  );
}
