'use client';

import { useEffect, useMemo, useState } from 'react';
import QrCode from '@/components/QrCode';
import type { QrMatrix } from '@/lib/qr';
import type { DisplayMember, DisplayRound } from '@/lib/display';
import { DRAW_MS, getDisplayPhase, type DisplayPhase } from '@/lib/display';

// 화면에 실제로 쓰는 필드만 받습니다. 서버 컴포넌트가 이보다 많은 필드를
// 넘기면 그 값 그대로 페이지 소스(RSC 페이로드)에 실리므로, 여기서
// 타입으로도 이름 외 정보가 섞여 들어오지 않게 막아 둡니다.
/** 추첨 중 이름표가 다시 흩어지는 주기 */
const SHUFFLE_MS = 170;
/** 대기 중 이름표가 천천히 자리를 바꾸는 주기 */
const WANDER_MS = 4200;
/** 통에 한 번에 띄우는 이름표 상한. 넘으면 "외 N명"으로 접습니다. */
const MAX_CHIPS = 120;

type Chip = {
  id: string;
  name: string;
  left: number;
  top: number;
  dx: string;
  dy: string;
  dur: string;
  delay: string;
  r0: string;
  r1: string;
};

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/** 통 안 임의의 자리. 가장자리는 살짝 비워 이름표가 잘리지 않게 합니다. */
function scatter() {
  return { left: rand(3, 84), top: rand(5, 82) };
}

function makeChip(p: DisplayMember): Chip {
  return {
    id: p.id,
    name: p.name,
    ...scatter(),
    dx: `${rand(-36, 36).toFixed(0)}px`,
    dy: `${rand(-26, 26).toFixed(0)}px`,
    dur: `${rand(6, 13).toFixed(1)}s`,
    delay: `${(-rand(0, 10)).toFixed(1)}s`,
    r0: `${rand(-5, 5).toFixed(1)}deg`,
    r1: `${rand(-9, 9).toFixed(1)}deg`,
  };
}

/**
 * 신청 QR. 늦게 온 사람도 언제든 스캔할 수 있게 항상 띄워 둡니다.
 * 결과 발표 중에는 조 카드가 주인공이므로 작게 줄입니다.
 */
function SignupQr({ matrix, compact }: { matrix: QrMatrix; compact: boolean }) {
  return (
    <div className={`rounded-2xl bg-white shadow-2xl ${compact ? 'p-2.5' : 'p-5'}`}>
      <QrCode
        matrix={matrix}
        className={`block ${compact ? 'h-24 w-24' : 'h-48 w-48 xl:h-56 xl:w-56'}`}
      />
      <p
        className={`mt-2 text-center font-bold leading-tight text-slate-900 ${
          compact ? 'text-[0.6rem]' : 'text-base'
        }`}
      >
        QR 스캔하고
        <br />
        기도제목 신청하기
      </p>
    </div>
  );
}

/** 조 수에 따라 카드 크기를 줄여 한 화면에 최대한 담습니다. */
function gridClass(groupCount: number) {
  if (groupCount <= 6) return 'grid-cols-2 lg:grid-cols-3 text-xl sm:text-3xl';
  if (groupCount <= 12) return 'grid-cols-2 lg:grid-cols-4 text-2xl';
  if (groupCount <= 24) return 'grid-cols-2 lg:grid-cols-5 text-xl';
  if (groupCount <= 40) return 'grid-cols-2 lg:grid-cols-6 text-lg';
  return 'grid-cols-2 lg:grid-cols-8 text-base';
}

type StageProps = {
  revision: number; drawStartedAt: string | null; serverTime: string;
  participants: DisplayMember[];
  round: DisplayRound | null;
  pendingCount: number;
  qr: QrMatrix;
};

export default function DisplayStage(props: StageProps) {
  const [current, setCurrent] = useState(props);
  // Never show an older refresh response after a newer event revision.
  if (props.revision > current.revision || (props.revision === current.revision && props.serverTime > current.serverTime)) setCurrent(props);
  return <Stage key={`${current.round?.id}:${current.drawStartedAt}`} {...current} />;
}

