// Vercel serverless API. Credentials and session signing key must be set as environment variables.
// Required: SUNAID_ADMIN_EMAIL, SUNAID_ADMIN_PASSWORD_SALT (hex), SUNAID_ADMIN_PASSWORD_HASH (hex),
// SUNAID_ADMIN_SESSION_SECRET (random 32+ bytes).
const crypto = require('node:crypto');
const COOKIE = 'sunaid_admin_session';
function configured(){
  return Boolean(process.env.SUNAID_ADMIN_EMAIL &&
    /^[0-9a-f]{32,}$/i.test(process.env.SUNAID_ADMIN_PASSWORD_SALT||'') &&
    /^[0-9a-f]{128}$/i.test(process.env.SUNAID_ADMIN_PASSWORD_HASH||'') &&
    (process.env.SUNAID_ADMIN_SESSION_SECRET||'').length>=43);
}
function sign(payload){return crypto.createHmac('sha256',process.env.SUNAID_ADMIN_SESSION_SECRET).update(payload).digest('base64url');}
function checkSession(req){
  if(!configured())return false;
  const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim());
  const session=(cookies.find(x=>x.startsWith(COOKIE+'='))||'').slice(COOKIE.length+1);
  const [value,signature,...extra]=session.split('.');
  if(!value||!signature||extra.length)return false;
  const expected=sign(value);
  const a=Buffer.from(expected),b=Buffer.from(signature);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;
  try{const data=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));return data.role==='admin'&&Number.isFinite(data.exp)&&data.exp>Date.now();}catch{return false;}
}
function cookie(value,maxAge){return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}`;}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='GET')return res.status(200).json({authenticated:checkSession(req)});
  if(req.method!=='POST'&&req.method!=='DELETE'){res.setHeader('Allow','GET, POST, DELETE');return res.status(405).json({error:'Method not allowed'});}
  // Reject cross-site requests (same-origin request is required for any state change).
  const origin=req.headers.origin;
  const host=req.headers['x-forwarded-host']||req.headers.host;
  if(!origin||!host||origin!==`https://${host}`)return res.status(403).json({error:'Origin rejected'});
  if(req.method==='DELETE'){
    res.setHeader('Set-Cookie',cookie('',0));
    return res.status(200).json({authenticated:false});
  }
  if(!configured())return res.status(503).json({error:'Administrator authentication is not configured'});
  let body=req.body;
  if(typeof body==='string'){try{body=JSON.parse(body)}catch{body={}}}
  const email=String(body?.email||'').trim().toLowerCase();
  const password=String(body?.password||'');
  if(email.length>254||password.length>1024)return res.status(400).json({error:'Invalid input'});
  const expectedEmail=process.env.SUNAID_ADMIN_EMAIL.trim().toLowerCase();
  const derived=crypto.scryptSync(password,Buffer.from(process.env.SUNAID_ADMIN_PASSWORD_SALT,'hex'),64);
  const expected=Buffer.from(process.env.SUNAID_ADMIN_PASSWORD_HASH,'hex');
  // Verify both parts without exposing which one is incorrect.
  const valid=crypto.timingSafeEqual(derived,expected)&&email===expectedEmail;
  if(!valid)return res.status(401).json({authenticated:false});
  const payload=Buffer.from(JSON.stringify({role:'admin',exp:Date.now()+12*60*60*1000})).toString('base64url');
  res.setHeader('Set-Cookie',cookie(payload+'.'+sign(payload),12*60*60));
  return res.status(200).json({authenticated:true});
};
