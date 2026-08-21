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

-- Password resets. Only the hash of the token is kept, for the same reason
-- only the hash of an API key is: a database read must not hand somebody a
-- working link into every account. `delivered` records whether an email
-- actually went out, so an operator can see which requests still need a hand.
CREATE TABLE IF NOT EXISTS password_resets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    token_hash  TEXT NOT NULL,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    delivered   INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resets_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

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

-- One row per page view, for the owner's own traffic numbers.
--
-- Deliberately not an analytics product. There is no third-party script, no
-- cookie beyond the session that already exists, and no raw address stored:
-- the visitor column is a salted hash, which is enough to count people twice
-- as one and not enough to identify anybody.
CREATE TABLE IF NOT EXISTS visits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER,               -- NULL for signed-out visitors
    path          TEXT NOT NULL,
    visitor       TEXT,                  -- salted hash of address + agent
    referrer      TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Things worth telling somebody about, for the owner and for users alike.
--
-- user_id is who it is FOR, never who caused it. A signup notifies every
-- admin, so one event writes several rows — which is what makes read state
-- per-person rather than global.
CREATE TABLE IF NOT EXISTS notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    kind          TEXT NOT NULL,         -- signup | capture | quota | system
    title         TEXT NOT NULL,
    body          TEXT,
    url           TEXT,
    read_at       TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Bug reports and ideas, written by users about the product.
--
-- Deliberately NOT captured Facebook content. Everything here is the author's
-- own words about the software, which is what makes it safe to show to other
-- accounts — captured posts belong to strangers in private groups and never
-- leave the account that captured them.
CREATE TABLE IF NOT EXISTS feedback (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'idea',   -- bug | idea
    title         TEXT NOT NULL,
    body          TEXT,
    status        TEXT NOT NULL DEFAULT 'open',   -- open | planned | shipped | declined
    admin_note    TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One vote per person per item, enforced by the key rather than by care.
CREATE TABLE IF NOT EXISTS feedback_votes (
    feedback_id   INTEGER NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (feedback_id, user_id)
);

-- Groups the user already belongs to, harvested from their own sidebar.
--
-- Kept OUT of `sources` deliberately. A source drives a baseline and gets
-- scored against; a candidate is a group nobody has scanned yet and must
-- never enter that maths. They meet on fb_id, so a candidate lights up as
-- scanned the moment a real capture lands under the same id.
--
-- Nothing here is ever shown to another account. Group membership says what a
-- person cares about — their politics, their health, their money — and it is
-- the one thing this table would be worth sharing and must not be.
CREATE TABLE IF NOT EXISTS group_candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    fb_id         TEXT NOT NULL,
    name          TEXT,
    url           TEXT,
    relevance     INTEGER,           -- 0-100, from the user's own AI. NULL = unranked
    reason        TEXT,              -- one line, why it scored that
    dismissed     INTEGER DEFAULT 0,
    seen_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, fb_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id);
CREATE INDEX IF NOT EXISTS idx_posts_captured ON posts(captured_at);
CREATE INDEX IF NOT EXISTS idx_posts_posted ON posts(posted_at);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, id);
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
    # A name the user picks for themselves.
    #
    # The feedback board needed something to show beside an item, and it was
    # deriving one from the email's local part. For a great many people that
    # IS their name — jeffrandle@gmail.com reads as "jeffrandle" — so the
    # board was publishing a thin disguise of an address nobody agreed to
    # share. It also collides: two people called jeff at different providers
    # were one handle. Until a name is chosen the display falls back to a
    # number, which is nobody's anything.
    if "username" not in _columns(conn, "users"):
        conn.execute("ALTER TABLE users ADD COLUMN username TEXT")
    # Case-insensitive uniqueness, in the index rather than in a check that
    # has to be remembered at every call site.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username "
        "ON users(LOWER(username)) WHERE username IS NOT NULL"
    )

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
        # Words rendered INTO the graphic, from Facebook's own OCR. Kept even
        # when the post also has a typed caption, which the body cannot do —
        # body holds one or the other, and a meme with a caption used to lose
        # its lettering entirely.
        ("image_text", "TEXT"),
        # What the graphic DEPICTS, from Facebook's generated alt description.
        # A machine's words, never the author's, so this must never be shown
        # or used as the body. It exists so remixing a wordless photo post has
        # something true to work from instead of an empty string.
        ("image_desc", "TEXT"),
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
            image_text    TEXT,
            image_desc    TEXT,
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
    # Both arrive from scraped alt attributes, so they are attacker-reachable
    # in exactly the way the body is and get the same treatment.
    for _field, _cap in (("image_text", 5000), ("image_desc", 500)):
        _value = post.get(_field)
        if isinstance(_value, str):
            post[_field] = _value[:_cap]
        elif _value is not None:
            post[_field] = ""

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
                -- Filled in by a later scan if the first one missed them, but
                -- never blanked: a re-read that fails to find the alt text
                -- should not delete what an earlier read did find.
                image_text = COALESCE(NULLIF(?, ''), image_text),
                image_desc = COALESCE(NULLIF(?, ''), image_desc),
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
                post.get("image_text") or "",
                post.get("image_desc") or "",
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
            body_from_image, engagement_read, image_text, image_desc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            post.get("image_text") or "",
            post.get("image_desc") or "",
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


