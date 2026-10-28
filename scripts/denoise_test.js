// 减噪变体：最小间隔 / 确认期，看能否去掉密集段的来回切
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'data', 'dataset.js'), 'utf8'), sandbox);
const E = require(path.join(root, 'engine.js'));
const D = sandbox.window.EQBD;

const dser = E.buildDaily(D.daily || []);
E.moveAvg(dser, 'erp', 20);
E.moveAvg(dser, 'ratio', 20);
E.moveAvg(dser, 'close', 60);
E.volZ(dser, 20);
const series = E.buildSeries(D.rows, E.monthlySmooth(dser));
const N = series.length;
const COST = 0.0005;
const P = series.map((r, i) => {
  const st = E.rollingStats(series, i, 120, 'erpS');
  return st.n >= 24 ? st.pct : null;
});

function target(p, r, lv, o) {
  if (lv === 0) return p >= o.buyPct ? 1 : 0;
  if (p <= o.flatPct) return 0;
  if (p <= o.halfPct || (p <= o.halfPct2 && ((r.ma60 != null && r.close < r.ma60) || (r.volZ != null && r.volZ > o.volZHot)))) return 0.5;
  return 1;
}

function run(o) {
  const w = new Array(N).fill(0);
  const sigs = [];
  let lv = 0, lastIdx = -99, pending = null, pendCnt = 0;
  for (let i = 0; i < N; i++) {
    const p = P[i], r = series[i];
    if (p == null) { w[i] = lv; continue; }
    let t = target(p, r, lv, o);
    // 确认期：目标档位连续 N 个月不变才执行
    if (o.confirm > 1) {
      if (t === lv) { pending = null; pendCnt = 0; }
      else if (pending === t) { pendCnt++; if (pendCnt < o.confirm - 1) t = lv; else { pending = null; pendCnt = 0; } }
      else { pending = t; pendCnt = 0; t = lv; }
    }
    // 最小间隔：距上次调仓不足 minGap 个月则不动（但清仓允许立即执行，风控优先）
    if (t !== lv && o.minGap && i - lastIdx < o.minGap && !(t === 0 && o.allowFastExit)) t = lv;
    if (t !== lv) {
      sigs.push({ i, m: r.m, from: lv, to: t, pct: p });
      lv = t; lastIdx = i;
    }
    w[i] = lv;
  }
  let a = 1, peak = 1, mdd = 0, prevW = 0, turn = 0;
  const rets = [];
  for (let i = 1; i < N; i++) {
    const r = series[i];
    if (r.retEq == null || r.retBd == null) continue;
    const raw = w[i - 1];
    const dw = Math.abs(raw - prevW);
    turn += dw; prevW = raw;
    const ret = raw * r.retEq + (1 - raw) * r.retBd - dw * COST;
    a *= 1 + ret; rets.push(ret);
    if (a > peak) peak = a;
    const dd = a / peak - 1; if (dd < mdd) mdd = dd;
  }
  const m = rets.length;
  const mu = rets.reduce((s, x) => s + x, 0) / m;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / m);
  return { ann: Math.pow(a, 12 / m) - 1, sharpe: (mu * 12) / (sd * Math.sqrt(12)), mdd, turn: turn / m * 12, sigs, w };
}

const BASE = { buyPct: 0.60, flatPct: 0.30, halfPct: 0.50, halfPct2: 0.65, volZHot: 1.5 };
const cases = [
  ['现状（无约束）', {}],
  ['最小间隔 3 个月', { minGap: 3 }],
  ['最小间隔 6 个月', { minGap: 6 }],
  ['最小间隔 3 月 + 清仓可立即', { minGap: 3, allowFastExit: true }],
  ['同向连续 2 月确认', { confirm: 2 }],
  ['同向连续 3 月确认', { confirm: 3 }],
  ['间隔3月 + 确认2月', { minGap: 3, confirm: 2 }],
];
console.log('%-28s %6s %8s %8s %8s %8s', '变体', '信号', '年化', '夏普', '回撤', '换手');
cases.forEach(([label, extra]) => {
  const r = run(Object.assign({}, BASE, extra));
  console.log('%-28s %6d %8s %8s %8s %8s', label, r.sigs.length,
    (r.ann * 100).toFixed(2) + '%', r.sharpe.toFixed(2),
    (r.mdd * 100).toFixed(1) + '%', r.turn.toFixed(2) + 'x');
});

// 看间隔 3 月的信号序列是否干净
const g3 = run(Object.assign({}, BASE, { minGap: 3 }));
console.log('\n[最小间隔 3 月] 信号序列：');
console.log('  ' + g3.sigs.map((s) => s.m + (s.to > s.from ? '↑' + s.to : '↓' + s.to)).join(' '));
const recent = g3.sigs.filter((s) => s.m >= '2024-01');
console.log('  2024 年后信号 %d 个（现状 %d 个）', recent.length,
  run(BASE).sigs.filter((s) => s.m >= '2024-01').length);

// 2025-08 之后的表现对比
const i0 = series.findIndex((r) => r.m === '2025-07');
function seg(w) {
  let a = 1;
  for (let i = i0 + 1; i < N; i++) {
    const r = series[i];
    if (r.retEq == null) continue;
    const ww = w[i - 1];
    a *= 1 + ww * r.retEq + (1 - ww) * r.retBd;
  }
  return (a - 1) * 100;
}
console.log('\n2025-08 ~ 2026-10 区间收益：满仓 %.1f%% ｜ 现状 %.1f%% ｜ 间隔3月 %.1f%% ｜ 确认2月 %.1f%%',
  seg(new Array(N).fill(1)), seg(run(BASE).w), seg(g3.w), seg(run(Object.assign({}, BASE, { confirm: 2 })).w));
