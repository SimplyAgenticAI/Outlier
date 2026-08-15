"""SQLite storage for captured Facebook posts.

Data only ever arrives from the Chrome extension as the user scrolls groups
and profiles they already have access to. There is no Facebook API that
exposes group post engagement, so the extension is the only ingest path.
"""

import os
import re
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
CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    email                 TEXT UNIQUE NOT NULL,
    password_hash         TEXT NOT NULL,
    -- Bearer token for the extension. Only the hash is kept; the prefix is a
    -- lookup handle so a presented key resolves in one indexed query.
    api_key_prefix        TEXT UNIQUE,
    api_key_hash          TEXT,
    plan                  TEXT DEFAULT 'free',        -- free | pro
    billing_interval      TEXT,                       -- month | year
    stripe_customer_id    TEXT,
    stripe_subscription_id TEXT,
    subscription_status   TEXT,                       -- active | past_due | canceled
    current_period_end    TEXT,
    is_admin              INTEGER DEFAULT 0,
    created_at            TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_keyprefix ON users(api_key_prefix);

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
    parent_fb_id  TEXT,                   -- for comments: the post they sit under
    image_url     TEXT,                   -- primary visual, for the card thumbnail
    image_count   INTEGER DEFAULT 0,
    has_video     INTEGER DEFAULT 0
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

-- Per-user configuration (AI provider, key, model). Separate from `settings`,
-- which stays global and holds app-level values such as the session secret.
CREATE TABLE IF NOT EXISTS user_settings (
    user_id       INTEGER NOT NULL,
    key           TEXT NOT NULL,
    value         TEXT,
    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key)
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
    # NORMAL is the correct durability level under WAL for a web app: it drops a
    # disk sync on every commit — a large throughput gain for the write-heavy
    # capture path when many users scan at once — and cannot corrupt the file.
    # The only exposure is losing the last transaction on a power loss, and
    # captured posts are re-capturable, so that trade is right.
    conn.execute("PRAGMA synchronous = NORMAL")
    # Keep the scoring reads (which scan every post) off disk under load: a
    # larger page cache, memory-mapped reads, and in-memory temp sorts.
    conn.execute("PRAGMA cache_size = -16000")        # ~16 MB per connection
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA mmap_size = 134217728")      # 128 MB, shared mapping
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


def _columns(conn, table):
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn):
    """Bring an existing database up to the current schema.

    CREATE TABLE IF NOT EXISTS silently does nothing for a table that already
    exists, so anything added later has to be applied here or an upgraded
    install breaks on the first query that mentions it.
    """
    post_cols = _columns(conn, "posts")

    if "item_type" not in post_cols:
        conn.execute("ALTER TABLE posts ADD COLUMN item_type TEXT DEFAULT 'post'")
        conn.execute("UPDATE posts SET item_type = 'post' WHERE item_type IS NULL")
    if "parent_fb_id" not in post_cols:
        conn.execute("ALTER TABLE posts ADD COLUMN parent_fb_id TEXT")
    for column, ddl in (
        ("image_url", "TEXT"),
        ("image_count", "INTEGER DEFAULT 0"),
        ("has_video", "INTEGER DEFAULT 0"),
        # Set when the body was read out of the graphic's alt text rather than
        # typed by the author, so the card can say so instead of implying the
        # poster wrote it.
        ("body_from_image", "INTEGER DEFAULT 0"),
        # 1 = a count was actually found, 0 = none were. NULL for rows captured
        # before the flag existed, whose provenance genuinely isn't known.
        ("engagement_read", "INTEGER"),
    ):
        if column not in post_cols:
            conn.execute(f"ALTER TABLE posts ADD COLUMN {column} {ddl}")

    _migrate_multi_user(conn)


# Tables that gained an owner when the app became multi-user.
_OWNED_TABLES = ("sources", "posts", "saved", "remixes", "sage_messages", "captures")


