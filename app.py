"""
Nook — Flask entry point.

Run with:
    python app.py

Then open http://localhost:5000 in your browser.

Rate limiting
-------------
/api/message is limited to 30 requests per minute per IP.
/api/start    is limited to 10 new sessions per minute per IP.
Limits are enforced by Flask-Limiter (in-memory store, fine for a single process).
On a limit hit the handler returns the same JSON error shape the frontend
already understands, so the user sees a friendly "slow down" message.

Session eviction
----------------
A lightweight in-process background thread calls session_store.evict_expired()
every 15 minutes to prevent the SQLite file from growing unboundedly.
"""

import uuid
import threading
import time

from flask import Flask, request, jsonify, send_from_directory
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from workflow import handle_message
from session_store import evict_expired, delete_session
from image_client import generate_image

app = Flask(__name__, static_folder="static")

# ── Rate limiter ──────────────────────────────────────────────────────────
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],          # no global default; apply per-route only
    storage_uri="memory://",
)


@limiter.request_filter
def _exempt_static():
    """Do not rate-limit requests for static assets."""
    return request.path.startswith("/static")


# ── Background session eviction ───────────────────────────────────────────

def _eviction_loop():
    """Runs in a daemon thread — evicts expired sessions every 15 minutes."""
    while True:
        time.sleep(15 * 60)
        try:
            removed = evict_expired()
            if removed:
                app.logger.info("Session eviction: removed %d expired session(s).", removed)
        except Exception as exc:  # noqa: BLE001
            app.logger.warning("Session eviction failed: %s", exc)


_eviction_thread = threading.Thread(target=_eviction_loop, daemon=True, name="session-eviction")
_eviction_thread.start()


# ── Routes ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/start", methods=["POST"])
@limiter.limit("10 per minute")
def start():
    """Creates a new session and returns the first intake question."""
    session_id = str(uuid.uuid4())
    result = handle_message(session_id, "")
    result["session_id"] = session_id
    return jsonify(result)


@app.route("/api/message", methods=["POST"])
@limiter.limit("30 per minute")
def message():
    """Handles a user's message within an existing session."""
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    text       = data.get("message", "")

    if not session_id:
        return jsonify({
            "error": True,
            "retryable": False,
            "reply": "session_id is required.",
        }), 400

    result = handle_message(session_id, text)
    return jsonify(result)


@app.route("/api/reset", methods=["POST"])
def reset():
    """
    Deletes the server-side session so the client can start fresh.
    Called by the '+ New brief' button before /api/start.
    """
    data       = request.get_json(force=True, silent=True) or {}
    session_id = data.get("session_id")
    if session_id:
        delete_session(session_id)
    return jsonify({"ok": True})

@app.route("/api/image", methods=["POST"])
def api_image():
    data = request.get_json()

    prompt = data.get("prompt", "").strip()

    if not prompt:
        return jsonify({
            "success": False,
            "message": "Prompt is required."
        }), 400

    result = generate_image(prompt)

    return jsonify(result)


# ── Error handlers ────────────────────────────────────────────────────────

@app.errorhandler(429)
def handle_rate_limit(exc):
    """Flask-Limiter raises a 429; return JSON so the frontend handles it cleanly."""
    return jsonify({
        "error":     True,
        "retryable": True,
        "reply":     "You're sending messages too quickly. Please slow down a little.",
    }), 429


from werkzeug.exceptions import HTTPException

@app.errorhandler(Exception)
def handle_unexpected(exc):
    # Let Flask handle 404, 405, etc. normally
    if isinstance(exc, HTTPException):
        return exc

    app.logger.exception("Unhandled exception: %s", exc)

    return jsonify({
        "error": True,
        "retryable": False,
        "reply": "An unexpected server error occurred."
    }), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
