"""SQLite WAL cloud storage for Red Dead Editor users, sessions, and journal state."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "rde.sqlite3"
DEFAULT_SESSION_TTL_SECONDS = 90 * 86400

USERNAME_RE = re.compile(r"^[a-z0-9_.-]{2,64}$")

DEFAULT_ENTRY_TEXT = (
    "Dear Diary,\n"
    "I think about him constantly. His presence always inflicts a warm, comforting "
    "feeling in my chest. Yesterday, we walked home together and he says something funny "
    "that made me blush. Every one of his small gestures make me forget my own name. "
    "I hope this puppy love is not unrequitted, although I am too shy to ask. The novel "
    "was finished by me last night under the starlight, and tears were shed by my eyes "
    "because the ending was so tragic. I wish I could tell him how I feel, but in my "
    "personal opinion, I think he might already know. His charm is completely "
    "irresistable. Even when he is just reading a book, he looks so handsome. Maybe "
    "tomorrow I will find the courage to talk to him more, rather than just staring "
    "from afar like a secret admirer."
)

_write_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _resolve_db_path(db_path: Path | str | None = None) -> Path:
    if db_path is not None:
        return Path(db_path)
    env_path = os.getenv("RDE_DB_PATH", "").strip()
    return Path(env_path) if env_path else DEFAULT_DB_PATH


def _connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    target = _resolve_db_path(db_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(target.parent, 0o700)
    except OSError:
        pass
    conn = sqlite3.connect(str(target), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def normalize_username(raw: str) -> str:
    """Normalize and validate an account username."""
    username = (raw or "").strip().lower()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError(
            "Username must be 2-64 chars of lowercase letters, digits, '_', '.', or '-'."
        )
    return username


def create_seed_entry() -> dict:
    """Build the default onboarding frontier journal entry."""
    return {
        "id": "seed_crush_diary",
        "title": "June 28, Sunday. Weather: Sunny day (\u6674\u5929)",
        "customTitle": True,
        "text": DEFAULT_ENTRY_TEXT,
        "date": _utc_now_iso(),
        "wordCount": len(DEFAULT_ENTRY_TEXT.split()),
    }


def _insert_user_unlocked(conn: sqlite3.Connection, username: str) -> dict:
    now_iso = _utc_now_iso()
    cur = conn.execute(
        "INSERT INTO users (username, created_at, last_login_at) VALUES (?, ?, NULL)",
        (username, now_iso),
    )
    user_id = int(cur.lastrowid)
    seed_json = json.dumps([create_seed_entry()], ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO user_data (user_id, entries_json, active_session_json, is_fresh_seed, updated_at)
        VALUES (?, ?, NULL, 1, ?)
        """,
        (user_id, seed_json, now_iso),
    )
    return {
        "id": user_id,
        "username": username,
        "created_at": now_iso,
        "last_login_at": None,
    }