def _migrate_multi_user(conn):
    """Scope every row to a user, and make identity uniqueness per-user.

    fb_id and fb_post_id were globally unique, which is wrong the moment two
    accounts exist: both may legitimately capture the same public group, and
    the second insert would be treated as a duplicate of the first — silently
    overwriting another account's row. Uniqueness has to be (user_id, fb_id).

    Each table is checked on its own. An earlier version short-circuited the
    whole function when `sources` already had user_id, so any table added to
    _OWNED_TABLES afterwards never got its column on a database that had
    already migrated — `captures` shipped that way and every /capture load
    died on "no such column: c.user_id".
    """
    existing = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}

    added = []
    for table in _OWNED_TABLES:
        if table in existing and "user_id" not in _columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER")
            added.append(table)

    # Pre-existing data belongs to whoever was already using this install, so
    # it is handed to the first account rather than orphaned. If no account
    # exists yet, the first registration claims it (see claim_unowned_data).
    if added:
        owner = conn.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
        if owner:
            for table in added:
                conn.execute(
                    f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL",
                    (owner["id"],)
                )

    if _needs_scoped_uniqueness(conn):
        _rebuild_with_scoped_uniqueness(conn)


def _needs_scoped_uniqueness(conn):
    """True while sources/posts still carry the old global UNIQUE constraint.

    Read from the stored DDL rather than a column check — the column can exist
    (ALTER TABLE above adds it) while the constraint is still global.
    """
    for table in ("sources", "posts"):
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", (table,)
        ).fetchone()
        if not row or not row["sql"]:
            continue
        ddl = re.sub(r"\s+", "", row["sql"]).upper()
        if "UNIQUE(USER_ID," not in ddl:
            return True
    return False


