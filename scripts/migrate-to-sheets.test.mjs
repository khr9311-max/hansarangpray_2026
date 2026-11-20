import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { TABLES, canonicalState, migrate, readSourceTable } from './migrate-to-sheets.mjs';

const env = {
  SUPABASE_URL: 'https://legacy-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-source-secret',
  GOOGLE_SHEETS_WEB_APP_URL: 'https://script.google.com/macros/s/test-deployment/exec',
  GOOGLE_SHEETS_API_SECRET: 'test-destination-secret-with-32-characters',
};
function blank() {
  return { ...Object.fromEntries(Object.keys(TABLES).map(table => [table, []])), match_control: [{ id: true, revision: 0, draw_started_at: null }] };
}
function sourceState() {
  return { ...blank(), participants: [{ id: '00000000-0000-0000-0000-000000000001', name: '검증용 참가자', team: '운영팀', prayer_request: '검증용 기도제목', created_at: '2026-11-20T01:02:03.123456+00:00', edit_version: 2 }],
    participant_submissions: [{ request_id: '00000000-0000-0000-0000-000000000002', participant_id: '00000000-0000-0000-0000-000000000001' }],
    match_control: [{ id: true, revision: 4, draw_started_at: null }] };
}
function mockServices(source, { destination = blank(), revisions, corruptImport = false } = {}) {
  const calls = []; let revisionReads = 0;
  const fetchImpl = async (url, options = {}) => {
    url = new URL(url); calls.push({ host: url.hostname, path: url.pathname, options });
    if (url.hostname === 'legacy-test.supabase.co') {
      assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
      if (url.pathname.endsWith('/prayer_snapshot')) return Response.json({ revision: revisions?.[revisionReads++] ?? source.match_control[0].revision });
      const table = url.pathname.split('/').at(-1);
      assert.ok(Object.hasOwn(TABLES, table));
      assert.ok(url.searchParams.get('order'));
      const offset = Number(url.searchParams.get('offset'));
      return Response.json(source[table].slice(offset, offset + 1000), { headers: { 'Content-Range': `${offset}-${Math.min(offset + 999, source[table].length - 1)}/${source[table].length}` } });
    }
    assert.equal(url.hostname, 'script.google.com');
    const request = JSON.parse(options.body);
    assert.equal(request.secret, env.GOOGLE_SHEETS_API_SECRET);
    if (request.operation === 'export') return Response.json({ ok: true, data: destination });
    assert.equal(request.operation, 'import');
    destination = structuredClone(request.payload.data);
    if (corruptImport) destination.participants[0].edit_version++;
    return Response.json({ ok: true, data: {} });
  };
  return { fetchImpl, calls, imported: () => destination, importCalls: () => calls.filter(c => c.host === 'script.google.com' && JSON.parse(c.options.body).operation === 'import').length };
}
async function tempBackup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jjak-sheets-migration-'));
  t.after(async () => {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Test cleanup target left temporary directory.');
    await rm(directory, { recursive: true });
  });
  return directory;
}

test('reads every paginated row and preserves timestamp text including microseconds', async () => {
  const state = sourceState();
  state.participants = Array.from({ length: 1001 }, (_, i) => ({ ...state.participants[0], id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }));
  const services = mockServices(state);
  const rows = await readSourceTable({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY }, 'participants', services.fetchImpl);
  assert.equal(rows.length, 1001);
  assert.equal(rows[1000].id, state.participants[1000].id);
  assert.equal(rows[0].created_at, '2026-11-20T01:02:03.123456+00:00');
  assert.equal(services.calls.length, 2);
});

test('default run saves a credential-free backup without contacting Sheets', async t => {
  const state = sourceState(), services = mockServices(state), backupDirectory = await tempBackup(t), output = [];
  const result = await migrate({ env, fetchImpl: services.fetchImpl, backupDirectory, log: line => output.push(line) });
  assert.equal(result.applied, false);
  assert.equal(services.calls.some(c => c.host === 'script.google.com'), false);
  const backup = await readFile(result.backupPath, 'utf8');
  assert.deepEqual(JSON.parse(backup).data, canonicalState(state));
  assert.ok(!backup.includes(env.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(!backup.includes(env.GOOGLE_SHEETS_API_SECRET));
  assert.ok(!output.join('\n').includes(state.participants[0].name));
});

test('apply preserves participant links, versions and retry identifiers and verifies every row', async t => {
  const state = sourceState(), services = mockServices(state);
  const result = await migrate({ apply: true, env, fetchImpl: services.fetchImpl, backupDirectory: await tempBackup(t), log: () => {} });
  assert.equal(result.applied, true);
  assert.equal(services.importCalls(), 1);
  assert.deepEqual(services.imported(), canonicalState(state));
});

test('refuses a populated destination without writing or replacing its records', async t => {
  const original = sourceState(), destination = sourceState(), services = mockServices(original, { destination });
  await assert.rejects(migrate({ apply: true, env, fetchImpl: services.fetchImpl, backupDirectory: await tempBackup(t), log: () => {} }), /비어 있지/);
  assert.equal(services.importCalls(), 0);
  assert.deepEqual(services.imported(), destination);
});

test('aborts when source changes while export is being read', async t => {
  const services = mockServices(sourceState(), { revisions: [4, 5] }), backupDirectory = await tempBackup(t);
  await assert.rejects(migrate({ apply: true, env, fetchImpl: services.fetchImpl, backupDirectory, log: () => {} }), /원본 데이터가 변경/);
  assert.equal(services.importCalls(), 0);
  assert.deepEqual(await readdir(backupDirectory), []);
});

test('rechecks source immediately before import and refuses changed source', async t => {
  const services = mockServices(sourceState(), { revisions: [4, 4, 5] });
  await assert.rejects(migrate({ apply: true, env, fetchImpl: services.fetchImpl, backupDirectory: await tempBackup(t), log: () => {} }), /가져오기 전에 원본/);
  assert.equal(services.importCalls(), 0);
});

test('reports a failed full-row comparison instead of declaring migration complete', async t => {
  const services = mockServices(sourceState(), { corruptImport: true });
  await assert.rejects(migrate({ apply: true, env, fetchImpl: services.fetchImpl, backupDirectory: await tempBackup(t), log: () => {} }), /원본과 일치하지/);
});

test('rejects partial API pages rather than silently truncating source data', async () => {
  const fetchImpl = async () => Response.json([{ id: 'sample' }], { headers: { 'Content-Range': '0-0/2' } });
  await assert.rejects(readSourceTable({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY }, 'participants', fetchImpl), /일부 행이 누락/);
});