def init_db(
    bootstrap_users: tuple[str, ...] = ("arthurtang",),
    db_path: Path | str | None = None,
) -> None:
    """Create database schema and optionally bootstrap initial users if empty."""
    with _write_lock:
        conn = _connect(db_path)
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_login_at TEXT
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

                CREATE TABLE IF NOT EXISTS user_data (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    entries_json TEXT NOT NULL,
                    active_session_json TEXT,
                    is_fresh_seed INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );
                """
            )
            if bootstrap_users:
                row = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()
                if row and int(row["cnt"]) == 0:
                    for raw_name in bootstrap_users:
                        norm = normalize_username(raw_name)
                        _insert_user_unlocked(conn, norm)
            conn.commit()
        finally:
            conn.close()


def create_user(username: str, db_path: Path | str | None = None) -> dict:
    """Provision a new user account with initial seeded ledger data."""
    norm = normalize_username(username)
    with _write_lock:
        conn = _connect(db_path)
        try:
            existing = conn.execute(
                "SELECT id FROM users WHERE username = ?", (norm,)
            ).fetchone()
            if existing:
                raise ValueError(f"User '{norm}' already exists.")
            user = _insert_user_unlocked(conn, norm)
            conn.commit()
            return user
        finally:
            conn.close()


def list_users(db_path: Path | str | None = None) -> list[dict]:
    """Return all provisioned users with entry and active-session counts."""
    now = time.time()
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.created_at,
                u.last_login_at,
                d.entries_json,
                d.is_fresh_seed,
                d.updated_at,
                (
                    SELECT COUNT(*) FROM sessions s
                    WHERE s.user_id = u.id AND s.expires_at > ?
                ) AS active_sessions
            FROM users u
            LEFT JOIN user_data d ON d.user_id = u.id
            ORDER BY u.id ASC
            """,
            (now,),
        ).fetchall()
        out = []
        for r in rows:
            entry_count = 0
            if r["entries_json"]:
                try:
                    parsed = json.loads(r["entries_json"])
                    if isinstance(parsed, list):
                        entry_count = len(parsed)
                except Exception:
                    pass
            out.append(
                {
                    "id": int(r["id"]),
                    "username": r["username"],
                    "created_at": r["created_at"],
                    "last_login_at": r["last_login_at"],
                    "entry_count": entry_count,
                    "is_fresh_seed": bool(r["is_fresh_seed"]) if r["is_fresh_seed"] is not None else True,
                    "updated_at": r["updated_at"],
                    "active_sessions": int(r["active_sessions"] or 0),
                }
            )
        return out
    finally:
        conn.close()


def delete_user(username: str, db_path: Path | str | None = None) -> bool:
    """Delete a user account and cascade all sessions and saved entries."""
    norm = normalize_username(username)
    with _write_lock:
        conn = _connect(db_path)
        try:
            cur = conn.execute("DELETE FROM users WHERE username = ?", (norm,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def revoke_user_sessions(username: str, db_path: Path | str | None = None) -> int:
    """Delete all active sessions for the given username."""
    norm = normalize_username(username)
    with _write_lock:
        conn = _connect(db_path)
        try:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (norm,)).fetchone()
            if not row:
                return 0
            cur = conn.execute("DELETE FROM sessions WHERE user_id = ?", (int(row["id"]),))
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()


def authenticate_username(username: str, db_path: Path | str | None = None) -> dict | None:
    """Verify username exists; if valid, update last_login_at and return user dict."""
    try:
        norm = normalize_username(username)
    except ValueError:
        return None
    with _write_lock:
        conn = _connect(db_path)
        try:
            row = conn.execute(
                "SELECT id, username, created_at, last_login_at FROM users WHERE username = ?",
                (norm,),
            ).fetchone()
            if not row:
                return None
            now_iso = _utc_now_iso()
            conn.execute(
                "UPDATE users SET last_login_at = ? WHERE id = ?",
                (now_iso, int(row["id"])),
            )
            conn.commit()
            return {
                "id": int(row["id"]),
                "username": row["username"],
                "created_at": row["created_at"],
                "last_login_at": now_iso,
            }
        finally:
            conn.close()


def create_session(
    user_id: int,
    ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
    db_path: Path | str | None = None,
) -> str:
    """Create a cryptographically random opaque session cookie token."""
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw_token)
    now = time.time()
    expires_at = now + ttl_seconds
    with _write_lock:
        conn = _connect(db_path)
        try:
            conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            conn.execute(
                """
                INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (token_hash, user_id, now, expires_at, now),
            )
            conn.commit()
            return raw_token
        finally:
            conn.close()


def get_user_by_session(
    raw_token: str | None,
    db_path: Path | str | None = None,
) -> dict | None:
    """Resolve an opaque session token to an authenticated user dict or None."""
    if not raw_token or not isinstance(raw_token, str):
        return None
    token_hash = _hash_token(raw_token)
    now = time.time()
    with _write_lock:
        conn = _connect(db_path)
        try:
            row = conn.execute(
                """
                SELECT u.id, u.username, s.expires_at
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if not row:
                return None
            if float(row["expires_at"]) <= now:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
                conn.commit()
                return None
            conn.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                (now, token_hash),
            )
            conn.commit()
            return {"id": int(row["id"]), "username": row["username"]}
        finally:
            conn.close()


