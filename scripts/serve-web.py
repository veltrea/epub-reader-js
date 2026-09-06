#!/usr/bin/env python3
"""ブラウザで src/ を検証するための静的サーバ。

    ./scripts/serve-web.py            # http://127.0.0.1:8000/src/index.html
    ./scripts/serve-web.py 8080       # ポートを変える

**リポジトリのルートを配信する**（`src/` ではない）。ブラウザ経路の `api.readBook` が
`test-books/` を `src/app/` から2つ上として引くため、ルートを下げると本が読めなくなる。

**`Cache-Control: no-store` を必ず返す。** ES modules はブラウザが強く握るので、
素の `python3 -m http.server` だと直したはずのコードで検証してしまう。実際に
`api.readBook` の修正が反映されず、404 の HTML を EPUB として渡していた（2026-08-10）。
リロードしても直らず、原因を掴むまで遠回りになる。
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404 だけ出す。200 を全部流すと本文の取得でログが埋まる。
        if args and str(args[1]).startswith("4"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {ROOT}")
        print(f"  http://127.0.0.1:{port}/src/index.html")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
