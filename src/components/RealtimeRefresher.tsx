'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 서버가 공유 캐시로 확인한 저장소 버전이 바뀌면 화면을 갱신합니다.
 * 숨겨진 탭에서는 멈추고, 다시 열거나 온라인으로 돌아오면 확인합니다.
 */
export default function RealtimeRefresher({
  revision,
}: {
  revision: number;
}) {
  const router = useRouter();

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let controller: AbortController | undefined;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (disposed || busy || document.visibilityState !== 'visible' || !navigator.onLine) return;
      busy = true;
      controller = new AbortController();
      requestTimeout = setTimeout(() => controller?.abort(), 15000);
      try {
        const response = await fetch('/api/event/revision', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const latest: { revision: number } = await response.json();
        if (!disposed && Number.isSafeInteger(latest.revision) && latest.revision !== revision) router.refresh();
      } catch { /* Retry on the next poll while keeping the current screen. */ }
      finally { clearTimeout(requestTimeout); busy = false; }
    };
    const poll = setInterval(check, 5000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    void check();
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(requestTimeout);
      clearInterval(poll);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [revision, router]);

  return null;
}
