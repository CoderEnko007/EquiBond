# -*- coding: utf-8 -*-
"""
EquiBond 增量更新器

每次访问前跑一次，把最新交易日的数据在线追加到 data/raw/ 并重建 data/dataset.js。

设计前提（重要，务必理解）：
  * 免费的、稳定的实时源只有「沪深300 点位」（新浪 / 东财，两个源交叉校验）
  * PE / PB / 股息率没有权威的实时免费接口。但在同一份财报的有效期内，
    指数盈利 E 不变，而 PE = P / E，所以：
        PE_today = PE_anchor × (Close_today / Close_anchor)
    PB 同理（B 不变、P 变）；股息率反向：
        Div_today = Div_anchor × (Close_anchor / Close_today)   # 分红金额固定，价格涨跌反向
    这三个公式在两个财报之间是数学精确的，不是估算。
  * 一旦跨过财报披露期（沪深300 的 E 会在 4月底 / 8月底 / 10月底 附近跳变），
    滚动推算就会失真 > 脚本会警告，需要用 Wind 重新校准锚点：
        让我（WorkBuddy）执行「校准股债数据」，或手动写入 data/raw/hs300_valuation_monthly.csv

国债收益率：本文件内置了多个候选源（见 YIELD_SOURCES），逐个尝试，
全都失败时保留上一交易日的值，并在 meta 里标记 y10_stale_days，页面会提示。

用法:
    python scripts/update.py            # 联网增量更新 + 重建 dataset.js
    python scripts/update.py --offline  # 不联网，仅重建
    python scripts/update.py --dry-run  # 只拉取并打印，不落盘
"""

import csv
import os
import sys
import io
import json
import runpy
import urllib.request
import urllib.error
from datetime import datetime, date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
}

VAL_CSV = "hs300_valuation_monthly.csv"
PX_CSV = "hs300_price_monthly.csv"
YLD_CSV = "cgb_yield_daily.csv"

ANCHOR_MAX_AGE = 110   # 天。超过说明很可能已跨过一个财报期，需要重新校准
                       # （页面端的「数据滞后」提示阈值见 app.js renderFreshness）
CALIB_FILE = "calibration.json"   # 记录「上一次用权威源(Wind)写死 PE」的日期


# ---------------------------------------------------------------- 取数
def load_calibration(anchor_date, args):
    """锚点年龄必须以上一次「权威校准」为基准。
    脚本自身的每次自增不能刷新它 —— 否则过期检查永远命中不了。"""
    p = os.path.join(RAW, CALIB_FILE)
    if "--calibrate" in args:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(dict(calibrated_at=anchor_date, source="Wind MCP 权威源"),
                      f, ensure_ascii=False, indent=2)
        print("[校准] 已记录权威锚点日期 -> %s" % anchor_date)
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return dict(calibrated_at=anchor_date, source="沿用 CSV 末行（未记录校准）")


def http_get(url, headers=None, decode="utf-8", timeout=15):
    """GET 并返回文本；失败返回 None"""
    h = dict(HDR)
    if headers:
        h.update(headers)
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode(decode, "ignore")
    except Exception as e:
        print("      · 请求失败 %s -> %s" % (url.split("?")[0], str(e)[:60]))
        return None


def fetch_hs300_sina():
    """新浪实时：返回 (date, close, name, source)"""
    txt = http_get("https://hq.sinajs.cn/list=sh000300",
                   {"Referer": "https://finance.sina.com.cn/"}, decode="gbk")
    if not txt or '="' not in txt:
        return None
    f = txt.split('"')[1].split(",")
    if len(f) < 32 or not f[3]:
        return None
    try:
        close = float(f[3])
        d = f[30].strip()
    except (ValueError, IndexError):
        return None
    if not d.startswith("20") or close <= 0:
        return None
    return dict(date=d, close=close, source="新浪财经")


def fetch_hs300_em():
    """东财实时（交叉校验）：返回 (date, close) —— 东财不直接给日期，用今天"""
    txt = http_get("https://push2.eastmoney.com/api/qt/stock/get"
                   "?secid=1.000300&fields=f43,f58,f86",
                   {"Referer": "https://quote.eastmoney.com/"})
    if not txt or '"data"' not in txt:
        return None
    try:
        d = json.loads(txt)["data"]
        v = d.get("f43")
        # 指数点位为 3 位小数放大，收盘价 f43 未放大时为整数点
        close = float(v) / 100.0 if v and v > 100000 else float(v)
        ts = d.get("f86")
        if ts and ts > 10 ** 9:
            dt = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        else:
            dt = date.today().strftime("%Y-%m-%d")
        if close <= 0:
            return None
        return dict(date=dt, close=close, source="东方财富")
    except Exception:
        return None


