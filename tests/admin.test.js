const {test, beforeEach} = require('node:test');
// Fixture bookings remain in the future regardless of the day the suite runs.
beforeEach(t => t.mock.timers.enable({apis:['Date'], now:new Date('2026-10-31T00:00:00Z').getTime()}));
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../lib/admin-security');
const handler = require('../api/admin');
const availabilityHandler = require('../api/availability');
const {OAuth2Client} = require('google-auth-library');
const source = fs.readFileSync('apps-script/Code.gs', 'utf8');
const summary = '【ご予約内容】\n出発日時：2026/11/01 10:00\n返却日時：2026/11/02 10:00\n概算料金：22,500円\n';
function backendHarness({email = true, enabled = true, reviewed = true} = {}) {
  const properties = {BACKEND_SECRET:'b'.repeat(48), SPREADSHEET_ID:'private-test-id', RESPONSE_SHEET_ID:'405558677', ENABLE_CUSTOMER_SEND:String(enabled), RESERVATION_CALENDAR_ID:'calendar-test-id'};
  const responseRows = [['タイムスタンプ','お問い合わせ種別 ','お名前','予約またはお問い合わせ内容', ...(email ? ['メールアドレス'] : [])],
    [new Date('2026-10-11T10:00:00Z'), '予約希望', '架空顧客', summary, ...(email ? ['fiction@example.test'] : [])]];
  const historyRows = [];
  const state = {calls:0, throwGmail:false, failSentSave:false, failSendingSave:false, failConfirmationAppend:false, owner:'info@izutrip.com', locked:false, events:[]};
  function sheet(rows, id) {
    return {getSheetId:() => id, getDataRange:() => ({getValues:() => rows.map(r => r.slice())}), getLastRow:() => rows.length,
      appendRow:r => { if (state.failConfirmationAppend && r.length === 9) throw new Error('append failure'); rows.push(r.slice()); }, setFrozenRows:() => {},
      getRange:(r,c,n,m) => ({getValues:() => rows.slice(r - 1,r - 1 + n).map(a => a.slice(c - 1,c - 1 + m)),
        setValues:values => {
          if ((state.failSentSave && values[0][4] === 'sent') || (state.failSendingSave && values[0][4] === 'sending')) throw new Error('storage failure');
          values.forEach((v,i) => { rows[r - 1 + i] = v.slice(); });
        }})};
  }
  const confirmationRows = [];
  const workflowRows = [];
  const responses = sheet(responseRows,405558677), histories = sheet(historyRows,8), confirmations = sheet(confirmationRows,9);
  const workflows = sheet(workflowRows,10);
  const namedSheets = {};
  const book = {getSheets:() => [responses].concat(Object.values(namedSheets)), getSheetByName:name => namedSheets[name] || null, insertSheet:name => { const result = name === 'SUN_AID_送信履歴' ? histories : name === 'SUN_AID_予約対応' ? workflows : confirmations; namedSheets[name] = result; return result; }};
  function calendarEvent(start,end,description='') {
    return {id:crypto.randomUUID(),start:new Date(start),end:new Date(end),description,title:'',visibility:null,
      getId(){return this.id;},getDescription(){return this.description;},getStartTime(){return this.start;},getEndTime(){return this.end;},
      isAllDayEvent(){return Boolean(this.allDay);},getAllDayStartDate(){return this.start;},getAllDayEndDate(){return this.end;},
      deleteEvent(){state.events=state.events.filter(event=>event.id!==this.id);},setVisibility(v){this.visibility=v;}};
  }
  const calendar = {getEvents:(start,end) => state.events.filter(ev => ev.start < end && ev.end > start),
    getEventById:id => state.events.find(ev=>ev.id===id)||null,
    createEvent:(title,start,end,opts) => {const ev=calendarEvent(start,end,opts.description);ev.title=title;state.events.push(ev);return ev;},
    createAllDayEvent:(title,start,end,opts) => {const ev=calendarEvent(start,end,opts.description);ev.title=title;ev.allDay=true;state.events.push(ev);return ev;}};
  const context = vm.createContext({Date, JSON, Number, String, Boolean, Error, console,
    PropertiesService:{getScriptProperties:() => ({getProperty:key => properties[key] || null})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'}, Charset:{UTF_8:'utf8'}, getUuid:() => crypto.randomUUID(),
      computeDigest:(algorithm,text) => [...crypto.createHash(algorithm).update(text).digest()],
      computeHmacSha256Signature:(text,secret) => [...crypto.createHmac('sha256',secret).update(text).digest()],
      formatDate:(d,zone,pattern) => pattern === 'yyyy-MM-dd'
        ? new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
        : d.toISOString().replace('T',' ').slice(0,19)},
    SpreadsheetApp:{openById:() => book, flush:() => {}},
    CalendarApp:{Visibility:{PRIVATE:'private'},getCalendarById:id => id === properties.RESERVATION_CALENDAR_ID ? calendar : null},
    Session:{getEffectiveUser:() => ({getEmail:() => state.owner})},
    GmailApp:{getAliases:() => [], sendEmail:(to,subject,body,opts) => {state.calls++; state.lastMail={to,subject,body,opts}; if (state.throwGmail) throw new Error('lost response');}},
    LockService:{getScriptLock:() => ({tryLock:() => {if (state.locked) return false; state.locked = true; return true;}, hasLock:() => state.locked, releaseLock:() => {state.locked = false;}})},
    CacheService:{getScriptCache:() => {const store = state.cache || (state.cache = {}); return {get:k => store[k], put:(k,v) => {store[k] = v;}};}},
    ContentService:{MimeType:{JSON:'json'}, createTextOutput:s => ({setMimeType:() => JSON.parse(s)})}
  });
  vm.runInContext(source, context); context.setup();
  if (reviewed && email) {
    const item = context.applications()[0];
    context.saveReview({applicationId:item.id, fingerprint:item.fingerprint, eligibility:'standard', approvedAmount:item.amount, amountVerified:true}, 'info@izutrip.com');
  }
  function request(action,data = {}, overrides = {}) {
    const payload = JSON.stringify({action,data,actor:'sunaid20220708@gmail.com',timestamp:Date.now(),nonce:crypto.randomUUID(),...overrides});
    const signature = crypto.createHmac('sha256',properties.BACKEND_SECRET).update(payload).digest('hex');
    return context.doPost({postData:{contents:JSON.stringify({payload,signature})}});
  }
  return {context, request, state, historyRows, confirmationRows, workflowRows, responseRows, properties, calendar};
}
function preview(h, amount = 23000) {
  const item = h.request('list').data.applications[0];
  const saved = h.request('saveReview', {applicationId:item.id, fingerprint:item.fingerprint, eligibility:item.workflow.eligibility === 'conditional' ? 'conditional' : 'standard', conditions:item.workflow.conditions || '', conditionsAccepted:item.workflow.conditionsAccepted, approvedAmount:amount, amountVerified:true});
  assert.equal(saved.ok,true);
  const result = h.request('preview',{applicationId:item.id,amount});
  assert.equal(result.ok,true); return result.data;
}
function send(h,p) { return h.request('send',{attemptId:p.attemptId,confirmed:true}); }
function confirm(h, item, changes = {}) {
  const review = h.request('checkReservation', {applicationId:item.id, fingerprint:item.fingerprint});
  return h.request('confirmReservation', {applicationId:item.id, fingerprint:item.fingerprint, reviewToken:review.data?.reviewToken, confirmed:true, paymentChecked:true, ...changes});
}
function configure() {
  Object.assign(process.env,{ADMIN_SESSION_SECRET:'s'.repeat(48), ADMIN_BACKEND_SECRET:'b'.repeat(48), ADMIN_GOOGLE_CLIENT_ID:'test-client', ADMIN_BACKEND_URL:'https://script.google.com/macros/s/test/exec', ADMIN_ORIGIN:'https://admin.example.test'});
}
async function call(req) {
  const res = {headers:{}, setHeader(k,v){this.headers[k]=v;}, status(s){this.code=s;return this;},json(b){this.body=b;return this;}};
  await handler({headers:{},method:'GET',query:{},...req},res); return res;
}

