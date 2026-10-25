'use client';
import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export default function ActionForm({ action, children, className }: {
  action: (data: FormData) => Promise<{ error?: string; message?: string }>; children: ReactNode; className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const router = useRouter();
  return <form className={className} onReset={event => event.preventDefault()} action={(data) => startTransition(async () => {
    setError(''); setMessage('');
    try { const result = await action(data); setError(result.error ?? ''); setMessage(result.message ?? ''); }
    catch { setError('연결이 끊겼습니다. 결과를 확인한 뒤 다시 시도해 주세요.'); }
    finally { router.refresh(); }
  })}>
    <fieldset disabled={pending} className="min-w-0 disabled:opacity-50">{children}</fieldset>
    {pending && <p className="mt-2 text-xs" role="status">처리 중…</p>}
    {message && <p className="mt-2 text-sm text-emerald-700" role="status">{message}</p>}
    {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
  </form>;
}
