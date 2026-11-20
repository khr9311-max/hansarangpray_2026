const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const clone = value => JSON.parse(JSON.stringify(value));
const secret = 'test-only-private-key-with-at-least-32-characters';
function empty() {
  return { participants: [], match_rounds: [], match_groups: [], match_members: [],
    match_control: [{ id: true, revision: 0, draw_started_at: null }], participant_submissions: [], prayer_checkins: [] };
}
function harness() {
  let stored = empty(), writes = 0, locks = 0, failWrite = false;
  const properties = new Map([['SHEETS_API_SECRET', secret], ['SPREADSHEET_ID', 'sheet-id']]);
  let clock = Date.now();
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    console, Date: TestDate, Utilities: { getUuid: randomUUID },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { locks++; return true; }, hasLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => ({}) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) }
  });
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), context);
  context.readState = () => clone(stored);
  context.readSubmissionState = () => clone(stored);
  context.readTable = (_, name) => clone(stored[name]);
  context.commitState = (_, before, after) => {
    writes++;
    if (failWrite) throw new Error('upstream response must not leak');
    assert.deepEqual(clone(before), stored);
    stored = clone(after);
  };
  context.commitSubmissionState = context.commitState;
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
  function check(id, week, checked, roundId = stored.match_rounds.find(r => r.is_active)?.id) { return call('check_prayer', { id, roundId, week, checked }); }
  return { context, call, ok, submit, command, publish, state: () => clone(stored), writes: () => writes, locks: () => locks, now: () => clock,
    check, advanceTime: milliseconds => { clock += milliseconds; }, failWrites: () => { failWrite = true; } };
}

test('authentication rejects requests before accessing storage; GET reveals no records', () => {
  const h = harness();
  h.submit('숨겨진 이름');
  const before = h.locks();
  assert.equal(h.call('export', {}, 'wrong').error.code, '401');
  assert.equal(h.locks(), before);
  assert.deepEqual(JSON.parse(h.context.doGet()), { ok: true, service: 'jjak-gido-google-sheets', version: 1 });
});

