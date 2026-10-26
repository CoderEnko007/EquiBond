# -*- coding: utf-8 -*-
"""
EquiBond 数据构建管道

把 data/raw/ 下的三个原始 CSV 合并对齐成月度面板 dataset.js，供前端直接加载。

输入（均由 Wind / 腾讯自选股 MCP 拉取）:
  hs300_valuation_monthly.csv : date,pe,pb,div        沪深300 月末 PE / PB / 股息率(%)
  hs300_price_monthly.csv     : date,close            沪深300 月线收盘价
  cgb_yield_daily.csv         : date,y10,y1,y30       银行间国债收益率曲线 日频(%)

输出:
  data/dataset.js  ->  window.EQBD = { meta, rows:[ {m,d,pe,pb,div,close,y10,y1,y30,ok} ] }

用法:
  python scripts/build_dataset.py
"""

import csv
import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "dataset.js")


def read_csv(name):
    path = os.path.join(RAW, name)
    if not os.path.exists(path):
        sys.exit("[x] 缺少原始文件: %s" % path)
    with open(path, "r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    print("  载入 %-32s %4d 行" % (name, len(rows)))
    return rows


def fval(v):
    """转 float，失败返回 None"""
    if v is None:
        return None
    v = str(v).strip()
    if v == "" or v in ("-", "nan", "None", "null"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def month_key(d):
    return d[:7]


def main():
    print("[1/3] 读取原始数据")
    val_rows = read_csv("hs300_valuation_monthly.csv")
    px_rows = read_csv("hs300_price_monthly.csv")
    yld_rows = read_csv("cgb_yield_daily.csv")

    # ---- 指数估值: 月末 → 最新一条 ----
    val_by_month = {}
    for r in val_rows:
        d = r["date"].strip()
        val_by_month[month_key(d)] = dict(
            d=d, pe=fval(r["pe"]), pb=fval(r["pb"]), div=fval(r["div"])
        )

    # ---- 指数收盘价: 月 → 最后一条 ----
    px_by_month = {}
    for r in px_rows:
        d = r["date"].strip()
        px_by_month[month_key(d)] = dict(d=d, close=fval(r["close"]))

    # ---- 国债收益率: 取每月最后一条日频观测 ----
    yld_by_month = {}
    for r in yld_rows:
        d = r["date"].strip()
        key = month_key(d)
        # date 升序，后写覆盖 → 月末值
        yld_by_month[key] = dict(
            d=d,
            y10=fval(r.get("y10")),
            y1=fval(r.get("y1")),
            y30=fval(r.get("y30")),
        )

    # ---- 对齐 ----
    # 面板以「有收盘价」的月份为骨架，向前回溯到最早的估值/收益率月份之前，
    # 以便第一个可用月份也能算出收益（需要上月收盘价做分母）。
    all_months = sorted(set(px_by_month) | set(val_by_month) | set(yld_by_month))
    val_months = sorted(k for k in val_by_month if val_by_month[k]["pe"])
    yld_months = sorted(k for k in yld_by_month if yld_by_month[k]["y10"] is not None)
    start = max(val_months[0], yld_months[0])
    all_months = [m for m in all_months if m >= "2011-01"]

    rows = []
    for m in all_months:
        v = val_by_month.get(m, {})
        p = px_by_month.get(m, {})
        y = yld_by_month.get(m, {})
        ok = (
            v.get("pe") is not None
            and v.get("div") is not None
            and p.get("close") is not None
            and y.get("y10") is not None
        )
        rows.append(
            dict(
                m=m,
                d=(v.get("d") or p.get("d") or y.get("d") or m + "-01"),
                pe=v.get("pe"),
                pb=v.get("pb"),
                div=v.get("div"),
                close=p.get("close"),
                y10=y.get("y10"),
                y1=y.get("y1"),
                y30=y.get("y30"),
                ok=1 if ok else 0,
            )
        )

    usable = [r for r in rows if r["ok"]]
    if not usable:
        sys.exit("[x] 没有可用的对齐月份，检查原始数据")

    meta = dict(
        generated=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        index="沪深300 (000300.SH)",
        price_fields="月线收盘价",
        valuation_source="Wind 指数加权口径 PE/PB/股息率(月末最后交易日)",
        yield_source="银行间国债收益率曲线 10年期(月末最后交易日)",
        months_total=len(rows),
        months_usable=len(usable),
        range=[usable[0]["m"], usable[-1]["m"]],
        latest=dict(
            date=usable[-1]["d"],
            pe=usable[-1]["pe"],
            pb=usable[-1]["pb"],
            div=usable[-1]["div"],
            y10=usable[-1]["y10"],
            close=usable[-1]["close"],
        ),
    )

    print("[2/3] 对齐完成  可用月份 %d  区间 %s ~ %s" % (len(usable), meta["range"][0], meta["range"][1]))

    payload = "window.EQBD = " + json.dumps(
        dict(meta=meta, rows=rows), ensure_ascii=False, separators=(",", ":")
    ) + ";\n"

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(payload)

    size = os.path.getsize(OUT)
    print("[3/3] 输出 %s  (%.1f KB)" % (OUT, size / 1024.0))

    latest = meta["latest"]
    ep = 100.0 / latest["pe"]
    erp = ep - latest["y10"]
    print("\n当前读数 (%s):" % latest["date"])
    print("  沪深300 PE      %.2f" % latest["pe"])
    print("  盈利收益率 E/P  %.2f%%" % ep)
    print("  10年期国债YTM   %.2f%%" % latest["y10"])
    print("  股息率          %.2f%%" % latest["div"])
    print("  股权风险溢价ERP %.2f pct" % erp)


if __name__ == "__main__":
    main()
