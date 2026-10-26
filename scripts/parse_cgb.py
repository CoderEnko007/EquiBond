import json, os, sys, glob, collections

RAW = r"g:/Projects/workbuddy projects/EquiBond/data/raw"
TMP = r"g:/Projects/workbuddy projects/EquiBond/data/tmp"

def walk(obj, out):
    if isinstance(obj, dict):
        if "YTM_END_DATE" in obj:
            out.append(obj)
        else:
            for v in obj.values():
                walk(v, out)
    elif isinstance(obj, list):
        for v in obj:
            walk(v, out)

def load(path):
    txt = open(path, "r", encoding="utf-8").read()
    try:
        return json.loads(txt)
    except Exception:
        # 兼容多段 JSON 拼接
        objs = []
        dec = json.JSONDecoder()
        i = 0
        while i < len(txt):
            while i < len(txt) and txt[i] in " \r\n\t":
                i += 1
            if i >= len(txt):
                break
            try:
                o, j = dec.raw_decode(txt, i)
            except Exception:
                break
            objs.append(o)
            i = j
        return objs

records = []
files = sorted(glob.glob(os.path.join(TMP, "yr*.json")))
for f in files:
    walk(load(f), records)

rows = {}
for r in records:
    d = str(r.get("YTM_END_DATE", "")).strip()
    if len(d) != 8 or not d.isdigit():
        continue
    date = "%s-%s-%s" % (d[:4], d[4:6], d[6:8])
    def num(k):
        v = r.get(k)
        if v is None or v == "" or v == "-":
            return ""
        try:
            return repr(round(float(v), 4))
        except Exception:
            return ""
    y10, y1, y30 = num("YTM_YIELD_10Y"), num("YTM_YIELD_1Y"), num("YTM_YIELD_30Y")
    if y10 == "" and y1 == "" and y30 == "":
        continue
    if date in rows:  # 同日期保留最后出现，并补空列
        old = rows[date]
        rows[date] = [date, y10 or old[1], y1 or old[2], y30 or old[3]]
    else:
        rows[date] = [date, y10, y1, y30]

ordered = sorted(rows.values())
os.makedirs(RAW, exist_ok=True)
with open(os.path.join(RAW, "cgb_yield_daily.csv"), "w", encoding="utf-8", newline="") as f:
    f.write("date,y10,y1,y30\n")
    for r in ordered:
        f.write("%s,%s,%s,%s\n" % tuple(r))

cnt = collections.Counter(r[0][:4] for r in ordered)
print("files:", [os.path.basename(x) for x in files])
print("total_rows:", len(ordered))
print("range:", ordered[0][0], "->", ordered[-1][0])
for y in sorted(cnt):
    print(y, cnt[y])

vals = [(float(r[1]), r[0]) for r in ordered if r[1] != ""]
mn, mx = min(vals), max(vals)
print("y10 min:", mn, " y10 max:", mx)
print("missing_years:", [str(y) for y in range(2012, 2027) if str(y) not in cnt])
print("blank_y1:", sum(1 for r in ordered if r[2] == ""), "blank_y30:", sum(1 for r in ordered if r[3] == ""))
