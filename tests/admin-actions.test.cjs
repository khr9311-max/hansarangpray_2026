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
    exports, process, Error, console: { error() {} },
    require(name) {
      if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const matching = load('src/lib/matching.ts');
const types = load('src/lib/types.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const form = (values = {}) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, String(value));
  return result;
};
const people = () => Object.freeze(Array.from({ length: 7 }, (_, i) => Object.freeze({
  id: `id-${i}`, name: `Person ${i}`, team: `Team ${i % 3}`,
  prayer_request: `Prayer ${i}`, created_at: '', edit_version: 0,
})));

function eventHarness({ data = 3, error = null, supabase = false } = {}) {
  const calls = [], invalidatedTags = [];
  class StorageError extends Error {
    constructor(code, message = 'Storage request failed') { super(message); this.code = code; }
  }
  const event = load('src/lib/event.ts', {
    'server-only': {}, react: { cache: fn => fn },
    'next/cache': { unstable_cache: fn => fn, revalidateTag: tag => invalidatedTags.push(tag) },
    './storage': {
      StorageError, usesSupabase: () => supabase,
      storageRequest: async (operation, payload) => {
        calls.push({ operation, payload: payload === undefined ? undefined : clone(payload) });
        if (error) throw new StorageError(error.code, error.message);
        return data;
      },
    },
  });
  return { event, calls, invalidatedTags };
}

test('a Supabase change check requests only the revision, while Sheets shares the snapshot', async () => {
  for (const supabase of [true, false]) {
    const h = eventHarness({ supabase, data: { revision: 12 } });
    assert.equal(await h.event.getEventRevision(), 12);
    assert.deepEqual(h.calls.map(call => call.operation), [supabase ? 'revision' : 'snapshot']);
  }
});

function harness({ admin = true, count = 3, conflict = false, active = true, participants = people(), revision = 17 } = {}) {
  const writes = [], appends = [], reads = [], invalidations = [];
  const { event } = eventHarness();
  const actions = load('src/app/admin/actions.ts', {
    'next/cache': { revalidatePath: (...args) => invalidations.push(args) },
    '@/lib/auth': {
      assertAdmin: async () => { if (!admin) throw new Error('Authentication required'); },
      signIn: async () => admin, signOut: async () => {},
    },
    '@/lib/event': {
      readRevision: data => event.readRevision(data),
      appendParticipants: async revision => {
        appends.push(revision); if (conflict) throw new Error('Stale event'); return count;
      },
      eventCommand: async (revision, operation, payload) => {
        writes.push({ revision, operation, payload: clone(payload) });
        if (conflict) throw new Error('Stale event');
      },
      getEventSnapshot: async () => {
        reads.push(true); return { participants, round: active ? { id: 'round' } : null, revision };
      },
    },
    '@/lib/matching': matching,
    '@/lib/types': types,
  });
  return { actions, writes, appends, reads, invalidations, participants };
}

test('append invokes only the preserve-groups operation and reports appended count or no-op', async () => {
  for (const count of [0, 3]) {
    const h = harness({ count });
    const result = await h.actions.applyParticipantsAction(form({ revision: 17 }));
    assert.equal(result.error, undefined);
    assert.match(result.message, count ? /3명을 기존 조에 추가/ : /추가로 반영할 참여자가 없습니다/);
    assert.deepEqual(h.appends, [17]);
    assert.equal(h.writes.length, 0);
    assert.equal(h.reads.length, 0);
    assert.equal(h.invalidations.length, 3);
  }
});

test('all administrator mutations require authentication before writing', async () => {
  const h = harness({ admin: false });
  const requests = [
    ['applyParticipantsAction', { revision: 17 }],
    ['startMatchingDrawAction', { revision: 17, target_size: 4, mode: 'team', confirm: '재편성' }],
    ['drawAction', { revision: 17 }], ['unpublishAction', { revision: 17 }],
    ['restoreRoundAction', { revision: 17, round_id: '38a8a4fe-0b74-4589-9cf0-3ec119c3981d' }],
    ['deleteParticipantAction', { revision: 17, id: 'id-0' }],
    ['resetAllAction', { revision: 17, confirm: '삭제' }],
  ];
  for (const [name, values] of requests) {
    const result = await h.actions[name](form(values));
    assert.equal(typeof result.error, 'string'); assert.equal(result.message, undefined);
  }
  assert.equal(h.appends.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.reads.length, 0);
});

test('append conflicts report failure once, without retry or success invalidation', async () => {
  const h = harness({ conflict: true });
  const result = await h.actions.applyParticipantsAction(form({ revision: 17 }));
  assert.equal(result.error, 'Stale event'); assert.equal(result.message, undefined);
  assert.deepEqual(h.appends, [17]); assert.equal(h.writes.length, 0);
  assert.equal(h.invalidations.length, 0);
});

test('rematching validates size, mode, nonempty roster and confirmation before writing', async () => {
  for (const values of [
    { target_size: 1, mode: 'team' }, { target_size: 11, mode: 'team' },
    { target_size: 2.5, mode: 'team' }, { target_size: 'bad', mode: 'team' },
    { target_size: 4, mode: 'bad' }, { target_size: 4, mode: 'team', confirm: '' },
  ]) {
    const h = harness();
    const result = await h.actions.startMatchingDrawAction(form({ revision: 17, confirm: '재편성', ...values }));
    assert.equal(typeof result.error, 'string'); assert.equal(h.writes.length, 0);
  }
  const empty = harness({ participants: [] });
  assert.match((await empty.actions.startMatchingDrawAction(form({ revision: 17, target_size: 4, mode: 'team', confirm: '재편성' }))).error, /참가자가 없습니다/);
  assert.equal(empty.writes.length, 0);
});

test('initial matching and confirmed replacement support 2-10 people in both modes without changing the input roster', async () => {
  for (const active of [false, true]) for (const mode of ['team', 'random']) for (let size = 2; size <= 10; size++) {
    const h = harness({ active });
    const before = JSON.stringify(h.participants);
    const result = await h.actions.startMatchingDrawAction(form({ revision: 17, target_size: size, mode, ...(active ? { confirm: '재편성' } : {}) }));
    assert.equal(result.error, undefined); assert.match(result.message, /출력 화면에 결과가 공개/);
    assert.equal(h.appends.length, 0); assert.equal(h.writes.length, 1);
    const command = h.writes[0];
    assert.equal(command.operation, 'publish'); assert.equal(command.revision, 17);
    assert.equal(command.payload.target, size); assert.equal(command.payload.mode, mode);
    assert.equal(command.payload.draw, true);
    assert.deepEqual(command.payload.assignments.map(row => row.participant_id).sort(), h.participants.map(p => p.id).sort());
    assert.ok(command.payload.assignments.every(row => Number.isInteger(row.group_number) && row.group_number > 0));
    assert.equal(JSON.stringify(h.participants), before);
  }
});

test('a stale replacement is rejected once rather than silently recomputed and retried', async () => {
  const h = harness({ conflict: true });
  const result = await h.actions.startMatchingDrawAction(form({ revision: 17, target_size: 4, mode: 'team', confirm: '재편성' }));
  assert.equal(result.error, 'Stale event'); assert.equal(result.message, undefined);
  assert.equal(h.writes.length, 1); assert.equal(h.reads.length, 1);
  assert.equal(h.invalidations.length, 0);
});

test('matching does not submit assignments computed from a different roster revision', async () => {
  const h = harness({ revision: 16 });
  const result = await h.actions.startMatchingDrawAction(form({ revision: 17, target_size: 4, mode: 'team', confirm: '재편성' }));
  assert.match(result.error, /갱신된 명단/);
  assert.equal(h.writes.length, 0);
});

test('restoring a dated round sends only its id and revision, without regenerating groups', async () => {
  const h = harness();
  const roundId = '38a8a4fe-0b74-4589-9cf0-3ec119c3981d';
  assert.ok((await h.actions.restoreRoundAction(form({ revision: 17, round_id: 'invalid' }))).error);
  assert.equal(h.writes.length, 0);
  assert.match((await h.actions.restoreRoundAction(form({ revision: 17, round_id: roundId }))).message, /출력 화면/);
  assert.deepEqual(h.writes, [{ revision: 17, operation: 'restore', payload: { roundId } }]);
  assert.equal(h.reads.length, 0);
});

test('archiving the active event requires its exact confirmation and uses the archive command', async () => {
  const h = harness();
  for (const confirm of ['', '재편성', ' 삭제 ', '초기화']) {
    assert.equal(typeof (await h.actions.resetAllAction(form({ revision: 17, confirm }))).error, 'string');
  }
  assert.equal(h.writes.length, 0);
  const result = await h.actions.resetAllAction(form({ revision: 17, confirm: '삭제' }));
  assert.equal(result.error, undefined);
  assert.match(result.message, /관리자 이력 관리/);
  assert.deepEqual(h.writes, [{ revision: 17, operation: 'archive_reset', payload: { confirm: '삭제' } }]);
  assert.ok(h.invalidations.some(([path]) => path === '/admin/history'));
});

test('hiding one participant uses the archive command and refreshes history', async () => {
  const h = harness();
  const result = await h.actions.deleteParticipantAction(form({ revision: 17, id: 'id-0' }));
  assert.match(result.message, /관리자 이력 관리/);
  assert.deepEqual(h.writes, [{ revision: 17, operation: 'archive_delete', payload: { id: 'id-0' } }]);
  assert.ok(h.invalidations.some(([path]) => path === '/admin/history'));
});

test('revision parsing rejects omitted, blank, malformed and unsafe versions while accepting zero', () => {
  const { event, calls } = eventHarness();
  assert.equal(event.readRevision(form({ revision: '0' })), 0);
  assert.equal(event.readRevision(form({ revision: '17' })), 17);
  assert.throws(() => event.readRevision(form()));
  for (const revision of ['', ' ', '-1', '+1', '1.5', '1e3', '0x10', 'NaN', '9007199254740992']) {
    assert.throws(() => event.readRevision(form({ revision })), `Rejected ${revision}`);
  }
  assert.equal(calls.length, 0);
});

test('missing revisions cannot trigger append or destructive administrator writes', async () => {
  const h = harness();
  for (const name of ['applyParticipantsAction', 'drawAction', 'unpublishAction', 'deleteParticipantAction', 'resetAllAction']) {
    const result = await h.actions[name](form({ id: 'id-0', confirm: '삭제' }));
    assert.equal(typeof result.error, 'string'); assert.equal(result.message, undefined);
  }
  assert.equal(h.appends.length, 0); assert.equal(h.writes.length, 0);
});

test('append storage request maps conflicts and missing-round errors without retrying, and accepts zero', async () => {
  for (const error of [{ code: '40001' }, { code: 'P0002' }, { code: 'XX000' }]) {
    const h = eventHarness({ error });
    await assert.rejects(h.event.appendParticipants(17));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].operation, 'append');
    assert.deepEqual(h.calls[0].payload, { revision: 17 });
    assert.deepEqual(h.invalidatedTags, []);
  }
  const noOp = eventHarness({ data: 0 });
  assert.equal(await noOp.event.appendParticipants(17), 0);
  assert.equal(noOp.calls.length, 1);
  assert.deepEqual(noOp.invalidatedTags, ['prayer-event']);
});
