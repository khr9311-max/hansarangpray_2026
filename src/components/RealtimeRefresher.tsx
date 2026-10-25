'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/**
 * 지정한 테이블에 변경이 생기면 서버 컴포넌트를 다시 그립니다.
 * Realtime 변경을 묶어서 반영하고, 모바일 복귀·연결 누락도 복구합니다.
 */
export default function RealtimeRefresher({
  tables,
  channel,
}: {
  tables: string[];
  channel: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 150);
    };
    const visibleRefresh = () => { if (document.visibilityState === 'visible') refresh(); };
    const poll = setInterval(visibleRefresh, 10000);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    const subscription = supabase.channel(channel);

    for (const table of tables) {
      subscription.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        refresh,
      );
    }

    subscription.subscribe();
    return () => {
      clearTimeout(timer); clearInterval(poll);
      window.removeEventListener('focus', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
      supabase.removeChannel(subscription);
    };
    // tables 는 렌더마다 새 배열이 되므로 문자열로 고정해 비교합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, tables.join(','), router]);

  return null;
}
