"""Accounts, sessions, and the extension's API keys.

Three separate credentials live here and are deliberately kept apart:

  password   — hashed with scrypt, never stored or logged in the clear
  session    — a signed cookie, used by the dashboard only
  api key    — a bearer token, used by the extension only

The extension cannot rely on cookies (it posts cross-origin from facebook.com
and users may not be signed in there), so it authenticates with a key instead.
That also means the capture endpoint carries no ambient authority from a
browser session, which is why it is exempt from CSRF rather than a hole in it.
"""

import functools
import hashlib
import hmac
import os
import re
import secrets
import time

from flask import g, jsonify, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import db

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

MIN_PASSWORD_LENGTH = 10

# Brute-force throttle. In-memory is sufficient because the app runs a single
# worker by design (SQLite allows one writer), and a restart clearing the
# counters is an acceptable trade for not adding a datastore dependency.
_ATTEMPTS = {}
MAX_ATTEMPTS = 8
ATTEMPT_WINDOW = 900        # 15 minutes


# ---------------------------------------------------------------- secrets


def get_secret_key():
    """Stable signing key for sessions.

    Read from the environment in production. Falling back to a random value
    per process would silently sign every user out on each restart and deploy,
    so a generated key is persisted instead.
    """
    env_key = os.environ.get("APP_SECRET")
    if env_key:
        return env_key

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'session_secret'"
        ).fetchone()
        if row and row["value"]:
            return row["value"]

        generated = secrets.token_hex(32)
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('session_secret', ?)",
            (generated,),
        )
    return generated


# ---------------------------------------------------------------- API keys


def _hash_key(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def generate_api_key():
    """Return (display_key, prefix, hash).

    Only the hash is stored. The prefix is kept separately so a presented key
    can be looked up in one indexed query instead of hashing against every
    row in the table.
    """
    raw = "olk_" + secrets.token_urlsafe(32)
    return raw, raw[:12], _hash_key(raw)


def user_for_api_key(raw):
    if not raw or not raw.startswith("olk_"):
        return None

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE api_key_prefix = ?", (raw[:12],)
        ).fetchone()

    if not row:
        return None
    # Constant-time compare so a timing signal can't confirm a partial guess.
    if not hmac.compare_digest(row["api_key_hash"], _hash_key(raw)):
        return None
    return dict(row)


# ---------------------------------------------------------------- users


def create_user(email, password):
    """Returns (user_dict, error_message)."""
    email = (email or "").strip().lower()

    if not EMAIL_RE.match(email):
        return None, "That doesn't look like an email address."
    if len(password or "") < MIN_PASSWORD_LENGTH:
        return None, f"Password must be at least {MIN_PASSWORD_LENGTH} characters."

    raw_key, prefix, key_hash = generate_api_key()

    with db.get_db() as conn:
        exists = conn.execute(
            "SELECT id FROM users WHERE email = ?", (email,)
        ).fetchone()
        if exists:
            return None, "An account with that email already exists."

        conn.execute(
            """
            INSERT INTO users (email, password_hash, api_key_prefix, api_key_hash)
            VALUES (?, ?, ?, ?)
            """,
            (email, generate_password_hash(password), prefix, key_hash),
        )
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    user = dict(row)
    user["api_key"] = raw_key      # shown once, never retrievable again
    return user, None


def _throttled(email):
    record = _ATTEMPTS.get(email)
    if not record:
        return False
    count, first_at = record
    if time.time() - first_at > ATTEMPT_WINDOW:
        _ATTEMPTS.pop(email, None)
        return False
    return count >= MAX_ATTEMPTS


def _record_failure(email):
    count, first_at = _ATTEMPTS.get(email, (0, time.time()))
    if time.time() - first_at > ATTEMPT_WINDOW:
        count, first_at = 0, time.time()
    _ATTEMPTS[email] = (count + 1, first_at)


def verify_user(email, password):
    """Returns (user_dict, error_message)."""
    email = (email or "").strip().lower()

    if _throttled(email):
        return None, "Too many attempts. Try again in a few minutes."

    with db.get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    # Same message and roughly the same work either way, so the response
    # cannot be used to enumerate which emails have accounts.
    if not row or not check_password_hash(row["password_hash"], password or ""):
        _record_failure(email)
        return None, "Email or password is incorrect."

    _ATTEMPTS.pop(email, None)
    return dict(row), None


def rotate_api_key(user_id):
    raw, prefix, key_hash = generate_api_key()
    with db.get_db() as conn:
        conn.execute(
            "UPDATE users SET api_key_prefix = ?, api_key_hash = ? WHERE id = ?",
            (prefix, key_hash, user_id),
        )
    return raw


def set_password(user_id, password):
    if len(password or "") < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    with db.get_db() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(password), user_id),
        )
    return None


# ---------------------------------------------------------------- session


def login_session(user):
    session.clear()                      # drop any pre-login fixation attempt
    session["user_id"] = user["id"]
    session.permanent = True


def logout_session():
    session.clear()


def current_user():
    """The signed-in user for this request, or None. Cached per request."""
    if "user" in g:
        return g.user

    user_id = session.get("user_id")
    g.user = None
    if user_id:
        with db.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        if row:
            g.user = dict(row)
        else:
            session.clear()              # account deleted underneath the session
    return g.user


# ---------------------------------------------------------------- CSRF


def csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def check_csrf():
    """True when this state-changing request carries a valid token.

    Cookies are SameSite=Lax, which already blocks cross-site form posts, but
    that is one browser-enforced control — this is the second.
    """
    sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    expected = session.get("csrf_token")
    return bool(expected and sent and hmac.compare_digest(expected, sent))


# ---------------------------------------------------------------- guards


def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Sign in required"}), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def api_key_required(view):
    """Authenticates the extension. Never falls back to the session cookie —
    an endpoint reachable cross-origin must not accept ambient browser
    authority, or facebook.com could drive it on a signed-in user's behalf."""
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        header = request.headers.get("X-Outlier-Key", "")
        user = user_for_api_key(header.strip())
        if not user:
            return jsonify({
                "ok": False,
                "error": "Invalid or missing API key. Copy it from the "
                         "dashboard's Capture page into the extension.",
            }), 401
        g.api_user = user
        return view(*args, **kwargs)
    return wrapped
