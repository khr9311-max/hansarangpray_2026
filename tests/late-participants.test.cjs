const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(path, imports = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, process, Buffer, console: { error() {} },
    require(name) {
      if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const matching = load('src/lib/matching.ts');
const display = load('src/lib/display.ts');
const members = (n) => Array.from({ length: n }, (_, i) => ({
  id: `private-id-${i}`, name: `Person ${i}`, team: `Team ${i % 4}`,
  prayer_request: `Private prayer ${i}`, created_at: '',
}));
const serialize = (value) => JSON.parse(JSON.stringify(value));

test('late arrivals never move existing members, disappear, duplicate, or mutate input', () => {
  for (let size = 2; size <= 10; size++) for (const mode of ['team', 'random']) {
    for (const initial of [0, 1, size - 1, size, size * 2 + 1]) {
      const original = matching.createPrayerGroups(members(initial), size, mode);
      const before = JSON.stringify(original);
      for (const extra of [0, 1, 2, size - 1, size, size * 3]) {
        const all = members(initial + extra);
        const result = matching.addLateParticipants(original, all, size, mode);
        if (original.length) assert.equal(result.length, original.length);
        const assigned = result.flatMap((group) => group.members.map((member) => member.id));
        assert.equal(assigned.length, all.length);
        assert.equal(new Set(assigned).size, all.length);
        for (const previous of original) {
          const next = result.find((group) => group.groupNumber === previous.groupNumber);
          assert.deepEqual(serialize(next.members.slice(0, previous.members.length)), serialize(previous.members));
        }
        assert.equal(JSON.stringify(original), before);
        assert.deepEqual(serialize(matching.addLateParticipants(result, all, size, mode)), serialize(result));
      }
    }
  }
});

test('four matched plus three late arrivals preserves the two groups and fills them evenly', () => {
  const all = members(7);
  const original = [{ groupNumber: 1, members: all.slice(0, 2) }, { groupNumber: 2, members: all.slice(2, 4) }];
  const result = matching.addLateParticipants(original, all, 2, 'team');
  assert.deepEqual(serialize(result.map((group) => group.members.length).sort()), [3, 4]);
});

test('display payload includes only names, synthetic keys, and pending count', () => {
  const all = members(7);
  const snapshot = display.toDisplaySnapshot(all, { id: 'round', groups: matching.createPrayerGroups(all.slice(0, 4), 2) });
  assert.equal(snapshot.pendingCount, 3);
  assert.equal(JSON.stringify(snapshot).includes('private-id'), false);
  assert.equal(JSON.stringify(snapshot).includes('Private prayer'), false);
  assert.equal(JSON.stringify(snapshot).includes('Team '), false);
});


test('edit tokens reject missing, tampered, expired and other participant tokens', () => {
  process.env.ADMIN_PASSWORD = 'local-test-only';
  const access = load('src/lib/participant-access.ts', {
    'server-only': {}, 'node:crypto': require('node:crypto'),
    'next/headers': {}, './auth': {},
  });
  const token = access.editToken('one');
  assert.equal(access.validEditToken('one', token), true);
  assert.equal(access.validEditToken('two', token), false);
  assert.equal(access.validEditToken('one', token + 'a'), false);
  assert.equal(access.validEditToken('one', ''), false);
  assert.equal(access.validEditToken('one', access.editToken('one', Date.now()-1)), false);
});

test('shared draw requires admin, passes the displayed revision, and reports conflicts', async () => {
  let admin = false, calls = 0, conflict = false;
  const actions = load('src/app/display/actions.ts', {
    'next/cache': { revalidatePath() {} },
    '@/lib/auth': { isAdmin: async () => admin },
    '@/lib/event': { eventCommand: async (revision, operation) => {
      assert.equal(revision, 17); assert.equal(operation, 'draw'); calls++;
      if (conflict) throw new Error('changed');
    } },
  });
  assert.equal((await actions.prepareDrawAction(17)).requiresAdmin, true);
  assert.equal(calls, 0);
  admin = true;
  assert.equal((await actions.prepareDrawAction(17)).status, 'success');
  conflict = true;
  assert.equal((await actions.prepareDrawAction(17)).status, 'error');
  assert.equal(calls, 2);
});

test('a newly opened display never reveals results during a shared draw', () => {
  const start = '2026-10-25T12:00:00.000Z';
  assert.equal(display.getDisplayPhase(false, null, start), 'idle');
  assert.equal(display.getDisplayPhase(true, null, start), 'ready');
  assert.equal(display.getDisplayPhase(true, start, start), 'drawing');
  assert.equal(display.getDisplayPhase(true, start, '2026-10-25T12:00:03.199Z'), 'drawing');
  assert.equal(display.getDisplayPhase(true, start, '2026-10-25T12:00:03.200Z'), 'revealed');
});
