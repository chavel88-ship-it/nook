"""
session_store.py — SQLite-backed session persistence for Nook.

Each session is serialised to JSON and stored in a single `sessions` table.
A background cleanup call evicts rows that have not been touched in SESSION_TTL_SECONDS.

Usage
-----
    from session_store import load_session, save_session, delete_session

The SQLite file is created automatically next to this module on first use.
Override the path with the NOOK_DB_PATH environment variable.
"""

import json
import os
import sqlite3
import time
import threading
from workflow import Session  # Session is defined in workflow.py

# ── Config ────────────────────────────────────────────────────────────────
_DB_PATH = os.environ.get(
    "NOOK_DB_PATH",
    os.path.join(os.path.dirname(__file__), "nook_sessions.db"),
)
SESSION_TTL_SECONDS = int(os.environ.get("NOOK_SESSION_TTL", str(60 * 60 * 4)))  # 4 hours

# ── One lock per process so multi-threaded Flask dev server stays safe ──
_lock = threading.Lock()


# ── Schema ────────────────────────────────────────────────────────────────
_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  REAL NOT NULL
);
"""


def _get_conn() -> sqlite3.Connection:
    """Return a thread-local connection (check_same_thread=False is safe with our lock)."""
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.execute(_CREATE_SQL)
    conn.commit()
    return conn


# ── Public API ────────────────────────────────────────────────────────────

def load_session(session_id: str) -> Session:
    """
    Load a session from SQLite.  If the row does not exist, create and persist
    a fresh Session so callers never have to handle None.
    """
    with _lock:
        conn = _get_conn()
        row = conn.execute(
            "SELECT data FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()

        if row is None:
            session = Session(session_id)
            _write(conn, session)
            conn.close()
            return session

        data = json.loads(row[0])
        conn.close()

    session = Session(session_id)
    session.stage            = data.get("stage", "INTAKE")
    session.intake_index     = data.get("intake_index", 0)
    session.answers          = data.get("answers", {})
    session.directions       = data.get("directions", [])
    session.chosen_direction = data.get("chosen_direction")
    session.current_draft    = data.get("current_draft")
    session.refine_count     = data.get("refine_count", 0)
    return session


def save_session(session: Session) -> None:
    """Persist the current state of a Session to SQLite."""
    with _lock:
        conn = _get_conn()
        _write(conn, session)
        conn.close()


def delete_session(session_id: str) -> None:
    """Remove a session row (e.g. when the user starts a new brief)."""
    with _lock:
        conn = _get_conn()
        conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        conn.commit()
        conn.close()


def evict_expired() -> int:
    """Delete sessions older than SESSION_TTL_SECONDS.  Returns the count removed."""
    cutoff = time.time() - SESSION_TTL_SECONDS
    with _lock:
        conn = _get_conn()
        cur = conn.execute(
            "DELETE FROM sessions WHERE updated_at < ?", (cutoff,)
        )
        conn.commit()
        removed = cur.rowcount
        conn.close()
    return removed


# ── Internal helpers ──────────────────────────────────────────────────────

def _write(conn: sqlite3.Connection, session: Session) -> None:
    data = json.dumps({
        "stage":            session.stage,
        "intake_index":     session.intake_index,
        "answers":          session.answers,
        "directions":       session.directions,
        "chosen_direction": session.chosen_direction,
        "current_draft":    session.current_draft,
        "refine_count":     getattr(session, "refine_count", 0),
    })
    conn.execute(
        """
        INSERT INTO sessions (session_id, data, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
        """,
        (session.id, data, time.time()),
    )
    conn.commit()