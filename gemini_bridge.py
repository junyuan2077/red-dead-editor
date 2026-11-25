from __future__ import annotations

import io
import json
import logging
import os
import re
import wave
from typing import Literal

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel

load_dotenv()

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System Prompts
# ---------------------------------------------------------------------------

EVALUATE_SYSTEM_PROMPT = """
You are an expert English writing assistant.
Analyze the provided text for grammatical errors, spelling mistakes, tense inconsistencies, vocabulary weaknesses (such as choosing a more accurate, context-appropriate word or phrase), and stylistic flaws.
Return ONLY a valid JSON array of objects ordered by appearance in the text. Do not include any markdown formatting, preamble, or postamble.

CRITICAL RULES FOR TEXT FRAGMENTS:
1. VERBATIM & NON-EMPTY: "original" MUST be a non-empty, exact verbatim substring copied from the input text (preserve exact spelling, casing, punctuation, and spacing). If a word or punctuation mark is missing, include the adjacent word(s) in "original" and provide the corrected phrase in "replacement".
2. NO OVERLAPPING: Reported "original" fragments MUST NOT overlap.
3. COMBINE ADJACENT ERRORS: If multiple errors occur in the same phrase, share the same words, or are immediately adjacent, you MUST combine them into a single correction object. For example, instead of flagging "explore , where" and "where met" separately, combine them into one "original" fragment like "explore , where met" and provide a unified "replacement".
4. CONTEXT ANCHORS: Provide "context_before" (the exact 1 to 5 words immediately before "original", or "" if at the very start) and "context_after" (the exact 1 to 5 words immediately after "original", or "" if at the very end) copied verbatim from the input so each error can be located unambiguously even if the same word appears multiple times.

Each object must have the following fields:
- "original": The exact, non-empty verbatim text fragment that is incorrect or could be improved.
- "replacement": The suggested correction or more accurate word/phrase (must differ from "original").
- "type": One of "Grammar", "Spelling", "Style", or "Vocabulary". (If combined, choose the most prominent type, e.g., "Vocabulary").
- "reason": A succinct clarification of the error or vocabulary/stylistic improvement.
- "context_before": Exact verbatim text (up to ~30 chars / 1-5 words) immediately preceding "original", or "" if at start.
- "context_after": Exact verbatim text (up to ~30 chars / 1-5 words) immediately following "original", or "" if at end.

If there are no errors, return an empty array [].
""".strip()

REWRITE_SYSTEM_PROMPT = """
You are an expert English writing assistant.
Rewrite the provided text to improve sentence structure, clarity, and pacing so it reads smoothly and naturally.
Return ONLY a valid JSON array of objects. Do not include any markdown formatting, preamble, or postamble.

Each object in the array should represent a logical sentence or phrase and must have the following fields:
- "original": The original sentence or phrase from the source text.
- "rewritten": The rewritten, improved version of the sentence or phrase.
- "explanation": A clear, concise explanation of why this rewrite is an improvement over the original sentence.

The sequence of objects must cover the entire source text from start to finish.
""".strip()

HONE_SYSTEM_PROMPT = """
You are a professional storyteller with a gift for cinematic, atmospheric prose.
Transform the provided text into a vivid, dramatic narrative — elevating language with evocative imagery and rhythm while staying true to the facts, characters, and chronological order of the original.
Romanticism is welcome, but never introduce spoilers, future knowledge, or events not present in the source.
Return ONLY a valid JSON object matching the required schema. Do not include any markdown formatting, preamble, or postamble.

Requirements:
- "paragraphs": An array of strings containing the polished narrative, preserving the paragraph structure of the source text (one entry per paragraph, without dropping or truncating events). Keep the overall length proportional to the original — vivid and well-paced, neither padded nor cut short.
- "improvements": An array of 3 to 6 (or fewer for very short inputs) notable stylistic upgrades that teach the writer how the prose was elevated. Each object must have:
  - "original": A concise verbatim phrase or sentence from the source text.
  - "improved": The corresponding elevated phrase or sentence from your polished narrative.
  - "reason": A brief, clear explanation of how the change improves imagery, word choice, or rhythm.
""".strip()

# ---------------------------------------------------------------------------
# Structured Output Schemas
# ---------------------------------------------------------------------------


class EvaluateErrorItem(BaseModel):
    original: str
    replacement: str
    type: Literal["Grammar", "Spelling", "Style", "Vocabulary"]
    reason: str
    context_before: str = ""
    context_after: str = ""


class RewriteSentence(BaseModel):
    original: str
    rewritten: str
    explanation: str