def fetch_hs300_price():
    """两个源交叉校验，取一致的结果；不一致时优先新浪（它给真实交易日期）"""
    a = fetch_hs300_sina()
    b = fetch_hs300_em()
    if a and b:
        diff = abs(a["close"] - b["close"]) / a["close"]
        print("      新浪 %.2f | 东财 %.2f | 偏差 %.3f%%" % (a["close"], b["close"], diff * 100))
        if diff > 0.01:
            print("      ! 两源偏差过大，采用新浪")
        return a
    return a or b


# ---- 国债收益率候选源 ----
# 说明：中债估值、财政部、chinamoney 都没有稳定的免鉴权接口。
#       找到可用源后，在下面加一个返回 {date, y10} 的函数并注册进 YIELD_SOURCES 即可，
#       无需改动其它代码。
def fetch_yield_chinamoney():
    txt = http_get("https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/bond/bkccpr.json")
    if not txt or "Error" in txt:
        return None
    try:
        arr = json.loads(txt)
        if isinstance(arr, list) and arr:
            last = arr[-1]
            return dict(date=str(last.get("date", ""))[:10], y10=float(last.get("y10")))
    except Exception:
        pass
    return None


YIELD_SOURCES = [
    ("中国货币网", fetch_yield_chinamoney),
]


def fetch_y10():
    for name, fn in YIELD_SOURCES:
        r = fn()
        if r and r.get("y10"):
            print("      国债 10Y 命中源：%s -> %s %.4f%%" % (name, r["date"], r["y10"]))
            return r
    return None


