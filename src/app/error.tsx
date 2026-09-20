'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Application Error]', error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-5 text-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-4 text-4xl">⚠️</div>
        <h2 className="text-xl font-bold text-slate-900">페이지를 불러오는 중 오류가 발생했습니다</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-500">
          데이터베이스가 일시 중지되었거나 일시적인 네트워크 연결 문제일 수 있습니다.
        </p>
        {error.digest && (
          <p className="mt-2 text-xs text-slate-400">코드: {error.digest}</p>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500"
          >
            다시 시도하기
          </button>
          <a
            href="/"
            className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            홈으로
          </a>
        </div>
      </div>
    </main>
  );
}
