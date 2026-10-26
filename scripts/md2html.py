# -*- coding: utf-8 -*-
"""
md2html.py —— 把 Markdown 项目文档转成带侧边栏导航的单文件 HTML。

设计要点：
1. 纯标准库，无第三方依赖，任何人拿到仓库都能重新生成。
2. 输出单个自包含 HTML（CSS / JS 全部内联），file:// 双击即可阅读，不联网。
3. 行内解析采用「占位符保护」策略：先抽出 code span 再转义，避免代码里的
   星号、方括号被误当成 Markdown 语法。
4. 代码块高亮用联合正则扫描 + token 化（先切词后转义），不会破坏 HTML 结构。

用法：
    python scripts/md2html.py                     # 默认 PROJECT.md -> PROJECT.html
    python scripts/md2html.py a.md out.html
"""

import io
import os
import re
import sys
from datetime import datetime

# ------------------------------------------------------------------ 工具


def esc(s):
    """HTML 转义。注意 & 必须先于其它替换。"""
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace('"', "&quot;"))


def slugify(title):
    """GitHub 风格锚点：小写、去标点、空格转连字符、保留 CJK。"""
    t = title.lower()
    t = re.sub(r"[^\w\u4e00-\u9fff\u3040-\u30ff\s-]", "", t)
    t = t.strip().replace(" ", "-")
    return t or "sec"


# ------------------------------------------------------------------ 行内语法

def inline(raw):
    """Markdown 行内语法 -> HTML。

    支持的写法：**粗体**、*斜体*、***粗斜***、~~删除线~~、`代码`、
    [文本](链接)、裸 URL 自动链接。
    """
    spans = []

    def stash(code):
        spans.append(code)
        return "\x00CODE%d\x00" % (len(spans) - 1)

    # 1. 抽出行内代码，防止其内部被后续规则命中
    s = re.sub(r"(`+)([\s\S]*?)\1", lambda m: stash(m.group(2)), raw)

    # 2. 转义剩余文本
    s = esc(s)

    # 3. 链接
    s = re.sub(
        r"\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)",
        lambda m: '<a href="%s"%s>%s</a>' % (
            m.group(2),
            ' target="_blank" rel="noopener"' if m.group(2).startswith("http") else "",
            m.group(1) or m.group(2),
        ),
        s,
    )

    # 4. 强调（三斜孤儿的处理：***x*** 视为粗+斜）
    s = re.sub(r"\*\*\*([^\*\n]+?)\*\*\*", r"<strong><em>\1</em></strong>", s)
    s = re.sub(r"\*\*([^\*\n]+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w\*])\*([^\*\n]+?)\*(?![\w\*])", r"<em>\1</em>", s)
    s = re.sub(r"~~([^~\n]+?)~~", r"<del>\1</del>", s)

    # 5. 还原行内代码
    s = re.sub("\x00CODE(\\d+)\x00", lambda m: "<code>%s</code>" % esc(spans[int(m.group(1))]), s)

    # 6. 未被 []() 包裹的裸链接
    s = re.sub(r"(?<![=\"\w])(https?://[^\s<)\]]+)",
               r'<a href="\1" target="_blank" rel="noopener">\1</a>', s)
    return s


# ------------------------------------------------------------------ 代码高亮

