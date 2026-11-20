// Isolated UI fixture. Never connects to the production spreadsheet.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const FIXTURE_SECRET = 'fixture-secret-for-local-testing-2026';

function createFixtureServer() {
  const submissions = new Map();
  const people = Array.from({ length: 4 }, (_, i) => ({
    id: randomUUID(), name: `검증${i + 1}`, team: '전도팀', prayer_request: '검증용 기도',
    created_at: new Date().toISOString(), edit_version: 0,
  }));
  let revision = 0, drawStartedAt = new Date(Date.now() - 10000).toISOString();
  let round = {
    id: randomUUID(), mode: 'team', targetSize: 2, createdAt: new Date().toISOString(),
    groups: [{ groupNumber: 1, members: people.slice(0, 2) }, { groupNumber: 2, members: people.slice(2) }],
  };
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const checkRevision = value => {
    if (value !== revision) fail('40001', 'Event changed');
  };
  const validateParticipant = data => {
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 20 ||
        typeof data.team !== 'string' || !data.team.trim() ||
        typeof data.prayer !== 'string' || !data.prayer.trim() || data.prayer.trim().length > 500) {
      fail('INVALID', 'Invalid participant');
    }
  };

  function dispatch(operation, data = {}) {
    if (operation === 'snapshot') return { participants: people, round, revision, drawStartedAt, serverTime: new Date().toISOString() };
    if (operation === 'revision') return { revision };
    if (operation === 'participant') return people.find(p => p.id === data.id) ?? null;
    if (operation === 'submit') {
      if (!data.requestId) fail('INVALID', 'Missing submission request');
      if (submissions.has(data.requestId)) return submissions.get(data.requestId);
      validateParticipant(data);
      const person = {
        id: randomUUID(), name: data.name.trim(), team: data.team.trim(), prayer_request: data.prayer.trim(),
        created_at: new Date().toISOString(), edit_version: 0,
      };
      people.push(person);
      submissions.set(data.requestId, person.id);
      revision++;
      return person.id;
    }
    if (operation === 'edit') {
      validateParticipant(data);
      const person = people.find(p => p.id === data.id);
      if (!person || person.edit_version !== data.version) fail('40001', 'Participant changed');
      Object.assign(person, { name: data.name.trim(), team: data.team.trim(), prayer_request: data.prayer.trim(), edit_version: person.edit_version + 1 });
      revision++;
      return person.edit_version;
    }
    if (operation === 'append') {
      checkRevision(data.revision);
      if (!round) fail('P0002', 'No active groups');
      const assigned = new Set(round.groups.flatMap(group => group.members.map(person => person.id)));
      const pending = people.filter(person => !assigned.has(person.id));
      for (const person of pending) {
        [...round.groups].sort((a, b) => a.members.length - b.members.length)[0].members.push(person);
      }
      if (pending.length) revision++;
      return pending.length;
    }
    if (operation === 'command') {
      checkRevision(data.revision);
      const payload = data.payload ?? {};
      if (data.operation === 'draw') {
        if (!round) fail('P0002', 'No active groups');
        drawStartedAt = new Date().toISOString();
      } else if (data.operation === 'publish') {
        if (round && payload.confirm !== '재편성') fail('INVALID', 'Confirmation required');
        if (!Number.isInteger(payload.target) || payload.target < 2 || payload.target > 10 || !['team', 'random'].includes(payload.mode)) {
          fail('INVALID', 'Invalid matching settings');
        }
        const assignments = payload.assignments;
        const expected = people.map(person => person.id).sort();
        if (!Array.isArray(assignments) || !expected.length ||
            JSON.stringify(assignments.map(row => row.participant_id).sort()) !== JSON.stringify(expected)) {
          fail('40001', 'Roster changed');
        }
        const groups = new Map();
        for (const assignment of assignments) {
          if (!Number.isInteger(assignment.group_number) || assignment.group_number < 1) fail('INVALID', 'Invalid group');
          if (!groups.has(assignment.group_number)) groups.set(assignment.group_number, { groupNumber: assignment.group_number, members: [] });
          groups.get(assignment.group_number).members.push(people.find(person => person.id === assignment.participant_id));
        }
        round = { id: randomUUID(), mode: payload.mode, targetSize: payload.target, createdAt: new Date().toISOString(), groups: [...groups.values()] };
        drawStartedAt = null;
      } else if (data.operation === 'unpublish') {
        round = null;
        drawStartedAt = null;
      } else if (data.operation === 'delete') {
        const index = people.findIndex(person => person.id === payload.id);
        if (index >= 0) people.splice(index, 1);
        if (round) for (const group of round.groups) group.members = group.members.filter(person => person.id !== payload.id);
        for (const [requestId, id] of submissions) if (id === payload.id) submissions.delete(requestId);
      } else if (data.operation === 'reset' && payload.confirm === '삭제') {
        people.splice(0);
        submissions.clear();
        round = null;
        drawStartedAt = null;
      } else fail('INVALID', 'Unsupported fixture command');
      revision++;
      return null;
    }
    fail('INVALID', 'Unsupported fixture operation');
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
