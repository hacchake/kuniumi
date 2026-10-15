# KUNIUMI 用のローカルサーバー。
# 標準の http.server と同じだが、ブラウザに古いファイルを使い回させないよう no-cache を付ける。
# 使い方: py serve.py [ポート]（既定 5194）
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5194
    print(f'KUNIUMI: http://localhost:{port}/')
    http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