KEYWORDS = {
    "python": r"def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|global|assert|async|await",
    "py": r"def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|global|assert",
    "js": r"function|const|let|var|return|if|else|for|while|switch|case|default|new|class|extends|typeof|instanceof|try|catch|finally|throw|delete|void|this|await|async|=>",
    "javascript": r"function|const|let|var|return|if|else|for|while|switch|case|default|new|class|extends|typeof|try|catch|finally|throw|delete|await|async",
    "json": r"true|false|null",
    "bash": r"if|then|else|elif|fi|for|do|done|while|case|esac|export|local|return|function|echo|cd|git|python|pip|curl|source",
    "shell": r"if|then|else|elif|fi|for|do|done|while|case|esac|export|local|return|function|echo|cd|git|python|pip|curl|source",
    "sh": r"if|then|else|elif|fi|for|do|done|while|case|esac|export|local|return|function|echo|cd|git|python|pip|curl",
    "bat": r"set|if|else|exist|for|in|do|echo|call|goto|rem|endlocal|setlocal|exit",
    "batch": r"set|if|else|exist|for|in|do|echo|call|goto|rem|setlocal|exit",
    "sql": r"select|from|where|group|by|order|limit|insert|into|values|update|set|delete|join|left|inner|as|and|or|not",
}
BUILTINS = {
    "python": r"print|len|range|str|int|float|list|dict|set|tuple|open|enumerate|zip|map|filter|sorted|sum|min|max|abs|round|isinstance|datetime|date|json|csv|re|os|sys|urllib| self",
    "py": r"print|len|range|str|int|float|list|dict|set|tuple|open|enumerate|zip|map|filter|sorted|sum|min|max|abs|round|isinstance| self",
    "js": r"console|document|window|Math|Date|Array|Object|String|Number|JSON|Promise|require|module|exports|echarts| undefined| null| true| false",
    "javascript": r"console|document|window|Math|Date|Array|Object|String|Number|JSON|Promise|require|module|exports| undefined| null| true| false",
}
COMMENT = {
    "python": r"#[^\n]*", "py": r"#[^\n]*",
    "js": r"//[^\n]*|/\*[\s\S]*?\*/", "javascript": r"//[^\n]*|/\*[\s\S]*?\*/",
    "json": "", "bash": r"#[^\n]*", "shell": r"#[^\n]*", "sh": r"#[^\n]*",
    "bat": r"rem[^\n]*|::[^\n]*", "batch": r"rem[^\n]*|::[^\n]*",
    "sql": r"--[^\n]*",
}
NO_HL = {"text", "txt", "plain", "csv", "tsv", "md", "markdown", "diff"}


def highlight(code, lang):
    """轻量词法高亮：先切 token，再对每个 token 单独转义并包 <span>。"""
    lang = (lang or "").lower().strip()
    if lang in NO_HL or not lang:
        return esc(code)
    if lang not in KEYWORDS:
        return esc(code)

    parts = []
    if COMMENT.get(lang):
        parts.append(("c", COMMENT[lang]))
    parts.append(("s", r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\''))
    if lang in ("bash", "shell", "sh"):
        parts.insert(0, ("p", r"^[ \t]*[$>][ \t]"))
    kw = KEYWORDS.get(lang)
    if kw:
        parts.append(("k", r"\b(?:%s)\b" % kw))
    bi = BUILTINS.get(lang)
    if bi:
        parts.append(("b", r"\b(?:%s)\b" % bi))
    parts.append(("n", r"\b\d+\.?\d*(?:[eE][+-]?\d+)?\b"))
    parts.append(("f", r"^[ \t]*[\-\*\+][ \t][\w\-]+(?=[ \t]|$)"))  # 命令行/YAML 选项

    scanner = re.compile("|".join("(?P<%s>%s)" % (n, p) for n, p in parts), re.M)
    out = []
    last = 0
    for m in scanner.finditer(code):
        if m.start() > last:
            out.append(esc(code[last:m.start()]))
        kind = m.lastgroup
        txt = m.group()
        cls = {"c": "tk-c", "s": "tk-s", "k": "tk-k", "b": "tk-b",
               "n": "tk-n", "p": "tk-p", "f": "tk-f"}.get(kind, "")
        out.append('<span class="%s">%s</span>' % (cls, esc(txt)))
        last = m.end()
    out.append(esc(code[last:]))
    return "".join(out)


# ------------------------------------------------------------------ 块级解析

LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def parse_blocks(lines):
    """逐行扫描 -> HTML 片段列表。返回 (html, toc_entries)。"""
    html = []
    toc = []
    i = 0
    n = len(lines)

    def take_paragraph(start):
        """收集到空行 / 下一个块级起始为止的连续行。"""
        buf = []
        j = start
        while j < n:
            ln = lines[j]
            if (not ln.strip() or lines[j].startswith("#") or lines[j].startswith("```")
                    or lines[j].startswith(">") or lines[j].strip() in ("---", "***", "___")
                    or LIST_RE.match(ln) or (ln.strip().startswith("|") and j + 1 < n and TABLE_SEP_RE.match(lines[j + 1]))):
                break
            buf.append(ln)
            j += 1
        return buf, j

    while i < n:
        line = lines[i]

        # 空行
        if not line.strip():
            i += 1
            continue

        # 围栏代码块
        if line.startswith("```"):
            lang = line[3:].strip()
            body = []
            i += 1
            while i < n and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1  # 跳过收尾栅栏
            code = "\n".join(body)
            html.append(
                '<div class="code-wrap"><div class="code-head">'
                '<span class="code-lang">%s</span>'
                '<button class="code-copy" type="button">复制</button></div>'
                '<pre class="code"><code>%s</code></pre></div>'
                % (esc(lang or "text"), highlight(code, lang))
            )
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            # 去掉包裹用的行内代码反引号，锚点按纯文本算
            plain = re.sub(r"`([^`]*)`", r"\1", title)
            sid = slugify(plain)
            if level == 1:
                html.append('<h1 id="%s" class="doc-title">%s</h1>' % (sid, inline(title)))
            else:
                html.append('<h%d id="%s">%s</h%d>' % (level, sid, inline(title), level))
                toc.append((level, plain, sid))
            i += 1
            continue

        # 水平分隔线
        if line.strip() in ("---", "***", "___"):
            html.append('<hr>')
            i += 1
            continue

        # 引用块
        if line.lstrip().startswith(">"):
            buf = []
            while i < n and lines[i].lstrip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            inner, _ = parse_blocks(buf)
            html.append('<blockquote>%s</blockquote>' % "".join(inner))
            continue

        # 表格
        if line.strip().startswith("|") and i + 1 < n and TABLE_SEP_RE.match(lines[i + 1]):
            def cells(ln):
                ln = ln.strip()
                if ln.startswith("|"):
                    ln = ln[1:]
                if ln.endswith("|"):
                    ln = ln[:-1]
                return [c.strip() for c in ln.split("|")]

            head = cells(line)
            align_spec = cells(lines[i + 1])
            aligns = []
            for a in align_spec:
                a = a.strip()
                if a.startswith(":") and a.endswith(":"):
                    aligns.append("center")
                elif a.endswith(":"):
                    aligns.append("right")
                else:
                    aligns.append("")
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(cells(lines[i]))
                i += 1

            def render_row(cs, tag):
                out = []
                for k, c in enumerate(cs):
                    st = ' style="text-align:%s"' % aligns[k] if k < len(aligns) and aligns[k] else ""
                    out.append("<%s%s>%s</%s>" % (tag, st, inline(c), tag))
                return "<tr>" + "".join(out) + "</tr>"

            t = ['<div class="table-wrap"><table>', "<thead>" + render_row(head, "th") + "</thead>", "<tbody>"]
            t += [render_row(r, "td") for r in rows]
            t += ["</tbody></table></div>"]
            html.append("".join(t))
            continue

        # 列表
        if LIST_RE.match(line):
            stack = []  # [(indent, ordered)]
            buf = ""

            def close_to(depth):
                nonlocal buf
                while len(stack) > depth:
                    ind, ordered = stack.pop()
                    buf += "</%s>" % ("ol" if ordered else "ul")

            while i < n:
                ln = lines[i]
                m2 = LIST_RE.match(ln)
                if m2:
                    indent = len(m2.group(1).replace("\t", "    "))
                    depth = indent // 2
                    ordered = bool(re.match(r"\d", m2.group(2)))
                    if not stack:
                        stack.append((indent, ordered))
                        buf += '<%s class="lvl0">' % ("ol" if ordered else "ul")
                    else:
                        close_to(depth + 1)
                        if len(stack) == depth:
                            ind, od = stack[-1]
                            if od != ordered:  # 同级下标记切换 -> 换列表类型
                                buf += "</%s>" % ("ol" if od else "ul")
                                stack[-1] = (ind, ordered)
                                buf += '<%s>' % ("ol" if ordered else "ul")
                            stack.append((indent, ordered))
                            buf += '<%s class="nest">' % ("ol" if ordered else "ul")
                        elif len(stack) < depth + 1:
                            stack.append((indent, ordered))
                            buf += '<%s class="nest">' % ("ol" if ordered else "ul")
                    buf += "<li>%s" % inline(m2.group(3))
                    i += 1
                    # 列表项的续行（缩进的非列表文本）
                    while i < n and lines[i].strip() and not LIST_RE.match(lines[i]) \
                            and not lines[i].startswith("#") and not lines[i].startswith("```") \
                            and not lines[i].lstrip().startswith(">"):
                        buf += " " + inline(lines[i].strip())
                        i += 1
                    buf += "</li>"
                    continue
                if ln.strip() and ln.startswith("    "):  # 缩进的代码/表格续块
                    buf += "\n" + inline(ln.strip())
                    i += 1
                    continue
                break
            close_to(0)
            html.append(buf)
            continue

        # 段落
        buf, i = take_paragraph(i)
        if buf:
            html.append("<p>%s</p>" % inline(" ".join(x.strip() for x in buf)))
        else:
            i += 1

    return html, toc


# ------------------------------------------------------------------ 页面模板

