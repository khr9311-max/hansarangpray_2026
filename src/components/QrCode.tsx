import type { QrMatrix } from '@/lib/qr';

/** 여백(quiet zone). 이게 없으면 스캔이 잘 안 됩니다. */
const QUIET = 2;

/**
 * QR 격자를 인라인 SVG 로 그립니다.
 * 모듈 하나당 <rect> 를 찍으면 1000개가 넘어가므로,
 * 가로로 이어진 검은 칸은 한 덩어리로 합쳐서 그립니다.
 */
export default function QrCode({
  matrix,
  className,
}: {
  matrix: QrMatrix;
  className?: string;
}) {
  const span = matrix.size + QUIET * 2;
  const bars: { x: number; y: number; w: number }[] = [];

  matrix.rows.forEach((row, y) => {
    let runStart = -1;
    for (let x = 0; x <= matrix.size; x++) {
      const dark = row[x] === '1';
      if (dark && runStart === -1) runStart = x;
      if (!dark && runStart !== -1) {
        bars.push({ x: runStart + QUIET, y: y + QUIET, w: x - runStart });
        runStart = -1;
      }
    }
  });

  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      className={className}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`신청 페이지 QR 코드 (${matrix.text})`}
    >
      <rect width={span} height={span} fill="#ffffff" />
      {bars.map((bar, i) => (
        <rect key={i} x={bar.x} y={bar.y} width={bar.w} height={1} fill="#000000" />
      ))}
    </svg>
  );
}