def delete_session(raw_token: str | None, db_path: Path | str | None = None) -> None:
    """Invalidate a single session token on logout."""
    if not raw_token or not isinstance(raw_token, str):
        return
    token_hash = _hash_token(raw_token)
    with _write_lock:
        conn = _connect(db_path)
        try:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            conn.commit()
        finally:
            conn.close()


def get_user_state(user_id: int, db_path: Path | str | None = None) -> dict:
    """Fetch user's entries, active session state, seed flag, and updated_at timestamp."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT entries_json, active_session_json, is_fresh_seed, updated_at
            FROM user_data
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
        if not row:
            conn.close()
            with _write_lock:
                conn2 = _connect(db_path)
                try:
                    now_iso = _utc_now_iso()
                    seed_entries = [create_seed_entry()]
                    conn2.execute(
                        """
                        INSERT OR IGNORE INTO user_data (user_id, entries_json, active_session_json, is_fresh_seed, updated_at)
                        VALUES (?, ?, NULL, 1, ?)
                        """,
                        (user_id, json.dumps(seed_entries, ensure_ascii=False), now_iso),
                    )
                    conn2.commit()
                    return {
                        "entries": seed_entries,
                        "active_session": None,
                        "is_fresh_seed": True,
                        "updated_at": now_iso,
                    }
                finally:
                    conn2.close()

        entries = json.loads(row["entries_json"]) if row["entries_json"] else []
        active_session = (
            json.loads(row["active_session_json"]) if row["active_session_json"] else None
        )
        return {
            "entries": entries if isinstance(entries, list) else [],
            "active_session": active_session if isinstance(active_session, dict) else None,
            "is_fresh_seed": bool(row["is_fresh_seed"]),
            "updated_at": row["updated_at"],
        }
    finally:
        conn.close()


def save_user_state(
    user_id: int,
    *,
    entries: list | None = None,
    active_session: dict | None = None,
    has_active_session: bool = False,
    db_path: Path | str | None = None,
) -> str:
    """Atomically save updated journal entries and/or active workspace session."""
    now_iso = _utc_now_iso()
    with _write_lock:
        conn = _connect(db_path)
        try:
            row = conn.execute(
                "SELECT entries_json, active_session_json FROM user_data WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if not row:
                new_entries_json = json.dumps(entries if entries is not None else [], ensure_ascii=False)
                new_session_json = (
                    json.dumps(active_session, ensure_ascii=False)
                    if (has_active_session and active_session is not None)
                    else None
                )
                conn.execute(
                    """
                    INSERT INTO user_data (user_id, entries_json, active_session_json, is_fresh_seed, updated_at)
                    VALUES (?, ?, ?, 0, ?)
                    """,
                    (user_id, new_entries_json, new_session_json, now_iso),
                )
            else:
                set_clauses = ["is_fresh_seed = 0", "updated_at = ?"]
                params: list = [now_iso]
                if entries is not None:
                    set_clauses.append("entries_json = ?")
                    params.append(json.dumps(entries, ensure_ascii=False))
                if has_active_session:
                    set_clauses.append("active_session_json = ?")
                    params.append(
                        json.dumps(active_session, ensure_ascii=False)
                        if active_session is not None
                        else None
                    )
                params.append(user_id)
                conn.execute(
                    f"UPDATE user_data SET {', '.join(set_clauses)} WHERE user_id = ?",
                    params,
                )
            conn.commit()
            return now_iso
        finally:
            conn.close()
