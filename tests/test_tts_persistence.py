"""Tests for persistent SQLite TTS audio caching in storage.py and main.py."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import main  # noqa: E402
import storage  # noqa: E402


class TestTTSPersistence(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_rde.sqlite3"
        self._prev_db_env = os.environ.get("RDE_DB_PATH")
        os.environ["RDE_DB_PATH"] = str(self.db_path)
        storage.init_db(bootstrap_users=("tester",), db_path=self.db_path)
        with main._tts_cache_lock:
            main._tts_cache.clear()
        with main._rate_limit_lock:
            main._rate_limit_hits.clear()

    def tearDown(self) -> None:
        with main._tts_cache_lock:
            main._tts_cache.clear()
        if self._prev_db_env is None:
            os.environ.pop("RDE_DB_PATH", None)
        else:
            os.environ["RDE_DB_PATH"] = self._prev_db_env
        self._tmpdir.cleanup()

    def test_storage_tts_round_trip_and_upsert(self) -> None:
        self.assertIsNone(storage.get_tts_audio("missing-key", db_path=self.db_path))

        storage.save_tts_audio("k1", b"RIFFdemo1", "audio/wav", db_path=self.db_path)
        self.assertEqual(
            storage.get_tts_audio("k1", db_path=self.db_path),
            (b"RIFFdemo1", "audio/wav"),
        )

        # Upsert replaces existing blob and media type cleanly.
        storage.save_tts_audio("k1", b"RIFFdemo2", "audio/mpeg", db_path=self.db_path)
        self.assertEqual(
            storage.get_tts_audio("k1", db_path=self.db_path),
            (b"RIFFdemo2", "audio/mpeg"),
        )

    def test_tts_endpoint_persists_across_memory_cache_clear(self) -> None:
        user = storage.authenticate_username("tester", db_path=self.db_path)
        self.assertIsNotNone(user)
        token = storage.create_session(user["id"], db_path=self.db_path)

        client = TestClient(main.app)
        client.cookies.set(main.SESSION_COOKIE_NAME, token)

        fake_wav = b"RIFF\x00\x00\x00\x00WAVEfmt "
        with patch("gemini_bridge.synthesize_speech", return_value=(fake_wav, "audio/wav")) as mock_tts:
            # 1. Cold miss -> calls Gemini TTS and persists to SQLite + L1 memory.
            r1 = client.post("/api/tts", json={"text": "Howdy, partner."})
            self.assertEqual(r1.status_code, 200)
            self.assertEqual(r1.content, fake_wav)
            self.assertEqual(r1.headers.get("X-TTS-Cache"), "MISS")
            self.assertEqual(mock_tts.call_count, 1)

            # 2. Warm L1 hit -> does not call Gemini TTS.
            r2 = client.post("/api/tts", json={"text": "Howdy, partner."})
            self.assertEqual(r2.status_code, 200)
            self.assertEqual(r2.content, fake_wav)
            self.assertEqual(r2.headers.get("X-TTS-Cache"), "HIT")
            self.assertEqual(mock_tts.call_count, 1)

            # 3. Simulate server restart by clearing L1 in-memory cache -> hits SQLite L2.
            with main._tts_cache_lock:
                main._tts_cache.clear()
            r3 = client.post("/api/tts", json={"text": "Howdy, partner."})
            self.assertEqual(r3.status_code, 200)
            self.assertEqual(r3.content, fake_wav)
            self.assertEqual(r3.headers.get("X-TTS-Cache"), "HIT")
            self.assertEqual(mock_tts.call_count, 1)
            self.assertEqual(len(main._tts_cache), 1)

            # 4. Different sentence -> cache miss -> calls Gemini TTS.
            r4 = client.post("/api/tts", json={"text": "Another sentence."})
            self.assertEqual(r4.status_code, 200)
            self.assertEqual(r4.headers.get("X-TTS-Cache"), "MISS")
            self.assertEqual(mock_tts.call_count, 2)


if __name__ == "__main__":
    unittest.main()
