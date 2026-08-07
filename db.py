"""SQLite storage for captured Facebook posts.

Data only ever arrives from the Chrome extension as the user scrolls groups
and profiles they already have access to. There is no Facebook API that
exposes group post engagement, so the extension is the only ingest path.
"""

import os
import sqlite3
from contextlib import contextmanager

# Render's free tier has an ephemeral filesystem — set DATA_DIR to a mounted
# persistent disk in production or the database resets on every deploy.
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
DB_PATH = os.path.join(DATA_DIR, "outlier.db")


def storage_is_ephemeral():
    """True when the database will not survive the next deploy.

    Render (and most PaaS free tiers) give each deploy a fresh filesystem.
    A SQLite file written there is destroyed on every push — captures simply
    vanish, with nothing in the UI to explain where they went. Detecting it
    lets the app say so instead of silently losing a user's work.
    """
    if os.environ.get("DATA_DIR"):
        return False   # explicitly pointed at a mounted disk
    # RENDER is set on every Render instance; the generic PORT+no-DATA_DIR
    # combination catches other PaaS hosts running the same way.
    return bool(os.environ.get("RENDER") or os.environ.get("DYNO"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fb_id         TEXT UNIQUE NOT NULL,
    kind          TEXT NOT NULL,          -- 'group' | 'profile' | 'page'
    name          TEXT NOT NULL,
    url           TEXT,
    member_count  INTEGER,
    tracked       INTEGER DEFAULT 1,
    first_seen    TEXT DEFAULT CURRENT_TIMESTAMP,
    last_capture  TEXT
);

CREATE TABLE IF NOT EXISTS authors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fb_id         TEXT UNIQUE,
    name          TEXT NOT NULL,
    profile_url   TEXT
);

CREATE TABLE IF NOT EXISTS posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fb_post_id    TEXT UNIQUE NOT NULL,
    source_id     INTEGER REFERENCES sources(id),
    author_id     INTEGER REFERENCES authors(id),
    body          TEXT,
    permalink     TEXT,
    post_type     TEXT,                   -- reel | photo | video | album | link | text
    posted_at     TEXT,
    likes         INTEGER DEFAULT 0,
    comments      INTEGER DEFAULT 0,
    shares        INTEGER DEFAULT 0,
    video_plays   INTEGER DEFAULT 0,
    captured_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    is_demo       INTEGER DEFAULT 0,
    -- 'post' or 'comment'. Comments are worth collecting — a reply that
    -- outperforms other replies says what the room actually responds to —
    -- but they must never share a baseline with posts, since their
    -- engagement is an order of magnitude smaller.
    item_type     TEXT DEFAULT 'post',
    parent_fb_id  TEXT                    -- for comments: the post they sit under
);

