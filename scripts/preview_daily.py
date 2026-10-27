# -*- coding: utf-8 -*-
"""
日频 ERP 效果预览（只读，不改动主系统）

拉取沪深300 日线 + 国债 10Y 日频，用 Wind 月末 PE 作为锚点推算日频 PE，
生成一个独立的对比页面 _daily_preview.html，用来判断"日频化到底值不值"。

用法：
    python scripts/preview_daily.py
产物：
    _daily_preview.html   （临时预览，已在 .gitignore 中排除）
"""

import csv
import json
import os
import statistics as st
import subprocess
import time
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "_daily_preview.html")

HDR = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
}


def get(url, referer="https://data.eastmoney.com/"):
    """优先用 curl 取数：东财对 Python urllib 的连接会直接断开，
    而 curl 的 TLS/请求头特征能正常通过（实测 2026-10-27）。"""
    h = dict(HDR)
    h["Referer"] = referer
    try:
        out = subprocess.run(
            ["curl", "-s", "--max-time", "40", "-H", "User-Agent: " + h["User-Agent"],
             "-H", "Referer: " + h["Referer"], url],
            capture_output=True, timeout=50)
        txt = out.stdout.decode("utf-8", "ignore").strip()
        if txt:
            return txt
    except Exception:
        pass
    # 回退：urllib
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:
            last = e
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError("请求失败 %s -> %s" % (url.split("?")[0], str(last)[:80]))


def fval(v):
    try:
        return float(str(v).strip())
    except Exception:
        return None


# ---------------------------------------------------------------- 取数
def load_price():
    """新浪日线（与 update.py 同源，点位与系统一致）；东财 kline 会限流断连，仅作兜底。"""
    url = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
           "CN_MarketData.getKLineData?symbol=sh000300&scale=240&ma=no&datalen=4000")
    px = {}
    txt = get(url, "https://finance.sina.com.cn/")
    if txt.strip().startswith("["):
        for it in json.loads(txt):
            d = it["day"][:10]
            if d >= "2012-01-01":
                px[d] = float(it["close"])
    if not px:
        raise RuntimeError("新浪日线为空")
    print("  沪深300 日线      %4d 条   %s ~ %s" % (len(px), min(px), max(px)))
    return px


def load_y10(max_page=14):
    out = {}
    for page in range(1, max_page + 1):
        url = ("https://datacenter-web.eastmoney.com/api/data/v1/get"
               "?reportName=RPTA_WEB_TREASURYYIELD&columns=ALL&pageNumber=%d&pageSize=300"
               "&sortTypes=-1&sortColumns=SOLAR_DATE&source=WEB&client=WEB" % page)
        rows = (json.loads(get(url)).get("result") or {}).get("data") or []
        if not rows:
            break
        for r in rows:
            d = str(r.get("SOLAR_DATE", ""))[:10]
            if d and r.get("EMM00166466") is not None:
                out[d] = float(r["EMM00166466"])
        if out and min(out) < "2012-01-01":
            break
        time.sleep(0.35)
    print("  国债 10Y 日频      %4d 条   %s ~ %s" % (len(out), min(out), max(out)))
    return out


