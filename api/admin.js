const crypto = require('node:crypto');
const {OAuth2Client} = require('google-auth-library');
const S = require('../lib/admin-security');
const google = new OAuth2Client();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const action = req.query.action || 'config';
    if (action === 'config' && req.method === 'GET') {
      if (!S.ready()) return res.status(200).json({ready: false});
      const nonce = crypto.randomBytes(32).toString('hex');
      res.setHeader('Set-Cookie', S.cookie(S.LOGIN_COOKIE, S.sign({purpose:'login', nonce, exp:Date.now() + 600000}), 600));
      let user = null;
      try { user = S.session(req); } catch (e) { if (e.status !== 401) throw e; }
      return res.status(200).json({ready:true, clientId:process.env.ADMIN_GOOGLE_CLIENT_ID, nonce,
        user:user ? {email:user.email, csrf:user.csrf} : null});
    }
    if (action === 'login' && req.method === 'POST') {
      if (!S.ready()) S.fail('CONFIG_REQUIRED', 503);
      S.origin(req);
      const challenge = S.decode(S.cookies(req)[S.LOGIN_COOKIE], 'login');
      if (!S.equal(req.body?.nonce, challenge.nonce)) S.fail('CSRF_REJECTED', 403);
      if (typeof req.body?.credential !== 'string' || req.body.credential.length > 12000) S.fail('AUTH_REQUIRED', 401);
      let payload;
      try {
        payload = (await google.verifyIdToken({idToken:req.body.credential, audience:process.env.ADMIN_GOOGLE_CLIENT_ID})).getPayload();
      } catch { S.fail('AUTH_REQUIRED', 401); }
      const email = String(payload.email || '').toLowerCase();
      if (payload.nonce !== challenge.nonce || payload.email_verified !== true || !payload.sub || !S.ALLOWED.has(email) ||
          (email === 'info@izutrip.com' && payload.hd !== 'izutrip.com')) S.fail('FORBIDDEN', 403);
      const user = {purpose:'session', sub:payload.sub, email, csrf:crypto.randomBytes(32).toString('hex'), exp:Date.now() + 3600000};
      res.setHeader('Set-Cookie', [S.cookie(S.COOKIE, S.sign(user), 3600), S.cookie(S.LOGIN_COOKIE, '', 0)]);
      return res.status(200).json({email:user.email, csrf:user.csrf});
    }
    const user = S.session(req);
    if (action === 'list' && req.method === 'GET') return res.status(200).json(await S.backend('list', {}, user));
    if (req.method !== 'POST') S.fail('METHOD_NOT_ALLOWED', 405);
    S.csrf(req, user);
    if (action === 'logout') {
      res.setHeader('Set-Cookie', S.cookie(S.COOKIE, '', 0)); return res.status(200).json({ok:true});
    }
    if (!['preview', 'send', 'resolveUnknown', 'previewTest', 'sendTest', 'confirmReservation'].includes(action)) S.fail('ACTION_REJECTED');
    return res.status(200).json(await S.backend(action, req.body || {}, user));
  } catch (error) {
    // Never return provider errors, credentials or customer content to logs / unauthenticated callers.
    return res.status(error.status || 500).json({error:error.status ? error.message : 'INTERNAL_ERROR'});
  }
};
