const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const submission = value => ({ requestId: uuid(value), name: `참가${value}`, team: '운영팀', prayer: `기도${value}` });
const participantId = value => uuid(100000 + Number(value.requestId.slice(-12)));
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(onRequest) {
  const exports = {}, calls = [], timers = new Map();
  let now = 0, nextId = 0;
  class SheetsError extends Error { constructor(code, message = 'Storage unavailable') { super(message); this.code = code; } }
  class ClockDate extends Date { static now() { return now; } }
  const code = ts.transpileModule(readFileSync('src/lib/sheets/submissions.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Date: ClockDate, Math: Object.assign(Object.create(Math), { random: () => 0 }),
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    require(name) {
      if (name === 'server-only') return {};
      assert.equal(name, './server');
      return { SheetsError, sheetRequest(operation, payload, options) {
        return new Promise((resolve, reject) => {
          const call = { operation, payload: clone(payload), options: clone(options), resolve, reject };
          calls.push(call);
          if (onRequest) Promise.resolve().then(() => onRequest(call, calls.length, SheetsError)).then(resolve, reject);
        });
      } };
    },
  });
  return {
    submit: exports.submitToSheets, calls, timers, SheetsError,
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (let count = 0; count < 5000; count++) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) { now = until; await settle(); return; }
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
      }
      throw new Error('Timer loop did not settle');
    },
    async complete(index, value = calls[index].payload.submissions.map(row => ({ requestId: row.requestId, participantId: participantId(row) }))) {
      calls[index].resolve(value); await settle();
    },
    async fail(index, code) { calls[index].reject(new SheetsError(code)); await settle(); },
  };
}

test('fifty concurrent registrations share one batch and resolve only after a valid save with private-key bindings', async () => {
  const h = harness(), inputs = Array.from({ length: 50 }, (_, index) => submission(index + 1));
  let completed = 0;
  const promises = inputs.map(input => h.submit(input).then(id => { completed++; return id; }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].operation, 'submit_batch');
  assert.equal(h.calls[0].payload.submissions.length, 50);
  await settle();
  assert.equal(completed, 0, 'queueing is never reported as a successful save');
  await h.complete(0, inputs.slice().reverse().map(input => ({ requestId: input.requestId, participantId: participantId(input) })));
  assert.deepEqual(await Promise.all(promises), inputs.map(participantId));
  assert.equal(h.timers.size, 0);
});

test('small batches wait 400ms and copy inputs before callers can mutate them', async () => {
  const h = harness(), input = submission(1), original = clone(input);
  const promise = h.submit(input);
  input.name = '변경 시도';
  await h.advance(399);
  assert.equal(h.calls.length, 0);
  await h.advance(1);
  assert.deepEqual(h.calls[0].payload.submissions, [original]);
  await h.complete(0);
  assert.equal(await promise, participantId(original));
});

test('batches are capped at fifty and only one backend call runs per instance', async () => {
  const h = harness(), inputs = Array.from({ length: 112 }, (_, index) => submission(index + 1));
  const done = Promise.all(inputs.map(h.submit));
  await h.advance(400);
  assert.equal(h.calls.length, 1);
  await h.complete(0);
  assert.equal(h.calls.length, 2);
  await h.complete(1);
  assert.equal(h.calls.length, 3);
  await h.complete(2);
  assert.deepEqual(await done, inputs.map(participantId));
  assert.deepEqual(h.calls.map(call => call.payload.submissions.length), [50, 50, 12]);
});

test('simultaneous identical retries share a promise; a changed payload cannot reuse the pending private binding', async () => {
  const h = harness(), input = submission(1);
  const first = h.submit(input), retry = h.submit(clone(input));
  assert.equal(first, retry);
  await assert.rejects(h.submit({ ...input, prayer: '다른 내용' }), error => error.code === '22023');
  await h.advance(400);
  assert.equal(h.calls[0].payload.submissions.length, 1);
  await h.complete(0);
  assert.equal(await first, await retry);
});

test('temporary errors retry the unchanged submission at most three times', async () => {
  const h = harness(), result = Promise.allSettled([h.submit(submission(1))]);
  await h.advance(400);
  await h.fail(0, '503');
  await h.advance(499); assert.equal(h.calls.length, 1);
  await h.advance(1); assert.equal(h.calls.length, 2);
  await h.fail(1, 'CONNECTION');
  await h.advance(999); assert.equal(h.calls.length, 2);
  await h.advance(1); assert.equal(h.calls.length, 3);
  await h.fail(2, '429');
  assert.equal((await result)[0].reason.code, '429');
  assert.deepEqual(h.calls.map(call => call.payload), Array(3).fill(h.calls[0].payload));
  assert.equal(h.timers.size, 0);
});

