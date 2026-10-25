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
    exports, process, console: { error() {} },
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

test('four matched plus three late arrivals preserves the two pairs and creates a new group', () => {
  const all = members(7);
  const original = [{ groupNumber: 1, members: all.slice(0, 2) }, { groupNumber: 2, members: all.slice(2, 4) }];
  const result = matching.addLateParticipants(original, all, 2, 'team');
  assert.deepEqual(serialize(result.map((group) => group.members.length)), [2, 2, 3]);
});

test('display payload includes only names, synthetic keys, and pending count', () => {
  const all = members(7);
  const snapshot = display.toDisplaySnapshot(all, { id: 'round', groups: matching.createPrayerGroups(all.slice(0, 4), 2) });
  assert.equal(snapshot.pendingCount, 3);
  assert.equal(JSON.stringify(snapshot).includes('private-id'), false);
  assert.equal(JSON.stringify(snapshot).includes('Private prayer'), false);
  assert.equal(JSON.stringify(snapshot).includes('Team '), false);
});

function harness({ admin = true, pending = 3, rpcErrors = [], readError = false } = {}) {
  let all = members(4 + pending);
  let round = { id: 'round', mode: 'team', targetSize: 2, groups: matching.createPrayerGroups(all.slice(0, 4), 2) };
  let rpcCalls = 0;
  let adminClients = 0;
  const actions = load('src/app/display/actions.ts', {
    'next/cache': { revalidatePath() {} },
    '@/lib/auth': { isAdmin: async () => admin },
    '@/lib/queries': {
      getActiveRound: async () => { if (readError) throw new Error('offline'); return round; },
      getParticipants: async () => all,
    },
    '@/lib/matching': matching,
    '@/lib/display': display,
    '@/lib/supabase/server': { createAdminClient() {
      adminClients++;
      return { async rpc(name, args) {
        assert.equal(name, 'append_prayer_members');
        assert.equal(args.p_round_id, round.id);
        rpcCalls++;
        const error = rpcErrors.shift();
        if (error) return { error };
        for (const assignment of args.p_assignments) {
          let group = round.groups.find((g) => g.groupNumber === assignment.group_number);
          if (!group) { group = { groupNumber: assignment.group_number, members: [] }; round.groups.push(group); }
          group.members.push(all.find((member) => member.id === assignment.participant_id));
        }
        return { error: null };
      } };
    } },
  });
  return { run: actions.prepareDrawAction, get rpcCalls() { return rpcCalls; }, get adminClients() { return adminClients; } };
}

test('draw saves all late arrivals before returning results; replay does not insert twice', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, 'success');
  assert.equal(result.snapshot.pendingCount, 0);
  assert.equal(result.snapshot.round.groups.flatMap((g) => g.members).length, 7);
  assert.equal(h.rpcCalls, 1);
  assert.equal((await h.run()).status, 'success');
  assert.equal(h.rpcCalls, 1);
});

test('unauthenticated draws cannot assign late participants; unchanged results can replay', async () => {
  const h = harness({ admin: false });
  assert.equal((await h.run()).requiresAdmin, true);
  assert.equal(h.adminClients, 0);
  const replay = harness({ admin: false, pending: 0 });
  assert.equal((await replay.run()).status, 'success');
  assert.equal(replay.adminClients, 0);
});

test('concurrent roster changes retry; storage/read failures never report successful draw', async () => {
  const retry = harness({ rpcErrors: [{ code: '40001' }] });
  assert.equal((await retry.run()).status, 'success');
  assert.equal(retry.rpcCalls, 2);
  const exhausted = harness({ rpcErrors: Array(3).fill({ code: '40001' }) });
  assert.equal((await exhausted.run()).status, 'error');
  assert.equal(exhausted.rpcCalls, 3);
  assert.equal((await harness({ rpcErrors: [{ code: 'XX000' }] }).run()).status, 'error');
  assert.equal((await harness({ readError: true }).run()).status, 'error');
});
