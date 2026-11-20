const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const key = 'sb_secret_unit_fixture_only';
const hostedUrl = 'https://database.supabase.co';
const participantId = '5281648f-c9da-44b1-9a6d-80a4bec84820';
const submission = {
  requestId: '1281648f-c9da-44b1-9a6d-80a4bec84820',
  name: 'Fixture',
  team: 'Team',
  prayer: 'Test prayer',
};

function load(path, context = {}, imports = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    ...context,
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

function harness({ env = {}, respond = () => Response.json(participantId) } = {}) {
  const calls = [], sheets = [], sleeps = [];
  const process = { env: { PRAYER_STORAGE_BACKEND: 'supabase', SUPABASE_URL: hostedUrl, SUPABASE_SECRET_KEY: key, ...env } };
  const errors = load('src/lib/storage-errors.ts');
  const supabase = load('src/lib/supabase/server.ts', {
    process, URL, AbortSignal,
    async fetch(url, options) {
      calls.push({ url, options, payload: JSON.parse(options.body) });
      return respond(calls.length);
    },
  }, { '../storage-errors': errors });
  const storage = load('src/lib/storage.ts', {
    process,
    setTimeout(fn, milliseconds) { sleeps.push(milliseconds); fn(); },
  }, {
    './storage-errors': errors,
    './supabase/server': supabase,
    './sheets/server': { async sheetRequest(...args) { sheets.push(args); return { revision: 7 }; } },
    './sheets/submissions': { async submitToSheets(input) { sheets.push(['submit', input]); return participantId; } },
  });
  return { ...storage, calls, sheets, sleeps };
}

test('Supabase dispatches a verified registration immediately with a server-only key and no redirect', async () => {
  const h = harness();
  assert.equal(await h.submitRegistration(submission), participantId);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.sheets.length, 0);
  const { url, options, payload } = h.calls[0];
  assert.equal(url, hostedUrl + '/rest/v1/rpc/prayer_storage');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.apikey, key);
  assert.equal(options.headers.Authorization, undefined);
  assert.deepEqual(payload, { p_operation: 'submit', p_payload: submission });
  assert.equal(options.body.includes(key), false);
});

test('an uncertain commit retries once with the same submission key without disclosing response details', async () => {
  const h = harness({ respond: attempt => attempt === 1
    ? Response.json({ message: 'Private server error' }, { status: 503 })
    : Response.json(participantId) });
  assert.equal(await h.submitRegistration(submission), participantId);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].payload, h.calls[1].payload);
  assert.equal(h.sleeps.length, 1);
  const malformed = harness({ respond: () => Response.json({ participantId }) });
  await assert.rejects(malformed.submitRegistration(submission), { code: 'CONNECTION' });
  assert.equal(malformed.calls.length, 2);
});

test('stale revisions preserve the SQLSTATE and never retry mutations or expose database details', async () => {
  const h = harness({ respond: () => Response.json({ code: '40001', message: 'Private data' }, { status: 409 }) });
  await assert.rejects(h.storageRequest('command', { revision: 17 }), error => {
    assert.equal(error.code, '40001');
    assert.doesNotMatch(error.message, /Private data/);
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('unselected storage continues to use Sheets, and an invalid Supabase host never receives the key', async () => {
  const sheets = harness({ env: { PRAYER_STORAGE_BACKEND: undefined } });
  assert.equal(await sheets.submitRegistration(submission), participantId);
  assert.equal((await sheets.storageRequest('snapshot')).revision, 7);
  assert.equal(sheets.calls.length, 0);
  assert.equal(sheets.sheets.length, 2);

  const invalid = harness({ env: { SUPABASE_URL: hostedUrl + '.other.test' } });
  await assert.rejects(invalid.submitRegistration(submission), { code: 'CONFIG' });
  assert.equal(invalid.calls.length, 0);
});

test('a legacy server key is supported for existing projects', async () => {
  const legacy = harness({ env: { SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: 'legacy-fixture-key' } });
  await legacy.storageRequest('revision');
  const { headers } = legacy.calls[0].options;
  assert.equal(headers.apikey, 'legacy-fixture-key');
  assert.equal(headers.Authorization, 'Bearer legacy-fixture-key');
});
