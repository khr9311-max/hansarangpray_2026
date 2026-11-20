const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { createFixtureServer } = require('./fixture-server.cjs');

const privateKey = 'fixture-secret-for-local-testing-2026';
const productionUrl = 'https://script.google.com/macros/s/test-deployment-id/exec';

function transport({ env = {}, fetch: request = async () => new Response(JSON.stringify({ ok: true, data: null })) } = {}) {
  const calls = [], exports = {};
  const environment = { GOOGLE_SHEETS_WEB_APP_URL: productionUrl, GOOGLE_SHEETS_API_SECRET: privateKey, ...env };
  const errors = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-errors.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: errors });
  const code = ts.transpileModule(readFileSync('src/lib/sheets/server.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, process: { env: environment }, URL, AbortSignal,
    fetch: async (...args) => { calls.push(args); return request(...args); },
    require(name) {
      if (name === 'server-only') return {};
      assert.equal(name, '../storage-errors');
      return errors;
    },
  });
  return { ...exports, calls, env: environment };
}

test('Sheets transport sends private credentials and data only in its server POST body', async () => {
  const h = transport({ fetch: async () => new Response(JSON.stringify({ ok: true, data: 'saved-id' })) });
  assert.equal(await h.sheetRequest('submit', { name: '비공개 이름', prayer: '비공개 기도' }), 'saved-id');
  assert.equal(h.calls.length, 1);
  const [url, options] = h.calls[0];
  assert.equal(url, productionUrl);
  assert.equal(options.method, 'POST');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['Accept-Language'], 'en-US');
  assert.deepEqual(JSON.parse(options.body), { secret: privateKey, operation: 'submit', payload: { name: '비공개 이름', prayer: '비공개 기도' } });
  assert.equal(url.includes(privateKey), false);
});

test('missing configuration, short secrets and untrusted endpoints are rejected before network access', async () => {
  const invalid = [
    { GOOGLE_SHEETS_WEB_APP_URL: '' },
    { GOOGLE_SHEETS_API_SECRET: '' },
    { GOOGLE_SHEETS_API_SECRET: 'too-short' },
    { GOOGLE_SHEETS_API_SECRET: 'a'.repeat(31) },
    { GOOGLE_SHEETS_WEB_APP_URL: 'https://example.com/macros/s/id/exec' },
    { GOOGLE_SHEETS_WEB_APP_URL: 'https://script.google.com.evil.example/macros/s/id/exec' },
    { GOOGLE_SHEETS_WEB_APP_URL: 'http://script.google.com/macros/s/id/exec' },
    { GOOGLE_SHEETS_WEB_APP_URL: 'https://script.google.com/macros/s/id/dev' },
    { GOOGLE_SHEETS_WEB_APP_URL: productionUrl + '?secret=leaked' },
    { GOOGLE_SHEETS_WEB_APP_URL: productionUrl + '#fragment' },
    { GOOGLE_SHEETS_WEB_APP_URL: 'https://user:password@script.google.com/macros/s/id/exec' },
    { GOOGLE_SHEETS_WEB_APP_URL: 'http://127.0.0.1:3031/exec' },
    { GOOGLE_SHEETS_WEB_APP_URL: 'http://192.168.0.1/exec', GOOGLE_SHEETS_ALLOW_LOCAL: 'true' },
  ];
  for (const env of invalid) {
    const h = transport({ env });
    await assert.rejects(h.sheetRequest('snapshot'), error => error instanceof h.SheetsError && error.code === 'CONFIG');
    assert.equal(h.calls.length, 0);
  }
});

test('connection failures never leak network errors or upstream response bodies', async () => {
  for (const request of [
    async () => { throw new Error('secret-upstream-details'); },
    async () => new Response('secret-upstream-details', { status: 503 }),
  ]) {
    const h = transport({ fetch: request });
    await assert.rejects(h.sheetRequest('snapshot'), error => {
      assert.equal(error instanceof h.SheetsError, true);
      assert.equal(error.code, 'CONNECTION');
      assert.equal(error.message.includes('secret-upstream-details'), false);
      return true;
    });
    assert.equal(h.calls.length, 1, 'mutations must not be retried implicitly');
  }
});

