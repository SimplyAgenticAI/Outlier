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
import sqlite3
import time
from datetime import datetime, timedelta, timezone

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

# Signups from one address, over the same window. Login was throttled and
# registration was not, so the one endpoint that CREATES rows was the one
# anybody could hit in a loop — each account carrying its own API key and its
# own free-tier allowance. Keyed by address rather than by email, since the
# attacker picks the email.
_SIGNUPS = {}
MAX_SIGNUPS = 5


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


def admin_emails():
    """Addresses that should always hold admin, from ADMIN_EMAILS.

    Applied at sign-in as well as registration, so an existing account can be
    promoted by setting the variable and signing in again — no SQL required.
    """
    raw = os.environ.get("ADMIN_EMAILS", "")
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def create_user(email, password, username=None):
    """Returns (user_dict, error_message).

    The username is chosen here rather than later. It is how other accounts
    see this one, and an account that exists before its name does forces the
    question at some worse moment — which is what it did: the prompt lived on
    the feedback board, so people met it in the middle of reporting a bug.
    """
    email = (email or "").strip().lower()
    username = (username or "").strip()

    if not EMAIL_RE.match(email):
        return None, "That doesn't look like an email address."
    if len(password or "") < MIN_PASSWORD_LENGTH:
        return None, f"Password must be at least {MIN_PASSWORD_LENGTH} characters."

    # Validated before anything is written, so a bad name cannot leave an
    # account half-created.
    if username:
        problem = db.username_error(username)
        if problem:
            return None, problem

    raw_key, prefix, key_hash = generate_api_key()

    with db.get_db() as conn:
        exists = conn.execute(
            "SELECT id FROM users WHERE email = ?", (email,)
        ).fetchone()
        if exists:
            return None, "An account with that email already exists."
        if username:
            taken = conn.execute(
                "SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (username,)
            ).fetchone()
            if taken:
                return None, "That username is taken."

        # The first account on an instance is its owner, and any address in
        # ADMIN_EMAILS is too. Admins are never metered — the person running
        # the thing should not be told they've hit a plan limit.
        first_account = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0
        is_admin = 1 if (first_account or email in admin_emails()) else 0

        try:
            conn.execute(
                """
                INSERT INTO users (email, password_hash, api_key_prefix, api_key_hash,
                                   is_admin, username)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (email, generate_password_hash(password), prefix, key_hash,
                 is_admin, username or None),
            )
        except sqlite3.IntegrityError:
            # The unique index is the real arbiter. The check above narrows the
            # window; two people submitting the same name in the same instant
            # still land here, and they get a message rather than a traceback.
            return None, "That username is taken."
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    user = dict(row)
    user["api_key"] = raw_key      # shown once, never retrievable again

    # Tell the owner somebody arrived. Outside the transaction above and
    # swallowed on failure, because a notification that cannot be written is
    # not a reason to fail a signup the user has already completed.
    if not first_account:
        try:
            db.notify_admins(
                "signup",
                "New account: " + email,
                body="Signed up just now.",
                url="/admin",
            )
        except Exception:
            pass

    return user, None


def signup_throttled(ip):
    """True when this address has created its allowance of accounts.

    Counted on success, not on attempt: a failed signup is usually somebody
    mistyping their password or rediscovering they already have an account,
    and locking them out for fifteen minutes over that would be its own bug.
    """
    if not ip:
        return False
    count, first_at = _SIGNUPS.get(ip, (0, 0))
    if time.time() - first_at > ATTEMPT_WINDOW:
        _SIGNUPS.pop(ip, None)
        return False
    return count >= MAX_SIGNUPS


def record_signup(ip):
    if not ip:
        return
    count, first_at = _SIGNUPS.get(ip, (0, time.time()))
    if time.time() - first_at > ATTEMPT_WINDOW:
        count, first_at = 0, time.time()
    _SIGNUPS[ip] = (count + 1, first_at)


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
    user = dict(row)

    # Promote on sign-in too, so adding an address to ADMIN_EMAILS takes
    # effect for an account that already exists.
    if email in admin_emails() and not user.get("is_admin"):
        with db.get_db() as conn:
            conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (user["id"],))
        user["is_admin"] = 1

    return user, None


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
        # Any reset link still in an inbox is now stale. Somebody who knows the
        # current password has demonstrated control of the account, and an
        # unspent link sitting in email is a second key to it.
        conn.execute(
            "UPDATE password_resets SET used_at = CURRENT_TIMESTAMP "
            "WHERE user_id = ? AND used_at IS NULL", (user_id,),
        )
    return None


# ------------------------------------------------------------ password reset


# Long enough to walk to another device and read an email, short enough that a
# link found later in a shared inbox is already dead.
RESET_TTL_MINUTES = 60

# Per email address, over the standard window. Without this the form is a way
# to have somebody's inbox filled on request.
MAX_RESETS = 5
_RESETS = {}


def reset_throttled(email):
    email = (email or "").strip().lower()
    count, first_at = _RESETS.get(email, (0, 0))
    if time.time() - first_at > ATTEMPT_WINDOW:
        _RESETS.pop(email, None)
        return False
    return count >= MAX_RESETS


def _record_reset(email):
    count, first_at = _RESETS.get(email, (0, time.time()))
    if time.time() - first_at > ATTEMPT_WINDOW:
        count, first_at = 0, time.time()
    _RESETS[email] = (count + 1, first_at)


def create_reset_token(email):
    """Issue a one-time reset token. Returns (raw_token, user) or (None, None).

    (None, None) means no account — and the caller must NOT say so. A reset
    form that answers differently for a known and an unknown address is a way
    to test which emails have accounts here.

    Only the hash is stored, for the same reason only the hash of an API key
    is: reading the table must not yield a working link into every account.
    """
    email = (email or "").strip().lower()
    if not email or reset_throttled(email):
        return None, None

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row:
        return None, None

    _record_reset(email)

    raw = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(minutes=RESET_TTL_MINUTES)

    with db.get_db() as conn:
        # One live link at a time. Requesting a new one has to retire the old,
        # or every request ever made stays usable until it expires.
        conn.execute(
            "UPDATE password_resets SET used_at = CURRENT_TIMESTAMP "
            "WHERE user_id = ? AND used_at IS NULL", (row["id"],),
        )
        conn.execute(
            "INSERT INTO password_resets (user_id, token_hash, expires_at) "
            "VALUES (?, ?, ?)",
            (row["id"], _hash_key(raw), expires.strftime("%Y-%m-%d %H:%M:%S")),
        )

    return raw, dict(row)


def _live_reset(conn, raw):
    """The unused, unexpired reset row for this token, or None."""
    if not raw:
        return None
    row = conn.execute(
        "SELECT * FROM password_resets WHERE token_hash = ?", (_hash_key(raw),)
    ).fetchone()
    if not row or row["used_at"]:
        return None
    # Compared as strings, both written as UTC 'YYYY-MM-DD HH:MM:SS'.
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    if row["expires_at"] <= now:
        return None
    return row


def reset_token_valid(raw):
    """Whether a link is still good, for deciding which page to render."""
    with db.get_db() as conn:
        return _live_reset(conn, raw) is not None


def mark_reset_delivered(raw):
    with db.get_db() as conn:
        conn.execute(
            "UPDATE password_resets SET delivered = 1 WHERE token_hash = ?",
            (_hash_key(raw),),
        )


def consume_reset_token(raw, password):
    """Spend a reset link on a new password. Returns (user_id, error).

    The token is checked before the password is validated, so a short password
    does not burn the link — the user gets to try again on the same one.
    """
    with db.get_db() as conn:
        row = _live_reset(conn, raw)

    if not row:
        return None, ("That reset link has expired or already been used. "
                      "Request a new one.")

    if len(password or "") < MIN_PASSWORD_LENGTH:
        return None, f"Password must be at least {MIN_PASSWORD_LENGTH} characters."

    with db.get_db() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(password), row["user_id"]),
        )
        # Single use, and every sibling link dies with it.
        conn.execute(
            "UPDATE password_resets SET used_at = CURRENT_TIMESTAMP "
            "WHERE user_id = ? AND used_at IS NULL", (row["user_id"],),
        )

    # Whoever was locked out is now the one who can get in. Clearing the
    # failed-attempt counter stops the throttle from meeting them at the door
    # with "too many attempts" straight after a successful reset.
    with db.get_db() as conn:
        user = conn.execute("SELECT email FROM users WHERE id = ?",
                            (row["user_id"],)).fetchone()
    if user:
        _ATTEMPTS.pop(user["email"], None)

    return row["user_id"], None


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
