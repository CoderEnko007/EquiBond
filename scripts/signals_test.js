/* 买卖信号探针: node scripts/signals_test.js
 * 目的：确定滞回阈值（lo / hi）下的信号频次与事后表现，避免图上标一堆噪音点 */
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
E.moveAvg(dser, 'ratio', 20);
const series = E.buildSeries(D.rows, E.monthlySmooth(dser));

const cfg = { signal: 'erp', window: 120, map: 'pct', minW: 0.2, maxW: 0.9, smooth: true, rebalance: 1, costBp: 5, startIdx: 0 };

function pctOf(i, key) {
  const st = E.rollingStats(series, i, cfg.window, key);
  return st.pct;
}

/* 滞回状态机：分位 >= hi 买入，<= lo 卖出 */
function events(lo, hi) {
  const key = E.signalKey(cfg);
  const out = [];
  let state = null;
  for (let i = 0; i < series.length; i++) {
    const v = series[i][key];
    if (v == null || !isFinite(v)) continue;
    const st = E.rollingStats(series, i, cfg.window, key);
    if (st.n < 24) continue;
    if (state === null) { state = st.pct >= 0.5 ? 'long' : 'flat'; continue; }
    if (state !== 'long' && st.pct >= hi) { out.push({ i: i, type: 'buy', pct: st.pct }); state = 'long'; }
    else if (state !== 'flat' && st.pct <= lo) { out.push({ i: i, type: 'sell', pct: st.pct }); state = 'flat'; }
  }
  return out;
}

function fwd(i, h) {
  let a = 1;
  for (let k = 1; k <= h; k++) {
    const r = series[i + k];
    if (!r || r.retEq == null) return null;
    a *= 1 + r.retEq;
  }
  return a - 1;
}

function hold(evs, h) {
  // 配对持有一段：买入 -> 下一个卖出（或末尾）
  const buys = [], sells = [];
  let open = null;
  evs.forEach((e) => {
    if (e.type === 'buy' && open == null) open = e;
    else if (e.type === 'sell' && open != null) { buys.push(open); sells.push(e); open = null; }
  });
  if (open != null) buys.push(open);
  const holds = buys.map((b, k) => {
    const end = sells[k] ? sells[k].i : series.length - 1;
    let a = 1;
    for (let j = b.i + 1; j <= end; j++) { if (series[j].retEq != null) a *= 1 + series[j].retEq; }
    return { m: series[b.i].m, months: end - b.i, ret: a - 1, pct: b.pct };
  });
  const hs = holds.map((x) => x.months);
  const rs = holds.map((x) => x.ret);
  return {
    n: holds.length,
    avgMonths: E.mean(hs),
    avgRet: E.mean(rs),
    winRate: rs.filter((x) => x > 0).length / (rs.length || 1),
    holds: holds,
  };
}

const pctF = (x) => (x * 100).toFixed(1) + '%';
const sets = [[0.30, 0.70], [0.25, 0.75], [0.20, 0.80], [0.15, 0.85], [0.35, 0.65]];

console.log('月份数', series.length, series[0].m, '~', series[series.length - 1].m);
console.log('\n阈值(low/high) | 信号数 | 买入数 | 持有段数 | 段均月数 | 段均收益 | 胜率 | 买入后12M均值 | 卖出后12M均值');
sets.forEach(([lo, hi]) => {
  const evs = events(lo, hi);
  const buys = evs.filter((e) => e.type === 'buy');
  const sells = evs.filter((e) => e.type === 'sell');
  const h = hold(evs, 12);
  const fb = buys.map((e) => fwd(e.i, 12)).filter((x) => x != null);
  const fs2 = sells.map((e) => fwd(e.i, 12)).filter((x) => x != null);
  console.log(
    (lo + '/' + hi).padEnd(14),
    String(evs.length).padStart(6),
    String(buys.length).padStart(6),
    String(h.n).padStart(8),
    String(h.avgMonths.toFixed(1)).padStart(9),
    String(pctF(h.avgRet)).padStart(8),
    String(pctF(h.winRate)).padStart(6),
    String(fb.length ? pctF(E.mean(fb)) : '—').padStart(13),
    String(fs2.length ? pctF(E.mean(fs2)) : '—').padStart(13)
  );
});

console.log('\n=== 0.25/0.75 明细 ===');
const evs = events(0.25, 0.75);
evs.forEach((e) => {
  const s = series[e.i];
  const f12 = fwd(e.i, 12);
  console.log(
    s.m, e.type === 'buy' ? '买入' : '卖出',
    '收盘', s.close.toFixed(0),
    'ERP', s.erp.toFixed(2), 'ERP20', s.erpS == null ? '—' : s.erpS.toFixed(2),
    '分位', pctF(e.pct),
    '后12M', f12 == null ? '—' : pctF(f12)
  );
});
