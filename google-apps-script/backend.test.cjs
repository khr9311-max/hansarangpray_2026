const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const clone = value => JSON.parse(JSON.stringify(value));
const secret = 'test-only-private-key-with-at-least-32-characters';
function empty() {
  return { participants: [], match_rounds: [], match_groups: [], match_members: [],
    match_control: [{ id: true, revision: 0, draw_started_at: null }], participant_submissions: [] };
}
function harness() {
  let stored = empty(), writes = 0, locks = 0, failWrite = false;
  let clock = Date.now();
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    console, Date: TestDate, Utilities: { getUuid: randomUUID },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'SHEETS_API_SECRET' ? secret : 'sheet-id' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { locks++; return true; }, hasLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => ({}) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) }
  });
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), context);
  context.readState = () => clone(stored);
  context.readTable = (_, name) => clone(stored[name]);
  context.commitState = (_, before, after) => {
    writes++;
    if (failWrite) throw new Error('upstream response must not leak');
    assert.deepEqual(clone(before), stored);
    stored = clone(after);
  };
  function call(operation, payload = {}, key = secret) {
    return JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ secret: key, operation, payload }) } }));
  }
  function ok(operation, payload) {
    const response = call(operation, payload);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  }
  function submit(name = '참가자') { return ok('submit', { requestId: randomUUID(), name, team: '전도팀', prayer: '기도제목' }); }
  function command(operation, payload = {}, revision = stored.match_control[0].revision) { return call('command', { revision, operation, payload }); }
  function publish(target = 2, mode = 'team', draw) {
    return command('publish', { target, mode, draw, confirm: '재편성', assignments: stored.participants.map((p, i) => ({ participant_id: p.id, group_number: Math.floor(i / target) + 1 })) });
  }
  return { context, call, ok, submit, command, publish, state: () => clone(stored), writes: () => writes, locks: () => locks, now: () => clock,
    advanceTime: milliseconds => { clock += milliseconds; }, failWrites: () => { failWrite = true; } };
}

test('authentication rejects requests before accessing storage; GET reveals no records', () => {
  const h = harness();
  h.submit('숨겨진 이름');
  const before = h.locks();
  assert.equal(h.call('export', {}, 'wrong').error.code, '401');
  assert.equal(h.locks(), before);
  assert.deepEqual(JSON.parse(h.context.doGet()), { ok: true, service: 'jjak-gido-google-sheets', version: 1 });
});

test('submission retries return the original participant and increment revision once', () => {
  const h = harness(), requestId = randomUUID();
  const first = h.ok('submit', { requestId, name: '이름', team: '전도팀', prayer: '=IMPORTDATA("private")' });
  const before = h.state(), writes = h.writes();
  assert.equal(h.ok('submit', { requestId, name: '재시도 이름', team: '전도팀', prayer: '다른 내용' }), first);
  assert.deepEqual(h.state(), before);
  assert.equal(h.writes(), writes);
  assert.equal(h.call('submit', { requestId: 'invalid', name: '이름', team: '전도팀', prayer: '기도' }).error.code, '22023');
  assert.equal(h.state().match_control[0].revision, 1);
});

test('publish covers all targets; stale commands and malformed assignments never commit', () => {
  const h = harness();
  for (let i = 0; i < 23; i++) h.submit('이름' + i);
  for (let target = 2; target <= 10; target++) {
    assert.equal(h.publish(target, target % 2 ? 'team' : 'random').ok, true);
    const s = h.state(), active = s.match_rounds.filter(r => r.is_active);
    assert.equal(active.length, 1);
    const ids = new Set(s.match_groups.filter(g => g.round_id === active[0].id).map(g => g.id));
    const assigned = s.match_members.filter(m => ids.has(m.group_id)).map(m => m.participant_id);
    assert.equal(new Set(assigned).size, 23);
    assert.equal(assigned.length, 23);
  }
  const before = h.state();
  for (const operation of ['draw', 'delete', 'unpublish', 'reset', 'publish']) {
    assert.equal(h.command(operation, { confirm: '삭제' }, 0).error.code, '40001');
  }
  const revision = before.match_control[0].revision;
  assert.equal(h.command('publish', { target: 2, mode: 'team', assignments: [] }, revision).error.code, '22023');
  assert.equal(h.command('publish', { target: 2, mode: 'team', confirm: '재편성', assignments: [] }, revision).error.code, '40001');
  assert.deepEqual(h.state(), before);
});

