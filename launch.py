#!/usr/bin/env python3
"""
launch.py — Orchestrator for Red Dead Editor.

Starts (optionally) the GPT-SoVITS TTS server and the FastAPI backend,
streams their output with colour-coded prefixes, and ensures graceful
shutdown when any child exits or a signal is received.

Usage:
    python launch.py
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
from typing import IO

# ---------------------------------------------------------------------------
# ANSI colour helpers
# ---------------------------------------------------------------------------

_RED = "\033[91m"
_BLUE = "\033[94m"
_RESET = "\033[0m"
_BOLD = "\033[1m"


def _coloured(prefix: str, colour: str) -> str:
    """Return a colour-coded prefix string."""
    return f"{colour}{_BOLD}[{prefix}]{_RESET} "


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GPT_SOVITS_API = os.path.join(BASE_DIR, "backend", "GPT-SoVITS", "api_v2.py")
GPT_SOVITS_PORT = 9880
FASTAPI_PORT = 8000

# TTS model assets — expected to live alongside this script.
TTS_CKPT = os.path.join(BASE_DIR, "charlotte-e15.ckpt")
TTS_PTH = os.path.join(BASE_DIR, "charlotte_e8_s112.pth")
REFER_WAV = os.path.join(BASE_DIR, "refer.wav")
REFER_TXT = os.path.join(BASE_DIR, "refer.txt")

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

_children: list[subprocess.Popen] = []
_shutting_down = False


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _stream_output(stream: IO[str] | None, prefix: str) -> None:
    """Read lines from *stream* and print them with a coloured prefix.

    Runs in a daemon thread so it does not block the main thread.
    """
    if stream is None:
        return
    try:
        for line in stream:
            print(f"{prefix}{line}", end="", flush=True)
    except ValueError:
        # Stream closed — expected during shutdown.
        pass


def _wait_for_port(port: int, timeout: float = 30.0) -> bool:
    """Block until *port* is accepting connections or *timeout* expires."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1.0):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def _shutdown(signum: int | None = None, _frame: object = None) -> None:
    """Terminate all child processes gracefully."""
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    sig_name = signal.Signals(signum).name if signum else "manual"
    print(f"\n{_BOLD}>>> Shutting down ({sig_name})…{_RESET}", flush=True)

    for proc in reversed(_children):
        if proc.poll() is None:
            print(f"    Terminating PID {proc.pid}…", flush=True)
            proc.terminate()

    # Give children a moment to exit, then force-kill.
    for proc in reversed(_children):
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            print(f"    Force-killing PID {proc.pid}", flush=True)
            proc.kill()


def _start_streaming(proc: subprocess.Popen, prefix: str) -> None:
    """Spin up daemon threads to stream *proc*'s stdout and stderr."""
    for stream in (proc.stdout, proc.stderr):
        t = threading.Thread(target=_stream_output, args=(stream, prefix), daemon=True)
        t.start()


# ---------------------------------------------------------------------------
# Process launchers
# ---------------------------------------------------------------------------


def _start_tts() -> subprocess.Popen | None:
    """Launch the GPT-SoVITS API server if the script and assets exist.

    Returns the ``Popen`` handle, or ``None`` if skipped.
    """
    if not os.path.isfile(GPT_SOVITS_API):
        print(f"{_coloured('TTS', _RED)}api_v2.py not found — skipping TTS server")
        return None

    # Read reference prompt text.
    refer_text = ""
    if os.path.isfile(REFER_TXT):
        with open(REFER_TXT, encoding="utf-8") as fh:
            refer_text = fh.read().strip()
    else:
        print(f"{_coloured('TTS', _RED)}refer.txt not found — TTS may not work correctly")

    cmd = [
        sys.executable,
        GPT_SOVITS_API,
        "-s", TTS_CKPT,
        "-g", TTS_PTH,
        "-dr", REFER_WAV,
        "-dt", refer_text,
        "-dl", "en",
    ]

    print(f"{_coloured('TTS', _RED)}Starting GPT-SoVITS…")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=os.path.dirname(GPT_SOVITS_API),
    )
    _children.append(proc)
    _start_streaming(proc, _coloured("TTS", _RED))

    print(f"{_coloured('TTS', _RED)}Waiting for port {GPT_SOVITS_PORT}…")
    if _wait_for_port(GPT_SOVITS_PORT):
        print(f"{_coloured('TTS', _RED)}GPT-SoVITS ready ✓")
    else:
        print(f"{_coloured('TTS', _RED)}⚠  Port {GPT_SOVITS_PORT} not ready after 30 s — continuing anyway")

    return proc


def _start_fastapi() -> subprocess.Popen:
    """Launch the FastAPI server via uvicorn."""
    cmd = [
        sys.executable, "-m", "uvicorn",
        "main:app",
        "--host", "0.0.0.0",
        "--port", str(FASTAPI_PORT),
    ]

    print(f"{_coloured('API', _BLUE)}Starting FastAPI…")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=BASE_DIR,
    )
    _children.append(proc)
    _start_streaming(proc, _coloured("API", _BLUE))
    return proc


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    """Entry point — start services and block until shutdown."""
    # Register signal handlers for graceful shutdown.
    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f"{_BOLD}{'=' * 60}{_RESET}")
    print(f"{_BOLD}  Red Dead Editor — Launcher{_RESET}")
    print(f"{_BOLD}{'=' * 60}{_RESET}\n")

    tts_proc = _start_tts()
    api_proc = _start_fastapi()

    print(f"\n{_BOLD}>>> All services launched.  Press Ctrl+C to stop.{_RESET}\n")

    # Monitor children — shut everything down if any exits unexpectedly.
    try:
        while not _shutting_down:
            for proc in _children:
                ret = proc.poll()
                if ret is not None and not _shutting_down:
                    name = "GPT-SoVITS" if proc is tts_proc else "FastAPI"
                    print(f"\n{_BOLD}>>> {name} exited with code {ret} — shutting down{_RESET}")
                    _shutdown()
                    sys.exit(ret)
            time.sleep(0.5)
    except KeyboardInterrupt:
        _shutdown()

    sys.exit(0)


if __name__ == "__main__":
    main()
