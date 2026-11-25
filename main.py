"""
main.py — FastAPI backend for Red Dead Editor.

Serves:
  • /api/health      – liveness probe (includes TTS availability check)
  • /api/evaluate    – evaluate English writing via Gemini
  • /api/rewrite     – rewrite a sentence via Gemini
  • /api/hone        – polish a text passage via Gemini
  • /api/tts         – synthesize text-to-speech via Gemini TTS
  • /                – static frontend (SPA)
"""

from __future__ import annotations

from collections import OrderedDict, deque
import logging
import os
from pathlib import Path
import threading
import time

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import gemini_bridge

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()

GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
BASE_DIR: str = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR: str = os.path.join(BASE_DIR, "frontend")
TTS_CACHE_MAX_ITEMS: int = int(os.getenv("TTS_CACHE_MAX_ITEMS", "32"))
_tts_cache: OrderedDict[str, bytes] = OrderedDict()
_tts_cache_lock = threading.Lock()

RATE_LIMIT_PER_MIN: int = int(os.getenv("RATE_LIMIT_PER_MIN", "20"))
RATE_LIMIT_WINDOW_S: float = 60.0
_RATE_LIMITED_PATHS = {"/api/evaluate", "/api/rewrite", "/api/hone", "/api/tts"}
_rate_limit_hits: dict[str, deque[float]] = {}
_rate_limit_lock = threading.Lock()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

if not GEMINI_API_KEY:
    logger.warning("GEMINI_API_KEY is not set — Gemini calls will fail")

# ---------------------------------------------------------------------------
# Gemini bridge module used directly
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Red Dead Editor API",
    description="English writing practice backend powered by Gemini.",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

def _get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def api_guard_and_timing(request: Request, call_next):
    """Enforce per-IP sliding-window rate limits on AI routes and log API latency."""
    path = request.url.path
    if path in _RATE_LIMITED_PATHS and request.method == "POST":
        client_ip = _get_client_ip(request)
        now = time.monotonic()
        cutoff = now - RATE_LIMIT_WINDOW_S
        with _rate_limit_lock:
            if len(_rate_limit_hits) > 512:
                stale_ips = [ip for ip, q in _rate_limit_hits.items() if not q or q[-1] <= cutoff]
                for ip in stale_ips:
                    del _rate_limit_hits[ip]
            timestamps = _rate_limit_hits.get(client_ip)
            if timestamps is None:
                timestamps = deque()
                _rate_limit_hits[client_ip] = timestamps
            while timestamps and timestamps[0] <= cutoff:
                timestamps.popleft()
            if len(timestamps) >= RATE_LIMIT_PER_MIN:
                logger.warning("Rate limit exceeded for %s on %s", client_ip, path)
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Too many requests. Please wait a moment, partner."},
                )
            timestamps.append(now)

    if path.startswith("/api/"):
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logger.info("%s %s -> %d (%.0fms)", request.method, path, response.status_code, elapsed_ms)
        return response

    return await call_next(request)


# Compress JSON/static responses on fallback / direct origins, with CORS outermost.
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://mary-beth.help",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------


class EvaluateRequest(BaseModel):
    """Body for POST /api/evaluate."""
    text: str = Field(..., max_length=8000)


class RewriteRequest(BaseModel):
    """Body for POST /api/rewrite."""
    sentence: str = Field(..., max_length=8000)
    context: str = Field(default="", max_length=8000)


class HoneRequest(BaseModel):
    """Body for POST /api/hone."""
    text: str = Field(..., max_length=8000)


class TTSRequest(BaseModel):
    """Body for POST /api/tts."""
    text: str = Field(..., max_length=8000)


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health_check() -> dict:
    """Liveness probe.  Reports whether Gemini TTS is configured."""
    return {"status": "ok", "tts_available": gemini_bridge.is_tts_configured()}


