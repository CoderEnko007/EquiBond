/* 事件式双确认规则对照: node scripts/combo2_test.js
 * 只回答一个问题：把「趋势确认」加到信号触发条件上（而不是逐月调整仓位），
 * 能不能治好两个毛病 —— 卖出太早、买入太早。
 * 规则形态：状态机 long/flat，long=90% 股票，flat=20% 股票，其余拿债。 */
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
const MA = { 60: ma(dser, 'close', 60), 120: ma(dser, 'close', 120), 200: ma(dser, 'close', 200) };

const series = E.buildSeries(D.rows, E.monthlySmooth(dser));
const key = E.signalKey({ signal: 'erp', smooth: true });
const cfg = { window: 120 };

// 每月的月末快照索引
const dIdx = {};
dser.forEach((r, i) => { dIdx[r.m] = i; });

series.forEach((r, i) => {
  const st = E.rollingStats(series, i, cfg.window, key);
  r._pct = st.n >= 24 ? st.pct : null;
  const j = dIdx[r.m];
  r._close = j == null ? null : dser[j].close;
  Object.keys(MA).forEach((n) => {
    r['_ma' + n] = j == null ? null : MA[n][j];
  });
});

const LONGW = 0.9, FLATW = 0.2;

/* 通用状态机：buyFn / sellFn 返回 true 才切换 */
function runEvents(buyFn, sellFn, initLong) {
  const rets = [], weights = [], dates = [], turns = [];
  let state = initLong ? 'long' : 'flat';
  let prevW = null, nav = 1;
  const events = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1], r = series[i];
    if (prev._pct == null) { /* 预热期保持初始状态 */ }
    else if (state === 'flat' && buyFn(prev)) { state = 'long'; events.push({ m: r.m, d: prev.m, type: 'buy', close: prev._close, pct: prev._pct }); }
    else if (state === 'long' && sellFn(prev)) { state = 'flat'; events.push({ m: r.m, d: prev.m, type: 'sell', close: prev._close, pct: prev._pct }); }
    const w = state === 'long' ? LONGW : FLATW;
    if (r.retEq == null || r.retBd == null) continue;
    const cost = (prevW == null ? 0 : Math.abs(w - prevW)) * 5 / 10000;
    const ret = w * r.retEq + (1 - w) * r.retBd - cost;
    nav *= 1 + ret;
    rets.push(ret); weights.push(w); dates.push(r.m);
    turns.push(prevW == null ? 0 : Math.abs(w - prevW));
    prevW = w;
  }
  let rfSum = 0, rfCnt = 0;
  series.forEach((x) => { if (x.y10 != null) { rfSum += x.y10; rfCnt++; } });
  const m = E.perfMetrics(rets, rfSum / rfCnt / 100);
  return { m: m, events: events, nav: nav, avgW: E.mean(weights), turns: E.mean(turns) };
}

const up = (r, n) => r['_ma' + n] != null && r._close > r['_ma' + n];
const dn = (r, n) => r['_ma' + n] != null && r._close < r['_ma' + n];

const RULES = [
  {
    k: 'E0 纯估值事件',
    buy: (r) => r._pct >= 0.65,
    sell: (r) => r._pct <= 0.35,
  },
  {
    k: 'E1 估值 + 200日线确认',
    buy: (r) => r._pct >= 0.65 && up(r, 200),
    sell: (r) => r._pct <= 0.35 && dn(r, 200),
  },
  {
    k: 'E2 估值 + 60日线确认',
    buy: (r) => r._pct >= 0.65 && up(r, 60),
    sell: (r) => r._pct <= 0.35 && dn(r, 60),
  },
  {
    k: 'E3 估值 + 60日线，极端例外',
    buy: (r) => (r._pct >= 0.9) || (r._pct >= 0.65 && up(r, 60)),
    sell: (r) => (r._pct <= 0.1) || (r._pct <= 0.35 && dn(r, 60)),
  },
  {
    k: 'E4 估值阈值放宽 + 200日线',
    buy: (r) => r._pct >= 0.55 && up(r, 200),
    sell: (r) => r._pct <= 0.45 && dn(r, 200),
  },
];

const pctF = (x) => (x * 100).toFixed(2) + '%';
console.log('区间', series[1].m, '~', series[series.length - 1].m, '\n');
console.log('规则'.padEnd(28), '年化'.padStart(8), '波动'.padStart(8), '夏普'.padStart(6), '回撤'.padStart(8), '换手'.padStart(7), '信号'.padStart(6));
const results = RULES.map((R) => {
  const r = runEvents(R.buy, R.sell, R.k.startsWith('E0') ? false : false);
  console.log(R.k.padEnd(26), pctF(r.m.ann).padStart(9), pctF(r.m.vol).padStart(8),
    r.m.sharpe.toFixed(2).padStart(6), pctF(r.m.maxDD).padStart(9), pctF(r.turns).padStart(7),
    String(r.events.length).padStart(6));
  return { R: R, r: r };
});

results.forEach(({ R, r }) => {
  console.log('\n【' + R.k + '】事件序列');
  r.events.forEach((e) => {
    console.log('  ' + e.m + ' ' + (e.type === 'buy' ? '买入' : '卖出') +
      ' 收盘 ' + (e.close == null ? '—' : Math.round(e.close)) +
      ' 分位 ' + (e.pct * 100).toFixed(0) + '%');
  });
});
