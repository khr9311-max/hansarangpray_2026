'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { submitParticipant, type SubmitState } from '@/app/actions';
import { TEAMS, type Participant } from '@/lib/types';

const initialState: SubmitState = { status: 'idle', message: '' };

/**
 * 접수에 성공하면 이 기기에 참가자 id를 남겨 둡니다.
 * 이게 없으면 새로고침 한 번에 "내 기도짝" 링크가 사라지고 빈 폼이 다시 떠서,
 * 같은 사람이 모르고 두 번 신청하게 됩니다. (DB에 이름 중복 제약이 없습니다)
 */
const STORAGE_KEY = 'jjak_participant';
const SUBMISSION_KEY = 'jjak_submission_request';
/** 다음 행사 때 지난 행사의 죽은 링크가 남지 않도록 하루가 지나기 전에 잊습니다. */
const REMEMBER_MS = 12 * 60 * 60 * 1000;

type Remembered = { id: string; at: number };

/** One private submission key per browser, shared across tabs and preserved on retry. */
export async function getSubmissionRequest(reset = false): Promise<string> {
  const readOrCreate = () => {
    if (!reset) {
      try {
        const saved = JSON.parse(localStorage.getItem(SUBMISSION_KEY) ?? 'null') as Partial<Remembered> | null;
        if (saved && typeof saved.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved.id)
          && typeof saved.at === 'number' && Date.now() - saved.at < REMEMBER_MS) return saved.id;
      } catch { /* Storage may be unavailable; this tab still retains its request key. */ }
    }
    const id = crypto.randomUUID();
    try { localStorage.setItem(SUBMISSION_KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* See above. */ }
    return id;
  };
  // Serializing the first read/create also covers two tabs opened at the same time.
  if (navigator.locks) {
    try { return await navigator.locks.request(SUBMISSION_KEY, readOrCreate); } catch { /* Fall back when locks are unavailable. */ }
  }
  return readOrCreate();
}

function readRemembered(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<Remembered>;
    if (typeof parsed?.id !== 'string' || typeof parsed?.at !== 'number') return null;

    if (Date.now() - parsed.at > REMEMBER_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.id;
  } catch {
    // 시크릿 모드 등으로 저장소를 못 읽어도 화면은 정상 동작해야 합니다.
    return null;
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // 저장이 막혀도 접수 자체는 이미 끝났으므로 그냥 넘어갑니다.
  }
}

function forget() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 위와 같음
  }
}

function SubmitButton({ shareInGroup, editing }: { shareInGroup: boolean; editing?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-xl bg-brand-600 px-4 py-4 text-lg font-semibold text-white transition active:scale-[0.99] disabled:opacity-50"
    >
      {pending ? '저장 중…' : editing ? '수정 내용 저장하기' : shareInGroup ? '참가 신청하기' : '기도제목 보내기'}
    </button>
  );
}

/** 폰을 빌려주는 경우가 있어, 어느 화면에서든 새로 신청할 길을 열어 둡니다. */
function StartOverButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-5 text-xs text-slate-400 underline underline-offset-2"
    >
      다른 분이 신청하시나요? 새로 신청하기
    </button>
  );
}

function MyPairLink({ id, showEdit = true }: { id: string; showEdit?: boolean }) {
  return (
    <>
    {showEdit && <Link href={`/edit/${id}`} className="mt-5 inline-block w-full rounded-xl border border-brand-600 px-4 py-3 text-sm font-semibold text-brand-600">내 신청 정보 수정하기</Link>}
    <Link
      href={`/me/${id}`}
      className="mt-6 inline-block w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white"
    >
      내 기도짝 확인하기 →
    </Link></>
  );
}