def _rebuild_with_scoped_uniqueness(conn):
    """Recreate sources and posts so their unique keys include user_id.

    SQLite cannot drop a UNIQUE constraint in place, so the table is rebuilt
    and the rows copied across.
    """
    conn.execute("PRAGMA foreign_keys = OFF")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sources_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER,
            fb_id         TEXT NOT NULL,
            kind          TEXT NOT NULL,
            name          TEXT NOT NULL,
            url           TEXT,
            member_count  INTEGER,
            tracked       INTEGER DEFAULT 1,
            first_seen    TEXT DEFAULT CURRENT_TIMESTAMP,
            last_capture  TEXT,
            UNIQUE(user_id, fb_id)
        );
        INSERT INTO sources_new (id, user_id, fb_id, kind, name, url, member_count,
                                 tracked, first_seen, last_capture)
            SELECT id, user_id, fb_id, kind, name, url, member_count,
                   tracked, first_seen, last_capture FROM sources;
        DROP TABLE sources;
        ALTER TABLE sources_new RENAME TO sources;

        CREATE TABLE IF NOT EXISTS posts_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER,
            fb_post_id    TEXT NOT NULL,
            source_id     INTEGER,
            author_id     INTEGER,
            body          TEXT,
            permalink     TEXT,
            post_type     TEXT,
            posted_at     TEXT,
            likes         INTEGER DEFAULT 0,
            comments      INTEGER DEFAULT 0,
            shares        INTEGER DEFAULT 0,
            video_plays   INTEGER DEFAULT 0,
            captured_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
            is_demo       INTEGER DEFAULT 0,
            item_type     TEXT DEFAULT 'post',
            parent_fb_id  TEXT,
            image_url     TEXT,
            image_count   INTEGER DEFAULT 0,
            has_video     INTEGER DEFAULT 0,
            body_from_image INTEGER DEFAULT 0,
            engagement_read INTEGER,
            UNIQUE(user_id, fb_post_id)
        );
        INSERT INTO posts_new (id, user_id, fb_post_id, source_id, author_id, body,
                               permalink, post_type, posted_at, likes, comments,
                               shares, video_plays, captured_at, updated_at,
                               is_demo, item_type, parent_fb_id)
            SELECT id, user_id, fb_post_id, source_id, author_id, body,
                   permalink, post_type, posted_at, likes, comments,
                   shares, video_plays, captured_at, updated_at,
                   is_demo, COALESCE(item_type,'post'), parent_fb_id FROM posts;
        DROP TABLE posts;
        ALTER TABLE posts_new RENAME TO posts;

        CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id);
        CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
        CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id);
    """)

    conn.execute("PRAGMA foreign_keys = ON")


def promote_sole_account():
    """Make sure somebody owns this instance, and is not metered by it.

    create_user flags the first account as owner, but an install where that
    never happened — accounts made before admin existed, or a database
    restored from one — ends up with nobody flagged. Every account is then
    metered, including the person running the thing, and the free plan's post
    cap starts rejecting their own captures at ingest. That looks exactly like
    a broken extension: the scan captures, the dashboard receives nothing, and
    the only clue is a plan message in a panel nobody reads.

    Restricting it to single-account installs was too narrow, because two
    accounts are enough to leave the owner metered. It applies whenever NO
    account is an admin, and promotes the earliest one — which is the account
    create_user would have flagged. It cannot promote a second person, and it
    does nothing once an owner exists.
    """
    with get_db() as conn:
        if conn.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").fetchone()["n"]:
            return False
        first = conn.execute(
            "SELECT id FROM users ORDER BY id LIMIT 1"
        ).fetchone()
        if not first:
            return False
        conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (first["id"],))
        return True


def claim_unowned_data(user_id):
    """Hand pre-multi-user rows to the first account created.

    A single-user install that later signs up would otherwise find its own
    captures invisible, since every query is now scoped by owner.
    """
    with get_db() as conn:
        others = conn.execute(
            "SELECT COUNT(*) AS n FROM users WHERE id != ?", (user_id,)
        ).fetchone()["n"]
        if others:
            return 0                       # not the first account; claim nothing

        claimed = 0
        for table in _OWNED_TABLES:
            cur = conn.execute(
                f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL", (user_id,)
            )
            claimed += cur.rowcount or 0
    return claimed


def upsert_source(conn, fb_id, kind, name, url=None, member_count=None, user_id=None):
    """Insert or refresh a group/profile we're capturing from.

    Keyed on (user_id, fb_id): two accounts may track the same public group
    without either one overwriting the other.
    """
    conn.execute(
        """
        INSERT INTO sources (user_id, fb_id, kind, name, url, member_count, last_capture)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, fb_id) DO UPDATE SET
            -- kind is deliberately NOT refreshed here. Auto-detection is
            -- best-effort (Facebook's SPA hides the page/profile signal on
            -- in-app navigation), so a later scan must not overwrite a label
            -- the user has corrected by hand. Kind is set once on insert and
            -- changed only through the manual control on the source card.
            name         = excluded.name,
            url          = COALESCE(excluded.url, sources.url),
            member_count = COALESCE(excluded.member_count, sources.member_count),
            last_capture = CURRENT_TIMESTAMP
        """,
        (user_id, fb_id, kind, name, url, member_count),
    )
    row = conn.execute(
        "SELECT id FROM sources WHERE user_id IS ? AND fb_id = ?", (user_id, fb_id)
    ).fetchone()
    return row["id"]


def upsert_author(conn, name, fb_id=None, profile_url=None):
    """Store an author, or None when the extractor could not read one.

    Substituting "Unknown" made an extraction failure indistinguishable from a
    real byline — the card printed it in the author slot exactly like a name.
    A missing author is now genuinely missing, and the UI says so.
    """
    if not name or not str(name).strip():
        return None
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


def _count(value):
    """A non-negative integer, whatever arrived.

    Counts come from an extension we don't fully control, and /api/capture is
    reachable directly with an API key, so a count could be a string, negative,
    or absurd. SQLite would store it verbatim and score_posts — which multiplies
    and sums these — would then crash on every dashboard load for that account,
    or produce a garbage baseline. Clamp at the single write path so nothing
    downstream has to defend against it.
    """
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    if n < 0:
        return 0
    return n if n < 1_000_000_000 else 999_999_999


def upsert_post(conn, source_id, author_id, post, user_id=None):
    """Insert a post, or update its engagement counts if we've seen it before.

    Returns True when the post is new — the caller reports this back to the
    extension so the user can see capture progress.
    """
    # Normalise attacker-reachable fields before anything is stored.
    for _field in ("likes", "comments", "shares", "video_plays", "image_count"):
        post[_field] = _count(post.get(_field, 0))
    _body = post.get("body")
    if isinstance(_body, str) and len(_body) > 10000:
        post["body"] = _body[:10000]
    elif _body is not None and not isinstance(_body, str):
        post["body"] = ""

    existing = conn.execute(
        "SELECT id FROM posts WHERE user_id IS ? AND fb_post_id = ?",
        (user_id, post["fb_post_id"]),
    ).fetchone()

    if existing:
        conn.execute(
            """
            UPDATE posts SET
                likes = ?, comments = ?, shares = ?, video_plays = ?,
                body = COALESCE(NULLIF(?, ''), body),
                image_url = COALESCE(image_url, ?),
                image_count = MAX(image_count, ?),
                engagement_read = CASE
                    WHEN ? = 1 THEN 1 ELSE engagement_read END,
                body_from_image = CASE
                    WHEN NULLIF(?, '') IS NOT NULL AND ? = 0 THEN 0
                    ELSE body_from_image END,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id IS ? AND fb_post_id = ?
            """,
            (
                post.get("likes", 0),
                post.get("comments", 0),
                post.get("shares", 0),
                post.get("video_plays", 0),
                post.get("body", ""),
                post.get("image_url"),
                post.get("image_count", 0),
                1 if post.get("engagement_read") else 0,
                post.get("body", ""),
                1 if post.get("body_from_image") else 0,
                user_id,
                post["fb_post_id"],
            ),
        )
        return False

    conn.execute(
        """
        INSERT INTO posts (
            user_id, fb_post_id, source_id, author_id, body, permalink, post_type,
            posted_at, likes, comments, shares, video_plays, is_demo,
            item_type, parent_fb_id, image_url, image_count, has_video,
            body_from_image, engagement_read
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
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
            post.get("image_url"),
            post.get("image_count", 0),
            1 if post.get("has_video") else 0,
            1 if post.get("body_from_image") else 0,
            None if post.get("engagement_read") is None
                 else (1 if post.get("engagement_read") else 0),
        ),
    )
    return True


