/* 档位切换探针: node scripts/tier_test.js
 * 用与 renderVerdict 完全相同的分档阈值（0.85/0.65/0.35/0.15），
 * 统计档位切换次数、每次切换后的前瞻收益，确认标记点数量与质量 */
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

const cfg = { signal: 'erp', window: 120, map: 'pct', minW: 0.2, maxW: 0.9, smooth: true };

const TIERS = [
  { k: 'A', lo: 0.85, name: '显著低估', act: '强烈买入' },
  { k: 'B', lo: 0.65, name: '偏便宜', act: '买入' },
  { k: 'C', lo: 0.35, name: '中性', act: '持有' },
  { k: 'D', lo: 0.15, name: '偏贵', act: '卖出' },
  { k: 'E', lo: -1, name: '显著高估', act: '强烈卖出' },
];
const tierOf = (p) => TIERS.find((t) => p >= t.lo);
const nameOf = (k) => TIERS.find((t) => t.k === k);

const key = E.signalKey(cfg);
const rows = [];
for (let i = 0; i < series.length; i++) {
  const v = series[i][key];
  if (v == null || !isFinite(v)) continue;
  const st = E.rollingStats(series, i, cfg.window, key);
  if (st.n < 24) continue;
  const t = tierOf(st.pct);
  rows.push({ i: i, m: series[i].m, close: series[i].close, erp: series[i].erp, erpS: series[i].erpS, pct: st.pct, z: st.z, tier: t.k });
}

const pctF = (x) => (x * 100).toFixed(1) + '%';
function fwd(i, h) {
  let a = 1;
  for (let k = 1; k <= h; k++) {
    const r = series[i + k];
    if (!r || r.retEq == null) return null;
    a *= 1 + r.retEq;
  }
  return a - 1;
}
function fwdBd(i, h) {
  let a = 1;
  for (let k = 1; k <= h; k++) {
    const r = series[i + k];
    if (!r || r.retBd == null) return null;
    a *= 1 + r.retBd;
  }
  return a - 1;
}

console.log('样本', rows.length, '个月', rows[0].m, '~', rows[rows.length - 1].m);
const dist = {};
rows.forEach((r) => { dist[r.tier] = (dist[r.tier] || 0) + 1; });
console.log('档位分布:', TIERS.map((t) => t.k + ' ' + t.name + '=' + (dist[t.k] || 0)).join('  '));

const switches = [];
for (let k = 1; k < rows.length; k++) {
  if (rows[k].tier !== rows[k - 1].tier) switches.push(rows[k]);
}
console.log('\n档位切换次数:', switches.length, '（年均 ' + (switches.length / (rows.length / 12)).toFixed(1) + ' 次）');

console.log('\n月份    | 从→到        | 收盘   | ERP  | 分位  | 后6M   | 后12M  | 后12M债券');
switches.forEach((s, k) => {
  const prev = rows[k].tier; // 顺序即上次与本次，注意 rows 已过滤
  const f6 = fwd(s.i, 6), f12 = fwd(s.i, 12), b12 = fwdBd(s.i, 12);
  console.log(
    s.m.padEnd(8),
    (prev + '→' + s.tier).padEnd(12),
    String(Math.round(s.close)).padStart(6),
    s.erp.toFixed(2).padStart(6),
    pctF(s.pct).padStart(6),
    (f6 == null ? '—' : pctF(f6)).padStart(6),
    (f12 == null ? '—' : pctF(f12)).padStart(7),
    (b12 == null ? '—' : pctF(b12)).padStart(8)
  );
});

// 各档位下持有一年的平均收益（用于表头校验）
console.log('\n各档位事后12个月沪深300平均收益：');
TIERS.forEach((t) => {
  const xs = rows.filter((r) => r.tier === t.k).map((r) => fwd(r.i, 12)).filter((x) => x != null);
  if (!xs.length) return;
  console.log('  ' + t.k + ' ' + t.name.padEnd(6), 'n=' + String(xs.length).padStart(3),
    '均值 ' + pctF(E.mean(xs)).padStart(7), '中位 ' + pctF(E.quantile(xs, 0.5)).padStart(7),
    '胜率 ' + pctF(xs.filter((x) => x > 0).length / xs.length));
});

// 只有"方向性"事件：买入档(A/B)与卖出档(D/E)，跳过 C 中性来回
const dir = [];
let last = null;
switches.forEach((s, k) => {
  const side = (s.tier === 'A' || s.tier === 'B') ? 'buy' : (s.tier === 'D' || s.tier === 'E') ? 'sell' : null;
  if (!side || side === last) return;
  dir.push({ s: s, side: side });
  last = side;
});
console.log('\n方向性事件（跳过中性档）:', dir.length);
dir.forEach((d) => console.log('  ' + d.s.m, d.side === 'buy' ? '买入' : '卖出', '收盘', Math.round(d.s.close), '分位', pctF(d.s.pct)));