export default function ParticipantForm({ participant, editToken = '' }: { participant?: Participant; editToken?: string }) {
  const [state, formAction] = useActionState(submitParticipant, initialState);
  const editing = !!participant;

  // undefined = 아직 브라우저 저장소를 확인하기 전(서버 렌더 시점).
  // 이 구분이 없으면 이미 신청한 사람에게도 빈 폼이 한 번 번쩍 보였다가 바뀌는데,
  // 그 순간에 제출 버튼을 눌러 버리면 중복 신청이 됩니다.
  const [savedId, setSavedId] = useState<string | null | undefined>(undefined);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [name, setName] = useState(participant?.name ?? '');
  const [team, setTeam] = useState(participant?.team ?? '');
  const [prayer, setPrayer] = useState(participant?.prayer_request ?? '');
  const [editVersion, setEditVersion] = useState(participant?.edit_version ?? 0);
  const [startingOver, setStartingOver] = useState(false);
  const [shareInGroup, setShareInGroup] = useState(participant?.prayer_request === '기도제목은 매칭된 조 안에서 직접 나눌게요.');

  useEffect(() => {
    if (editing) return;
    let mounted = true;
    setSavedId(readRemembered());
    void getSubmissionRequest().then(id => { if (mounted) setSubmissionId(id); });
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        const id = readRemembered();
        if (id) { setSavedId(id); setStartingOver(false); }
      }
      if (event.key === SUBMISSION_KEY && event.newValue) {
        void getSubmissionRequest().then(id => { if (mounted) setSubmissionId(id); });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => { mounted = false; window.removeEventListener('storage', onStorage); };
  }, [editing]);

  useEffect(() => {
    if (state.status !== 'success' || !state.participantId) return;
    // 운영자가 다른 사람을 수정해도 이 기기의 본인 신청 기록은 바꾸지 않습니다.
    if (!editing) {
      remember(state.participantId);
      setSavedId(state.participantId);
    }
    setStartingOver(false);
  }, [state, editing]);

  async function startOver() {
    forget();
    setSavedId(null);
    setSubmissionId(null);
    setStartingOver(true);
    setShareInGroup(false); setName(''); setTeam(''); setPrayer('');
    setSubmissionId(await getSubmissionRequest(true));
  }

  // 저장소를 읽기 전에는 폼도 안내도 띄우지 않습니다.
  if (!participant && (savedId === undefined || !submissionId)) {
    return (
      <div
        aria-hidden
        className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="h-[4.5rem] animate-pulse rounded-xl bg-slate-100" />
        <div className="h-[4.5rem] animate-pulse rounded-xl bg-slate-100" />
        <div className="h-[9rem] animate-pulse rounded-xl bg-slate-100" />
        <div className="h-14 animate-pulse rounded-xl bg-slate-100" />
      </div>
    );
  }

  // 1) 방금 제출을 마친 경우
  if (!startingOver && state.status === 'success' && state.participantId && (editing || savedId === state.participantId)) {
    return (
      <div className="rounded-2xl border border-brand-100 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 text-5xl">🙏</div>
        <h2 className="text-xl font-bold text-slate-900">{state.message}</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-500">
          잠시 후 앞 화면에 짝이 안내됩니다.
          <br />
          화면을 보며 함께 기도해 주세요.
        </p>

        <MyPairLink id={state.participantId} showEdit={!participant} />
        {participant && <button type="button" className="mt-4 text-sm underline" onClick={() => { setEditVersion(participant.edit_version); setStartingOver(true); }}>다시 수정하기</button>}
        <p className="mt-3 text-xs text-slate-400">
          매칭이 확정되면 이 링크에서 기도짝의 기도제목을 볼 수 있어요.
        </p>

        {!participant && <StartOverButton onClick={startOver} />}
      </div>
    );
  }

  // 2) 예전에 이 기기에서 신청한 기록이 남아 있는 경우 (새로고침·재방문)
  if (!participant && !startingOver && savedId) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 text-5xl">✅</div>
        <h2 className="text-xl font-bold text-slate-900">이미 신청하셨어요</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-500">
          두 번 신청하지 않으셔도 됩니다.
          <br />
          아래에서 기도짝을 확인해 주세요.
        </p>

        <MyPairLink id={savedId} />

        {!participant && <StartOverButton onClick={startOver} />}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      onReset={event => event.preventDefault()}
      className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      {!participant && <input type="hidden" name="submission_id" value={submissionId ?? ''} />}
      {participant && <>
        <h2 className="text-xl font-bold">내 신청 정보 수정</h2>
        <p className="text-sm text-slate-500">이름·팀·기도제목을 바꿔도 기존 조는 유지됩니다.</p>
        <input type="hidden" name="participant_id" value={participant.id} />
        <input type="hidden" name="edit_version" value={editVersion} />
        <input type="hidden" name="edit_token" value={editToken} />
      </>}
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-semibold text-slate-700">
          이름
        </label>
        <input
          id="name"
          name="name"
          value={name} onChange={event => setName(event.target.value)}
          type="text"
          required
          maxLength={20}
          autoComplete="name"
          placeholder="홍길동"
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>

      <div>
        <label htmlFor="team" className="mb-2 block text-sm font-semibold text-slate-700">
          팀
        </label>
        <select
          id="team"
          name="team"
          required
          value={team} onChange={event => setTeam(event.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          <option value="" disabled>
            팀을 선택하세요
          </option>
          {TEAMS.map((team) => (
            <option key={team} value={team}>
              {team}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="prayer_request"
          className="mb-2 block text-sm font-semibold text-slate-700"
        >
          기도제목
        </label>
        <label className="mb-3 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
          <input
            type="checkbox"
            name="share_in_group"
            checked={shareInGroup}
            onChange={(event) => setShareInGroup(event.target.checked)}
            aria-controls="prayer_request"
            className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
          />
          <span>기도제목을 입력하지 않고 매칭된 조 안에서 직접 나눌래요</span>
        </label>
        <textarea
          id="prayer_request"
          name="prayer_request"
          value={prayer} onChange={event => setPrayer(event.target.value)}
          required={!shareInGroup}
          disabled={shareInGroup}
          rows={5}
          maxLength={500}
          placeholder={shareInGroup ? '매칭된 조 안에서 기도제목을 직접 나눠 주세요.' : '함께 기도하고 싶은 내용을 적어 주세요.'}
          className="w-full resize-none rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-400"
        />
        <p className="mt-2 text-xs text-slate-400">
          송출 화면에는 이름만 나갑니다. 기도제목은 매칭된 기도짝끼리만 개인 링크로 볼 수
          있어요.
        </p>
      </div>

      {state.status === 'error' && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
          {state.message}
        </p>
      )}

      <SubmitButton editing={!!participant} shareInGroup={shareInGroup} />
    </form>
  );
}
