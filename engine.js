/* ============================================================
 * EquiBond Engine  ——  股债性价比 / 股权风险溢价 计算核心
 * 纯函数，无 DOM 依赖，可在 Node 中直接做单元测试
 *
 * 模型主线：
 *   1) 股票端的"投资回报"用盈利收益率代理:  E/P = 100 / PE(TTM)
 *   2) 债券端的"利息"用无风险利率代理:      Y10 = 10年期国债到期收益率
 *   3) 二者之差即股权风险溢价 ERP = E/P - Y10
 *      差值越大 => 股票相对债券越便宜 => 越应该超配股票
 *   4) 用历史分位 / Z-Score 把 ERP 标准化，再映射到股票仓位
 *   5) 用 signal(t-1) 决定 t 月仓位，杜绝未来函数，回测净值
 * ============================================================ */
(function (global) {
  'use strict';

  // ---------------- 基础统计工具 ----------------
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function mean(a) {
    if (!a.length) return NaN;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function stdev(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  /** 样本中 <= x 的占比，返回 0~1 */
  function percentileRank(sample, x) {
    let c = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] <= x) c++;
    return c / sample.length;
  }

  /** 修正久期（付息债券，半年付息，面值附近）
   *  Macaulay D = (1+i)/i * (1 - (1+i)^-n)，再除以 (1+i) 得修正久期 */
  function modDuration(yieldPct) {
    const N = 10, m = 2, n = N * m;
    const y = yieldPct / 100;
    if (y <= 1e-6) return N;
    const i = y / m;
    const dPeriods = ((1 + i) / i) * (1 - Math.pow(1 + i, -n));
    return dPeriods / (1 + i) / m;
  }

  // ---------------- 面板构建 ----------------
  /**
   * 把 dataset.rows 转成带派生指标 + 月度收益的序列
   * @param {Array} rows 原始行（含 ok 标记）
   * @returns {Array} 仅含可用月份的对象数组，升序
   */
  function buildSeries(rows, smoothMap) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.ok) continue;

      const prev = rows[i - 1];
      const ep = 100 / r.pe;
      const rec = {
        m: r.m,
        date: r.d,
        pe: r.pe,
        pb: r.pb,
        div: r.div,
        close: r.close,
        y10: r.y10,
        y1: r.y1,
        y30: r.y30,
        ep: ep,
        erp: ep - r.y10,
        ratio: ep / r.y10,
        dyspread: r.div - r.y10,
        erpS: null,
        ratioS: null,
        retEq: null,
        retEqPrice: null,
        retBd: null,
      };

      // --- 日频平滑信号回灌（20 日均线在月末的取值）---
      if (smoothMap) {
        const sm = smoothMap[r.m];
        if (sm) {
          rec.erpS = sm.erpS;
          rec.ratioS = sm.ratioS;
          rec.smoothDate = sm.d;
          rec.ma60 = sm.ma60 == null ? null : sm.ma60;   // 60 日线（趋势确认用）
          rec.vol = sm.vol == null ? null : sm.vol;
          rec.volZ = sm.volZ == null ? null : sm.volZ;
        }
      }

      // --- 股票端月度收益: 价格收益 + 股息再投近似 ---
      if (prev && prev.close != null) {
        rec.retEqPrice = r.close / prev.close - 1;
        const divPrev = prev.div != null ? prev.div : 0;
        rec.retEq = rec.retEqPrice + divPrev / 100 / 12;
      }

      // --- 债券端月度收益: 票息 carry + 久期驱动的价格损益 ---
      // 用久期近似把 10 年期收益率序列合成"固定期限国债总收益指数"
      if (r.y10 != null) {
        if (prev && prev.y10 != null) {
          const D = modDuration(prev.y10);
          const carry = prev.y10 / 100 / 12;
          const dy = (r.y10 - prev.y10) / 100;
          rec.retBd = carry - D * dy;
        } else {
          // 首月无上月收益率，只计 carry
          rec.retBd = r.y10 / 100 / 12;
        }
      }
      out.push(rec);
    }
    return out;
  }

  // ---------------- 日频面板 ----------------
  /**
   * dataset.daily（紧凑数组 [[d,pe,y10,close],...]）→ 对象数组
   * @param {Array} daily
   * @returns {Array} 升序，含 ep / erp / ratio
   */
  function buildDaily(daily) {
    const out = [];
    if (!daily || !daily.length) return out;
    for (let i = 0; i < daily.length; i++) {
      const r = daily[i];
      const pe = r[1], y10 = r[2];
      if (!(pe > 0) || y10 == null) continue;
      const ep = 100 / pe;
      out.push({
        d: r[0],
        m: String(r[0]).slice(0, 7),
        pe: pe,
        y10: y10,
        close: r[3],
        vol: (r[4] == null ? null : r[4]),   // 成交量（亿股），可选
        ep: ep,
        erp: ep - y10,
        ratio: ep / y10,
      });
    }
    return out;
  }

  /**
   * 原地计算简单移动平均，结果写到 series[i][outKey]
   * 用于给日频 ERP 去噪（20 日 ≈ 一个月，刚好把月度信号"摊平"成日频形态）
   */
  function moveAvg(series, key, n, outKey) {
    const k = outKey || (key + 'Ma' + n);
    const buf = [];
    let sum = 0, cnt = 0;
    for (let i = 0; i < series.length; i++) {
      const v = series[i][key];
      buf.push(v);
      if (v != null && isFinite(v)) { sum += v; cnt++; }
      if (buf.length > n) {
        const o = buf.shift();
        if (o != null && isFinite(o)) { sum -= o; cnt--; }
      }
      series[i][k] = cnt >= n ? sum / cnt : null;
    }
    return series;
  }

  /**
   * 成交量情绪：对 log(成交量) 做 rolling 均值/标准差，输出 z-score
   * 正值＝近期放量（情绪升温），负值＝缩量（观望/地量）
   * @param {Array} series 日频面板
   * @param {number} n 窗口交易日数，默认 20
   */
  function volZ(series, n) {
    n = n || 20;
    const buf = [];
    let s1 = 0, s2 = 0, c = 0;
    for (let i = 0; i < series.length; i++) {
      const v = series[i].vol;
      const lv = (v != null && v > 0) ? Math.log(v) : null;
      buf.push(lv);
      if (lv != null) { s1 += lv; s2 += lv * lv; c++; }
      if (buf.length > n) {
        const o = buf.shift();
        if (o != null) { s1 -= o; s2 -= o * o; c--; }
      }
      series[i].volMa = c ? Math.exp(s1 / c) : null;   // 窗口内日均成交量（亿股）
      if (c >= Math.max(5, Math.floor(n * 0.8))) {
        const m = s1 / c;
        const sd = Math.sqrt(Math.max(0, s2 / c - m * m) * c / Math.max(1, c - 1));
        series[i].volZ = sd > 0 ? (lv - m) / sd : null;
      } else {
        series[i].volZ = null;
      }
    }
    return series;
  }

  /**
   * 取每月最后一个交易日的（原始值 + 平滑值），回灌到月度面板做信号
   * @returns {Object} { 'YYYY-MM': { d, erp, erpS, ratio, ratioS } }
   */
  function monthlySmooth(dailySeries) {
    const byM = {};
    for (let i = 0; i < dailySeries.length; i++) {
      byM[dailySeries[i].m] = dailySeries[i];
    }
    const out = {};
    Object.keys(byM).forEach(function (m) {
      const r = byM[m];
      out[m] = {
        d: r.d,
        erp: r.erp,
        erpS: r.erpMa20 != null ? r.erpMa20 : r.erp,   // 序列开头不足 20 日时回退原值
        ratio: r.ratio,
        ratioS: r.ratioMa20 != null ? r.ratioMa20 : r.ratio,
        close: r.close,
        ma60: r.closeMa60 != null ? r.closeMa60 : null,
        vol: r.vol,
        volZ: r.volZ != null ? r.volZ : null,
      };
    });
    return out;
  }

  /**
   * 日频滚动通道（均值 / 标准差），滑动窗口 O(n)
   * @param {number} window 交易日数（0 = 扩张窗口）
   */
  function rollingChannel(series, key, window) {
    const n = series.length;
    const mu = new Array(n), sd = new Array(n);
    const q = [];
    let sum = 0, sum2 = 0, cnt = 0;
    const W = window > 0 ? window : n;
    for (let i = 0; i < n; i++) {
      const v = series[i][key];
      q.push(v);
      if (v != null && isFinite(v)) { sum += v; sum2 += v * v; cnt++; }
      if (q.length > W) {
        const o = q.shift();
        if (o != null && isFinite(o)) { sum -= o; sum2 -= o * o; cnt--; }
      }
      if (cnt >= Math.min(W, 20)) {
        const m = sum / cnt;
        const varr = Math.max(0, sum2 / cnt - m * m) * cnt / Math.max(1, cnt - 1);
        mu[i] = m;
        sd[i] = Math.sqrt(varr);
      } else {
        mu[i] = null;
        sd[i] = null;
      }
    }
    return { mean: mu, sd: sd };
  }

  /** 平滑口径下实际使用的信号字段名（dyspread 无日频股息率，保持原始） */
  function signalKey(cfg) {
    if (!cfg || !cfg.smooth) return cfg.signal;
    if (cfg.signal === 'erp') return 'erpS';
    if (cfg.signal === 'ratio') return 'ratioS';
    return cfg.signal;
  }

  // ---------------- 滚动统计 ----------------
  /**
   * @param {Array} series 面板
   * @param {number} i 当前位置
   * @param {number} window 回看月数，0 = 全部历史（扩张窗口）
   * @param {string} key 信号字段 erp / ratio / dyspread
   */
  function rollingStats(series, i, window, key) {
    const start = window > 0 ? Math.max(0, i - window + 1) : 0;
    const sample = [];
    for (let k = start; k <= i; k++) {
      const v = series[k][key];
      if (v != null && isFinite(v)) sample.push(v);
    }
    const x = series[i][key];
    const mu = mean(sample);
    const sd = stdev(sample);
    return {
      n: sample.length,
      value: x,
      mean: mu,
      sd: sd,
      pct: percentileRank(sample, x),
      z: sd > 0 ? (x - mu) / sd : NaN,
      min: Math.min.apply(null, sample),
      max: Math.max.apply(null, sample),
      p10: quantile(sample, 0.1),
      p25: quantile(sample, 0.25),
      p50: quantile(sample, 0.5),
      p75: quantile(sample, 0.75),
      p90: quantile(sample, 0.9),
    };
  }

  function quantile(sample, q) {
    if (!sample.length) return NaN;
    const a = sample.slice().sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  // ---------------- 仓位映射 ----------------
  /**
   * @param {number} p 历史分位 0~1
   * @param {number} z Z-Score
   * @param {object} cfg { map:'pct'|'z', minW, maxW, zRange }
   * @returns {number} 股票仓位 0~1
   */
  function equityWeight(p, z, cfg) {
    let t;
    if (cfg.map === 'pct') {
      t = clamp(p, 0, 1);
    } else {
      const zr = cfg.zRange || 2;
      t = (clamp(z, -zr, zr) + zr) / (2 * zr);
      t = clamp(t, 0, 1);
    }
    return clamp(cfg.minW + (cfg.maxW - cfg.minW) * t, 0, 1);
  }

  // ---------------- 绩效指标 ----------------
  function perfMetrics(rets, rfAnnual) {
    const n = rets.length;
    if (!n) return null;
    let nav = 1, peak = 1, maxDD = 0, win = 0;
    const navSeries = [1];
    for (let i = 0; i < n; i++) {
      nav *= 1 + rets[i];
      navSeries.push(nav);
      if (nav > peak) peak = nav;
      const dd = nav / peak - 1;
      if (dd < maxDD) maxDD = dd;
      if (rets[i] > 0) win++;
    }
    const years = n / 12;
    const ann = Math.pow(nav, 1 / years) - 1;
    const vol = stdev(rets) * Math.sqrt(12);
    const rf = rfAnnual || 0;
    return {
      total: nav - 1,
      ann: ann,
      vol: vol,
      sharpe: vol > 0 ? (ann - rf) / vol : NaN,
      maxDD: maxDD,
      calmar: maxDD < 0 ? ann / Math.abs(maxDD) : NaN,
      winRate: win / n,
      navSeries: navSeries,
    };
  }

  // ---------------- 回测 ----------------
  /**
   * 信号 t-1 -> 仓位 t -> 收益 t，月度再平衡
   * @param {Array} series 面板
   * @param {object} cfg {
   *   signal:'erp'|'ratio'|'dyspread', window, map, minW, maxW, zRange,
   *   startIdx, rebalance:1|3, costBp
   * }
   */
  function backtest(series, cfg) {
    const startIdx = cfg.startIdx || 0;
    const key = signalKey(cfg);
    const rets = [], weights = [], dates = [], turnover = [];
    let nav = 1, w = null, prevW = null, costAcc = 0;

    for (let i = startIdx; i < series.length; i++) {
      const r = series[i];
      if (r.retEq == null || r.retBd == null) continue;

      if (w === null) {
        // 首期用当前信号建仓
        const st = rollingStats(series, i, cfg.window, key);
        w = equityWeight(st.pct, st.z, cfg);
      } else if ((i - startIdx) % (cfg.rebalance || 1) === 0) {
        // 调仓日：用上一期观测到的信号
        const st = rollingStats(series, i - 1, cfg.window, key);
        w = equityWeight(st.pct, st.z, cfg);
      }

      const turn = prevW === null ? Math.abs(w) : Math.abs(w - prevW);
      const cost = turn * (cfg.costBp || 0) / 10000;
      costAcc += cost;

      const ret = w * r.retEq + (1 - w) * r.retBd - cost;
      nav *= 1 + ret;

      rets.push(ret);
      weights.push(w);
      dates.push(r.m);
      turnover.push(turn);
      prevW = w;
    }

    // 对照组
    const eqRets = [], bdRets = [], mixRets = [];
    for (let i = startIdx; i < series.length; i++) {
      const r = series[i];
      if (r.retEq == null || r.retBd == null) continue;
      eqRets.push(r.retEq);
      bdRets.push(r.retBd);
      mixRets.push(0.6 * r.retEq + 0.4 * r.retBd);
    }

    let rfSum = 0, rfCnt = 0;
    for (let i = startIdx; i < series.length; i++) {
      if (series[i].y10 != null) { rfSum += series[i].y10; rfCnt++; }
    }
    const rf = rfCnt ? rfSum / rfCnt / 100 : 0;

    return {
      dates: dates,
      weights: weights,
      turnover: turnover,
      costTotal: costAcc,
      strategy: perfMetrics(rets, rf),
      equity: perfMetrics(eqRets, rf),
      bond: perfMetrics(bdRets, rf),
      mix6040: perfMetrics(mixRets, rf),
      rf: rf,
      avgTurnover: turnover.length ? mean(turnover) : 0,
    };
  }

  // ---------------- 当前读数快照 ----------------
  function currentSnapshot(series, cfg) {
    const i = series.length - 1;
    if (i < 0) return null;
    const r = series[i];
    const key = signalKey(cfg);
    const keys = ['erp', 'ratio', 'dyspread'];
    const stats = {};
    keys.forEach((k) => { stats[k] = rollingStats(series, i, cfg.window, k); });

    // 平滑口径：仓位建议用它，避免被单日跳动带跑
    const statsSmooth = (key !== cfg.signal) ? rollingStats(series, i, cfg.window, key) : null;
    const stSig = statsSmooth || stats[cfg.signal];
    const w = equityWeight(stSig.pct, stSig.z, cfg);

    // 历史同期对照：ERP 处于不同历史分位时对应的 PE 与 Y10 水平
    const bands = [];
    [0.1, 0.25, 0.5, 0.75, 0.9].forEach((q) => {
      const all = series.map((s) => s[cfg.signal]).filter((v) => v != null && isFinite(v));
      bands.push({ q: q, value: quantile(all, q) });
    });

    return {
      index: i,
      date: r.date,
      month: r.m,
      pe: r.pe, pb: r.pb, div: r.div, close: r.close,
      ep: r.ep, y10: r.y10, erp: r.erp, ratio: r.ratio, dyspread: r.dyspread,
      stats: stats,
      statsSmooth: statsSmooth,
      signalKey: key,
      erpS: r.erpS,
      ratioS: r.ratioS,
      selected: cfg.signal,
      weight: w,
      weightInput: { value: stSig.value, pct: stSig.pct, z: stSig.z, n: stSig.n },
      historyBands: bands,
      modDur: modDuration(r.y10),
    };
  }

  // ---------------- 历史类比：同样信号强度之后发生了什么 ----------------
  /**
   * 找出历史上"信号 ≥ 当前强度"的所有时点，统计其后 horizon 个月的前瞻表现
   */
  function forwardReturns(series, cfg, horizon) {
    horizon = horizon || 12;
    const key = signalKey(cfg);
    const N = series.length;
    const curPct = rollingStats(series, N - 1, cfg.window, key).pct;
    const eq = [], bd = [];
    for (let i = 0; i <= N - 1 - horizon; i++) {
      const st = rollingStats(series, i, cfg.window, key);
      if (!isFinite(st.pct)) continue;
      if (st.pct >= curPct - 1e-9) {
        let a = 1, b = 1, valid = true;
        for (let k = 1; k <= horizon; k++) {
          const row = series[i + k];
          if (row.retEq == null || row.retBd == null) { valid = false; break; }
          a *= 1 + row.retEq;
          b *= 1 + row.retBd;
        }
        if (!valid) continue;
        eq.push(a - 1);
        bd.push(b - 1);
      }
    }
    const winCount = eq.filter((x) => x > 0).length;
    return {
      n: eq.length, horizon: horizon, threshold: curPct,
      eqMean: mean(eq), eqMedian: quantile(eq, 0.5), eqWin: winCount / (eq.length || 1),
      eqP25: quantile(eq, 0.25), eqP75: quantile(eq, 0.75),
      bdMean: mean(bd), excess: mean(eq) - mean(bd),
    };
  }

  // ---------------- 情景推演矩阵 ----------------
  /**
   * 给定当前Y10与PE，推演 "PE变动% × Y10变动bp" 下的 ERP 与目标股票仓位
   */
  function scenarios(series, cfg, peSteps, bpSteps) {
    const i = series.length - 1;
    const basePe = series[i].pe;
    const baseY = series[i].y10;
    const all = series.map((s) => s[cfg.signal]).filter((v) => v != null && isFinite(v));

    // 预先算好全历史样本的均值与标准差，便于把推演值换成 z / 分位
    const mu = mean(all), sd = stdev(all);
    const win = cfg.window > 0 ? Math.max(0, i - cfg.window + 1) : 0;
    const recent = [];
    for (let k = win; k <= i; k++) {
      const v = series[k][cfg.signal];
      if (v != null && isFinite(v)) recent.push(v);
    }
    const rMu = mean(recent), rSd = stdev(recent);

    return peSteps.map((dPe) => {
      const row = { dPe: dPe };
      row.cells = bpSteps.map((bp) => {
        const pe = basePe * (1 + dPe);
        const y = baseY + bp / 100;
        const ep = 100 / pe;
        let v;
        if (cfg.signal === 'erp') v = ep - y;
        else if (cfg.signal === 'ratio') v = ep / y;
        else v = (series[i].div / (1 + dPe)) - y; // 股息率随价格反向变动
        const z = (v - rMu) / rSd;
        const pct = percentileRank(recent, v);
        row.__v = v;
        return { bp: bp, value: v, pct: pct, z: z, weight: equityWeight(pct, z, cfg) };
      });
      return row;
    });
  }

  // ---------------- 买卖信号（离散事件） ----------------
  /** 第 i 期之后 h 个月的累计收益（用于事后检验） */
  function fwdRet(series, i, h, key) {
    const k = key || 'retEq';
    let a = 1;
    for (let j = 1; j <= h; j++) {
      const r = series[i + j];
      if (!r || r[k] == null) return null;
      a *= 1 + r[k];
    }
    return a - 1;
  }

  /**
   * 买卖点：估值定方向、趋势确认卖点（实测优于双向确认，见 scripts/combo*_test.js）
   *   买入：信号分位 >= buyPct —— 不等趋势转身，否则会踏空底部第一段
   *   卖出：信号分位 <= sellPct 且 收盘跌破 60 日线 —— 估值往往提前几个月预警，
   *         等趋势走坏再走，能躲过「卖太早」（2015 卖点从 3534 推到 4473）
   * 月末评估、次月生效，与回测同口径。
   * @returns {Array} [{ i, m, d, type:'buy'|'sell', close, pct, z, erp, erpS, ma60, volZ, fwd6, fwd12, weight }]
   */
  function tradeSignals(series, cfg, opts) {
    const o = opts || {};
    const buyPct = o.buyPct == null ? 0.65 : o.buyPct;
    const sellPct = o.sellPct == null ? 0.35 : o.sellPct;
    const minN = o.minN == null ? 24 : o.minN;
    const key = signalKey(cfg);
    const out = [];
    let state = 'flat';

    for (let i = 0; i < series.length; i++) {
      const r = series[i];
      const v = r[key];
      if (v == null || !isFinite(v)) continue;
      const st = rollingStats(series, i, cfg.window, key);
      if (st.n < minN) continue;

      let type = null;
      if (state === 'flat' && st.pct >= buyPct) {
        type = 'buy'; state = 'long';
      } else if (state === 'long' && st.pct <= sellPct &&
                 r.ma60 != null && r.close != null && r.close < r.ma60) {
        type = 'sell'; state = 'flat';
      }
      if (!type) continue;

      out.push({
        i: i, m: r.m, d: r.date, type: type,
        close: r.close, pct: st.pct, z: st.z,
        erp: r.erp, erpS: r.erpS, ma60: r.ma60, volZ: r.volZ,
        weight: equityWeight(st.pct, st.z, cfg),
        fwd6: fwdRet(series, i, 6),
        fwd12: fwdRet(series, i, 12),
      });
    }
    return out;
  }

  /**
   * 信号配对后的持仓段统计：每个买点到下一个卖点（或数据末尾）
   * @returns {Array} [{ buyM, sellM, months, ret, open }]
   */
  function holdSegments(series, sigs) {
    const segs = [];
    let cur = null;
    for (let k = 0; k < sigs.length; k++) {
      const s = sigs[k];
      if (s.type === 'buy') {
        if (cur) continue;
        cur = { buyM: s.m, buyClose: s.close, buyPct: s.pct, buyIdx: s.i };
      } else if (s.type === 'sell' && cur) {
        let a = 1;
        for (let j = cur.buyIdx + 1; j <= s.i; j++) {
          if (series[j] && series[j].retEq != null) a *= 1 + series[j].retEq;
        }
        segs.push(Object.assign(cur, {
          sellM: s.m, sellClose: s.close, months: s.i - cur.buyIdx,
          ret: a - 1, open: false,
        }));
        cur = null;
      }
    }
    if (cur) {
      let a = 1;
      for (let j = cur.buyIdx + 1; j < series.length; j++) {
        if (series[j] && series[j].retEq != null) a *= 1 + series[j].retEq;
      }
      segs.push(Object.assign(cur, {
        sellM: null, sellClose: null, months: series.length - 1 - cur.buyIdx,
        ret: a - 1, open: true,
      }));
    }
    return segs;
  }

  /**
   * 三档仓位信号（估值定方向 + 趋势/天量预警减半）
   * 规则（月末评估、次月生效，对照回测见 scripts/freq_test2.js 的 S2）：
   *   空仓 → ERP 分位 ≥ buyPct(默认60%) 买入满仓（估值给方向就动手，否则踏空底部）
   *   持仓 → 分位 ≤ flatPct(30%) 清仓
   *        → 分位 ≤ halfPct(50%)（估值走弱），或 分位 ≤ halfPct2(65%) 且（跌破60日线 或
   *          成交量σ > volZHot(1.5) 天量）→ 减半（趋势/情绪预警先降风险，不必等到彻底转空）
   *        → 其余情况恢复满仓
   * confirm(默认2)：目标档位需**连续 N 个月**不变才执行，用于滤掉单月噪音。
   *   这是体检后的修正——无确认期时 2025-08~2026-09 来回切 8 次、跑输躺平 0.4pct，
   *   加确认后该段从 3.2% 变 9.96%，换手 0.88x→0.51x（scripts/denoise_test.js）。
   * @returns {Array} [{ i, m, d, type:'buy'|'add'|'reduce'|'sell', level, close, pct, z, erp, erpS, ma60, volZ, fwd6, fwd12 }]
   */
  function tierSignals(series, cfg, opts) {
    const o = opts || {};
    const buyPct = o.buyPct == null ? 0.60 : o.buyPct;
    const flatPct = o.flatPct == null ? 0.30 : o.flatPct;
    const halfPct = o.halfPct == null ? 0.50 : o.halfPct;
    const halfPct2 = o.halfPct2 == null ? 0.65 : o.halfPct2;
    const volZHot = o.volZHot == null ? 1.5 : o.volZHot;
    const confirm = o.confirm == null ? 2 : o.confirm;
    const key = signalKey(cfg);
    const out = [];
    let lv = 0;          // 当前档位 0 / 0.5 / 1
    let pending = null;  // 待确认的目标档位
    let pendCnt = 0;     // 已连续观察到的次数

    for (let i = 0; i < series.length; i++) {
      const r = series[i];
      const v = r[key];
      if (v == null || !isFinite(v)) continue;
      const st = rollingStats(series, i, cfg.window, key);
      if (st.n < 24) continue;
      const p = st.pct;
      const weak = r.ma60 != null && r.close != null && r.close < r.ma60;
      const hot = r.volZ != null && r.volZ > volZHot;

      let target;
      if (lv === 0) target = p >= buyPct ? 1 : 0;
      else if (p <= flatPct) target = 0;
      else if (p <= halfPct || (p <= halfPct2 && (weak || hot))) target = 0.5;
      else target = 1;

      // 确认期：目标档位要连续 confirm 个月咬住才执行，中途回到现档位就重新计数
      let next = lv;
      if (confirm <= 1) {
        next = target;
      } else if (target === lv) {
        pending = null; pendCnt = 0;
      } else if (pending === target) {
        pendCnt++;
        if (pendCnt >= confirm - 1) { next = target; pending = null; pendCnt = 0; }
      } else {
        pending = target; pendCnt = 0;
      }

      let type = null;
      if (next !== lv) {
        if (lv === 0) type = 'buy';
        else if (next === 0) type = 'sell';
        else if (next < lv) type = 'reduce';
        else type = 'add';
      }

      if (type) {
        out.push({
          i: i, m: r.m, d: r.date, type: type, level: next,
          close: r.close, pct: p, z: st.z,
          erp: r.erp, erpS: r.erpS, ma60: r.ma60, volZ: r.volZ,
          fwd6: fwdRet(series, i, 6), fwd12: fwdRet(series, i, 12),
        });
      }
      lv = next;
    }
    return out;
  }

  /**
   * 三档信号的持仓段：从买入到清仓，按各期实际档位加权复合收益
   * @returns {Array} [{ buyM, sellM, months, ret, open }]
   */
  function tierHoldings(series, sigs) {
    function segRet(cur, endIdx, open) {
      let a = 1;
      for (let j = cur.buyIdx + 1; j <= endIdx; j++) {
        const r = series[j];
        if (!r || r.retEq == null || r.retBd == null) continue;
        let w = 0;
        for (let q = 0; q < cur.w.length; q++) {
          if (cur.w[q].i <= j - 1) w = cur.w[q].w; else break;
        }
        a *= 1 + w * r.retEq + (1 - w) * r.retBd;
      }
      return {
        buyM: cur.buyM, buyClose: cur.buyClose, buyIdx: cur.buyIdx,
        sellM: open ? null : series[endIdx].m, sellClose: open ? null : series[endIdx].close,
        months: endIdx - cur.buyIdx, ret: a - 1, open: open,
      };
    }
    const segs = [];
    let cur = null;
    for (let k = 0; k < sigs.length; k++) {
      const s = sigs[k];
      if (s.type === 'buy') {
        cur = { buyM: s.m, buyClose: s.close, buyIdx: s.i, w: [{ i: s.i, w: 1 }] };
      } else if (cur) {
        if (s.type === 'reduce') cur.w.push({ i: s.i, w: 0.5 });
        else if (s.type === 'add') cur.w.push({ i: s.i, w: 1 });
        else if (s.type === 'sell') {
          cur.w.push({ i: s.i, w: 0 });
          segs.push(segRet(cur, s.i, false));
          cur = null;
        }
      }
    }
    if (cur) segs.push(segRet(cur, series.length - 1, true));
    return segs;
  }

  // ---------------- 导出 ----------------
  const Engine = {
    clamp, mean, stdev, quantile, percentileRank, modDuration,
    buildSeries, rollingStats, equityWeight, perfMetrics, backtest,
    currentSnapshot, scenarios, forwardReturns,
    // 日频相关
    buildDaily, moveAvg, monthlySmooth, rollingChannel, signalKey, volZ,
    // 买卖信号
    tradeSignals, holdSegments, fwdRet,
    tierSignals, tierHoldings,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else global.EQBEngine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : window);