test('HTML sign-in pages produce a deployment error instead of a successful storage response', async () => {
  const h = transport({ fetch: async () => new Response('<html>Google sign in</html>') });
  await assert.rejects(h.sheetRequest('snapshot'), error => error instanceof h.SheetsError && error.code === 'CONFIG');
});

test('a batch may shorten the transport deadline, including while reading the response body', async () => {
  const h = transport({ fetch: async () => ({ ok: true, text: () => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('body stream aborted')), 10);
  }) }) });
  await assert.rejects(h.sheetRequest('snapshot', {}, { timeoutMs: 1 }), error => error instanceof h.SheetsError && error.code === 'CONNECTION');
  assert.equal(h.calls[0][1].signal.aborted, true);
  for (const timeoutMs of [0, -1, 45001, 1.5, NaN]) {
    const invalid = transport();
    await assert.rejects(invalid.sheetRequest('snapshot', {}, { timeoutMs }), error => error.code === 'CONFIG');
    assert.equal(invalid.calls.length, 0);
  }
});

test('only recognized temporary Google HTML errors are retryable, with safe reason facts', async () => {
  const cases = [
    ["There are too many scripts running simultaneously for this Google user account.", 'GOOGLE_CONCURRENCY'],
    ['Script invoked too many times per second for this Google user account.', 'GOOGLE_RATE_LIMIT'],
    ['Service invoked too many times in a short time: Spreadsheets.', 'GOOGLE_RATE_LIMIT'],
    ["We&#39;re sorry, a server error occurred. Please wait a bit and try again.", 'GOOGLE_SERVER'],
    ['이 Google 사용자 계정에 대해 동시에 실행 중인 스크립트가 너무 많습니다.', 'GOOGLE_CONCURRENCY'],
    ['요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 'GOOGLE_RATE_LIMIT'],
    ['죄송합니다. 서버 오류가 발생했습니다.', 'GOOGLE_SERVER'],
  ];
  for (const [text, reason] of cases) {
    const h = transport({ fetch: async () => new Response(`<html><body>${text}</body></html>`, { status: 200 }) });
    await assert.rejects(h.sheetRequest('submit_batch'), error => {
      assert.equal(error.code, 'CONNECTION');
      assert.deepEqual({ ...h.sheetFailureFacts(error) }, { code: 'CONNECTION', reason, httpStatus: 200 });
      assert.equal(error.message.includes(text), false);
      return true;
    });
  }
});

test('sign-in, IAM, permissions, daily quotas and unrelated non-JSON pages are never classified as burst errors', async () => {
  const pages = [
    '<html>Sign in to Google. Too many requests.</html>',
    "<html>PERMISSION_DENIED iam.serviceAccounts. We're sorry, a server error occurred.</html>",
    '<html>Authorization is required. There are too many scripts running simultaneously for this Google user account.</html>',
    '<html>권한이 없습니다. 요청이 너무 많습니다.</html>',
    '<html>로그인하세요. 죄송합니다. 서버 오류가 발생했습니다.</html>',
    '<html>Service invoked too many times for one day: urlfetch.</html>',
    '<html>일일 할당량 한도 초과. 요청이 너무 많습니다.</html>',
    '<html>Sorry, unable to open the file at this time.</html>',
    'There are too many scripts running simultaneously for this Google user account.',
    '<html><script>const message = "Too many requests";</script>Unknown page</html>',
  ];
  for (const page of pages) {
    const h = transport({ fetch: async () => new Response(page) });
    await assert.rejects(h.sheetRequest('submit_batch'), error => error.code === 'CONFIG');
  }
  for (const url of ['https://accounts.google.com/login', 'https://example.com/error']) {
    const response = new Response('<html>Too many requests</html>');
    Object.defineProperty(response, 'url', { value: url });
    const h = transport({ fetch: async () => response });
    await assert.rejects(h.sheetRequest('submit_batch'), error => error.code === 'CONFIG');
  }
});

test('HTTP throttling and server failures are distinct from permanent HTTP access failures', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const h = transport({ fetch: async () => new Response('private upstream detail', { status }) });
    await assert.rejects(h.sheetRequest('submit_batch'), error => {
      assert.equal(error.code, status === 429 ? '429' : 'CONNECTION');
      const facts = h.sheetFailureFacts(error);
      assert.equal(facts.reason, status === 429 ? 'HTTP_RATE_LIMIT' : 'HTTP_5XX');
      assert.equal(facts.httpStatus, status);
      return true;
    });
  }
  for (const status of [400, 401, 403, 404]) {
    const h = transport({ fetch: async () => new Response('permission failure', { status }) });
    await assert.rejects(h.sheetRequest('submit_batch'), error => error.code === String(status) && h.sheetFailureFacts(error).reason === 'HTTP_CLIENT');
  }
});

