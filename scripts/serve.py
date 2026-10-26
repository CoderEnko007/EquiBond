#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EquiBond · 手机访问服务（局域网）

在电脑上起一个静态文件服务，手机连同一个 WiFi，用浏览器打开打印出来的地址就能看。
只服务项目目录内的文件，不对外网开放。

用法：
    python scripts/serve.py                # 默认 8765 端口，自动打开电脑浏览器
    python scripts/serve.py --port 8000    # 换端口
    python scripts/serve.py --no-open      # 不自动打开浏览器
    python scripts/serve.py --no-qr        # 不打印二维码

提示：
  * 首次运行 Windows 会弹防火墙提示，请勾选「专用网络」并允许访问。
  * 已关闭浏览器缓存，手机刷新即可拿到最新数据。
  * 手机与电脑必须在同一个 WiFi / 路由器下。
"""

import argparse
import http.server
import socket
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# 网络信息
# --------------------------------------------------------------------------
def lan_ips():
    """本机在局域网里的 IPv4 地址，主网卡排在最前。"""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))          # 只查路由表，不会真的发包
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return [ip for ip in ips if not ip.startswith(("127.", "169.254."))]


def qr_ascii(text):
    """把 URL 画成终端二维码；没装 qrcode 库就返回 None。"""
    try:
        import qrcode
    except ImportError:
        return None
    q = qrcode.QRCode(border=2)
    q.add_data(text)
    q.make(fit=True)
    m = q.get_matrix()
    lines = []
    for row in m:
        lines.append("".join("██" if cell else "  " for cell in row))
    return lines


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # 手机端最怕看到几天前的缓存，一律不缓存
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 控制台只报错误，正常访问不刷屏
        code = str(args[1]) if len(args) > 1 else ""
        if code.startswith(("4", "5")):
            sys.stderr.write("  [%s] %s\n" % (code, args[0] if args else ""))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def bind(port, tries=12):
    """端口被占用时顺延，返回 (server, port)。"""
    for p in range(port, port + tries):
        try:
            return Server(("", p), Handler), p
        except OSError:
            continue
    raise SystemExit("端口 %d~%d 都被占用，请用 --port 指定其它端口。" % (port, port + tries - 1))


def main():
    ap = argparse.ArgumentParser(description="EquiBond 手机 / 局域网访问服务")
    ap.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    ap.add_argument("--no-open", action="store_true", help="不自动打开电脑浏览器")
    ap.add_argument("--no-qr", action="store_true", help="不打印二维码")
    args = ap.parse_args()

    httpd, port = bind(args.port)
    local = "http://127.0.0.1:%d/" % port
    ips = lan_ips()
    phones = ["http://%s:%d/" % (ip, port) for ip in ips]

    line = "=" * 58
    print()
    print(line)
    print("  EquiBond · 手机访问已启动")
    print(line)
    print("  本机浏览器   %s" % local)
    if phones:
        for i, url in enumerate(phones):
            print("  手机访问     %s%s" % (url, "   <= 用这个" if i == 0 else ""))
    else:
        print("  手机访问     没有检测到局域网地址，请确认已连上 WiFi / 网线")
    print()
    print("  手机需要和这台电脑连同一个 WiFi，然后在手机浏览器里输入上面的地址。")
    print("  打不开时依次检查：① 同一 WiFi  ② Windows 防火墙允许 Python 访问专用网络")
    print("                    ③ 路由器是否开了「AP 隔离」")
    print("  按 Ctrl+C 结束服务。")
    print(line)

    if not args.no_qr and phones:
        art = qr_ascii(phones[0])
        if art:
            print("\n  用手机相机 / 微信扫下面这个码直接打开：\n")
            for row in art:
                print("   " + row)
            print()
        else:
            print("\n  （装了 qrcode 库就能在这里显示二维码：pip install qrcode）\n")

    sys.stdout.flush()

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(local)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止服务。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
