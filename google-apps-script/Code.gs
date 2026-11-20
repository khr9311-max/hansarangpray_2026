/**
 * 짝기도 Google Sheets storage service.
 * Bound to a private spreadsheet; deploy as owner / anyone.
 * Only the Next.js server knows SHEETS_API_SECRET. Never expose it to a browser.
 * Application writes share one script lock and one atomic Sheets batchUpdate.
 */
var TABLES = {
  participants: ['id', 'name', 'team', 'prayer_request', 'created_at', 'edit_version'],
  match_rounds: ['id', 'mode', 'target_size', 'is_active', 'created_at'],
  match_groups: ['id', 'round_id', 'group_number'],
  match_members: ['group_id', 'participant_id', 'seq'],
  match_control: ['id', 'revision', 'draw_started_at'],
  participant_submissions: ['request_id', 'participant_id']
};
var UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Run once from the editor while the intended spreadsheet is open. */
function setup() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  var spreadsheet = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) fail('CONFIG', '먼저 구글시트에 연결된 Apps Script에서 설정해 주세요.');
  properties.setProperty('SPREADSHEET_ID', spreadsheet.getId());
  if (!properties.getProperty('SHEETS_API_SECRET')) {
    properties.setProperty('SHEETS_API_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    Object.keys(TABLES).forEach(function (name) {
      var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
      var headers = TABLES[name];
      if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      verifyHeaders(sheet, headers);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length).setBackground('#f1f3f4').setFontColor('#202124').setFontWeight('bold');
      sheet.autoResizeColumns(1, headers.length);
      if (name === 'participants') {
        sheet.setColumnWidth(2, 120); sheet.setColumnWidth(3, 160); sheet.setColumnWidth(4, 440);
        sheet.getRange(1, 4).setNote('기도제목입니다. 저장된 데이터는 비공개로 유지하고 수정은 웹앱에서 진행하세요.');
      }
      if (name === 'match_control' && sheet.getLastRow() === 1) sheet.getRange(2, 1, 1, 3).setValues([[true, 0, '']]);
      if (name === 'match_control' || name === 'participant_submissions') sheet.hideSheet();
    });
    SpreadsheetApp.flush();
    readState(spreadsheet); // Validate existing data; setup never overwrites it.
  } finally { lock.releaseLock(); }
  console.log('설정 완료: ' + spreadsheet.getUrl() + ' / API 비밀키는 프로젝트 설정의 스크립트 속성에서 확인하세요.');
}

function doGet() {
  return jsonOutput({ ok: true, service: 'jjak-gido-google-sheets', version: 1 });
}