# Shapes that were never the author's writing, for rows already stored.
#
# Every capture-side fix for these only changes what gets written afterwards.
# The dashboard kept showing the old rows, which is the version actually being
# looked at — four fixes shipped and the screen did not change once. Cleaning
# the stored rows is the half that was missing.
_BARE_DOMAIN_RE = re.compile(r"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")
_LONG_TOKEN_RE = re.compile(r"^\S{20,}$")
_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'’‘-]{1,29}$")

# The operator's own name, as they typed it.
#
# Three attempts were made to work out where Facebook prints the reader's name
# and to recognise it from the markup. All three were guesses at a page nobody
# here can see, and the name kept arriving anyway. This stops guessing: the
# name is asked for once, stored, and stripped on the way in — which works
# whatever Facebook renames its containers to, and whatever build of the
# extension is installed, because it happens on the server after the post has
# already been sent.
VIEWER_NAMES_KEY = "viewer_names"


def get_viewer_names(conn, user_id):
    """The names this account has declared as its own. Comma separated."""
    row = conn.execute(
        "SELECT value FROM user_settings WHERE user_id = ? AND key = ?",
        (user_id, VIEWER_NAMES_KEY),
    ).fetchone()
    raw = (row["value"] if row else "") or ""
    return [n.strip() for n in raw.split(",") if n.strip()]


def viewer_name_parts(conn, user_id):
    """Each word of each declared name, lowercased.

    Parts and not just the whole string, because the name lands in a caption
    as "Jeff" far more often than as "Jeff Randle".
    """
    parts = set()
    for name in get_viewer_names(conn, user_id):
        # The whole name as well as its pieces: it arrives as "Jeff" most of
        # the time, but a header echo can carry "Jeff Randle" intact.
        whole = " ".join(name.split()).strip(".,:;!?'\"’‘").lower()
        if len(whole) >= 2:
            parts.add(whole)
        for part in name.split():
            part = part.strip(".,:;!?'\"’‘").lower()
            if len(part) >= 2:
                parts.add(part)
    return parts


def repeated_caption_bodies(conn, user_id, min_authors=2):
    """Short captions that appear under more than one author's name.

    The evidence nobody had to configure. "Jeff" arrived as the caption on a
    post by Doug Hensley and on a post by Kaylee Merry, in the same group, on
    the same scan — and two different people did not write the same one-word
    post. Anything Facebook prints on every post lands like this, whoever it
    belongs to, which is what makes the shape detectable without knowing whose
    name it is or where on the page it came from.

    Deliberately narrow. A single token only, which is what keeps it safe:
    real captions that genuinely repeat across authors have spaces in them.
    "Happy Birthday!" from three different people in a group is ordinary and
    is never touched; "Jeff" from two is not a coincidence worth protecting.

    Two authors rather than three, because this runs over stored rows where
    the evidence is already complete, and the ingest-time check has usually
    blanked the later copies by the time anyone presses the button — leaving
    exactly the early stragglers this needs to catch.
    """
    return [r["body"] for r in conn.execute(
        """
        SELECT body
        FROM posts
        WHERE user_id IS ?
          AND body IS NOT NULL AND body != ''
          AND LENGTH(body) <= 30
          AND body NOT LIKE '% %'
          AND author_id IS NOT NULL
        GROUP BY body
        HAVING COUNT(DISTINCT author_id) >= ?
        """, (user_id, int(min_authors)))]


def furniture_caption(body):
    """Is this body short and plain enough to be worth asking about at all?

    The gate that keeps the ordinary case — a post with real writing in it —
    away from the query entirely.
    """
    text = (body or "").strip()
    return bool(text) and " " not in text and len(text) <= 30


