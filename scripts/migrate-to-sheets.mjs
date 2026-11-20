import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TABLES = {
  participants: ['id', 'name', 'team', 'prayer_request', 'created_at', 'edit_version'],
  match_rounds: ['id', 'mode', 'target_size', 'is_active', 'created_at'],
  match_groups: ['id', 'round_id', 'group_number'],
  match_members: ['group_id', 'participant_id', 'seq'],
  match_control: ['id', 'revision', 'draw_started_at'],
  participant_submissions: ['request_id', 'participant_id'],
};
const ORDER = {
  participants: ['id'], match_rounds: ['id'], match_groups: ['id'],
  match_members: ['group_id', 'participant_id'], match_control: ['id'],
  participant_submissions: ['request_id'],
};
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_SIZE = 1000;

function sourceConfig(env) {
  const value = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value || !key) throw new Error('이전용 Supabase URL과 service_role 키를 로컬 환경변수에 설정해 주세요.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Supabase URL 형식을 확인해 주세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Supabase URL은 매개변수 없는 HTTPS 기본 주소여야 합니다.');
  }
  return { url: url.origin, key };
}

function destinationConfig(env) {
  const value = env.GOOGLE_SHEETS_WEB_APP_URL;
  const secret = env.GOOGLE_SHEETS_API_SECRET;
  if (!value || !secret || secret.length < 32) throw new Error('Apps Script 배포 주소와 32자 이상의 서버 비밀키를 설정해 주세요.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Apps Script 배포 주소 형식을 확인해 주세요.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) throw new Error('Apps Script의 /exec 웹 앱 배포 주소가 필요합니다.');
  return { url: url.toString(), secret };
}

async function jsonRequest(fetchImpl, url, options, label) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(60000), redirect: 'follow' }); }
  catch { throw new Error(`${label} 연결에 실패했습니다. 연결을 확인한 뒤 다시 실행해 주세요.`); }
  if (!response.ok) throw new Error(`${label} 요청에 실패했습니다. HTTP ${response.status}.`);
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${label} 응답 형식을 확인해 주세요. 배포·접근 권한 설정이 필요할 수 있습니다.`); }
  return { response, data };
}

async function sourceRevision(source, fetchImpl) {
  const { data } = await jsonRequest(fetchImpl, `${source.url}/rest/v1/rpc/prayer_snapshot`, {
    method: 'POST', headers: { apikey: source.key, Authorization: `Bearer ${source.key}`, 'Content-Type': 'application/json' }, body: '{}',
  }, 'Supabase 상태 조회');
  const revision = Number(data?.revision);
  if (data?.revision === undefined || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Supabase 행사 버전을 확인하지 못했습니다. 이전 스키마를 확인해 주세요.');
  return revision;
}

export async function readSourceTable(source, table, fetchImpl = fetch) {
  if (!Object.hasOwn(TABLES, table)) throw new Error('지원하지 않는 원본 테이블입니다.');
  const rows = [];
  let expectedTotal;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`${source.url}/rest/v1/${table}`);
    url.searchParams.set('select', TABLES[table].join(','));
    url.searchParams.set('order', ORDER[table].map(column => `${column}.asc`).join(','));
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    const { response, data } = await jsonRequest(fetchImpl, url, {
      headers: { apikey: source.key, Authorization: `Bearer ${source.key}`, Prefer: 'count=exact' },
    }, `Supabase ${table} 조회`);
    if (!Array.isArray(data)) throw new Error(`${table} 테이블 응답이 목록이 아닙니다.`);
    const countText = response.headers.get('content-range')?.split('/')[1];
    const total = countText && /^\d+$/.test(countText) ? Number(countText) : NaN;
    if (!Number.isSafeInteger(total)) throw new Error(`${table} 전체 행 수를 확인하지 못해 이전을 중단했습니다.`);
    if (expectedTotal !== undefined && total !== expectedTotal) throw new Error('내보내기 중 원본 행 수가 변경되었습니다. 접수·관리자 조작을 중단한 뒤 다시 실행해 주세요.');
    expectedTotal = total;
    if (data.length !== Math.min(PAGE_SIZE, Math.max(total - offset, 0))) throw new Error(`${table} 일부 행이 누락되어 이전을 중단했습니다. Supabase API의 최대 행 수를 1000 이상으로 확인해 주세요.`);
    rows.push(...data);
    if (rows.length === total) return rows;
  }
}

export function canonicalState(data) {
  if (!data || typeof data !== 'object') throw new Error('이전 데이터 형식을 확인해 주세요.');
  const result = {};
  for (const [table, columns] of Object.entries(TABLES)) {
    if (!Array.isArray(data[table])) throw new Error(`${table} 데이터가 없습니다.`);
    result[table] = data[table].map(row => {
      if (!row || typeof row !== 'object' || columns.some(column => !Object.hasOwn(row, column))) throw new Error(`${table} 데이터 열이 누락되었습니다.`);
      return Object.fromEntries(columns.map(column => [column, row[column]]));
    }).sort((a, b) => {
      for (const column of ORDER[table]) {
        const compared = String(a[column]).localeCompare(String(b[column]), 'en');
        if (compared) return compared;
      }
      return 0;
    });
  }
  return result;
}

function counts(data) { return Object.fromEntries(Object.keys(TABLES).map(table => [table, data[table].length])); }
function emptyDestination(data) {
  return Object.keys(TABLES).every(table => table === 'match_control' || data[table].length === 0)
    && data.match_control.length === 1 && data.match_control[0].id === true
    && data.match_control[0].revision === 0 && data.match_control[0].draw_started_at === null;
}

async function sheetsRequest(destination, operation, payload, fetchImpl) {
  const { data } = await jsonRequest(fetchImpl, destination.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: destination.secret, operation, payload }),
  }, '구글시트');
  if (data?.ok !== true) throw new Error(`구글시트 ${operation} 요청을 처리하지 못했습니다. 설정과 대상 시트 상태를 확인해 주세요. 오류 코드: ${String(data?.error?.code || 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30)}`);
  return data.data;
}

export async function migrate({ apply = false, env = process.env, fetchImpl = fetch,
  backupDirectory = join(PROJECT_DIR, '.tmp.driveupload', 'migration'), log = console.log } = {}) {
  const source = sourceConfig(env);
  const destination = apply ? destinationConfig(env) : null;
  const revision = await sourceRevision(source, fetchImpl);
  const raw = {};
  for (const table of Object.keys(TABLES)) raw[table] = await readSourceTable(source, table, fetchImpl);
  if (revision !== await sourceRevision(source, fetchImpl) || raw.match_control.length !== 1 || raw.match_control[0].revision !== revision) {
    throw new Error('내보내기 중 원본 데이터가 변경되었습니다. 접수·관리자 조작을 중단한 뒤 다시 실행해 주세요.');
  }
  const data = canonicalState(raw);
  const exportedAt = new Date().toISOString();
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDirectory, `supabase-${exportedAt.replace(/[:.]/g, '-')}-${process.pid}.json`);
  await writeFile(backupPath, JSON.stringify({ version: 1, exportedAt, source: source.url, revision, data }, null, 2), { flag: 'wx', mode: 0o600 });
  const tableCounts = counts(data);
  log(`로컬 백업 저장: ${backupPath}`);
  log(`내보낸 행 수: ${JSON.stringify(tableCounts)}`);
  if (!apply) {
    log('확인만 완료했습니다. 구글시트는 변경하지 않았습니다. 이전하려면 접수를 중단하고 --apply로 실행하세요.');
    return { applied: false, backupPath, counts: tableCounts, revision };
  }
  const existing = canonicalState(await sheetsRequest(destination, 'export', {}, fetchImpl));
  if (!emptyDestination(existing)) throw new Error('대상 구글시트가 비어 있지 않아 가져오지 않았습니다. 기존 데이터를 보존했습니다.');
  if (revision !== await sourceRevision(source, fetchImpl)) throw new Error('가져오기 전에 원본이 변경되었습니다. 접수·관리자 조작을 중단한 뒤 다시 실행해 주세요.');
  await sheetsRequest(destination, 'import', { data }, fetchImpl);
  const imported = canonicalState(await sheetsRequest(destination, 'export', {}, fetchImpl));
  if (JSON.stringify(data) !== JSON.stringify(imported)) throw new Error('이전 후 데이터가 원본과 일치하지 않습니다. 운영 저장소를 전환하지 말고 로컬 백업과 구글시트를 확인해 주세요.');
  if (revision !== await sourceRevision(source, fetchImpl)) throw new Error('가져오기 도중 Supabase 데이터가 변경되었습니다. 구글시트는 이전 시점의 데이터이므로 운영 저장소 전환을 중단하고 두 저장소를 확인해 주세요.');
  log('구글시트 이전과 전체 행 비교를 완료했습니다. 운영 배포 전까지 Supabase 접수와 관리자 조작을 계속 중단해 주세요.');
  return { applied: true, backupPath, counts: tableCounts, revision };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('사용법: npm run migrate:sheets -- [--export-only | --apply]\n기본값/--export-only: 로컬 백업과 행 수만 확인. --apply: 빈 구글시트에 이전하고 전체 행 비교.');
    return;
  }
  if (args.some(arg => !['--export-only', '--apply'].includes(arg)) || (args.includes('--export-only') && args.includes('--apply'))) {
    throw new Error('--export-only 또는 --apply 중 하나만 사용해 주세요.');
  }
  const envPath = join(PROJECT_DIR, '.env.local');
  if (existsSync(envPath)) {
    if (typeof process.loadEnvFile !== 'function') throw new Error('.env.local을 읽으려면 Node.js 22 이상으로 실행해 주세요.');
    process.loadEnvFile(envPath);
  }
  await migrate({ apply: args.includes('--apply') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : '이전에 실패했습니다.'); process.exitCode = 1; });
}
