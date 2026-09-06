import DisplayStage from './DisplayStage';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import { getActiveRound, getParticipants } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function DisplayPage() {
  const [participants, round] = await Promise.all([getParticipants(), getActiveRound()]);

  return (
    <main className="flex min-h-dvh flex-col bg-slate-950 px-8 py-6 text-white">
      <RealtimeRefresher
        channel="display"
        tables={['participants', 'match_rounds', 'match_groups', 'match_members']}
      />

      <header className="mb-5 flex items-baseline justify-between">
        <div>
          <p className="text-xs font-semibold tracking-wider text-white/40">
            사랑의교회 청년부 · 한반도이웃사랑선교국
          </p>
          <h1 className="mt-1 text-3xl font-bold">
            2026 짝기도 매칭
            {round && (
              <span className="ml-4 text-lg font-normal text-white/40">
                총 {round.groups.length}조
              </span>
            )}
          </h1>
        </div>
        <p className="text-sm text-white/25">F11 전체화면</p>
      </header>

      <DisplayStage participants={participants} round={round} />
    </main>
  );
}