def has_any_posts(user_id=None):
    with get_db() as conn:
        if user_id is None:
            row = conn.execute("SELECT COUNT(*) AS n FROM posts").fetchone()
        else:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM posts WHERE user_id = ?", (user_id,)
            ).fetchone()
        return row["n"] > 0


def clear_demo_data(user_id=None):
    """Remove demo posts and any source left with nothing behind it.

    Capture-log rows reference sources, so they have to go first or the source
    delete trips the foreign key. Saved/remix rows hang off posts and cascade
    on their own.
    """
    with get_db() as conn:
        conn.execute("DELETE FROM posts WHERE is_demo = 1 AND user_id IS ?",
                     (user_id,))

        orphans = [
            r["id"] for r in conn.execute(
                "SELECT id FROM sources WHERE user_id IS ? AND id NOT IN "
                "(SELECT DISTINCT source_id FROM posts WHERE source_id IS NOT NULL)",
                (user_id,),
            ).fetchall()
        ]
        for source_id in orphans:
            conn.execute("DELETE FROM captures WHERE source_id = ?", (source_id,))
            conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))


def clear_all_captures(user_id):
    """Delete every source, post and capture belonging to one account.

    A hard reset, offered because data captured by a broken extractor is worse
    than no data: it sets baselines, it is indistinguishable on a card from a
    correct reading, and re-scanning updates existing rows rather than
    replacing them — so a bad number can survive a re-scan that no longer
    produces it. Saved and remix rows cascade from posts; captures reference
    sources and have to go first or the foreign key trips.

    Scoped to one owner. Never call this without a user_id.
    """
    if user_id is None:
        raise ValueError("clear_all_captures requires a user_id")

    with get_db() as conn:
        removed = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE user_id IS ?", (user_id,)
        ).fetchone()["n"]
        sources = conn.execute(
            "SELECT COUNT(*) AS n FROM sources WHERE user_id IS ?", (user_id,)
        ).fetchone()["n"]

        conn.execute("DELETE FROM captures WHERE user_id IS ?", (user_id,))
        conn.execute("DELETE FROM saved WHERE user_id IS ?", (user_id,))
        conn.execute("DELETE FROM remixes WHERE user_id IS ?", (user_id,))
        conn.execute("DELETE FROM posts WHERE user_id IS ?", (user_id,))
        conn.execute("DELETE FROM sources WHERE user_id IS ?", (user_id,))

        # Authors are shared across owners by name-keyed identity, so only the
        # ones nothing points at any more are removed.
        conn.execute(
            "DELETE FROM authors WHERE id NOT IN "
            "(SELECT author_id FROM posts WHERE author_id IS NOT NULL)"
        )

    return {"posts": removed, "sources": sources}
