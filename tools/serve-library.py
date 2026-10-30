#!/usr/bin/env python3
"""Serve a folder (a MEGAjam library, or any static build) to MEGAjam on this machine.

    python3 tools/serve-library.py path/to/folder [--port 8780]

Adds the headers a page on another origin (MEGAjam on GitHub Pages) needs to read it: CORS, and Chrome's
private/local network access opt-in for pages reaching http://localhost. Only listens on this machine.
"""
import argparse
import functools
import http.server


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("folder")
    ap.add_argument("--port", type=int, default=8780)
    a = ap.parse_args()
    Handler.extensions_map[".wasm"] = "application/wasm"
    Handler.extensions_map[".js"] = "text/javascript"
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), functools.partial(Handler, directory=a.folder))
    print(f"Serving {a.folder} to MEGAjam at http://localhost:{a.port}/  (Control-C to stop)")
    server.serve_forever()


if __name__ == "__main__":
    main()