test('signups wait for explicit append; append preserves groups, reveal and old memberships', () => {
  const h = harness();
  assert.equal(h.call('append', { revision: 0 }).error.code, 'P0002');
  for (let i = 0; i < 6; i++) h.submit('기존' + i);
  assert.equal(h.publish(2).ok, true);
  const requestedAt = h.now();
  assert.equal(h.command('draw').ok, true);
  const old = h.state();
  assert.ok(Date.parse(old.match_control[0].draw_started_at) >= requestedAt + 8000, 'shared start leaves time for polling clients');
  for (let i = 0; i < 13; i++) h.submit('추가' + i);
  assert.deepEqual(h.state().match_members, old.match_members);
  assert.equal(h.command('draw').error.code, '40001', 'another admin cannot restart a pending or active draw');
  assert.equal(h.state().match_members.length, 6, 'draw must only reveal saved groups');
  const beforeAppend = h.state();
  assert.equal(h.ok('append', { revision: beforeAppend.match_control[0].revision }), 13);
  const after = h.state();
  assert.deepEqual(after.match_groups, old.match_groups);
  assert.deepEqual(after.match_members.slice(0, 6), old.match_members);
  assert.equal(after.match_members.length, 19);
  assert.equal(new Set(after.match_members.map(m => m.participant_id)).size, 19);
  assert.equal(after.match_control[0].draw_started_at, beforeAppend.match_control[0].draw_started_at);
  const counts = after.match_groups.map(g => after.match_members.filter(m => m.group_id === g.id).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  const writes = h.writes();
  assert.equal(h.ok('append', { revision: after.match_control[0].revision }), 0);
  assert.deepEqual(h.state(), after);
  assert.equal(h.writes(), writes);
  assert.equal(h.call('append', { revision: beforeAppend.match_control[0].revision }).error.code, '40001');
});

test('editing preserves IDs and membership, rejects stale changes, deletion cascades retry tokens', () => {
  const h = harness(), id = h.submit();
  h.submit(); h.publish();
  const oldMembers = h.state().match_members;
  assert.equal(h.ok('edit', { id, version: 0, name: '수정 이름', team: '운영팀', prayer: '수정 기도' }), 1);
  assert.deepEqual(h.state().match_members, oldMembers);
  assert.equal(h.call('edit', { id, version: 0, name: '이름', team: '전도팀', prayer: '기도' }).error.code, '40001');
  const snapshot = h.ok('snapshot');
  assert.equal(snapshot.round.groups[0].members.find(p => p.id === id).name, '수정 이름');
  assert.equal(h.command('delete', { id }).ok, true);
  assert.ok(h.state().match_members.every(m => m.participant_id !== id));
  assert.ok(h.state().participant_submissions.every(s => s.participant_id !== id));
  assert.equal(h.command('reset', { confirm: '삭제' }).ok, true);
  const after = h.state();
  for (const [table, rows] of Object.entries(after)) if (table !== 'match_control') assert.equal(rows.length, 0);
  assert.equal(after.match_control[0].draw_started_at, null);
});

test('import preserves IDs, history, edit versions and retry tokens; rejects corrupt or nonempty target', () => {
  const origin = harness(), id = origin.submit(); origin.submit(); origin.publish();
  origin.ok('edit', { id, version: 0, name: '옮길 이름', team: '운영팀', prayer: '원래 기도' });
  const original = origin.ok('export');
  const target = harness();
  assert.equal(target.ok('import', { data: original }).participants, 2);
  assert.deepEqual(target.ok('export'), original);
  assert.equal(target.ok('import', { data: original }).participants, 2, 'same import is an idempotent retry');
  const reordered = clone(original); reordered.participants.reverse();
  assert.equal(target.ok('import', { data: reordered }).participants, 2, 'equivalent reordered import is also an idempotent retry');
  const changed = clone(original); changed.participants[0].name = '교체 시도';
  assert.equal(target.call('import', { data: changed }).error.code, '409');
  const corrupt = clone(original); corrupt.match_members[0].participant_id = randomUUID();
  assert.equal(harness().call('import', { data: corrupt }).error.code, '22023');
  assert.equal(harness().call('import', {}).error.code, '22023');
});

test('history is private metadata, newest first, includes active and excludes unusable empty rounds', () => {
  const h = harness();
  assert.deepEqual(h.ok('history'), []);
  const id = h.submit(); h.submit();
  assert.equal(h.publish(2).ok, true);
  const first = h.state().match_rounds[0].id;
  h.advanceTime(1000);
  assert.equal(h.publish(3, 'random').ok, true);
  const second = h.state().match_rounds[1].id;
  const writes = h.writes();
  assert.deepEqual(h.ok('history'), [
    { id: second, mode: 'random', targetSize: 3, createdAt: h.state().match_rounds[1].created_at, groupCount: 1, memberCount: 2, isActive: true },
    { id: first, mode: 'team', targetSize: 2, createdAt: h.state().match_rounds[0].created_at, groupCount: 1, memberCount: 2, isActive: false },
  ]);
  assert.equal(h.writes(), writes);
  assert.equal(h.call('history', {}, 'wrong').error.code, '401');
  const publicSnapshot = h.ok('snapshot');
  assert.deepEqual(Object.keys(publicSnapshot).sort(), ['drawStartedAt', 'participants', 'revision', 'round', 'serverTime']);
  assert.ok(!JSON.stringify(publicSnapshot).includes(first), 'public snapshot must not expose past round metadata');
  assert.equal(h.command('delete', { id }).ok, true);
  assert.equal(h.command('delete', { id: h.state().participants[0].id }).ok, true);
  assert.deepEqual(h.ok('history'), []);
  assert.equal(h.command('restore', { roundId: first }).error.code, 'P0002');
});

test('restore reactivates the chosen saved round and schedules a draw without touching memberships', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.submit('기존' + i);
  h.publish(2);
  const original = h.state(), firstId = original.match_rounds[0].id;
  h.advanceTime(1000); h.publish(4, 'random');
  h.submit('늦게온 참가자');
  const before = h.state(), staleRevision = before.match_control[0].revision - 1;
  assert.equal(h.command('restore', { roundId: firstId }, staleRevision).error.code, '40001');
  assert.equal(h.command('restore', { roundId: randomUUID() }).error.code, 'P0002');
  assert.deepEqual(h.state(), before);
  const writes = h.writes(), requestedAt = h.now();
  assert.equal(h.command('restore', { roundId: firstId }).ok, true);
  const after = h.state();
  assert.equal(h.writes(), writes + 1, 'switch and draw schedule commit once');
  assert.deepEqual(after.participants, before.participants);
  assert.deepEqual(after.match_groups, before.match_groups);
  assert.deepEqual(after.match_members, before.match_members);
  assert.deepEqual(after.participant_submissions, before.participant_submissions);
  assert.equal(after.match_rounds.find(r => r.is_active).id, firstId);
  assert.equal(after.match_rounds.find(r => r.id === firstId).created_at, original.match_rounds[0].created_at);
  assert.equal(after.match_control[0].revision, before.match_control[0].revision + 1);
  assert.equal(Date.parse(after.match_control[0].draw_started_at), requestedAt + 8000);
  const snapshot = h.ok('snapshot');
  assert.equal(snapshot.round.id, firstId);
  assert.equal(snapshot.round.groups.flatMap(g => g.members).length, 5, 'pending signup must remain unassigned');
});

