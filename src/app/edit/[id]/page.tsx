import Link from 'next/link';
import ParticipantForm from '@/components/ParticipantForm';
import { allowParticipantEdit } from '@/lib/participant-access';
import { getParticipant } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function EditPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token = '' } = await searchParams;
  const allowed = await allowParticipantEdit(id, token);
  const participant = allowed ? await getParticipant(id) : null;
  return <main className="min-h-dvh bg-slate-50 px-5 py-10"><div className="mx-auto max-w-md">
    {participant ? <ParticipantForm participant={participant} editToken={token} /> : <div className="rounded-xl bg-white p-6">
      <h1 className="text-xl font-bold">본인 확인이 필요합니다</h1>
      <p className="mt-3 text-sm text-slate-600">신청한 브라우저에서 열어 주세요. 이전 버전에서 신청했거나 기기를 바꾼 경우 운영자에게 본인용 수정 링크를 요청해 주세요. 삭제된 신청은 수정할 수 없습니다.</p>
    </div>}
    <Link href={`/me/${id}`} className="mt-5 inline-block text-sm underline">내 기도짝으로 돌아가기</Link>
  </div></main>;
}