test('a contended batch yields to later arrivals while backoff is pending', async () => {
  const h = harness(), first = h.submit(submission(1));
  await h.advance(400);
  await h.fail(0, '503');
  const second = h.submit(submission(2));
  await h.advance(400);
  assert.equal(h.calls[1].payload.submissions[0].requestId, uuid(2));
  await h.complete(1);
  await h.advance(100);
  assert.equal(h.calls[2].payload.submissions[0].requestId, uuid(1));
  await h.complete(2);
  assert.deepEqual(await Promise.all([first, second]), [participantId(submission(1)), participantId(submission(2))]);
});

test('all waiting and retry time counts toward 150s and the final fetch receives only its remaining budget', async () => {
  const h = harness(), inputs = Array.from({ length: 100 }, (_, index) => submission(index + 1));
  const done = Promise.allSettled(inputs.map(h.submit));
  await h.advance(45000); await h.fail(0, 'CONNECTION');
  assert.equal(h.calls[1].payload.submissions[0].requestId, uuid(51));
  await h.advance(45000); await h.fail(1, 'CONNECTION');
  assert.equal(h.calls[2].payload.submissions[0].requestId, uuid(1));
  await h.advance(45000); await h.fail(2, 'CONNECTION');
  assert.equal(h.calls[3].options.timeoutMs, 15000);
  await h.advance(15000);
  const results = await done;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'CONNECTION'));
  await h.fail(3, 'CONNECTION');
  assert.equal(h.calls.length, 4, 'expired batches are never sent again');
  assert.equal(h.timers.size, 0);
});

test('invalid inputs and a full queue fail before another backend write', async () => {
  const h = harness();
  for (const invalid of [null, {}, { ...submission(1), requestId: 'not-a-uuid' }, { ...submission(1), name: ' ' }, { ...submission(1), prayer: 'x'.repeat(501) }]) {
    await assert.rejects(h.submit(invalid), error => error.code === '22023');
  }
  assert.equal(h.calls.length, 0);
  const queued = Promise.allSettled(Array.from({ length: 500 }, (_, index) => h.submit(submission(index + 1))));
  await assert.rejects(h.submit(submission(501)), error => error.code === '503');
  assert.equal(h.calls.length, 1);
  await h.advance(150000); await queued;
  await h.complete(0);
  assert.equal(h.calls.length, 1);
});

test('partial, malformed, foreign or duplicate response bindings never grant any caller success', async () => {
  const a = submission(1), b = submission(2);
  const row = input => ({ requestId: input.requestId, participantId: participantId(input) });
  const invalidResponses = [null, {}, [], [row(a)], [row(a), row(a)], [row(a), row(submission(3))],
    [row(a), { ...row(b), participantId: row(a).participantId }], [row(a), { ...row(b), participantId: 'bad-id' }]];
  for (const response of invalidResponses) {
    const h = harness(), result = Promise.allSettled([h.submit(a), h.submit(b)]);
    await h.advance(400); await h.complete(0, response);
    assert.ok((await result).every(item => item.status === 'rejected' && item.reason.code === 'STORAGE'));
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  }
  const h = harness(), result = Promise.allSettled([h.submit(a)]);
  await h.advance(400); await h.fail(0, 'CONFIG');
  assert.equal((await result)[0].reason.code, 'CONFIG');
  assert.equal(h.calls.length, 1);
});

test('separate instances retry lost acknowledgements against real backend rules without duplicating people', async () => {
  const backend = { Utilities: { getUuid: randomUUID } };
  vm.runInNewContext(readFileSync('google-apps-script/Code.gs', 'utf8'), backend);
  let stored = Object.fromEntries(Object.keys(backend.TABLES).map(name => [name, []]));
  stored.match_control = [{ id: true, revision: 0, draw_started_at: null }];
  let lostAcknowledgement = false;
  const send = (call, _index, SheetsError) => {
    const draft = clone(stored);
    const result = backend.applyOperation(draft, call.operation, call.payload);
    backend.validateState(draft);
    if (result.changed) stored = draft;
    if (!lostAcknowledgement) { lostAcknowledgement = true; throw new SheetsError('CONNECTION'); }
    return clone(result.data);
  };
  const first = harness(send), second = harness(send);
  const inputs = Array.from({ length: 50 }, (_, index) => submission(index + 1));
  const one = Promise.all(inputs.map(first.submit)), two = Promise.all(inputs.map(second.submit));
  await settle();
  await first.advance(500);
  const [firstIds, secondIds] = await Promise.all([one, two]);
  assert.deepEqual(firstIds, secondIds);
  assert.equal(stored.participants.length, 50);
  assert.equal(stored.participant_submissions.length, 50);
  assert.equal(stored.match_control[0].revision, 50);
});
