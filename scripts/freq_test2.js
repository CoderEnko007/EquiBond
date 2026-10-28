// 频率提升方案细化：找「信号数 8~14 个且质量不明显下降」的规则
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
const above = r => r.ma60 != null && r.close != null && r.close > r.ma60;
const below = r => r.ma60 != null && r.close != null && r.close < r.ma60;

function run(weights) {
  let a = 1, peak = 1, mdd = 0, prevW = 0, turn = 0;
  const rets = [];
  for (let i = 1; i < N; i++) {
    const w = weights[i - 1];
    const r = series[i];
    if (r.retEq == null || r.retBd == null || w == null) continue;
    const dw = Math.abs(w - prevW);
    turn += dw;
    prevW = w;
    const ret = w * r.retEq + (1 - w) * r.retBd - dw * COST;
    a *= 1 + ret; rets.push(ret);
    if (a > peak) peak = a;
    const dd = a / peak - 1; if (dd < mdd) mdd = dd;
  }
  const n = rets.length;
  const mu = rets.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / n);
  return { ann: Math.pow(a, 12 / n) - 1, sharpe: (mu * 12) / (sd * Math.sqrt(12)),
           mdd, turn: (turn / n) * 12 };
}

// 通用状态机：每期返回目标仓位（0/0.5/1）
function build(fn) {
  const w = new Array(N).fill(null);
  const sigs = [];
  let cur = 0;
  for (let i = 0; i < N; i++) {
    const p = P[i], r = series[i];
    if (p == null) { w[i] = cur; continue; }
    const next = fn(cur, p, r, i);
    if (next !== cur) sigs.push({ m: r.m, from: cur, to: next, pct: p, close: r.close });
    cur = next; w[i] = cur;
  }
  return { w, sigs };
}

const cases = [
  ['D1 50/50 且破60线', 1, (c, p, r) => (c === 0 ? (p >= 0.50 ? 1 : 0) : (p <= 0.50 && below(r) ? 0 : 1))],
  ['D2 50买 / 45卖+破线', 1, (c, p, r) => (c === 0 ? (p >= 0.50 ? 1 : 0) : (p <= 0.45 && below(r) ? 0 : 1))],
  ['D3 55买 / 45卖+破线', 1, (c, p, r) => (c === 0 ? (p >= 0.55 ? 1 : 0) : (p <= 0.45 && below(r) ? 0 : 1))],
  ['S1 三档 65买满/50减半/35+破线清', 2, (c, p, r) => {
    if (c === 0) return p >= 0.65 ? 1 : 0;
    if (c === 1) { if (p <= 0.35 && below(r)) return 0; if (p <= 0.50) return 0.5; return 1; }
    if (p >= 0.60) return 1; return 0.5;
  }],
  ['S2 三档 估值主 + 趋势减半', 2, (c, p, r) => {
    if (c === 0) return p >= 0.60 ? 1 : 0;
    if (p <= 0.30) return 0;
    if (p <= 0.50 || (p <= 0.65 && (below(r) || (r.volZ != null && r.volZ > 1.5)))) return 0.5;
    return 1;
  }],
  ['S3 四档渐进（80/60/40/20）', 4, (c, p, r) => {
    if (p >= 0.80) return 1; if (p >= 0.60) return 0.8;
    if (p >= 0.40) return 0.55; return 0.35;
  }],
  ['S4 五档渐进（85/70/50/30）', 5, (c, p, r) => {
    if (p >= 0.85) return 0.9; if (p >= 0.70) return 0.8;
    if (p >= 0.50) return 0.65; if (p >= 0.30) return 0.45; return 0.30;
  }],
  ['L1 双轨：主信号1/0 + 破线半仓', 2, (c, p, r) => {
    if (c === 0) return p >= 0.50 ? 0.5 : 0;
    if (p <= 0.35 && below(r)) return 0;
    if (p >= 0.70 && above(r)) return 1;
    return c;
  }],
];

console.log('区间 ' + series[0].m + ' ~ ' + series[N - 1].m + '，共 ' + N + ' 个月\n');
const out = [];
cases.forEach(([label, tiers, fn]) => {
  const { w, sigs } = build(fn);
  const perf = run(w);
  const buys = sigs.filter(s => s.to > s.from).length;
  const sells = sigs.length - buys;
  const gap = sigs.length > 1 ? ((N - 1) / (sigs.length - 1)).toFixed(1) : '-';
  out.push({ label, n: sigs.length, buys, sells, gap, perf, sigs });
  console.log(pad(label, 34) + pad(sigs.length + ' 个', 7) + pad('买' + buys + '卖' + sells, 9) +
    pad('间隔' + gap + '月', 11) + pad('年化' + (perf.ann * 100).toFixed(2) + '%', 12) +
    pad('夏普' + perf.sharpe.toFixed(2), 10) + pad('回撤' + (perf.mdd * 100).toFixed(1) + '%', 13) +
    '换手' + perf.turn.toFixed(1) + 'x');
});
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

// 基准
const hold = run(new Array(N).fill(1));
console.log('\n基准 满仓沪深300: 年化 ' + (hold.ann * 100).toFixed(2) + '%  夏普 ' + hold.sharpe.toFixed(2) +
  '  回撤 ' + (hold.mdd * 100).toFixed(1) + '%');
const cur = series[N - 1];
console.log('当前 ERP 分位 ' + (P[N - 1] * 100).toFixed(0) + '%  收盘 ' + cur.close +
  '  ma60 ' + Math.round(cur.ma60) + (cur.close < cur.ma60 ? '（在下方）' : '（在上方）') +
  '  volZ ' + (cur.volZ == null ? '-' : cur.volZ.toFixed(2)));

console.log('\n=== 各方案信号序列 ===');
out.forEach(o => {
  console.log('\n[' + o.label + ']');
  console.log('  ' + o.sigs.map(s => s.m + (s.to > s.from ? '↑' + s.to : '↓' + s.to)).join('  '));
});
