import ParticipantForm from '@/components/ParticipantForm';

export default function HomePage() {
  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-10">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xs font-semibold leading-relaxed tracking-wider text-brand-600">
            사랑의교회 청년부
            <br />
            한반도이웃사랑선교국
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">2026 짝기도 매칭</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
            이름과 팀, 성별만 남겨 주시면
            <br />
            짝을 지어 앞 화면에 안내해 드립니다.
          </p>
        </header>

        <ParticipantForm />
      </div>
    </main>
  );
}
