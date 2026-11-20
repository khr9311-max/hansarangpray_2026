import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TABLES, canonicalSnapshot, manageSource, migrateFromSheets } from './migrate-from-sheets.mjs';

const env = {
  GOOGLE_SHEETS_WEB_APP_URL: 'https://script.google.com/macros/s/test-deployment/exec',
  GOOGLE_SHEETS_API_SECRET: 'test-sheets-secret-with-32-characters',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_example',
};
const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const config = { env, log: () => {} };

function empty() {
  return { ...Object.fromEntries(Object.keys(TABLES).map(name => [name, []])),
    match_control: [{ id: true, revision: 0, draw_started_at: null }] };
}

function sourceSnapshot() {
  const created = '2026-11-20T10:02:03.123456+09:00';
  return {
    participants: [{ id: id(1), name: '테스트 참가자', team: '테스트 팀',
      prayer_request: '테스트 기도제목', created_at: created, edit_version: 2 }],
    match_rounds: [{ id: id(2), mode: 'team', target_size: 4, is_active: true, created_at: created }],
    match_groups: [{ id: id(3), round_id: id(2), group_number: 1 }],
    match_members: [{ group_id: id(3), participant_id: id(1), seq: 0 }],
    match_control: [{ id: true, revision: 6, draw_started_at: created }],
    participant_submissions: [{ request_id: id(4), participant_id: id(1) }],
    prayer_checkins: [{ participant_id: id(1), week_1: true, week_2: false, week_3: true, week_4: false }],
  };
}

function fakeServices({ source = sourceSnapshot(), target = empty(), revisions = [], readOnly = true,
  corruptTarget = false, loseImportResponse = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.startsWith(env.GOOGLE_SHEETS_WEB_APP_URL)) {
      assert.equal(body.secret, env.GOOGLE_SHEETS_API_SECRET);
      calls.push(body.operation);
      if (body.operation === 'migration_set_read_only') readOnly = body.payload.readOnly;
      const replies = { export: source, migration_status: { readOnly }, migration_set_read_only: { readOnly } };
      const data = body.operation === 'revision' ? { revision: revisions.shift() ?? source.match_control[0].revision } : replies[body.operation];
      return Response.json({ ok: true, data });
    }
    assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    const operation = new URL(url).pathname.split('/').at(-1);
    calls.push(operation);
    if (operation === 'prayer_export') return Response.json(target);
    assert.equal(operation, 'prayer_import');
    assert.equal(body.p_expected_revision, target.match_control[0].revision);
    assert.equal(body.p_allow_replace, target.match_control[0].revision !== 0);
    target = structuredClone(body.p_state);
    if (corruptTarget) target.prayer_checkins[0].week_3 = false;
    if (loseImportResponse) throw new Error('transport lost');
    return Response.json({});
  };
  return { fetchImpl, calls, target: () => target };
}

async function withBackups(t) {
  const backupDirectory = await mkdtemp(join(tmpdir(), 'jjak-reverse-migration-'));
  const cleanup = [];
  t.after(async () => {
    for (const path of cleanup) await unlink(path);
    await rmdir(backupDirectory);
  });
  return { backupDirectory, cleanup };
}

test('exports a credential-free backup of all seven tables without calling Supabase', async t => {
  const { fetchImpl, calls } = fakeServices();
  const { backupDirectory, cleanup } = await withBackups(t);
  const log = [];
  const result = await migrateFromSheets({ ...config, fetchImpl, backupDirectory, log: value => log.push(value) });
  cleanup.push(result.backupPath);
  const file = await readFile(result.backupPath, 'utf8');
  assert.deepEqual(calls, ['revision', 'export', 'revision']);
  const backup = JSON.parse(file);
  assert.deepEqual(backup.data, canonicalSnapshot(sourceSnapshot()));
  assert.equal(backup.data.participants[0].created_at, '2026-11-20T01:02:03.123456Z');
  assert.equal(result.sha256, backup.sha256);
  assert.ok(!file.includes(env.GOOGLE_SHEETS_API_SECRET));
  assert.ok(!file.includes(env.SUPABASE_SECRET_KEY));
  assert.ok(!log.join('\n').includes(sourceSnapshot().participants[0].prayer_request));
});

test('requires exact target revision before replacing a populated store', async () => {
  const target = { ...empty(), match_control: [{ id: true, revision: 9, draw_started_at: null }] };
  const { fetchImpl, calls } = fakeServices({ target });
  await assert.rejects(migrateFromSheets({ ...config, fetchImpl, mode: 'apply' }), /--replace-target 9/);
  await assert.rejects(migrateFromSheets({ ...config, fetchImpl, mode: 'apply', replaceTarget: 8 }), /변경되었습니다/);
  assert.ok(!calls.includes('prayer_import'));
});

test('requires the source to be frozen before inspecting or writing the target', async () => {
  const { fetchImpl, calls } = fakeServices({ readOnly: false });
  await assert.rejects(migrateFromSheets({ ...config, fetchImpl, mode: 'apply' }), /--freeze-source/);
  assert.deepEqual(calls, ['migration_status']);
  assert.equal(await manageSource({ ...config, fetchImpl, readOnly: true }), true);
  assert.equal(await manageSource({ ...config, fetchImpl }), true);
  assert.equal(await manageSource({ ...config, fetchImpl, readOnly: false }), false);
});

test('backs up both sides, preserves checks and all IDs, then verifies each imported row', async t => {
  const target = { ...empty(), match_control: [{ id: true, revision: 9, draw_started_at: null }] };
  const services = fakeServices({ target, loseImportResponse: true });
  const { backupDirectory, cleanup } = await withBackups(t);
  const result = await migrateFromSheets({ ...config, fetchImpl: services.fetchImpl, backupDirectory, mode: 'apply', replaceTarget: 9 });
  cleanup.push(result.backupPath, result.targetBackupPath);
  assert.equal(result.verified, true);
  assert.equal(result.applied, true);
  assert.deepEqual(services.target(), canonicalSnapshot(sourceSnapshot()));
  const before = JSON.parse(await readFile(result.targetBackupPath, 'utf8'));
  assert.deepEqual(before.data, canonicalSnapshot(target));
  assert.equal(services.calls.filter(name => name === 'prayer_import').length, 1);
});

test('refuses to import if source revision changes after the source snapshot', async () => {
  const { fetchImpl, calls } = fakeServices({ revisions: [6, 7] });
  await assert.rejects(migrateFromSheets({ ...config, fetchImpl, mode: 'apply' }), /행사 버전이 실행 중 변경/);
  assert.ok(!calls.includes('prayer_import'));
});

test('verifies equivalent timestamp formatting and reports differences without printing values', async () => {
  const target = sourceSnapshot();
  target.participants[0].created_at = '2026-11-20 01:02:03.123456+00';
  const { fetchImpl, calls, target: liveTarget } = fakeServices({ target });
  const result = await migrateFromSheets({ ...config, fetchImpl, mode: 'verify' });
  assert.equal(result.verified, true);
  liveTarget().prayer_checkins[0].week_4 = true;
  await assert.rejects(migrateFromSheets({ ...config, fetchImpl, mode: 'verify' }), /일치하지 않습니다 \(prayer_checkins\)/);
  assert.ok(!calls.includes('prayer_import'));
});