test('the migration gate blocks writes under the submit lock and keeps export available', () => {
  const h = harness();
  h.submit();
  const before = h.state(), locks = h.locks();
  assert.equal(h.call('migration_set_read_only', { readOnly: true }, 'wrong').error.code, '401');
  assert.equal(h.locks(), locks);
  assert.deepEqual(h.ok('migration_status'), { readOnly: false });
  assert.equal(h.call('migration_set_read_only', { readOnly: 'true' }).error.code, '22023');
  assert.deepEqual(h.ok('migration_set_read_only', { readOnly: true }), { readOnly: true });
  assert.equal(h.call('submit_batch', {}).error.code, '55000');
  assert.equal(h.call('command', {}).error.code, '55000');
  assert.deepEqual(h.ok('export'), before);
  assert.deepEqual(h.ok('migration_set_read_only', { readOnly: false }), { readOnly: false });
  h.submit();
  assert.equal(h.state().participants.length, before.participants.length + 1);
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

test('three batches of 50 submissions each commit once and keep existing groups and draw untouched', () => {
  const h = harness(); h.submit(); h.submit(); h.publish(); h.command('draw');
  const original = h.state(), writes = h.writes();
  for (let burst = 0; burst < 3; burst++) {
    const submissions = Array.from({ length: 50 }, (_, i) => ({ requestId: randomUUID(), name: `가상${burst}-${i}`, team: '운영팀', prayer: '가상 기도제목' }));
    const results = h.ok('submit_batch', { submissions });
    assert.equal(results.length, 50);
    assert.deepEqual(results.map(result => result.requestId), submissions.map(submission => submission.requestId));
    assert.equal(new Set(results.map(result => result.participantId)).size, 50);
    const stored = h.state();
    assert.equal(stored.participants.length, original.participants.length + 50 * (burst + 1));
    assert.equal(stored.match_control[0].revision, original.match_control[0].revision + 50 * (burst + 1));
    assert.equal(stored.match_control[0].draw_started_at, original.match_control[0].draw_started_at);
    assert.deepEqual(stored.match_rounds, original.match_rounds);
    assert.deepEqual(stored.match_groups, original.match_groups);
    assert.deepEqual(stored.match_members, original.match_members);
  }
  assert.equal(h.writes(), writes + 3);
});

test('batch submission retries and duplicate keys inside a batch return one original participant', () => {
  const h = harness(), requestId = randomUUID();
  const first = { requestId, name: '처음 이름', team: '전도팀', prayer: '처음 기도' };
  const existingId = h.ok('submit', first), newRequest = { ...first, requestId: randomUUID(), name: '새 이름' };
  const before = h.state(), writes = h.writes();
  const result = h.ok('submit_batch', { submissions: [first, { ...first, name: '중복 다른 이름' }, newRequest, newRequest] });
  assert.deepEqual(result.map(row => row.participantId), [existingId, existingId, result[2].participantId, result[2].participantId]);
  assert.equal(h.state().participants.length, 2);
  assert.equal(h.state().participant_submissions.length, 2);
  assert.equal(h.state().match_control[0].revision, before.match_control[0].revision + 1);
  assert.equal(h.writes(), writes + 1);
  const after = h.state();
  assert.deepEqual(h.ok('submit_batch', { submissions: [first, newRequest] }), [result[0], result[2]]);
  assert.deepEqual(h.state(), after);
  assert.equal(h.writes(), writes + 1);
});

test('invalid or oversized batches never partially store earlier valid submissions', () => {
  const h = harness(), before = h.state(), writes = h.writes();
  const valid = { requestId: randomUUID(), name: '올바른 이름', team: '운영팀', prayer: '기도' };
  for (const submissions of [undefined, null, [], [valid, null], [valid, { ...valid, requestId: 'bad' }],
    [valid, { ...valid, requestId: randomUUID(), prayer: '' }], Array.from({ length: 51 }, () => ({ ...valid, requestId: randomUUID() }))]) {
    assert.equal(h.call('submit_batch', { submissions }).error.code, '22023');
    assert.deepEqual(h.state(), before);
  }
  assert.equal(h.writes(), writes);
});

test('fast submission adapter uses one limited Sheets GET and one append batch, preserving control draw', () => {
  const h = harness(), c = h.context; h.submit(); h.submit(); h.publish(); h.command('draw');
  const original = h.state(), data = clone(original), calls = [];
  // Simulate a native Sheets date, which submission must never read or rewrite.
  data.match_control[0].draw_started_at = 46330.75;
  const originalDraw = data.match_control[0].draw_started_at;
  const names = ['participants', 'participant_submissions', 'match_control'];
  const readColumns = { participants: ['id'], participant_submissions: ['request_id', 'participant_id'], match_control: ['id', 'revision'] };
  const sheetIds = Object.fromEntries(names.map((name, i) => [name, 100 + i]));
  const source = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
  vm.runInContext(source.slice(source.indexOf('function readSubmissionState('), source.indexOf('\nfunction applySubmissions(')), c);
  vm.runInContext(source.slice(source.indexOf('function commitSubmissionState('), source.indexOf('\nfunction commitState(')), c);
  c.ScriptApp = { getOAuthToken: () => 'synthetic-token' };
  c.SpreadsheetApp.openById = () => assert.fail('fast submission must not open SpreadsheetApp or read unrelated event tables');
  function effective(value) {
    return value === null ? {} : { effectiveValue: typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } };
  }
  function decode(cell) {
    const value = cell.userEnteredValue;
    return !value ? '' : Object.hasOwn(value, 'numberValue') ? value.numberValue : Object.hasOwn(value, 'boolValue') ? value.boolValue : value.stringValue;
  }
  c.UrlFetchApp = { fetch: (url, options) => {
    calls.push({ url, options });
    if (options.method === 'get') {
      assert.ok(!url.includes('match_rounds') && !url.includes('match_groups') && !url.includes('prayer_checkins'));
      assert.deepEqual(new URL(url).searchParams.getAll('ranges').sort(), ["'participants'!A:A", "'participant_submissions'!A:B", "'match_control'!A:B"].sort());
      const sheets = names.map(name => {
        const rows = [readColumns[name], ...data[name].map(record => readColumns[name].map(column => record[column]))];
        if (name === 'match_control') rows.splice(1, 0, ['', '']); // Preserve a physical gap before the actual control row.
        return { properties: { sheetId: sheetIds[name], title: name }, data: [{ rowData: rows.map(row => ({ values: row.map(effective) })) }] };
      });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ sheets }) };
    }
    assert.equal(options.method, 'post');
    const requests = JSON.parse(options.payload).requests;
    assert.equal(requests.length, 3);
    for (const name of ['participants', 'participant_submissions']) {
      const append = requests.find(request => request.appendCells?.sheetId === sheetIds[name]).appendCells;
      assert.equal(append.rows.length, 50);
      assert.equal(append.fields, 'userEnteredValue');
      for (const row of append.rows) data[name].push(Object.fromEntries(Array.from(c.TABLES[name]).map((column, i) => [column, decode(row.values[i])])));
    }
    const update = requests[2].updateCells;
    assert.deepEqual(update.range, { sheetId: sheetIds.match_control, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 });
    assert.equal(update.rows[0].values.length, 1, 'only revision is updated; draw_started_at never rewritten');
    data.match_control[0].revision = decode(update.rows[0].values[0]);
    return { getResponseCode: () => 200 };
  } };
  const submissions = Array.from({ length: 50 }, (_, i) => ({ requestId: randomUUID(), name: `빠른검증${i}`, team: '전도팀', prayer: '=literal text' }));
  assert.equal(h.ok('submit_batch', { submissions }).length, 50);
  assert.equal(calls.length, 2);
  assert.equal(data.participants.length, original.participants.length + 50);
  assert.equal(data.match_control[0].revision, original.match_control[0].revision + 50);
  assert.equal(data.match_control[0].draw_started_at, originalDraw);
  assert.deepEqual(data.match_members, original.match_members);
  assert.ok(data.participants.slice(-50).every(person => person.prayer_request === '=literal text'));
  // Whole-event reads still use the original date-aware path; this adapter
  // validates only existing IDs, request-key foreign keys, and id/revision.
  c.validateState({ ...data, match_control: original.match_control });
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

