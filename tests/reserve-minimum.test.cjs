const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'Asia/Tokyo';
const html = fs.readFileSync(path.join(__dirname, '../reserve.html'), 'utf8');
const pricing = html.slice(html.indexOf('const REGULAR_WEEKDAY_HOURLY'), html.indexOf('// 予約リクエストフォーム'));
const formatting = html.slice(html.indexOf('function formatHoursAsDaysAndHours'), html.indexOf('function buildReservationGuidanceMessage'));

function calculate(start, end) {
  const context = vm.createContext({
    startDate: new Date(start + '+09:00'),
    endDate: new Date(end + '+09:00'),
    resultEl: { innerHTML: '', children: [] },
    priceHeadlineEl: { innerHTML: '' },
    formatSelected: (date) => date.toISOString(),
    reservationSummaryText: null
  });
  vm.runInContext(pricing + '\n' + formatting + '\ncalcPrice();', context);
  const match = context.priceHeadlineEl.innerHTML.match(/reserve-result-price">([\d,]+)円/);
  return { total: match ? Number(match[1].replaceAll(',', '')) : null, context };
}

const cases = [
  ['平日開始・文化の日返却21時間', '2026-11-02T19:00:00', '2026-11-03T16:00:00', 22500],
  ['祝日開始・平日返却21時間', '2026-11-03T19:00:00', '2026-11-04T16:00:00', 22500],
  ['金曜から土曜21時間', '2026-11-06T19:00:00', '2026-11-07T16:00:00', 22500],
  ['日曜から月曜21時間', '2026-11-08T19:00:00', '2026-11-09T16:00:00', 22500],
  ['勤労感謝の日', '2026-11-23T10:00:00', '2026-11-23T16:00:00', 22500],
  ['平日のみ21時間', '2026-11-04T19:00:00', '2026-11-05T16:00:00', 18000],
  ['通常土曜からシーズン日曜', '2026-12-19T19:00:00', '2026-12-20T16:00:00', 45000],
  ['通常期からシーズン期の平日', '2027-03-14T19:00:00', '2027-03-15T16:00:00', 36000],
  ['春分振替休日', '2027-03-22T10:00:00', '2027-03-22T16:00:00', 45000],
  ['国民の休日', '2026-09-22T10:00:00', '2026-09-22T16:00:00', 45000],
  ['土曜0時返却は土曜を含まない', '2026-11-06T19:00:00', '2026-11-07T00:00:00', 18000],
  ['祝日0時返却は祝日を含まない', '2026-11-02T19:00:00', '2026-11-03T00:00:00', 18000],
  ['祝日の利用1時間を含む', '2026-11-02T19:00:00', '2026-11-03T01:00:00', 22500],
  ['23時間は最低料金適用', '2026-11-02T17:00:00', '2026-11-03T16:00:00', 22500],
  ['ちょうど24時間は既存計算を維持', '2026-11-02T10:00:00', '2026-11-03T10:00:00', 19800],
  ['25時間は既存計算を維持', '2026-11-02T10:00:00', '2026-11-03T11:00:00', 20800],
  ['平日48時間の既存計算', '2026-11-04T10:00:00', '2026-11-06T10:00:00', 36000],
  ['土日48時間の既存計算', '2026-11-07T00:00:00', '2026-11-09T00:00:00', 45000]
];

for (const [name, start, end, expected] of cases) {
  test(name, () => {
    const { total, context } = calculate(start, end);
    assert.equal(total, expected);
    assert.ok(context.reservationSummaryText.includes('概算料金：' + expected.toLocaleString('ja-JP') + '円'));
  });
}

test('最低料金の説明を実際の判定に合わせる', () => {
  const { context } = calculate('2026-11-02T19:00:00', '2026-11-03T16:00:00');
  assert.ok(context.resultEl.innerHTML.includes('利用時間内の最高単価で24時間料金を適用'));
  assert.ok(!context.resultEl.innerHTML.includes('利用開始日の24時間料金'));
});

test('全インラインスクリプトの構文', () => {
  for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    new vm.Script(source);
  }
});

test('2026〜2027年の全土日・祝休日に最低24時間料金を適用', () => {
  const context = vm.createContext({});
  vm.runInContext(pricing + '\nthis.isSpecial = isWeekendOrHoliday; this.rate = hourlyRateForDate;', context);
  let checked = 0;
  for (let date = new Date(2026, 0, 1); date.getFullYear() <= 2027; date.setDate(date.getDate() + 1)) {
    if (!context.isSpecial(date)) continue;
    const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    assert.equal(calculate(day + 'T10:00:00', day + 'T16:00:00').total, context.rate(date) * 24, day);
    checked++;
  }
  assert.ok(checked > 200);
});