def caption_author_counts(conn, user_id, bodies):
    """How many distinct authors each of these captions has appeared under.

    ONE query for a whole batch, not one per post.
    ​
    The first version asked per post, and measured at 40,000 stored posts that
    cost about 17ms each — a capture batch carrying twenty such captions added
    a third of a second to the request, growing linearly with everything the
    account had ever captured. A partial index does not rescue it: the NULL-safe
    `user_id IS ?` comparison stops the planner using one. Asking once for the
    whole batch removes the problem rather than optimising it.
    """
    wanted = sorted({(b or "").strip() for b in bodies if furniture_caption(b)})
    if not wanted:
        return {}
    marks = ",".join("?" * len(wanted))
    rows = conn.execute(
        f"""
        SELECT body, COUNT(DISTINCT author_id) AS n FROM posts
        WHERE user_id IS ? AND author_id IS NOT NULL AND body IN ({marks})
        GROUP BY body
        """, [user_id] + wanted,
    )
    return {r["body"]: r["n"] for r in rows}


def is_viewer_name_body(body, parts):
    """Is this whole caption nothing but one of those names?

    Whole-block only, and matched against a closed set of declared names — so
    a caption that merely contains the name is writing, and is never touched.
    "Jeff" and "Jeff Randle" go; "Jeff was right about this" stays.
    """
    text = " ".join((body or "").split())
    if not text or not parts:
        return False
    return text.strip(".,:;!?'\"’‘").lower() in parts


def _name_parts(conn, user_id, names):
    """Every word that is known to be somebody's name, lowercased.

    A one-word caption cannot be judged on its shape — "Jeff" and
    "Congratulations" are the same shape, and clearing every capitalised word
    would delete real one-word captions with no way to get them back short of
    re-scanning. So only words that are demonstrably names are cleared: the
    ones the operator supplies, and every part of every author name already
    captured. Anything else is left exactly as it is.
    """
    parts = set()
    # Whatever was typed now, plus whatever was declared earlier — so a
    # cleanup run without retyping the name still knows it.
    for name in list(names or []) + get_viewer_names(conn, user_id):
        for part in str(name or "").split():
            part = part.strip(".,:;!?'\"").lower()
            if len(part) >= 2:
                parts.add(part)

    # Joined through posts, not filtered on authors.user_id — that column does
    # not exist. `authors` is shared across accounts (it is not in
    # _OWNED_TABLES), so this threw "no such column: user_id" on every run, and
    # the whole cleanup failed before it cleared a single caption. Which is why
    # pressing the button never reported a count.
    for row in conn.execute(
        "SELECT DISTINCT a.name FROM authors a "
        "JOIN posts p ON p.author_id = a.id "
        "WHERE p.user_id IS ? AND a.name IS NOT NULL", (user_id,)
    ):
        for part in str(row["name"] or "").split():
            part = part.strip(".,:;!?'\"").lower()
            if len(part) >= 2:
                parts.add(part)
    return parts


def clean_captions(user_id, names=None):
    """Blank stored bodies that are chrome rather than writing.

    Never deletes a post, never touches engagement, never changes a score. A
    post with a bad caption is still a real post with real numbers; clearing
    the body puts it in exactly the state a genuinely caption-less post has
    always been in.

    Scoped to one owner, like everything else that touches posts.
    """
    if user_id is None:
        raise ValueError("clean_captions requires a user_id")

    counts = {"domain": 0, "token": 0, "name": 0, "repeated": 0}
    with get_db() as conn:
        known_names = _name_parts(conn, user_id, names)
        # Captions already proven to belong to nobody, by having shown up
        # under three different authors. Computed once for the whole sweep.
        repeated = {b.strip().lower() for b in repeated_caption_bodies(conn, user_id)}
        rows = conn.execute(
            "SELECT id, body, body_from_image FROM posts "
            "WHERE user_id IS ? AND body IS NOT NULL AND body != ''",
            (user_id,),
        ).fetchall()

        for row in rows:
            body = (row["body"] or "").strip()
            # Anything with a space is writing and is never touched here.
            if not body or " " in body:
                continue

            # An explicit link is something a person chose to post. Only a
            # BARE domain is a preview-card label.
            low = body.lower()
            if "/" in body or low.startswith("www.") or low.startswith("http"):
                continue

            # Words read out of a graphic are the author's own, whatever shape
            # they take. A quote card transcribed as one long unbroken run of
            # capitals is real copy and must survive this.
            from_image = bool(row["body_from_image"])

            kind = None
            # Checked before the shape tests, and regardless of body_from_image:
            # a word that appeared under three different authors is furniture
            # even if it was read out of a graphic.
            if body.lower() in repeated:
                kind = "repeated"
            elif _BARE_DOMAIN_RE.match(body):
                kind = "domain"
            elif (not from_image
                  and _LONG_TOKEN_RE.match(body)
                  and body[0] not in "@#"
                  # Mixed case is the signature. All-caps is a shout or a
                  # transcription, never one of these.
                  and re.search(r"[A-Z]", body) and re.search(r"[a-z]", body)):
                kind = "token"
            elif (not from_image
                  and _WORD_RE.match(body)
                  and body.strip(".,:;!?").lower() in known_names):
                kind = "name"

            if not kind:
                continue

            conn.execute(
                "UPDATE posts SET body = '', body_from_image = 0 "
                "WHERE id = ? AND user_id IS ?",
                (row["id"], user_id),
            )
            counts[kind] += 1

    counts["total"] = (counts["domain"] + counts["token"]
                       + counts["name"] + counts["repeated"])
    return counts


