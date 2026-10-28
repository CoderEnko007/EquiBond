// 稳健性自检：三档规则到底有多少信息量？
// A. 参数敏感性（挪 5pct 会不会崩）
// B. 蒙地卡罗：打乱分位序列的时间顺序，看真实成绩在随机分布中的位置
// C. 密集段解剖：2025-2026 那段来回切到底赚不赚
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

// 用给定的分位序列跑规则，返回 {ann, sharpe, mdd, turn, n, sigs}
function runRule(PX, o) {
  const buyPct = o.buyPct, flatPct = o.flatPct, halfPct = o.halfPct, halfPct2 = o.halfPct2, volZHot = o.volZHot;
  const w = new Array(N).fill(0);
  let lv = 0, n = 0;
  for (let i = 0; i < N; i++) {
    const p = PX[i], r = series[i];
    if (p == null) { w[i] = lv; continue; }
    const weak = r.ma60 != null && r.close != null && r.close < r.ma60;
    const hot = r.volZ != null && r.volZ > volZHot;
    let next;
    if (lv === 0) next = p >= buyPct ? 1 : 0;
    else if (p <= flatPct) next = 0;
    else if (p <= halfPct || (p <= halfPct2 && (weak || hot))) next = 0.5;
    else next = 1;
    if (next !== lv) n++;
    lv = next; w[i] = lv;
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
  return {
    ann: Math.pow(a, 12 / m) - 1, sharpe: (mu * 12) / (sd * Math.sqrt(12)),
    mdd, turn: (turn / m) * 12, n, w,
  };
}

const BASE = { buyPct: 0.60, flatPct: 0.30, halfPct: 0.50, halfPct2: 0.65, volZHot: 1.5 };
const base = runRule(P, BASE);

console.log('=== 基准 ===');
console.log('信号 %d 个  年化 %s  夏普 %s  回撤 %s',
  base.n, (base.ann * 100).toFixed(2) + '%', base.sharpe.toFixed(2), (base.mdd * 100).toFixed(1) + '%');

// ---------- A. 参数敏感性 ----------
console.log('\n=== A. 参数敏感性（单因素 ±5pct / ±10pct）===');
const grid = [
  ['buyPct', [0.50, 0.55, 0.60, 0.65, 0.70]],
  ['flatPct', [0.20, 0.25, 0.30, 0.35, 0.40]],
  ['halfPct', [0.40, 0.45, 0.50, 0.55, 0.60]],
  ['halfPct2', [0.55, 0.60, 0.65, 0.70, 0.75]],
  ['volZHot', [0.5, 1.0, 1.5, 2.0, 9.9]],
];
const anns = [];
grid.forEach(([k, vals]) => {
  const line = vals.map((v) => {
    const o = Object.assign({}, BASE); o[k] = v;
    const r = runRule(P, o);
    anns.push(r.ann);
    return v + '→' + (r.ann * 100).toFixed(2) + '%/' + r.sharpe.toFixed(2) + '/' + r.n + '个';
  });
  console.log('  ' + k.padEnd(9) + line.join('  '));
});
console.log('  年化区间 %s ~ %s（%d 组参数全部为正: %s）',
  (Math.min(...anns) * 100).toFixed(2) + '%', (Math.max(...anns) * 100).toFixed(2) + '%',
  anns.length, anns.every((x) => x > 0));

// ---------- B. 蒙地卡罗：分位序列块状打乱 ----------
console.log('\n=== B. 蒙地卡罗（块状打乱分位序列，2000 次）===');
function blockShuffle(arr, block) {
  // 保留块内顺序，打乱块顺序 —— 破坏"时间位置"信息但保留局部自相关
  const out = [];
  const blocks = [];
  for (let i = 0; i < arr.length; i += block) blocks.push(arr.slice(i, i + block));
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = blocks[i]; blocks[i] = blocks[j]; blocks[j] = t;
  }
  blocks.forEach((b) => out.push.apply(out, b));
  return out.slice(0, arr.length);
}
const sims = [];
for (let s = 0; s < 2000; s++) {
  const Pp = blockShuffle(P, 6);   // 半年块，保留局部趋势感
  const r = runRule(Pp, BASE);
  sims.push({ ann: r.ann, sharpe: r.sharpe, n: r.n });
}
sims.sort((a, b) => a.ann - b.ann);
const pctRank = sims.filter((x) => x.ann < base.ann).length / sims.length;
const q = (p) => sims[Math.floor(p * (sims.length - 1))];
console.log('  随机信号年化：中位 %s ｜ 10%% %s ｜ 90%% %s ｜ 最好 %s',
  (q(0.5).ann * 100).toFixed(2) + '%', (q(0.1).ann * 100).toFixed(2) + '%',
  (q(0.9).ann * 100).toFixed(2) + '%', (q(1).ann * 100).toFixed(2) + '%');
console.log('  随机信号夏普中位 %s ｜ 真实规则 %s', q(0.5).sharpe.toFixed(2), base.sharpe.toFixed(2));
console.log('  真实年化在随机分布中排在第 %s 百分位',
  (pctRank * 100).toFixed(1) + '%');
const beat = sims.filter((x) => x.ann >= base.ann).length;
console.log('  2000 次随机里，有 %d 次（%s）跑赢真实规则',
  beat, (beat / sims.length * 100).toFixed(1) + '%');

// ---------- C. 密集段解剖 ----------
console.log('\n=== C. 最近密集段解剖（2025-08 起）===');
const sigs = E.tierSignals(series, { signal: 'erp', window: 120, map: 'pct', smooth: true });
const t0 = '2025-07';
let lv = null, enterIdx = null, enterLv = 0, cum = 1, costSum = 0;
sigs.filter((s) => s.m >= t0).forEach((s) => {
  if (lv == null) lv = 1; // 假设之前满仓
  const dw = Math.abs(s.level - lv);
  costSum += dw * COST;
  const months = enterIdx == null ? 0 : s.i - enterIdx;
  console.log('  %s %s 仓位 %s→%s 分位 %s%s  %s个月',
    s.m, { buy: '买入', add: '加满', reduce: '减半', sell: '清仓' }[s.type],
    (lv * 100) + '%', (s.level * 100) + '%', (s.pct * 100).toFixed(0) + '%',
    s.volZ == null ? '' : ' σ' + s.volZ.toFixed(1),
    months ? String(months) : '—');
  lv = s.level; enterIdx = s.i;
});
console.log('  该段累计换手（双边） %s，成本约 %s（单边5bp）',
  costSum.toFixed(2) + 'x', (costSum * 100).toFixed(2) + '%');

// 同段：满仓 vs 规则
function segRet(from, to, weights) {
  let a = 1;
  for (let i = from + 1; i <= to; i++) {
    const r = series[i];
    if (r.retEq == null) continue;
    const w = weights ? weights[i - 1] : 1;
    a *= 1 + w * r.retEq + (1 - w) * r.retBd;
  }
  return a - 1;
}
const idxFrom = series.findIndex((r) => r.m === '2025-07');
const idxTo = N - 1;
console.log('  2025-08 ~ 2026-10 区间：满仓沪深300 %s ｜ 规则 %s ｜ 纯债 %s',
  (segRet(idxFrom, idxTo, null) * 100).toFixed(1) + '%',
  (segRet(idxFrom, idxTo, base.w) * 100).toFixed(1) + '%',
  (segRet(idxFrom, idxTo, new Array(N).fill(0)) * 100).toFixed(1) + '%');
