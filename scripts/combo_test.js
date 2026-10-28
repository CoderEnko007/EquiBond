/* 组合信号对照: node scripts/combo_test.js
 * 目的：用本机已有数据检验「估值 + 趋势」组合能否改善纯 ERP 分位信号
 * 数据：沪深300 日线（算 MA200 / 6个月动量）、国债 10Y 日频（算利率 60 日变化）
 * 口径：月末评估、次月生效（signal(t-1)→weight(t)），单边 5bp 成本 */
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

// --- 日频附加指标 ---
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
const ma200 = ma(dser, 'close', 200);
const ma60 = ma(dser, 'close', 60);

function chg(ds, key, n) {
  // n 个交易日变化
  const out = new Array(ds.length).fill(null);
  for (let i = n; i < ds.length; i++) {
    const a = ds[i][key], b = ds[i - n][key];
    if (a != null && b != null) out[i] = a - b;
  }
  return out;
}
const y10Chg60 = chg(dser, 'y10', 60);

// 月末快照
const dmap = {};
for (let i = 0; i < dser.length; i++) {
  dmap[dser[i].m] = { i: i, close: dser[i].close, ma200: ma200[i], ma60: ma60[i], y10c: y10Chg60[i] };
}
const series = E.buildSeries(D.rows, E.monthlySmooth(dser));
series.forEach((r) => {
  const s = dmap[r.m] || {};
  r._close = s.close;
  r._ma200 = s.ma200;
  r._ma60 = s.ma60;
  r._y10c = s.y10c;
});

const cfg = { signal: 'erp', window: 120, map: 'pct', minW: 0.2, maxW: 0.9, smooth: true };
const key = E.signalKey(cfg);

// 预计算分位
series.forEach((r, i) => {
  const st = E.rollingStats(series, i, cfg.window, key);
  r._pct = st.n >= 24 ? st.pct : null;
  r._z = st.z;
});

function wBase(p) { return Math.min(1, Math.max(0, 0.2 + 0.7 * Math.min(1, Math.max(0, p)))); }

const RULES = {
  R0: { name: '纯 ERP 分位（现状）', w: (r) => wBase(r._pct) },
  R1: {
    name: '趋势闸门：破 200 日线降到 20%',
    w: (r) => (r._ma200 != null && r._close < r._ma200) ? 0.2 : wBase(r._pct),
  },
  R2: {
    name: '趋势闸门：破线减半（不低于20%）',
    w: (r) => Math.max(0.2, (r._ma200 != null && r._close < r._ma200) ? 0.5 * wBase(r._pct) : wBase(r._pct)),
  },
  R3: {
    name: '双确认：站上200日线才加到 65% 以上',
    w: (r) => {
      const up = r._ma200 != null && r._close > r._ma200;
      const w0 = wBase(r._pct);
      return up ? w0 : Math.min(w0, 0.45);
    },
  },
  R4: {
    name: '估值选方向、趋势定触发：跌破200日线才减，站上才加',
    w: (r) => {
      const up = r._ma200 != null && r._close > r._ma200;
      if (r._pct >= 0.65) return up ? 0.9 : 0.4;
      if (r._pct <= 0.35) return 0.2;
      return up ? 0.6 : 0.4;
    },
  },
  R5: {
    name: '利率趋势过滤：Y10 60日上行>15bp 时降仓',
    w: (r) => {
      const base = wBase(r._pct);
      return (r._y10c != null && r._y10c > 0.15) ? Math.max(0.2, base - 0.2) : base;
    },
  },
};

function run(rule) {
  const rets = [], weights = [], turns = [], dates = [];
  let w = null, prevW = null, nav = 1;
  for (let i = 1; i < series.length; i++) {
    const r = series[i];
    if (r.retEq == null || r.retBd == null) continue;
    const prev = series[i - 1];
    if (prev._pct == null) { w = 0.6; }
    else w = rule.w(prev);
    const cost = (prevW == null ? 0 : Math.abs(w - prevW)) * 5 / 10000;
    const ret = w * r.retEq + (1 - w) * r.retBd - cost;
    nav *= 1 + ret;
    rets.push(ret); weights.push(w); dates.push(r.m);
    turns.push(prevW == null ? 0 : Math.abs(w - prevW));
    prevW = w;
  }
  let rfSum = 0, rfCnt = 0;
  series.forEach((r) => { if (r.y10 != null) { rfSum += r.y10; rfCnt++; } });
  const rf = rfSum / rfCnt / 100;
  const m = E.perfMetrics(rets, rf);
  return { m: m, avgW: E.mean(weights), turns: E.mean(turns), dates: dates };
}

// 基准
function bench() {
  const eq = [], bd = [];
  for (let i = 1; i < series.length; i++) {
    const r = series[i];
    if (r.retEq == null || r.retBd == null) continue;
    eq.push(r.retEq); bd.push(r.retBd);
  }
  return { eq: E.perfMetrics(eq, 0), bd: E.perfMetrics(bd, 0) };
}
const bm = bench();
const pctF = (x) => (x * 100).toFixed(2) + '%';

console.log('回测区间:', series[1].m, '~', series[series.length - 1].m, '（' + (series.length - 1) + ' 个月）\n');
console.log('规则'.padEnd(42), '年化'.padStart(8), '波动'.padStart(8), '夏普'.padStart(6), '回撤'.padStart(8), '月换手'.padStart(7), '均仓位'.padStart(7));
Object.keys(RULES).forEach((k) => {
  const r = run(RULES[k]);
  console.log(RULES[k].name.padEnd(40),
    pctF(r.m.ann).padStart(9), pctF(r.m.vol).padStart(8), r.m.sharpe.toFixed(2).padStart(6),
    pctF(r.m.maxDD).padStart(9), pctF(r.turns).padStart(7), pctF(r.avgW).padStart(8));
});
console.log('沪深300 全仓'.padEnd(40), pctF(bm.eq.ann).padStart(9), pctF(bm.eq.vol).padStart(8),
  bm.eq.sharpe.toFixed(2).padStart(6), pctF(bm.eq.maxDD).padStart(9));
console.log('10年国债 全仓'.padEnd(40), pctF(bm.bd.ann).padStart(9), pctF(bm.bd.vol).padStart(8),
  bm.bd.sharpe.toFixed(2).padStart(6), pctF(bm.bd.maxDD).padStart(9));

// 关键时点：2014-12 之后不同规则何时减仓
console.log('\n关键时点仓位对照（%）');
const marks = ['2014-11', '2014-12', '2015-03', '2015-05', '2015-06', '2015-08', '2018-10', '2018-12', '2021-01', '2021-12', '2022-04', '2024-01', '2025-04'];
console.log('月份'.padEnd(9) + Object.keys(RULES).map((k) => k.padStart(7)).join('') + '   分位');
marks.forEach((m) => {
  const i = series.findIndex((r) => r.m === m);
  if (i < 0) return;
  const prev = series[i - 1];
  const p = prev && prev._pct != null ? prev._pct * 100 : NaN;
  console.log(m.padEnd(9) + Object.keys(RULES).map((k) => {
    const r = RULES[k];
    const w = (prev && prev._pct != null) ? r.w(prev) : null;
    return (w == null ? '—' : (w * 100).toFixed(0)).padStart(7);
  }).join('') + '   ' + (isFinite(p) ? p.toFixed(0) + '%' : '—'));
});
