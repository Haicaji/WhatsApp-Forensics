#!/usr/bin/env python3
"""Serve only the ShowMesssage frontend without exposing project files."""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
FRONTEND_ROOT = PROJECT_ROOT / "frontend"
HOST = "127.0.0.1"


class ShowMesssageHandler(SimpleHTTPRequestHandler):
    server_version = "ShowMesssage/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.fspath(FRONTEND_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="在本机打开 ShowMesssage 聊天查看器")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    parser.add_argument("--no-open", action="store_true", help="不要自动打开浏览器")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("端口必须在 1 到 65535 之间")

    server = ThreadingHTTPServer((HOST, args.port), ShowMesssageHandler)
    base_url = f"http://{HOST}:{args.port}/"
    print(f"ShowMesssage 已启动：{base_url}")
    print("按 Ctrl+C 停止服务。")

    if not args.no_open:
        threading.Timer(0.45, lambda: webbrowser.open(base_url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