# --------------------------------------------------------------- analytics

def record_visit(path, visitor=None, user_id=None, referrer=None):
    """Log one page view. Never raises — a counter must not break a page."""
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO visits (user_id, path, visitor, referrer) "
                "VALUES (?, ?, ?, ?)",
                (user_id, path[:200], visitor, (referrer or "")[:300] or None),
            )
    except Exception:
        pass


VISIT_RETENTION_DAYS = 400


def prune_visits(conn):
    """Drop page views older than the retention window.

    One row per page view, forever, on a 1GB disk was a slow leak with no
    ceiling — the kind that is invisible for a year and then fills the volume
    that also holds every captured post. Four hundred days keeps a full
    year-on-year comparison and throws away the rest.

    Run from the admin page rather than on a schedule: it is the only reader
    of this table, nothing else depends on the pruning being timely, and a
    delete on every page view would be a write nobody asked for.
    """
    conn.execute(
        "DELETE FROM visits WHERE created_at < datetime('now', ?)",
        (f"-{VISIT_RETENTION_DAYS} days",),
    )


def traffic_summary(days=30):
    """Totals the owner actually asks about, in one round trip each.

    "Visitors" counts distinct hashes, so one person reading six pages is one
    visitor. "Views" counts rows. Both are reported because the ratio is the
    interesting part.
    """
    since = f"-{int(days)} days"
    with get_db() as conn:
        prune_visits(conn)

        def one(sql, *params):
            row = conn.execute(sql, params).fetchone()
            return (row[0] if row else 0) or 0

        return {
            "days": int(days),
            "views": one("SELECT COUNT(*) FROM visits WHERE created_at >= datetime('now', ?)", since),
            "visitors": one("SELECT COUNT(DISTINCT visitor) FROM visits WHERE created_at >= datetime('now', ?)", since),
            "views_today": one("SELECT COUNT(*) FROM visits WHERE date(created_at) = date('now')"),
            "visitors_today": one("SELECT COUNT(DISTINCT visitor) FROM visits WHERE date(created_at) = date('now')"),
            "signed_out_views": one(
                "SELECT COUNT(*) FROM visits WHERE user_id IS NULL "
                "AND created_at >= datetime('now', ?)", since),
            "users": one("SELECT COUNT(*) FROM users"),
            "users_new": one(
                "SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', ?)", since),
            "daily": [dict(r) for r in conn.execute(
                "SELECT date(created_at) AS day, COUNT(*) AS views, "
                "       COUNT(DISTINCT visitor) AS visitors "
                "FROM visits WHERE created_at >= datetime('now', ?) "
                "GROUP BY day ORDER BY day DESC LIMIT 30", (since,))],
            "top_paths": [dict(r) for r in conn.execute(
                "SELECT path, COUNT(*) AS views FROM visits "
                "WHERE created_at >= datetime('now', ?) "
                "GROUP BY path ORDER BY views DESC LIMIT 10", (since,))],
        }


def pending_reset_requests(limit=20):
    """Reset requests that were never spent, newest first.

    `delivered` is 0 when no email went out — on an instance with no SMTP
    configured that is every one of them, and this list is the only place the
    request surfaces at all.
    """
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """
            SELECT r.id, r.user_id, r.created_at, r.expires_at, r.delivered,
                   u.email
            FROM password_resets r
            JOIN users u ON u.id = r.user_id
            WHERE r.used_at IS NULL
            ORDER BY r.id DESC LIMIT ?
            """, (limit,)
        ).fetchall()]