@app.post("/api/evaluate")
def evaluate_text_endpoint(req: EvaluateRequest) -> dict:
    """Evaluate English writing for grammar, spelling, style, and vocabulary."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty.")
    
    raw_results = gemini_bridge.evaluate_text(req.text)
    
    if isinstance(raw_results, dict) and "error" in raw_results:
        logger.error("Gemini error on %s: %s", req.__class__.__name__, raw_results["error"])
        raise HTTPException(status_code=500, detail="AI service is temporarily unavailable. Please try again.")
        
    errors = []
    if isinstance(raw_results, list):
        for item in raw_results:
            start = item["start"] if "start" in item else item.get("offset", 0)
            end = item["end"] if "end" in item else start + item.get("length", 0)
            errors.append({
                "type": item.get("type", "Grammar"),
                "start": start,
                "end": end,
                "original": item.get("original", ""),
                "suggestion": item.get("replacement", ""),
                "explanation": item.get("reason", "")
            })
    
    score = 100 - (len(errors) * 5)
    score = max(0, score)
    summary = f"Found {len(errors)} issues to correct." if errors else "Your text looks good!"
    
    return {
        "score": score,
        "summary": summary,
        "errors": errors
    }


@app.post("/api/rewrite")
def rewrite_sentence(req: RewriteRequest) -> dict:
    """Rewrite the text (could be single sentence or full article) for clarity and style."""
    if not req.sentence.strip():
        raise HTTPException(status_code=400, detail="Sentence must not be empty.")
    
    raw_results = gemini_bridge.rewrite_text(req.sentence)
    
    if isinstance(raw_results, dict) and "error" in raw_results:
        logger.error("Gemini error on %s: %s", req.__class__.__name__, raw_results["error"])
        raise HTTPException(status_code=500, detail="AI service is temporarily unavailable. Please try again.")
        
    rewritten = req.sentence
    sentences = []
    if isinstance(raw_results, list):
        sentences = [
            {
                "original": (item.get("original") or "").strip(),
                "rewritten": (item.get("rewritten") or "").strip(),
                "explanation": item.get("explanation", "Improved sentence structure and clarity.")
            }
            for item in raw_results
        ]
        if len(raw_results) > 0:
            rewritten = " ".join([item.get("rewritten", "") for item in raw_results])
        
    return {
        "rewritten": rewritten.strip(),
        "explanation": "Rewritten for clarity and flow.",
        "sentences": sentences
    }


@app.post("/api/hone")
def hone_text(req: HoneRequest) -> dict:
    """Refine / polish an entire text passage."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty.")
        
    raw_results = gemini_bridge.hone_text(req.text)
    
    if isinstance(raw_results, dict) and "error" in raw_results:
        logger.error("Gemini error on %s: %s", req.__class__.__name__, raw_results["error"])
        raise HTTPException(status_code=500, detail="AI service is temporarily unavailable. Please try again.")
        
    honed = req.text
    improvements = []
    if isinstance(raw_results, dict):
        paragraphs = raw_results.get("paragraphs")
        if isinstance(paragraphs, list) and len(paragraphs) > 0:
            cleaned_paragraphs = [str(p).strip() for p in paragraphs if str(p).strip()]
            if cleaned_paragraphs:
                honed = "\n\n".join(cleaned_paragraphs)
        elif isinstance(raw_results.get("honed"), str) and raw_results["honed"].strip():
            honed = raw_results["honed"].strip()

        raw_improvements = raw_results.get("improvements")
        if isinstance(raw_improvements, list):
            for imp in raw_improvements:
                if not isinstance(imp, dict):
                    continue
                orig = str(imp.get("original") or "").strip()
                impr = str(imp.get("improved") or "").strip()
                reason = str(imp.get("reason") or "").strip()
                if orig or impr or reason:
                    improvements.append({
                        "original": orig,
                        "improved": impr,
                        "reason": reason,
                    })
    elif isinstance(raw_results, list) and len(raw_results) > 0:
        honed = " ".join([str(item.get("rewritten", "")).strip() for item in raw_results if item.get("rewritten")])

    return {
        "honed": honed.strip(),
        "improvements": improvements
    }


@app.post("/api/tts")
def text_to_speech(req: TTSRequest) -> Response:
    """Synthesize speech via Gemini TTS and return ``audio/wav`` with bounded caching."""
    clean_text = req.text.strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Text must not be empty.")

    cache_key = f"{gemini_bridge.TTS_MODEL}:{gemini_bridge.TTS_VOICE}:{clean_text}"
    with _tts_cache_lock:
        cached = _tts_cache.get(cache_key)
        if cached is not None:
            _tts_cache.move_to_end(cache_key)
            return Response(
                content=cached,
                media_type="audio/wav",
                headers={"Cache-Control": "private, max-age=86400", "X-TTS-Cache": "HIT"},
            )

    try:
        wav_bytes, media_type = gemini_bridge.synthesize_speech(clean_text)
    except Exception as exc:
        logger.error("Gemini TTS synthesis failed: %s", exc)
        raise HTTPException(status_code=503, detail="TTS service is temporarily unavailable.")

    with _tts_cache_lock:
        _tts_cache[cache_key] = wav_bytes
        _tts_cache.move_to_end(cache_key)
        while len(_tts_cache) > TTS_CACHE_MAX_ITEMS:
            _tts_cache.popitem(last=False)

    return Response(
        content=wav_bytes,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=86400", "X-TTS-Cache": "MISS"},
    )

# ---------------------------------------------------------------------------
# Static frontend — MUST be mounted AFTER all /api routes so it doesn't
# shadow them.
# ---------------------------------------------------------------------------


@app.get("/")
async def serve_index() -> FileResponse:
    """Serve the SPA entry point."""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.isfile(index_path):
        raise HTTPException(status_code=404, detail="Frontend not built yet.")
    return FileResponse(index_path)


# Mount the rest of the frontend assets (JS, CSS, images …).
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("Frontend directory %s does not exist — static files will not be served", FRONTEND_DIR)
