from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

sys.dont_write_bytecode = True

from werkzeug.serving import make_server

from app import app
from runtime_paths import DATA_DIR


def main() -> None:
    parser = argparse.ArgumentParser(description="Start ModelTrace locally.")
    parser.add_argument("--port", type=int, default=0 if getattr(sys, "frozen", False) else 7860)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    server = make_server("127.0.0.1", args.port, app, threaded=True)
    url = f"http://127.0.0.1:{server.server_port}/"
    print("ModelTrace is ready.", flush=True)
    print(f"URL: {url}", flush=True)
    print(f"Data: {DATA_DIR}", flush=True)
    print("Keep this window open. Close it or press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        timer = threading.Timer(0.5, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