class HoneImprovement(BaseModel):
    original: str
    improved: str
    reason: str


class HoneResult(BaseModel):
    paragraphs: list[str]
    improvements: list[HoneImprovement]


# ---------------------------------------------------------------------------
# Model Configuration (Google GenAI API)
# ---------------------------------------------------------------------------

EVALUATE_MODEL = os.getenv("GEMINI_EVALUATE_MODEL", "gemini-4-hydrogen")
EVALUATE_THINKING_LEVEL = os.getenv("GEMINI_EVALUATE_THINKING_LEVEL", "LOW")

REWRITE_MODEL = os.getenv("GEMINI_REWRITE_MODEL", "gemini-4-hydrogen")
REWRITE_THINKING_LEVEL = os.getenv("GEMINI_REWRITE_THINKING_LEVEL", "LOW")

HONE_MODEL = os.getenv("GEMINI_HONE_MODEL", "gemini-4-hydrogen")
HONE_THINKING_LEVEL = os.getenv("GEMINI_HONE_THINKING_LEVEL", "LOW")

TTS_MODEL = os.getenv("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
TTS_VOICE = os.getenv("GEMINI_TTS_VOICE", "Leda")
TTS_STYLE_PROMPT = os.getenv(
    "GEMINI_TTS_STYLE_PROMPT",
    "a gentle, slightly bookish young woman in her early twenties with a soft, "
    "soothing voice and a hint of a late-19th-century rural Southern American accent",
)

API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
API_TIMEOUT_MS = int(os.getenv("GEMINI_TIMEOUT_MS", "60000"))
client = (
    genai.Client(api_key=API_KEY, http_options=types.HttpOptions(timeout=API_TIMEOUT_MS))
    if API_KEY
    else None
)


# ---------------------------------------------------------------------------
# Deterministic span anchoring (Python -> UTF-16 JS offsets)
# ---------------------------------------------------------------------------

_VALID_ERROR_TYPES = {
    "grammar": "Grammar",
    "spelling": "Spelling",
    "style": "Style",
    "vocabulary": "Vocabulary",
}

_QUOTE_TRANSLATION = str.maketrans({
    "\u2018": ", u2019: ", "\u201a": ", u201b: ",
    "\u201c": ', u201d: ', "\u201e": ', u201f: ',
    "\u2013": "-", "\u2014": "-", "\u00a0": " ",
})


def _build_py_to_utf16_map(text: str) -> list[int]:
    """Map each Python string index (0..len(text)) to its UTF-16 code-unit offset (JS index)."""
    mapping = [0] * (len(text) + 1)
    u16 = 0
    for i, ch in enumerate(text):
        u16 += 2 if ord(ch) > 0xFFFF else 1
        mapping[i + 1] = u16
    return mapping


def _norm_for_match(s: str) -> str:
    return re.sub(r"\s+", " ", s.translate(_QUOTE_TRANSLATION)).strip().lower()


def _common_suffix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    k = 0
    while k < n and a[-1 - k] == b[-1 - k]:
        k += 1
    return k


def _common_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    k = 0
    while k < n and a[k] == b[k]:
        k += 1
    return k


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def _find_candidates(text: str, original: str) -> list[tuple[int, int, bool]]:
    """Return candidate spans as (py_start, py_end, is_exact)."""
    candidates: list[tuple[int, int, bool]] = []
    start = 0
    while True:
        idx = text.find(original, start)
        if idx == -1:
            break
        candidates.append((idx, idx + len(original), True))
        start = idx + 1

    if candidates:
        return candidates

    # Safe fallback: equivalent quotes/dashes and flexible whitespace only.
    # _QUOTE_TRANSLATION is strictly 1-to-1 so regex match indices map directly to `text`.
    norm_text = text.translate(_QUOTE_TRANSLATION)
    norm_orig = original.translate(_QUOTE_TRANSLATION)
    parts = re.split(r"(\s+)", norm_orig)
    pattern = "".join(r"\s+" if p.isspace() else re.escape(p) for p in parts if p)
    if not pattern:
        return []

    for m in re.finditer(pattern, norm_text):
        candidates.append((m.start(), m.end(), False))

    return candidates


def _context_score(actual: str, expected: str, side: str) -> float:
    exp = _norm_for_match(expected)
    if not exp:
        return 0.0
    act = _norm_for_match(actual)
    if side == "before":
        if act.endswith(exp):
            return 100.0 + len(exp)
        char_overlap = _common_suffix_len(act, exp)
        act_words = re.findall(r"[a-z0-9']+", act)
        exp_words = re.findall(r"[a-z0-9']+", exp)
        word_overlap = 0
        for aw, ew in zip(reversed(act_words), reversed(exp_words)):
            if aw == ew:
                word_overlap += 1
            else:
                break
        return char_overlap * 2.0 + word_overlap * 15.0
    else:
        if act.startswith(exp):
            return 100.0 + len(exp)
        char_overlap = _common_prefix_len(act, exp)
        act_words = re.findall(r"[a-z0-9']+", act)
        exp_words = re.findall(r"[a-z0-9']+", exp)
        word_overlap = 0
        for aw, ew in zip(act_words, exp_words):
            if aw == ew:
                word_overlap += 1
            else:
                break
        return char_overlap * 2.0 + word_overlap * 15.0


def anchor_evaluation_errors(text: str, raw_items: list[dict]) -> list[dict]:
    """Deterministically anchor LLM evaluation items onto `text`.

    Guarantees for every returned item:
      - `start` and `end` are UTF-16 code-unit offsets matching JS String.substring()
      - `original` equals the exact verbatim slice `text[py_start:py_end]` (non-empty)
      - `original != replacement`
      - Returned spans are strictly non-overlapping and sorted by `start`
    """
    if not text or not isinstance(raw_items, list):
        return []

    py_to_utf16 = _build_py_to_utf16_map(text)
    claimed: list[tuple[int, int]] = []
    resolved: list[tuple[int, dict]] = []
    cursor = 0

    for item in raw_items:
        if not isinstance(item, dict):
            continue

        original = item.get("original")
        replacement = item.get("replacement")
        if not isinstance(original, str) or not original:
            continue
        if not isinstance(replacement, str):
            replacement = ""

        candidates = _find_candidates(text, original)
        non_overlapping = [
            (s, e, is_exact)
            for (s, e, is_exact) in candidates
            if not any(s < ce and cs < e for cs, ce in claimed)
        ]

        if not non_overlapping:
            logger.warning("Dropping unanchored or overlapping evaluation fragment: %r", original)
            continue

        ctx_before = item.get("context_before") or ""
        ctx_after = item.get("context_after") or ""
        if not isinstance(ctx_before, str):
            ctx_before = ""
        if not isinstance(ctx_after, str):
            ctx_after = ""

        def _score_candidate(cand: tuple[int, int, bool]) -> tuple:
            s, e, is_exact = cand
            before_win = max(len(ctx_before) + 16, 40)
            after_win = max(len(ctx_after) + 16, 40)
            actual_before = text[max(0, s - before_win):s]
            actual_after = text[e:min(len(text), e + after_win)]

            ctx_score = (
                _context_score(actual_before, ctx_before, "before")
                + _context_score(actual_after, ctx_after, "after")
            )
            # Bonus if LLM explicitly indicated start/end of text with empty context
            if not ctx_before.strip() and not text[:s].strip():
                ctx_score += 20.0
            if not ctx_after.strip() and not text[e:].strip():
                ctx_score += 20.0

            # Word-boundary preference prevents matching e.g. "in" inside "into"
            boundary_score = 0
            if _is_word_char(text[s]):
                boundary_score += 1 if (s == 0 or not _is_word_char(text[s - 1])) else -1
            if _is_word_char(text[e - 1]):
                boundary_score += 1 if (e == len(text) or not _is_word_char(text[e])) else -1

            in_order = 1 if s >= cursor else 0
            return (ctx_score, boundary_score, 1 if is_exact else 0, in_order, -abs(s - cursor))

        best_s, best_e, _ = max(non_overlapping, key=_score_candidate)
        exact_slice = text[best_s:best_e]
        if exact_slice == replacement:
            continue

        claimed.append((best_s, best_e))
        if best_e > cursor:
            cursor = best_e

        u16_start = py_to_utf16[best_s]
        u16_end = py_to_utf16[best_e]
        err_type = _VALID_ERROR_TYPES.get(str(item.get("type", "Grammar")).strip().lower(), "Grammar")

        resolved.append((
            best_s,
            {
                "original": exact_slice,
                "replacement": replacement,
                "type": err_type,
                "reason": item.get("reason", "") or "",
                "start": u16_start,
                "end": u16_end,
                "offset": u16_start,
                "length": u16_end - u16_start,
            },
        ))

    resolved.sort(key=lambda pair: pair[0])
    return [entry for _, entry in resolved]


# ---------------------------------------------------------------------------
# GenAI Request Helper
# ---------------------------------------------------------------------------


def _build_thinking_config(level: str | None) -> types.ThinkingConfig | None:
    if not level or not level.strip():
        return None
    normalized = level.strip().upper()
    try:
        thinking_level = types.ThinkingLevel[normalized]
    except KeyError:
        logger.warning("Unknown thinking level %r; falling back to model default", level)
        return None
    return types.ThinkingConfig(thinking_level=thinking_level)


def _generate_json(
    *,
    model: str,
    system_prompt: str,
    text: str,
    response_schema: object,
    thinking_level: str | None = None,
) -> list[dict] | dict:
    if not client:
        return {"error": "GEMINI_API_KEY not found in environment or client not initialized"}

    config_kwargs: dict = {
        "system_instruction": system_prompt,
        "response_mime_type": "application/json",
        "response_schema": response_schema,
    }
    thinking_config = _build_thinking_config(thinking_level)
    if thinking_config is not None:
        config_kwargs["thinking_config"] = thinking_config

    try:
        response = client.models.generate_content(
            model=model,
            contents=f"Text:\n\"\"\"\n{text}\n\"\"\"",
            config=types.GenerateContentConfig(**config_kwargs),
        )
        raw_text = (response.text or "").strip()
        if not raw_text:
            return {"error": f"Empty response from model {model}"}
        return json.loads(raw_text)
    except json.JSONDecodeError as exc:
        logger.error("JSON parse error from %s: %s", model, exc)
        return {"error": f"Failed to parse {model} output as JSON"}
    except Exception as exc:
        logger.error("Gemini API error (%s): %s", model, exc)
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Public Bridge Functions
# ---------------------------------------------------------------------------


def evaluate_text(text: str) -> list[dict] | dict:
    raw_results = _generate_json(
        model=EVALUATE_MODEL,
        system_prompt=EVALUATE_SYSTEM_PROMPT,
        text=text,
        response_schema=list[EvaluateErrorItem],
        thinking_level=EVALUATE_THINKING_LEVEL,
    )
    if isinstance(raw_results, dict) and "error" in raw_results:
        return raw_results
    if isinstance(raw_results, list):
        return anchor_evaluation_errors(text, raw_results)
    return []


def rewrite_text(text: str) -> list[dict] | dict:
    return _generate_json(
        model=REWRITE_MODEL,
        system_prompt=REWRITE_SYSTEM_PROMPT,
        text=text,
        response_schema=list[RewriteSentence],
        thinking_level=REWRITE_THINKING_LEVEL,
    )


def hone_text(text: str) -> dict:
    return _generate_json(
        model=HONE_MODEL,
        system_prompt=HONE_SYSTEM_PROMPT,
        text=text,
        response_schema=HoneResult,
        thinking_level=HONE_THINKING_LEVEL,
    )


def is_tts_configured() -> bool:
    return client is not None


def _ensure_wav(audio_bytes: bytes, mime_type: str | None) -> bytes:
    """Return valid RIFF WAV bytes, wrapping raw 16-bit mono PCM if needed."""
    if audio_bytes.startswith(b"RIFF"):
        return audio_bytes

    sample_rate = 24000
    if mime_type:
        m = re.search(r"rate=(\d+)", mime_type)
        if m:
            sample_rate = int(m.group(1))

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_bytes)
    return buf.getvalue()


def synthesize_speech(text: str) -> tuple[bytes, str]:
    """Synthesize spoken English audio via Gemini TTS and return (wav_bytes, mime_type)."""
    if not client:
        raise RuntimeError("GEMINI_API_KEY not found in environment or client not initialized")

    clean_text = text.strip()
    if not clean_text:
        raise ValueError("Text must not be empty")

    # Gemini 3.8 Flash TTS treats `text` strictly as verbatim transcript.
    # Pass sustained persona/delivery cues via `part_metadata={"style": ...}`
    # so the style prompt is honored without ever leaking into spoken audio.
    style = TTS_STYLE_PROMPT.strip()
    part = types.Part(
        text=clean_text,
        part_metadata={"style": style} if style else None,
    )

    response = client.models.generate_content(
        model=TTS_MODEL,
        contents=types.Content(role="user", parts=[part]),
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=TTS_VOICE,
                    )
                )
            ),
        ),
    )

    for candidate in response.candidates or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            inline_data = getattr(part, "inline_data", None)
            if inline_data and inline_data.data:
                wav_bytes = _ensure_wav(inline_data.data, inline_data.mime_type)
                return wav_bytes, "audio/wav"

    raise RuntimeError(f"No audio returned by model {TTS_MODEL}")