test('diagnostic facts distinguish backend lock failure and cannot echo arbitrary error content', async () => {
  const h = transport({ fetch: async () => new Response(JSON.stringify({ ok: false, error: { code: '503', message: '다른 신청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.' } })) });
  await assert.rejects(h.sheetRequest('submit_batch'), error => {
    assert.deepEqual({ ...h.sheetFailureFacts(error) }, { code: '503', reason: 'BACKEND_LOCK', httpStatus: 200 });
    return true;
  });
  assert.deepEqual({ ...h.sheetFailureFacts(new h.SheetsError('private-person-id', 'private prayer', { reason: 'private-secret', httpStatus: NaN })) }, { code: 'OTHER', reason: 'UNCLASSIFIED' });
  assert.deepEqual({ ...h.sheetFailureFacts(new Error('private-token')) }, { code: 'OTHER', reason: 'UNEXPECTED' });
});

test('backend errors retain their machine code without exposing private backend messages', async () => {
  for (const code of ['40001', 'P0002', '401', '503']) {
    const h = transport({ fetch: async () => new Response(JSON.stringify({ ok: false, error: { code, message: 'private participant detail' } })) });
    await assert.rejects(h.sheetRequest('command', { revision: 17, operation: 'draw' }), error => {
      assert.equal(error instanceof h.SheetsError, true);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('private participant detail'), false);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
});

test('valid empty and zero results remain successful, while malformed envelopes fail closed', async () => {
  for (const data of [null, 0, '', false]) {
    const h = transport({ fetch: async () => new Response(JSON.stringify({ ok: true, data })) });
    assert.equal(await h.sheetRequest('command'), data);
  }
  for (const result of [null, {}, { ok: false }, { ok: 'true', data: 'wrong' }]) {
    const h = transport({ fetch: async () => new Response(JSON.stringify(result)) });
    await assert.rejects(h.sheetRequest('snapshot'), error => error instanceof h.SheetsError && error.code === 'STORAGE');
  }
});

test('real transport and isolated backend preserve retries, conflicts, and existing groups', async () => {
  const server = createFixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const h = transport({
    env: { GOOGLE_SHEETS_WEB_APP_URL: `http://127.0.0.1:${server.address().port}/exec`, GOOGLE_SHEETS_ALLOW_LOCAL: 'true' },
    fetch,
  });
  try {
    const before = await h.sheetRequest('snapshot');
    const payload = { requestId: '38a8a4fe-0b74-4589-9cf0-3ec119c3981d', name: '추가 참가자', team: '전도팀', prayer: '기도' };
    const id = await h.sheetRequest('submit', payload);
    assert.equal(await h.sheetRequest('submit', payload), id);
    const pending = await h.sheetRequest('snapshot');
    assert.equal(pending.participants.length, before.participants.length + 1);
    assert.equal(pending.revision, before.revision + 1);
    await assert.rejects(h.sheetRequest('append', { revision: before.revision }), error => error.code === '40001');
    assert.equal(await h.sheetRequest('append', { revision: pending.revision }), 1);
    const after = await h.sheetRequest('snapshot');
    for (const group of before.round.groups) {
      assert.deepEqual(after.round.groups.find(next => next.groupNumber === group.groupNumber).members.slice(0, group.members.length), group.members);
    }
    assert.equal(await h.sheetRequest('append', { revision: after.revision }), 0);
    assert.equal((await h.sheetRequest('snapshot')).revision, after.revision);
    h.env.GOOGLE_SHEETS_API_SECRET = 'incorrect-secret-for-local-testing-2026';
    await assert.rejects(h.sheetRequest('snapshot'), error => error.code === 'UNAUTHORIZED');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