function doPost(event) {
  var lock;
  try {
    var contents = event && event.postData && event.postData.contents;
    if (typeof contents !== 'string' || contents.length > 2000000) fail('22023', '요청 형식을 확인해 주세요.');
    var request;
    try { request = JSON.parse(contents); } catch (_) { fail('22023', 'JSON 요청이 필요합니다.'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('22023', '요청 형식을 확인해 주세요.');
    var properties = PropertiesService.getScriptProperties();
    var expected = properties.getProperty('SHEETS_API_SECRET');
    if (!expected || expected.length < 32) fail('CONFIG', '저장소 비밀키를 설정해 주세요.');
    if (!secretEquals(expected, request.secret)) fail('401', '저장소 접근 권한이 없습니다.');
    var spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) fail('CONFIG', '저장소를 먼저 설정해 주세요.');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) fail('503', '다른 신청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    if (request.operation === 'revision') {
      var control = readTable(spreadsheet, 'match_control')[0];
      validateControl(control);
      return jsonOutput({ ok: true, data: { revision: control.revision, drawStartedAt: control.draw_started_at, serverTime: nowIso() } });
    }
    if (request.operation === 'participant') {
      var participantId = request.payload && request.payload.id;
      assertUuid(participantId);
      var participant = readTable(spreadsheet, 'participants').filter(function (p) { return p.id === participantId; })[0] || null;
      return jsonOutput({ ok: true, data: participant });
    }
    var state = readState(spreadsheet);
    var before = JSON.parse(JSON.stringify(state));
    var result = applyOperation(state, request.operation, request.payload || {});
    if (result.changed) {
      validateState(state);
      commitState(spreadsheet, before, state);
    }
    return jsonOutput({ ok: true, data: result.data });
  } catch (error) {
    // Do not log payloads, secrets, participant data or upstream Google responses.
    return jsonOutput({ ok: false, error: { code: String(error.code || '503'), message: error.code ? error.message : '저장소 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.' } });
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}

function jsonOutput(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function nowIso() { return new Date().toISOString(); }
function fail(code, message) { var error = new Error(message); error.code = code; throw error; }
function secretEquals(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  var difference = 0;
  for (var i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}
function assertUuid(value) { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('22023', '올바른 식별자가 필요합니다.'); }
function isInteger(value, minimum) { return Number.isSafeInteger(value) && value >= minimum; }
function verifyHeaders(sheet, expected) {
  var actual = sheet.getRange(1, 1, 1, expected.length).getValues()[0];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('CONFIG', sheet.getName() + ' 시트의 열 제목을 확인해 주세요.');
}
function readTable(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) fail('CONFIG', '저장소 setup 함수를 먼저 실행해 주세요.');
  var headers = TABLES[name]; verifyHeaders(sheet, headers);
  var length = sheet.getLastRow() - 1;
  if (length < 1) return [];
  return sheet.getRange(2, 1, length, headers.length).getValues().filter(function (row) {
    return row.some(function (value) { return value !== ''; });
  }).map(function (row) {
    var record = {};
    headers.forEach(function (column, index) {
      var value = row[index];
      if (column === 'draw_started_at' && value === '') value = null;
      if (value instanceof Date) value = value.toISOString();
      record[column] = value;
    });
    return record;
  });
}
function readState(spreadsheet) {
  var state = {};
  Object.keys(TABLES).forEach(function (name) { state[name] = readTable(spreadsheet, name); });
  validateState(state);
  return state;
}

/** User-entered strings always use stringValue, so '=...' never becomes a formula. */
function asCell(value) {
  if (value === null || value === undefined || value === '') return {};
  return { userEnteredValue: typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } };
}
function commitState(spreadsheet, before, after) {
  var requests = [];
  Object.keys(TABLES).forEach(function (name) {
    if (JSON.stringify(before[name]) === JSON.stringify(after[name])) return;
    var sheet = spreadsheet.getSheetByName(name), columns = TABLES[name];
    var rowCount = Math.max(before[name].length, after[name].length, sheet.getLastRow() - 1) + 1;
    if (rowCount > sheet.getMaxRows()) requests.push({ appendDimension: { sheetId: sheet.getSheetId(), dimension: 'ROWS', length: rowCount - sheet.getMaxRows() } });
    requests.push({ updateCells: {
      range: { sheetId: sheet.getSheetId(), startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columns.length },
      rows: after[name].map(function (record) { return { values: columns.map(function (column) { return asCell(record[column]); }) }; }),
      fields: 'userEnteredValue'
    } });
  });
  if (!requests.length) return;
  var response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheet.getId()) + ':batchUpdate', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ requests: requests, includeSpreadsheetInResponse: false }), muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) fail('503', '구글시트에 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

function validatePerson(person) {
  if (!person || typeof person.name !== 'string' || person.name.trim().length < 1 || person.name.length > 20 ||
      typeof person.team !== 'string' || person.team.trim().length < 1 || person.team.length > 200 ||
      typeof person.prayer_request !== 'string' || person.prayer_request.trim().length < 1 || person.prayer_request.length > 500) {
    fail('22023', '이름·팀·기도제목을 확인해 주세요.');
  }
}
function validateControl(control) {
  if (!control || control.id !== true || !isInteger(control.revision, 0) ||
      (control.draw_started_at !== null && (typeof control.draw_started_at !== 'string' || !Number.isFinite(Date.parse(control.draw_started_at))))) fail('CONFIG', '행사 상태 값이 올바르지 않습니다.');
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function uniqueIndex(rows, key) {
  var index = {};
  rows.forEach(function (row) {
    var id = row[key]; assertUuid(id);
    if (Object.prototype.hasOwnProperty.call(index, id)) fail('22023', '중복 식별자가 있습니다.');
    index[id] = row;
  });
  return index;
}
function validateState(state) {
  if (!state || typeof state !== 'object') fail('22023', '저장소 데이터가 필요합니다.');
  Object.keys(TABLES).forEach(function (name) { if (!Array.isArray(state[name])) fail('22023', '저장소 데이터 구성을 확인해 주세요.'); });
  if (state.match_control.length !== 1) fail('CONFIG', '행사 상태 행은 하나여야 합니다.');
  validateControl(state.match_control[0]);
  var participants = uniqueIndex(state.participants, 'id');
  state.participants.forEach(function (p) {
    validatePerson(p);
    if (!isInteger(p.edit_version, 0) || !validTimestamp(p.created_at)) fail('22023', '참가자 버전·등록 시각을 확인해 주세요.');
  });
  var rounds = uniqueIndex(state.match_rounds, 'id');
  if (state.match_rounds.filter(function (r) { return r.is_active; }).length > 1) fail('22023', '진행 중인 조 편성은 하나여야 합니다.');
  state.match_rounds.forEach(function (r) {
    if (['team', 'random'].indexOf(r.mode) < 0 || !isInteger(r.target_size, 2) || r.target_size > 10 || typeof r.is_active !== 'boolean' || !validTimestamp(r.created_at)) fail('22023', '조 편성 설정을 확인해 주세요.');
  });
  var groups = uniqueIndex(state.match_groups, 'id'), groupNumbers = {};
  state.match_groups.forEach(function (g) {
    if (!rounds[g.round_id] || !isInteger(g.group_number, 1) || groupNumbers[g.round_id + ':' + g.group_number]) fail('22023', '조 번호·회차를 확인해 주세요.');
    groupNumbers[g.round_id + ':' + g.group_number] = true;
  });
  var assigned = {}, memberPairs = {};
  state.match_members.forEach(function (m) {
    var group = groups[m.group_id];
    if (!group || !participants[m.participant_id] || !isInteger(m.seq, 0)) fail('22023', '조원 연결을 확인해 주세요.');
    var pair = m.group_id + ':' + m.participant_id, inRound = group.round_id + ':' + m.participant_id;
    if (memberPairs[pair] || assigned[inRound]) fail('22023', '같은 회차에 중복 배정된 참가자가 있습니다.');
    memberPairs[pair] = true; assigned[inRound] = true;
  });
  var submissions = {};
  state.participant_submissions.forEach(function (s) {
    assertUuid(s.request_id);
    if (submissions[s.request_id] || !participants[s.participant_id]) fail('22023', '신청 재시도 연결을 확인해 주세요.');
    submissions[s.request_id] = true;
  });
}

function snapshot(state) {
  var round = state.match_rounds.filter(function (r) { return r.is_active; })[0];
  var people = {}, control = state.match_control[0];
  state.participants.forEach(function (p) { people[p.id] = p; });
  return {
    revision: control.revision, drawStartedAt: control.draw_started_at, serverTime: nowIso(),
    participants: state.participants.slice().sort(function (a, b) { return b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id); }),
    round: round ? {
      id: round.id, mode: round.mode, targetSize: round.target_size, createdAt: round.created_at,
      groups: state.match_groups.filter(function (g) { return g.round_id === round.id; }).sort(function (a, b) { return a.group_number - b.group_number; }).map(function (g) {
        return { groupNumber: g.group_number, members: state.match_members.filter(function (m) { return m.group_id === g.id; }).sort(function (a, b) { return a.seq - b.seq; }).map(function (m) { return people[m.participant_id]; }) };
      })
    } : null
  };
}

function applyOperation(state, operation, payload) {
  var control = state.match_control[0], person, active, data;
  if (operation === 'snapshot') return { data: snapshot(state), changed: false };
  if (operation === 'export') return { data: state, changed: false };
  if (operation === 'import') {
    var incoming = payload.data;
    validateState(incoming);
    var normalized = {};
    Object.keys(TABLES).forEach(function (name) {
      normalized[name] = incoming[name].map(function (row) {
        var cleaned = {}; TABLES[name].forEach(function (key) { cleaned[key] = row[key]; }); return cleaned;
      });
    });
    if (canonicalState(state) === canonicalState(normalized)) return { data: tableCounts(state), changed: false };
    if (Object.keys(TABLES).some(function (name) { return name !== 'match_control' && state[name].length > 0; }) || control.revision !== 0 || control.draw_started_at !== null) fail('409', '비어 있는 구글시트에만 기존 데이터를 가져올 수 있습니다.');
    Object.keys(TABLES).forEach(function (name) { state[name] = normalized[name]; });
    return { data: tableCounts(state), changed: true };
  }
  if (operation === 'submit') {
    assertUuid(payload.requestId);
    var previous = state.participant_submissions.filter(function (s) { return s.request_id === payload.requestId; })[0];
    if (previous) return { data: previous.participant_id, changed: false };
    person = { id: Utilities.getUuid(), name: payload.name, team: payload.team, prayer_request: payload.prayer, created_at: nowIso(), edit_version: 0 };
    validatePerson(person);
    state.participants.push(person);
    state.participant_submissions.push({ request_id: payload.requestId, participant_id: person.id });
    control.revision++;
    return { data: person.id, changed: true };
  }
  if (operation === 'edit') {
    assertUuid(payload.id);
    person = state.participants.filter(function (p) { return p.id === payload.id; })[0];
    if (!person || payload.version !== person.edit_version) fail('40001', '다른 화면에서 신청 정보가 변경되었습니다.');
    var edited = { name: payload.name, team: payload.team, prayer_request: payload.prayer }; validatePerson(edited);
    person.name = edited.name; person.team = edited.team; person.prayer_request = edited.prayer_request;
    person.edit_version++; control.revision++;
    return { data: person.edit_version, changed: true };
  }
  if (operation !== 'command' && operation !== 'append') fail('22023', '지원하지 않는 작업입니다.');
  if (!isInteger(payload.revision, 0) || payload.revision !== control.revision) fail('40001', '다른 기기의 조작 또는 새 신청이 반영되었습니다.');
  if (operation === 'append') {
    active = state.match_rounds.filter(function (r) { return r.is_active; })[0];
    if (!active) fail('P0002', '먼저 첫 조 편성을 완료해 주세요.');
    data = appendPending(state, active);
    if (data > 0) control.revision++;
    return { data: data, changed: data > 0 };
  }
  var action = payload.operation, body = payload.payload || {};
  if (action === 'publish') {
    if (state.match_rounds.some(function (r) { return r.is_active; }) && body.confirm !== '재편성') fail('22023', '기존 조 편성을 바꾸려면 재편성을 확인해 주세요.');
    if (!isInteger(body.target, 2) || body.target > 10 || ['team', 'random'].indexOf(body.mode) < 0) fail('22023', '매칭 설정을 확인해 주세요.');
    if (!Array.isArray(body.assignments)) fail('22023', '조 편성 명단이 필요합니다.');
    var roster = state.participants.map(function (p) { return p.id; }).sort();
    var requested = body.assignments.map(function (a) { return a.participant_id; }).sort();
    if (!roster.length || JSON.stringify(roster) !== JSON.stringify(requested)) fail('40001', '참가자 명단이 변경되었습니다.');
    if (body.assignments.some(function (a) { return !isInteger(a.group_number, 1); })) fail('22023', '올바른 조 번호가 필요합니다.');
    active = { id: Utilities.getUuid(), mode: body.mode, target_size: body.target, is_active: true, created_at: nowIso() };
    state.match_rounds.forEach(function (r) { r.is_active = false; });
    state.match_rounds.push(active);
    var groupByNumber = {};
    body.assignments.forEach(function (assignment) {
      var group = groupByNumber[assignment.group_number];
      if (!group) {
        group = { id: Utilities.getUuid(), round_id: active.id, group_number: assignment.group_number };
        groupByNumber[assignment.group_number] = group; state.match_groups.push(group);
      }
      state.match_members.push({ group_id: group.id, participant_id: assignment.participant_id,
        seq: state.match_members.filter(function (m) { return m.group_id === group.id; }).length });
    });
    control.draw_started_at = null;
  } else if (action === 'draw') {
    if (!state.match_rounds.some(function (r) { return r.is_active; })) fail('P0002', '먼저 조 편성을 완료해 주세요.');
    var drawNow = Date.now();
    if (control.draw_started_at && Date.parse(control.draw_started_at) + 3200 > drawNow) fail('40001', '이미 추첨을 준비하거나 진행하고 있습니다.');
    // Give every polling phone time to observe one shared future start time.
    control.draw_started_at = new Date(drawNow + 8000).toISOString();
    // Reveal saved groups only; never append participants implicitly.
  } else if (action === 'unpublish') {
    state.match_rounds.forEach(function (r) { r.is_active = false; }); control.draw_started_at = null;
  } else if (action === 'delete') {
    assertUuid(body.id);
    state.participants = state.participants.filter(function (p) { return p.id !== body.id; });
    state.match_members = state.match_members.filter(function (m) { return m.participant_id !== body.id; });
    state.participant_submissions = state.participant_submissions.filter(function (s) { return s.participant_id !== body.id; });
  } else if (action === 'reset' && body.confirm === '삭제') {
    Object.keys(TABLES).forEach(function (name) { if (name !== 'match_control') state[name] = []; }); control.draw_started_at = null;
  } else fail('22023', '지원하지 않는 작업이거나 확인 문구가 없습니다.');
  control.revision++;
  return { data: null, changed: true };
}
function tableCounts(state) {
  var counts = {}; Object.keys(TABLES).forEach(function (name) { counts[name] = state[name].length; }); return counts;
}
function canonicalState(state) {
  return JSON.stringify(Object.keys(TABLES).map(function (name) {
    return state[name].map(function (row) { return TABLES[name].map(function (column) { return row[column]; }); })
      .sort(function (a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); });
  }));
}
function appendPending(state, active) {
  var groups = state.match_groups.filter(function (g) { return g.round_id === active.id; });
  if (!groups.length) fail('P0002', '현재 회차에 조가 없습니다. 다시 조 편성해 주세요.');
  var people = {}; state.participants.forEach(function (p) { people[p.id] = p; });
  var activeGroupIds = {}; groups.forEach(function (g) { activeGroupIds[g.id] = true; });
  var assigned = {}; state.match_members.forEach(function (m) { if (activeGroupIds[m.group_id]) assigned[m.participant_id] = true; });
  var pending = state.participants.filter(function (p) { return !assigned[p.id]; }).sort(function (a, b) { return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id); });
  pending.forEach(function (p) {
    var ranked = groups.map(function (g) {
      var members = state.match_members.filter(function (m) { return m.group_id === g.id; });
      return { group: g, members: members, count: members.length, same: active.mode === 'team' ? members.filter(function (m) { return people[m.participant_id].team === p.team; }).length : 0, random: Math.random() };
    }).sort(function (a, b) { return a.count - b.count || a.same - b.same || a.random - b.random; });
    var best = ranked[0];
    state.match_members.push({ group_id: best.group.id, participant_id: p.id, seq: best.members.reduce(function (maximum, m) { return Math.max(maximum, m.seq); }, -1) + 1 });
  });
  return pending.length;
}
