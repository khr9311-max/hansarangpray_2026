// Isolated UI fixture. Runs the real Apps Script rules without Google services.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const FIXTURE_SECRET = 'fixture-secret-for-local-testing-2026';

function createFixtureServer() {
  const backend = { Utilities: { getUuid: randomUUID }, console: { log() {} } };
  vm.runInNewContext(readFileSync(join(__dirname, '../google-apps-script/Code.gs'), 'utf8'), backend);
  const createdAt = new Date().toISOString(), roundId = randomUUID();
  const participants = Array.from({ length: 4 }, (_, i) => ({
    id: randomUUID(), name: `검증${i + 1}`, team: '전도팀', prayer_request: '검증용 기도',
    created_at: createdAt, edit_version: 0,
  }));
  const groups = [1, 2].map(groupNumber => ({ id: randomUUID(), round_id: roundId, group_number: groupNumber }));
  let state = {
    participants,
    match_rounds: [{ id: roundId, mode: 'team', target_size: 2, is_active: true, created_at: createdAt }],
    match_groups: groups,
    match_members: participants.map((person, index) => ({ group_id: groups[Math.floor(index / 2)].id, participant_id: person.id, seq: index % 2 })),
    match_control: [{ id: true, revision: 0, draw_started_at: new Date(Date.now() - 10000).toISOString() }],
    participant_submissions: [],
  };
  // New normalized tables start empty while the real backend owns their rules.
  for (const table of Object.keys(backend.TABLES)) state[table] ??= [];
  backend.validateState(state);
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

  function dispatch(operation, payload = {}) {
    if (operation === 'revision') {
      const control = state.match_control[0];
      return { revision: control.revision, drawStartedAt: control.draw_started_at, serverTime: new Date().toISOString() };
    }
    if (operation === 'participant') {
      backend.assertUuid(payload.id);
      return state.participants.find(person => person.id === payload.id) ?? null;
    }
    // A failed command must leave every table unchanged, like atomic batchUpdate.
    const draft = structuredClone(state);
    const result = backend.applyOperation(draft, operation, payload);
    if (result.changed) {
      backend.validateState(draft);
      state = draft;
    }
    return result.data;
  }

  return http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/exec') fail('INVALID', 'Unknown fixture endpoint');
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (request.secret !== FIXTURE_SECRET) fail('UNAUTHORIZED', 'Invalid fixture secret');
      res.end(JSON.stringify({ ok: true, data: dispatch(request.operation, request.payload) }));
    } catch (error) {
      res.end(JSON.stringify({ ok: false, error: { code: error.code ?? 'INVALID', message: error.message } }));
    }
  });
}

if (require.main === module) {
  const server = createFixtureServer();
  server.listen(3031, '127.0.0.1', () => {
    const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', process.env.FIXTURE_APP_PORT ?? '3030'], {
      stdio: 'inherit',
      env: {
        ...process.env, ADMIN_PASSWORD: 'fixture-only-password',
        GOOGLE_SHEETS_WEB_APP_URL: 'http://127.0.0.1:3031/exec',
        GOOGLE_SHEETS_API_SECRET: FIXTURE_SECRET, GOOGLE_SHEETS_ALLOW_LOCAL: 'true',
      },
    });
    process.on('SIGINT', () => { app.kill(); server.close(); process.exit(); });
  });
}

module.exports = { createFixtureServer };
