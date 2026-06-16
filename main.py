"""
main.py — FastAPI backend for Red Dead Editor.

Serves:
  • /api/health      – liveness probe (includes TTS availability check)
  • /api/evaluate    – evaluate English writing via Gemini
  • /api/rewrite     – rewrite a sentence via Gemini
  • /api/hone        – polish a text passage via Gemini
  • /api/tts         – proxy text-to-speech requests to GPT-SoVITS
  • /                – static frontend (SPA)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import gemini_bridge

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()

GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
BASE_DIR: str = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR: str = os.path.join(BASE_DIR, "frontend")
GPT_SOVITS_URL: str = os.getenv("GPT_SOVITS_URL", "http://127.0.0.1:9880")

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
)

# Allow any origin so the frontend (or external tools) can call the API
# without CORS issues.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------


class EvaluateRequest(BaseModel):
    """Body for POST /api/evaluate."""
    text: str


class RewriteRequest(BaseModel):
    """Body for POST /api/rewrite."""
    sentence: str
    context: str = ""


class HoneRequest(BaseModel):
    """Body for POST /api/hone."""
    text: str


class TTSRequest(BaseModel):
    """Body for POST /api/tts."""
    text: str


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health_check() -> dict:
    """Liveness probe.  Also reports whether the TTS backend is reachable."""
    tts_available = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(GPT_SOVITS_URL)
            tts_available = resp.status_code < 500
    except Exception:
        pass

    return {"status": "ok", "tts_available": tts_available}


@app.post("/api/evaluate")
def evaluate_text_endpoint(req: EvaluateRequest) -> dict:
    """Evaluate English writing for grammar, spelling, style, and vocabulary."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty.")
    
    raw_results = gemini_bridge.evaluate_text(req.text)
    
    if isinstance(raw_results, dict) and "error" in raw_results:
        raise HTTPException(status_code=500, detail=raw_results["error"])
        
    errors = []
    if isinstance(raw_results, list):
        for item in raw_results:
            errors.append({
                "type": item.get("type", "Grammar"),
                "start": item.get("offset", 0),
                "end": item.get("offset", 0) + item.get("length", 0),
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
        raise HTTPException(status_code=500, detail=raw_results["error"])
        
    rewritten = req.sentence
    sentences = []
    if isinstance(raw_results, list):
        sentences = [
            {
                "original": item.get("original", ""),
                "rewritten": item.get("rewritten", ""),
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
        raise HTTPException(status_code=500, detail=raw_results["error"])
        
    honed = req.text
    if isinstance(raw_results, list) and len(raw_results) > 0:
        honed = " ".join([item.get("rewritten", "") for item in raw_results])
        
    return {
        "honed": honed.strip(),
        "improvements": []
    }


@app.post("/api/tts")
async def text_to_speech(req: TTSRequest) -> StreamingResponse:
    """Proxy a TTS request to a locally-running GPT-SoVITS server.

    The audio is streamed back to the client as ``audio/wav``.
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty.")

    # Read the reference prompt text from disk.
    refer_txt_path = os.path.join(BASE_DIR, "refer.txt")
    try:
        with open(refer_txt_path, encoding="utf-8") as fh:
            prompt_text = fh.read().strip()
    except FileNotFoundError:
        logger.error("refer.txt not found at %s", refer_txt_path)
        raise HTTPException(status_code=500, detail="TTS reference text (refer.txt) is missing.")

    payload = {
        "text": req.text,
        "text_lang": "en",
        "ref_audio_path": os.path.join(BASE_DIR, "refer.wav"),
        "prompt_text": prompt_text,
        "prompt_lang": "en",
        "text_split_method": "cut4",
        "media_type": "wav",
        "streaming_mode": False,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{GPT_SOVITS_URL}/tts", json=payload)
            resp.raise_for_status()

        return StreamingResponse(
            content=iter([resp.content]),
            media_type="audio/wav",
        )
    except httpx.ConnectError:
        logger.error("Cannot connect to GPT-SoVITS at %s", GPT_SOVITS_URL)
        raise HTTPException(
            status_code=503,
            detail="TTS service is not available. Is GPT-SoVITS running?",
        )
    except httpx.HTTPStatusError as exc:
        logger.error("GPT-SoVITS returned HTTP %d", exc.response.status_code)
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"TTS service error: {exc.response.text[:500]}",
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