CSS = """
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:#f6f7f9;color:#1f2430;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:15px;line-height:1.78;-webkit-font-smoothing:antialiased;
}
#progress{position:fixed;top:0;left:0;height:2.5px;width:0;background:#2f66e0;z-index:60;transition:width .1s linear}

/* ---------- 侧栏 ---------- */
#side{
  position:fixed;top:0;left:0;bottom:0;width:296px;background:#fff;
  border-right:1px solid #e6e8ee;display:flex;flex-direction:column;z-index:50;
}
#side .brand{padding:20px 22px 14px;border-bottom:1px solid #eef0f5}
#side .brand b{display:block;font-size:15.5px;letter-spacing:.2px}
#side .brand span{display:block;margin-top:3px;font-size:11.5px;color:#8a90a0}
#side .brand .home{
  display:inline-block;margin-top:10px;font-size:12px;color:#2f66e0;text-decoration:none;
  background:#eef3ff;border-radius:6px;padding:4px 10px;font-weight:600;
}
#side .brand .home:hover{background:#e2ebff}
#tocsearch{
  margin:12px 16px 8px;padding:7px 11px;border:1px solid #e0e3ea;border-radius:7px;
  font-size:12.5px;outline:none;width:calc(100% - 32px);background:#fafbfc;color:#1f2430;font-family:inherit;
}
#tocsearch:focus{border-color:#2f66e0;background:#fff}
#toc{flex:1;overflow-y:auto;padding:4px 10px 30px}
#toc a{
  display:block;padding:5px 12px 5px 14px;color:#5a6371;text-decoration:none;
  font-size:13px;border-radius:6px;line-height:1.5;border-left:2px solid transparent;
}
#toc a:hover{background:#f3f5f9;color:#1f2430}
#toc a.on{color:#2f66e0;font-weight:600;background:#eef3ff;border-left-color:#2f66e0}
#toc a.h2{font-size:13.4px;font-weight:600;color:#2b3240;margin-top:7px}
#toc a.h3{padding-left:26px}
#toc a.h4{padding-left:38px;font-size:12.4px;color:#7b8393}
#toc a.hide{display:none}
#toc .none{padding:14px;color:#9aa1af;font-size:12.5px}

/* ---------- 正文 ---------- */
#main{margin-left:296px;padding:0 0 120px}
#doc{max-width:940px;margin:0 auto;padding:46px 44px 0}
.doc-title{
  font-size:31px;line-height:1.35;margin:0 0 6px;letter-spacing:-.4px;font-weight:700;
  padding-bottom:20px;border-bottom:2px solid #e6e8ee;
}
#doc h2{
  font-size:23px;margin:52px 0 16px;padding-top:24px;border-top:1px solid #e9ebf0;
  letter-spacing:-.2px;font-weight:700;
}
#doc h3{font-size:17.5px;margin:34px 0 12px;font-weight:650;color:#171b23}
#doc h4{font-size:14.8px;margin:24px 0 10px;font-weight:650;color:#39404e}
#doc h2>.anchor,#doc h3>.anchor,#doc h4>.anchor{
  opacity:0;margin-left:8px;color:#c2c8d4;text-decoration:none;font-weight:400;font-size:.8em;
}
#doc h2:hover>.anchor,#doc h3:hover>.anchor,#doc h4:hover>.anchor{opacity:1}
#doc p{margin:0 0 15px}
#doc ul,#doc ol{margin:0 0 15px;padding-left:24px}
#doc li{margin:5px 0}
#doc li>ul,#doc li>ol{margin:6px 0}
#doc strong{font-weight:650;color:#111520}
#doc a{color:#2f66e0;text-decoration:none;border-bottom:1px solid rgba(47,102,224,.28)}
#doc a:hover{border-bottom-color:#2f66e0}
#doc hr{border:0;border-top:1px solid #e9ebf0;margin:34px 0}
#doc blockquote{
  margin:18px 0;padding:13px 18px;background:#f7f9fc;border-left:3px solid #2f66e0;
  border-radius:0 7px 7px 0;color:#414a5a;font-size:14.2px;
}
#doc blockquote p:last-child{margin-bottom:0}
#doc blockquote blockquote{margin:10px 0 0;background:#fff;border-left-color:#c9d6f5}

/* ---------- 行内代码 & 代码块 ---------- */
code{
  font-family:"SF Mono",Menlo,Consolas,"Courier New",monospace;font-size:.875em;
  background:#f0f2f6;color:#c0342d;padding:1.5px 5px;border-radius:4px;
}
.code-wrap{margin:16px 0;border:1px solid #e3e6ec;border-radius:8px;overflow:hidden;background:#fbfcfe}
.code-head{
  display:flex;align-items:center;justify-content:space-between;padding:6px 12px;
  background:#f3f5f9;border-bottom:1px solid #e6e9ef;
}
.code-lang{font-size:11px;color:#8a90a0;font-weight:600;letter-spacing:.6px;text-transform:uppercase;font-family:Consolas,monospace}
.code-copy{
  border:1px solid #dfe3ea;background:#fff;color:#6b7280;font-size:11.5px;cursor:pointer;
  border-radius:5px;padding:2px 9px;font-family:inherit;transition:.15s;
}
.code-copy:hover{border-color:#2f66e0;color:#2f66e0}
.code-copy.done{border-color:#12a05c;color:#12a05c}
pre.code{
  margin:0;padding:14px 16px;overflow-x:auto;font-size:12.9px;line-height:1.68;
  font-family:"SF Mono",Menlo,Consolas,"Courier New",monospace;color:#2b3240;
  background:transparent;tab-size:4;
}
pre.code code{background:none;padding:0;color:inherit;font-size:inherit;border-radius:0}
.tk-c{color:#8d97a8;font-style:italic}
.tk-s{color:#1a7f52}
.tk-k{color:#a13dbe;font-weight:600}
.tk-b{color:#2f66e0}
.tk-n{color:#b8541f}
.tk-p{color:#c0342d;font-weight:600}
.tk-f{color:#0b7a8a}

/* ---------- 表格 ---------- */
.table-wrap{margin:16px 0;overflow-x:auto;border:1px solid #e3e6ec;border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13.6px;background:#fff}
th,td{padding:9px 13px;border-bottom:1px solid #edeff4;text-align:left;vertical-align:top}
th{background:#f7f9fc;font-weight:650;color:#39404e;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#fafbfe}
td code{font-size:12.4px}

/* ---------- 工具部件 ---------- */
#top-btn{
  position:fixed;right:26px;bottom:26px;width:42px;height:42px;border-radius:50%;
  background:#fff;border:1px solid #e0e3ea;color:#5a6371;cursor:pointer;font-size:17px;
  box-shadow:0 3px 14px rgba(20,30,60,.09);opacity:0;pointer-events:none;transition:.22s;z-index:55;
}
#top-btn.show{opacity:1;pointer-events:auto}
#top-btn:hover{color:#2f66e0;border-color:#2f66e0;transform:translateY(-2px)}
#menu-btn{
  display:none;position:fixed;left:14px;top:14px;z-index:70;width:40px;height:40px;border-radius:9px;
  background:#fff;border:1px solid #e0e3ea;box-shadow:0 2px 10px rgba(20,30,60,.08);
  cursor:pointer;font-size:17px;color:#39404e;
}
@media (max-width:1080px){
  #side{transform:translateX(-100%);transition:transform .24s ease;box-shadow:0 0 30px rgba(20,30,60,.12)}
  #side.open{transform:none}
  #main{margin-left:0}
  #menu-btn{display:block}
  #doc{padding:64px 20px 0}
  .doc-title{font-size:25px}
  #doc h2{font-size:20px}
}
@media print{
  #side,#top-btn,#menu-btn,#progress{display:none}
  #main{margin:0}#doc{max-width:none;padding:0}
  #doc h2{page-break-after:avoid}table,.code-wrap{page-break-inside:avoid}
}
"""

