import Link from 'next/link';
import LoginForm from './LoginForm';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import { isAdmin } from '@/lib/auth';
import { countByTeam, getActiveRound, getParticipants } from '@/lib/queries';
import { MATCH_MODE_LABEL, type MatchMode, type TargetSize } from '@/lib/types';
import {
  deleteParticipantAction,
  logoutAction,
  resetAllAction,
  runMatchingAction,
  unpublishAction,
} from './actions';

export const dynamic = 'force-dynamic';

const MATCH_OPTIONS: {
  mode: MatchMode;
  targetSize: TargetSize;
  label: string;
  hint: string;
  primary: boolean;
}[] = [
  { mode: 'team', targetSize: 2, label: '2인 1조', hint: '팀 섞기', primary: true },
  { mode: 'team', targetSize: 3, label: '3인 1조', hint: '팀 섞기', primary: true },
  { mode: 'team', targetSize: 4, label: '4인 1조', hint: '팀 섞기', primary: true },
  { mode: 'random', targetSize: 2, label: '2인 1조', hint: '완전 랜덤', primary: false },
  { mode: 'random', targetSize: 3, label: '3인 1조', hint: '완전 랜덤', primary: false },
  { mode: 'random', targetSize: 4, label: '4인 1조', hint: '완전 랜덤', primary: false },
];

export default async function AdminPage() {
  if (!(await isAdmin())) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
        <LoginForm />
      </main>
    );
  }

  const [participants, round] = await Promise.all([getParticipants(), getActiveRound()]);
  const byTeam = countByTeam(participants);

  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-8">
      <RealtimeRefresher
        channel="admin"
        tables={['participants', 'match_rounds', 'match_groups', 'match_members']}
      />

      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-slate-400">
              사랑의교회 청년부 · 한반도이웃사랑선교국
            </p>
            <h1 className="text-2xl font-bold text-slate-900">2026 짝기도 매칭 관리</h1>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/display"
              target="_blank"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-medium text-slate-700"
            >
              송출 화면 열기 ↗
            </Link>
            <a
              href="/api/admin/export"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-medium text-slate-700"
            >
              CSV 내려받기
            </a>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-lg px-3 py-2 font-medium text-slate-500"
              >
                로그아웃
              </button>
            </form>
          </div>
        </header>

        {/* 접수 현황 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold text-slate-500">접수 현황</h2>
            <p className="text-3xl font-bold text-slate-900">{participants.length}명</p>
          </div>

          {byTeam.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {byTeam.map(({ team, count }) => (
                <span
                  key={team}
                  className="rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-700"
                >
                  {team} <b className="ml-1">{count}</b>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* 매칭 실행 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-500">매칭 실행</h2>
          <p className="mt-1 text-xs text-slate-400">
            누르는 즉시 새 매칭이 확정되어 송출 화면에 반영됩니다. 이전 매칭은 자동으로
            내려갑니다.
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {MATCH_OPTIONS.map((option) => (
              <form key={`${option.mode}-${option.targetSize}`} action={runMatchingAction}>
                <input type="hidden" name="mode" value={option.mode} />
                <input type="hidden" name="target_size" value={option.targetSize} />
                <button
                  type="submit"
                  disabled={participants.length === 0}
                  className={`w-full rounded-xl px-4 py-3 text-sm font-semibold transition active:scale-[0.99] disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 ${
                    option.primary
                      ? 'border border-brand-600 bg-brand-600 text-white'
                      : 'border border-slate-300 bg-white text-slate-700'
                  }`}
                >
                  {option.label}
                  <span
                    className={`ml-2 text-xs font-normal ${
                      option.primary ? 'text-white/70' : 'text-slate-400'
                    }`}
                  >
                    {option.hint}
                  </span>
                </button>
              </form>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
            {round ? (
              <>
                <p className="text-sm text-slate-600">
                  현재 송출 중 · <b>{round.groups.length}조</b> ·{' '}
                  {MATCH_MODE_LABEL[round.mode]} / {round.targetSize}인 기준
                </p>
                <form action={unpublishAction}>
                  <button
                    type="submit"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
                  >
                    화면에서 내리기
                  </button>
                </form>
              </>
            ) : (
              <p className="text-sm text-slate-400">아직 확정된 매칭이 없습니다.</p>
            )}
          </div>
        </section>

        {/* 매칭 결과 미리보기 */}
        {round && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="mb-4 text-sm font-semibold text-slate-500">매칭 결과</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {round.groups.map((group) => (
                <div
                  key={group.groupNumber}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <p className="mb-2 text-xs font-bold tracking-wider text-brand-600">
                    {group.groupNumber}조
                  </p>
                  <ul className="space-y-1 text-sm text-slate-700">
                    {group.members.map((member) => (
                      <li key={member.id}>
                        {member.name}
                        <span className="ml-1.5 text-xs text-slate-400">
                          {member.team}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 참가자 명단 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-500">참가자 명단</h2>

          {participants.length === 0 ? (
            <p className="text-sm text-slate-400">아직 접수된 사람이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs text-slate-400">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">이름</th>
                    <th className="pb-2 pr-4 font-medium">팀</th>
                    <th className="pb-2 pr-4 font-medium">기도제목</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {participants.map((participant) => (
                    <tr key={participant.id}>
                      <td className="py-3 pr-4 font-medium text-slate-900">
                        {participant.name}
                      </td>
                      <td className="py-3 pr-4 text-slate-500">{participant.team}</td>
                      <td className="max-w-md py-3 pr-4 text-slate-600">
                        {participant.prayer_request}
                      </td>
                      <td className="py-3 text-right">
                        <form action={deleteParticipantAction}>
                          <input type="hidden" name="id" value={participant.id} />
                          <button
                            type="submit"
                            className="text-xs text-slate-400 hover:text-red-600"
                          >
                            삭제
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 행사 종료 후 데이터 삭제 */}
        <section className="rounded-2xl border border-red-200 bg-red-50 p-6">
          <h2 className="text-sm font-semibold text-red-700">행사 종료 후 데이터 삭제</h2>
          <p className="mt-1 text-xs text-red-600/80">
            참가자와 매칭 기록을 모두 지웁니다. 되돌릴 수 없으니 CSV 를 먼저 내려받으세요.
          </p>
          <form action={resetAllAction} className="mt-4 flex flex-wrap gap-2">
            <input
              name="confirm"
              required
              placeholder="삭제 라고 입력"
              className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-500"
            />
            <button
              type="submit"
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white"
            >
              전체 삭제
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
