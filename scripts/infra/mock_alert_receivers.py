#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OUTPUT = Path('/tmp/umoja-alert-receivers.jsonl')

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length)
        record = {
            'path': self.path,
            'headers': dict(self.headers),
            'body': body.decode('utf-8', errors='replace'),
        }
        with OUTPUT.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(record, sort_keys=True) + '\n')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        if self.path == '/slack':
            self.wfile.write(b'{"ok":true}')
        else:
            self.wfile.write(b'{"status":"accepted"}')

    def log_message(self, fmt, *args):
        return

if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 18080), Handler).serve_forever()
