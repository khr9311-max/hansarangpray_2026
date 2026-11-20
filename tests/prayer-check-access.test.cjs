const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const participantId = '1281648f-c9da-44b1-9a6d-80a4bec84820';
const peerId = '856a1a7b-caab-4320-a50a-f554aa258f63';
const roundId = '68ff7203-73b5-4e12-b3f5-d88a23fe0686';

function load(path, imports) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, Buffer, process: { env: { ADMIN_PASSWORD: 'local-test-password' } }, require(name) {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
    return imports[name];
  } });
  return exports;
}

test('checking a week requires proof for that participant and preserves a submitted false', async () => {
  const cookies = new Map();
  const access = load('src/lib/prayer-access.ts', {
    'server-only': {}, 'node:crypto': require('node:crypto'),
    'next/headers': { cookies: async () => cookies },
    './participant-access': { validEditToken: () => false },
    './prayer-weeks': { PRAYER_ACCESS_SECONDS: 45 * 86400 },
  });
  const writes = [];
  const actions = load('src/app/me/[id]/actions.ts', {
    'next/cache': { revalidatePath() {}, revalidateTag() {} },
    '@/lib/event': { EVENT_CACHE_TAG: 'prayer-event' },
    '@/lib/prayer-access': access,
    '@/lib/storage': { async storageRequest(operation, payload) { writes.push({ operation, ...payload }); } },
  });
  const request = { id: participantId, roundId, week: 2, checked: false };
  const token = access.prayerCheckToken(participantId);
  assert.equal(access.validPrayerCheckToken(participantId, token), true);
  assert.equal(access.validPrayerCheckToken(peerId, token), false);
  assert.equal(access.validPrayerCheckToken(participantId, token + 'a'), false);
  assert.equal(access.validPrayerCheckToken(participantId, access.prayerCheckToken(participantId, Date.now() - 1)), false);
  assert.ok((await actions.savePrayerCheck(request)).error, 'opening the public personal link grants view only');
  cookies.set(`jjak_prayer_${participantId}`, { value: token });
  assert.ok((await actions.savePrayerCheck({ ...request, id: peerId })).error, 'one participant cannot edit a peer');
  assert.ok((await actions.savePrayerCheck({ ...request, checked: 'false' })).error, 'strings cannot be used as check states');
  assert.equal(writes.length, 0);
  assert.equal((await actions.savePrayerCheck(request)).error, undefined);
  assert.deepEqual(writes, [{ operation: 'check_prayer', ...request }]);
});
