export default function KeepWindowOpenNotice({ display = false }: { display?: boolean }) {
  return (
    <aside
      aria-label="휴대폰 창 유지 안내"
      className={`rounded-2xl border ${
        display
          ? 'mb-5 border-amber-300/40 bg-amber-300/10 px-6 py-4 text-center text-amber-100'
          : 'mb-5 border-amber-200 bg-amber-50 px-4 py-4 text-amber-950'
      }`}
    >
      <p className={`font-bold leading-snug ${display ? 'text-2xl lg:text-3xl' : 'text-base'}`}>
        휴대폰 기도제목 입력 완료 후 창을 닫지 말아주세요!
      </p>
      <p className={`mt-2 leading-relaxed ${display ? 'text-base text-amber-100/80' : 'text-sm text-amber-800'}`}>
        매칭 후 휴대폰에서 ‘내 기도짝 확인하기’를 눌러 조원들의 기도제목을 확인해 주세요.
      </p>
    </aside>
  );
}
