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
  applyParticipantsAction,
  drawAction,
  deleteParticipantAction,
  logoutAction,
  resetAllAction,
  runMatchingAction,
  unpublishAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  if (!(await isAdmin())) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
        <LoginForm />
      </main>
    );
  }

  const { participants, round, revision } = await getEventSnapshot();
  const matchedIds = new Set(round?.groups.flatMap(group => group.members.map(member => member.id)));
  const pendingCount = participants.filter(p => !matchedIds.has(p.id)).length;
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
          <h2 className="text-sm font-semibold text-slate-500">조 편성 관리</h2>
          <p className="mt-2 text-sm text-slate-600">{round ? `현재 ${round.groups.length}조 · 추가 반영 대기 ${pendingCount}명` : '아직 편성된 조가 없습니다. 먼저 조를 편성해 주세요.'}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ActionForm action={applyParticipantsAction} className="rounded-xl border border-brand-100 bg-brand-50 p-4">
              <input type="hidden" name="revision" value={revision} />
              <button type="submit" disabled={!round} className="w-full rounded-xl bg-brand-600 px-4 py-3 font-bold text-white disabled:opacity-40">추가 참여자 반영</button>
              <p className="mt-3 text-sm text-slate-600">미배정 참여자만 인원이 적은 기존 조에 추가합니다. 기존 조원·조 번호·공개 상태는 유지됩니다.</p>
            </ActionForm>
            <ActionForm key={round?.id ?? 'initial'} action={runMatchingAction} className="rounded-xl border border-slate-200 p-4">
              <input type="hidden" name="revision" value={revision} />
              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-600">조 인원
                  <select name="target_size" defaultValue={round?.targetSize ?? 2} className="mt-1 w-full rounded-lg border bg-white p-2 text-base">{TARGET_SIZES.map(size => <option key={size} value={size}>{size}인 1조</option>)}</select>
                </label>
                <label className="text-xs text-slate-600">편성 방식
                  <select name="mode" defaultValue={round?.mode ?? 'team'} className="mt-1 w-full rounded-lg border bg-white p-2 text-base"><option value="team">팀 섞기</option><option value="random">완전 랜덤</option></select>
                </label>
              </div>
              {round && <label className="mb-3 flex items-start gap-2 text-sm text-slate-600"><input type="checkbox" name="confirm" value="재편성" required className="mt-1 shrink-0" />기존 조 편성을 초기화하고 전체 참여자를 새로 편성합니다.</label>}
              <button type="submit" disabled={!participants.length} className="w-full rounded-xl bg-slate-800 px-4 py-3 font-bold text-white disabled:opacity-40">초기화 후 조 편성</button>
              <p className="mt-3 text-sm text-slate-600">참가자 명단과 기도제목은 유지하고 조 편성만 새로 만듭니다.</p>
            </ActionForm>
          </div>
          {round && <ActionForm action={drawAction} className="mt-4 border-t border-slate-100 pt-4">
            <input type="hidden" name="revision" value={revision} />
            <button type="submit" className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700">모든 화면에서 추첨·결과 공개</button>
            <p className="mt-2 text-xs text-slate-500">저장된 조 편성을 공개합니다. 추가 신청자는 위의 ‘추가 참여자 반영’을 먼저 눌러 주세요.</p>
          </ActionForm>}
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
                        <Link prefetch={false} href={`/edit/${participant.id}`} className="mt-1 block text-xs text-brand-600 underline">정보 수정</Link>
                        <Link prefetch={false} href={`/edit/${participant.id}?token=${editToken(participant.id)}`} className="mt-1 block text-xs text-slate-500 underline">본인 전달용 수정 링크</Link>
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
