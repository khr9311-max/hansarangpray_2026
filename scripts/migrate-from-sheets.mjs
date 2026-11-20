import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TABLES as LEGACY_TABLES } from './migrate-to-sheets.mjs';

export const TABLES = {
  ...LEGACY_TABLES,
  prayer_checkins: ['participant_id', 'week_1', 'week_2', 'week_3', 'week_4'],
};
const KEYS = {
  participants: ['id'], match_rounds: ['id'], match_groups: ['id'],
  match_members: ['group_id', 'participant_id'], match_control: ['id'],
  participant_submissions: ['request_id'], prayer_checkins: ['participant_id'],
};
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6})0*)?(Z|[+-]\d{2}(?::?\d{2})?)$/;
const HELP = '사용법: node scripts/migrate-from-sheets.mjs [--export-only | --verify | --apply [--replace-target <버전>] | --source-status | --freeze-source | --unfreeze-source]';

function readUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} 연결 주소를 확인해 주세요.`); }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${label} 연결 주소 형식을 확인해 주세요.`);
  return url;
}

function sheetsConfig(env) {
  const url = readUrl(env.GOOGLE_SHEETS_WEB_APP_URL, '구글시트');
  if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) {
    throw new Error('Apps Script의 /exec 웹 앱 배포 주소가 필요합니다.');
  }
  const secret = env.GOOGLE_SHEETS_API_SECRET;
  if (!secret || secret.length < 32) throw new Error('Apps Script 서버 비밀키를 확인해 주세요.');
  return { url: url.href, secret };
}

function supabaseConfig(env) {
  const url = readUrl(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, 'Supabase');
  const local = env.SUPABASE_ALLOW_LOCAL === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.pathname !== '/') {
    throw new Error('Supabase 기본 연결 주소가 필요합니다.');
  }
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const legacy = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key || '');
  if (!key || (!key.startsWith('sb_secret_') && !legacy)) throw new Error('Supabase 서버 전용 API 키를 확인해 주세요.');
  const headers = { apikey: key };
  if (legacy) headers.Authorization = `Bearer ${key}`;
  return { url: url.origin, headers };
}

async function callJson(fetchImpl, url, { headers = {}, body = {}, redirect = 'error', label }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), redirect, signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error(`${label} 연결에 실패했습니다.`);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const code = typeof error?.code === 'string' && /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(error.code) ? `, ${error.code}` : '';
    throw new Error(`${label} 요청에 실패했습니다 (HTTP ${response.status}${code}).`);
  }
  try { return await response.json(); }
  catch { throw new Error(`${label} 응답 형식을 확인해 주세요.`); }
}

async function sheetsRequest(source, fetchImpl, operation, payload = {}) {
  const response = await callJson(fetchImpl, source.url, {
    label: '구글시트', redirect: 'follow', body: { secret: source.secret, operation, payload },
  });
  if (response?.ok !== true) throw new Error(`구글시트 ${operation} 요청을 처리하지 못했습니다.`);
  return response.data;
}

async function sourceGate(source, fetchImpl, requested) {
  const reply = requested === undefined
    ? await sheetsRequest(source, fetchImpl, 'migration_status')
    : await sheetsRequest(source, fetchImpl, 'migration_set_read_only', { readOnly: requested });
  if (typeof reply?.readOnly !== 'boolean' || (requested !== undefined && reply.readOnly !== requested)) {
    throw new Error('구글시트의 접수 중지 상태를 확인하지 못했습니다.');
  }
  return reply.readOnly;
}