test('single-button publish schedules draw atomically and pending draws reject replacement or restart', () => {
  const h = harness(); h.submit(); h.submit();
  const before = h.state(), writes = h.writes(), requestedAt = h.now();
  assert.equal(h.publish(2, 'team', true).ok, true);
  const after = h.state();
  assert.equal(h.writes(), writes + 1);
  assert.equal(after.match_control[0].revision, before.match_control[0].revision + 1);
  assert.equal(Date.parse(after.match_control[0].draw_started_at), requestedAt + 8000);
  const roundId = after.match_rounds[0].id;
  for (const attempt of [() => h.command('draw'), () => h.command('restore', { roundId }), () => h.publish(3, 'random')]) {
    assert.equal(attempt().error.code, '40001');
    assert.deepEqual(h.state(), after);
  }
  h.advanceTime(8000 + 3100);
  assert.equal(h.command('restore', { roundId }).error.code, '40001', 'replacement is also blocked during the shake');
  h.advanceTime(100);
  assert.equal(h.publish(3, 'random', false).ok, true);
  assert.equal(h.state().match_control[0].draw_started_at, null, 'legacy publish still waits for explicit draw');
  const saved = h.state();
  assert.equal(h.publish(3, 'team', 'true').error.code, '22023');
  assert.deepEqual(h.state(), saved);
});

