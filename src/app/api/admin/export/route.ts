import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/auth';
import { getActiveRound, getParticipants } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function escapeCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function GET() {
  if (!(await isAdmin())) {
    return new NextResponse('관리자 인증이 필요합니다.', { status: 401 });
  }

  const [participants, round] = await Promise.all([getParticipants(), getActiveRound()]);

  // 참가자별 조 번호를 붙이기 위한 역인덱스
  const groupNumberById = new Map<string, number>();
  for (const group of round?.groups ?? []) {
    for (const member of group.members) {
      groupNumberById.set(member.id, group.groupNumber);
    }
  }

  const header = ['조', '이름', '팀', '성별', '접수시각'];
  const rows = participants.map((p) =>
    [
      groupNumberById.get(p.id)?.toString() ?? '',
      p.name,
      p.team,
      p.gender,
      new Date(p.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    ]
      .map(escapeCsv)
      .join(','),
  );

  // 엑셀이 한글을 깨뜨리지 않도록 UTF-8 BOM 을 붙입니다.
  const csv = '﻿' + [header.map(escapeCsv).join(','), ...rows].join('\r\n');
  const filename = `짝기도_${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}
