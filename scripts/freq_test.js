// 信号频率对照：在「估值买 + 60日线确认卖」基础上，测多套提高信号密度的规则
// 口径：月末评估（用 t-1 月末信息）→ 次月生效，单边成本 5bp
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
E.moveAvg(dser, 'close', 200);
E.volZ(dser, 20);
const series = E.buildSeries(D.rows, E.monthlySmooth(dser));

// 补齐 ma200（月度口径，用日频回灌的月末值）
const ma200map = E.monthlySmooth(dser);
series.forEach(r => {
  const s = ma200map[r.m];
  r.ma200 = s && s.ma200 != null ? s.ma200 : null;
});

const N = series.length;
const COST = 0.0005;

function pctAt(i, key, win) {
  const st = E.rollingStats(series, i, win || 120, key || 'erpS');
  return st.n >= 24 ? st.pct : null;
}
// 预先算好分位，避免重复滑动
const P = series.map((r, i) => pctAt(i));

// 把「目标仓位序列」跑成绩效
function run(weights, label) {
  let a = 1, peak = 1, mdd = 0;
  const rets = [];
  let turn = 0, prevW = 0;
  for (let i = 1; i < N; i++) {
    const w = weights[i - 1]; // 用上一期信号，次月生效
    const r = series[i];
    if (r.retEq == null || r.retBd == null || w == null) continue;
    const dw = Math.abs(w - prevW);
    turn += dw;
    const ret = w * r.retEq + (1 - w) * r.retBd - dw * COST;
    prevW = w;
    a *= 1 + ret;
    rets.push(ret);
    if (a > peak) peak = a;
    const dd = a / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  const n = rets.length;
  const mu = rets.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / n);
  const ann = Math.pow(a, 12 / n) - 1;
  return {
    label, ann, vol: sd * Math.sqrt(12), sharpe: (mu * 12) / (sd * Math.sqrt(12)),
    mdd, turn: (turn / n) * 12,
  };
}

// 从状态机生成仓位序列（1=持仓 / 0=空仓）
function weightsFromState(state) {
  return state.map(s => (s === 1 ? 1 : 0));
}

function makeStateMachine(opts) {
  const o = opts;
  const state = new Array(N).fill(0);
  const sigs = [];
  let cur = 0;
  for (let i = 0; i < N; i++) {
    const p = P[i];
    const r = series[i];
    if (p == null) { state[i] = cur; continue; }
    let next = cur;
    if (cur === 0 && o.buy(p, r, i)) next = 1;
    else if (cur === 1 && o.sell(p, r, i)) next = 0;
    if (next !== cur) sigs.push({ m: r.m, type: next === 1 ? 'buy' : 'sell', pct: p, close: r.close });
    cur = next;
    state[i] = cur;
  }
  return { state, sigs };
}

const above = r => r.ma60 != null && r.close != null && r.close > r.ma60;
const below = r => r.ma60 != null && r.close != null && r.close < r.ma60;

const cases = [
  { key: 'A', label: '现状 65/35 + 60日线确认卖',
    buy: p => p >= 0.65, sell: (p, r) => p <= 0.35 && below(r) },
  { key: 'B', label: '60/40（阈值各放宽 5pct）',
    buy: p => p >= 0.60, sell: (p, r) => p <= 0.40 && below(r) },
  { key: 'C', label: '55/45（对称收窄）',
    buy: p => p >= 0.55, sell: (p, r) => p <= 0.45 && below(r) },
  { key: 'D', label: '50/50（分位过半即买，过半即卖）',
    buy: p => p >= 0.50, sell: (p, r) => p <= 0.50 && below(r) },
  { key: 'E', label: '55/45 + 卖点改为「破线」或「分位≤25」',
    buy: p => p >= 0.55, sell: (p, r) => (p <= 0.45 || p <= 0.25) && below(r) },
  { key: 'F', label: '估值买 65 + 趋势补充买（分位≥45 且上穿60线）',
    buy: (p, r) => p >= 0.65 || (p >= 0.45 && above(r)),
    sell: (p, r) => p <= 0.40 && below(r) },
  { key: 'G', label: '双确认 50/40（估值+趋势同时）',
    buy: (p, r) => p >= 0.50 && above(r), sell: (p, r) => p <= 0.40 && below(r) },
  { key: 'H', label: '趋势为主 60线金叉买 / 死叉卖（纯技术）',
    buy: (p, r, i) => above(r) && series[i - 1] && !above(series[i - 1]),
    sell: (p, r, i) => below(r) && series[i - 1] && !below(series[i - 1]) },
];

const rows = [];
console.log('区间 %s ~ %s，%d 个月\n', series[0].m, series[N - 1].m, N);
console.log('%-46s %6s %6s %8s %8s %8s %7s', '规则', '信号', '买/卖', '年化', '夏普', '回撤', '换手');
console.log('-'.repeat(96));
cases.forEach(c => {
  const st = makeStateMachine({ buy: c.buy, sell: c.sell });
  const perf = run(weightsFromState(st.state), c.label);
  const buys = st.sigs.filter(s => s.type === 'buy').length;
  const gap = st.sigs.length > 1
    ? ((N - 1) / (st.sigs.length - 1)).toFixed(1) : '-';
  rows.push(Object.assign({ key: c.key, n: st.sigs.length, buys, gap }, perf, { sigs: st.sigs }));
  console.log('%-46s %6d %6s %8s %8s %8s %7s',
    c.label, st.sigs.length, buys + '/' + (st.sigs.length - buys),
    (perf.ann * 100).toFixed(2) + '%', perf.sharpe.toFixed(2),
    (perf.mdd * 100).toFixed(1) + '%', perf.turn.toFixed(1) + 'x');
});

// 分档调仓：仓位随分位连续变化，每次档位切换即一个调仓提示
console.log('\n=== 分档调仓（仓位分 5 档，档位切换即信号）===');
function tierW(p) {
  if (p == null) return 0.5;
  if (p >= 0.85) return 0.90;
  if (p >= 0.70) return 0.80;
  if (p >= 0.50) return 0.65;
  if (p >= 0.30) return 0.45;
  return 0.30;
}
const tw = P.map(tierW);
let tierSigs = 0, prevT = null;
tw.forEach((w, i) => { if (prevT != null && w !== prevT) tierSigs++; prevT = w; });
const tp = run(tw, 'tier');
console.log('%-46s %6d %6s %8s %8s %8s %7s', '五档平滑调仓', tierSigs, '-',
  (tp.ann * 100).toFixed(2) + '%', tp.sharpe.toFixed(2), (tp.mdd * 100).toFixed(1) + '%', tp.turn.toFixed(1) + 'x');

// 输出各方案的信号时间线（便于看密度）
console.log('\n=== 信号时间线 ===');
rows.forEach(r => {
  console.log('\n[' + r.key + '] ' + r.label + '  共 ' + r.n + ' 个，平均间隔 ' + r.gap + ' 个月');
  console.log('  ' + r.sigs.map(s => s.m + (s.type === 'buy' ? '▲' : '▼')).join(' '));
});
