const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const requestId = '38a8a4fe-0b74-4589-9cf0-3ec119c3981d';

function harness({ allowed = true, rpcError = null } = {}) {
  const calls = [], granted = [], invalidated = [];
  let clientCount = 0;
  const imports = {
    '@/lib/supabase/server': { createAdminClient() {
      clientCount++;
      return { async rpc(name, args) {
        calls.push({ name, args });
        return { data: name === 'prayer_edit' ? args.p_version + 1 : 'new-participant-id', error: rpcError };
      } };
    } },
    'next/cache': { revalidatePath: (...args) => invalidated.push(args) },
    '@/lib/participant-access': {
      allowParticipantEdit: async () => allowed,
      rememberParticipantAccess: async id => granted.push(id),
      validEditToken: (id, token) => token === `valid-link-for-${id}`,
    },
    '@/lib/types': { TEAMS: ['전도팀', '운영팀'] },
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/app/actions.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, console: { error() {} }, require(name) {
    assert.ok(name in imports, `Unexpected import ${name}`);
    return imports[name];
  } });
  return { run: data => exports.submitParticipant({ status: 'idle', message: '' }, data), calls, granted, invalidated, get clientCount() { return clientCount; } };
}

function form(overrides = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ name: '참가자', team: '전도팀', prayer_request: '함께 기도합니다.', submission_id: requestId, ...overrides })) data.set(key, value);
  return data;
}

test('new registration grants only its returned participant ownership', async () => {
  const h = harness();
  const result = await h.run(form());
  assert.equal(result.status, 'success');
  assert.equal(result.participantId, 'new-participant-id');
  assert.equal(h.calls[0].name, 'prayer_submit');
  assert.equal(h.calls[0].args.p_request_id, requestId);
  assert.deepEqual(h.granted, ['new-participant-id']);
});

test('new registration rejects missing or malformed submission keys before database access', async () => {
  for (const value of ['', 'not-a-uuid', '38a8a4fe-0b74-4589-9cf0-3ec119c3981d-extra']) {
    const h = harness();
    const data = form({ submission_id: value });
    if (!value) data.delete('submission_id');
    assert.equal((await h.run(data)).status, 'error');
    assert.equal(h.clientCount, 0);
    assert.deepEqual(h.granted, []);
  }
});

test('registration retry forwards the same private submission key', async () => {
  const h = harness({ rpcError: { code: 'XX000' } });
  const data = form();
  assert.equal((await h.run(data)).status, 'error');
  assert.equal((await h.run(data)).status, 'error');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(c => c.args.p_request_id), [requestId, requestId]);
});

test('editing rejects unauthorized access before constructing an admin client', async () => {
  const h = harness({ allowed: false });
  const result = await h.run(form({ participant_id: 'someone-else', edit_version: '0' }));
  assert.equal(result.status, 'error');
  assert.equal(h.clientCount, 0);
  assert.deepEqual(h.granted, []);
});

test('existing owner or admin edits preserve the participant id and do not grant a new owner cookie', async () => {
  const h = harness();
  const result = await h.run(form({ participant_id: 'existing-id', edit_version: '4', name: '수정이름' }));
  assert.equal(result.status, 'success');
  assert.equal(result.participantId, 'existing-id');
  assert.equal(h.calls[0].name, 'prayer_edit');
  assert.equal(h.calls[0].args.p_id, 'existing-id');
  assert.equal(h.calls[0].args.p_version, 4);
  assert.equal(h.calls[0].args.p_name, '수정이름');
  assert.deepEqual(h.granted, []);
});

test('a valid participant edit link grants browser ownership only after saving', async () => {
  const h = harness();
  const result = await h.run(form({ participant_id: 'existing-id', edit_version: '4', edit_token: 'valid-link-for-existing-id' }));
  assert.equal(result.status, 'success');
  assert.deepEqual(h.granted, ['existing-id']);
});

test('stale edits return a conflict without claiming success, granting cookies, or retrying', async () => {
  const h = harness({ rpcError: { code: '40001' } });
  const result = await h.run(form({ participant_id: 'existing-id', edit_version: '4', edit_token: 'valid-link-for-existing-id' }));
  assert.equal(result.status, 'error');
  assert.match(result.message, /이미 수정/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.granted, []);
  assert.deepEqual(h.invalidated, []);
});

test('invalid data and database failures never claim successful submission', async () => {
  const invalid = harness();
  assert.equal((await invalid.run(form({ team: '없는 팀' }))).status, 'error');
  assert.equal((await invalid.run(form({ name: 'x'.repeat(21) }))).status, 'error');
  assert.equal(invalid.clientCount, 0);
  const failed = harness({ rpcError: { code: 'XX000' } });
  assert.equal((await failed.run(form())).status, 'error');
  assert.deepEqual(failed.granted, []);
});

test('share-in-group choice saves the agreed message even without a textarea value', async () => {
  const h = harness();
  const data = form({ share_in_group: 'on' });
  data.delete('prayer_request');
  assert.equal((await h.run(data)).status, 'success');
  assert.equal(h.calls[0].args.p_prayer, '기도제목은 매칭된 조 안에서 직접 나눌게요.');
});

test('browser submission keys are shared across simultaneous tabs and change only on a new signup', async () => {
  const memory = new Map();
  let lock = Promise.resolve();
  const globals = {
    crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) },
    navigator: { locks: { request: (_name, fn) => { const pending = lock.then(fn); lock = pending.catch(() => {}); return pending; } } },
  };
  function tab() {
    const exports = {};
    const code = ts.transpileModule(readFileSync('src/components/ParticipantForm.tsx', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(code, { ...globals, exports, require(name) {
      assert.ok(['react/jsx-runtime', 'react', 'react-dom', 'next/link', '@/app/actions', '@/lib/types'].includes(name));
      return {};
    } });
    return exports;
  }
  const first = tab(), second = tab();
  const [one, two] = await Promise.all([first.getSubmissionRequest(), second.getSubmissionRequest()]);
  assert.match(one, /^[0-9a-f-]{36}$/);
  assert.equal(one, two);
  assert.equal(await tab().getSubmissionRequest(), one, 'reload preserves key for a lost-response retry');
  const next = await first.getSubmissionRequest(true);
  assert.notEqual(next, one);
  assert.equal(await second.getSubmissionRequest(), next, 'explicit new signup propagates to another tab');
});

test('malformed edit-link tokens are rejected without throwing', () => {
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/lib/participant-access.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, process, Buffer, require(name) {
    if (name === 'node:crypto') return require(name);
    assert.ok(['server-only', 'next/headers', './auth'].includes(name));
    return {};
  } });
  for (const token of [undefined, null, ['one', 'two'], {}, 123]) assert.equal(exports.validEditToken('participant', token), false);
});
