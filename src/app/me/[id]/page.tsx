import Link from 'next/link';
import PrayerWeekChecks from '@/components/PrayerWeekChecks';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import { getMyGroup, getParticipant } from '@/lib/queries';
import { getEventSnapshot } from '@/lib/event';
import { canCheckPrayer } from '@/lib/prayer-access';
import { PRAYER_WEEKS } from '@/lib/prayer-weeks';

export const dynamic = 'force-dynamic';
const EMPTY_CHECKS = [false, false, false, false] as const;

export default async function MyGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [me, group, snapshot, canCheck] = await Promise.all([
    getParticipant(id), getMyGroup(id), getEventSnapshot(), canCheckPrayer(id).catch(() => false),
  ]);

  if (!me) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-slate-500">링크를 확인할 수 없습니다.</p>
          <Link href="/" className="mt-4 inline-block text-sm text-brand-600 underline">
            처음으로
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-10">
      {/* 매칭 전이면 관리자가 확정하는 순간 자동으로 다시 그려집니다. */}
      <RealtimeRefresher revision={snapshot.revision} />

      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xs font-semibold tracking-wider text-brand-600">
            {me.name}님 · {me.team}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">내 기도짝</h1>
          <Link href={`/edit/${id}`} className="mt-3 inline-block text-sm text-brand-600 underline">내 신청 정보 수정하기</Link>
        </header>

        {!group ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mb-4 text-4xl">⏳</div>
            <p className="font-semibold text-slate-700">{snapshot.round ? '추가 참여자 반영 대기 중입니다' : '아직 매칭 전입니다'}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              {snapshot.round ? '관리자가 추가 참여자를 반영하면' : '관리자가 매칭을 확정하면'}
              <br />이 화면이 자동으로 바뀝니다. 잠시만 기다려 주세요.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-center text-sm text-slate-400">
              {group.groupNumber}조 · {group.members.length}명
            </p>
            <p className="rounded-xl bg-brand-50 px-4 py-3 text-sm leading-relaxed text-brand-700">
              우리 조를 위해 기도한 주차에 체크해 주세요. 같은 조원과 관리자가 체크 상태를 볼 수 있어요.
            </p>

            {group.members.map((member, memberIndex) => {
              const isMe = member.id === me.id;
              return (
                <div
                  key={isMe ? 'self' : `peer-${memberIndex}`}
                  className={`rounded-2xl border p-5 shadow-sm ${
                    isMe
                      ? 'border-slate-200 bg-slate-50'
                      : 'border-brand-100 bg-white'
                  }`}
                >
                  <p className="font-bold text-slate-900">
                    {member.name}
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {member.team}
                      {isMe && ' · 나'}
                    </span>
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
                    {member.prayer_request}
                  </p>
                  {isMe && canCheck && snapshot.round ? (
                    <PrayerWeekChecks key={snapshot.round.id} id={me.id} roundId={snapshot.round.id} checks={member.prayerChecks ?? EMPTY_CHECKS} />
                  ) : (
                    <div className="mt-4 border-t border-slate-200 pt-4">
                      <p className="text-sm font-semibold text-slate-700">우리 조를 위한 기도 기록</p>
                      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={`${member.name}님의 주차별 기도 체크`}>
                        {PRAYER_WEEKS.map((week, index) => {
                          const checked = (member.prayerChecks ?? EMPTY_CHECKS)[index];
                          return <li key={week} className={`rounded-xl border px-3 py-3 text-xs ${checked ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                            <span className="block font-semibold">{week}주차</span>
                            <span className="mt-1 block"><span aria-hidden="true" className="mr-1">{checked ? '✓' : '○'}</span>{checked ? '기도했어요' : '미체크'}</span>
                          </li>;
                        })}
                      </ul>
                      {isMe && !canCheck && <p className="mt-3 text-xs leading-relaxed text-slate-500">신청한 기기에서 열거나 운영자에게 본인용 기도 체크 링크를 요청해 주세요.</p>}
                    </div>
                  )}
                </div>
              );
            })}

            <p className="pt-2 text-center text-xs text-slate-400">
              이 페이지는 나와 기도짝에게만 공유되는 개인 링크입니다.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
