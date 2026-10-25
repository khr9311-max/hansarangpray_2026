import Link from 'next/link';
import ActionForm from '@/components/ActionForm';
import { getEventSnapshot } from '@/lib/event';
import { editToken } from '@/lib/participant-access';
import LoginForm from './LoginForm';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import { isAdmin } from '@/lib/auth';
import { countByTeam } from '@/lib/queries';
import { MATCH_MODE_LABEL, TARGET_SIZES } from '@/lib/types';
import {
  drawAction,
  deleteParticipantAction,
  logoutAction,
  resetAllAction,
  runMatchingAction,
  unpublishAction,
} from './actions';

export const dynamic = 'force-dynamic';

const MATCH_OPTIONS = (['team', 'random'] as const).flatMap((mode) =>
  TARGET_SIZES.map((targetSize) => ({
    mode,
    targetSize,
    label: `${targetSize}인 1조`,
    hint: MATCH_MODE_LABEL[mode],
    primary: mode === 'team',
  })),
);

export default async function AdminPage() {
  if (!(await isAdmin())) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
        <LoginForm />
      </main>
    );
  }

  const { participants, round, revision } = await getEventSnapshot();
  const byTeam = countByTeam(participants);

  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-8">
      <RealtimeRefresher
        channel="admin"
        tables={['match_control', 'participants', 'match_rounds', 'match_groups', 'match_members']}
      />

      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-slate-400">
              사랑의교회 청년부 · 한반도이웃사랑선교국
            </p>
            <h1 className="text-2xl font-bold text-slate-900">2026 짝기도 매칭 관리</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              href="/display"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-medium text-slate-700"
            >
              휴대폰·PC 결과 화면 열기 →
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
          <h2 className="text-sm font-semibold text-slate-500">{round ? '기존 조 유지 중' : '첫 조 편성'}</h2>
          <p className="mt-2 text-sm text-slate-600">새 신청자는 기존 조 중 인원이 적은 조에 자동 합류합니다. 기존 조원과 조 번호는 바뀌지 않습니다.</p>
          {round && <ActionForm action={drawAction} className="mt-4">
            <input type="hidden" name="revision" value={revision} />
            <button className="w-full rounded-xl bg-brand-600 p-4 font-bold text-white">모든 화면에서 추첨·결과 공개</button>
            <p className="mt-2 text-xs text-slate-500">폰에서 누르면 PC 송출 화면도 함께 바뀝니다. 조 편성은 그대로 유지됩니다.</p>
          </ActionForm>}
          <details open={round ? undefined : true} key={round?.id ?? 'initial'} className="mt-4">
          <summary className="cursor-pointer font-semibold text-slate-700">{round ? '전체 조를 새로 편성하기 (기존 조 변경)' : '인원과 방식 선택'}</summary>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {MATCH_OPTIONS.map((option) => (
              <ActionForm key={`${option.mode}-${option.targetSize}`} action={runMatchingAction}>
                <input type="hidden" name="revision" value={revision} />
                {round && <input name="confirm" required placeholder="재편성 입력" aria-label={`${option.hint} ${option.label} 재편성 확인`} className="mb-2 w-full rounded-lg border p-2 text-sm" />}
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
              </ActionForm>
            ))}
          </div>

          </details>
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
            {round ? (
              <>
                <p className="text-sm text-slate-600">
                  현재 송출 중 · <b>{round.groups.length}조</b> ·{' '}
                  {MATCH_MODE_LABEL[round.mode]} / {round.targetSize}인 기준
                </p>
                <ActionForm action={unpublishAction}><input type="hidden" name="revision" value={revision} />
                  <button
                    type="submit"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
                  >
                    화면에서 내리기
                  </button>
                </ActionForm>
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
                        <Link href={`/edit/${participant.id}`} className="mt-1 block text-xs text-brand-600 underline">정보 수정</Link>
                        <Link href={`/edit/${participant.id}?token=${editToken(participant.id)}`} className="mt-1 block text-xs text-slate-500 underline">본인 전달용 수정 링크</Link>
                      </td>
                      <td className="py-3 pr-4 text-slate-500">{participant.team}</td>
                      <td className="max-w-md py-3 pr-4 text-slate-600">
                        {participant.prayer_request}
                      </td>
                      <td className="py-3 text-right">
                        <ActionForm action={deleteParticipantAction}><input type="hidden" name="revision" value={revision} />
                          <input type="hidden" name="id" value={participant.id} />
                          <button
                            type="submit"
                            className="text-xs text-slate-400 hover:text-red-600"
                          >
                            삭제
                          </button>
                        </ActionForm>
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
          <ActionForm action={resetAllAction} className="mt-4 flex flex-wrap gap-2"><input type="hidden" name="revision" value={revision} />
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
          </ActionForm>
        </section>
      </div>
    </main>
  );
}
