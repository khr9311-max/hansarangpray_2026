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

      {/*
        화면 렌더에는 이름만 쓰지만, 클라이언트 컴포넌트에 넘기는 값은
        그대로 페이지 소스(RSC 페이로드)에 실려 나갑니다. 팀·기도제목까지
        통째로 넘기면 "화면엔 안 보이지만 소스에는 있는" 상태가 되므로
        여기서 이름만 남기고 잘라서 넘깁니다.

        id 도 실제 participant.id(=/me/[id] 접근 키) 대신 화면 전용
        가짜 키로 바꿉니다. 진짜 id를 그대로 넘기면 페이지 소스에서
        모든 참가자의 /me 링크를 추출할 수 있게 되어, 매칭된 조끼리만
        기도제목을 보게 한 의미가 사라집니다.
      */}
      <DisplayStage
        participants={participants.map((p, i) => ({ id: `p${i}`, name: p.name }))}
        round={
          round && {
            id: round.id,
            groups: round.groups.map((g) => ({
              groupNumber: g.groupNumber,
              members: g.members.map((m, i) => ({
                id: `${g.groupNumber}-${i}`,
                name: m.name,
              })),
            })),
          }
        }
      />
    </main>
  );
}
