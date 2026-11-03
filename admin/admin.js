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
  INVALID_INQUIRY_RANGE:'開始日・終了日を確認してください。登録できるのは今日から190日以内です。',
  INQUIRY_RANGE_CONFLICT:'登録済みの要問い合わせ期間と重なっています。既存期間を解除してから登録してください。',
  INQUIRY_NOT_FOUND:'対象の要問い合わせ期間が見つかりません。再読込みしてください。',
  INQUIRY_ACTION_RESULT_UNKNOWN:'操作結果が不明です。再読込みして期間が登録済みか確認してください。',
  BUSY:'別の処理が進行中です。少し待って一覧を再読込みしてください。', WAIT_FOR_SEND_COMPLETION:'処理開始から5分以上待ってください。',
  MAILBOX_CHECK_REQUIRED:'送信済みフォルダを確認してチェックを入れてください。', SENDER_NOT_CONFIGURED:'info@から送信できるGoogle設定が未完了です。',
  BACKEND_UNAVAILABLE:'送信処理に接続できません。外部設定・接続状況を確認してください。', BACKEND_ERROR:'処理を完了できませんでした。送信操作中なら再送せず、一覧の状態を確認してください。'
};
errors.CALENDAR_CONFIG_REQUIRED = 'Googleカレンダー「予約」のIDが未設定です。設定手順書を確認してください。';
errors.CALENDAR_ACCESS_REQUIRED = 'Apps Script実行アカウントに、Googleカレンダー「予約」の編集権限がありません。';
errors.RESERVATION_CONFLICT = 'その日時はGoogleカレンダーですでに埋まっています。入金を返金または調整し、申込者へ連絡してください。';
errors.PAYMENT_CONFIRMATION_REQUIRED = '入金確認のチェックを入れてから実行してください。';
errors.ACTION_RESULT_UNKNOWN = '処理結果を確認できませんでした。一覧を再読込みしてください。未確定ならもう一度実行できます。同じ申込みの予定は重複登録されません。';
errors.APPLICATION_CHANGED = '申込内容が変更されました。一覧を再読込みして内容を確認してください。';
errors.EARLIER_APPLICATION_PENDING = '同じ時間帯に先行する商談があります。先行案件を確定または終了してから再確認してください。';
errors.APPLICATION_CLOSED = 'この商談は終了しています。送信・予約確定はできません。';
errors.CONDITIONS_NOT_ACCEPTED = '貸出条件について、お客様の了承を確認してください。';
errors.CONDITIONS_REVIEW_REQUIRED = '△要問い合わせの期間を含みます。条件付きとして貸出条件とお客様の了承を確認してください。';
errors.QUOTE_VERIFICATION_REQUIRED = '貸出区分と請求金額を確認し、確認内容を保存してください。';
errors.INVALID_REVIEW = '通常条件では条件欄を空にし、条件付きでは貸出条件を入力してください。';
errors.FINAL_REVIEW_REQUIRED = '確認内容を保存し、カレンダーとの重複をもう一度確認してください。';
errors.ALREADY_CONFIRMED = '予約確定済みです。商談終了・振込案内は行えません。';
let user = null, items = [], current = null, pending = null, test = false, customerEnabled = false, sending = false, testAttempt = null;
let reservationReview = null, reviewDirty = false;
async function api(action, data) {
  const options = {credentials:'same-origin', cache:'no-store', headers:{}};
  if (data !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.headers['X-Admin-Csrf'] = user?.csrf || ''; options.body = JSON.stringify(data); }
  let response, result;
  try { response = await fetch('/api/admin?action=' + action, options); result = await response.json(); }
  catch { throw new Error(['send','sendTest'].includes(action) ? errors.SEND_RESULT_UNKNOWN : action === 'confirmReservation' ? errors.ACTION_RESULT_UNKNOWN : errors.BACKEND_UNAVAILABLE); }
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
  renderInquiryRanges(result.inquiries || []);
  for (const item of items) {
    const tr = node('tr');
    const identity = node('td', item.name); identity.append(node('small', item.submittedAt), node('small', item.email || 'メールアドレスなし'));
    const dates = node('td', item.start || '開始日時なし'); dates.append(node('small', '→ ' + (item.end || '返却日時なし')));
    if (item.requiresInquiry) dates.append(node('small', '△ 要問い合わせ期間を含む'));
    const status = node('td'); status.append(node('span', labels[item.status] || item.status, 'status ' + item.status));
    status.append(node('small', item.reservationStatus === 'confirmed' ? '予約確定済み' : item.workflow.closed ? '商談終了' : '□ 商談中・最終承認前'));
    if (item.reservationConfirmedAt) status.append(node('small', new Date(item.reservationConfirmedAt).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' JST'));
    if (item.sentAt) status.append(node('small', new Date(item.sentAt).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' JST'));
    if (item.issues.length) status.append(node('small', item.issues.join('／'), 'issues'));
    const operation = node('td'), button = node('button', '確認'); button.className = 'secondary'; button.addEventListener('click', () => open(item)); operation.append(button);
    tr.append(identity, dates, node('td', yen(item.amount)), status, operation); $('rows').append(tr);
  }
  message('申込み ' + items.length + '件。利用日時は日本時間です。自動案内：' + (result.autoGuidanceEnabled && customerEnabled ? '有効（条件・請求額の確認済み案件のみ）' : '停止中'));
}
function dateLabel(value) { return new Date(value + 'T00:00:00+09:00').toLocaleDateString('ja-JP', {timeZone:'Asia/Tokyo', year:'numeric', month:'numeric', day:'numeric'}); }
function renderInquiryRanges(ranges) {
  const list = $('inquiry-list'); list.replaceChildren();
  if (!ranges.length) { list.append(node('li', '登録中の期間はありません。')); return; }
  for (const range of ranges) {
    const row = node('li');
    const lastDay = new Date(Date.parse(range.end + 'T00:00:00+09:00') - 86400000)
      .toLocaleDateString('ja-JP', {timeZone:'Asia/Tokyo', year:'numeric', month:'numeric', day:'numeric'});
    row.append(node('span', dateLabel(range.start) + ' 〜 ' + lastDay));
    const button = node('button', '解除', 'secondary'); button.addEventListener('click', () => removeInquiry(range.id)); row.append(button); list.append(row);
  }
}
async function addInquiry() {
  const start = $('inquiry-start').value, end = $('inquiry-end').value;
  if (!start || !end || end < start) { message('要問い合わせ期間の開始日と終了日を確認してください。'); return; }
  $('inquiry-add').disabled = true;
  try { await api('setInquiry', {start, end}); $('inquiry-start').value = ''; $('inquiry-end').value = ''; await load(); message('要問い合わせ期間を登録しました。公開カレンダーの再読み込み後に反映されます。'); }
  catch (e) { message(errors[e.message] || e.message); }
  finally { $('inquiry-add').disabled = false; }
}
async function removeInquiry(id) {
  if (!id) return;
  try { await api('removeInquiry', {id}); await load(); message('要問い合わせ期間を解除しました。公開カレンダーの再読み込み後に反映されます。'); }
  catch (e) { message(errors[e.message] || e.message); }
}
function open(item) {
  if (sending) return;
  test = item.id === 'test'; current = item; clearPreview(); $('detail-message').textContent = '';
  reservationReview = null; reviewDirty = false; $('reservation-review').replaceChildren();
  const workflow = item.workflow || {};
  const applicationDetails = [node('p', item.name + ' 様 ／ ' + (item.email || 'メールアドレスなし')), node('p', (item.start || '日時なし') + ' → ' + (item.end || '日時なし'))];
  if (item.requiresInquiry) applicationDetails.push(node('p', '△ 要問い合わせ期間を含みます。貸出可否を確認してから振込案内を送ってください。', 'issues'));
  $('application').replaceChildren(...applicationDetails);
  $('amount').value = workflow.approvedAmount || item.lastAmount || item.amount || ''; $('amount').disabled = false;
  $('review-controls').hidden = test;
  $('eligibility').value = workflow.eligibility === 'conditional' ? 'conditional' : 'standard';
  $('conditions').value = workflow.conditions || '';
  $('conditions-accepted').checked = workflow.conditionsAccepted === true;
  $('amount-verified').checked = workflow.amountVerified === true;
  $('save-review').disabled = $('close-application').disabled = Boolean(workflow.closed) || item.reservationStatus === 'confirmed';
  $('check-reservation').disabled = Boolean(workflow.closed) || item.reservationStatus === 'confirmed';
  $('reservation-confirmation').hidden = test;
  $('reservation-status').textContent = item.reservationStatus === 'confirmed' ? '予約確定済みです。再登録は行いません。' : workflow.closed ? '商談終了' : '□ 商談中・最終承認前';
  $('payment-confirm').checked = false;
  $('payment-confirm').disabled = item.reservationStatus === 'confirmed' || item.issues.length > 0;
  $('confirm-reservation').disabled = true;
  $('confirm-reservation').textContent = item.reservationStatus === 'confirmed' ? '予約確定済み' : '最終承認して予約確定';
  $('preview').hidden = item.status === 'sent' || item.status === 'unknown'; $('preview').disabled = item.issues.length > 0;
  $('reconcile').hidden = item.status !== 'unknown'; $('mailbox').checked = false;
  $('raw').textContent = item.raw; $('history').replaceChildren();
  for (const h of item.history) $('history').append(node('p', [labels[h.status], h.email, yen(h.amount), '確認：' + h.preparedAt, h.sentAt && '送信：' + h.sentAt, h.resolvedAt && '手動確認：' + h.resolvedAt, h.detail].filter(Boolean).join(' ／ ')));
  if (item.issues.length) $('detail-message').textContent = item.issues.join('／');
  $('detail').showModal();
}
async function preview() {
  if (!test && reviewDirty) { $('detail-message').textContent = '変更した条件・金額を先に保存してください。'; return; }
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
async function confirmReservation() {
  if (sending || !current || !reservationReview?.ready || reviewDirty || current.reservationStatus === 'confirmed' || !$('payment-confirm').checked) return;
  sending = true; $('confirm-reservation').disabled = true; $('payment-confirm').disabled = true;
  $('detail-message').textContent = 'カレンダーへ登録しています。結果を待ってください。';
  try {
    await api('confirmReservation', {applicationId:current.id, fingerprint:current.fingerprint, reviewToken:reservationReview.reviewToken, confirmed:true, paymentChecked:true});
    $('reservation-status').textContent = '予約確定済みです。Googleカレンダーへ登録しました。HPは再読み込み後に反映されます。';
    $('confirm-reservation').textContent = '予約確定済み';
    $('detail-message').textContent = '予約確定しました。';
    current.reservationStatus = 'confirmed';
    await load();
  } catch (e) {
    $('detail-message').textContent = e.message;
    reservationReview = null; $('payment-confirm').checked = false;
    $('payment-confirm').disabled = false;
  } finally {
    sending = false;
    refreshReservationConfirm();
  }
}
function refreshReservationConfirm() {
  $('confirm-reservation').disabled = sending || reviewDirty || !reservationReview?.ready || !$('payment-confirm').checked || current?.reservationStatus === 'confirmed';
}
function invalidateReview() {
  reviewDirty = true; reservationReview = null; clearPreview(); $('payment-confirm').checked = false;
  $('reservation-review').replaceChildren(node('p', '変更した条件・請求額を保存してください。'));
  refreshReservationConfirm();
}
async function saveReview() {
  if (sending || !current) return;
  sending = true; refreshSend(); refreshReservationConfirm(); clearPreview();
  try {
    current.workflow = await api('saveReview', {applicationId:current.id, fingerprint:current.fingerprint,
      eligibility:$('eligibility').value, conditions:$('conditions').value,
      conditionsAccepted:$('conditions-accepted').checked, approvedAmount:Number($('amount').value), amountVerified:$('amount-verified').checked});
    reviewDirty = false; reservationReview = null;
    $('detail-message').textContent = '貸出条件・請求額を保存しました。自動案内が有効なら、次の処理時に対象になります。';
    await load();
  } catch (e) { $('detail-message').textContent = e.message; }
  finally { sending = false; refreshSend(); refreshReservationConfirm(); }
}
async function checkReservation() {
  if (sending || !current) return;
  if (reviewDirty) { $('detail-message').textContent = '変更内容を先に保存してください。'; return; }
  sending = true; reservationReview = null; $('payment-confirm').checked = false; refreshSend(); refreshReservationConfirm();
  try {
    reservationReview = await api('checkReservation', {applicationId:current.id, fingerprint:current.fingerprint});
    const review = reservationReview;
    const lines = [node('p', '確認時刻：' + new Date(review.checkedAt).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' JST'),
      node('p', '請求確認額：' + yen(review.workflow.approvedAmount)),
      node('p', '確定予約・貸出不可予定との重複：' + (review.bookingConflicts.length ? 'あり' : 'なし')),
      node('p', '重なる先行商談：' + review.earlierApplications.length + '件'),
      node('p', '貸出条件：' + (review.workflow.conditions || '通常条件') + ' ／ 了承確認：' + (review.workflow.conditionsAccepted ? '済' : '未確認'))];
    for (const range of review.bookingConflicts) lines.push(node('p', new Date(range.start).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' 〜 ' + new Date(range.end).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}), 'issues'));
    lines.push(node('p', review.ready ? '入金を確認し、最終承認できます。承認時にも重複を再確認します。' : '貸出条件・請求額・先行商談を確認してください。予約確定は停止しています。'));
    $('reservation-review').replaceChildren(...lines);
  } catch (e) { $('detail-message').textContent = e.message; }
  finally { sending = false; refreshSend(); refreshReservationConfirm(); }
}
async function closeApplication() {
  if (sending || !current) return;
  sending = true; clearPreview(); reservationReview = null; refreshReservationConfirm();
  try {
    await api('closeApplication', {applicationId:current.id, fingerprint:current.fingerprint});
    $('detail').close(); await load(); message('商談を終了しました。公開カレンダーの再読み込み後に□が解除されます。');
  } catch (e) { $('detail-message').textContent = e.message; }
  finally { sending = false; refreshSend(); refreshReservationConfirm(); }
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
$('amount').addEventListener('input', () => { $('amount-verified').checked = false; invalidateReview(); }); $('confirm').addEventListener('change', refreshSend);
$('eligibility').addEventListener('change', invalidateReview);
$('conditions').addEventListener('input', () => { $('conditions-accepted').checked = false; invalidateReview(); });
$('conditions-accepted').addEventListener('change', invalidateReview);
$('amount-verified').addEventListener('change', invalidateReview);
$('save-review').addEventListener('click', saveReview);
$('close-application').addEventListener('click', closeApplication);
$('check-reservation').addEventListener('click', checkReservation);
$('preview').addEventListener('click', preview); $('send').addEventListener('click', send);
$('reload').addEventListener('click', () => load().catch(e => message(e.message)));
$('inquiry-add').addEventListener('click', addInquiry);
$('found').addEventListener('click', () => resolve('sent')); $('not-found').addEventListener('click', () => resolve('notSent'));
$('payment-confirm').addEventListener('change', refreshReservationConfirm);
$('confirm-reservation').addEventListener('click', confirmReservation);
$('test').addEventListener('click', async () => {
  if (sending) return;
  if (testAttempt?.status === 'unknown') {
    open({id:'test', name:'テスト申込者', email:'sunaid20220708@gmail.com', start:'2026/11/01 10:00', end:'2026/11/02 10:00', amount:100, status:'unknown', attemptId:testAttempt.attemptId, issues:[], raw:'テスト送信', history:[]});
    return;
  }
  test = true; current = null; clearPreview(); $('amount').value = 100; $('amount').disabled = true;
  $('review-controls').hidden = true; $('reservation-confirmation').hidden = true;
  $('application').replaceChildren(node('p', 'テスト宛先：sunaid20220708@gmail.com'), node('p', '架空の申込内容で動作を確認します。お振込みは不要です。'));
  $('preview').hidden = false; $('reconcile').hidden = true; $('raw').textContent = '架空のテストデータ'; $('history').replaceChildren();
  $('detail').showModal(); await preview();
});
$('detail').addEventListener('cancel', e => { if (sending) e.preventDefault(); });
$('detail').querySelector('form').addEventListener('submit', e => { if (sending) e.preventDefault(); });
init();
