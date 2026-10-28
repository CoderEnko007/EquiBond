/* 非对称双确认 + 估值综合分: node scripts/combo3_test.js
 * 思路：估值负责「方向」，趋势只负责「卖点确认」（因为估值底部往往在下跌途中，
 * 买入再等趋势转身会踏空）；另测 PE/PB/股息率三分位平均能否降噪。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.dirname(__dirname);
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'data', 'dataset.js'), 'utf8'), sandbox);
const E = require(path.join(root, 'engine.js'));

const D = sandbox.window.EQBD;
const dser = E.buildDaily(D.daily || []);
E.moveAvg(dser, 'erp', 20);

function ma(ds, key, n) {
  const out = new Array(ds.length).fill(null);
  let s = 0, c = 0;
  for (let i = 0; i < ds.length; i++) {
    const v = ds[i][key];
    if (v != null && isFinite(v)) { s += v; c++; }
    if (i >= n && ds[i - n][key] != null) { s -= ds[i - n][key]; c--; }
    if (c >= n) out[i] = s / c;
  }
  return out;
}
const MA60 = ma(dser, 'close', 60);
const MA200 = ma(dser, 'close', 200);

const series = E.buildSeries(D.rows, E.monthlySmooth(dser));
const key = E.signalKey({ signal: 'erp', smooth: true });
const dIdx = {};
dser.forEach((r, i) => { dIdx[r.m] = i; });

series.forEach((r, i) => {
  const st = E.rollingStats(series, i, 120, key);
  r._pct = st.n >= 24 ? st.pct : null;
  const j = dIdx[r.m];
  r._close = j == null ? null : dser[j].close;
  r._ma60 = j == null ? null : MA60[j];
  r._ma200 = j == null ? null : MA200[j];
});

/* 估值综合分：PE 分位、PB 分位、股息率分位（反向）三者平均
 * 用同一 120 个月窗口算各自分位，降低单一 PE 受盈利周期扰动的影响 */
series.forEach((r, i) => {
  const stPe = E.rollingStats(series, i, 120, 'pe');
  const stPb = E.rollingStats(series, i, 120, 'pb');
  const stDiv = E.rollingStats(series, i, 120, 'div');
  if (stPe.n < 24) { r._comp = null; return; }
  const pPe = 1 - stPe.pct;          // PE 越低越便宜 → 取反
  const pPb = 1 - stPb.pct;
  const pDiv = stDiv.pct;            // 股息率越高越便宜
  r._comp = (pPe + pPb + pDiv) / 3;
});

const LONGW = 0.9, FLATW = 0.2;

function runEvents(buyFn, sellFn) {
  const rets = [], weights = [], dates = [], turns = [], events = [];
  let state = 'flat', prevW = null;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1], r = series[i];
    if (prev._pct != null) {
      if (state === 'flat' && buyFn(prev)) { state = 'long'; events.push({ m: r.m, type: 'buy', close: prev._close, pct: prev._pct }); }
      else if (state === 'long' && sellFn(prev)) { state = 'flat'; events.push({ m: r.m, type: 'sell', close: prev._close, pct: prev._pct }); }
    }
    const w = state === 'long' ? LONGW : FLATW;
    if (r.retEq == null || r.retBd == null) continue;
    const cost = (prevW == null ? 0 : Math.abs(w - prevW)) * 5 / 10000;
    rets.push(w * r.retEq + (1 - w) * r.retBd - cost);
    weights.push(w); dates.push(r.m);
    turns.push(prevW == null ? 0 : Math.abs(w - prevW));
    prevW = w;
  }
  let rfSum = 0, rfCnt = 0;
  series.forEach((x) => { if (x.y10 != null) { rfSum += x.y10; rfCnt++; } });
  const m = E.perfMetrics(rets, rfSum / rfCnt / 100);
  return { m: m, events: events, turns: E.mean(turns), avgW: E.mean(weights) };
}

const up60 = (r) => r._ma60 != null && r._close > r._ma60;
const dn60 = (r) => r._ma60 != null && r._close < r._ma60;

const RULES = [
  { k: 'F0 纯估值（基线）', buy: (r) => r._pct >= 0.65, sell: (r) => r._pct <= 0.35 },
  { k: 'F1 买纯估值 / 卖加60日线', buy: (r) => r._pct >= 0.65, sell: (r) => r._pct <= 0.35 && dn60(r) },
  { k: 'F2 买纯估值 / 卖只破60日线', buy: (r) => r._pct >= 0.65, sell: (r) => dn60(r) },
  { k: 'F3 买卖都加60日线（E2）', buy: (r) => r._pct >= 0.65 && up60(r), sell: (r) => r._pct <= 0.35 && dn60(r) },
  { k: 'G0 综合分（PE/PB/股息）', buy: (r) => r._comp >= 0.65, sell: (r) => r._comp <= 0.35 },
  { k: 'G1 综合分 / 卖加60日线', buy: (r) => r._comp >= 0.65, sell: (r) => r._comp <= 0.35 && dn60(r) },
  { k: 'G2 综合分极端档', buy: (r) => r._comp >= 0.75, sell: (r) => r._comp <= 0.25 },
];

const pctF = (x) => (x * 100).toFixed(2) + '%';
console.log('区间', series[1].m, '~', series[series.length - 1].m, '\n');
console.log('规则'.padEnd(26), '年化'.padStart(8), '波动'.padStart(8), '夏普'.padStart(6), '回撤'.padStart(9), '均仓'.padStart(7), '信号'.padStart(5));
const res = RULES.map((R) => {
  const r = runEvents(R.buy, R.sell);
  console.log(R.k.padEnd(24), pctF(r.m.ann).padStart(9), pctF(r.m.vol).padStart(8),
    r.m.sharpe.toFixed(2).padStart(6), pctF(r.m.maxDD).padStart(10), pctF(r.avgW).padStart(8),
    String(r.events.length).padStart(5));
  return { R: R, r: r };
});

console.log('\n事件序列（重点看 2015 顶部与 2022 底部怎么处理）');
res.forEach(({ R, r }) => {
  console.log('\n【' + R.k + '】');
  r.events.forEach((e) => {
    console.log('  ' + e.m + ' ' + (e.type === 'buy' ? '买入' : '卖出') +
      '  收盘 ' + (e.close == null ? '—' : Math.round(e.close)) +
      '  分位 ' + (e.pct * 100).toFixed(0) + '%');
  });
});

// 当前读数
const cur = series[series.length - 1];
console.log('\n当前（' + cur.m + '）: ERP 分位 ' + (cur._pct * 100).toFixed(1) + '%',
  '| 综合分 ' + (cur._comp == null ? '—' : (cur._comp * 100).toFixed(1) + '%'),
  '| 收盘 ' + Math.round(cur._close), '| MA60 ' + Math.round(cur._ma60), '| MA200 ' + Math.round(cur._ma200));
