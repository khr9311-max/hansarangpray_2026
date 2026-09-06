import Link from 'next/link';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import { getMyGroup, getParticipant } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function MyGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [me, group] = await Promise.all([getParticipant(id), getMyGroup(id)]);

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
      <RealtimeRefresher
        channel={`me-${id}`}
        tables={['match_rounds', 'match_groups', 'match_members']}
      />

      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xs font-semibold tracking-wider text-brand-600">
            {me.name}님 · {me.team}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">내 기도짝</h1>
        </header>

        {!group ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mb-4 text-4xl">⏳</div>
            <p className="font-semibold text-slate-700">아직 매칭 전입니다</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              관리자가 매칭을 확정하면
              <br />이 화면이 자동으로 바뀝니다. 잠시만 기다려 주세요.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-center text-sm text-slate-400">
              {group.groupNumber}조 · {group.members.length}명
            </p>

            {group.members.map((member) => {
              const isMe = member.id === me.id;
              return (
                <div
                  key={member.id}
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