test('reservation parser rejects missing, duplicate, reversed and impossible dates', () => {
  const h = backendHarness(); const parse = h.context.parseReservation;
  assert.equal(parse(summary).valid,true);
  for (const text of [summary.replace('2026/11/01','2026/02/30'),summary.replace('返却日時：2026/11/02','返却日時：2026/10/31'),summary + '概算料金：5円\n',summary.replace('22,500円','22,50円'),summary.replace('【ご予約内容】','自由なお問い合わせ')]) assert.equal(parse(text).valid,false);
});
test('missing email column and general inquiries cannot become sends', () => {
  const h = backendHarness({email:false}); const item = h.request('list').data.applications[0];
  assert.ok(item.issues.includes('メールアドレスなし・不正'));
  assert.equal(h.request('preview',{applicationId:item.id,amount:100}).error,'INVALID_APPLICATION');
  h.responseRows[1][1] = 'お問い合わせ'; assert.equal(h.request('list').data.applications.length,0);
  assert.equal(h.state.calls,0);
});
test('edited amount, fixed bank link and no deadline appear in immutable preview', () => {
  const h = backendHarness(), p = preview(h,12345);
  assert.equal(p.envelope.amount,12345); assert.match(p.envelope.body,/12,345円/);
  assert.ok(p.envelope.body.includes(h.context.BANK_LINK)); assert.match(p.envelope.body,/入金確認/); assert.match(p.envelope.body,/振込手数料/);
  assert.doesNotMatch(p.envelope.body,/期限/); assert.equal(send(h,p).data.status,'sent');
  assert.equal(h.state.lastMail.to,'fiction@example.test'); assert.equal(h.state.lastMail.body,p.envelope.body);
});
test('repeated click and reloaded preview cannot resend successful application', () => {
  const h = backendHarness(), p = preview(h); assert.equal(send(h,p).ok,true);
  assert.equal(send(h,p).data.alreadySent,true); assert.equal(h.state.calls,1);
  const item = h.request('list').data.applications[0];
  assert.equal(item.status,'sent'); assert.ok(item.sentAt); assert.equal(h.request('preview',{applicationId:item.id,amount:1}).error,'ALREADY_SENT');
  assert.equal(item.status === 'confirmed',false);
});
test('Gmail exception and save-after-send failure both block retry as unknown', () => {
  for (const failure of ['throwGmail','failSentSave']) {
    const h = backendHarness(), p = preview(h); h.state[failure] = true;
    assert.equal(send(h,p).ok,false); assert.equal(h.request('list').data.applications[0].status,'unknown');
    assert.equal(send(h,p).error,'SEND_RESULT_UNKNOWN'); assert.equal(h.state.calls,1);
    const item = h.request('list').data.applications[0]; assert.equal(h.request('preview',{applicationId:item.id,amount:1}).error,'SEND_RESULT_UNKNOWN');
  }
});
test('failure before durable sending state never calls Gmail', () => {
  const h = backendHarness(), p = preview(h); h.state.failSendingSave=true;
  assert.equal(send(h,p).ok,false); assert.equal(h.state.calls,0);
});
test('sender preflight failure is recorded as failed with zero sends', () => {
  const h = backendHarness(), p = preview(h); h.state.owner='other@example.test';
  assert.equal(send(h,p).error,'SENDER_NOT_CONFIGURED'); assert.equal(h.state.calls,0);
  assert.equal(h.request('list').data.applications[0].status,'failed');
});
test('unknown resolution requires mailbox check and delay, retaining audit trail', () => {
  const h = backendHarness(), p = preview(h); h.state.throwGmail=true; send(h,p);
  assert.equal(h.request('resolveUnknown',{attemptId:p.attemptId,result:'notSent'}).error,'MAILBOX_CHECK_REQUIRED');
  assert.equal(h.request('resolveUnknown',{attemptId:p.attemptId,result:'notSent',mailboxChecked:true}).error,'WAIT_FOR_SEND_COMPLETION');
  h.historyRows[1][9] = new Date(Date.now()-360000).toISOString();
  assert.equal(h.request('resolveUnknown',{attemptId:p.attemptId,result:'notSent',mailboxChecked:true}).data.status,'failed');
  h.state.throwGmail=false; const fresh = preview(h); assert.equal(send(h,fresh).ok,true);
  const history = h.request('list').data.applications[0].history;
  assert.equal(history.length,2); assert.ok(history[0].resolvedAt); assert.match(history[0].detail,/MAILBOX_CHECKED_notSent/);
});
test('test mode cannot send customer mail, and test recipient cannot be overridden', () => {
  const h = backendHarness({enabled:false}), p=preview(h);
  assert.equal(send(h,p).error,'CUSTOMER_SEND_DISABLED'); assert.equal(h.state.calls,0);
  const t=h.request('previewTest',{email:'real@example.test',amount:999999}).data;
  assert.equal(t.envelope.email,'sunaid20220708@gmail.com'); assert.equal(t.envelope.amount,100);
  assert.equal(h.request('sendTest',{attemptId:t.attemptId,confirmed:true}).ok,true);
  assert.equal(h.state.lastMail.to,'sunaid20220708@gmail.com'); assert.match(h.state.lastMail.body,/お振込みは不要/);
});
test('concurrent, superseded, unconfirmed, changed and duplicate responses are blocked', () => {
  const h = backendHarness(), p=preview(h), newer=preview(h);
  assert.equal(send(h,p).error,'PREVIEW_SUPERSEDED');
  assert.equal(h.request('send',{attemptId:newer.attemptId}).error,'CONFIRMATION_REQUIRED');
  h.state.locked=true; assert.equal(send(h,newer).error,'BUSY'); h.state.locked=false;
  h.responseRows[1][2]='変更された顧客'; assert.equal(send(h,newer).error,'APPLICATION_CHANGED');
  h.responseRows.push(h.responseRows[1].slice()); assert.ok(h.request('list').data.applications.every(a => a.issues.length > 0)); assert.equal(h.state.calls,0);
});
test('backend HMAC, actor and request age are checked before private reads', () => {
  const h=backendHarness();
  assert.equal(h.context.doPost({postData:{contents:JSON.stringify({payload:'{}',signature:'bad'})}}).error,'AUTH_REQUIRED');
  assert.equal(h.request('list',{}, {actor:'stranger@example.test'}).error,'AUTH_REQUIRED');
  assert.equal(h.request('list',{}, {timestamp:Date.now()-180000}).error,'AUTH_REQUIRED');
});
test('payment confirmation creates one private calendar event and marks the application confirmed', () => {
  const h=backendHarness(), item=h.request('list').data.applications[0];
  assert.equal(h.request('confirmReservation',{applicationId:item.id,confirmed:true}).error,'PAYMENT_CONFIRMATION_REQUIRED');
  const confirmed=confirm(h,item);
  assert.equal(confirmed.ok,true); assert.equal(confirmed.data.status,'confirmed');
  assert.equal(h.state.events.length,1); assert.equal(h.state.events[0].visibility,'private');
  assert.match(h.state.events[0].title,/架空顧客/); assert.match(h.state.events[0].description,/fiction@example\.test/);
  const listed=h.request('list').data.applications[0]; assert.equal(listed.reservationStatus,'confirmed');
  assert.equal(confirm(h,item).data.alreadyConfirmed,true);
  assert.equal(h.state.events.length,1);
});
test('calendar conflicts stop confirmation and concurrent duplicate events are avoided', () => {
  const h=backendHarness(), item=h.request('list').data.applications[0];
  h.state.events.push({start:new Date('2026-11-01T11:00:00+09:00'),end:new Date('2026-11-01T12:00:00+09:00'),getDescription:()=>'',getStartTime(){return this.start;},getEndTime(){return this.end;}});
  assert.equal(confirm(h,item).error,'RESERVATION_CONFLICT');
  assert.equal(h.state.events.length,1); assert.equal(h.confirmationRows.length,1);
});
test('calendar event is recoverable if the confirmation audit write fails; public availability exposes dates only', () => {
  const h=backendHarness(), item=h.request('list').data.applications[0]; h.state.failConfirmationAppend=true;
  assert.equal(confirm(h,item).ok,false);
  assert.equal(h.state.events.length,1); h.state.failConfirmationAppend=false;
  const recovered=confirm(h,item);
  assert.equal(recovered.ok,true); assert.equal(recovered.data.recoveredExistingEvent,true); assert.equal(h.state.events.length,1);
  const availabilityResult=h.request('availability'); assert.equal(availabilityResult.ok,true,JSON.stringify(availabilityResult));
  const publicRows=availabilityResult.data.bookings; assert.ok(publicRows.length);
  assert.deepEqual(Object.keys(publicRows[0]).sort(),['end','start']);
  assert.deepEqual(availabilityResult.data.inquiries,[]);
  assert.equal(JSON.stringify(availabilityResult.data).includes('架空顧客'),false);
});
test('inquiry periods appear publicly as △ ranges, remain selectable and can be removed by admin', () => {
  const h=backendHarness();
  const today=new Date(Date.now()+9*3600000); today.setUTCHours(0,0,0,0);
  const day=n=>new Date(today.getTime()+n*86400000).toISOString().slice(0,10);
  const added=h.request('setInquiry',{start:day(10),end:day(11)});
  assert.equal(added.ok,true); assert.equal(added.data.start,day(10)); assert.equal(added.data.end,day(12));
  const listed=h.request('list').data.inquiries; assert.equal(listed.length,1); assert.equal(listed[0].id,added.data.id);
  const availability=h.request('availability').data;
  assert.equal(availability.bookings.length,0); assert.equal(availability.inquiries.length,1);
  assert.deepEqual(Object.keys(availability.inquiries[0]).sort(),['end','start']);
  const item=h.request('list').data.applications[0]; assert.equal(item.requiresInquiry,false);
  assert.equal(confirm(h,item).ok,true);
  assert.equal(h.state.events.length,2);
  assert.equal(h.request('removeInquiry',{id:added.data.id}).data.removed,true);
  assert.deepEqual(h.request('availability').data.inquiries,[]);
  assert.equal(h.state.events.length,1);
});
test('a one-day inquiry period is valid and marks overlapping requests for review', () => {
  const h=backendHarness();
  const added=h.request('setInquiry',{start:'2026-11-01',end:'2026-11-01'});
  assert.equal(added.ok,true); assert.equal(added.data.end,'2026-11-02');
  const item=h.request('list').data.applications[0];
  assert.equal(item.requiresInquiry,true);
  assert.equal(h.request('saveReview',{applicationId:item.id,fingerprint:item.fingerprint,eligibility:'conditional',conditions:'受渡し時刻を個別調整',conditionsAccepted:true,approvedAmount:22500,amountVerified:true}).ok,true);
  assert.equal(confirm(h,item).ok,true);
});
test('session tampering, expiry and forged login are rejected', async () => {
  configure(); const payload={purpose:'session',email:'sunaid20220708@gmail.com',sub:'test-sub',csrf:'csrf',exp:Date.now()+60000};
  const token=S.sign(payload); assert.equal(S.decode(token,'session').email,payload.email);
  assert.throws(() => S.decode(token+'x','session')); assert.throws(() => S.decode(S.sign({...payload,exp:0}),'session'));
  assert.equal((await call({query:{action:'list'}})).code,401);
  const nonce='nonce', challenge=S.sign({purpose:'login',nonce,exp:Date.now()+60000});
  const res=await call({method:'POST',query:{action:'login'},headers:{origin:process.env.ADMIN_ORIGIN,cookie:S.LOGIN_COOKIE+'='+challenge},body:{nonce,credential:'forged'}});
  assert.equal(res.code,401);
});
test('API rejects disallowed accounts, wrong nonce, cross-origin and wrong CSRF', async () => {
  configure(); const verify=OAuth2Client.prototype.verifyIdToken;
  const nonce='nonce', challenge=S.sign({purpose:'login',nonce,exp:Date.now()+60000});
  try {
    let payload={email:'stranger@example.test',email_verified:true,sub:'sub',nonce};
    OAuth2Client.prototype.verifyIdToken=async ({audience}) => {assert.equal(audience,'test-client');return {getPayload:() => payload};};
    const req={method:'POST',query:{action:'login'},headers:{origin:process.env.ADMIN_ORIGIN,cookie:S.LOGIN_COOKIE+'='+challenge},body:{nonce,credential:'mocked-valid-token'}};
    assert.equal((await call(req)).code,403);
    payload={...payload,email:'sunaid20220708@gmail.com',nonce:'wrong'}; assert.equal((await call(req)).code,403);
    payload={...payload,nonce}; const allowed=await call(req); assert.equal(allowed.code,200);
    assert.match(allowed.headers['Set-Cookie'][0],/HttpOnly; Secure; SameSite=Strict/);
    const cookie=allowed.headers['Set-Cookie'][0].split(';')[0];
    assert.equal((await call({method:'POST',query:{action:'preview'},headers:{origin:'https://evil.test',cookie,'x-admin-csrf':allowed.body.csrf},body:{}})).code,403);
    assert.equal((await call({method:'POST',query:{action:'preview'},headers:{origin:process.env.ADMIN_ORIGIN,cookie,'x-admin-csrf':'wrong'},body:{}})).code,403);
    payload={...payload,email:'info@izutrip.com',hd:undefined}; assert.equal((await call(req)).code,403);
    payload.hd='izutrip.com'; assert.equal((await call(req)).code,200);
  } finally {OAuth2Client.prototype.verifyIdToken=verify;}
});
test('backend network loss is result unknown for send and unavailable for reads', async () => {
  configure(); const fetchOriginal=global.fetch; global.fetch=async () => {throw new Error('timeout');};
  try {
    await assert.rejects(() => S.backend('send',{}, {email:'sunaid20220708@gmail.com'}),/ACTION_RESULT_UNKNOWN/);
    await assert.rejects(() => S.backend('list',{}, {email:'sunaid20220708@gmail.com'}),/BACKEND_UNAVAILABLE/);
  } finally {global.fetch=fetchOriginal;}
});
test('public availability endpoint is GET-only and whitelists private backend fields', async () => {
  const original=S.publicAvailability; S.publicAvailability=async()=>({bookings:[{start:'2026-11-01T01:00:00.000Z',end:'2026-11-02T01:00:00.000Z',name:'Private Name',email:'private@example.test'}],inquiries:[{start:'2026-11-03T00:00:00+09:00',end:'2026-11-04T00:00:00+09:00',id:'private-id'}],pending:[{start:'2026-11-05T00:00:00+09:00',end:'2026-11-06T00:00:00+09:00',applicationId:'private-application',name:'Private Name'}]});
  try {
    const response=await availabilityHandler({method:'GET'},{headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
    assert.equal(response.code,200); assert.deepEqual(Object.keys(response.body.bookings[0]).sort(),['end','start']);
    assert.deepEqual(Object.keys(response.body.inquiries[0]).sort(),['end','start']);
    assert.deepEqual(Object.keys(response.body.pending[0]).sort(),['end','start']);
    assert.equal(JSON.stringify(response.body).includes('private-application'),false);
    assert.equal(JSON.stringify(response.body).includes('private-id'),false);
    assert.equal(response.headers['Cache-Control'],'no-store');
    const rejected=await availabilityHandler({method:'POST'},{setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
    assert.equal(rejected.code,405);
  } finally {S.publicAvailability=original;}
});
test('public availability proxy signs a fixed read-only action and strips backend fields', async () => {
  configure(); const fetchOriginal=global.fetch; let captured;
  global.fetch=async (url,options) => {
    captured={url,options};
    const envelope=JSON.parse(options.body), body=JSON.parse(envelope.payload);
    assert.equal(url,process.env.ADMIN_BACKEND_URL); assert.equal(body.action,'availability'); assert.deepEqual(body.data,{});
    assert.equal(body.actor,'sunaid20220708@gmail.com'); assert.equal(Math.abs(Date.now()-body.timestamp)<5000,true);
    assert.equal(crypto.createHmac('sha256',process.env.ADMIN_BACKEND_SECRET).update(envelope.payload).digest('hex'),envelope.signature);
    return {ok:true,json:async()=>({ok:true,data:{bookings:[{start:'2026-11-01T01:00:00.000Z',end:'2026-11-02T01:00:00.000Z',name:'Private Name',email:'private@example.test'}],inquiries:[{start:'2026-11-03T00:00:00+09:00',end:'2026-11-04T00:00:00+09:00',id:'private-id'}],pending:[{start:'2026-11-05T00:00:00+09:00',end:'2026-11-06T00:00:00+09:00',applicationId:'private-application',name:'Private Name'}]}})};
  };
  try {
    const values=await S.publicAvailability(); assert.deepEqual(Object.keys(values.bookings[0]).sort(),['end','start']);
    assert.deepEqual(Object.keys(values.inquiries[0]).sort(),['end','start']);
    assert.deepEqual(Object.keys(values.pending[0]).sort(),['end','start']);
    assert.equal(JSON.stringify(values).includes('private@example.test'),false); assert.equal(captured.options.method,'POST');
  } finally {global.fetch=fetchOriginal;}
});

test('current and legacy estimate labels work; ambiguous combinations are rejected', () => {
  const parse=backendHarness().context.parseReservation;
  assert.equal(parse(summary.replace('概算料金：','車両の概算料金：')).amount,22500);
  assert.equal(parse(summary + '車両の概算料金：22,500円\n').valid,false);
  assert.equal(parse(summary + '車両の概算料金：1円\n').valid,false);
});
test('an unreviewed request is public pending without sending mail or creating a booking', () => {
  const h=backendHarness({reviewed:false});
  const availability=h.request('availability').data;
  assert.equal(availability.pending.length,1);
  assert.deepEqual(Object.keys(availability.pending[0]).sort(),['end','start']);
  assert.equal(availability.bookings.length,0); assert.equal(h.state.calls,0); assert.equal(h.state.events.length,0);
  assert.equal(JSON.stringify(availability).includes('fiction@example.test'),false);
  assert.equal(h.workflowRows.length,1); // public reads do not write workflow state
});
test('closing a pending request releases the public marker and prevents sends and confirmation', () => {
  const h=backendHarness(), p=preview(h), item=h.request('list').data.applications[0];
  assert.equal(h.request('closeApplication',{applicationId:item.id,fingerprint:item.fingerprint}).ok,true);
  assert.deepEqual(h.request('availability').data.pending,[]);
  assert.equal(send(h,p).error,'APPLICATION_CLOSED');
  assert.equal(confirm(h,item).error,'APPLICATION_CLOSED');
  assert.equal(h.state.calls,0);
});
test('a confirmed request leaves pending and cannot be closed or invoiced again', () => {
  const h=backendHarness(), p=preview(h), item=h.request('list').data.applications[0];
  assert.equal(confirm(h,item).ok,true);
  assert.deepEqual(h.request('availability').data.pending,[]);
  assert.equal(h.request('closeApplication',{applicationId:item.id,fingerprint:item.fingerprint}).error,'ALREADY_CONFIRMED');
  assert.equal(send(h,p).error,'ALREADY_CONFIRMED');
});
test('earlier pending requests prevent a later invoice until the earlier request is closed', () => {
  const h=backendHarness();
  const second=h.responseRows[1].slice(); second[0]=new Date('2026-10-12T10:00:00Z'); second[2]='後続顧客'; h.responseRows.push(second);
  const item=h.request('list').data.applications[0], p=preview(h);
  assert.equal(send(h,p).error,'EARLIER_APPLICATION_PENDING');
  assert.equal(confirm(h,item).error,'EARLIER_APPLICATION_PENDING');
  const earlier=h.request('list').data.applications[1];
  assert.equal(h.request('closeApplication',{applicationId:earlier.id,fingerprint:earlier.fingerprint}).ok,true);
  assert.equal(send(h,p).ok,true);
});
test('automatic guidance requires both switches and a verified quote, and never confirms a reservation', () => {
  const h=backendHarness();
  assert.equal(h.context.runAutomaticGuidance().enabled,false);
  h.properties.ENABLE_AUTO_GUIDANCE='true'; h.properties.ENABLE_CUSTOMER_SEND='false';
  assert.equal(h.context.runAutomaticGuidance().enabled,false); assert.equal(h.state.calls,0);
  h.properties.ENABLE_CUSTOMER_SEND='true';
  assert.equal(h.context.runAutomaticGuidance().sent,1);
  assert.equal(h.state.calls,1); assert.equal(h.state.events.length,0);
  assert.equal(h.context.runAutomaticGuidance().sent,0); assert.equal(h.state.calls,1);
  assert.equal(h.request('list').data.applications[0].reservationStatus,'unconfirmed');
  assert.match(h.state.lastMail.body,/当社の最終確認/);
});
test('a free-text form amount cannot become an automatic invoice without verification', () => {
  const h=backendHarness({reviewed:false}); h.properties.ENABLE_AUTO_GUIDANCE='true';
  assert.equal(h.context.runAutomaticGuidance().sent,0); assert.equal(h.state.calls,0);
  const item=h.request('list').data.applications[0];
  assert.equal(h.request('saveReview',{applicationId:item.id,fingerprint:item.fingerprint,eligibility:'standard',approvedAmount:1}).error,'QUOTE_VERIFICATION_REQUIRED');
  assert.equal(confirm(h,item).error,'FINAL_REVIEW_REQUIRED');
});
test('conditional guidance waits for acceptance and includes the accepted terms', () => {
  const h=backendHarness(), item=h.request('list').data.applications[0]; h.properties.ENABLE_AUTO_GUIDANCE='true';
  const data={applicationId:item.id,fingerprint:item.fingerprint,eligibility:'conditional',conditions:'受渡しは指定場所・午後のみ',approvedAmount:22500,amountVerified:true};
  assert.equal(h.request('saveReview',data).ok,true);
  assert.equal(h.context.runAutomaticGuidance().sent,0); assert.equal(h.state.calls,0);
  assert.equal(h.request('saveReview',{...data,conditionsAccepted:true}).ok,true);
  assert.equal(h.context.runAutomaticGuidance().sent,1);
  assert.match(h.state.lastMail.body,/受渡しは指定場所・午後のみ/);
});
test('automatic guidance does not retry an unknown or failed attempt', () => {
  const h=backendHarness(); h.properties.ENABLE_AUTO_GUIDANCE='true'; h.state.throwGmail=true;
  assert.equal(h.context.runAutomaticGuidance().sent,0); assert.equal(h.state.calls,1);
  h.state.throwGmail=false;
  assert.equal(h.context.runAutomaticGuidance().sent,0); assert.equal(h.state.calls,1);
});
test('a booking added after preview prevents payment guidance', () => {
  const h=backendHarness(), p=preview(h);
  h.calendar.createEvent('貸出不可',new Date('2026-11-01T11:00:00+09:00'),new Date('2026-11-01T12:00:00+09:00'),{description:''});
  assert.equal(send(h,p).error,'RESERVATION_CONFLICT'); assert.equal(h.state.calls,0);
});
test('a new inquiry period requires conditional review before automatic payment guidance', () => {
  const h=backendHarness(); h.properties.ENABLE_AUTO_GUIDANCE='true';
  assert.equal(h.request('setInquiry',{start:'2026-11-01',end:'2026-11-01'}).ok,true);
  assert.equal(h.context.runAutomaticGuidance().sent,0); assert.equal(h.state.calls,0);
});
test('final confirmation rejects a missing token, changed quote or new booking', () => {
  const h=backendHarness(), item=h.request('list').data.applications[0];
  const review=h.request('checkReservation',{applicationId:item.id,fingerprint:item.fingerprint}).data;
  assert.equal(review.ready,true);
  assert.equal(h.request('confirmReservation',{applicationId:item.id,fingerprint:item.fingerprint,confirmed:true,paymentChecked:true}).error,'FINAL_REVIEW_REQUIRED');
  h.request('saveReview',{applicationId:item.id,fingerprint:item.fingerprint,eligibility:'standard',approvedAmount:23000,amountVerified:true});
  assert.equal(h.request('confirmReservation',{applicationId:item.id,fingerprint:item.fingerprint,reviewToken:review.reviewToken,confirmed:true,paymentChecked:true}).error,'FINAL_REVIEW_REQUIRED');
  const current=h.request('checkReservation',{applicationId:item.id,fingerprint:item.fingerprint}).data;
  h.calendar.createEvent('新しい予定',new Date('2026-11-01T11:00:00+09:00'),new Date('2026-11-01T12:00:00+09:00'),{description:''});
  assert.equal(h.request('confirmReservation',{applicationId:item.id,fingerprint:item.fingerprint,reviewToken:current.reviewToken,confirmed:true,paymentChecked:true}).error,'RESERVATION_CONFLICT');
});
test('response edits invalidate an existing quote and stale approval; closed state survives edits', () => {
  const h=backendHarness(), item=h.request('list').data.applications[0];
  h.responseRows[1][2]='変更後の顧客';
  assert.equal(confirm(h,item).error,'APPLICATION_CHANGED');
  const updated=h.request('list').data.applications[0];
  assert.equal(updated.workflow.eligibility,'unreviewed');
  h.request('closeApplication',{applicationId:updated.id,fingerprint:updated.fingerprint});
  h.responseRows[1][2]='さらに変更';
  assert.equal(h.request('list').data.applications[0].workflow.closed,true);
  assert.deepEqual(h.request('availability').data.pending,[]);
});
test('form-trigger input from another spreadsheet cannot start automatic mail', () => {
  const h=backendHarness(); h.properties.ENABLE_AUTO_GUIDANCE='true';
  assert.throws(()=>h.context.onReservationFormSubmit({source:{getId:()=> 'wrong'},range:{getSheet:()=>({getSheetId:()=>405558677})}}),/INVALID_FORM_EVENT/);
  assert.equal(h.state.calls,0);
});
