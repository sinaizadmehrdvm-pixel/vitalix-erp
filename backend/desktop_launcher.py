import json
import multiprocessing
import os
import secrets
import socket
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from app.network_config import load_network_config
from app.version import APP_VERSION


def bundle_path(*parts):
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return root.joinpath(*parts)


def data_directory():
    base = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    target = Path(base) / "VetrixERP"
    target.mkdir(parents=True, exist_ok=True)
    (target / "backups").mkdir(exist_ok=True)
    (target / "uploads").mkdir(exist_ok=True)
    return target


def load_or_create_secret(target):
    config_file = target / "desktop-config.json"
    config = {}
    if config_file.exists():
        try:
            config = json.loads(config_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            config = {}
    secret = str(config.get("jwt_secret") or "")
    if len(secret) < 32:
        secret = secrets.token_urlsafe(48)
        config["jwt_secret"] = secret
        config_file.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return secret


def configure_environment(network):
    target = data_directory()
    os.environ.setdefault("VETRIX_ENV", "desktop")
    os.environ.setdefault("VETRIX_JWT_SECRET", load_or_create_secret(target))
    os.environ["VETRIX_ALLOWED_ORIGINS"] = ",".join(network.allowed_origins)
    database = (target / "vetrix.db").resolve().as_posix()
    os.environ.setdefault("VETRIX_DATABASE_URL", f"sqlite:///{database}")
    os.environ.setdefault("VETRIX_BACKUP_DIR", str(target / "backups"))
    os.chdir(target)
    return target


class SpaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(
            *args,
            directory=str(bundle_path("frontend_dist")),
            **kwargs,
        )

    def do_GET(self):
        requested = self.path.split("?", 1)[0].split("#", 1)[0]
        local = bundle_path("frontend_dist", requested.lstrip("/"))
        if requested != "/" and not local.exists():
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, format, *args):
        if os.getenv("VETRIX_VERBOSE") == "1":
            super().log_message(format, *args)


def assert_port_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError as error:
            raise RuntimeError(
                f"Port {port} is already in use. Close the other VITALIX instance and retry."
            ) from error


def run_web_server(network):
    server = ThreadingHTTPServer((network.bind_host, network.web_port), SpaHandler)
    server.serve_forever()


def open_browser_when_ready(network):
    url = network.local_url
    for _ in range(60):
        try:
            with socket.create_connection(
                (network.browser_host, network.web_port), timeout=0.2
            ):
                if os.getenv("VETRIX_NO_BROWSER") != "1":
                    webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.25)


def main():
    multiprocessing.freeze_support()
    network = load_network_config()
    target = configure_environment(network)
    assert_port_available(network.bind_host, network.api_port)
    assert_port_available(network.bind_host, network.web_port)

    from main import app
    import uvicorn

    web_thread = threading.Thread(
        target=run_web_server,
        args=(network,),
        name="vetrix-web",
        daemon=True,
    )
    web_thread.start()
    threading.Thread(
        target=open_browser_when_ready,
        args=(network,),
        name="vetrix-browser",
        daemon=True,
    ).start()

    print("=" * 58)
    print(f"VITALIX ERP {APP_VERSION}")
    print(f"Application: {network.local_url}")
    print(f"Mode: {'LAN server' if network.lan_enabled else 'local only'}")
    if network.lan_enabled:
        print("Allowed client URLs:")
        for origin in network.allowed_origins:
            print(f"  {origin}")
    print(f"Data folder: {target}")
    print("Keep this window open while using VITALIX.")
    print("=" * 58)
    uvicorn.run(
        app,
        host=network.bind_host,
        port=network.api_port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"VITALIX failed to start: {error}")
        if os.getenv("VETRIX_NO_PAUSE") != "1":
            input("Press Enter to close...")
        raise