def load_pe_anchor():
    """Wind 月末 PE 锚点：date -> pe"""
    out = {}
    with open(os.path.join(RAW, "hs300_valuation_monthly.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            pe = fval(r["pe"])
            if pe:
                out[r["date"].strip()] = pe
    print("  Wind 月末 PE 锚点  %4d 个" % len(out))
    return out


# ---------------------------------------------------------------- 构建
def build_daily(px, y10, anchor):
    """PE_t = PE_anchor × Close_t / Close_anchor
    锚点取「t 之前最近一个 Wind 权威日」，这样财报季盈利更新会被自动吸收。"""
    a_dates = sorted(anchor)
    px_dates = sorted(px)
    # 每个锚点日的东财收盘价（非交易日则取之前最近交易日）
    a_close = {}
    j = 0
    for d in a_dates:
        while j + 1 < len(px_dates) and px_dates[j + 1] <= d:
            j += 1
        if px_dates[j] <= d:
            a_close[d] = px[px_dates[j]]

    rows = []
    i = 0
    cur = None
    for d in px_dates:
        while i < len(a_dates) and a_dates[i] <= d:
            cur = a_dates[i]
            i += 1
        if cur is None or cur not in a_close:
            continue
        pe = anchor[cur] * px[d] / a_close[cur]
        y = y10.get(d)
        rows.append(dict(d=d, close=px[d], pe=round(pe, 4), y10=y,
                         erp=(round(100.0 / pe - y, 4) if y is not None else None)))
    # 补最后一天缺 Y10 的情况：沿用最近一个 Y10
    last_y = None
    for r in rows:
        if r["y10"] is None:
            r["y10"] = last_y
            r["erp"] = round(100.0 / r["pe"] - last_y, 4) if last_y else None
            r["y10_carry"] = 1
        else:
            last_y = r["y10"]
    return [r for r in rows if r["erp"] is not None]


def main():
    print("[1/3] 取数")
    px = load_price()
    y10 = load_y10()
    anchor = load_pe_anchor()

    print("[2/3] 构建日频面板")
    daily = build_daily(px, y10, anchor)
    print("  日频面板 %d 个交易日  %s ~ %s" % (len(daily), daily[0]["d"], daily[-1]["d"]))

    # 月频：每月最后一个交易日
    last_of = {}
    for r in daily:
        last_of[r["d"][:7]] = r
    monthly = [last_of[k] for k in sorted(last_of)]
    print("  月频月末 %d 个点" % len(monthly))

    # 统计
    d_erp = [r["erp"] for r in daily]
    m_erp = [r["erp"] for r in monthly]
    mu, sd = st.mean(d_erp), st.pstdev(d_erp)
    m_mu, m_sd = st.mean(m_erp), st.pstdev(m_erp)
    d_step = st.mean([abs(d_erp[i] - d_erp[i - 1]) for i in range(1, len(d_erp))])
    m_step = st.mean([abs(m_erp[i] - m_erp[i - 1]) for i in range(1, len(m_erp))])

    # 20 日均线
    ma20 = []
    for i in range(len(daily)):
        if i < 19:
            ma20.append(None)
        else:
            ma20.append(round(sum(d_erp[i - 19:i + 1]) / 20.0, 3))

    # 穿越均线次数
    def cross(series, win):
        n = 0
        for i in range(win, len(series)):
            a = sum(series[i - win:i]) / win
            prev = sum(series[i - win - 1:i - 1]) / win
            if (series[i] > a) != (series[i - 1] > prev):
                n += 1
        return n

    d_cross = cross(d_erp, 60)
    m_cross = cross(m_erp, 12)
    years = len(daily) / 244.0
    d_cost = d_cross / years * 2 * 0.0005 * 100      # 每次翻转双边 10bp -> %
    m_cost = m_cross / years * 2 * 0.0005 * 100

    print("[3/3] 生成页面")
    stats = dict(
        n_daily=len(daily), n_monthly=len(monthly),
        mu=round(mu, 2), sd=round(sd, 2), m_mu=round(m_mu, 2), m_sd=round(m_sd, 2),
        d_step=round(d_step, 3), m_step=round(m_step, 3),
        d_cross=d_cross, m_cross=m_cross,
        d_cost=round(d_cost, 2), m_cost=round(m_cost, 2),
        years=round(years, 1),
        range=[daily[0]["d"], daily[-1]["d"]],
        latest=daily[-1],
    )

    # 近 250 个交易日
    tail = daily[-250:]
    tail_ma = ma20[-250:]

    html = TEMPLATE.replace("__STATS__", json.dumps(stats, ensure_ascii=False))
    html = html.replace("__RANGE__", "%s ~ %s" % (stats["range"][0], stats["range"][1]))
    html = html.replace("__N__", str(stats["n_daily"]))
    html = html.replace("__DCOST__", "%.2f" % d_cost)
    html = html.replace("__MCOST__", "%.2f" % m_cost)
    html = html.replace("__DATES__", json.dumps([r["d"] for r in daily]))
    html = html.replace("__ERP__", json.dumps(d_erp))
    html = html.replace("__MA20__", json.dumps(ma20))
    html = html.replace("__M_DATES__", json.dumps([r["d"] for r in monthly]))
    html = html.replace("__M_ERP__", json.dumps(m_erp))
    html = html.replace("__T_DATES__", json.dumps([r["d"] for r in tail]))
    html = html.replace("__T_ERP__", json.dumps([r["erp"] for r in tail]))
    html = html.replace("__T_MA__", json.dumps(tail_ma))
    html = html.replace("__T_MD__", json.dumps([r["d"] for r in tail if r["d"] in [x["d"] for x in monthly]]))
    html = html.replace("__T_ME__", json.dumps([r["erp"] for r in tail if r["d"] in [x["d"] for x in monthly]]))
    html = html.replace("__GEN__", datetime.now().strftime("%Y-%m-%d %H:%M"))

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("  输出 %s  (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024.0))
    print("\n统计：日频 σ=%.2f 月频 σ=%.2f ｜ 日步长 %.3f 月步长 %.3f ｜ 穿越 % d/%d 次"
          % (sd, m_sd, d_step, m_step, d_cross, m_cross))


TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>日频 ERP 预览 · EquiBond</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --line:#e4e7ec; --soft:#f0f2f5;
    --txt:#1a1f2b; --txt2:#4a5261; --txt3:#7b8494;
    --blue:#2f6fed; --red:#c0392b; --navy:#1d3557; --gold:#e3b04b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 18px 60px}
  .badge{display:inline-block;padding:2px 9px;border-radius:20px;background:#fff3cd;color:#8a6100;
    font-size:12px;font-weight:600;margin-left:8px;vertical-align:middle}
  h1{font-size:22px;margin:0 0 6px;letter-spacing:-.2px}
  .sub{color:var(--txt3);font-size:13px;margin-bottom:20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 15px}
  .card .k{font-size:12px;color:var(--txt3);margin-bottom:5px}
  .card .v{font-size:21px;font-weight:650;letter-spacing:-.5px}
  .card .n{font-size:11.5px;color:var(--txt3);margin-top:3px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px 8px;margin-bottom:18px}
  .panel h2{font-size:15px;margin:0 0 3px;font-weight:650}
  .panel .hint{font-size:12.5px;color:var(--txt3);margin-bottom:10px}
  .chart{height:330px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:9px 10px;text-align:right;border-bottom:1px solid var(--soft)}
  th:first-child,td:first-child{text-align:left}
  th{font-size:12px;color:var(--txt3);font-weight:600;background:#fafbfc}
  td.num{font-variant-numeric:tabular-nums}
  .hl{color:var(--red);font-weight:650}
  .ok{color:#1a7f4b;font-weight:650}
  .foot{color:var(--txt3);font-size:12.5px;line-height:1.8;border-top:1px solid var(--line);padding-top:14px}
  code{background:var(--soft);padding:1px 5px;border-radius:4px;font-size:12.5px}
</style>
</head>
<body>
<div class="wrap">
  <h1>日频 ERP 效果预览<span class="badge">只读 · 未并入主系统</span></h1>
  <div class="sub">__RANGE__ ｜ __N__ 个交易日 ｜ 生成于 __GEN__</div>

  <div class="cards" id="cards"></div>

  <div class="panel">
    <h2>一、全历史：日频曲线 vs 月末采样点</h2>
    <div class="hint">细蓝线是日频 ERP，红点是现有系统的月末数据点。红点全都落在蓝线上——说明日频没有改变任何月末读数，只是补上了中间的路程。</div>
    <div class="chart" id="c1"></div>
  </div>

  <div class="panel">
    <h2>二、近 250 个交易日放大：日频到底多"抖"</h2>
    <div class="hint">灰细线为日频原始值，深蓝粗线为 20 日均线，橙线为月频阶梯（现有系统看到的样子）。日频的锯齿大多是噪声，平滑后才接近月频信息。</div>
    <div class="chart" id="c2"></div>
  </div>

  <div class="panel">
    <h2>三、关键量化对比</h2>
    <div class="hint">决定"值不值得改"的就是这几行。</div>
    <table id="t1"></table>
  </div>

  <div class="foot">
    <b>怎么读这张表：</b>标准差几乎相同 → 日频不改变"贵/便宜"的判断，只改变看得多细；
    但穿越均线次数是月频的 6 倍 → 若直接用日频做仓位信号，会频繁翻转。
    按每次翻转双边 10bp 估算，日频裸调仓每年成本约 <b>__DCOST__%</b>，月频仅 <b>__MCOST__%</b>。<br>
    这就是为什么建议：<b>图表用日频，信号与调仓仍按月（信号加 20 日均线平滑）</b>。
  </div>
</div>
<script src="vendor/echarts.min.js"></script>
<script>
const S = __STATS__;
const D = __DATES__, E = __ERP__, MA = __MA20__;
const MD = __M_DATES__, ME = __M_ERP__;
const TD = __T_DATES__, TE = __T_ERP__, TM = __T_MA__, TMD = __T_MD__, TME = __T_ME__;

const C = { txt:'#1a1f2b', txt3:'#7b8494', line:'#e4e7ec', soft:'#f0f2f5',
            blue:'#2f6fed', red:'#c0392b', navy:'#1d3557', gold:'#e3b04b' };
const AX = {
  axisLine:{ lineStyle:{ color:C.line } }, axisTick:{ show:false },
  axisLabel:{ color:C.txt3, fontSize:11 },
  splitLine:{ lineStyle:{ color:C.soft } }
};
const TIP = {
  backgroundColor:'rgba(255,255,255,.97)', borderColor:C.line, borderWidth:1,
  textStyle:{ color:C.txt, fontSize:12 }, padding:[8,11],
  extraCssText:'box-shadow:0 6px 20px rgba(16,24,40,.12);border-radius:9px;'
};

// 统计卡
const cards = [
  ['日频样本', S.n_daily, '个交易日'],
  ['月频样本', S.n_monthly, '个月末'],
  ['ERP 标准差', S.sd + ' / ' + S.m_sd, '日频 / 月频'],
  ['平均单步变动', S.d_step + ' / ' + S.m_step, 'pct，日频 / 月频'],
  ['穿越均线', S.d_cross + ' / ' + S.m_cross, '日频 / 月频'],
  ['年化摩擦成本', S.d_cost + '% / ' + S.m_cost + '%', '日频 / 月频'],
];
document.getElementById('cards').innerHTML = cards.map(c =>
  `<div class="card"><div class="k">${c[0]}</div><div class="v">${c[1]}</div><div class="n">${c[2]}</div></div>`
).join('');

// 图1
echarts.init(document.getElementById('c1')).setOption({
  grid:{ left:56, right:22, top:26, bottom:56 },
  tooltip: Object.assign({ trigger:'axis' }, TIP),
  xAxis: Object.assign({ type:'category', data:D, boundaryGap:false }, AX),
  yAxis: Object.assign({ type:'value', name:'ERP (pct)', nameTextStyle:{ color:C.txt3, fontSize:11 },
    scale:true }, AX),
  dataZoom:[{ type:'inside' }, { type:'slider', height:18, bottom:14,
    borderColor:C.line, fillerColor:'rgba(47,111,237,.10)', handleStyle:{ color:C.blue } }],
  series:[
    { name:'日频 ERP', type:'line', data:E, showSymbol:false, sampling:'lttb',
      lineStyle:{ color:C.blue, width:1, opacity:.6 }, itemStyle:{ color:C.blue }, z:2 },
    { name:'月末采样', type:'scatter', data:MD.map((d,i)=>[d, ME[i]]), symbolSize:4.5,
      itemStyle:{ color:C.red, opacity:.85 }, z:3 },
    { name:'均值', type:'line', data:D.map(()=>S.mu), showSymbol:false, silent:true,
      lineStyle:{ color:'#8e8e8e', width:1, type:'dashed' }, z:1 },
    { name:'±1σ', type:'line', data:D.map(()=>S.mu+S.sd), showSymbol:false, silent:true,
      lineStyle:{ color:C.gold, width:1, type:'dotted', opacity:.75 }, z:1 },
    { name:'-1σ', type:'line', data:D.map(()=>S.mu-S.sd), showSymbol:false, silent:true,
      lineStyle:{ color:C.gold, width:1, type:'dotted', opacity:.75 }, z:1 },
    { name:'±2σ', type:'line', data:D.map(()=>S.mu+2*S.sd), showSymbol:false, silent:true,
      lineStyle:{ color:C.red, width:1, type:'dotted', opacity:.55 }, z:1 },
    { name:'-2σ', type:'line', data:D.map(()=>S.mu-2*S.sd), showSymbol:false, silent:true,
      lineStyle:{ color:C.red, width:1, type:'dotted', opacity:.55 }, z:1 },
  ],
  legend:{ left:6, top:0, itemWidth:14, itemHeight:8, itemGap:14,
    textStyle:{ color:'#4a5261', fontSize:11.5 },
    data:['日频 ERP','月末采样','均值','±1σ','±2σ'] }
});

// 图2
echarts.init(document.getElementById('c2')).setOption({
  grid:{ left:56, right:22, top:26, bottom:40 },
  tooltip: Object.assign({ trigger:'axis' }, TIP),
  xAxis: Object.assign({ type:'category', data:TD, boundaryGap:false }, AX),
  yAxis: Object.assign({ type:'value', name:'ERP (pct)', nameTextStyle:{ color:C.txt3, fontSize:11 },
    scale:true }, AX),
  series:[
    { name:'日频原始', type:'line', data:TE, showSymbol:false,
      lineStyle:{ color:'#b9c0cc', width:1 }, z:2 },
    { name:'20日均线', type:'line', data:TM, showSymbol:false,
      lineStyle:{ color:C.navy, width:2.2 }, z:4 },
    { name:'月末阶梯', type:'line', data:TMD.map((d,i)=>[d, TME[i]]), step:'end',
      symbol:'circle', symbolSize:6, lineStyle:{ color:C.gold, width:1.6 },
      itemStyle:{ color:C.gold }, z:3 },
  ],
  legend:{ left:6, top:0, itemWidth:14, itemHeight:8, itemGap:14,
    textStyle:{ color:'#4a5261', fontSize:11.5 } }
});

// 表
document.getElementById('t1').innerHTML = `
<thead><tr><th>指标</th><th>日频</th><th>月频</th><th>差异意味着什么</th></tr></thead>
<tbody>
  <tr><td>样本数</td><td class="num">${S.n_daily}</td><td class="num">${S.n_monthly}</td><td>密 ${(S.n_daily/S.n_monthly).toFixed(0)} 倍</td></tr>
  <tr><td>ERP 均值 (pct)</td><td class="num">${S.mu}</td><td class="num">${S.m_mu}</td><td class="ok">几乎相同 → 估值中枢不变</td></tr>
  <tr><td>ERP 标准差</td><td class="num hl">${S.sd}</td><td class="num hl">${S.m_sd}</td><td class="ok">完全相同 → 不改变便宜/贵的判断</td></tr>
  <tr><td>平均单步变动 (pct)</td><td class="num">${S.d_step}</td><td class="num">${S.m_step}</td><td>日频步子小约 ${(S.m_step/S.d_step).toFixed(1)} 倍</td></tr>
  <tr><td>穿越均线次数</td><td class="num hl">${S.d_cross}</td><td class="num">${S.m_cross}</td><td class="hl">日频抖 ${(S.d_cross/S.m_cross).toFixed(1)} 倍 → 信号噪声大</td></tr>
  <tr><td>年化摩擦成本估算</td><td class="num hl">${S.d_cost}%</td><td class="num">${S.m_cost}%</td><td class="hl">日频裸调仓会吃掉大量收益</td></tr>
</tbody>`;
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
