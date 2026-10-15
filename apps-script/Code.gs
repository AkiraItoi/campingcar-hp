/** SUN AID private backend. Secrets and file IDs belong in Script Properties only. */
var ALLOWED_ACTORS = ['sunaid20220708@gmail.com', 'info@izutrip.com'];
var HISTORY_HEADERS = ['attemptId', 'applicationId', 'actor', 'envelope', 'status', 'preparedAt', 'sentAt', 'detail', 'resolvedAt', 'startedAt'];
var CONFIRM_HEADERS = ['applicationId', 'eventId', 'marker', 'fingerprint', 'confirmedAt', 'confirmedBy', 'start', 'end', 'name'];
var CONFIRM_SHEET = 'SUN_AID_予約確定履歴';
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
  var start = extract('出発日時'), end = extract('返却日時'), fee = extract('概算料金');
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
  function column(name) { return headers.indexOf(name); }
  ['タイムスタンプ','お問い合わせ種別','お名前','予約またはお問い合わせ内容'].forEach(function(name) { if (column(name) < 0) fault('RESPONSE_SCHEMA_MISMATCH', 503); });
  var emailHeader = props().getProperty('EMAIL_HEADER') || 'メールアドレス';
  var emailCol = column(emailHeader);
  var result = rows.filter(function(row) { return row[column('お問い合わせ種別')] === '予約希望'; }).map(function(row) {
    var timestamp = row[column('タイムスタンプ')];
    var validTimestamp = timestamp instanceof Date && Number.isFinite(timestamp.getTime());
    var raw = String(row[column('予約またはお問い合わせ内容')] || '');
    var parsed = parseReservation(raw);
    var email = emailCol < 0 ? '' : String(row[emailCol] || '').trim();
    var fingerprint = hash(JSON.stringify(row));
    // Timestamp is immutable application identity. Collisions block both records rather than risk duplicate billing.
    var id = validTimestamp ? hash(timestamp.toISOString()) : hash('invalid:' + fingerprint);
    var name = cleanLine(row[column('お名前')]);
    return {id:id, fingerprint:fingerprint, submittedAt:validTimestamp ? Utilities.formatDate(timestamp, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') : cleanLine(timestamp),
      name:name, email:email, start:parsed.start, end:parsed.end, amount:parsed.amount, raw:raw,
      issues:[!validTimestamp && '申込日時が不正', !name && '氏名なし', !emailValid(email) && 'メールアドレスなし・不正', !parsed.valid && '日時・概算料金を読み取れません'].filter(Boolean)};
  });
  result.forEach(function(item) { if (result.filter(function(other) { return other.id === item.id; }).length > 1) item.issues.push('申込日時の重複：個別確認が必要'); });
  return result;
}
function customerEnabled() { return props().getProperty('ENABLE_CUSTOMER_SEND') === 'true'; }
function list() {
  var records = attempts();
  var confirmed = confirmations();
  var inquiryRanges = inquiries();
  var testAttempt = latest(records, 'test');
  return {customerSendEnabled:customerEnabled(), inquiries:inquiryRanges.map(function(range) { return {id:range.id, start:range.start, end:range.end}; }), testAttempt:testAttempt ? {attemptId:testAttempt.id, status:state(testAttempt), sentAt:testAttempt.sentAt} : null, applications:applications().reverse().map(function(item) {
    var a = latest(records, item.id);
    item.status = state(a); item.sentAt = a ? a.sentAt : ''; item.attemptId = a ? a.id : '';
    var booking = confirmed.filter(function(r) { return r.applicationId === item.id; })[0];
    var itemStart = parseDate(item.start), itemEnd = parseDate(item.end);
    item.requiresInquiry = itemStart !== null && itemEnd !== null && inquiryRanges.some(function(range) {
      return itemStart < new Date(range.end + 'T00:00:00+09:00').getTime() && itemEnd > new Date(range.start + 'T00:00:00+09:00').getTime();
    });
    item.reservationStatus = booking ? 'confirmed' : 'unconfirmed';
    item.reservationConfirmedAt = booking ? booking.confirmedAt : '';
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
  }), inquiries:inquiryList(calendar).map(function(range) { return {start:range.start + 'T00:00:00+09:00', end:range.end + 'T00:00:00+09:00'}; })};
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
    '当社の入金確認をもって予約枠を確保し、予約確定となります。\nこのメールの送信時点では予約枠を確保していません。\n振込手数料はお客様のご負担です。\n\n株式会社 SUN AID\ninfo@izutrip.com';
  return {email:item.email, name:name, start:item.start, end:item.end, amount:amount, subject:subject, body:body, fingerprint:item.fingerprint, test:Boolean(test)};
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
function dispatch(action, data, actor) {
  if (action === 'list') return list();
  if (action === 'availability') return availability();
  if (action === 'setInquiry') return setInquiry(data, actor);
  if (action === 'removeInquiry') return removeInquiry(data);
  if (action === 'confirmReservation') return confirmReservation(data, actor);
  if (action === 'preview') return preview(data, actor, false);
  if (action === 'previewTest') return preview(data, actor, true);
  if (action === 'send') return send(data, actor, false);
  if (action === 'sendTest') return send(data, actor, true);
  if (action === 'resolveUnknown') return resolveUnknown(data, actor);
  fault('ACTION_REJECTED');
}
