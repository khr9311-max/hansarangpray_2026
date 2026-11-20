const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function poller({ revision = 17, visible = true, online = true } = {}) {
  const exports = {}, requests = [], timers = new Map(), timeouts = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const document = { visibilityState: visible ? 'visible' : 'hidden', addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) };
  const navigator = { onLine: online };
  let cleanup, refreshes = 0, timerId = 0;
  const code = ts.transpileModule(readFileSync('src/components/RealtimeRefresher.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, {
    exports, document, navigator, AbortController,
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), removeEventListener: name => windowEvents.delete(name) },
    setInterval: (fn, milliseconds) => { timers.set(++timerId, { fn, milliseconds }); return timerId; },
    clearInterval: id => timers.delete(id),
    setTimeout: (fn, milliseconds) => { timeouts.set(++timerId, { fn, milliseconds }); return timerId; },
    clearTimeout: id => timeouts.delete(id),
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    require: name => {
      if (name === 'react') return { useEffect: fn => { cleanup = fn(); } };
      assert.equal(name, 'next/navigation');
      return { useRouter: () => ({ refresh: () => { refreshes++; } }) };
    },
  });
  exports.default({ revision });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    requests, timers, timeouts, windowEvents, documentEvents, document, navigator,
    tick: async () => { for (const { fn } of timers.values()) await fn(); },
    expireRequests: async () => { for (const [id, { fn }] of [...timeouts]) { timeouts.delete(id); fn(); } await settle(); },
    answer: async (index, data, ok = true) => { requests[index].resolve({ ok, json: async () => data }); await settle(); },
    reject: async index => { requests[index].reject(new Error('network unavailable')); await settle(); },
    cleanup: () => cleanup(), get refreshes() { return refreshes; },
  };
}

test('poller refreshes only on a changed valid revision and never downloads private event data', async () => {
  const h = poller();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/event/revision');
  assert.equal(h.requests[0].options.cache, 'no-store');
  await h.answer(0, { revision: 17 });
  assert.equal(h.refreshes, 0);
  assert.equal(h.timeouts.size, 0);
  const next = h.tick();
  await h.answer(1, { revision: 18 });
  await next;
  assert.equal(h.refreshes, 1);
  h.cleanup();
});

test('hidden and offline pages wait for visibility or reconnection before polling', async () => {
  for (const initial of [{ visible: false }, { online: false }]) {
    const h = poller(initial);
    await h.tick();
    assert.equal(h.requests.length, 0);
    h.document.visibilityState = 'visible';
    h.navigator.onLine = true;
    const event = initial.online === false ? h.windowEvents.get('online') : h.documentEvents.get('visibilitychange');
    const checking = event();
    assert.equal(h.requests.length, 1);
    await h.answer(0, { revision: 17 });
    await checking;
    h.cleanup();
  }
});

test('focus and timer events cannot overlap a pending storage check', async () => {
  const h = poller();
  await h.tick();
  await h.windowEvents.get('focus')();
  await h.windowEvents.get('online')();
  assert.equal(h.requests.length, 1);
  await h.answer(0, { revision: 17 });
  const next = h.tick();
  assert.equal(h.requests.length, 2);
  await h.answer(1, { revision: 17 });
  await next;
  h.cleanup();
});

test('transient failures and invalid change indicators keep the current screen and allow retry', async () => {
  const h = poller();
  await h.reject(0);
  for (const response of [{ revision: '18' }, { revision: 1.5 }, { revision: 9007199254740992 }]) {
    const next = h.tick();
    await h.answer(h.requests.length - 1, response);
    await next;
  }
  const unavailable = h.tick();
  await h.answer(h.requests.length - 1, { revision: 18 }, false);
  await unavailable;
  assert.equal(h.refreshes, 0);
  const retry = h.tick();
  await h.answer(h.requests.length - 1, { revision: 18 });
  await retry;
  assert.equal(h.refreshes, 1);
  h.cleanup();
});

test('unmount aborts requests and removes callbacks; late responses cannot refresh an old page', async () => {
  const h = poller();
  const request = h.requests[0];
  h.cleanup();
  assert.equal(request.options.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.windowEvents.size, 0);
  assert.equal(h.documentEvents.size, 0);
  await h.answer(0, { revision: 18 });
  await h.tick();
  assert.equal(h.refreshes, 0);
  assert.equal(h.requests.length, 1);
});

test('a stalled request is aborted so focus or a later poll can resume change detection', async () => {
  const h = poller();
  const stalled = h.requests[0];
  assert.equal(h.timeouts.size, 1);
  assert.equal([...h.timeouts.values()][0].milliseconds, 15000);
  await h.expireRequests();
  assert.equal(stalled.options.signal.aborted, true);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.refreshes, 0);
  const resumed = h.windowEvents.get('focus')();
  assert.equal(h.requests.length, 2);
  await h.answer(1, { revision: 18 });
  await resumed;
  assert.equal(h.refreshes, 1);
  assert.equal(h.timeouts.size, 0);
  h.cleanup();
});
