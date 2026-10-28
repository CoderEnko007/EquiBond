/* ============================================================
 * EquiBond App —— 渲染层
 * 依赖: vendor/echarts.min.js, data/dataset.js, engine.js
 * ============================================================ */
(function () {
  'use strict';

  const E = window.EQBEngine;
  const D = window.EQBD;

  // ---- 日频序列（图表用）：约 3,500 个交易日 ----
  // PE 由 Wind 月末权威值 + 日线收盘价比例推算，跨月自动重新锚定
  const dser = E.buildDaily(D.daily || []);
  const HAS_DAILY = dser.length > 100;
  if (HAS_DAILY) {
    E.moveAvg(dser, 'erp', 20);
    E.moveAvg(dser, 'ratio', 20);
    E.moveAvg(dser, 'close', 60);   // 60 日线：买卖信号的趋势确认
    E.volZ(dser, 20);               // 成交量情绪（对数 z-score）
  }
  const smoothMap = HAS_DAILY ? E.monthlySmooth(dser) : null;

  // ---- 月度序列（信号 / 回测 / 矩阵用）----
  const series = E.buildSeries(D.rows, smoothMap);
  const charts = {};

  const DEFAULTS = {
    signal: 'erp', window: 120, map: 'pct',
    minW: 0.20, maxW: 0.90, zRange: 2,
    startIdx: 0, rebalance: 1, costBp: 5,
    smooth: true,      // 仓位信号用 20 日平滑值（回测同步）
  };
  let cfg = Object.assign({}, DEFAULTS);
  let CHAN = 'roll';   // ERP 通道统计口径：roll | exp | fix | quant

  // ---------------- 主题常量 ----------------
  const C = {
    stock: '#d1362d', bond: '#2f6fed', grey: '#98a1af', amber: '#e8a33d',
    purple: '#7b52c9', txt: '#1b1f27', txt2: '#5a6472', txt3: '#8e97a6',
    line: '#e3e7ed', soft: '#eef1f5',
  };
  // ---------------- 窄屏（手机）自适应 ----------------
  // 手机竖屏可用宽度约 340~400px，桌面那套左右留白 / 图例间距会把绘图区压扁，
  // 所以尺寸类参数统一从下面两个工厂函数出，render() 时按当前宽度取值。
  let NARROW = window.innerWidth <= 720;

  const AXIS = () => ({
    axisLine: { lineStyle: { color: C.line } },
    axisTick: { show: false },
    axisLabel: { color: C.txt3, fontSize: NARROW ? 10 : 11, hideOverlap: true },
    splitLine: { lineStyle: { color: C.soft } },
  });
  const TIP = {
    backgroundColor: 'rgba(255,255,255,.97)',
    borderColor: C.line, borderWidth: 1,
    textStyle: { color: C.txt, fontSize: 12 },
    padding: [9, 12],
    confine: true,   // 手指点在屏幕边缘时不让浮层溢出可视区
    extraCssText: 'box-shadow:0 6px 20px rgba(16,24,40,.12); border-radius:9px;max-width:88vw;',
  };
  const LEGEND = () => {
    const base = {
      left: 8, top: 2, itemWidth: 14, itemHeight: 8, itemGap: 16,
      textStyle: { color: C.txt2, fontSize: 12 },
    };
    if (!NARROW) return base;
    return Object.assign({}, base, {
      left: 4, top: 1, itemGap: 9, itemWidth: 11, itemHeight: 7,
      textStyle: { color: C.txt2, fontSize: 10.5 },
    });
  };
  // 绘图区留白：窄屏压缩左右、顶部给换行后的图例留位
  function gd(g) {
    if (!NARROW) return g;
    const o = Object.assign({}, g);
    o.left = Math.min(o.left == null ? 48 : o.left, 44);
    o.right = Math.min(o.right == null ? 20 : o.right, 42);
    o.top = (g.top || 46) + 14;
    if ((g.bottom || 42) < 60) o.bottom = 50;
    return o;
  }

  const months = series.map((s) => s.m);

  // ---------------- 格式化 ----------------
  const f = {
    n2: (x) => (x == null || !isFinite(x)) ? '—' : x.toFixed(2),
    n1: (x) => (x == null || !isFinite(x)) ? '—' : x.toFixed(1),
    p: (x, d) => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%',
    raw: (x, d) => (x == null || !isFinite(x)) ? '—' : x.toFixed(d == null ? 2 : d),
    sign: (x) => (x > 0 ? '+' : '') + f.p(x, 2),
  };
  const windowLabel = () => cfg.window === 0 ? '全样本' : '近' + (cfg.window / 12) + '年';

  // ---------------- 初始化控件 ----------------
  function initControls() {
    const sel = document.getElementById('c-start');
    const opts = [];
    for (let i = 0; i < series.length - 24; i++) {
      if (i === 0 || i === series.length - 25 || series[i].m.endsWith('-01')) {
        opts.push('<option value="' + i + '">' + series[i].m + '</option>');
      }
    }
    sel.innerHTML = opts.join('');
    sel.value = String(cfg.startIdx);

    const bind = (id, fn, evt) => {
      const el = document.getElementById(id);
      el.addEventListener(evt || 'change', fn);
      return el;
    };

    bind('c-signal', (e) => { cfg.signal = e.target.value; render(); });
    bind('c-window', (e) => { cfg.window = +e.target.value; render(); });
    bind('e-chan', (e) => { CHAN = e.target.value; renderERP(); });
    // 口径对照：点击窗口行即套用到全站；填入外部读数实时反推差异来源
    const dw = document.getElementById('diag-win');
    if (dw) dw.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-w]');
      if (!tr) return;
      cfg.window = +tr.getAttribute('data-w');
      syncAll(); render();
    });
    bind('diag-in', (e) => {
      const v = parseFloat(e.target.value);
      DIAG_EXT = isFinite(v) ? v : null;
      renderDiagOut();
    }, 'input');
    bind('c-map', (e) => { cfg.map = e.target.value; render(); });
    bind('c-rebal', (e) => { cfg.rebalance = +e.target.value; render(); });
    bind('c-cost', (e) => { cfg.costBp = +e.target.value || 0; render(); });
    bind('c-start', (e) => { cfg.startIdx = +e.target.value; render(); });
    bind('c-min', (e) => {
      cfg.minW = +e.target.value / 100;
      if (cfg.minW > cfg.maxW - 0.05) { cfg.maxW = Math.min(1, cfg.minW + 0.05); syncRanges(); }
      render();
    }, 'input');
    bind('c-max', (e) => {
      cfg.maxW = +e.target.value / 100;
      if (cfg.maxW < cfg.minW + 0.05) { cfg.minW = Math.max(0, cfg.maxW - 0.05); syncRanges(); }
      render();
    }, 'input');
    document.getElementById('c-reset').addEventListener('click', () => {
      cfg = Object.assign({}, DEFAULTS);
      syncAll(); render();
    });
    // 净值图视图切换：相对强弱 / 绝对净值
    const sw = document.getElementById('nav-switch');
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      navView = b.getAttribute('data-v');
      [].forEach.call(sw.querySelectorAll('button'), (x) => x.classList.toggle('on', x === b));
      document.getElementById('nav-foot').textContent = navView === 'rel'
        ? '以沪深300 为基准，纵轴＝相对强弱；0% 即与沪深300 持平。可拖动下方滑块缩放区间（滚轮需按住 Shift）'
        : '四条策略的累计净值（对数坐标）；可拖动下方滑块缩放区间（滚轮需按住 Shift）';
      drawNav();
    });
  }

  function syncRanges() {
    const mn = document.getElementById('c-min'), mx = document.getElementById('c-max');
    mn.value = Math.round(cfg.minW * 100);
    mx.value = Math.round(cfg.maxW * 100);
    document.getElementById('c-min-v').textContent = Math.round(cfg.minW * 100) + '%';
    document.getElementById('c-max-v').textContent = Math.round(cfg.maxW * 100) + '%';
  }

  function syncAll() {
    document.getElementById('c-signal').value = cfg.signal;
    document.getElementById('c-window').value = String(cfg.window);
    document.getElementById('c-map').value = cfg.map;
    document.getElementById('c-rebal').value = String(cfg.rebalance);
    document.getElementById('c-cost').value = cfg.costBp;
    document.getElementById('c-start').value = String(cfg.startIdx);
    syncRanges();
  }

  function syncLabels() {
    document.getElementById('c-min-v').textContent = Math.round(cfg.minW * 100) + '%';
    document.getElementById('c-max-v').textContent = Math.round(cfg.maxW * 100) + '%';
  }

  // ---------------- 图表工具 ----------------
  function ensure(id) {
    if (!charts[id]) charts[id] = echarts.init(document.getElementById(id));
    return charts[id];
  }
  const noSym = { symbol: 'none' };

  /* ---------------- 时间范围快捷按钮 ----------------
   * 每张图各自记忆选择：切视图（相对/净值）、改参数重绘后都保持不变。
   * 定位用 startValue（类目索引）而不是百分比，序列长度变化时不会漂移。 */
  const RANGES = [
    { k: '3m', label: '近三月', m: 3 },
    { k: '6m', label: '近六月', m: 6 },
    { k: 'ytd', label: '今年来', m: 0 },
    { k: '1y', label: '近一年', m: 12 },
    { k: '3y', label: '近三年', m: 36 },
    { k: '5y', label: '近五年', m: 60 },
    { k: 'all', label: '全部', m: -1 },
  ];
  const rangeOf = {};   // chartId -> 'all' | '3m' | ...

  function rangeDates(id) {
    const inst = charts[id];
    if (!inst) return null;
    const opt = inst.getOption();
    const ax = opt && opt.xAxis;
    const first = Array.isArray(ax) ? ax[0] : ax;
    return first && first.data && first.data.length ? first.data : null;
  }

  /** 求起始类目索引：以数据最后一个点的日期为锚（而不是今天），避免数据滞后期错位 */
  function rangeStartIndex(dates, key) {
    const def = RANGES.filter((r) => r.k === key)[0];
    if (!def || def.m < 0) return 0;
    const last = String(dates[dates.length - 1]);
    const monthly = last.length <= 7;
    const y = +last.slice(0, 4), mo = +last.slice(5, 7);
    let ty, tm;
    if (key === 'ytd') { ty = y; tm = 1; }
    else {
      const t = new Date(y, mo - 1 - def.m, 1);
      ty = t.getFullYear(); tm = t.getMonth() + 1;
    }
    const target = ty + '-' + (tm < 10 ? '0' : '') + tm + (monthly ? '' : '-01');
    let lo = 0, hi = dates.length - 1, ans = dates.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (String(dates[mid]).slice(0, target.length) >= target) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  }

  function applyRange(id) {
    const inst = charts[id];
    const dates = rangeDates(id);
    if (!inst || !dates) return;
    const key = rangeOf[id] || 'all';
    const s = rangeStartIndex(dates, key);
    const n = dates.length;
    const dz = (inst.getOption().dataZoom || []);
    dz.forEach((_, i) => inst.dispatchAction({
      type: 'dataZoom', dataZoomIndex: i, startValue: s, endValue: n - 1,
    }));
    const bar = document.querySelector('.range-bar[data-for="' + id + '"]');
    if (bar) {
      [].forEach.call(bar.children, (b) => {
        b.className = b.getAttribute('data-k') === key ? 'on' : '';
      });
    }
  }

  /** 把按钮条插到图容器后面（图表 DOM 由 ECharts 接管，只能做兄弟节点） */
  function mountRangeBar(id) {
    if (document.querySelector('.range-bar[data-for="' + id + '"]')) return;
    const el = document.getElementById(id);
    if (!el) return;
    const bar = document.createElement('div');
    bar.className = 'range-bar';
    bar.setAttribute('data-for', id);
    RANGES.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.label;
      b.setAttribute('data-k', r.k);
      if (r.k === (rangeOf[id] || 'all')) b.className = 'on';
      b.addEventListener('click', () => { rangeOf[id] = r.k; applyRange(id); });
      bar.appendChild(b);
    });
    el.insertAdjacentElement('afterend', bar);
  }

  function rangeBar(id) { mountRangeBar(id); applyRange(id); }

  // ---------------- 数据新鲜度 ----------------
  function renderFreshness(snap) {
    const rf = D.meta.refresh || {};
    const box = document.getElementById('m-fresh');
    const bar = document.getElementById('stale-bar');
    const barTxt = document.getElementById('stale-text');

    // 最新数据点与今天的距离
    const asOf = rf.live ? rf.live.date : snap.date;
    const days = Math.round((Date.now() - new Date(asOf).getTime()) / 86400000);
    const cls = days <= 3 ? 'ok' : (days <= 8 ? 'warn' : 'bad');
    const level = days <= 3 ? '最新' : (days <= 8 ? '滞后' : '过期');
    box.innerHTML = '最新数据点 <b>' + asOf + '</b> ｜ <span class="' + cls + '">' +
      level + ' ' + days + ' 天</span>' +
      (rf.live ? '　<span style="color:var(--down)">实时 ' + rf.live.close.toFixed(2) + '</span>' : '') +
      (rf.y10_source ? '<br>国债YTM 取自 <b>' + rf.y10_source + '</b>（当日曲线 17:30 后发布）' : '');

    // 需要提示的情况
    const msgs = [];
    let bad = false;

    if (days > 8) {
      msgs.push('数据已 ' + days + ' 天没更新了。双击项目根目录的 <code>start.bat</code> 会自动联网补齐最新交易日的沪深300 点位和估值，再自动打开本页面。');
    }
    if (rf.anchor_expired) {
      bad = true;
      msgs.push('PE 锚点 <code>' + rf.anchor_date + '</code> 距今 ' + rf.anchor_age_days +
        ' 天，很可能跨过了财报披露期（指数盈利 E 已变），滚动推算的 PE 会失真。' +
        '建议让我执行「校准股债数据」用 Wind 重新取一次 PE/PB/股息率。');
    }
    if (!rf.live) {
      msgs.push('上次运行时没有联网拿到实时行情，页面显示的是最后一次成功取到的月度快照。');
    }

    if (msgs.length) {
      barTxt.innerHTML = msgs.join('<br>');
      bar.className = 'stale-bar' + (bad ? ' bad' : '');
    } else {
      bar.className = 'stale-bar hidden';
    }
  }

  // ---------------- 渲染: KPI ----------------
  function renderKPI(snap) {
    document.getElementById('m-date').textContent = snap.date;
    document.getElementById('m-n').textContent = HAS_DAILY
      ? dser.length.toLocaleString('en-US') + ' 个交易日'
      : series.length + ' 个月';
    document.getElementById('m-gen').textContent = D.meta.generated.slice(0, 10);
    document.getElementById('n-range').textContent = D.meta.range[0] + ' ~ ' + D.meta.range[1];
    document.getElementById('n-count').textContent = series.length + ' 个月'
      + (HAS_DAILY ? '，日频面板 ' + dser.length.toLocaleString('en-US') + ' 个交易日' : '');

    document.getElementById('k-ep').innerHTML = f.n2(snap.ep) + '<span class="unit">%</span>';
    document.getElementById('k-y10').innerHTML = f.n2(snap.y10) + '<span class="unit">%</span>';
    document.getElementById('k-erp').innerHTML = f.n2(snap.erp) + '<span class="unit">pct</span>';
    document.getElementById('k-ratio').innerHTML = f.n2(snap.ratio) + '<span class="unit">×</span>';
    document.getElementById('k-dys').innerHTML = f.n2(snap.dyspread) + '<span class="unit">pct</span>';

    const st = snap.stats[cfg.signal];
    document.getElementById('k-winlab').textContent = windowLabel();
    document.getElementById('k-pct').innerHTML = f.n1(st.pct * 100) + '<span class="unit">%</span>';
    document.getElementById('k-pct-foot').textContent =
      'Z=' + f.n2(st.z) + ' ｜ 中位 ' + f.n2(st.p50) + ' ｜ 区间 [' + f.n2(st.min) + ', ' + f.n2(st.max) + ']';

    const labels = { erp: 'E/P − Y10　越高＝股票越便宜', ratio: 'E/P ÷ Y10　倍数越大越便宜', dyspread: '股息率 − Y10　越厚越有底' };
    let footTxt = labels[cfg.signal];
    if (cfg.smooth && cfg.signal !== 'dyspread' && snap.weightInput) {
      const sv = cfg.signal === 'erp' ? snap.erpS : snap.ratioS;
      if (sv != null) {
        footTxt += '　｜　20日均线 ' + f.n2(sv)
          + (cfg.signal === 'erp' ? ' pct' : '×')
          + '（分位 ' + f.n1(snap.weightInput.pct * 100) + '%，用于定仓位）';
      }
    }
    document.getElementById('k-erp-foot').textContent = footTxt;
  }

  // ---------------- 渲染: 结论 ----------------
  function renderVerdict(snap, fw) {
    const st = snap.stats[cfg.signal];
    // 判定与仓位都用平滑口径（缺失时回退原始）
    const stSig = (cfg.smooth && snap.statsSmooth) ? snap.statsSmooth : st;
    const p = stSig.pct;
    const w = snap.weight;
    let tier, col, bg, verdict;
    if (p >= 0.85) { tier = '股票显著低估'; col = C.stock; bg = '#fdeceb'; verdict = '超配股票'; }
    else if (p >= 0.65) { tier = '股票偏便宜'; col = '#e0634f'; bg = '#fff2f0'; verdict = '小幅超配股票'; }
    else if (p >= 0.35) { tier = '中性区间'; col = C.amber; bg = '#fff8ec'; verdict = '维持基准比例'; }
    else if (p >= 0.15) { tier = '股票偏贵'; col = '#3aa87a'; bg = '#eefaf3'; verdict = '小幅减配股票'; }
    else { tier = '股票显著高估'; col = '#12a05c'; bg = '#e7f7ef'; verdict = '大幅减配股票'; }

    const tag = document.getElementById('v-tag');
    tag.textContent = tier;
    tag.style.background = bg;
    tag.style.color = col;

    const unitLabel = { erp: 'pct', ratio: '×', dyspread: 'pct' }[cfg.signal];
    const signalName = { erp: '股权风险溢价 ERP', ratio: '股债收益比', dyspread: '股息率差' }[cfg.signal];
    document.getElementById('v-signal').innerHTML =
      '当前 <b>' + signalName + '</b> = <b>' + f.n2(st.value) + ' ' + unitLabel + '</b>' +
      (stSig !== st ? '（20日均线 ' + f.n2(stSig.value) + '）' : '') + '，' +
      '处于' + windowLabel() + ' <b>' + f.n1(p * 100) + '%</b> 分位' +
      '（Z = ' + f.n2(stSig.z) + '，较中位数 ' + f.n2(stSig.p50) + ' ' +
      (stSig.value >= stSig.p50 ? '高出 ' : '低 ') + f.n2(Math.abs(stSig.value - stSig.p50)) + '）';

    const eq = document.getElementById('v-bar-eq'), bd = document.getElementById('v-bar-bd');
    const eqPct = Math.round(w * 100);
    eq.style.width = eqPct + '%';
    eq.textContent = '股票 ' + eqPct + '%';
    bd.textContent = '债券 ' + (100 - eqPct) + '%';

    let fwText = '';
    if (fw && fw.n >= 6) {
      fwText = '历史上信号不低于当前水平的样本有 <b>' + fw.n + '</b> 个，其后 ' + fw.horizon +
        ' 个月沪深300总收益平均 <b>' + f.sign(fw.eqMean) + '</b>、中位 <b>' + f.sign(fw.eqMedian) +
        '</b>，上涨概率 <b>' + f.p(fw.eqWin, 0) + '</b>，相对债券超额 <b>' + f.sign(fw.excess) + '</b>。';
    } else if (fw) {
      fwText = '历史可比样本不足（' + fw.n + ' 个），类比参考价值有限。';
    }

    document.getElementById('v-text').innerHTML =
      '建议配置：<b style="color:' + C.stock + '">股票 ' + eqPct + '%</b>' +
      ' / <b style="color:' + C.bond + '">债券 ' + (100 - eqPct) + '%</b>　' +
      '—— ' + verdict + '。<br>' + fwText;

    // 温度仪表
    ensure('gauge').setOption({
      series: [{
        type: 'gauge', min: 0, max: 100, startAngle: 210, endAngle: -30,
        radius: '92%', center: ['50%', '62%'],
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color: col } },
        axisLine: { roundCap: true, lineStyle: { width: 14, color: [[1, C.soft]] } },
        pointer: { icon: 'triangle', width: 10, length: '58%', offsetCenter: [0, '5%'], itemStyle: { color: col } },
        axisTick: { distance: -18, length: 5, lineStyle: { color: C.txt3, width: 1 } },
        splitLine: { distance: -20, length: 10, lineStyle: { color: C.txt3, width: 1.5 } },
        axisLabel: { distance: -6, color: C.txt3, fontSize: 10 },
        anchor: { show: true, size: 10, itemStyle: { color: col, borderWidth: 0 } },
        title: { show: false },
        detail: {
          valueAnimation: true, fontSize: 30, fontWeight: 650, color: col,
          offsetCenter: [0, '38%'], formatter: (v) => v.toFixed(0),
        },
        data: [{ value: p * 100 }],
      }],
    });
  }

  // ---------------- 渲染: 双线图 ----------------
  function renderYield() {
    // 日频优先（3,500+ 个交易日）；数据缺失时自动退化为月度
    const ds = HAS_DAILY ? dser : series;
    const dDates = ds.map((s) => s.d || s.date || s.m);
    const ep = ds.map((s) => +s.ep.toFixed(3));
    const y10 = ds.map((s) => s.y10);
    const erp = ds.map((s) => +s.erp.toFixed(3));
    // 沪深300 点位（右轴，对数）
    const px = ds.map((s) => (s.close == null ? null : Math.round(s.close)));
    const PX = '#b07d1a';
    const lastI = ds.length - 1;
    const last = ds[lastI];

    ensure('chart-yield').setOption({
      grid: gd({ left: 52, right: 62, top: 46, bottom: 56 }),
      tooltip: Object.assign({}, TIP, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: C.txt3, type: 'dashed' } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const pxTxt = ds[i].close == null ? '—'
            : Math.round(ds[i].close).toLocaleString('en-US');
          return '<b>' + dDates[i] + '</b><br>' +
            '<span style="color:' + C.stock + '">盈利收益率 E/P</span>：' + f.n2(ds[i].ep) + '%<br>' +
            '<span style="color:' + C.bond + '">10年国债 YTM</span>：' + f.n2(ds[i].y10) + '%<br>' +
            '<span style="color:#8e4b45">风险溢价 ERP</span>：<b>' + f.n2(ds[i].erp) + ' pct</b><br>' +
            '<span style="color:' + PX + '">沪深300</span>：' + pxTxt +
            '　<span style="color:' + C.txt3 + '">PE ' + f.n2(ds[i].pe) + '</span>';
        },
      }),
      legend: Object.assign(LEGEND(), { data: ['10年国债YTM', '盈利收益率 E/P', '沪深300'] }),
      xAxis: Object.assign({ type: 'category', data: dDates, boundaryGap: false }, AXIS()),
      yAxis: [
        Object.assign({ type: 'value', name: '%', scale: true, nameTextStyle: { color: C.txt3, fontSize: 11, padding: [0, 0, 0, -34] } }, AXIS()),
        Object.assign({}, AXIS(), {
          type: 'log', name: '沪深300', scale: true, position: 'right',
          nameTextStyle: { color: PX, fontSize: 11, padding: [0, 0, 0, 24] },
          splitLine: { show: false },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: PX, fontSize: 10, formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) },
        }),
      ],
      dataZoom: [
        { type: 'inside', throttle: 60 },
        {
          type: 'slider', height: NARROW ? 14 : 16, bottom: NARROW ? 6 : 8,
          borderColor: C.line, fillerColor: 'rgba(47,111,237,.10)',
          handleStyle: { color: C.bond }, textStyle: { color: C.txt3, fontSize: 10 },
        },
      ],
      series: [
        {
          name: '10年国债YTM', type: 'line', stack: 'tot', symbol: 'none',
          lineStyle: { color: C.bond, width: 1.6 },
          areaStyle: { color: 'rgba(47,111,237,.10)' },
          itemStyle: { color: C.bond }, data: y10,
        },
        {
          name: '盈利收益率 E/P', type: 'line', stack: 'tot', symbol: 'none',
          lineStyle: { width: 0 }, areaStyle: { color: 'rgba(209,54,45,.20)' },
          itemStyle: { color: C.stock }, data: erp, tooltip: { show: false },
        },
        {
          name: '盈利收益率 E/P', type: 'line', symbol: 'none',
          lineStyle: { color: C.stock, width: 1.9 },
          itemStyle: { color: C.stock }, data: ep,
          markLine: {
            silent: true, symbol: 'none',
            label: {
              formatter: '当前 ERP ' + f.n2(last.erp),
              color: C.stock, fontSize: 10, position: 'insideEndTop',
            },
            lineStyle: { color: C.stock, type: 'dotted', opacity: .55 },
            data: [{ xAxis: lastI }],
          },
        },
        {
          // 沪深300 点位（右轴对数，实线）——与 ERP 图保持同一视觉语言
          name: '沪深300', type: 'line', symbol: 'none', z: 3, yAxisIndex: 1,
          lineStyle: { color: PX, width: 1.4, type: 'solid', opacity: .8 },
          itemStyle: { color: PX }, data: px, tooltip: { show: false },
        },
      ],
    }, true);
    rangeBar('chart-yield');
  }

  // ---------------- 渲染: ERP 通道图 ----------------
  /* ERP 通道图。chanMode 四种口径：
   *  roll  滚动窗口均值±σ（跟随「标准化回看窗口」，实盘可用，默认）
   *  exp   全样本累计均值±σ（截至当月的扩张窗口，实盘可用）
   *  fix   固定全样本均值±σ（用完整历史一次性算出，轨道与极值重合度最高，
   *         但把「未来」也算进去了——只能复盘，不能当实盘信号）
   *  quant 滚动 P10–P90 分位带（对非正态/含极值的数据比 σ 通道稳健） */
  /** 通用通道计算：mean / sd 用滑动窗口 O(n)；分位带按 step 稀疏采样后阶梯填充。
   *  ds 可以是日频或月度，win 单位与 ds 一致（0 = 扩张窗口）。 */
  function rollingBand(ds, key, win, step) {
    const n = ds.length;
    const W = win > 0 ? win : n;
    const val = new Array(n), mean = new Array(n), sd = new Array(n);
    const p10 = new Array(n), p50 = new Array(n), p90 = new Array(n);
    const q = [];
    let s1 = 0, s2 = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const v = ds[i][key];
      const ok = v != null && isFinite(v);
      val[i] = ok ? +v.toFixed(3) : null;
      q.push(ok ? v : null);
      if (ok) { s1 += v; s2 += v * v; c++; }
      if (q.length > W) {
        const o = q.shift();
        if (o != null) { s1 -= o; s2 -= o * o; c--; }
      }
      if (c >= Math.min(W, 12)) {
        const m = s1 / c;
        mean[i] = +m.toFixed(3);
        sd[i] = Math.sqrt(Math.max(0, s2 / c - m * m) * c / Math.max(1, c - 1));
      } else {
        mean[i] = null; sd[i] = null;
      }
    }
    // 分位：每 step 个点算一次（日频逐点排序太慢），其余按上一个标记阶梯填充
    const marks = [];
    for (let i = W - 1; i < n; i += step) {
      const smp = [];
      for (let k = i - W + 1; k <= i; k++) {
        const v = ds[k][key];
        if (v != null && isFinite(v)) smp.push(v);
      }
      if (smp.length < 12) continue;
      smp.sort((a, b) => a - b);
      marks.push({ i: i, a: E.quantile(smp, 0.1), b: E.quantile(smp, 0.5), c: E.quantile(smp, 0.9) });
    }
    let ptr = 0, cur = null;
    for (let i = 0; i < n; i++) {
      while (ptr < marks.length && marks[ptr].i <= i) { cur = marks[ptr]; ptr++; }
      if (cur) { p10[i] = +cur.a.toFixed(3); p50[i] = +cur.b.toFixed(3); p90[i] = +cur.c.toFixed(3); }
      else { p10[i] = null; p50[i] = null; p90[i] = null; }
    }
    return { val: val, mean: mean, sd: sd, p10: p10, p50: p50, p90: p90 };
  }

  function renderERP() {
    const chanMode = CHAN;   // 模块级变量，由下拉控制
    // 日频优先；股息率差没有日频数据源，回退月度
    const useDaily = HAS_DAILY && cfg.signal !== 'dyspread';
    const ds = useDaily ? dser : series;
    const dDates = ds.map((s) => s.d || s.date || s.m);
    const N = ds.length;

    // 窗口换算：cfg.window 是月数，日频按 244 交易日/年折算
    const winUnits = cfg.window === 0 ? 0
      : (useDaily ? Math.round(cfg.window * 244 / 12) : cfg.window);
    const win = chanMode === 'exp' ? 0
      : (chanMode === 'quant' ? Math.max(winUnits, useDaily ? 1220 : 60) : winUnits);

    const band = rollingBand(ds, cfg.signal, win, useDaily ? 10 : 1);
    const val = band.val, mean = band.mean, sd = band.sd;
    const q10 = band.p10, q50 = band.p50, q90 = band.p90;

    const unit = { erp: 'pct', ratio: '×', dyspread: 'pct' }[cfg.signal];
    const name = { erp: '股权风险溢价 ERP', ratio: '股债收益比', dyspread: '股息率差' }[cfg.signal];
    const isQuant = chanMode === 'quant';

    // 通道几何。
    //  σ 口径：堆叠四层（透明基座 mean−2σ → 红/灰/绿三段），±1σ 点线勾轮廓
    //  分位口径：单层灰带 p10~p90 + p50 中线 + p10/p90 边界线
    const base = [], b1 = [], b2 = [], b3 = [], mLine = [];
    const lo1 = [], hi1 = [];
    for (let i = 0; i < N; i++) {
      if (isQuant) {
        base.push(q10[i]); b1.push(+((q90[i] || 0) - (q10[i] || 0)).toFixed(3));
        b2.push(null); b3.push(null); lo1.push(q10[i]); hi1.push(q90[i]); mLine.push(q50[i]);
        continue;
      }
      if (sd[i] == null || !isFinite(sd[i])) { base.push(null); b1.push(null); b2.push(null); b3.push(null); lo1.push(null); hi1.push(null); mLine.push(mean[i]); continue; }
      base.push(+(mean[i] - 2 * sd[i]).toFixed(3));
      b1.push(+(sd[i]).toFixed(3));
      b2.push(+(2 * sd[i]).toFixed(3));
      b3.push(+(sd[i]).toFixed(3));
      lo1.push(+(mean[i] - sd[i]).toFixed(3));
      hi1.push(+(mean[i] + sd[i]).toFixed(3));
      mLine.push(+mean[i].toFixed(3));
    }

    // 沪深300 点位（右轴）
    const px = ds.map((s) => (s.close == null ? null : Math.round(s.close)));
    const PX = '#b07d1a';
    // 20 日均线（仅 ERP 且有日频时叠加，用于展示平滑后的信号）
    const maLine = (useDaily && cfg.signal === 'erp')
      ? dser.map((s) => (s.erpMa20 == null ? null : +s.erpMa20.toFixed(3)))
      : null;

    const meanLabel = { roll: '滚动均值', exp: '累计均值', fix: '全样本均值', quant: 'P50 中位' }[chanMode];
    const footEl = document.getElementById('erp-foot');
    if (footEl) {
      footEl.innerHTML = isQuant
        ? '滚动 P10–P90 分位带：<i class="lg" style="background:rgba(142,151,166,.22)"></i>带内＝常态，<b>穿出带外</b>即历史极端（低 P10 偏贵 / 高 P90 偏便宜）'
        : (chanMode === 'fix'
          ? '<b style="color:var(--down)">⚠ 固定全样本口径含未来数据，仅用于复盘对照，不构成实盘信号</b>　｜　'
          : '通道相对' + meanLabel + '：') +
          (isQuant ? '' : '<i class="lg" style="background:rgba(18,160,92,.28)"></i>低于 −1σ（股票偏贵）<i class="lg" style="background:rgba(142,151,166,.22)"></i>±1σ 中性<i class="lg" style="background:rgba(209,54,45,.30)"></i>高于 +1σ（股票偏便宜）');
    }

    ensure('chart-erp').setOption({
      grid: gd({ left: 52, right: 62, top: 46, bottom: 56 }),
      tooltip: Object.assign({}, TIP, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: C.txt3, type: 'dashed' } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          let head = '<b>' + dDates[i] + '</b>';
          const stepTxt = useDaily ? '较前日' : '较前月';
          if (isQuant) {
            if (q90[i] == null) return head + '<br>样本不足';
            let pxTxt = '—';
            if (px[i] != null) pxTxt = px[i].toLocaleString('en-US');
            return head + '<br>' + name + '：<b>' + f.n2(val[i]) + ' ' + unit + '</b><br>' +
              'P10 / P50 / P90：' + f.n2(q10[i]) + ' / ' + f.n2(q50[i]) + ' / ' + f.n2(q90[i]) + '<br>' +
              (sd[i] ? 'Z-Score：<b>' + f.n2((val[i] - mean[i]) / sd[i]) + '</b><br>' : '') +
              '<span style="color:' + PX + '">沪深300</span>：' + pxTxt;
          }
          if (sd[i] == null || !isFinite(sd[i])) return head + '<br>样本不足';
          const z = (val[i] - mean[i]) / sd[i];
          let pxTxt = '—';
          if (px[i] != null) {
            const pm = (i > 0 && ds[i - 1].close) ? (ds[i].close / ds[i - 1].close - 1) : null;
            pxTxt = px[i].toLocaleString('en-US') +
              (pm == null ? '' : '　<span style="color:' + C.txt3 + '">' + stepTxt + ' ' + f.p(pm, 1) + '</span>');
          }
          return head + '<br>' +
            name + '：<b>' + f.n2(val[i]) + ' ' + unit + '</b><br>' +
            (useDaily && maLine && maLine[i] != null
              ? '20日均线：' + f.n2(maLine[i]) + '　' : '') +
            meanLabel + '：' + f.n2(mean[i]) + '　±1σ：' + f.n2(sd[i]) +
            (chanMode === 'fix' ? '　<span style="color:var(--down)">(含未来数据)</span>' : '') + '<br>' +
            'Z-Score：<b>' + f.n2(z) + '</b><br>' +
            '<span style="color:' + PX + '">沪深300</span>：' + pxTxt;
        },
      }),
      legend: Object.assign(LEGEND(), {
        data: maLine ? [name, '20日均线', meanLabel, '沪深300'] : [name, meanLabel, '沪深300'],
      }),
      xAxis: Object.assign({ type: 'category', data: dDates, boundaryGap: false }, AXIS()),
      yAxis: [
        Object.assign({ type: 'value', name: unit, scale: true, nameTextStyle: { color: C.txt3, fontSize: 11, padding: [0, 0, 0, -34] } }, AXIS()),
        Object.assign({}, AXIS(), {
          type: 'log', name: '沪深300', scale: true, position: 'right',
          nameTextStyle: { color: PX, fontSize: 11, padding: [0, 0, 0, 24] },
          splitLine: { show: false },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: PX, fontSize: 10, formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) },
        }),
      ],
      dataZoom: [
        { type: 'inside', throttle: 60 },
        {
          type: 'slider', height: NARROW ? 14 : 16, bottom: NARROW ? 6 : 8,
          borderColor: C.line, fillerColor: 'rgba(47,111,237,.10)',
          handleStyle: { color: C.bond }, textStyle: { color: C.txt3, fontSize: 10 },
        },
      ],
      series: [
        // 透明基准层：把堆叠起点抬到带底，否则第一段的填充会从 0 轴一路铺到底
        { name: 'base', type: 'line', stack: 'b', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(0,0,0,0)' }, data: base, silent: true, tooltip: { show: false } },
      ].concat(isQuant ? [
        { name: 'P10–P90 带', type: 'line', stack: 'b', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(142,151,166,.16)' }, data: b1, silent: true, tooltip: { show: false } },
      ] : [
        { name: '贵 −2σ~−1σ', type: 'line', stack: 'b', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(18,160,92,.16)' }, data: b1, silent: true, tooltip: { show: false } },
        { name: '中性 ±1σ', type: 'line', stack: 'b', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(142,151,166,.10)' }, data: b2, silent: true, tooltip: { show: false } },
        { name: '廉 +1σ~+2σ', type: 'line', stack: 'b', symbol: 'none', lineStyle: { width: 0 }, areaStyle: { color: 'rgba(209,54,45,.20)' }, data: b3, silent: true, tooltip: { show: false } },
      ]).concat([
        // ±1σ（或 P10/P90）边界：细点线勾出通道轮廓
        {
          name: isQuant ? 'P10' : '±1σ边界', type: 'line', symbol: 'none', z: 3, silent: true, tooltip: { show: false },
          lineStyle: { color: 'rgba(70,80,95,.45)', width: 1, type: 'dotted' },
          itemStyle: { color: 'rgba(70,80,95,.45)' }, data: lo1,
        },
        {
          name: isQuant ? 'P90' : '±1σ边界', type: 'line', symbol: 'none', z: 3, silent: true, tooltip: { show: false },
          lineStyle: { color: 'rgba(70,80,95,.45)', width: 1, type: 'dotted' },
          itemStyle: { color: 'rgba(70,80,95,.45)' }, data: hi1,
        },
        {
          name: name, type: 'line', symbol: 'none', z: 5,
          lineStyle: { color: C.stock, width: 2.2 }, itemStyle: { color: C.stock }, data: val,
        },
        {
          name: meanLabel, type: 'line', symbol: 'none', z: 4,
          lineStyle: { color: C.grey, width: 1.6, type: 'dashed' }, itemStyle: { color: C.grey }, data: mLine,
        },
        {
          name: '沪深300', type: 'line', symbol: 'none', z: 2, yAxisIndex: 1,
          lineStyle: { color: PX, width: 1.5, type: 'solid', opacity: .75 },
          itemStyle: { color: PX }, data: px, tooltip: { show: false },
        },
      ]).concat(maLine ? [
        {
          // 20 日均线＝仓位信号实际使用的平滑值，与原始 ERP 的差就是"噪声"
          name: '20日均线', type: 'line', symbol: 'none', z: 6,
          lineStyle: { color: '#1d3557', width: 1.9, opacity: .85 },
          itemStyle: { color: '#1d3557' }, data: maLine, tooltip: { show: false },
        },
      ] : []),
    }, true);
    rangeBar('chart-erp');
  }

  /* ---------------- 净值图：相对强弱 / 绝对净值 双视图 ----------------
   * 绝对净值跨度为 1→3.5，四条曲线挤在一起看不出差异；
   * 「相对沪深300」把每条曲线除以沪深300 净值，转成相对强弱百分比，纵轴跨度缩小一个量级。 */
  let navView = 'rel';
  let navCache = null;

  function navZoom() {
    const inst = charts['chart-nav'];
    if (!inst) return { start: 0, end: 100 };
    try {
      const dz = inst.getOption().dataZoom;
      if (dz && dz[0] && isFinite(dz[0].start)) return { start: dz[0].start, end: dz[0].end };
    } catch (e) { /* ignore */ }
    return { start: 0, end: 100 };
  }

  function drawNav() {
    if (!navCache) return;
    const bt = navCache.bt, dates = navCache.dates;
    const eq = bt.equity.navSeries;
    const rel = navView === 'rel';
    const items = [
      { name: 'ERP 动态轮动', nav: bt.strategy.navSeries, color: C.stock, w: 2.4, area: 'rgba(209,54,45,.10)', z: 5 },
      { name: '沪深300 基准', nav: bt.equity.navSeries, color: '#f0664f', w: 1.6, z: 3 },
      { name: '10年国债', nav: bt.bond.navSeries, color: C.bond, w: 1.6, z: 4 },
      { name: '60/40', nav: bt.mix6040.navSeries, color: C.purple, w: 1.6, type: 'dashed', z: 4 },
    ].filter((s) => s.nav && s.nav.length);

    const z = navZoom();

    ensure('chart-nav').setOption({
      grid: gd({ left: rel ? 58 : 54, right: 20, top: 46, bottom: 68 }),
      tooltip: Object.assign({}, TIP, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: C.txt3, type: 'dashed' } },
        formatter: (ps) => {
          return '<b>' + ps[0].name + '</b><br>' + ps.map((p) =>
            p.marker + '<span style="color:' + C.txt2 + '">' + p.seriesName + '</span>：<b>' +
            (rel ? (+p.value >= 0 ? '+' : '') + (+p.value).toFixed(1) + '%' : (+p.value).toFixed(3)) +
            '</b>').join('<br>');
        },
      }),
      legend: Object.assign(LEGEND(), { data: items.map((s) => s.name) }),
      xAxis: Object.assign({ type: 'category', data: dates, boundaryGap: false }, AXIS()),
      yAxis: Object.assign({}, AXIS(), rel
        ? {
          type: 'value', name: NARROW ? '相对' : '相对沪深300', scale: true,
          nameTextStyle: { color: C.txt3, fontSize: 11, padding: [0, 0, 0, NARROW ? -34 : -58] },
          axisLabel: { color: C.txt3, fontSize: NARROW ? 10 : 11, hideOverlap: true, formatter: (v) => (v > 0 ? '+' : '') + v + '%' },
        }
        : {
          type: 'log', name: '净值',
          nameTextStyle: { color: C.txt3, fontSize: 11, padding: [0, 0, 0, -34] },
        }),
      dataZoom: [
        { type: 'inside', zoomOnMouseWheel: 'shift', moveOnMouseWheel: false, moveOnMouseMove: false, start: z.start, end: z.end },
        {
          type: 'slider', height: 15, bottom: 22, start: z.start, end: z.end,
          borderColor: C.line, fillerColor: 'rgba(47,111,237,.07)',
          handleStyle: { color: '#fff', borderColor: C.txt3, borderWidth: 1 },
          moveHandleSize: 4, dataBackground: { lineStyle: { color: C.line }, areaStyle: { color: C.soft } },
          textStyle: { color: C.txt3, fontSize: 10 },
        },
      ],
      series: items.map((s) => ({
        name: s.name, type: 'line', symbol: 'none', z: s.z,
        lineStyle: { color: s.color, width: s.w, type: s.type || 'solid' },
        itemStyle: { color: s.color },
        areaStyle: (!rel && s.area) ? { color: s.area } : undefined,
        data: s.nav.map((v, i) => rel ? +(((v / eq[i]) - 1) * 100).toFixed(2) : +v.toFixed(4)),
        markLine: (rel && s.name === '沪深300 基准') ? {
          silent: true, symbol: 'none',
          label: { formatter: '沪深300 基准', color: C.txt3, fontSize: 10, position: 'insideEndTop' },
          lineStyle: { color: C.txt3, type: 'dashed', opacity: .6, width: 1 },
          data: [{ yAxis: 0 }],
        } : undefined,
      })),
    }, true);
    rangeBar('chart-nav');
  }

  // ---------------- 渲染: ERP 口径对照诊断 ----------------
  // 同一份数据、不同统计口径会得出差异很大的"当前位置"。这个面板把差异摊开，
  // 用来回答"为什么别人的图显示贴近均线、我们却在上轨"。
  const DIAG_WINS = [
    { v: 120, t: '近 10 年' }, { v: 84, t: '近 7 年' }, { v: 60, t: '近 5 年' },
    { v: 36, t: '近 3 年' }, { v: 24, t: '近 2 年' }, { v: 12, t: '近 1 年' },
    { v: 0, t: '全部历史（扩张）' },
  ];
  const DIAG_LAGS = [1, 2, 3, 6, 9, 12];
  let DIAG_EXT = null;   // 用户填入的外部读数

  function diagWinStat(v) {
    const N = series.length;
    const st = E.rollingStats(series, N - 1, v, cfg.signal);
    const arr = series.slice(v > 0 ? N - v : 0).map((r) => r[cfg.signal]).filter((x) => x != null);
    const below = arr.filter((x) => x <= st.value).length;
    return {
      mean: st.mean, sd: st.sd, val: st.value,
      z: st.sd ? (st.value - st.mean) / st.sd : NaN,
      pct: arr.length ? below / arr.length : NaN,
    };
  }

  function renderDiag() {
    if (!document.getElementById('diag-win')) return;
    const N = series.length, cur = series[N - 1];
    const unit = { erp: 'pct', ratio: '×', dyspread: 'pct' }[cfg.signal];
    const nm = { erp: '股权风险溢价 ERP', ratio: '股债收益比', dyspread: '股息率差' }[cfg.signal];
    const n2 = (x) => (isFinite(x) ? x.toFixed(2) : '—');
    const zc = (z) => (!isFinite(z) ? '' : z >= 1.5 ? 'hi' : z >= 0.5 ? 'mid' : z <= -1.5 ? 'lo' : z <= -0.5 ? 'lomid' : '');
    const zt = (z) => (isFinite(z) ? (z >= 0 ? '+' : '') + z.toFixed(2) : '—');

    // —— 顶部结论：讲清"最近这段时间发生了什么位移"
    const k6 = Math.min(6, N - 1), k12 = Math.min(12, N - 1);
    const p6 = series[N - 1 - k6], p12 = series[N - 1 - k12];
    const d6 = cur[cfg.signal] - p6[cfg.signal];
    const d12 = cur[cfg.signal] - p12[cfg.signal];
    const px6 = (cur.close && p6.close) ? (cur.close / p6.close - 1) : NaN;
    const px12 = (cur.close && p12.close) ? (cur.close / p12.close - 1) : NaN;
    document.getElementById('diag-note').innerHTML =
      '同一时点、同一指数，<b>换个统计口径就能差出 1 个 σ 以上</b>——这通常不是谁算错了，而是口径差异。' +
      '当前 ' + nm + ' <b>' + n2(cur[cfg.signal]) + ' ' + unit + '</b>；半年（' + p6.m + '）前 ' + n2(p6[cfg.signal]) +
      '、一年（' + p12.m + '）前 ' + n2(p12[cfg.signal]) + '，半年变动 <b>' + (d6 >= 0 ? '+' : '') + n2(d6) +
      '</b>、一年变动 <b>' + (d12 >= 0 ? '+' : '') + n2(d12) + '</b>；同期沪深300 ' + f.p(px6, 1) + ' / ' + f.p(px12, 1) +
      '。<br><b>所以：只要别人的图截止在几个月前，"贴近均线"就完全正常。</b>';

    // —— 表①：不同回看窗口
    let h = '<thead><tr><th>回看窗口</th><th>均值</th><th>σ</th><th>当前值</th><th>Z-Score</th><th>分位</th></tr></thead><tbody>';
    DIAG_WINS.forEach((w) => {
      const s = diagWinStat(w.v);
      const on = w.v === cfg.window;
      h += '<tr data-w="' + w.v + '" class="' + (on ? 'on' : '') + '"><td>' + w.t +
        (on ? '<span class="tag">当前</span>' : '') + '</td><td>' + n2(s.mean) + '</td><td>' + n2(s.sd) +
        '</td><td><b>' + n2(s.val) + '</b></td><td class="' + zc(s.z) + '"><b>' + zt(s.z) + '</b></td><td>' +
        (isFinite(s.pct) ? Math.round(s.pct * 100) + '%' : '—') + '</td></tr>';
    });
    document.getElementById('diag-win').innerHTML = h + '</tbody>';

    // —— 表②：若图截止在更早的月份
    let h2 = '<thead><tr><th>图截止在</th><th>当时读数</th><th>当时 10 年均值</th><th>当时 Z-Score</th></tr></thead><tbody>';
    DIAG_LAGS.forEach((k) => {
      const j = N - 1 - k;
      if (j < 130) return;
      const st = E.rollingStats(series, j, 120, cfg.signal);
      const z = st.sd ? (st.value - st.mean) / st.sd : NaN;
      h2 += '<tr><td>' + series[j].m + '（' + k + ' 个月前）</td><td><b>' + n2(st.value) +
        '</b></td><td>' + n2(st.mean) + '</td><td class="' + zc(z) + '"><b>' + zt(z) + '</b></td></tr>';
    });
    document.getElementById('diag-lag').innerHTML = h2 + '</tbody>';

    renderDiagOut();
  }

  function renderDiagOut() {
    const el = document.getElementById('diag-out');
    if (!el) return;
    if (DIAG_EXT == null || !isFinite(DIAG_EXT)) {
      el.innerHTML = '填入后可看到它在本站各口径下的位置，以及差异换算成 PE / 国债收益率的幅度。';
      return;
    }
    const v = DIAG_EXT, cur = series[series.length - 1];
    const d = v - cur[cfg.signal];
    const zt2 = (z) => (isFinite(z) ? (z >= 0 ? '+' : '') + z.toFixed(2) : '—');
    let s = '外部 <b>' + v.toFixed(2) + '</b>，比本站' + (d >= 0 ? '高 ' : '低 ') + '<b>' + Math.abs(d).toFixed(2) +
      '</b>。它在各窗口下的位置：' +
      DIAG_WINS.slice(0, 6).map((w) => {
        const st = diagWinStat(w.v);
        return w.t + ' <b>z=' + zt2((v - st.mean) / st.sd) + '</b>';
      }).join('　·　');
    if (cfg.signal === 'erp') {
      const y10 = cur.y10, ep = cur.ep;
      const y10b = y10 - d, peb = 100 / (ep + d);
      s += '<br>差异来源换算：若全部来自国债收益率口径 → 对方 Y10 ≈ <b>' + y10b.toFixed(2) + '%</b>（本站 ' +
        y10.toFixed(2) + '%）；若全部来自估值口径 → 对方 PE ≈ <b>' + peb.toFixed(2) + '</b>（本站 ' +
        cur.pe.toFixed(2) + '，' + (peb / cur.pe - 1 >= 0 ? '+' : '') + ((peb / cur.pe - 1) * 100).toFixed(1) + '%）';
    }
    el.innerHTML = s;
  }

  // ---------------- 渲染: 回测 ----------------
  function renderBacktest(bt) {
    const dates = bt.dates;
    const rows = [
      ['ERP 动态轮动', bt.strategy, C.stock, true],
      ['沪深300 全仓（含股息）', bt.equity, '#f0664f', false],
      ['10年期国债全仓', bt.bond, C.bond, false],
      ['60/40 股债再平衡', bt.mix6040, C.purple, false],
    ];
    const tb = document.querySelector('#t-perf tbody');
    tb.innerHTML = rows.map((r) => {
      const m = r[1];
      if (!m) return '';
      const cls = (v) => v >= 0 ? 'pos' : 'neg';
      return '<tr class="' + (r[3] ? 'hl' : '') + '">' +
        '<td><i class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + r[2] + ';margin-right:7px"></i>' + r[0] + '</td>' +
        '<td class="num ' + cls(m.ann) + '">' + f.p(m.ann, 2) + '</td>' +
        '<td class="num">' + f.p(m.vol, 2) + '</td>' +
        '<td class="num">' + f.n2(m.sharpe) + '</td>' +
        '<td class="num neg">' + f.p(m.maxDD, 2) + '</td>' +
        '<td class="num">' + f.n2(m.calmar) + '</td>' +
        '<td class="num">' + f.p(m.winRate, 1) + '</td>' +
        '<td class="num">' + f.n2(m.navSeries[m.navSeries.length - 1]) + '</td>' +
        '</tr>';
    }).join('');

    document.getElementById('bt-note').innerHTML =
      '回测区间 <b>' + dates[0] + ' ~ ' + dates[dates.length - 1] + '</b>（' + dates.length + ' 个月）｜' +
      '平均单次调仓幅度 <b>' + f.p(bt.avgTurnover, 2) + '</b>｜累计交易成本 <b>' + f.p(bt.costTotal, 2) + '</b>｜' +
      '夏普分母的无风险利率取区间均值 <b>' + f.p(bt.rf, 2) + '</b>。';

    // 净值曲线（抽成独立函数，支持「相对强弱 / 净值」两种视图）
    navCache = { bt: bt, dates: dates };
    drawNav();

    // 仓位曲线
    ensure('chart-alloc').setOption({
      grid: gd({ left: 52, right: 20, top: 46, bottom: 52 }),
      tooltip: Object.assign({}, TIP, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: C.txt3, type: 'dashed' } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          return '<b>' + dates[i] + '</b><br>股票仓位：<b>' + f.n1(bt.weights[i] * 100) + '%</b><br>' +
            '债券仓位：' + f.n1((1 - bt.weights[i]) * 100) + '%<br>' +
            '<span style="color:' + C.txt3 + '">本期调仓幅度 ' + f.p(bt.turnover[i], 2) + '</span>';
        },
      }),
      legend: Object.assign(LEGEND(), { data: ['股票仓位'] }),
      xAxis: Object.assign({ type: 'category', data: dates, boundaryGap: false }, AXIS()),
      yAxis: Object.assign({ type: 'value', name: '%', min: 0, max: 100, nameTextStyle: { color: C.txt3, fontSize: 11, padding: [0, 0, 0, -34] } }, AXIS()),
      dataZoom: [
        { type: 'inside', throttle: 60 },
        {
          type: 'slider', height: NARROW ? 14 : 16, bottom: NARROW ? 6 : 8,
          borderColor: C.line, fillerColor: 'rgba(47,111,237,.10)',
          handleStyle: { color: C.bond }, textStyle: { color: C.txt3, fontSize: 10 },
        },
      ],
      series: [{
        name: '股票仓位', type: 'line', symbol: 'none', step: 'end',
        lineStyle: { color: C.stock, width: 1.8 }, itemStyle: { color: C.stock },
        areaStyle: { color: 'rgba(209,54,45,.14)' },
        data: bt.weights.map((w) => +(w * 100).toFixed(1)),
      }],
    }, true);
    rangeBar('chart-alloc');
  }

  // ---------------- 渲染: 情景矩阵 ----------------
  function renderMatrix() {
    const peSteps = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];
    const bpSteps = [-60, -40, -20, 0, 20, 40, 60];
    const sc = E.scenarios(series, cfg, peSteps, bpSteps);
    const curPe = series[series.length - 1].pe;
    const curY = series[series.length - 1].y10;
    const unit = { erp: 'pct', ratio: '×', dyspread: 'pct' }[cfg.signal];

    let html = '<thead><tr><th>PE \\ ΔY10</th>';
    bpSteps.forEach((bp) => {
      html += '<th>' + (bp > 0 ? '+' : '') + bp + 'bp<br><span style="font-weight:400;color:#8e97a6">Y10 ' +
        (curY + bp / 100).toFixed(2) + '%</span></th>';
    });
    html += '</tr></thead><tbody>';

    sc.forEach((row) => {
      const isBase = Math.abs(row.dPe) < 1e-9;
      html += '<tr><td class="rowlab"' + (isBase ? ' style="background:#fff0ef;color:#d1362d"' : '') + '>PE ' +
        (row.dPe > 0 ? '+' : '') + (row.dPe * 100) + '%<br><span style="font-weight:400;font-size:11px">' +
        (curPe * (1 + row.dPe)).toFixed(1) + '</span></td>';
      row.cells.forEach((c) => {
        const t = E.clamp((c.pct - 0.15) / 0.7, 0, 1);
        const alpha = (0.05 + 0.22 * t).toFixed(3);
        const isNow = isBase && c.bp === 0;
        html += '<td style="background:rgba(209,54,45,' + alpha + ');color:' + (t > 0.55 ? '#fff' : '#1b1f27') +
          (isNow ? ';outline:2px solid #d1362d' : '') + '">' +
          '<div class="mx-val">' + f.n2(c.value) + '</div>' +
          '<div class="mx-w">股票 ' + Math.round(c.weight * 100) + '%</div>' +
          '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    document.getElementById('t-matrix').innerHTML = html;
  }

  // ---------------- 渲染: 买卖信号 ----------------
  /* 三档仓位规则（对照回测见 scripts/freq_test2.js 的 S2，年化 9.12%/夏普 0.70/回撤 −18.6%）：
   *   ▲ 买入：ERP 分位 ≥ 60%（估值给方向就动手，不等趋势转身，否则踏空底部第一段）
   *   ▽ 减半：分位 ≤ 50%，或 分位 ≤ 65% 且（跌破 60 日线 / 成交量天量 >1.5σ）—— 趋势或情绪预警先降风险
   *   ▼ 清仓：分位 ≤ 30%
   *   ▲ 加满：减半后估值修复（分位 >65% 或回到 50% 上方且趋势修复）即恢复满仓
   * 评估频率与仓位建议/回测一致：月末出信号，次月执行。 */
  function renderSignals() {
    const sigs = E.tierSignals(series, cfg);
    const segs = E.tierHoldings(series, sigs);

    const ds = HAS_DAILY ? dser : series;
    const dates = ds.map((s) => s.d || s.date || s.m);
    const px = ds.map((s) => (s.close == null ? null : Math.round(s.close)));
    const ma60 = HAS_DAILY
      ? dser.map((s) => (s.closeMa60 == null ? null : +s.closeMa60.toFixed(1)))
      : null;
    const vol = ds.map((s) => (s.vol == null ? null : s.vol));
    const vz = ds.map((s) => (s.volZ == null ? null : +s.volZ.toFixed(2)));

    const idxOfMonth = {};
    ds.forEach((s, i) => { idxOfMonth[s.m] = i; });

    const PX = '#b07d1a', BUY = C.stock, SELL = '#12a05c';
    const SIG_TXT = {
      buy: { s: '▲', t: '买入', c: BUY },
      add: { s: '▲', t: '加满', c: BUY },
      reduce: { s: '▽', t: '减半', c: SELL },
      sell: { s: '▼', t: '清仓', c: SELL },
    };
    // 信号点用独立 scatter 序列承载（markPoint 不支持 labelLayout，密集区标签会叠成一团）
    const markData = [];
    sigs.forEach((s) => {
      const i = idxOfMonth[s.m];
      if (i == null || px[i] == null) return;
      const info = SIG_TXT[s.type];
      const up = s.type === 'buy' || s.type === 'add';
      markData.push({
        value: [dates[i], px[i]],
        symbolRotate: up ? 0 : 180,
        symbolOffset: up ? [0, -11] : [0, 11],
        itemStyle: { color: info.c, borderColor: '#fff', borderWidth: 1, opacity: s.type === 'add' || s.type === 'reduce' ? 0.75 : 1 },
        label: {
          show: true, position: up ? 'top' : 'bottom', distance: 5,
          formatter: info.t + ' ' + s.m.slice(2),
          color: info.c, fontSize: NARROW ? 9 : 10, fontWeight: 600,
        },
      });
    });

    // ---- 图：上格价格 + 买卖点，下格成交量与情绪 z ----
    const g0 = { left: 52, right: 62, top: 44, height: '55%' };
    const g1 = { left: 52, right: 62, top: '69%', height: '13%' };
    if (NARROW) {
      g0.left = 44; g0.right = 46; g0.top = 40;
      g1.left = 44; g1.right = 46; g1.top = '68%';
    }

    ensure('chart-signal').setOption({
      grid: [g0, g1],
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#3a4352' } },
      tooltip: Object.assign({}, TIP, {
        trigger: 'axis',
        formatter: (ps) => {
          if (!ps.length) return '';
          const i = ps[0].dataIndex;
          const s = sigs.filter((x) => idxOfMonth[x.m] === i)[0];
          const prev = i > 0 ? ds[i - 1].close : null;
          const chg = (prev && ds[i].close) ? ds[i].close / prev - 1 : null;
          let t = '<b>' + dates[i] + '</b><br>' +
            '<span style="color:' + PX + '">沪深300</span>：' + (px[i] == null ? '—' : px[i].toLocaleString('en-US')) +
            (chg == null ? '' : '　<span style="color:' + (chg >= 0 ? C.stock : '#12a05c') + '">' + f.p(chg, 2) + '</span>') +
            '<br><span style="color:' + C.txt3 + '">ERP</span>：' + f.n2(ds[i].erp) + ' pct' +
            '　<span style="color:' + C.txt3 + '">PE</span>：' + f.n2(ds[i].pe);
          if (ma60 && ma60[i] != null) t += '<br>60 日线：' + f.n1(ma60[i]);
          if (vol[i] != null) {
            t += '<br>成交量：' + f.n1(vol[i]) + ' 亿股' +
              (vz[i] == null ? '' : '　情绪 σ ' + (vz[i] > 0 ? '+' : '') + f.n2(vz[i]));
          }
          if (s) {
            const info = SIG_TXT[s.type];
            const lvTxt = s.level === 1 ? '股票 100%' : (s.level === 0.5 ? '股票 50%' : '空仓');
            t += '<br><b style="color:' + info.c + '">' + info.s + ' ' + info.t + '信号</b>　分位 ' +
              f.n1(s.pct * 100) + '%　→ ' + lvTxt;
          }
          return t;
        },
      }),
      legend: Object.assign(LEGEND(), {
        data: ['沪深300', '60日线', '成交量', '成交量情绪 σ'],
      }),
      xAxis: [
        Object.assign({ type: 'category', data: dates, boundaryGap: false, gridIndex: 0, axisLabel: { show: false } }, AXIS()),
        Object.assign({ type: 'category', data: dates, boundaryGap: false, gridIndex: 1 }, AXIS()),
      ],
      yAxis: [
        Object.assign({}, AXIS(), {
          type: 'log', name: '', scale: true, gridIndex: 0,
          axisLabel: { color: PX, fontSize: 10, formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) },
          splitLine: { lineStyle: { color: C.soft } },
        }),
        Object.assign({}, AXIS(), {
          type: 'value', name: '亿股', gridIndex: 1, scale: true,
          nameTextStyle: { color: C.txt3, fontSize: 10, padding: [0, 0, 0, -30] },
          axisLabel: { color: C.txt3, fontSize: 9, showMinLabel: false },
          splitLine: { show: false },
        }),
        Object.assign({}, AXIS(), {
          type: 'value', name: '', gridIndex: 1, position: 'right',
          axisLabel: { color: C.purple, fontSize: 9 },
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        }),
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], throttle: 60 },
        {
          type: 'slider', xAxisIndex: [0, 1], height: NARROW ? 14 : 16, bottom: NARROW ? 6 : 8,
          borderColor: C.line, fillerColor: 'rgba(47,111,237,.10)',
          handleStyle: { color: C.bond }, textStyle: { color: C.txt3, fontSize: 10 },
        },
      ],
      series: [
        {
          name: '沪深300', type: 'line', xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', z: 5,
          lineStyle: { color: PX, width: 1.7 }, itemStyle: { color: PX }, data: px,
        },
        {
          name: '信号', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, z: 9,
          symbol: 'triangle', symbolSize: NARROW ? 10 : 12,
          data: markData, tooltip: { show: false },
          labelLayout: { hideOverlap: true },
        },
        ma60 ? {
          name: '60日线', type: 'line', xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', z: 4,
          lineStyle: { color: 'rgba(70,80,95,.55)', width: 1.2, type: 'dashed' },
          itemStyle: { color: 'rgba(70,80,95,.55)' }, data: ma60, tooltip: { show: false },
        } : { name: '60日线', type: 'line', data: [] },
        {
          name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
          itemStyle: { color: 'rgba(47,111,237,.28)' },
          data: vol, tooltip: { show: false }, barMaxWidth: 6,
        },
        {
          name: '成交量情绪 σ', type: 'line', xAxisIndex: 1, yAxisIndex: 2, symbol: 'none', z: 6,
          lineStyle: { color: C.purple, width: 1.4 }, itemStyle: { color: C.purple },
          data: vz, tooltip: { show: false },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: 'rgba(123,82,201,.35)', width: 1, type: 'dotted' },
            label: { show: false },
            data: [{ yAxis: 0 }, { yAxis: 2 }, { yAxis: -2 }],
          },
        },
      ],
    }, true);
    rangeBar('chart-signal');

    // ---- 表：信号明细（新→旧）----
    let h = '<thead><tr><th>评估日</th><th>信号</th><th>信号后仓位</th><th>收盘</th><th>ERP</th>' +
      '<th>信号分位</th><th>成交量 σ</th><th>后 6 个月</th><th>后 12 个月</th></tr></thead><tbody>';
    sigs.slice().reverse().forEach((s) => {
      const info = SIG_TXT[s.type];
      const lvTxt = s.level === 1 ? '满仓' : (s.level === 0.5 ? '半仓' : '空仓');
      h += '<tr><td>' + s.m + '</td>' +
        '<td class="' + (info.c === BUY ? 'pos' : 'neg') + '"><b>' + info.s + ' ' + info.t + '</b></td>' +
        '<td>' + lvTxt + '</td>' +
        '<td class="num">' + (s.close == null ? '—' : Math.round(s.close).toLocaleString('en-US')) + '</td>' +
        '<td class="num">' + f.n2(s.erp) + '</td>' +
        '<td class="num">' + f.n1(s.pct * 100) + '%</td>' +
        '<td class="num">' + (s.volZ == null ? '—' : (s.volZ > 0 ? '+' : '') + f.n2(s.volZ)) + '</td>' +
        '<td class="num ' + (s.fwd6 == null ? '' : (s.fwd6 >= 0 ? 'pos' : 'neg')) + '">' +
        (s.fwd6 == null ? '—' : f.sign(s.fwd6)) + '</td>' +
        '<td class="num ' + (s.fwd12 == null ? '' : (s.fwd12 >= 0 ? 'pos' : 'neg')) + '">' +
        (s.fwd12 == null ? '—' : f.sign(s.fwd12)) + '</td></tr>';
    });
    if (!sigs.length) {
      h += '<tr><td colspan="9" style="text-align:center;color:#8e97a6">当前参数下没有触发任何信号</td></tr>';
    }
    document.getElementById('t-signal').innerHTML = h + '</tbody>';

    // ---- 脚注：规则 + 段统计 + 当前状态 ----
    const curLv = sigs.length ? sigs[sigs.length - 1].level : 0;
    const curLvTxt = curLv === 1
      ? '<b style="color:' + BUY + '">满仓持有</b>'
      : (curLv === 0.5 ? '<b style="color:' + C.amber + '">半仓持有</b>' : '<b style="color:' + SELL + '">空仓</b>');
    const stateTxt = sigs.length
      ? curLvTxt + '（' + sigs[sigs.length - 1].m + ' 之后）'
      : '无信号';
    const closed = segs.filter((x) => !x.open);
    const avgRet = closed.length ? E.mean(closed.map((x) => x.ret)) : NaN;
    const winRate = closed.length ? closed.filter((x) => x.ret > 0).length / closed.length : NaN;

    document.getElementById('sig-foot').innerHTML =
      '<b style="color:' + BUY + '">▲ 买入</b>：分位 ≥ 60% 满仓　' +
      '<b style="color:' + SELL + '">▽ 减半</b>：分位 ≤ 50%，或 ≤ 65% 且跌破 60 日线 / 成交量 &gt;1.5σ　' +
      '<b style="color:' + SELL + '">▼ 清仓</b>：分位 ≤ 30%　' +
      '｜　当前状态：' + stateTxt +
      '<br>已平仓 ' + closed.length + ' 轮完整持仓（按实际档位加权）：平均 ' +
      (closed.length ? f.n1(E.mean(closed.map((x) => x.months))) + ' 个月、' : '— ') +
      '轮均收益 <b>' + (isFinite(avgRet) ? f.sign(avgRet) : '—') + '</b>、胜率 ' +
      (isFinite(winRate) ? f.p(winRate, 0) : '—') +
      '　｜　下方成交量情绪＝20 日对数成交量 z-score，&gt;+1.5σ 天量参与减半预警，−2σ 以下多为地量';
  }

  // ---------------- 主渲染 ----------------
  function render() {
    syncLabels();
    const snap = E.currentSnapshot(series, cfg);
    const fw = E.forwardReturns(series, cfg, 12);
    const bt = E.backtest(series, cfg);
    renderKPI(snap);
    renderFreshness(snap);
    renderVerdict(snap, fw);
    renderYield();
    renderERP();
    renderSignals();
    renderDiag();
    renderBacktest(bt);
    renderMatrix();
  }

  // ---------------- 启动 ----------------
  document.getElementById('stale-close').addEventListener('click', () => {
    document.getElementById('stale-bar').className = 'stale-bar hidden';
  });

  initControls();
  syncAll();
  render();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    Object.keys(charts).forEach((k) => charts[k].resize());
    // 跨越桌面/手机断点（旋转屏幕、改窗口宽度）时，重算图表留白与字号
    const narrow = window.innerWidth <= 720;
    if (narrow !== NARROW) {
      NARROW = narrow;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        render();
        Object.keys(charts).forEach((k) => charts[k].resize());
      }, 140);
    }
  });
})();