def recent_users(limit=25):
    """Who signed up, newest first, with what they have actually done.

    A signup count on its own cannot tell a real user from an empty account,
    so the post count travels with the row.
    """
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """
            SELECT u.id, u.email, u.plan, u.is_admin, u.created_at,
                   (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts,
                   (SELECT COUNT(*) FROM sources s WHERE s.user_id = u.id) AS sources
            FROM users u ORDER BY u.id DESC LIMIT ?
            """, (int(limit),))]


# -------------------------------------------------------------- usernames

# Letters, numbers, underscore and hyphen. No spaces, no dots, no unicode
# lookalikes — a name that can be typed back exactly is worth more here than
# a name that can be decorated.
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,20}$")

# Words that would let a name impersonate the product or a role. Checked
# lowercased, so Admin and ADMIN are covered by "admin".
RESERVED_USERNAMES = {
    "admin", "administrator", "owner", "root", "staff", "team", "support",
    "help", "moderator", "mod", "system", "official", "tallgrass",
    "macrandle", "macrandleacres", "sage", "null", "undefined", "anonymous",
    "me", "you", "everyone", "here", "all",
}


def display_name(user):
    """What to show other people. Never derived from the address.

    A member number until they choose otherwise: unhelpful, but it belongs to
    nobody and reveals nothing, which beats a handle assembled out of somebody
    else's email.
    """
    if not user:
        return "someone"
    name = (user.get("username") if isinstance(user, dict) else user["username"])
    if name:
        return name
    uid = user["id"] if not isinstance(user, dict) else user.get("id")
    return "member-" + str(uid or "?")


def username_error(name):
    """Why this name cannot be used, or None if it can."""
    name = (name or "").strip()
    if not name:
        return "Pick a username."
    if not USERNAME_RE.match(name):
        return ("3–20 characters, letters, numbers, underscore or hyphen only.")
    if name.lower() in RESERVED_USERNAMES:
        return "That name is reserved."
    # A name that is only digits reads as the member-<id> fallback and could
    # be used to pass as somebody else's account number.
    if name.isdigit():
        return "Usernames need at least one letter."
    return None


def set_username(user_id, name):
    """Claim a name. Returns (ok, error).

    Uniqueness is the index's job — checking first and inserting after is a
    race between two people picking the same name at the same moment, and the
    loser should see a message rather than a stack trace.
    """
    name = (name or "").strip()
    problem = username_error(name)
    if problem:
        return False, problem
    try:
        with get_db() as conn:
            conn.execute("UPDATE users SET username = ? WHERE id = ?", (name, user_id))
    except sqlite3.IntegrityError:
        return False, "That username is taken."
    return True, None


# -------------------------------------------------------------- feedback

FEEDBACK_STATUSES = ("open", "planned", "shipped", "declined")


def create_feedback(user_id, kind, title, body=None):
    """File a bug report or an idea. Returns the new row's id."""
    kind = kind if kind in ("bug", "idea") else "idea"
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO feedback (user_id, kind, title, body) VALUES (?, ?, ?, ?)",
            (user_id, kind, title.strip()[:160], (body or "").strip()[:4000] or None),
        )
        return cur.lastrowid


def list_feedback(viewer_id, status=None, sort="top", limit=100):
    """The board, with each item's vote count and whether the viewer voted.

    Sorted by votes for "top" and by recency for "new". Both are one query —
    counting votes per row in Python would be a query per item.
    """
    where, params = [], []
    if status in FEEDBACK_STATUSES:
        where.append("f.status = ?")
        params.append(status)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    order = "votes DESC, f.id DESC" if sort == "top" else "f.id DESC"

    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            f"""
            SELECT f.*,
                   u.username AS author_username,
                   (SELECT COUNT(*) FROM feedback_votes v
                     WHERE v.feedback_id = f.id) AS votes,
                   (SELECT COUNT(*) FROM feedback_votes v
                     WHERE v.feedback_id = f.id AND v.user_id = ?) AS voted
            FROM feedback f
            LEFT JOIN users u ON u.id = f.user_id
            {clause}
            ORDER BY {order}
            LIMIT ?
            """, [viewer_id] + params + [int(limit)])]


def get_feedback(feedback_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (int(feedback_id),)
        ).fetchone()
    return dict(row) if row else None