JS = """
(function(){
  var links=[].slice.call(document.querySelectorAll('#toc a'));
  var secs=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1));});
  var search=document.getElementById('tocsearch');
  var main=document.getElementById('main');

  // 1. 目录筛选
  search.addEventListener('input',function(){
    var q=this.value.trim().toLowerCase();
    var hit=0;
    links.forEach(function(a){
      var ok=!q||a.textContent.toLowerCase().indexOf(q)>=0;
      a.classList.toggle('hide',!ok);
      if(ok)hit++;
    });
    document.getElementById('toc-empty').style.display=hit?'none':'block';
  });

  // 2. 滚动高亮当前章节
  var cur=-1;
  function onScroll(){
    var y=window.scrollY+90,idx=-1;
    for(var i=0;i<secs.length;i++){ if(secs[i]&&secs[i].offsetTop<=y) idx=i; }
    if(idx!==cur){
      if(cur>=0&&links[cur])links[cur].classList.remove('on');
      cur=idx;
      if(cur>=0&&links[cur]){
        links[cur].classList.add('on');
        var box=document.getElementById('toc'),r=links[cur].offsetTop;
        if(r<box.scrollTop||r>box.scrollTop+box.clientHeight-60) box.scrollTop=r-120;
      }
    }
    var h=document.documentElement;
    document.getElementById('progress').style.width=
      (h.scrollTop/(h.scrollHeight-h.clientHeight)*100)+'%';
    document.getElementById('top-btn').classList.toggle('show',h.scrollTop>500);
  }
  var tick=false;
  window.addEventListener('scroll',function(){
    if(tick)return;tick=true;
    requestAnimationFrame(function(){onScroll();tick=false;});
  });
  onScroll();

  // 3. 代码块复制（execCommand 优先：file:// 下 clipboard API 可能不可用或悬挂）
  document.querySelectorAll('.code-copy').forEach(function(btn){
    btn.addEventListener('click',function(){
      var txt=btn.parentNode.nextElementSibling.querySelector('code').innerText;
      var done=function(){
        btn.textContent='已复制';btn.classList.add('done');
        setTimeout(function(){btn.textContent='复制';btn.classList.remove('done');},1600);
      };
      var fail=function(){ btn.textContent='复制失败'; setTimeout(function(){btn.textContent='复制';},1600); };
      var okc=false;
      try{
        var ta=document.createElement('textarea');
        ta.value=txt;ta.style.cssText='position:fixed;top:-999px;opacity:0';
        document.body.appendChild(ta);ta.focus();ta.select();
        okc=document.execCommand('copy');
        document.body.removeChild(ta);
      }catch(e){}
      if(okc){done();return;}
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(txt).then(done,fail);
      }else fail();
    });
  });

  // 4. 移动端抽屉
  var side=document.getElementById('side');
  document.getElementById('menu-btn').addEventListener('click',function(){
    side.classList.toggle('open');
  });
  main.addEventListener('click',function(){ side.classList.remove('open'); });

  // 5. 标题锚点
  document.querySelectorAll('#doc h2,#doc h3,#doc h4').forEach(function(h){
    if(!h.id)return;
    var a=document.createElement('a');
    a.className='anchor';a.href='#'+h.id;a.textContent='#';
    h.appendChild(a);
  });
})();
"""


