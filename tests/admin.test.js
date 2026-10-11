const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../lib/admin-security');
const handler = require('../api/admin');
const {OAuth2Client} = require('google-auth-library');
const source = fs.readFileSync('apps-script/Code.gs', 'utf8');
const summary = '【ご予約内容】\n出発日時：2026/11/01 10:00\n返却日時：2026/11/02 10:00\n概算料金：22,500円\n';
function backendHarness({email = true, enabled = true} = {}) {
  const properties = {BACKEND_SECRET:'b'.repeat(48), SPREADSHEET_ID:'private-test-id', RESPONSE_SHEET_ID:'405558677', ENABLE_CUSTOMER_SEND:String(enabled)};
  const responseRows = [['タイムスタンプ','お問い合わせ種別 ','お名前','予約またはお問い合わせ内容', ...(email ? ['メールアドレス'] : [])],
    [new Date('2026-10-11T10:00:00Z'), '予約希望', '架空顧客', summary, ...(email ? ['fiction@example.test'] : [])]];
  const historyRows = [];
  const state = {calls:0, throwGmail:false, failSentSave:false, failSendingSave:false, owner:'info@izutrip.com', locked:false};
  function sheet(rows, id) {
    return {getSheetId:() => id, getDataRange:() => ({getValues:() => rows.map(r => r.slice())}), getLastRow:() => rows.length,
      appendRow:r => rows.push(r.slice()), setFrozenRows:() => {},
      getRange:(r,c,n,m) => ({getValues:() => rows.slice(r - 1,r - 1 + n).map(a => a.slice(c - 1,c - 1 + m)),
        setValues:values => {
          if ((state.failSentSave && values[0][4] === 'sent') || (state.failSendingSave && values[0][4] === 'sending')) throw new Error('storage failure');
          values.forEach((v,i) => { rows[r - 1 + i] = v.slice(); });
        }})};
  }
  const responses = sheet(responseRows,405558677), histories = sheet(historyRows,8);
  let created = false;
  const book = {getSheets:() => [responses], getSheetByName:() => created ? histories : null, insertSheet:() => {created = true; return histories;}};
  const context = vm.createContext({Date, JSON, Number, String, Boolean, Error, console,
    PropertiesService:{getScriptProperties:() => ({getProperty:key => properties[key] || null})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'}, Charset:{UTF_8:'utf8'}, getUuid:() => crypto.randomUUID(),
      computeDigest:(algorithm,text) => [...crypto.createHash(algorithm).update(text).digest()],
      computeHmacSha256Signature:(text,secret) => [...crypto.createHmac('sha256',secret).update(text).digest()],
      formatDate:d => d.toISOString().replace('T',' ').slice(0,19)},
    SpreadsheetApp:{openById:() => book, flush:() => {}},
    Session:{getEffectiveUser:() => ({getEmail:() => state.owner})},
    GmailApp:{getAliases:() => [], sendEmail:(to,subject,body,opts) => {state.calls++; state.lastMail={to,subject,body,opts}; if (state.throwGmail) throw new Error('lost response');}},
    LockService:{getScriptLock:() => ({tryLock:() => {if (state.locked) return false; state.locked = true; return true;}, hasLock:() => state.locked, releaseLock:() => {state.locked = false;}})},
    CacheService:{getScriptCache:() => {const store = state.cache || (state.cache = {}); return {get:k => store[k], put:(k,v) => {store[k] = v;}};}},
    ContentService:{MimeType:{JSON:'json'}, createTextOutput:s => ({setMimeType:() => JSON.parse(s)})}
  });
  vm.runInContext(source, context); context.setup();
  function request(action,data = {}, overrides = {}) {
    const payload = JSON.stringify({action,data,actor:'sunaid20220708@gmail.com',timestamp:Date.now(),nonce:crypto.randomUUID(),...overrides});
    const signature = crypto.createHmac('sha256',properties.BACKEND_SECRET).update(payload).digest('hex');
    return context.doPost({postData:{contents:JSON.stringify({payload,signature})}});
  }
  return {context, request, state, historyRows, responseRows, properties};
}
function preview(h, amount = 23000) {
  const item = h.request('list').data.applications[0];
  const result = h.request('preview',{applicationId:item.id,amount});
  assert.equal(result.ok,true); return result.data;
}
function send(h,p) { return h.request('send',{attemptId:p.attemptId,confirmed:true}); }
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
    await assert.rejects(() => S.backend('send',{}, {email:'sunaid20220708@gmail.com'}),/SEND_RESULT_UNKNOWN/);
    await assert.rejects(() => S.backend('list',{}, {email:'sunaid20220708@gmail.com'}),/BACKEND_UNAVAILABLE/);
  } finally {global.fetch=fetchOriginal;}
});
