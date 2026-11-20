const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const compiled = ts.transpileModule(readFileSync('src/lib/legacy-round-history.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const createdAt = '2026-10-25T11:53:15.578599Z';
const oldRound = { id: 'old-round', mode: 'team', targetSize: 4, createdAt, groupCount: 2, memberCount: 3, isActive: true };
const person = (id, name) => ({ id, name, team: 'A팀', prayer_request: `${name}의 기도제목`, created_at: createdAt, edit_version: 0 });
const first = person('first', '하나');
const second = person('second', '둘');
const third = person('third', '셋');
const elsewhere = person('elsewhere', '다른 회차');
const exportData = {
  participants: [{ ...first, unexpected: 'private internal field' }, second, third, elsewhere],
  match_rounds: [
    { id: oldRound.id, mode: 'team', target_size: 4, created_at: createdAt, is_active: true },
    { id: 'different-round', mode: 'random', target_size: 3, created_at: createdAt, is_active: false },
    { id: 'empty-round', mode: 'random', target_size: 3, created_at: createdAt, is_active: false },
  ],
  match_groups: [
    { id: 'group-b', round_id: oldRound.id, group_number: 2 },
    { id: 'group-a', round_id: oldRound.id, group_number: 1 },
    { id: 'group-c', round_id: oldRound.id, group_number: 3 },
    { id: 'other-group', round_id: 'different-round', group_number: 1 },
  ],
  match_members: [
    { group_id: 'group-a', participant_id: second.id, seq: 1 },
    { group_id: 'group-a', participant_id: first.id, seq: 0 },
    { group_id: 'group-b', participant_id: third.id, seq: 0 },
    { group_id: 'group-c', participant_id: 'missing', seq: 0 },
    { group_id: 'other-group', participant_id: elsewhere.id, seq: 0 },
  ],
};

function setup({ useSupabase = true, env = {}, error } = {}) {
  const exports = {};
  const operations = [];
  vm.runInNewContext(compiled, {
    exports,
    process: { env: { GOOGLE_SHEETS_WEB_APP_URL: 'test-url', GOOGLE_SHEETS_API_SECRET: 'test-secret', ...env } },
    require(name) {
      if (name === 'server-only') return {};
      if (name === './storage') return { usesSupabase: () => useSupabase };
      assert.equal(name, './sheets/server');
      return {
        async sheetRequest(operation) {
          operations.push(operation);
          if (error) throw error;
          assert.ok(['history', 'export'].includes(operation));
          return operation === 'history' ? [oldRound] : structuredClone(exportData);
        },
      };
    },
  });
  return { ...exports, operations };
}

test('legacy summaries use the frozen Sheets history when Supabase is active', async () => {
  const legacy = setup();
  assert.equal(legacy.hasLegacyRoundSource(), true);
  assert.deepEqual(await legacy.getLegacyRoundHistory(), [oldRound]);
  assert.deepEqual(legacy.operations, ['history']);
});

test('legacy detail joins only the selected round in original group and member order', async () => {
  const legacy = setup();
  const detail = JSON.parse(JSON.stringify(await legacy.getLegacyRoundEntry(oldRound.id)));
  assert.deepEqual(detail, {
    id: oldRound.id,
    mode: oldRound.mode,
    targetSize: oldRound.targetSize,
    createdAt,
    isActive: true,
    groups: [
      { groupNumber: 1, members: [first, second] },
      { groupNumber: 2, members: [third] },
    ],
  });
  assert.deepEqual(legacy.operations, ['export']);
  for (const id of ['missing-round', 'empty-round']) assert.equal(await legacy.getLegacyRoundEntry(id), null);
});

test('the fallback makes no Sheets call in Sheets mode or with incomplete configuration', async () => {
  for (const condition of [
    { useSupabase: false },
    { env: { GOOGLE_SHEETS_WEB_APP_URL: '' } },
    { env: { GOOGLE_SHEETS_API_SECRET: '' } },
  ]) {
    const legacy = setup(condition);
    assert.equal(legacy.hasLegacyRoundSource(), false);
    assert.equal((await legacy.getLegacyRoundHistory()).length, 0);
    assert.equal(await legacy.getLegacyRoundEntry(oldRound.id), null);
    assert.deepEqual(legacy.operations, []);
  }
});

test('a Sheets transport failure remains distinguishable from missing history', async () => {
  const error = Object.assign(new Error('구글시트 연결이 지연되었습니다.'), { code: 'CONNECTION' });
  const legacy = setup({ error });
  await assert.rejects(legacy.getLegacyRoundHistory(), error);
  await assert.rejects(legacy.getLegacyRoundEntry(oldRound.id), error);
});