function Stage({ participants, round, pendingCount, qr, drawStartedAt, serverTime }: StageProps) {
  const [phase, setPhase] = useState<DisplayPhase>(() => getDisplayPhase(!!round, drawStartedAt, serverTime));
  const [chips, setChips] = useState<Chip[]>([]);
  const roundId = round?.id;

  const visible = useMemo(() => participants.slice(0, MAX_CHIPS), [participants]);
  const hiddenCount = participants.length - visible.length;
  const chipKey = JSON.stringify(visible.map((p) => [p.id, p.name]));

  // 명단이 바뀌면(=새로 접수되면) 이름표를 다시 만듭니다.
  useEffect(() => {
    setChips(visible.map(makeChip));
    // chipKey 로 명단 변화만 감지합니다. visible 은 매 렌더 새 배열입니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipKey]);

  // Shared database timestamp: a phone command starts the same reveal on every display.
  useEffect(() => {
    setPhase(getDisplayPhase(Boolean(roundId), drawStartedAt, serverTime));
    if (!roundId || !drawStartedAt) return;
    const untilStart = Date.parse(drawStartedAt) - Date.parse(serverTime);
    const remaining = DRAW_MS + untilStart;
    if (remaining <= 0) return;
    const startTimer = untilStart > 0 ? setTimeout(() => setPhase('drawing'), untilStart) : undefined;
    const revealTimer = setTimeout(() => setPhase('revealed'), remaining);
    return () => { clearTimeout(startTimer); clearTimeout(revealTimer); };
  }, [roundId, drawStartedAt, serverTime]);

  // 이름표 자리 바꾸기. 추첨 중에는 빠르게, 대기 중에는 느긋하게.
  useEffect(() => {
    if (phase === 'revealed') return;
    const period = phase === 'drawing' ? SHUFFLE_MS : WANDER_MS;
    const timer = setInterval(() => {
      setChips((prev) => prev.map((chip) => ({ ...chip, ...scatter() })));
    }, period);
    return () => clearInterval(timer);
  }, [phase]);

  const drawNotice = pendingCount > 0 && (
    <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-300/10 px-5 py-3 text-center text-amber-100">
      <p role="status">추가 신청 {pendingCount}명이 조 배정을 기다리고 있습니다.</p>
    </div>
  );

  if (phase === 'revealed' && round) {
    return (
      <>
        {drawNotice}
        <div className={`grid gap-4 pb-44 ${gridClass(round.groups.length)}`}>
          {round.groups.map((group, index) => (
            <div
              key={group.groupNumber}
              style={{ animation: `pop-in 420ms ease-out ${index * 55}ms both` }}
              className="min-w-0 break-words rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-5"
            >
              <div className="mb-3 flex items-baseline gap-2">
                <span className="text-[0.7em] font-semibold tracking-widest text-brand-500">
                  {group.groupNumber}조
                </span>
                <span className="text-[0.6em] text-white/40">
                  {group.members.length}명
                </span>
              </div>

              <ul className="space-y-1.5">
                {group.members.map((member) => (
                  <li key={member.id} className="font-bold leading-tight text-white">
                    {member.name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="fixed bottom-6 left-6 z-40">
          <SignupQr matrix={qr} compact />
        </div>
      </>
    );
  }

  const drawing = phase === 'drawing';

  return (
    <div className="flex min-h-[28rem] flex-1 flex-col">
      {drawNotice}
      <div className="flex min-h-[22rem] flex-1 flex-col gap-6 sm:flex-row">
      {/* 이름표가 떠다니는 통 */}
      <div
        data-shake={drawing ? '' : undefined}
        style={drawing ? { animation: 'shake 420ms ease-in-out infinite' } : undefined}
        className="relative min-h-[22rem] min-w-0 flex-1 overflow-hidden rounded-[2.5rem] border-4 border-white/10 bg-gradient-to-b from-white/[0.07] to-transparent"
      >
        {/* 유리통 느낌의 하이라이트 */}
        <div className="pointer-events-none absolute inset-x-8 top-0 h-24 rounded-b-full bg-white/[0.06] blur-2xl" />

        {chips.map((chip) => (
          <div
            key={chip.id}
            style={{
              left: `${chip.left}%`,
              top: `${chip.top}%`,
              transition: `left ${drawing ? 160 : 3800}ms ${drawing ? 'linear' : 'ease-in-out'}, top ${drawing ? 160 : 3800}ms ${drawing ? 'linear' : 'ease-in-out'}`,
            }}
            className="absolute"
          >
            <div
              data-drift=""
              style={
                {
                  '--dx': chip.dx,
                  '--dy': chip.dy,
                  '--r0': chip.r0,
                  '--r1': chip.r1,
                  animation: `drift ${drawing ? '0.9s' : chip.dur} ease-in-out ${chip.delay} infinite`,
                } as React.CSSProperties
              }
            >
              <span
                className={`inline-block whitespace-nowrap rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-2xl font-bold text-white shadow-lg transition-[filter] duration-300 ${
                  drawing ? 'blur-[1.5px]' : ''
                }`}
              >
                {chip.name}
              </span>
            </div>
          </div>
        ))}

        {/* 이름표는 마운트 후에 자리를 잡으므로(서버/클라이언트 난수 불일치 방지)
            빈 화면 안내는 실제 신청자 수로 판단합니다. */}
        {participants.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-6 text-7xl">🙏</div>
            <p className="text-3xl font-bold text-white/80">신청을 받고 있습니다</p>
            <p className="mt-3 text-xl text-white/40">
              QR 코드를 스캔해 이름을 남겨 주세요.
            </p>
          </div>
        )}

        {hiddenCount > 0 && (
          <p className="absolute bottom-5 right-7 text-lg text-white/30">
            외 {hiddenCount}명
          </p>
        )}
      </div>

        {/* 신청 QR. 통 옆에 두어 떠다니는 이름표를 가리지 않게 합니다. */}
        <aside className="flex shrink-0 flex-col items-center justify-center">
          <SignupQr matrix={qr} compact={false} />
          <p className="mt-3 max-w-[14rem] break-all text-center text-xs text-white/25">
            {qr.text}
          </p>
        </aside>
      </div>

      {/* 추첨은 관리자 화면에서 시작하며 출력 화면은 상태만 표시합니다. */}
      <div className="mt-6 flex min-h-[4.5rem] items-center justify-center">
        {phase === 'drawing' ? (
          <p className="text-2xl font-semibold tracking-wide text-white/70">
            섞는 중…
          </p>
        ) : phase === 'scheduled' ? (
          <p role="status" className="text-2xl font-semibold tracking-wide text-white/70">잠시 후 모든 화면에서 추첨을 시작합니다…</p>
        ) : (
          <p className="text-xl text-white/30">
            {participants.length > 0
              ? `${participants.length}명 신청 · 관리자 화면에서 추첨을 시작하면 자동으로 공개됩니다`
              : 'QR 코드로 신청을 받는 중입니다'}
          </p>
        )}
      </div>
    </div>
  );
}
