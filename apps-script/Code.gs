/** SUN AID private backend. Secrets and file IDs belong in Script Properties only. */
var ALLOWED_ACTORS = ['sunaid20220708@gmail.com', 'info@izutrip.com'];
var HISTORY_HEADERS = ['attemptId', 'applicationId', 'actor', 'envelope', 'status', 'preparedAt', 'sentAt', 'detail', 'resolvedAt', 'startedAt'];
var CONFIRM_HEADERS = ['applicationId', 'eventId', 'marker', 'fingerprint', 'confirmedAt', 'confirmedBy', 'start', 'end', 'name'];
var CONFIRM_SHEET = 'SUN_AID_予約確定履歴';
var WORKFLOW_SHEET = 'SUN_AID_予約対応';
var WORKFLOW_HEADERS = ['applicationId', 'fingerprint', 'data', 'updatedAt', 'updatedBy'];
var INQUIRY_MARKER = 'SUN_AID_AVAILABILITY:INQUIRY:';
var BANK_LINK = 'https://campingcar-hp.vercel.app/reserve.html#bank-transfer';
function fault(code, status) { var e = new Error(code); e.status = status || 400; throw e; }
function props() { return PropertiesService.getScriptProperties(); }
function hex(bytes) { return bytes.map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function hash(text) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var different = 0; for (var i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
function authenticate(request) {
  var secret = props().getProperty('BACKEND_SECRET');
  if (!secret || secret.length < 32) fault('CONFIG_REQUIRED', 503);
  if (!request || typeof request.payload !== 'string' || request.payload.length > 20000) fault('AUTH_REQUIRED', 401);
  var expected = hex(Utilities.computeHmacSha256Signature(request.payload, secret, Utilities.Charset.UTF_8));
  if (!equal(request.signature, expected)) fault('AUTH_REQUIRED', 401);
  var body = JSON.parse(request.payload);
  if (!ALLOWED_ACTORS.includes(body.actor) || !Number.isFinite(body.timestamp) || Math.abs(Date.now() - body.timestamp) > 120000 ||
      !/^[a-f0-9-]{36}$/.test(body.nonce || '')) fault('AUTH_REQUIRED', 401);
  return body;
}
function doPost(e) {
  var lock;
  try {
    var body = authenticate(JSON.parse(e.postData.contents));
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) fault('BUSY', 409);
    // Replay cache is an extra guard; durable attempt state supplies send idempotency.
    var cache = CacheService.getScriptCache();
    if (cache.get(body.nonce)) fault('REPLAY_REJECTED', 409);
    cache.put(body.nonce, '1', 300);
    var output = dispatch(body.action, body.data || {}, body.actor);
    return json({ok:true, data:output});
  } catch (error) {
    return json({ok:false, error:error.status ? error.message : 'BACKEND_ERROR', status:error.status || 500});
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}
function doGet() { return json({ok:false, error:'AUTH_REQUIRED', status:401}); }
function json(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function book() {
  var id = props().getProperty('SPREADSHEET_ID');
  if (!id) fault('CONFIG_REQUIRED', 503);
  return SpreadsheetApp.openById(id);
}
function history() {
  var sheet = book().getSheetByName('SUN_AID_送信履歴');
  if (!sheet) fault('SETUP_REQUIRED', 503);
  if (JSON.stringify(sheet.getRange(1, 1, 1, HISTORY_HEADERS.length).getValues()[0]) !== JSON.stringify(HISTORY_HEADERS)) fault('HISTORY_SCHEMA_MISMATCH', 503);
  return sheet;
}
function reservationCalendar() {
  var id = props().getProperty('RESERVATION_CALENDAR_ID');
  if (!id) fault('CALENDAR_CONFIG_REQUIRED', 503);
  var calendar = CalendarApp.getCalendarById(id);
  if (!calendar) fault('CALENDAR_ACCESS_REQUIRED', 503);
  return calendar;
}
function confirmationSheet() {
  var sheet = book().getSheetByName(CONFIRM_SHEET);
  if (!sheet) fault('SETUP_REQUIRED', 503);
  if (JSON.stringify(sheet.getRange(1, 1, 1, CONFIRM_HEADERS.length).getValues()[0]) !== JSON.stringify(CONFIRM_HEADERS)) fault('CONFIRM_SCHEMA_MISMATCH', 503);
  return sheet;
}
function confirmations() {
  var sheet = confirmationSheet(), n = sheet.getLastRow();
  if (n > 5000) fault('HISTORY_TOO_LARGE', 503);
  return n < 2 ? [] : sheet.getRange(2, 1, n - 1, CONFIRM_HEADERS.length).getValues().map(function(r) {
    return {applicationId:r[0], eventId:r[1], marker:r[2], fingerprint:r[3], confirmedAt:r[4], confirmedBy:r[5], start:r[6], end:r[7], name:r[8]};
  });
}
/** Run manually as info@izutrip.com once. Checks private calendar access, creates the audit tab, and never modifies responses. */
function setup() {
  senderOptions();
  reservationCalendar();
  var spreadsheet = book();
  var sheet = spreadsheet.getSheetByName('SUN_AID_送信履歴');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('SUN_AID_送信履歴');
    sheet.appendRow(HISTORY_HEADERS); sheet.setFrozenRows(1); SpreadsheetApp.flush();
  }
  history();
  var confirmed = spreadsheet.getSheetByName(CONFIRM_SHEET);
  if (!confirmed) {
    confirmed = spreadsheet.insertSheet(CONFIRM_SHEET);
    confirmed.appendRow(CONFIRM_HEADERS); confirmed.setFrozenRows(1); SpreadsheetApp.flush();
  }
  confirmationSheet();
  var workflow = spreadsheet.getSheetByName(WORKFLOW_SHEET);
  if (!workflow) { workflow = spreadsheet.insertSheet(WORKFLOW_SHEET); workflow.appendRow(WORKFLOW_HEADERS); workflow.setFrozenRows(1); SpreadsheetApp.flush(); }
  workflowSheet();
}
function attempts() {
  var sheet = history(), n = sheet.getLastRow();
  if (n > 5000) fault('HISTORY_TOO_LARGE', 503);
  return n < 2 ? [] : sheet.getRange(2, 1, n - 1, HISTORY_HEADERS.length).getValues().map(function(r, i) {
    return {row:i + 2, id:r[0], applicationId:r[1], actor:r[2], envelope:JSON.parse(r[3]), status:r[4], preparedAt:r[5], sentAt:r[6], detail:r[7], resolvedAt:r[8], startedAt:r[9]};
  });
}
function writeAttempt(a, create) {
  var row = [a.id, a.applicationId, a.actor, JSON.stringify(a.envelope), a.status, a.preparedAt, a.sentAt || '', a.detail || '', a.resolvedAt || '', a.startedAt || ''];
  var sheet = history();
  if (create) { sheet.appendRow(row); a.row = sheet.getLastRow(); }
  else sheet.getRange(a.row, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush(); // A send may start only after durable SENDING has been flushed.
}
function state(a) { return !a ? 'new' : a.status === 'sending' ? 'unknown' : a.status; }
function latest(records, id) { return records.filter(function(a) { return a.applicationId === id; }).pop(); }
function cleanLine(value) { return String(value || '').replace(/[\r\n\t]/g, ' ').trim(); }
function emailValid(value) { return typeof value === 'string' && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) && value.length < 255; }
function parseDate(value) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(value || '');
  if (!m) return null;
  var d = new Date(value.replace(/\//g, '-').replace(' ', 'T') + ':00+09:00');
  if (!Number.isFinite(d.getTime())) return null;
  var check = new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 16).replace(/-/g, '/').replace('T', ' ');
  return check === value ? d.getTime() : null;
}
function parseReservation(text) {
  text = String(text || '');
  function extract(label) {
    var matches = text.split(/\r?\n/).filter(function(line) { return line.indexOf(label + '：') === 0; });
    return matches.length === 1 ? matches[0].slice(label.length + 1).trim() : null;
  }
  var start = extract('出発日時'), end = extract('返却日時');
  // Accept both published formats, but reject duplicate/ambiguous price fields.
  var feeLines = text.split(/\r?\n/).filter(function(line) { return /^(?:車両の)?概算料金：/.test(line); });
  var fee = feeLines.length === 1 ? feeLines[0].replace(/^(?:車両の)?概算料金：/, '').trim() : null;
  var validFee = /^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)円$/.test(fee || '');
  var amount = validFee ? Number(fee.replace(/[円,]/g, '')) : null;
  return {start:start, end:end, amount:amount,
    valid:text.indexOf('【ご予約内容】') === 0 && parseDate(start) !== null && parseDate(end) !== null && parseDate(end) > parseDate(start) && Number.isSafeInteger(amount) && amount > 0};
}
function applications() {
  var spreadsheet = book();
  var sheet = spreadsheet.getSheets().filter(function(s) { return s.getSheetId() === Number(props().getProperty('RESPONSE_SHEET_ID')); })[0];
  if (!sheet) fault('RESPONSE_SHEET_NOT_FOUND', 503);
  if (sheet.getLastRow() > 2000) fault('RESPONSES_TOO_LARGE', 503);
  var rows = sheet.getDataRange().getValues();
  var headers = rows.shift().map(function(h) { return String(h).trim(); });
  function columns(names) { return headers.map(function(name, index) { return names.includes(name) ? index : -1; }).filter(function(index) { return index >= 0; }); }
  function column(name) { var found = columns([name]); return found.length === 1 ? found[0] : -1; }
  ['タイムスタンプ','お問い合わせ種別','お名前'].forEach(function(name) { if (column(name) < 0) fault('RESPONSE_SCHEMA_MISMATCH', 503); });
  var contentHeader = props().getProperty('RESERVATION_HEADER');
  var contentColumns = columns(contentHeader ? [contentHeader] : ['予約希望詳細またはお問い合わせ内容', '予約またはお問い合わせ内容']);
  if (contentColumns.length !== 1) fault('RESPONSE_SCHEMA_MISMATCH', 503);
  var emailHeader = props().getProperty('EMAIL_HEADER') || 'メールアドレス';
  var emailColumns = columns([emailHeader]);
  var reservationTypes = ['予約希望', '予約希望（すでにHPで期日を入力された方）'];
  var result = rows.filter(function(row) { return reservationTypes.includes(String(row[column('お問い合わせ種別')] || '').trim()); }).map(function(row) {
    var timestamp = row[column('タイムスタンプ')];
    var validTimestamp = timestamp instanceof Date && Number.isFinite(timestamp.getTime());
    var raw = String(row[contentColumns[0]] || '');
    var parsed = parseReservation(raw);
    // Duplicate form-email headers are common. Accept one unique nonempty address only.
    var addresses = emailColumns.map(function(index) { return String(row[index] || '').trim(); }).filter(Boolean);
    addresses = addresses.filter(function(value, index) { return addresses.indexOf(value) === index; });
    var email = addresses.length === 1 ? addresses[0] : '';
    var fingerprint = hash(JSON.stringify(row));
    // Timestamp is immutable application identity. Collisions block both records rather than risk duplicate billing.
    var id = validTimestamp ? hash(timestamp.toISOString()) : hash('invalid:' + fingerprint);
    var name = cleanLine(row[column('お名前')]);
    return {id:id, fingerprint:fingerprint, submittedAtIso:validTimestamp ? timestamp.toISOString() : null, submittedAt:validTimestamp ? Utilities.formatDate(timestamp, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') : cleanLine(timestamp),
      name:name, email:email, start:parsed.start, end:parsed.end, amount:parsed.amount, raw:raw,
      issues:[!validTimestamp && '申込日時が不正', !name && '氏名なし', addresses.length > 1 && 'メールアドレス列の値が不一致：個別確認が必要', !emailValid(email) && 'メールアドレスなし・不正', !parsed.valid && '日時・概算料金を読み取れません'].filter(Boolean)};
  });
  result.forEach(function(item) { if (result.filter(function(other) { return other.id === item.id; }).length > 1) item.issues.push('申込日時の重複：個別確認が必要'); });
  return result;
}
function customerEnabled() { return props().getProperty('ENABLE_CUSTOMER_SEND') === 'true'; }
function workflowSheet() {
  var sheet = book().getSheetByName(WORKFLOW_SHEET);
  if (!sheet) fault('SETUP_REQUIRED', 503);
  if (JSON.stringify(sheet.getRange(1, 1, 1, WORKFLOW_HEADERS.length).getValues()[0]) !== JSON.stringify(WORKFLOW_HEADERS)) fault('WORKFLOW_SCHEMA_MISMATCH', 503);
  return sheet;
}
function workflowRecords() {
  var sheet = workflowSheet(), count = sheet.getLastRow();
  if (count > 5000) fault('HISTORY_TOO_LARGE', 503);
  return count < 2 ? [] : sheet.getRange(2, 1, count - 1, WORKFLOW_HEADERS.length).getValues().map(function(row, index) {
    return {row:index + 2, applicationId:row[0], fingerprint:row[1], data:JSON.parse(row[2]), updatedAt:row[3], updatedBy:row[4]};
  });
}
function workflowFor(item, records) {
  var record = (records || workflowRecords()).filter(function(row) { return row.applicationId === item.id; })[0];
  if (!record) return {eligibility:'unreviewed', closed:false};
  // Editing the response invalidates the quote/conditions; closed applications stay closed.
  return record.fingerprint === item.fingerprint ? record.data : {eligibility:'unreviewed', closed:Boolean(record.data.closed)};
}
function writeWorkflow(item, data, actor) {
  var existing = workflowRecords().filter(function(row) { return row.applicationId === item.id; })[0];
  var row = [item.id, item.fingerprint, JSON.stringify(data), new Date().toISOString(), actor];
  if (existing) workflowSheet().getRange(existing.row, 1, 1, row.length).setValues([row]);
  else workflowSheet().appendRow(row);
  SpreadsheetApp.flush();
  return data;
}
function application(data) {
  var item = applications().filter(function(row) { return row.id === data.applicationId; })[0];
  if (!item || item.issues.length) fault('INVALID_APPLICATION');
  if (data.fingerprint !== item.fingerprint) fault('APPLICATION_CHANGED', 409);
  return item;
}
function saveReview(data, actor) {
  var item = application(data), previous = workflowFor(item);
  if (previous.closed) fault('APPLICATION_CLOSED', 409);
  if (confirmations().some(function(row) { return row.applicationId === item.id; })) fault('ALREADY_CONFIRMED', 409);
  if (!['standard', 'conditional'].includes(data.eligibility)) fault('INVALID_REVIEW');
  var conditions = String(data.conditions || '').trim();
  if (conditions.length > 2000 || (data.eligibility === 'conditional' && !conditions) || (data.eligibility === 'standard' && conditions)) fault('INVALID_REVIEW');
  if (!Number.isSafeInteger(data.approvedAmount) || data.approvedAmount <= 0 || data.approvedAmount > 999999999 || data.amountVerified !== true) fault('QUOTE_VERIFICATION_REQUIRED');
  return writeWorkflow(item, {closed:false, eligibility:data.eligibility, conditions:conditions,
    conditionsAccepted:data.eligibility === 'standard' || data.conditionsAccepted === true,
    approvedAmount:data.approvedAmount, amountVerified:true, quoteSource:'admin', reviewedAt:new Date().toISOString(), reviewedBy:actor}, actor);
}
function closeApplication(data, actor) {
  var item = application(data);
  if (confirmations().some(function(row) { return row.applicationId === item.id; })) fault('ALREADY_CONFIRMED', 409);
  var previous = workflowFor(item);
  previous.closed = true; previous.closedAt = new Date().toISOString(); previous.closedBy = actor;
  return writeWorkflow(item, previous, actor);
}
function pendingApplications() {
  var confirmed = confirmations(), records = workflowRecords();
  return applications().filter(function(item) {
    return !item.issues.length && parseDate(item.end) > Date.now() && !workflowFor(item, records).closed &&
      !confirmed.some(function(row) { return row.applicationId === item.id; });
  }).sort(function(a, b) { return Date.parse(a.submittedAtIso) - Date.parse(b.submittedAtIso); });
}
function overlaps(start, end, otherStart, otherEnd) { return start < otherEnd && end > otherStart; }
function checkReservation(data) {
  var item = application(data), start = parseDate(item.start), end = parseDate(item.end), workflow = workflowFor(item);
  var marker = eventMarker(item.id);
  var conflicts = reservationCalendar().getEvents(new Date(start), new Date(end)).filter(function(event) {
    var description = String(event.getDescription() || '');
    return description.indexOf(INQUIRY_MARKER) !== 0 && description.indexOf(marker) < 0 &&
      overlaps(start, end, event.getStartTime().getTime(), event.getEndTime().getTime());
  }).map(function(event) { return {start:event.getStartTime().toISOString(), end:event.getEndTime().toISOString()}; });
  var earlier = pendingApplications().filter(function(other) {
    return other.id !== item.id && Date.parse(other.submittedAtIso) < Date.parse(item.submittedAtIso) &&
      overlaps(start, end, parseDate(other.start), parseDate(other.end));
  }).map(function(other) { return {applicationId:other.id, start:other.start, end:other.end}; });
  var requiresInquiry = inquiries().some(function(range) { return overlaps(start, end, Date.parse(range.start + 'T00:00:00+09:00'), Date.parse(range.end + 'T00:00:00+09:00')); });
  var result = {applicationId:item.id, fingerprint:item.fingerprint, checkedAt:new Date().toISOString(),
    bookingConflicts:conflicts, earlierApplications:earlier, requiresInquiry:requiresInquiry, workflow:workflow};
  result.ready = !workflow.closed && !conflicts.length && !earlier.length && workflow.amountVerified === true &&
    ['standard', 'conditional'].includes(workflow.eligibility) && workflow.conditionsAccepted === true && (!requiresInquiry || workflow.eligibility === 'conditional');
  result.reviewToken = hash(JSON.stringify([item.fingerprint, workflow]));
  return result;
}
function requireAvailable(review) {
  if (review.workflow.closed) fault('APPLICATION_CLOSED', 409);
  if (review.bookingConflicts.length) fault('RESERVATION_CONFLICT', 409);
  if (review.earlierApplications.length) fault('EARLIER_APPLICATION_PENDING', 409);
  if (review.requiresInquiry && review.workflow.eligibility !== 'conditional') fault('CONDITIONS_REVIEW_REQUIRED', 409);
  if (review.workflow.eligibility === 'conditional' && !review.workflow.conditionsAccepted) fault('CONDITIONS_NOT_ACCEPTED', 409);
}
function list() {
  var records = attempts();
  var confirmed = confirmations();
  var inquiryRanges = inquiries();
  var testAttempt = latest(records, 'test');
  var workflows = workflowRecords();
  return {customerSendEnabled:customerEnabled(), autoGuidanceEnabled:props().getProperty('ENABLE_AUTO_GUIDANCE') === 'true', inquiries:inquiryRanges.map(function(range) { return {id:range.id, start:range.start, end:range.end}; }), testAttempt:testAttempt ? {attemptId:testAttempt.id, status:state(testAttempt), sentAt:testAttempt.sentAt} : null, applications:applications().reverse().map(function(item) {
    var a = latest(records, item.id);
    item.status = state(a); item.sentAt = a ? a.sentAt : ''; item.attemptId = a ? a.id : '';
    var booking = confirmed.filter(function(r) { return r.applicationId === item.id; })[0];
    var itemStart = parseDate(item.start), itemEnd = parseDate(item.end);
    item.requiresInquiry = itemStart !== null && itemEnd !== null && inquiryRanges.some(function(range) {
      return itemStart < new Date(range.end + 'T00:00:00+09:00').getTime() && itemEnd > new Date(range.start + 'T00:00:00+09:00').getTime();
    });
    item.reservationStatus = booking ? 'confirmed' : 'unconfirmed';
    item.reservationConfirmedAt = booking ? booking.confirmedAt : '';
    item.workflow = workflowFor(item, workflows);
    item.lastAmount = a ? a.envelope.amount : null;
    item.history = records.filter(function(r) { return r.applicationId === item.id; }).map(function(r) {
      return {id:r.id, status:state(r), preparedAt:r.preparedAt, sentAt:r.sentAt, amount:r.envelope.amount, email:r.envelope.email, actor:r.actor, detail:r.detail, resolvedAt:r.resolvedAt};
    });
    return item;
  })};
}
function dateOnly(value) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0,10) === value ? d : null;
}
function inquiryList(calendar) {
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var start = new Date(today + 'T00:00:00+09:00');
  var end = new Date(start.getTime() + 191 * 86400000);
  return calendar.getEvents(start, end).map(function(event) {
    var description = String(event.getDescription() || '');
    if (description.indexOf(INQUIRY_MARKER) !== 0 || !event.isAllDayEvent()) return null;
    return {id:event.getId(), start:Utilities.formatDate(event.getAllDayStartDate(), 'Asia/Tokyo', 'yyyy-MM-dd'), end:Utilities.formatDate(event.getAllDayEndDate(), 'Asia/Tokyo', 'yyyy-MM-dd')};
  }).filter(Boolean);
}
function inquiries() { return inquiryList(reservationCalendar()); }
function setInquiry(data, actor) {
  var start = dateOnly(data.start), end = dateOnly(data.end);
  if (!start || !end || end < start) fault('INVALID_INQUIRY_RANGE');
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var todayDate = dateOnly(today), max = new Date(todayDate.getTime() + 190 * 86400000);
  if (start < todayDate || end >= max || end.getTime() - start.getTime() >= 190 * 86400000) fault('INVALID_INQUIRY_RANGE');
  var calendar = reservationCalendar();
  var endExclusive = new Date(end.getTime() + 86400000);
  var existing = inquiryList(calendar);
  var marker = INQUIRY_MARKER + Utilities.getUuid();
  var calendarStart = new Date(start.getTime() - 9 * 3600000);
  var calendarEnd = new Date(endExclusive.getTime() - 9 * 3600000);
  if (existing.some(function(range) { return start.toISOString().slice(0,10) < range.end && endExclusive.toISOString().slice(0,10) > range.start; })) fault('INQUIRY_RANGE_CONFLICT', 409);
  var event = calendar.createAllDayEvent('要問い合わせ', calendarStart, calendarEnd, {description:marker + '\n登録者：' + actor});
  event.setVisibility(CalendarApp.Visibility.PRIVATE);
    return {id:event.getId(), start:Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd'), end:Utilities.formatDate(new Date(endExclusive.getTime()), 'Asia/Tokyo', 'yyyy-MM-dd')};
}
function removeInquiry(data) {
  var event = reservationCalendar().getEventById(String(data.id || ''));
  if (!event || !event.isAllDayEvent() || String(event.getDescription() || '').indexOf(INQUIRY_MARKER) !== 0) fault('INQUIRY_NOT_FOUND', 404);
  event.deleteEvent();
  return {removed:true};
}
function eventMarker(applicationId) { return 'SUN_AID_APPLICATION:' + hash(applicationId); }
function reservationEvent(calendar, item, marker) {
  var startMs = parseDate(item.start), endMs = parseDate(item.end);
  if (startMs === null || endMs === null || endMs <= startMs) fault('INVALID_APPLICATION');
  var start = new Date(startMs), end = new Date(endMs);
  var nearby = calendar.getEvents(new Date(startMs - 86400000), new Date(endMs + 86400000));
  var existing = nearby.filter(function(event) { return String(event.getDescription() || '').indexOf(marker) >= 0; })[0];
  if (existing) return {event:existing, alreadyExists:true};
  var overlap = nearby.filter(function(event) { return String(event.getDescription() || '').indexOf(INQUIRY_MARKER) !== 0 && event.getStartTime().getTime() < endMs && event.getEndTime().getTime() > startMs; })[0];
  if (overlap) fault('RESERVATION_CONFLICT', 409);
  var description = [
    '予約内容',
    '利用者：' + cleanLine(item.name),
    'メール：' + cleanLine(item.email),
    '利用日時：' + item.start + ' 〜 ' + item.end + '（日本時間）',
    '申込内容：', item.raw,
    '', marker
  ].join('\n');
  var event = calendar.createEvent('レンタル予約：' + cleanLine(item.name) + ' 様', start, end, {description:description});
  event.setVisibility(CalendarApp.Visibility.PRIVATE);
  return {event:event, alreadyExists:false};
}
function confirmReservation(data, actor) {
  var item = applications().filter(function(a) { return a.id === data.applicationId; })[0];
  if (!item || item.issues.length) fault('INVALID_APPLICATION');
  var prior = confirmations().filter(function(r) { return r.applicationId === item.id; })[0];
  if (prior) {
    if (prior.fingerprint !== item.fingerprint) fault('APPLICATION_CHANGED', 409);
    return {status:'confirmed', confirmedAt:prior.confirmedAt, alreadyConfirmed:true};
  }
  if (data.confirmed !== true || data.paymentChecked !== true) fault('PAYMENT_CONFIRMATION_REQUIRED');
  var review = checkReservation(data);
  requireAvailable(review);
  if (!review.ready || data.reviewToken !== review.reviewToken) fault('FINAL_REVIEW_REQUIRED', 409);
  // Do not confirm a stale application after its source response was edited.
  var current = applications().filter(function(a) { return a.id === item.id; })[0];
  if (!current || current.fingerprint !== item.fingerprint) fault('APPLICATION_CHANGED', 409);
  var calendar = reservationCalendar();
  var marker = eventMarker(item.id);
  var result = reservationEvent(calendar, item, marker);
  var confirmedAt = new Date().toISOString();
  confirmationSheet().appendRow([item.id, result.event.getId(), marker, item.fingerprint, confirmedAt, actor, item.start, item.end, item.name]);
  SpreadsheetApp.flush();
  return {status:'confirmed', confirmedAt:confirmedAt, calendarEventId:result.event.getId(), recoveredExistingEvent:result.alreadyExists};
}
/** Public endpoint returns only occupied date ranges; never event names, descriptions, emails, or IDs. */
function availability() {
  var calendar = reservationCalendar();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd').split('-').map(Number);
  var start = new Date(Date.UTC(today[0], today[1] - 1, today[2]) - 9 * 3600000);
  var end = new Date(start.getTime() + 190 * 86400000);
  var events = calendar.getEvents(start, end);
  return {bookings:events.filter(function(event) { return String(event.getDescription() || '').indexOf(INQUIRY_MARKER) !== 0; }).map(function(event) {
    return {start:event.getStartTime().toISOString(), end:event.getEndTime().toISOString()};
  }), inquiries:inquiryList(calendar).map(function(range) { return {start:range.start + 'T00:00:00+09:00', end:range.end + 'T00:00:00+09:00'}; }),
  pending:pendingApplications().map(function(item) { return {start:new Date(parseDate(item.start)).toISOString(), end:new Date(parseDate(item.end)).toISOString()}; })};
}
function buildEnvelope(item, amount, test) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999999999) fault('INVALID_AMOUNT');
  var name = cleanLine(item.name);
  if (!name || !emailValid(item.email) || parseDate(item.start) === null || parseDate(item.end) <= parseDate(item.start)) fault('INVALID_APPLICATION');
  var subject = (test ? '【テスト送信】' : '') + '【SUN AID】キャンピングカーレンタル 振込のご案内';
  var body = name + ' 様\n\n' + (test ? 'これは動作確認用のテストメールです。お振込みは不要です。\n\n' : '') +
    'お申込みありがとうございます。貸出可能な日程を確認しましたので、振込をご案内します。\n\n' +
    '利用開始：' + item.start + '（日本時間）\n返却：' + item.end + '（日本時間）\n請求金額：' + amount.toLocaleString('ja-JP') + '円\n\n' +
    '振込先はこちらをご確認ください。\n' + BANK_LINK + '\n\n' +
    '入金確認後、当社の最終確認をもって予約確定となります。\nこのメールの送信時点では予約は確定していません。\n振込手数料はお客様のご負担です。\n\n株式会社 SUN AID\ninfo@izutrip.com';
  if (!test) { var workflow = workflowFor(item); if (workflow.conditions) body += '\n\nご了承いただいた貸出条件：\n' + workflow.conditions; }
  return {email:item.email, name:name, start:item.start, end:item.end, amount:amount, subject:subject, body:body, conditions:test ? '' : (workflow.conditions || ''), fingerprint:item.fingerprint, test:Boolean(test)};
}
function preview(data, actor, test) {
  var item;
  if (test) item = {id:'test', name:'テスト申込者', email:'sunaid20220708@gmail.com', start:'2026/11/01 10:00', end:'2026/11/02 10:00', fingerprint:'test-v1'};
  else {
    item = applications().filter(function(a) { return a.id === data.applicationId; })[0];
    if (!item || item.issues.length) fault('INVALID_APPLICATION');
  }
  var records = attempts(), previous = latest(records, item.id);
  if (['sent','unknown'].includes(state(previous))) fault(state(previous) === 'sent' ? 'ALREADY_SENT' : 'SEND_RESULT_UNKNOWN', 409);
  var a = {id:Utilities.getUuid(), applicationId:item.id, actor:actor, envelope:buildEnvelope(item, test ? 100 : data.amount, test), status:'prepared', preparedAt:new Date().toISOString()};
  writeAttempt(a, true);
  return {attemptId:a.id, envelope:a.envelope, customerSendEnabled:customerEnabled()};
}
function senderOptions() {
  var primary = Session.getEffectiveUser().getEmail().toLowerCase();
  if (primary === 'info@izutrip.com') return {name:'株式会社 SUN AID', replyTo:'info@izutrip.com'};
  if (GmailApp.getAliases().includes('info@izutrip.com')) return {from:'info@izutrip.com', name:'株式会社 SUN AID', replyTo:'info@izutrip.com'};
  fault('SENDER_NOT_CONFIGURED', 503);
}
function send(data, actor, test) {
  var records = attempts(), a = records.filter(function(r) { return r.id === data.attemptId; })[0];
  if (!a || a.actor !== actor || Boolean(a.envelope.test) !== Boolean(test)) fault('ATTEMPT_NOT_FOUND', 404);
  if (a.status === 'sent') return {status:'sent', sentAt:a.sentAt, alreadySent:true};
  if (a.status !== 'prepared') fault('SEND_RESULT_UNKNOWN', 409);
  var last = latest(records, a.applicationId);
  if (!last || last.id !== a.id) fault('PREVIEW_SUPERSEDED', 409);
  if (Date.now() - Date.parse(a.preparedAt) > 900000) fault('PREVIEW_EXPIRED', 409);
  if (data.confirmed !== true) fault('CONFIRMATION_REQUIRED');
  if (!test && !customerEnabled()) fault('CUSTOMER_SEND_DISABLED', 403);
  if (!test) {
    var item = applications().filter(function(r) { return r.id === a.applicationId; })[0];
    if (!item || item.issues.length || item.fingerprint !== a.envelope.fingerprint) fault('APPLICATION_CHANGED', 409);
    if (confirmations().some(function(row) { return row.applicationId === item.id; })) fault('ALREADY_CONFIRMED', 409);
    var review = checkReservation({applicationId:item.id, fingerprint:item.fingerprint});
    requireAvailable(review);
    if (!review.ready || review.workflow.approvedAmount !== a.envelope.amount) fault('QUOTE_VERIFICATION_REQUIRED', 409);
    if ((review.workflow.conditions || '') !== (a.envelope.conditions || '')) fault('APPLICATION_CHANGED', 409);
  }
  var options;
  try { options = senderOptions(); }
  catch (error) { a.status = 'failed'; a.detail = 'SENDER_NOT_CONFIGURED'; writeAttempt(a, false); throw error; }
  // The following flush must succeed BEFORE Gmail is called. Persisted SENDING is never automatically retried.
  a.status = 'sending'; a.startedAt = new Date().toISOString(); writeAttempt(a, false);
  try { GmailApp.sendEmail(a.envelope.email, a.envelope.subject, a.envelope.body, options); }
  catch (error) {
    a.status = 'unknown'; a.detail = 'GMAIL_RESULT_UNKNOWN'; writeAttempt(a, false); fault('SEND_RESULT_UNKNOWN', 502);
  }
  a.status = 'sent'; a.sentAt = new Date().toISOString(); a.detail = 'GMAIL_ACCEPTED';
  // If this save fails, durable SENDING remains UNKNOWN, so another click cannot send again.
  writeAttempt(a, false);
  return {status:'sent', sentAt:a.sentAt};
}
function resolveUnknown(data, actor) {
  var records = attempts(), a = records.filter(function(r) { return r.id === data.attemptId; })[0];
  if (!a || latest(records, a.applicationId).id !== a.id || state(a) !== 'unknown') fault('INVALID_RESOLUTION', 409);
  if (!['sent','notSent'].includes(data.result) || data.mailboxChecked !== true) fault('MAILBOX_CHECK_REQUIRED');
  if (!a.startedAt || Date.now() - Date.parse(a.startedAt) < 300000) fault('WAIT_FOR_SEND_COMPLETION', 409);
  a.status = data.result === 'sent' ? 'sent' : 'failed';
  // No fabricated sentAt: manual reconciliation time is recorded separately.
  a.resolvedAt = new Date().toISOString(); a.detail = 'MAILBOX_CHECKED_' + data.result + '_BY_' + actor;
  writeAttempt(a, false);
  return {status:state(a)};
}
/** Install as a spreadsheet form-submit trigger only after Preview acceptance. */
function onReservationFormSubmit(e) {
  if (!e || !e.source || e.source.getId() !== props().getProperty('SPREADSHEET_ID') ||
      !e.range || e.range.getSheet().getSheetId() !== Number(props().getProperty('RESPONSE_SHEET_ID'))) fault('INVALID_FORM_EVENT');
  return runAutomaticGuidance();
}
/** May also be used by an installable time trigger. No customer send is enabled by setup(). */
function runAutomaticGuidance() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fault('BUSY', 409);
  try {
    if (!customerEnabled() || props().getProperty('ENABLE_AUTO_GUIDANCE') !== 'true') return {enabled:false, sent:0};
    senderOptions();
    var effective = Session.getEffectiveUser().getEmail().toLowerCase();
    var actor = ALLOWED_ACTORS.includes(effective) ? effective : 'info@izutrip.com';
    var results = [];
    pendingApplications().forEach(function(item) {
      var prior = latest(attempts(), item.id);
      // A prepared/failed/unknown attempt is an operator task, never an automatic retry.
      if (prior) return;
      try {
        var review = checkReservation({applicationId:item.id, fingerprint:item.fingerprint});
        requireAvailable(review);
        if (!review.ready) return;
        // The form's free-text estimate is NOT a trusted invoice. A verified quote is required.
        var prepared = preview({applicationId:item.id, amount:review.workflow.approvedAmount}, actor, false);
        var result = send({attemptId:prepared.attemptId, confirmed:true}, actor, false);
        results.push({applicationId:item.id, status:result.status});
      } catch (error) { results.push({applicationId:item.id, status:'review_required', error:error.status ? error.message : 'BACKEND_ERROR'}); }
    });
    return {enabled:true, sent:results.filter(function(result) { return result.status === 'sent'; }).length, results:results};
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}
function dispatch(action, data, actor) {
  if (action === 'list') return list();
  if (action === 'availability') return availability();
  if (action === 'setInquiry') return setInquiry(data, actor);
  if (action === 'removeInquiry') return removeInquiry(data);
  if (action === 'confirmReservation') return confirmReservation(data, actor);
  if (action === 'checkReservation') return checkReservation(data);
  if (action === 'saveReview') return saveReview(data, actor);
  if (action === 'closeApplication') return closeApplication(data, actor);
  if (action === 'preview') return preview(data, actor, false);
  if (action === 'previewTest') return preview(data, actor, true);
  if (action === 'send') return send(data, actor, false);
  if (action === 'sendTest') return send(data, actor, true);
  if (action === 'resolveUnknown') return resolveUnknown(data, actor);
  fault('ACTION_REJECTED');
}