export async function manageSource({ readOnly, env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const state = await sourceGate(sheetsConfig(env), fetchImpl, readOnly);
  log(state ? '구글시트 저장 중지 상태입니다.' : '구글시트 저장 가능 상태입니다.');
  return state;
}

function rpc(target, fetchImpl, name, body = {}) {
  return callJson(fetchImpl, `${target.url}/rest/v1/rpc/${name}`, {
    headers: target.headers, body, label: `Supabase ${name}`,
  });
}

function timestamp(value, table) {
  const match = typeof value === 'string' ? TIMESTAMP.exec(value) : null;
  if (!match) throw new Error(`${table} 시각 값의 형식 또는 정밀도를 확인해 주세요.`);
  const [, date, time, fraction = '', rawZone] = match;
  const localSecond = `${date}T${time}`;
  const zone = rawZone.length === 3 ? `${rawZone}:00` : rawZone;
  const local = new Date(`${localSecond}Z`);
  const utc = new Date(`${localSecond}${zone}`);
  if (!Number.isFinite(utc.getTime()) || !Number.isFinite(local.getTime()) || !local.toISOString().startsWith(localSecond)) {
    throw new Error(`${table} 날짜를 확인해 주세요.`);
  }
  return `${utc.toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
}

function checkedColumn(table, column, value) {
  if (column === 'created_at' || column === 'draw_started_at') {
    return column === 'draw_started_at' && value === null ? null : timestamp(value, table);
  }
  if (table === 'match_control' && column === 'id') {
    if (value === true) return value;
  } else if (column === 'id' || column.endsWith('_id')) {
    if (typeof value === 'string' && UUID.test(value)) return value;
  } else if (column === 'is_active' || column.startsWith('week_')) {
    if (typeof value === 'boolean') return value;
  } else if (['edit_version', 'revision', 'target_size', 'group_number', 'seq'].includes(column)) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } else if (typeof value === 'string') {
    return value;
  }
  throw new Error(`${table}.${column} 값의 형식을 확인해 주세요.`);
}

export function canonicalSnapshot(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('이전 데이터 형식을 확인해 주세요.');
  const canonical = {};
  for (const [table, columns] of Object.entries(TABLES)) {
    if (!Array.isArray(state[table])) throw new Error(`${table} 데이터가 없습니다.`);
    const keys = KEYS[table];
    const seen = new Set();
    canonical[table] = state[table].map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${table} 행 형식을 확인해 주세요.`);
      const clean = Object.fromEntries(columns.map(column => [column, checkedColumn(table, column, row[column])]));
      const key = JSON.stringify(keys.map(column => clean[column]));
      if (seen.has(key)) throw new Error(`${table}에 중복 행 식별자가 있습니다.`);
      seen.add(key);
      return clean;
    }).sort((left, right) => {
      for (const column of keys) {
        if (left[column] < right[column]) return -1;
        if (left[column] > right[column]) return 1;
      }
      return 0;
    });
  }
  if (canonical.match_control.length !== 1) throw new Error('행사 상태 행은 하나여야 합니다.');
  return canonical;
}

function counts(state) {
  return Object.fromEntries(Object.entries(state).map(([table, rows]) => [table, rows.length]));
}