test('weekly checks default false and merge individual weeks without changing participant rows', () => {
  const h = harness(), id = h.submit(); h.submit(); h.publish();
  const storedPeople = h.state().participants;
  assert.deepEqual(h.ok('participant', { id }).prayerChecks, [false, false, false, false]);
  assert.deepEqual(h.ok('snapshot').round.groups[0].members[0].prayerChecks, [false, false, false, false]);
  const beforeNoop = h.state(), noOpWrites = h.writes();
  assert.equal(h.check(id, 2, false).data, false);
  assert.deepEqual(h.state(), beforeNoop);
  assert.equal(h.writes(), noOpWrites);
  assert.equal(h.check(id, 2, true).data, true);
  assert.equal(h.state().match_control[0].revision, beforeNoop.match_control[0].revision + 1);
  assert.equal(h.check(id, 4, true).data, true);
  assert.deepEqual(h.ok('participant', { id }).prayerChecks, [false, true, false, true]);
  assert.equal(h.check(id, 2, false).data, false);
  assert.equal(h.check(id, 1, true).data, true);
  assert.equal(h.check(id, 3, true).data, true);
  const beforeRepeat = h.state(), writes = h.writes();
  assert.equal(h.check(id, 3, true).data, true);
  assert.deepEqual(h.state(), beforeRepeat);
  assert.equal(h.writes(), writes);
  assert.deepEqual(h.state().participants, storedPeople);
  assert.equal(h.state().prayer_checkins.length, 1);
  const snapshot = h.ok('snapshot');
  assert.deepEqual(snapshot.participants.find(p => p.id === id).prayerChecks, [true, false, true, true]);
  assert.deepEqual(snapshot.round.groups.flatMap(g => g.members).find(p => p.id === id).prayerChecks, [true, false, true, true]);
  assert.ok(h.ok('export').participants.every(p => !Object.hasOwn(p, 'prayerChecks')));
});

test('weekly checks reject invalid values, stale round IDs and people outside the active group', () => {
  const h = harness(), id = h.submit(); h.submit();
  assert.equal(h.check(id, 1, true, randomUUID()).error.code, '40001');
  h.publish();
  const oldRoundId = h.state().match_rounds.find(r => r.is_active).id;
  const pendingId = h.submit('미배정');
  const before = h.state();
  assert.equal(h.check(pendingId, 1, true).error.code, 'P0002');
  assert.equal(h.check(randomUUID(), 1, true).error.code, 'P0002');
  for (const week of [0, 5, '1', true, 1.5]) assert.equal(h.check(id, week, true).error.code, '22023');
  for (const checked of [0, 1, 'true', null]) assert.equal(h.check(id, 1, checked).error.code, '22023');
  assert.equal(h.check('invalid', 1, true).error.code, '22023');
  assert.equal(h.check(id, 1, true, 'invalid').error.code, '22023');
  assert.deepEqual(h.state(), before);
  h.publish(3);
  assert.equal(h.check(id, 1, true, oldRoundId).error.code, '40001');
  assert.equal(h.command('unpublish').ok, true);
  assert.equal(h.check(id, 1, true, oldRoundId).error.code, '40001');
});

