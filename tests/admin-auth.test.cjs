'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const handler = require('../api/admin/auth.js');
const original = {
  SUNAID_ADMIN_EMAIL: process.env.SUNAID_ADMIN_EMAIL,
  SUNAID_ADMIN_PASSWORD_SALT: process.env.SUNAID_ADMIN_PASSWORD_SALT,
  SUNAID_ADMIN_PASSWORD_HASH: process.env.SUNAID_ADMIN_PASSWORD_HASH,
  SUNAID_ADMIN_SESSION_SECRET: process.env.SUNAID_ADMIN_SESSION_SECRET
};
function setCredentials(){
  const salt=crypto.randomBytes(16);
  process.env.SUNAID_ADMIN_EMAIL='admin@example.test';
  process.env.SUNAID_ADMIN_PASSWORD_SALT=salt.toString('hex');
  process.env.SUNAID_ADMIN_PASSWORD_HASH=crypto.scryptSync('correct-password',salt,64).toString('hex');
  process.env.SUNAID_ADMIN_SESSION_SECRET=crypto.randomBytes(48).toString('base64url');
}
function request(method,body,cookie,origin='https://example.test'){
  const headers={host:'example.test'};
  if(method!=='GET')headers.origin=origin;
  if(cookie)headers.cookie=cookie;
  const req={method,headers,body};
  const res={
    statusCode:200,headers:{},
    setHeader(name,value){this.headers[name.toLowerCase()]=value;return this;},
    status(code){this.statusCode=code;return this;},
    json(data){this.body=data;return this;}
  };
  return handler(req,res).then(()=>res);
}
beforeEach(()=>{for(const key of Object.keys(original))delete process.env[key];});
afterEach(()=>{for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
test('missing secrets fail closed',async()=>{
  const r=await request('POST',{email:'admin@example.test',password:'correct-password'});
  assert.equal(r.statusCode,503);
  assert.equal((await request('GET')).body.authenticated,false);
});
test('invalid credentials are rejected without session',async()=>{
  setCredentials();
  for(const input of [{email:'wrong@example.test',password:'correct-password'},{email:'admin@example.test',password:'wrong'}]){
    const r=await request('POST',input);assert.equal(r.statusCode,401);assert.equal(r.headers['set-cookie'],undefined);
  }
});
test('successful login, session access, and logout',async()=>{
  setCredentials();
  const login=await request('POST',{email:'admin@example.test',password:'correct-password'});
  assert.equal(login.statusCode,200);assert.equal(login.body.authenticated,true);
  const raw=login.headers['set-cookie'];
  assert.match(raw,/HttpOnly/);assert.match(raw,/Secure/);assert.match(raw,/SameSite=Strict/);
  const session=raw.split(';')[0];
  assert.equal((await request('GET',undefined,session)).body.authenticated,true);
  const logout=await request('DELETE',undefined,session);
  assert.equal(logout.statusCode,200);assert.match(logout.headers['set-cookie'],/Max-Age=0/);
  assert.equal((await request('GET')).body.authenticated,false);
});
test('tampered, expired, and incorrectly signed sessions rejected',async()=>{
  setCredentials();
  const login=await request('POST',{email:'admin@example.test',password:'correct-password'});
  const raw=login.headers['set-cookie'].split(';')[0];
  assert.equal((await request('GET',undefined,raw+'x')).body.authenticated,false);
  const expired=Buffer.from(JSON.stringify({role:'admin',exp:Date.now()-1000})).toString('base64url');
  const sig=crypto.createHmac('sha256',process.env.SUNAID_ADMIN_SESSION_SECRET).update(expired).digest('base64url');
  assert.equal((await request('GET',undefined,'sunaid_admin_session='+expired+'.'+sig)).body.authenticated,false);
});
test('cross-origin writes rejected',async()=>{
  setCredentials();
  const r=await request('POST',{email:'admin@example.test',password:'correct-password'},undefined,'https://attacker.test');
  assert.equal(r.statusCode,403);
});
test('unsupported methods rejected',async()=>{
  setCredentials();assert.equal((await request('PUT')).statusCode,405);
});
