const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(readFileSync('src/components/ParticipantForm.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function recover(submitParticipant, data) {
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => name === '@/app/actions' ? { submitParticipant } : {}, setTimeout: resolve => resolve() });
  return exports.submitWithRecovery({ status: 'idle', message: '' }, data);
}

test('a lost registration response reuses the exact form and recovers the original participant', async () => {
  const data = new FormData();
  data.set('submission_id', '62aa0b6b-e103-421d-b5dd-df6901905730');
  let calls = 0;
  const result = await recover(async (_, form) => {
    assert.equal(form, data);
    if (++calls === 1) throw new Error('response interrupted');
    return { status: 'success', message: '', participantId: 'original' };
  }, data);
  assert.equal(result.participantId, 'original');
  assert.equal(calls, 2);
});

test('edits and validation failures never trigger a client-side replay', async () => {
  const edit = new FormData();
  edit.set('participant_id', 'existing');
  let calls = 0;
  const interrupted = await recover(async () => { calls++; throw new Error(); }, edit);
  assert.equal(interrupted.status, 'error');
  const invalid = await recover(async () => { calls++; return { status: 'error', message: '입력을 확인해 주세요.' }; }, new FormData());
  assert.equal(invalid.message, '입력을 확인해 주세요.');
  assert.equal(calls, 2);
});

test('overlapping bursts and a lost response can recover on the same click', async () => {
  const data = new FormData();
  data.set('submission_id', '62aa0b6b-e103-421d-b5dd-df6901905730');
  let calls = 0;
  const result = await recover(async (_, form) => {
    assert.equal(form, data);
    calls++;
    if (calls === 1) return { status: 'error', message: '저장 확인 지연', retryable: true };
    if (calls === 2) throw new Error('connection lost');
    return { status: 'success', message: '', participantId: 'original' };
  }, data);
  assert.equal(result.participantId, 'original');
  assert.equal(calls, 3);
});
