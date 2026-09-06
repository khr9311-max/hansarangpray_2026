'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Participant, PrayerGroup } from '@/lib/types';

type Phase = 'idle' | 'ready' | 'drawing' | 'revealed';

/** 추첨 연출 길이. 너무 길면 현장이 지루해집니다. */
const DRAW_MS = 3200;
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

function makeChip(p: Pick<Participant, 'id' | 'name'>): Chip {
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

/** 조 수에 따라 카드 크기를 줄여 한 화면에 최대한 담습니다. */
function gridClass(groupCount: number) {
  if (groupCount <= 6) return 'grid-cols-2 lg:grid-cols-3 text-3xl';
  if (groupCount <= 12) return 'grid-cols-2 lg:grid-cols-4 text-2xl';
  if (groupCount <= 24) return 'grid-cols-3 lg:grid-cols-5 text-xl';
  if (groupCount <= 40) return 'grid-cols-4 lg:grid-cols-6 text-lg';
  return 'grid-cols-4 lg:grid-cols-8 text-base';
}

export default function DisplayStage({
  participants,
  round,
}: {
  participants: Participant[];
  round: { id: string; groups: PrayerGroup[] } | null;
}) {
  // 새로고침으로 다시 열었을 때 결과가 사라지면 안 되므로,
  // 이미 확정된 매칭이 있으면 결과 화면에서 시작합니다.
  const [phase, setPhase] = useState<Phase>(round ? 'revealed' : 'idle');
  const [chips, setChips] = useState<Chip[]>([]);
  const seenRoundId = useRef<string | null>(round?.id ?? null);
  const drawTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = useMemo(() => participants.slice(0, MAX_CHIPS), [participants]);
  const hiddenCount = participants.length - visible.length;
  const chipKey = visible.map((p) => p.id).join(',');

  // 명단이 바뀌면(=새로 접수되면) 이름표를 다시 만듭니다.
  useEffect(() => {
    setChips(visible.map(makeChip));
    // chipKey 로 명단 변화만 감지합니다. visible 은 매 렌더 새 배열입니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipKey]);

  // 관리자가 매칭을 새로 확정하면 추첨 대기 상태로 돌아갑니다.
  useEffect(() => {
    const id = round?.id ?? null;
    if (id === seenRoundId.current) return;
    seenRoundId.current = id;
    setPhase(id ? 'ready' : 'idle');
  }, [round?.id]);

  // 이름표 자리 바꾸기. 추첨 중에는 빠르게, 대기 중에는 느긋하게.
  useEffect(() => {
    if (phase === 'revealed') return;
    const period = phase === 'drawing' ? SHUFFLE_MS : WANDER_MS;
    const timer = setInterval(() => {
      setChips((prev) => prev.map((chip) => ({ ...chip, ...scatter() })));
    }, period);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    if (drawTimer.current) clearTimeout(drawTimer.current);
  }, []);

  const startDraw = useCallback(() => {
    if (!round || phase === 'drawing') return;
    setPhase('drawing');
    if (drawTimer.current) clearTimeout(drawTimer.current);
    drawTimer.current = setTimeout(() => setPhase('revealed'), DRAW_MS);
  }, [phase, round]);

  // 스페이스바로도 추첨을 돌릴 수 있게 합니다. 현장에서 마우스보다 편합니다.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      if (phase !== 'ready' && phase !== 'revealed') return;
      event.preventDefault();
      startDraw();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, startDraw]);

  if (phase === 'revealed' && round) {
    return (
      <>
        <div className={`grid gap-4 ${gridClass(round.groups.length)}`}>
          {round.groups.map((group, index) => (
            <div
              key={group.groupNumber}
              style={{ animation: `pop-in 420ms ease-out ${index * 55}ms both` }}
              className="rounded-2xl border border-white/10 bg-white/5 p-5"
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
                    <span className="ml-2 text-[0.65em] font-normal text-white/40">
                      {member.team}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={startDraw}
          className="fixed bottom-6 right-6 rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm text-white/50 transition hover:bg-white/10"
        >
          추첨 다시 보기 (Space)
        </button>
      </>
    );
  }

  const drawing = phase === 'drawing';

  return (
    <div className="flex min-h-[78dvh] flex-col">
      {/* 이름표가 떠다니는 통 */}
      <div
        data-shake={drawing ? '' : undefined}
        style={drawing ? { animation: 'shake 420ms ease-in-out infinite' } : undefined}
        className="relative flex-1 overflow-hidden rounded-[2.5rem] border-4 border-white/10 bg-gradient-to-b from-white/[0.07] to-transparent"
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

      {/* 통 아래 안내 · 추첨 버튼 */}
      <div className="mt-6 flex min-h-[4.5rem] items-center justify-center">
        {phase === 'drawing' ? (
          <p className="text-2xl font-semibold tracking-wide text-white/70">
            섞는 중…
          </p>
        ) : phase === 'ready' ? (
          <button
            type="button"
            onClick={startDraw}
            className="rounded-2xl bg-brand-600 px-12 py-5 text-3xl font-bold text-white shadow-xl transition hover:bg-brand-500 active:scale-[0.98]"
          >
            추첨 시작
            <span className="ml-3 text-lg font-normal text-white/60">Space</span>
          </button>
        ) : (
          <p className="text-xl text-white/30">
            {participants.length > 0
              ? `${participants.length}명 신청 · 관리자가 매칭을 확정하면 추첨이 열립니다`
              : 'QR 코드로 신청을 받는 중입니다'}
          </p>
        )}
      </div>
    </div>
  );
}
