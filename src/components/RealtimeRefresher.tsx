'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/**
 * 지정한 테이블에 변경이 생기면 서버 컴포넌트를 다시 그립니다.
 * 폴링 없이 /display 와 /admin 을 최신 상태로 유지합니다.
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
    const subscription = supabase.channel(channel);

    for (const table of tables) {
      subscription.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => router.refresh(),
      );
    }

    subscription.subscribe();
    return () => {
      supabase.removeChannel(subscription);
    };
    // tables 는 렌더마다 새 배열이 되므로 문자열로 고정해 비교합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, tables.join(','), router]);

  return null;
}