def build(src_path, out_path):
    with io.open(src_path, encoding="utf-8") as f:
        raw = f.read()
    lines = raw.replace("\r\n", "\n").split("\n")
    body, toc = parse_blocks(lines)

    # 生成侧栏目录
    toc_items = []
    for level, title, sid in toc:
        toc_items.append('<a class="h%d" href="#%s">%s</a>' % (min(level, 4), sid, esc(title)))

    mtime = datetime.fromtimestamp(os.path.getmtime(src_path)).strftime("%Y-%m-%d %H:%M")
    doc_title_html = body[0] if body and body[0].startswith("<h1") else "<h1>文档</h1>"

    page = (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
        "<title>EquiBond · 项目文档</title>\n"
        "<style>%s</style>\n</head>\n<body>\n"
        "<div id=\"progress\"></div>\n"
        "<button id=\"menu-btn\" type=\"button\">&#9776;</button>\n"
        "<nav id=\"side\">\n"
        "  <div class=\"brand\">\n"
        "    <b>EquiBond 项目文档</b>\n"
        "    <span>v1.1 ｜ 源件更新于 %s</span>\n"
        "    <a class=\"home\" href=\"index.html\">&larr; 打开系统主页</a>\n"
        "  </div>\n"
        "  <input id=\"tocsearch\" placeholder=\"筛选目录…\" autocomplete=\"off\">\n"
        "  <div id=\"toc\">%s\n"
        "    <div id=\"toc-empty\" class=\"none\" style=\"display:none\">无匹配章节</div>\n"
        "  </div>\n"
        "</nav>\n"
        "<div id=\"main\"><article id=\"doc\">%s</article></div>\n"
        "<button id=\"top-btn\" title=\"回到顶部\">&#8593;</button>\n"
        "<script>%s</script>\n</body>\n</html>\n"
    ) % (CSS, mtime, "\n    ".join(toc_items), "".join(body), JS)

    with io.open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    return len(page), len(toc), src_path


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "PROJECT.md")
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, "PROJECT.html")
    size, ntoc, _ = build(src, dst)
    print("[md2html] %s -> %s" % (os.path.basename(src), os.path.basename(dst)))
    print("[md2html] 目录条目 %d 个 ｜ 输出 %.1f KB" % (ntoc, size / 1024.0))
