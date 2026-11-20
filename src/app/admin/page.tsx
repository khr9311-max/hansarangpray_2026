import Link from 'next/link';
import ActionForm from '@/components/ActionForm';
import { getEventSnapshot, getRoundHistory } from '@/lib/event';
import { editToken } from '@/lib/participant-access';
import { prayerCheckToken } from '@/lib/prayer-access';
import { PRAYER_WEEKS } from '@/lib/prayer-weeks';
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
  restoreRoundAction,
  startMatchingDrawAction,
  unpublishAction,
} from './actions';

export const dynamic = 'force-dynamic';

const historyDateFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export default async function AdminPage() {
  if (!(await isAdmin())) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
        <LoginForm />
      </main>
    );
  }

  const [snapshot, history] = await Promise.all([
    getEventSnapshot(),
    getRoundHistory().catch(() => null),
  ]);
  const { participants, round, revision } = snapshot;
  const matchedIds = new Set(round?.groups.flatMap(group => group.members.map(member => member.id)));
  const pendingCount = participants.filter(p => !matchedIds.has(p.id)).length;
  const byTeam = countByTeam(participants);

  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-8">
      <RealtimeRefresher revision={revision} />

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

        {/* 추첨 실행과 추가 참여자 반영 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">추첨 진행</h2>
          <p className="mt-2 text-sm text-slate-600">{round ? `현재 ${round.groups.length}조 · 추가 반영 대기 ${pendingCount}명` : '조 인원과 방식을 고르고 추첨을 시작해 주세요.'}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ActionForm key={round?.id ?? 'initial'} action={startMatchingDrawAction} className="rounded-xl border border-brand-200 bg-brand-50 p-4">
              <input type="hidden" name="revision" value={revision} />
              <h3 className="mb-3 font-semibold text-slate-900">새 조로 추첨하기</h3>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-600">조 인원
                  <select name="target_size" defaultValue={round?.targetSize ?? 2} className="mt-1 w-full rounded-lg border bg-white p-2 text-base">{TARGET_SIZES.map(size => <option key={size} value={size}>{size}인 1조</option>)}</select>
                </label>
                <label className="text-xs text-slate-600">편성 방식
                  <select name="mode" defaultValue={round?.mode ?? 'team'} className="mt-1 w-full rounded-lg border bg-white p-2 text-base"><option value="team">팀 섞기</option><option value="random">완전 랜덤</option></select>
                </label>
              </div>
              {round && <label className="mb-3 flex items-start gap-2 text-sm text-slate-600"><input type="checkbox" name="confirm" value="재편성" required className="mt-1 shrink-0" />전체 참여자를 새 조로 편성합니다. 현재 조는 기록에 남습니다.</label>}
              <button type="submit" disabled={!participants.length} className="w-full rounded-xl bg-brand-600 px-4 py-3 text-lg font-bold text-white disabled:opacity-40">추첨 시작</button>
              <p className="mt-3 text-sm text-slate-600">새 조 편성을 저장하고 열려 있는 결과 화면에서 추첨을 시작합니다. 참가자 명단과 기도제목은 유지됩니다.</p>
              {!participants.length && <p className="mt-2 text-xs text-slate-500">참가자가 접수되면 시작할 수 있습니다.</p>}
            </ActionForm>
            <ActionForm action={applyParticipantsAction} className="rounded-xl border border-slate-200 bg-white p-4">
              <input type="hidden" name="revision" value={revision} />
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">늦게 온 참여자 합류</h3>
                {round && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">대기 {pendingCount}명</span>}
              </div>
              <button type="submit" disabled={!round} className="w-full rounded-xl border border-brand-600 bg-brand-50 px-4 py-3 font-bold text-brand-700 disabled:opacity-40">추가 참여자 반영</button>
              <p className="mt-3 text-sm text-slate-600">미배정 참여자만 인원이 적은 기존 조에 추가합니다. 기존 조원·조 번호·공개 상태를 유지하고 새 추첨 없이 결과에 반영합니다.</p>
              {!round && <p className="mt-2 text-xs text-slate-500">첫 조가 만들어지면 사용할 수 있습니다.</p>}
            </ActionForm>
          </div>
          {round && <ActionForm action={drawAction} className="mt-4 border-t border-slate-100 pt-4">
            <input type="hidden" name="revision" value={revision} />
            <button type="submit" className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700">현재 조 다시 공개</button>
            <p className="mt-2 text-xs text-slate-500">현재 조로 추첨 연출만 다시 보여 줍니다. 추가 신청자는 위의 ‘추가 참여자 반영’을 먼저 눌러 주세요.</p>
          </ActionForm>}
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
            {round ? (
              <>
                <p className="text-sm text-slate-600">
                  현재 조 편성 · <b>{round.groups.length}조</b> ·{' '}
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

        {/* 이전 조 편성으로 돌아가기 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-500">조 편성 기록</h2>
            <p className="text-xs text-slate-400">최근 순 · 한국 시간</p>
          </div>
          <p className="mt-2 text-sm text-slate-600">이전 조를 선택하면 저장된 조 편성으로 돌아가 결과 화면에 다시 공개합니다. 이후 접수되어 그 조에 없는 참여자는 추가 반영 대기로 남습니다.</p>
          {history === null ? (
            <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">조 편성 기록을 불러오지 못했습니다. 화면을 새로고침해 다시 확인해 주세요.</p>
          ) : history.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">아직 저장된 조 편성 기록이 없습니다.</p>
          ) : (
            <ol className="mt-4 divide-y divide-slate-100">
              {history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <time dateTime={entry.createdAt} className="text-sm font-semibold text-slate-800">{historyDateFormat.format(new Date(entry.createdAt))}</time>
                      {entry.isActive && <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">현재 조</span>}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">{MATCH_MODE_LABEL[entry.mode]} · {entry.targetSize}인 기준 · {entry.groupCount}조 · {entry.memberCount}명</p>
                  </div>
                  {entry.isActive ? (
                    <span className="text-xs text-slate-400">현재 사용 중</span>
                  ) : (
                    <ActionForm action={restoreRoundAction} className="w-full sm:w-auto">
                      <input type="hidden" name="revision" value={revision} />
                      <input type="hidden" name="round_id" value={entry.id} />
                      <button type="submit" className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 sm:w-auto">이 조로 돌아가기</button>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* 현재 조별 기도 체크 현황 */}
        {round && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="mb-4 space-y-2">
              <h2 className="text-sm font-semibold text-slate-500">조별 기도 현황</h2>
              <p className="text-xs leading-relaxed text-slate-500">각 조원이 우리 조를 위해 기도했다고 표시한 주차입니다.</p>
              <p className="text-xs text-slate-500"><span aria-hidden="true" className="font-semibold text-brand-600">✓</span> 기도했어요 <span aria-hidden="true" className="mx-2 text-slate-300">·</span><span aria-hidden="true">—</span> 미체크</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {round.groups.map((group) => (
                <div
                  key={group.groupNumber}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <h3 className="mb-3 flex items-baseline justify-between gap-2 text-xs font-bold text-brand-600">
                    <span>{group.groupNumber}조</span>
                    <span className="font-normal text-slate-400">{group.members.length}명</span>
                  </h3>
                  <table className="w-full table-fixed text-xs">
                    <caption className="sr-only">{group.groupNumber}조 조원별 주차별 기도 체크</caption>
                    <colgroup>
                      <col />
                      {PRAYER_WEEKS.map(week => <col key={week} className="w-9" />)}
                    </colgroup>
                    <thead className="border-b border-slate-100 text-slate-400">
                      <tr>
                        <th scope="col" className="pb-2 pr-2 text-left font-medium">이름</th>
                        {PRAYER_WEEKS.map(week => <th key={week} scope="col" className="pb-2 text-center font-medium">{week}주</th>)}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {group.members.map(member => (
                        <tr key={member.id}>
                          <th scope="row" className="break-words py-2.5 pr-2 text-left font-medium text-slate-700">
                            {member.name}
                            <span className="mt-0.5 block text-[10px] font-normal text-slate-400">{member.team}</span>
                          </th>
                          {PRAYER_WEEKS.map((week, index) => {
                            const checked = member.prayerChecks?.[index] === true;
                            return <td key={week} className="py-2.5 text-center">
                              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full font-semibold ${checked ? 'bg-brand-50 text-brand-700' : 'text-slate-300'}`}>
                                <span aria-hidden="true">{checked ? '✓' : '—'}</span>
                                <span className="sr-only">{week}주차 {checked ? '우리 조를 위해 기도했어요' : '미체크'}</span>
                              </span>
                            </td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                        <Link prefetch={false} href={`/me/${participant.id}/check-access?token=${prayerCheckToken(participant.id)}`} className="mt-1 block text-xs text-slate-500 underline">본인용 기도 체크 링크</Link>
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