CREATE TABLE IF NOT EXISTS saved (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id       INTEGER UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
    note          TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS remixes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id       INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    angle         TEXT,
    output        TEXT NOT NULL,
    model         TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS captures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     INTEGER REFERENCES sources(id),
    post_count    INTEGER DEFAULT 0,
    new_count     INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Key/value app settings, including the user's AI provider choice and key.
-- Keys are stored as supplied; this database is local and gitignored, but it
-- is plaintext on disk, which the Settings UI states explicitly.
CREATE TABLE IF NOT EXISTS settings (
    key           TEXT PRIMARY KEY,
    value         TEXT,
    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sage_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    role          TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id);
CREATE INDEX IF NOT EXISTS idx_posts_captured ON posts(captured_at);
CREATE INDEX IF NOT EXISTS idx_posts_posted ON posts(posted_at);
"""


@contextmanager
def get_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    # A fresh connection per call, so each server thread owns its own and
    # never trips sqlite3's same-thread check.
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL lets the dashboard keep reading while the extension is writing.
    # Under the default rollback journal a capture batch blocks every page
    # load for its duration, which during a scan is most of the time.
    conn.execute("PRAGMA journal_mode = WAL")
    # Wait for a held write lock rather than failing instantly.
    conn.execute("PRAGMA busy_timeout = 8000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn):
    """Add columns that arrived after a database was first created.

    CREATE TABLE IF NOT EXISTS silently does nothing for an existing table, so
    new columns have to be added explicitly or an upgraded install breaks on
    the first query that mentions them.
    """
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(posts)")}

    if "item_type" not in existing:
        conn.execute("ALTER TABLE posts ADD COLUMN item_type TEXT DEFAULT 'post'")
        conn.execute("UPDATE posts SET item_type = 'post' WHERE item_type IS NULL")
    if "parent_fb_id" not in existing:
        conn.execute("ALTER TABLE posts ADD COLUMN parent_fb_id TEXT")


def upsert_source(conn, fb_id, kind, name, url=None, member_count=None):
    """Insert or refresh a group/profile we're capturing from."""
    conn.execute(
        """
        INSERT INTO sources (fb_id, kind, name, url, member_count, last_capture)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(fb_id) DO UPDATE SET
            name         = excluded.name,
            url          = COALESCE(excluded.url, sources.url),
            member_count = COALESCE(excluded.member_count, sources.member_count),
            last_capture = CURRENT_TIMESTAMP
        """,
        (fb_id, kind, name, url, member_count),
    )
    row = conn.execute("SELECT id FROM sources WHERE fb_id = ?", (fb_id,)).fetchone()
    return row["id"]


def upsert_author(conn, name, fb_id=None, profile_url=None):
    if not name:
        name = "Unknown"
    # Authors inside groups often have no stable id exposed in the DOM, so fall
    # back to name-keyed identity rather than creating a row per capture.
    key = fb_id or f"name:{name}"
    conn.execute(
        """
        INSERT INTO authors (fb_id, name, profile_url)
        VALUES (?, ?, ?)
        ON CONFLICT(fb_id) DO UPDATE SET
            name        = excluded.name,
            profile_url = COALESCE(excluded.profile_url, authors.profile_url)
        """,
        (key, name, profile_url),
    )
    row = conn.execute("SELECT id FROM authors WHERE fb_id = ?", (key,)).fetchone()
    return row["id"]


def upsert_post(conn, source_id, author_id, post):
    """Insert a post, or update its engagement counts if we've seen it before.

    Returns True when the post is new — the caller reports this back to the
    extension so the user can see capture progress.
    """
    existing = conn.execute(
        "SELECT id FROM posts WHERE fb_post_id = ?", (post["fb_post_id"],)
    ).fetchone()

    if existing:
        conn.execute(
            """
            UPDATE posts SET
                likes = ?, comments = ?, shares = ?, video_plays = ?,
                body = COALESCE(NULLIF(?, ''), body),
                updated_at = CURRENT_TIMESTAMP
            WHERE fb_post_id = ?
            """,
            (
                post.get("likes", 0),
                post.get("comments", 0),
                post.get("shares", 0),
                post.get("video_plays", 0),
                post.get("body", ""),
                post["fb_post_id"],
            ),
        )
        return False

    conn.execute(
        """
        INSERT INTO posts (
            fb_post_id, source_id, author_id, body, permalink, post_type,
            posted_at, likes, comments, shares, video_plays, is_demo,
            item_type, parent_fb_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            post["fb_post_id"],
            source_id,
            author_id,
            post.get("body", ""),
            post.get("permalink"),
            post.get("post_type", "text"),
            post.get("posted_at"),
            post.get("likes", 0),
            post.get("comments", 0),
            post.get("shares", 0),
            post.get("video_plays", 0),
            post.get("is_demo", 0),
            post.get("item_type", "post"),
            post.get("parent_fb_id"),
        ),
    )
    return True


def has_any_posts():
    with get_db() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM posts").fetchone()
        return row["n"] > 0


def clear_demo_data():
    """Remove demo posts and any source left with nothing behind it.

    Capture-log rows reference sources, so they have to go first or the source
    delete trips the foreign key. Saved/remix rows hang off posts and cascade
    on their own.
    """
    with get_db() as conn:
        conn.execute("DELETE FROM posts WHERE is_demo = 1")

        orphans = [
            r["id"] for r in conn.execute(
                "SELECT id FROM sources WHERE id NOT IN "
                "(SELECT DISTINCT source_id FROM posts WHERE source_id IS NOT NULL)"
            ).fetchall()
        ]
        for source_id in orphans:
            conn.execute("DELETE FROM captures WHERE source_id = ?", (source_id,))
            conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