test('weekly checks survive redeals and restoration and cascade on participant deletion and reset', () => {
  const h = harness(), id = h.submit(); h.submit();
  h.publish(2); const firstRoundId = h.state().match_rounds[0].id;
  assert.equal(h.check(id, 1, true).ok, true);
  assert.equal(h.check(id, 4, true).ok, true);
  h.publish(3);
  assert.deepEqual(h.ok('participant', { id }).prayerChecks, [true, false, false, true]);
  assert.equal(h.command('restore', { roundId: firstRoundId }).ok, true);
  assert.deepEqual(h.ok('snapshot').round.groups.flatMap(g => g.members).find(p => p.id === id).prayerChecks, [true, false, false, true]);
  assert.equal(h.command('delete', { id }).ok, true);
  assert.equal(h.state().prayer_checkins.length, 0);
  const otherId = h.state().participants[0].id;
  assert.equal(h.check(otherId, 2, true).ok, true);
  assert.equal(h.command('reset', { confirm: '삭제' }).ok, true);
  assert.equal(h.state().prayer_checkins.length, 0);
});

test('legacy imports omit optional weekly-check table and new backups validate its rows', () => {
  const origin = harness(), id = origin.submit(); origin.submit(); origin.publish();
  const legacy = origin.ok('export'); delete legacy.prayer_checkins;
  const target = harness();
  assert.equal(target.ok('import', { data: legacy }).prayer_checkins, 0);
  assert.deepEqual(target.ok('participant', { id }).prayerChecks, [false, false, false, false]);
  assert.equal(target.ok('import', { data: legacy }).prayer_checkins, 0);
  origin.check(id, 3, true);
  const backup = origin.ok('export');
  const restored = harness();
  assert.equal(restored.ok('import', { data: backup }).prayer_checkins, 1);
  assert.deepEqual(restored.ok('participant', { id }).prayerChecks, [false, false, true, false]);
  assert.equal(restored.call('import', { data: legacy }).error.code, '409', 'legacy restore must not erase existing checks');
  for (const badRows of [
    [{ participant_id: randomUUID(), week_1: false, week_2: false, week_3: false, week_4: false }],
    [{ participant_id: id, week_1: 'true', week_2: false, week_3: false, week_4: false }],
    [backup.prayer_checkins[0], backup.prayer_checkins[0]],
  ]) {
    const invalid = clone(backup); invalid.prayer_checkins = badRows;
    assert.equal(harness().call('import', { data: invalid }).error.code, '22023');
  }
});

test('missing optional tab reads empty and its initializer changes only that tab without seeding false rows', () => {
  const h = harness(), c = h.context, source = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
  vm.runInContext(source.slice(source.indexOf('function readTable('), source.indexOf('\nfunction readState(')), c);
  assert.deepEqual(clone(c.readTable({ getSheetByName: () => null }, 'prayer_checkins')), []);
  assert.throws(() => c.readTable({ getSheetByName: () => null }, 'participants'), e => e.code === 'CONFIG');
  let exists = false, headerWrites = 0, validations = 0, removedValidations = 0, hidden = false, headers;
  const range = {
    setValues: rows => { headerWrites++; headers = rows[0]; return range; }, getValues: () => [headers],
    setBackground: () => range, setFontColor: () => range, setFontWeight: () => range,
    setDataValidation: () => { validations++; return range; },
  };
  const sheet = { getLastRow: () => exists && headers ? 1 : 0, getRange: (...args) => {
    if (args[0] > 1) return { clearDataValidations: () => { removedValidations++; }, setDataValidation: () => { validations++; }, setValues: () => assert.fail('must not seed idle checkbox rows') };
    return range;
  }, setFrozenRows() {}, setColumnWidth() {}, setColumnWidths() {}, getMaxRows: () => 1000, hideSheet: () => { hidden = true; } };
  const spreadsheet = { getSheetByName: name => { assert.equal(name, 'prayer_checkins'); return exists ? sheet : null; },
    insertSheet: name => { assert.equal(name, 'prayer_checkins'); exists = true; return sheet; } };
  c.SpreadsheetApp.newDataValidation = () => ({ requireCheckbox: () => ({ build: () => ({}) }) });
  c.initializePrayerCheckins(spreadsheet); c.initializePrayerCheckins(spreadsheet);
  assert.equal(headerWrites, 1);
  assert.equal(validations, 0, 'empty rows must never receive native checkbox validation');
  assert.equal(removedValidations, 2);
  assert.equal(hidden, true);
  assert.deepEqual(clone(headers), ['participant_id', 'week_1', 'week_2', 'week_3', 'week_4']);
});

