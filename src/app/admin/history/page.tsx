import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAdmin } from '@/lib/auth';
import { getArchiveEntry, getArchiveHistory, getRoundEntry, getRoundHistory, type ArchiveEntry, type ArchiveSummary } from '@/lib/event';
import { getLegacyRoundEntry, getLegacyRoundHistory, hasLegacyRoundSource } from '@/lib/legacy-round-history';
import { MATCH_MODE_LABEL, type Participant } from '@/lib/types';

export const dynamic = 'force-dynamic';

const dateFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function archiveLabel(kind: ArchiveSummary['kind']) {
  return kind === 'reset' ? '현재 기록 숨기기' : '참가자 숨기기';
}

function archivedRoundLabel(round: ArchiveEntry['rounds'][number]) {
  const date = dateFormat.format(new Date(round.createdAt));
  const label = `${date} · ${MATCH_MODE_LABEL[round.mode]} · ${round.targetSize}인 기준`;
  return round.isActive ? `${label} · 숨기기 직전 편성` : label;
}

function ParticipantTable({ rows }: { rows: { participant: Participant; groupNumber?: number }[] }) {
  return (
    <table className="mt-5 w-full table-fixed text-left text-sm">
      <caption className="sr-only">회차별 참가자 명단</caption>
      <colgroup>
        <col className="w-[18%]" />
        <col className="w-[22%]" />
        <col className="w-[15%]" />
        <col />
      </colgroup>
      <thead className="border-b border-slate-200 text-xs text-slate-500">
        <tr>
          <th scope="col" className="pb-2 pr-2 font-medium">이름</th>
          <th scope="col" className="pb-2 pr-2 font-medium">팀</th>
          <th scope="col" className="pb-2 pr-2 font-medium">조</th>
          <th scope="col" className="pb-2 font-medium">기도제목</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 align-top text-slate-600">
        {rows.map(({ participant, groupNumber }) => (
          <tr key={participant.id}>
            <th scope="row" className="py-3 pr-2 font-medium text-slate-900 [overflow-wrap:anywhere]">{participant.name}</th>
            <td className="py-3 pr-2 [overflow-wrap:anywhere]">{participant.team}</td>
            <td className="py-3 pr-2 [overflow-wrap:anywhere]">{groupNumber === undefined ? '미배정' : `${groupNumber}조`}</td>
            <td className="whitespace-pre-wrap py-3 [overflow-wrap:anywhere]">{participant.prayer_request}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArchiveDetails({ entry, roundId }: { entry: ArchiveEntry; roundId?: string | string[] }) {
  const rounds = [...entry.rounds].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const round = rounds.find(item => item.id === roundId) ?? rounds.find(item => item.isActive) ?? rounds[0];
  const groupByParticipant = new Map(round?.assignments.map(item => [item.participantId, item.groupNumber]));
  const participants = [...entry.participants].sort((a, b) => {
    const aGroup = groupByParticipant.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bGroup = groupByParticipant.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aGroup - bGroup || a.name.localeCompare(b.name, 'ko');
  });

  return (
    <section aria-labelledby="archive-title" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="archive-title" className="text-lg font-semibold text-slate-900">{archiveLabel(entry.kind)} · {entry.participantCount}명</h2>
        <time dateTime={entry.archivedAt} className="text-xs text-slate-500">{dateFormat.format(new Date(entry.archivedAt))}</time>
      </div>
      {rounds.length > 1 ? (
        <form method="get" action="/admin/history" className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="entry" value={entry.id} />
          <label className="min-w-0 max-w-full text-xs font-medium text-slate-600">
            조 편성 회차
            <select key={round.id} name="round" defaultValue={round.id} className="mt-1 block max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
              {rounds.map(item => <option key={item.id} value={item.id}>{archivedRoundLabel(item)}</option>)}
            </select>
          </label>
          <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">회차 보기</button>
        </form>
      ) : (
        <p className="mt-3 text-sm text-slate-600">{round ? archivedRoundLabel(round) : '숨길 당시 조 배정이 없었습니다.'}</p>
      )}
      <ParticipantTable rows={participants.map(participant => ({ participant, groupNumber: groupByParticipant.get(participant.id) }))} />
    </section>
  );
}

function RoundDetails({ round, fromLegacySheet }: {
  round: NonNullable<Awaited<ReturnType<typeof getRoundEntry>>>;
  fromLegacySheet: boolean;
}) {
  const rows = round.groups.flatMap(group => group.members.map(participant => ({ participant, groupNumber: group.groupNumber })));
  return (
    <section aria-labelledby="round-title" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="round-title" className="text-lg font-semibold text-slate-900">{!fromLegacySheet && round.isActive ? '현재 조 편성' : '이전 조 편성'}</h2>
        <time dateTime={round.createdAt} className="text-xs text-slate-500">{dateFormat.format(new Date(round.createdAt))}</time>
      </div>
      <p className="mt-3 text-sm text-slate-600">{MATCH_MODE_LABEL[round.mode]} · {round.targetSize}인 기준 · {round.groups.length}조 · {rows.length}명</p>
      <p className="mt-1 text-xs text-slate-500">{fromLegacySheet ? '이전 시트에 저장된 참가 정보입니다.' : '이름, 팀, 기도제목은 현재 저장된 참가 정보를 표시합니다.'}</p>
      <ParticipantTable rows={rows} />
    </section>
  );
}

export default async function AdminHistoryPage({ searchParams }: {
  searchParams: Promise<{ view?: string | string[]; entry?: string | string[]; round?: string | string[] }>;
}) {
  if (!(await isAdmin())) redirect('/admin');

  const query = await searchParams;
  const [rounds, archives] = await Promise.all([
    getRoundHistory().catch(() => null),
    getArchiveHistory().catch(() => null),
  ]);
  const hasLegacy = hasLegacyRoundSource();
  let view: 'rounds' | 'archived' | 'legacy' = 'rounds';
  if (query.view === 'archived' || query.entry !== undefined) {
    view = 'archived';
  } else if (query.view === 'legacy' && hasLegacy) {
    view = 'legacy';
  } else if (query.view === undefined && rounds?.length === 0) {
    if (archives?.length) view = 'archived';
    else if (hasLegacy) view = 'legacy';
  }
  const showArchives = view === 'archived';
  const showLegacy = view === 'legacy';
  const displayRounds = showLegacy ? await getLegacyRoundHistory().catch(() => null) : rounds;
  const records = showArchives
    ? archives?.map(entry => ({
      id: entry.id, date: entry.archivedAt, label: `${archiveLabel(entry.kind)} · ${entry.participantCount}명`,
      query: { entry: entry.id },
    }))
    : displayRounds?.map(round => ({
      id: round.id, date: round.createdAt, label: `${!showLegacy && round.isActive ? '현재 조' : '이전 조'} · ${round.groupCount}조 · ${round.memberCount}명`,
      query: { view, round: round.id },
    }));
  const requestedId = showArchives ? query.entry : query.round;
  const selected = requestedId === undefined ? records?.[0] : records?.find(record => record.id === requestedId);
  const loadDetails = showArchives ? getArchiveEntry : showLegacy ? getLegacyRoundEntry : getRoundEntry;
  const details = selected ? await loadDetails(selected.id).catch(() => undefined) : null;
  const views = [
    { key: 'rounds', label: '조 편성 기록' },
    { key: 'archived', label: '숨긴 기록' },
    ...(hasLegacy ? [{ key: 'legacy', label: '이전 시트 기록' }] : []),
  ];
  const emptyMessage = {
    rounds: '현재 저장소에 저장된 조 편성이 없습니다.',
    archived: '아직 숨긴 기록이 없습니다.',
    legacy: '이전 시트에 저장된 조 편성이 없습니다.',
  }[view];

  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-8">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">이력 관리</h1>
          </div>
          <Link href="/admin" prefetch={false} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
            관리자 화면으로
          </Link>
        </header>

        <nav aria-label="이력 종류" className="flex flex-wrap gap-2">
          {views.map(item => (
            <Link
              key={item.key}
              href={{ pathname: '/admin/history', query: { view: item.key } }}
              prefetch={false}
              aria-current={view === item.key ? 'page' : undefined}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 aria-[current=page]:border-brand-200 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {records === undefined ? (
          <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">이력을 불러오지 못했습니다. 화면을 새로고침해 다시 확인해 주세요.</p>
        ) : records.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            {emptyMessage}
          </p>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <nav aria-label={showArchives ? '숨긴 기록 목록' : '조 편성 회차 목록'} className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">최근 순 · 한국 시간</p>
              <ol className="mt-2 max-h-60 space-y-1 overflow-y-auto">
                {records.map(record => (
                  <li key={record.id}>
                    <Link
                      href={{ pathname: '/admin/history', query: record.query }}
                      prefetch={false}
                      aria-current={record.id === selected?.id ? 'page' : undefined}
                      className="block rounded-lg px-2.5 py-2 hover:bg-slate-50 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
                    >
                      <span className="block text-sm font-medium">{record.label}</span>
                      <time dateTime={record.date} className="mt-1 block text-xs text-slate-500">{dateFormat.format(new Date(record.date))}</time>
                    </Link>
                  </li>
                ))}
              </ol>
            </nav>
            {details === undefined ? (
              <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">선택한 이력을 불러오지 못했습니다. 화면을 새로고침해 다시 확인해 주세요.</p>
            ) : details === null ? (
              <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">선택한 이력을 찾을 수 없습니다. 목록에서 기록을 선택해 주세요.</p>
            ) : 'participants' in details ? (
              <ArchiveDetails entry={details} roundId={query.round} />
            ) : (
              <RoundDetails round={details} fromLegacySheet={showLegacy} />
            )}
          </div>
        )}
      </div>
    </main>
  );
}
