/* 引擎冒烟测试: node scripts/smoke_test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.dirname(__dirname);
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'data', 'dataset.js'), 'utf8'), sandbox);
const Engine = require(path.join(root, 'engine.js'));

const rows = sandbox.window.EQBD.rows;
console.log('=== 原始数据 ===');
console.log('rows:', rows.length, '| 可用:', rows.filter(r => r.ok).length);

const series = Engine.buildSeries(rows);
console.log('\n=== 面板 ===');
console.log('可用月份:', series.length, '区间', series[0].m, '~', series[series.length - 1].m);
const missingRet = series.filter(s => s.retEq == null || s.retBd == null);
console.log('缺失收益的月份:', missingRet.length, missingRet.map(s => s.m).join(','));

// --- 收益合理性 ---
const eqs = series.slice(1).map(s => s.retEq);
const bds = series.slice(1).map(s => s.retBd);
const pct = x => (x * 100).toFixed(2) + '%';
console.log('\n=== 月度收益(年化核对) ===');
const eqAnn = Math.pow(series[series.length - 1].close / series[0].close, 12 / (series.length - 1)) - 1;
console.log('沪深300 价格年化:', pct(eqAnn), '(复核对:不含股息)');
console.log('股票月收益 均值/标准差:', pct(Engine.mean(eqs)), '/', pct(Engine.stdev(eqs)));
console.log('债券月收益 均值/标准差:', pct(Engine.mean(bds)), '/', pct(Engine.stdev(bds)));
console.log('债券单层最大/最小月度:', pct(Math.max(...bds)), '/', pct(Math.min(...bds)));
console.log('修正久期 @2.0%:', Engine.modDuration(2.0).toFixed(2), ' @4%:', Engine.modDuration(4).toFixed(2), '(应约9左右)');

// --- 当前快照 ---
const cfg = { signal: 'erp', window: 0, map: 'pct', minW: 0.2, maxW: 0.9, zRange: 2, startIdx: 0, rebalance: 1, costBp: 5 };
const snap = Engine.currentSnapshot(series, cfg);
console.log('\n=== 当前读数 ' + snap.date + ' ===');
console.log('PE', snap.pe.toFixed(2), '| E/P', snap.ep.toFixed(2) + '%', '| Y10', snap.y10.toFixed(2) + '%');
console.log('ERP', snap.erp.toFixed(2) + 'pct', '| 比值', snap.ratio.toFixed(2), '| 股息差', snap.dyspread.toFixed(2));
const s = snap.stats.erp;
console.log('ERP 历史分位', (s.pct * 100).toFixed(1) + '%', '| Z', s.z.toFixed(2), '| 样本', s.n);
console.log('ERP 区间 min/中位数/max:', s.min.toFixed(2), s.p50.toFixed(2), s.max.toFixed(2));
console.log('目标股票仓位:', (snap.weight * 100).toFixed(1) + '%');

// --- 回测 ---
console.log('\n=== 回测 (起点 ' + series[0].m + ') ===');
const bt = Engine.backtest(series, cfg);
const fmt = m => m ? `年化${pct(m.ann)} 波动${pct(m.vol)} 夏普${m.sharpe.toFixed(2)} 回撤${pct(m.maxDD)} Calmar${m.calmar.toFixed(2)} 胜率${pct(m.winRate)}` : 'n/a';
console.log('ERP轮动 :', fmt(bt.strategy));
console.log('纯股票  :', fmt(bt.equity));
console.log('纯债券  :', fmt(bt.bond));
console.log('60/40   :', fmt(bt.mix6040));
console.log('平均换手', pct(bt.avgTurnover), '累计成本', pct(bt.costTotal), '| 无风险利率假设', pct(bt.rf));
console.log('净值序列长度', bt.strategy.navSeries.length, '首', bt.strategy.navSeries[0], '末', bt.strategy.navSeries[bt.strategy.navSeries.length - 1].toFixed(3));

// --- 边界检查 ---
let nan = 0;
[bt.strategy, bt.equity, bt.bond, bt.mix6040].forEach(m => {
  ['ann', 'vol', 'maxDD'].forEach(k => { if (!isFinite(m[k])) nan++; });
});
console.log('\n非有限值数量:', nan, nan === 0 ? '✅ 通过' : '❌ 存在NaN');

// --- 情景矩阵 ---
const sc = Engine.scenarios(series, cfg, [-0.2, 0, 0.2], [-50, 0, 50]);
console.log('\n=== 情景推演 (行=PE变动 列=Y10变动bp) ===');
sc.forEach(r => {
  console.log('PE' + (r.dPe * 100 > 0 ? '+' : '') + (r.dPe * 100) + '%:',
    r.cells.map(c => `${c.bp > 0 ? '+' : ''}${c.bp}bp→ERP${c.value.toFixed(2)} 仓位${(c.weight * 100).toFixed(0)}%`).join(' | '));
});