test('weekly setup cleans phantom false defaults without touching real records or checked orphan data', () => {
  const h = harness(), c = h.context, id = randomUUID();
  const headers = ['participant_id', 'week_1', 'week_2', 'week_3', 'week_4'];
  const grid = [headers, ['', false, false, false, false], [id, true, false, true, false], ['', false, false, false, false], ['', true, false, false, false]];
  const originalRecord = clone(grid[2]); let clearedValidation = false, validatedRows = [];
  const sheet = {
    getLastRow: () => grid.length, getMaxRows: () => 1000, setFrozenRows() {}, setColumnWidth() {}, setColumnWidths() {}, hideSheet() {},
    getRange(row, column, rowCount = 1, columnCount = 1) {
      const range = {
        getValues: () => grid.slice(row - 1, row - 1 + rowCount).map(values => values.slice(column - 1, column - 1 + columnCount)),
        setBackground: () => range, setFontColor: () => range, setFontWeight: () => range,
        clearDataValidations: () => { clearedValidation = true; },
        clearContent: () => {
          for (let i = row - 1; i < row - 1 + rowCount; i++) for (let j = column - 1; j < column - 1 + columnCount; j++) grid[i][j] = '';
        },
        setDataValidation: () => {
          assert.ok(grid[row - 1][0], 'must not validate a blank-ID row');
          validatedRows.push(row);
          // Model the actual native behavior that caused the production issue.
          for (let i = row - 1; i < row - 1 + rowCount; i++) for (let j = column - 1; j < column - 1 + columnCount; j++) if (grid[i][j] === '') grid[i][j] = false;
        },
      }; return range;
    },
  };
  const spreadsheet = { getSheetByName: () => sheet };
  c.SpreadsheetApp.newDataValidation = () => ({ requireCheckbox: () => ({ build: () => ({}) }) });
  c.initializePrayerCheckins(spreadsheet);
  assert.equal(clearedValidation, true);
  assert.deepEqual(grid[1], ['', '', '', '', '']);
  assert.deepEqual(grid[2], originalRecord);
  assert.deepEqual(grid[3], ['', '', '', '', '']);
  assert.deepEqual(grid[4], ['', true, false, false, false], 'checked orphan row must not be silently erased');
  assert.deepEqual(validatedRows, [3]);
  const source = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
  vm.runInContext(source.slice(source.indexOf('function readTable('), source.indexOf('\nfunction readState(')), c);
  const read = clone(c.readTable(spreadsheet, 'prayer_checkins'));
  assert.equal(read.length, 2);
  const state = empty(); state.prayer_checkins = read;
  assert.throws(() => c.validateState(state), e => e.code === '22023', 'checked row without participant ID remains an error');
});

test('weekly check and revision are sent in the same batch without participant row writes', () => {
  const h = harness(), c = h.context, id = h.submit(); h.submit(); h.publish();
  const before = h.state(); h.check(id, 2, true); const after = h.state();
  let sent;
  c.ScriptApp = { getOAuthToken: () => 'test-token' };
  c.UrlFetchApp = { fetch: (_, options) => { sent = JSON.parse(options.payload); return { getResponseCode: () => 200 }; } };
  const source = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
  vm.runInContext(source.slice(source.indexOf('function commitState('), source.indexOf('\nfunction validatePerson(')), c);
  const names = Object.keys(before);
  c.commitState({ getId: () => 'test-sheet', getSheetByName: name => ({ getSheetId: () => names.indexOf(name), getLastRow: () => 2, getMaxRows: () => 1000 }) }, before, after);
  assert.deepEqual(sent.requests.map(r => names[r.updateCells.range.sheetId]).sort(), ['match_control', 'prayer_checkins']);
  const checkWrite = sent.requests.find(r => names[r.updateCells.range.sheetId] === 'prayer_checkins').updateCells;
  assert.deepEqual(checkWrite.rows[0].values.slice(1).map(cell => cell.userEnteredValue.boolValue), [false, true, false, false]);
  assert.equal(checkWrite.fields, 'userEnteredValue,dataValidation');
  assert.equal(checkWrite.rows.length, 1, 'only populated records receive checkbox validation');
  assert.equal(checkWrite.rows[0].values[0].dataValidation, undefined);
  for (const cell of checkWrite.rows[0].values.slice(1)) assert.deepEqual(cell.dataValidation, { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true });
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