test('upstream commit failure never reports success or leaks upstream details', () => {
  const h = harness(), before = h.state(); h.failWrites();
  const response = h.call('submit', { requestId: randomUUID(), name: '실패 이름', team: '운영팀', prayer: '비공개 기도' });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, '503');
  assert.ok(!response.error.message.includes('upstream'));
  assert.deepEqual(h.state(), before);
});

test('batch update stores text literally, clears removed rows, and includes control in same atomic request', () => {
  const h = harness(), c = h.context;
  const before = empty(), after = empty();
  before.participants.push({ id: randomUUID(), name: '삭제', team: '팀', prayer_request: '기도', created_at: new Date().toISOString(), edit_version: 0 });
  after.participants.push({ id: randomUUID(), name: '=1+1', team: '팀', prayer_request: '=IMPORTDATA("private")', created_at: new Date().toISOString(), edit_version: 0 });
  after.match_control[0].revision = 1;
  let sent;
  c.ScriptApp = { getOAuthToken: () => 'test-token' };
  c.UrlFetchApp = { fetch: (url, options) => { sent = { url, options }; return { getResponseCode: () => 200 }; } };
  const source = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
  const originalCommit = source.slice(source.indexOf('function commitState('), source.indexOf('\nfunction validatePerson('));
  vm.runInContext(originalCommit, c);
  const sheetNames = Object.keys(before);
  const spreadsheet = { getId: () => 'private-sheet', getSheetByName: name => ({ getSheetId: () => sheetNames.indexOf(name), getLastRow: () => 4, getMaxRows: () => 1000 }) };
  c.commitState(spreadsheet, before, after);
  const body = JSON.parse(sent.options.payload);
  assert.equal(body.requests.length, 2);
  const participantWrite = body.requests[0].updateCells;
  assert.equal(participantWrite.rows[0].values[1].userEnteredValue.stringValue, '=1+1');
  assert.equal(participantWrite.rows[0].values[3].userEnteredValue.stringValue, '=IMPORTDATA("private")');
  assert.equal(participantWrite.range.endRowIndex, 4, 'range includes stale rows to clear them');
  assert.equal(participantWrite.fields, 'userEnteredValue');
  assert.equal(body.requests[1].updateCells.rows[0].values[1].userEnteredValue.numberValue, 1);
  c.UrlFetchApp.fetch = () => ({ getResponseCode: () => 403 });
  assert.throws(() => c.commitState(spreadsheet, before, after), error => error.code === '503');
});
