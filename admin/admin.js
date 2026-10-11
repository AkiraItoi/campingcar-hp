'use strict';
const $ = id => document.getElementById(id);
const labels = {new:'未対応', prepared:'送信前確認', sent:'送信済み（Gmail受付）', failed:'未送信・再確認可', unknown:'結果不明・再送停止'};
const errors = {
  AUTH_REQUIRED:'ログインし直してください。', FORBIDDEN:'このアカウントは利用できません。', CONFIG_REQUIRED:'外部設定が必要です。',
  CONFIG_REQUIRED_BACKEND:'外部設定が必要です。', SETUP_REQUIRED:'Google側で初期設定を実行してください。',
  SEND_RESULT_UNKNOWN:'送信結果が不明です。再送せず、一覧を再読込みして送信履歴とinfo@の送信済みフォルダを確認してください。',
  CUSTOMER_SEND_DISABLED:'現在はテスト送信のみ有効です。', INVALID_APPLICATION:'メール・日時・金額を取得できません。元の回答を確認してください。',
  PREVIEW_SUPERSEDED:'別の確認操作が行われました。本文をもう一度確認してください。', PREVIEW_EXPIRED:'確認から15分経過しました。本文をもう一度確認してください。',
  APPLICATION_CHANGED:'申込内容が変更されました。一覧を再読込みしてください。', ALREADY_SENT:'送信済みです。重複送信は行いません。',
  BUSY:'別の処理が進行中です。少し待って一覧を再読込みしてください。', WAIT_FOR_SEND_COMPLETION:'処理開始から5分以上待ってください。',
  MAILBOX_CHECK_REQUIRED:'送信済みフォルダを確認してチェックを入れてください。', SENDER_NOT_CONFIGURED:'info@から送信できるGoogle設定が未完了です。',
  BACKEND_UNAVAILABLE:'送信処理に接続できません。外部設定・接続状況を確認してください。', BACKEND_ERROR:'処理を完了できませんでした。送信操作中なら再送せず、一覧の状態を確認してください。'
};
let user = null, items = [], current = null, pending = null, test = false, customerEnabled = false, sending = false, testAttempt = null;
async function api(action, data) {
  const options = {credentials:'same-origin', cache:'no-store', headers:{}};
  if (data !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.headers['X-Admin-Csrf'] = user?.csrf || ''; options.body = JSON.stringify(data); }
  let response, result;
  try { response = await fetch('/api/admin?action=' + action, options); result = await response.json(); }
  catch { throw new Error(['send','sendTest'].includes(action) ? errors.SEND_RESULT_UNKNOWN : errors.BACKEND_UNAVAILABLE); }
  if (!response.ok) throw new Error(errors[result.error] || '処理できませんでした。状態を再確認してください。');
  return result;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
function yen(amount) { return amount == null ? '読み取れません' : amount.toLocaleString('ja-JP') + '円'; }
function message(text) { $('message').textContent = text; }
function clearPreview() { pending = null; $('preview-area').hidden = true; $('confirm').checked = false; $('send').disabled = true; }
function refreshSend() { $('send').disabled = sending || !pending || !$('confirm').checked || (!test && !customerEnabled); }
async function load() {
  const result = await api('list'); items = result.applications; customerEnabled = result.customerSendEnabled; testAttempt = result.testAttempt;
  $('test').textContent = testAttempt?.status === 'unknown' ? 'テスト送信の結果を確認' : testAttempt?.status === 'sent' ? 'テスト送信済み' : 'テストメールを確認';
  $('test').disabled = testAttempt?.status === 'sent';
  $('mode').hidden = customerEnabled; $('rows').replaceChildren(); $('empty').hidden = items.length > 0;
  for (const item of items) {
    const tr = node('tr');
    const identity = node('td', item.name); identity.append(node('small', item.submittedAt), node('small', item.email || 'メールアドレスなし'));
    const dates = node('td', item.start || '開始日時なし'); dates.append(node('small', '→ ' + (item.end || '返却日時なし')));
    const status = node('td'); status.append(node('span', labels[item.status] || item.status, 'status ' + item.status));
    if (item.sentAt) status.append(node('small', new Date(item.sentAt).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' JST'));
    if (item.issues.length) status.append(node('small', item.issues.join('／'), 'issues'));
    const operation = node('td'), button = node('button', '確認'); button.className = 'secondary'; button.addEventListener('click', () => open(item)); operation.append(button);
    tr.append(identity, dates, node('td', yen(item.amount)), status, operation); $('rows').append(tr);
  }
  message('申込み ' + items.length + '件。利用日時は日本時間です。');
}
function open(item) {
  if (sending) return;
  test = false; current = item; clearPreview(); $('detail-message').textContent = '';
  $('application').replaceChildren(node('p', item.name + ' 様 ／ ' + (item.email || 'メールアドレスなし')), node('p', (item.start || '日時なし') + ' → ' + (item.end || '日時なし')));
  $('amount').value = item.lastAmount || item.amount || ''; $('amount').disabled = false;
  $('preview').hidden = item.status === 'sent' || item.status === 'unknown'; $('preview').disabled = item.issues.length > 0;
  $('reconcile').hidden = item.status !== 'unknown'; $('mailbox').checked = false;
  $('raw').textContent = item.raw; $('history').replaceChildren();
  for (const h of item.history) $('history').append(node('p', [labels[h.status], h.email, yen(h.amount), '確認：' + h.preparedAt, h.sentAt && '送信：' + h.sentAt, h.resolvedAt && '手動確認：' + h.resolvedAt, h.detail].filter(Boolean).join(' ／ ')));
  if (item.issues.length) $('detail-message').textContent = item.issues.join('／');
  $('detail').showModal();
}
async function preview() {
  clearPreview(); $('preview').disabled = true;
  try {
    const amount = Number($('amount').value); if (!test && (!Number.isSafeInteger(amount) || amount <= 0)) throw new Error('請求金額を整数で入力してください。');
    pending = await api(test ? 'previewTest' : 'preview', test ? {} : {applicationId:current.id, amount});
    customerEnabled = pending.customerSendEnabled;
    $('recipient').textContent = '宛先：' + pending.envelope.email; $('subject').textContent = '件名：' + pending.envelope.subject; $('body').textContent = pending.envelope.body;
    $('preview-area').hidden = false; $('send').textContent = test ? 'テストメールを送信' : '振込案内を送信';
    $('detail-message').textContent = !test && !customerEnabled ? errors.CUSTOMER_SEND_DISABLED : '本文確認後、チェックを入れて送信してください。'; refreshSend();
  } catch (e) { $('detail-message').textContent = e.message; }
  finally { $('preview').disabled = false; }
}
async function send() {
  if (sending || !pending || !$('confirm').checked) return;
  sending = true; refreshSend(); $('preview').disabled = true; $('amount').disabled = true;
  $('detail-message').textContent = '送信処理中です。結果を待ってください。';
  try {
    const result = await api(test ? 'sendTest' : 'send', {attemptId:pending.attemptId, confirmed:true});
    $('detail-message').textContent = '送信済み（Gmail受付）：' + new Date(result.sentAt).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' JST。予約確定にはしていません。';
    clearPreview(); $('preview').hidden = true;
  } catch (e) { $('detail-message').textContent = e.message; clearPreview(); $('preview').hidden = true; }
  finally { sending = false; try { await load(); } catch (e) { message(e.message); } }
}
async function resolve(result) {
  if (!$('mailbox').checked) { $('detail-message').textContent = errors.MAILBOX_CHECK_REQUIRED; return; }
  $('found').disabled = $('not-found').disabled = true;
  try { await api('resolveUnknown', {attemptId:current.attemptId, result, mailboxChecked:true}); $('detail').close(); await load(); }
  catch (e) { $('detail-message').textContent = e.message; }
  finally { $('found').disabled = $('not-found').disabled = false; }
}
async function signedIn(identity) {
  user = identity; $('login').hidden = true; $('workspace').hidden = false;
  const logout = node('button', 'ログアウト', 'secondary'); logout.addEventListener('click', async () => { try { await api('logout', {}); location.reload(); } catch (e) { message(e.message); } });
  $('account').replaceChildren(node('span', user.email), logout); await load();
}
async function init() {
  try {
    const config = await api('config');
    if (!config.ready) { $('setup').hidden = false; message('外部設定が未完了です。'); return; }
    if (config.user) { await signedIn(config.user); return; }
    $('login').hidden = false; message('Googleアカウントでログインしてください。');
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.google?.accounts?.id) {
        clearInterval(timer);
        google.accounts.id.initialize({client_id:config.clientId, nonce:config.nonce, auto_select:false, callback:async response => {
          try { await signedIn(await api('login', {credential:response.credential, nonce:config.nonce})); }
          catch (e) { message(e.message); }
        }});
        google.accounts.id.renderButton($('google-login'), {theme:'outline', size:'large', text:'signin_with'});
      } else if (Date.now() - started > 15000) { clearInterval(timer); message('Googleログインを読み込めません。接続を確認して再読込みしてください。'); }
    }, 100);
  } catch (e) { message(e.message); }
}
$('amount').addEventListener('input', clearPreview); $('confirm').addEventListener('change', refreshSend);
$('preview').addEventListener('click', preview); $('send').addEventListener('click', send);
$('reload').addEventListener('click', () => load().catch(e => message(e.message)));
$('found').addEventListener('click', () => resolve('sent')); $('not-found').addEventListener('click', () => resolve('notSent'));
$('test').addEventListener('click', async () => {
  if (sending) return;
  if (testAttempt?.status === 'unknown') {
    open({id:'test', name:'テスト申込者', email:'sunaid20220708@gmail.com', start:'2026/11/01 10:00', end:'2026/11/02 10:00', amount:100, status:'unknown', attemptId:testAttempt.attemptId, issues:[], raw:'テスト送信', history:[]});
    return;
  }
  test = true; current = null; clearPreview(); $('amount').value = 100; $('amount').disabled = true;
  $('application').replaceChildren(node('p', 'テスト宛先：sunaid20220708@gmail.com'), node('p', '架空の申込内容で動作を確認します。お振込みは不要です。'));
  $('preview').hidden = false; $('reconcile').hidden = true; $('raw').textContent = '架空のテストデータ'; $('history').replaceChildren();
  $('detail').showModal(); await preview();
});
$('detail').addEventListener('cancel', e => { if (sending) e.preventDefault(); });
$('detail').querySelector('form').addEventListener('submit', e => { if (sending) e.preventDefault(); });
init();