function fingerprint(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function equalState(source, target) {
  return JSON.stringify(source) === JSON.stringify(target);
}

function matchingState(source, target) {
  if (equalState(source, target)) return;
  const differing = Object.keys(TABLES).filter(table => JSON.stringify(source[table]) !== JSON.stringify(target[table]));
  throw new Error(`Supabase 데이터가 구글시트와 일치하지 않습니다 (${differing.join(', ')}).`);
}

function isEmpty(state) {
  return state.match_control[0].revision === 0 && state.match_control[0].draw_started_at === null
    && Object.keys(TABLES).every(table => table === 'match_control' || state[table].length === 0);
}

async function saveBackup(directory, type, state) {
  const exportedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${type}-${exportedAt.replace(/[:.]/g, '-')}-${process.pid}.json`);
  await writeFile(path, JSON.stringify({ version: 1, exportedAt, sha256: fingerprint(state), data: state }, null, 2),
    { flag: 'wx', mode: 0o600 });
  return path;
}

async function sourceRevision(source, fetchImpl) {
  const { revision } = (await sheetsRequest(source, fetchImpl, 'revision')) ?? {};
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('구글시트 행사 버전을 확인하지 못했습니다.');
  return revision;
}

export async function migrateFromSheets({ mode = 'export-only', replaceTarget, env = process.env, fetchImpl = fetch,
  backupDirectory = join(PROJECT_DIR, '.tmp.driveupload', 'migration'), log = console.log } = {}) {
  if (!['export-only', 'verify', 'apply'].includes(mode) || (replaceTarget !== undefined
    && (mode !== 'apply' || !Number.isSafeInteger(replaceTarget) || replaceTarget < 0))) throw new Error(HELP);
  const source = sheetsConfig(env);
  const target = mode === 'export-only' ? null : supabaseConfig(env);
  async function requireFrozenSource() {
    if (mode === 'apply' && !await sourceGate(source, fetchImpl)) {
      throw new Error('구글시트가 저장 가능 상태입니다. 이전 직전에 --freeze-source로 먼저 멈춰 주세요.');
    }
  }
  await requireFrozenSource();
  const revision = await sourceRevision(source, fetchImpl);
  const data = canonicalSnapshot(await sheetsRequest(source, fetchImpl, 'export'));
  async function assertSourceUnchanged() {
    if (revision !== data.match_control[0].revision || revision !== await sourceRevision(source, fetchImpl)) {
      throw new Error('구글시트 행사 버전이 실행 중 변경되었습니다. 접수와 관리자 조작을 멈춘 뒤 다시 확인해 주세요.');
    }
    await requireFrozenSource();
  }
  await assertSourceUnchanged();
  const summary = { revision, counts: counts(data), sha256: fingerprint(data) };
  log(`구글시트 버전 ${revision}, 행 수 ${JSON.stringify(summary.counts)}, SHA-256 ${summary.sha256}`);
  if (!target) {
    const backupPath = await saveBackup(backupDirectory, 'sheets', data);
    log(`구글시트 로컬 백업 저장 ${backupPath}`);
    return { ...summary, backupPath, applied: false };
  }

  const existing = canonicalSnapshot(await rpc(target, fetchImpl, 'prayer_export'));
  if (mode === 'verify' || equalState(data, existing)) {
    matchingState(data, existing);
    await assertSourceUnchanged();
    log('구글시트와 Supabase의 전체 행이 일치합니다.');
    return { ...summary, applied: false, verified: true };
  }

  const targetRevision = existing.match_control[0].revision;
  if (!isEmpty(existing) && replaceTarget === undefined) {
    throw new Error(`Supabase에 기존 데이터가 있습니다. 이전 대상을 확인한 후 --replace-target ${targetRevision}를 함께 지정해 주세요.`);
  }
  if (replaceTarget !== undefined && replaceTarget !== targetRevision) {
    throw new Error(`Supabase 대상 데이터 버전이 변경되었습니다 (현재 ${targetRevision}).`);
  }
  const backupPath = await saveBackup(backupDirectory, 'sheets', data);
  const targetBackupPath = await saveBackup(backupDirectory, 'supabase-before-restore', existing);
  log(`구글시트와 이전 전 Supabase의 로컬 백업 저장 ${backupPath}, ${targetBackupPath}`);
  await assertSourceUnchanged();
  let possibleImportError;
  try {
    await rpc(target, fetchImpl, 'prayer_import', {
      p_state: data, p_expected_revision: targetRevision, p_allow_replace: replaceTarget !== undefined,
    });
  } catch (error) {
    possibleImportError = error;
  }
  try {
    matchingState(data, canonicalSnapshot(await rpc(target, fetchImpl, 'prayer_export')));
  } catch (error) {
    throw possibleImportError || error;
  }
  await assertSourceUnchanged();
  log('Supabase 가져오기와 전체 행 대조를 완료했습니다.');
  return { ...summary, backupPath, targetBackupPath, applied: true, verified: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  const mode = args.length ? args[0].slice(2) : 'export-only';
  if ((args.length && args[0] !== `--${mode}`)
    || (args.length > 1 && (mode !== 'apply' || args.length !== 3 || args[1] !== '--replace-target' || !/^\d+$/.test(args[2])))) {
    throw new Error(HELP);
  }
  const envPath = join(PROJECT_DIR, '.env.local');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  if (['source-status', 'freeze-source', 'unfreeze-source'].includes(mode)) {
    await manageSource({ readOnly: mode === 'source-status' ? undefined : mode === 'freeze-source' });
    return;
  }
  await migrateFromSheets({ mode, replaceTarget: args.length === 3 ? Number(args[2]) : undefined });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : '이전에 실패했습니다.'); process.exitCode = 1; });
}
