import 'server-only';

import QRCode from 'qrcode';

export type QrMatrix = {
  /** 한 변의 모듈 수 */
  size: number;
  /** 각 행을 '0'/'1' 문자열로. 클라이언트로 넘길 때 배열보다 훨씬 가볍습니다. */
  rows: string[];
  /** QR 이 담고 있는 주소. 화면에 같이 적어 주면 스캔이 안 될 때 손으로 칠 수 있습니다. */
  text: string;
};

/**
 * 신청 주소를 QR 모듈 격자로 만듭니다.
 * 이미지 파일이나 외부 QR 서비스를 쓰지 않는 이유:
 *  - 도메인이 바뀌어도 QR 이 저절로 따라옵니다.
 *  - 행사 중 외부 서비스가 죽거나 네트워크가 끊겨도 화면이 멀쩡합니다.
 *
 * 오류 정정 수준은 M. 빔프로젝터로 크게 띄우는 용도라 여유가 충분합니다.
 */
export function createQrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;

  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) row += data[y * size + x] ? '1' : '0';
    rows.push(row);
  }

  return { size, rows, text };
}