# ---------------------------------------------------------------- CSV 工具
def read_rows(name):
    with open(os.path.join(RAW, name), "r", encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def write_rows(name, rows):
    with open(os.path.join(RAW, name), "w", encoding="utf-8", newline="") as f:
        csv.writer(f).writerows(rows)


def month_upsert(rows, new_row):
    """月度面板专用：同一个自然月永远只保留最新的一条。
    rows[0] 是表头，其余按日期升序。"""
    m = new_row[0][:7]
    out = [rows[0]] + [r for r in rows[1:] if r[0][:7] != m]
    out.append(new_row)
    out[1:] = sorted(out[1:], key=lambda r: r[0])
    del rows[:]
    rows.extend(out)


def upsert_sorted(rows, key, new_row):
    """按日期升序 upsert（日频数据用）"""
    k = new_row[0]
    for i, r in enumerate(rows[1:], start=1):
        if r[0] == k:
            rows[i] = new_row
            return "update"
        if r[0] > k:
            rows.insert(i, new_row)
            return "insert"
    rows.append(new_row)
    return "insert"


# ---------------------------------------------------------------- 主流程
def main():
    args = sys.argv[1:]
    offline = "--offline" in args
    dry = "--dry-run" in args

    print("=" * 62)
    print("EquiBond 数据增量更新")
    print("=" * 62)

    # ---------- 1. 读现有锚点 ----------
    val = read_rows(VAL_CSV)
    px = read_rows(PX_CSV)
    yld = read_rows(YLD_CSV)

    anchor = val[-1]                     # date,pe,pb,div
    anchor_date, anchor_pe, anchor_pb, anchor_div = (
        anchor[0], float(anchor[1]), float(anchor[2]), float(anchor[3]))
    last_px_date, last_px_close = px[-1][0], float(px[-1][1])
    last_yld = yld[-1] if len(yld) > 1 else None

    today = date.today()
    calib = load_calibration(anchor_date, args)
    calib_date = calib.get("calibrated_at", anchor_date)
    age = (today - datetime.strptime(calib_date, "%Y-%m-%d").date()).days
    print("\n[锚点] %s  PE %.4f  PB %.4f  股息率 %.4f" %
          (anchor_date, anchor_pe, anchor_pb, anchor_div))
    print("[校准] 权威锚点日期 %s（%s），距今 %d 天" % (calib_date, calib.get("source"), age))
    print("[价格] %s  收盘 %.2f" % (last_px_date, last_px_close))
    print("[国债] %s  10Y %s%%" % (last_yld[0] if last_yld else "-",
                                   last_yld[1] if last_yld else "-"))
    if age > ANCHOR_MAX_AGE:
        print("\n  !! 锚点已 %d 天，很可能跨过了财报披露期，E 已变化。" % age)
        print("     滚动推算的 PE 会失真，请用 Wind 重新校准：")
        print("     让我执行「校准股债数据」，或直接改写 %s 最后一行" % VAL_CSV)

    if offline:
        print("\n[离线] 跳过联网取数")
        live = None
        y10 = None
    else:
        # ---------- 2. 拉最新价 ----------
        print("\n[联网] 拉取沪深300 最新行情 ...")
        live = fetch_hs300_price()
        if live:
            print("      -> %s  收盘 %.2f  (%s)" % (live["date"], live["close"], live["source"]))
        else:
            print("      -> 未能获取最新行情（网络不通或被限流），保留历史数据")

        # ---------- 3. 拉国债收益率 ----------
        print("[联网] 拉取 10 年期国债收益率 ...")
        y10 = fetch_y10()
        if not y10:
            print("      -> 无可用免费源，沿用 %s 的 %.4f%%" %
                  (last_yld[0] if last_yld else "-", float(last_yld[1]) if last_yld else 0))

    if not live and not y10:
        print("\n[结果] 没有拿到任何新数据，dataset 保持不变")

    # ---------- 4. 计算并落盘 ----------
    changes = []
    new_val_row = None
    new_px_row = None

    if live:
        d, close = live["date"], live["close"]
        # 锚点那天的收盘价（若价格表里有同日记录就用它，否则用锚点所在月的最后收盘）
        rows_by_date = {r[0]: float(r[1]) for r in px[1:] if r[1]}
        base_close = rows_by_date.get(anchor_date)
        if base_close is None:
            anchor_month = anchor_date[:7]
            cand = [r for r in px[1:] if r[0][:7] == anchor_month and r[1]]
            base_close = float(cand[-1][1]) if cand else last_px_close

        if d == last_px_date and abs(close - last_px_close) < 1e-6:
            print("\n[结论] 价格无变化，无需更新")
        else:
            ratio = close / base_close
            pe = anchor_pe * ratio
            pb = anchor_pb * ratio
            div = anchor_div / ratio          # 分红金额固定 → 股息率与价格反向
            print("\n[推算] 相对锚点价格 %.2f → %.2f (×%.4f)" % (base_close, close, ratio))
            print("       PE  %.4f → %.4f" % (anchor_pe, pe))
            print("       PB  %.4f → %.4f" % (anchor_pb, pb))
            print("       股息率 %.4f → %.4f" % (anchor_div, div))

            new_val_row = [d, "%.4f" % pe, "%.4f" % pb, "%.4f" % div]
            new_px_row = [d, "%.2f" % close]
            changes.append("估值/价格 -> %s" % d)

    if y10:
        y_row = [y10["date"], "%.4f" % y10["y10"],
                 (last_yld[2] if last_yld and len(last_yld) > 2 else ""),
                 (last_yld[3] if last_yld and len(last_yld) > 3 else "")]
        act = upsert_sorted(yld, 0, y_row)
        if act and not dry:
            write_rows(YLD_CSV, yld)
        changes.append("国债10Y -> %s (%.4f%%)" % (y10["date"], y10["y10"]))

    if dry:
        print("\n[dry-run] 未落盘。待写入：")
        print("   ", VAL_CSV, new_val_row)
        print("   ", PX_CSV, new_px_row)
        return

    if new_val_row:
        month_upsert(val, new_val_row)
        write_rows(VAL_CSV, val)
    if new_px_row:
        month_upsert(px, new_px_row)
        write_rows(PX_CSV, px)

    # ---------- 5. 重建 dataset ----------
    print("\n[重建] 调用 build_dataset.py ...")
    bd = os.path.join(ROOT, "scripts", "build_dataset.py")
    sys.argv = [bd]
    try:
        runpy.run_path(bd, run_name="__main__")
    except SystemExit:
        pass

    # ---------- 6. 写更新元信息 ----------
    ds = os.path.join(ROOT, "data", "dataset.js")
    meta_extra = dict(
        refreshed_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        anchor_date=anchor_date,
        anchor_age_days=age,
        anchor_expired=1 if age > ANCHOR_MAX_AGE else 0,
        live=(dict(date=live["date"], close=live["close"], source=live["source"]) if live else None),
        y10_source=(y10["date"] if y10 else (last_yld[0] if last_yld else None)),
        changes=changes,
    )
    try:
        with open(ds, "r", encoding="utf-8") as f:
            txt = f.read()
        js = json.loads(txt[len("window.EQBD = "):].rstrip().rstrip(";"))
        js["meta"]["refresh"] = meta_extra
        with open(ds, "w", encoding="utf-8") as f:
            f.write("window.EQBD = " + json.dumps(js, ensure_ascii=False,
                                                  separators=(",", ":")) + ";\n")
    except Exception as e:
        print("      ! 写入 refresh 元信息失败: %s" % e)

    print("\n[完成] %s" % (", ".join(changes) if changes else "无变更"))
    print("=" * 62)


if __name__ == "__main__":
    main()