def toggle_vote(feedback_id, user_id):
    """Vote or take it back. Returns (voted, total).

    A second press removes the vote rather than erroring — a button that can
    only ever be pressed once is a trap, and the primary key makes double
    voting impossible regardless of what the interface does.
    """
    with get_db() as conn:
        existing = conn.execute(
            "SELECT 1 FROM feedback_votes WHERE feedback_id = ? AND user_id = ?",
            (int(feedback_id), user_id),
        ).fetchone()
        if existing:
            conn.execute(
                "DELETE FROM feedback_votes WHERE feedback_id = ? AND user_id = ?",
                (int(feedback_id), user_id),
            )
            voted = False
        else:
            conn.execute(
                "INSERT OR IGNORE INTO feedback_votes (feedback_id, user_id) VALUES (?, ?)",
                (int(feedback_id), user_id),
            )
            voted = True
        total = conn.execute(
            "SELECT COUNT(*) FROM feedback_votes WHERE feedback_id = ?",
            (int(feedback_id),),
        ).fetchone()[0]
    return voted, total


def feedback_voters(feedback_id):
    """Everyone who backed an item — the people a status change is news to."""
    with get_db() as conn:
        return [r["user_id"] for r in conn.execute(
            "SELECT user_id FROM feedback_votes WHERE feedback_id = ?",
            (int(feedback_id),))]


def set_feedback_status(feedback_id, status, note=None):
    if status not in FEEDBACK_STATUSES:
        return False
    with get_db() as conn:
        conn.execute(
            "UPDATE feedback SET status = ?, admin_note = COALESCE(?, admin_note), "
            "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (status, (note or None), int(feedback_id)),
        )
    return True


# ----------------------------------------------------------- notifications

def notify(user_id, kind, title, body=None, url=None):
    """Leave a message for one person. Never raises."""
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO notifications (user_id, kind, title, body, url) "
                "VALUES (?, ?, ?, ?, ?)",
                (user_id, kind, title[:200], (body or None), (url or None)),
            )
    except Exception:
        pass


def notify_admins(kind, title, body=None, url=None):
    """The same message to everyone who owns the place."""
    try:
        with get_db() as conn:
            admins = [r["id"] for r in conn.execute(
                "SELECT id FROM users WHERE is_admin = 1")]
    except Exception:
        return
    for admin_id in admins:
        notify(admin_id, kind, title, body, url)


def notifications_for(user_id, limit=20, unread_only=False):
    sql = "SELECT * FROM notifications WHERE user_id = ?"
    if unread_only:
        sql += " AND read_at IS NULL"
    sql += " ORDER BY id DESC LIMIT ?"
    with get_db() as conn:
        return [dict(r) for r in conn.execute(sql, (user_id, int(limit)))]


def unread_count(user_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        ).fetchone()
    return (row[0] if row else 0) or 0


def mark_notifications_read(user_id, notification_id=None):
    """Mark one as read, or all of them. Scoped to the owner either way."""
    with get_db() as conn:
        if notification_id:
            conn.execute(
                "UPDATE notifications SET read_at = CURRENT_TIMESTAMP "
                "WHERE id = ? AND user_id = ? AND read_at IS NULL",
                (int(notification_id), user_id),
            )
        else:
            conn.execute(
                "UPDATE notifications SET read_at = CURRENT_TIMESTAMP "
                "WHERE user_id = ? AND read_at IS NULL", (user_id,),
            )
    return unread_count(user_id)


def delete_post(post_id, user_id):
    """Remove one post outright. Returns True if a row went.

    The whole row, not just its caption. A post the user has looked at and
    rejected should not go on setting the median every other post in that
    group is measured against — leaving it in with the text blanked would keep
    it in the baseline, which is the part that actually matters.

    Scoped to the owner: a post id from another account matches nothing.
    """
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM posts WHERE id = ? AND user_id IS ?",
            (int(post_id), user_id),
        )
        return cur.rowcount > 0


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


# ------------------------------------------------------------ instance settings

def get_setting(key, default=""):
    """A value for the whole install, not for one person.

    The per-user equivalent lives in sage.py against user_settings. This one
    backs the settings table, which had a schema and no accessors.
    """
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row and row["value"] is not None else default
    except Exception:
        return default


def set_setting(key, value):
    """Never raises — callers are alert throttles, not the request path."""
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) "
                "VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(key) DO UPDATE SET "
                "value = excluded.value, updated_at = CURRENT_TIMESTAMP",
                (key, value))
    except Exception:
        pass
