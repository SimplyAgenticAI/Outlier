import io
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from flask import (Flask, jsonify, redirect, render_template, request,
                   send_file, session, url_for)

import auth
import billing
import db
import outliers
import remix
import sage
from demo_data import seed_demo_data

app = Flask(__name__)


def _manifest_version(default="0.0.0"):
    """The version written in the extension manifest."""
    path = os.path.join(os.path.dirname(__file__), "extension", "manifest.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle).get("version", default)
    except (OSError, json.JSONDecodeError):
        return default


# One version number for the whole product.
#
# There used to be two — a constant here and a literal in the manifest — and
# they drifted apart immediately, because bumping one is a different edit from
# bumping the other. The manifest wins because Chrome demands a literal there
# and will not read anything else, so the dashboard takes its version from the
# same file rather than keeping a second copy to forget about.
APP_VERSION = _manifest_version("11.1")

# The product name lives here and nowhere else. APP_SHORT_NAME is what prose
# uses on the second mention — spelling out the full name mid-sentence reads
# like boilerplate.
APP_NAME = "Tallgrass"
APP_SHORT_NAME = "Tallgrass"

# The umbrella brand. Shown under the mark, not inside it.
APP_PARENT = "by MacRandle Acres"
APP_TAGLINE = "Find the standout posts in your Facebook groups, and write the next one."

# Printed on the privacy policy and terms as the address for deletion
# requests, so it has to be an inbox someone actually reads. Override it in
# the environment once there is a real support address to point at.
SUPPORT_EMAIL = os.environ.get("SUPPORT_EMAIL", "macrandleacres@gmail.com")

# The date shown on the legal pages. Bump it when the terms change in a way
# that affects what is collected or who receives it — not for typos.
LEGAL_UPDATED = "10 August 2026"

db.init_db()
db.promote_sole_account()

# Signed sessions. Secure is off for localhost only — a Secure cookie is never
# sent over plain HTTP, which would break local development entirely.
app.secret_key = auth.get_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,      # unreadable from JavaScript
    SESSION_COOKIE_SAMESITE="Lax",     # not sent on cross-site POSTs
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,   # cap capture payloads
)

# The extension posts cross-origin from facebook.com, so the ingest endpoints
# need permissive CORS. Everything else is same-origin.
INGEST_PATHS = ("/api/capture", "/api/ping")


@app.after_request
def add_cors_headers(response):
    if request.path in INGEST_PATHS:
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Outlier-Key"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"

    # Pages reflect a database that changes while the tab sits open. Without
    # this the browser serves a cached copy and newly captured posts appear
    # to have vanished.
    if response.mimetype == "text/html":
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


def client_ip():
    """The caller's address, as seen from behind Render's proxy.

    remote_addr on a hosted instance is the proxy, so every visitor shares one
    value and a per-address limit would throttle the whole internet at once.
    X-Forwarded-For is a chain the client can prepend to, but the platform
    appends the real peer last, so the final entry is the one to trust.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.remote_addr or ""


def _uid():
    """Current owner id, or a value that matches nothing when signed out."""
    user = auth.current_user()
    return user["id"] if user else -1


def _fetch_posts(source_id=None, limit=None, user_id=None):
    """Pull posts joined to their source and author, ready for scoring.

    Always scoped to one owner. The user_id filter is not optional — an
    unscoped variant would be one forgotten argument away from serving another
    account's captures.
    """
    if user_id is None:
        user = auth.current_user()
        user_id = user["id"] if user else -1

    sql = """
        SELECT p.*, s.name AS source_name, s.kind AS source_kind,
               s.fb_id AS source_fb_id, s.url AS source_url, a.name AS author_name,
               (SELECT COUNT(*) FROM saved
                 WHERE saved.post_id = p.id AND saved.user_id = p.user_id) AS is_saved
        FROM posts p
        LEFT JOIN sources s ON s.id = p.source_id
        LEFT JOIN authors a ON a.id = p.author_id
        WHERE p.user_id = ?
    """
    params = [user_id]
    if source_id:
        sql += " AND p.source_id = ?"
        params.append(source_id)
    sql += " ORDER BY p.posted_at DESC"
    if limit:
        sql += f" LIMIT {int(limit)}"

    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _global_stats(scored):
    """Headline numbers. Posts and comments are counted apart — labelling a
    comment total as "posts captured" overstates what was actually collected."""
    posts = [s for s in scored if (s.get("item_type") or "post") == "post"]
    comments = [s for s in scored if (s.get("item_type") or "post") == "comment"]
    breakouts = [s for s in posts if s["tier"] == "breakout"]

    # Generated sample rows are not captures. Counting them under "posts
    # captured" reports work the user never did — and the number then
    # disagrees with the list below it, which hides samples by default.
    real_posts = [s for s in posts if not s["is_demo"]]
    real_comments = [s for s in comments if not s["is_demo"]]

    with db.get_db() as conn:
        user = auth.current_user()
        # Sources whose every post is generated sample data are not groups
        # the user tracks, so they don't belong in the headline count.
        source_count = conn.execute(
            """
            SELECT COUNT(*) AS n FROM sources s
            WHERE s.user_id = ?
              AND EXISTS (SELECT 1 FROM posts p
                           WHERE p.source_id = s.id AND p.is_demo = 0)
            """,
            (user["id"] if user else -1,),
        ).fetchone()["n"]

    scoreable = [s for s in posts if s["has_baseline"]]
    return {
        "post_count": len(real_posts),
        "comment_count": len(real_comments),
        "sample_post_count": len(posts) - len(real_posts),
        "source_count": source_count,
        "breakout_count": len(breakouts),
        # Scored posts only. Taking the max across every post printed a
        # headline multiple derived from a baseline the app had already
        # rejected as unusable — "Biggest outlier 99.9x" above "0 scored".
        "top_multiple": max(
            (s["outlier_multiple"] for s in posts
             if s["outlier_multiple"] is not None),
            default=None,
        ),
        # Zero breakouts is a legitimate result — it means nothing cleared 5x
        # its group median — but shown bare it reads as a broken feature. These
        # let the UI say which it is.
        "scored_count": len(scoreable),
        "strong_count": sum(1 for s in scoreable if s["tier"] in ("breakout", "strong")),
        "no_engagement_count": sum(
            1 for s in real_posts if s["total_engagement"] == 0
        ),
    }


# How many cards one page of the feed holds. Rendering everything is fine for
# a few hundred posts and painful at ten thousand.
PAGE_SIZE = 60


# ---------------------------------------------------------------- pages


def _next_step(user, scored):
    """The one thing this account should do next, or None when there isn't one.

    Derived from the database rather than from a tour the user clicks through,
    so it cannot claim a step is undone after they have done it, and it
    disappears on its own instead of needing to be dismissed.

    The existing empty state already handles "nothing captured at all". This
    covers the stretch after that, which had no guidance anywhere: posts are
    arriving, and nobody has said what they are for or what to do next. That
    is the gap a user described as not knowing the best way to use it.

    Ordered by what blocks what. There is no point suggesting a remix to
    somebody whose group cannot score yet.
    """
    if not user:
        return None

    # Never issued a key: the extension cannot deliver anything yet.
    if not user.get("api_key_prefix"):
        return {
            "key": "connect",
            "title": "Connect the extension",
            "body": ("Install it, then open this dashboard once while signed in "
                     "— it picks up your key automatically."),
            "cta": "Get the extension",
            "href": url_for("capture"),
            "scan_demo": False,
        }

    real = [s for s in scored if not s["is_demo"]]
    if not real:
        return {
            "key": "scan",
            "title": "Scan your first group",
            "body": ("Open a Facebook group you're in, find the Tallgrass panel "
                     "in the corner, and press Start. Scroll — or let it scroll "
                     "— and posts arrive here as they're read."),
            "cta": "How scanning works",
            "href": url_for("capture"),
            "scan_demo": True,
        }

    # Captured, but nothing can be scored yet — a median needs a sample.
    if not any(s["has_baseline"] for s in real):
        need = max(outliers.MIN_SAMPLE - sum(1 for s in real if s.get("engagement_read")), 1)
        return {
            "key": "more",
            "title": "Keep scanning — nothing can be scored yet",
            "body": (f"A group needs about {outliers.MIN_SAMPLE} posts with readable "
                     f"engagement before a median means anything. Roughly {need} more "
                     "and this feed starts ranking properly."),
            "cta": "See what each group needs",
            "href": url_for("groups"),
            "scan_demo": True,
        }

    # Scored, but the second half of the product has never been touched.
    with db.get_db() as conn:
        remixed = conn.execute(
            "SELECT 1 FROM remixes WHERE user_id = ? LIMIT 1", (user["id"],)
        ).fetchone()
    if not remixed:
        best = max((s for s in real if s.get("outlier_multiple")),
                   key=lambda s: s["outlier_multiple"], default=None)
        if best:
            return {
                "key": "remix",
                "title": f"Your top post beat its group by {best['outlier_multiple']}×",
                "body": ("Finding it is half of this. The other half is writing your "
                         "own version — open it and generate variants built on the "
                         "same mechanic."),
                "cta": "Open it and remix",
                "href": url_for("post_detail", post_id=best["id"]),
                "scan_demo": False,
            }

    return None


@app.route("/")
def feed():
    """Signed in: the outlier feed. Signed out: the product page.

    Deliberately NOT login_required. The front door used to redirect a
    signed-out visitor to /login, so the first thing a stranger saw was a
    password box — a fine page for somebody who already has an account and a
    bad one for somebody deciding whether to get one. The route keeps its name
    because url_for("feed") is spread across every template.
    """
    if not auth.current_user():
        return landing()

    tier_filter = request.args.get("tier", "all")
    show_samples = request.args.get("samples") == "1"

    # Posts only.
    #
    # Facebook previews one or two replies per post, chosen by "Most
    # relevant". Ranking those produced a "top comment" out of two samples
    # drawn from a hundred and ninety five by somebody else's algorithm.
    # Comment capture is gone; any comment rows still in the database are
    # from older versions and are shown on their post's page as what they
    # are — a partial preview — rather than ranked.
    kind = "post"

    all_posts = _fetch_posts()
    scored = outliers.score_posts(all_posts)

    real_count = sum(1 for s in scored if not s["is_demo"])

    # Everything of this kind, scored or not. Requiring a baseline here is
    # what made the feed useless: hundreds of captured posts sat in the
    # database while the page said "nothing in this band". Unscored posts are
    # ranked by whatever signal they carry and labelled with which one, which
    # is more honest than hiding them and far more useful.
    visible = [s for s in scored if (s.get("item_type") or "post") == kind]

    # Once there are real captures, sample posts stop being helpful and start
    # being noise you have to mentally filter — so hide them by default.
    if real_count and not show_samples:
        visible = [s for s in visible if not s["is_demo"]]
    if tier_filter != "all":
        visible = [s for s in visible if s["tier"] == tier_filter]

    scored_visible = sum(1 for s in visible if s["has_baseline"])

    # Paged, not truncated. The feed used to render visible[:60] and say
    # nothing about it, so 86 captured posts showed 60 cards and the page
    # looked like that was all of them.
    total_visible = len(visible)
    page = max(1, request.args.get("page", type=int) or 1)
    page_count = max(1, -(-total_visible // PAGE_SIZE))
    page = min(page, page_count)
    start = (page - 1) * PAGE_SIZE
    page_items = visible[start:start + PAGE_SIZE]

    # Counted over what is actually on this page, so the divider's number and
    # the cards under it agree.
    scored_here = sum(1 for s in page_items if s["has_baseline"])
    unscored_here = len(page_items) - scored_here

    return render_template(
        "feed.html",
        posts=page_items,
        stats=_global_stats(scored),
        tier_filter=tier_filter,
        tier_labels=outliers.TIER_LABELS,
        has_data=bool(scored),
        next_step=_next_step(auth.current_user(), scored),
        real_count=real_count,
        sample_count=len(scored) - real_count,
        show_samples=show_samples,
        # Distinguishes "nothing captured" from "captured, but not enough of
        # any one group to score" — completely different problems.
        unscored_count=sum(1 for s in scored if not s["has_baseline"]),
        # How much of what's on screen is actually scored, so the page can say
        # which ranking is in force instead of implying every row is a multiple.
        scored_visible=scored_here,
        unscored_visible=unscored_here,
        total_scored=scored_visible,
        total_unscored=total_visible - scored_visible,
        page=page,
        page_count=page_count,
        page_size=PAGE_SIZE,
        total_visible=total_visible,
        range_start=start + 1 if page_items else 0,
        range_end=start + len(page_items),
        rank_basis_labels=outliers.RANK_BASIS_LABELS,
        version=APP_VERSION,
        active="feed",
    )


def _sources_with_stats():
    """Sources plus their stats and whether they're sample data.

    is_demo is carried through so the UI can mark generated posts as such —
    mixing invented sample content into the same feed as real captures with
    no visible distinction is actively misleading.
    """
    user = auth.current_user()
    user_id = user["id"] if user else -1

    with db.get_db() as conn:
        sources = [dict(r) for r in conn.execute(
            """
            SELECT s.*,
                   COUNT(p.id) AS post_count,
                   SUM(CASE WHEN p.is_demo = 1 THEN 1 ELSE 0 END) AS demo_count
            FROM sources s LEFT JOIN posts p ON p.source_id = s.id
            WHERE s.user_id = ?
            GROUP BY s.id ORDER BY s.last_capture DESC
            """, (user_id,)
        ).fetchall()]

    for source in sources:
        source["is_demo"] = bool(source["demo_count"])
        posts = _fetch_posts(source_id=source["id"])
        source["stats"] = outliers.source_stats(posts) if posts else None

    # Real captures first, newest first. Sample data is a demonstration and
    # should never sit above the group the user just scanned.
    sources.sort(key=lambda s: (s["is_demo"], s["last_capture"] or ""), reverse=False)
    sources.sort(key=lambda s: s["is_demo"])
    real = [s for s in sources if not s["is_demo"]]
    demo = [s for s in sources if s["is_demo"]]
    real.sort(key=lambda s: s["last_capture"] or "", reverse=True)
    return real + demo


@app.route("/groups")
@auth.login_required
def groups():
    return render_template(
        "groups.html",
        sources=_sources_with_stats(),
        version=APP_VERSION,
        active="groups",
    )


@app.route("/sage")
@auth.login_required
def sage_page():
    """Chat with Sage, the built-in analyst."""
    with db.get_db() as conn:
        history = [dict(r) for r in conn.execute(
            "SELECT role, content FROM sage_messages WHERE user_id = ? "
            "ORDER BY id ASC LIMIT 60", (_uid(),)
        ).fetchall()]

    config = sage.get_config()
    return render_template(
        "sage.html",
        history=history,
        configured=config["has_key"],
        provider=config["provider"],
        key_source=config["key_source"],
        suggested=sage.SUGGESTED,
        version=APP_VERSION,
        active="sage",
    )


@app.route("/ideas")
@auth.login_required
def ideas_page():
    """Post ideas modelled on what outperformed in one group.

    Reached straight from the extension when a scan finishes, so `source` is
    the Facebook id rather than our row id.
    """
    fb_id = request.args.get("source")
    source_id = request.args.get("source_id", type=int)

    with db.get_db() as conn:
        if fb_id:
            row = conn.execute("SELECT * FROM sources WHERE fb_id = ? AND user_id = ?",
                               (fb_id, _uid())).fetchone()
        elif source_id:
            row = conn.execute("SELECT * FROM sources WHERE id = ? AND user_id = ?",
            (source_id, _uid())).fetchone()
        else:
            row = None

    sources = _sources_with_stats()
    scoreable = [s for s in sources if s["stats"] and s["stats"]["has_baseline"]]

    source = dict(row) if row else None
    posts = []
    if source:
        posts = [
            p for p in outliers.score_posts(_fetch_posts(source_id=source["id"]))
            if p["has_baseline"]
        ]

    return render_template(
        "ideas.html",
        source=source,
        posts=posts[:10],
        sources=scoreable,
        configured=sage.is_configured(),
        version=APP_VERSION,
        active="ideas",
    )


@app.route("/api/ideas/<int:source_id>", methods=["POST"])
@auth.login_required
def api_ideas(source_id):
    with db.get_db() as conn:
        row = conn.execute("SELECT * FROM sources WHERE id = ? AND user_id = ?",
                               (source_id, _uid())).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "Group not found"}), 404

    scored = [
        p for p in outliers.score_posts(_fetch_posts(source_id=source_id))
        if p["has_baseline"]
    ]
    if not scored:
        return jsonify({
            "ok": False,
            "error": "This group has no scored posts yet — it needs 8+ posts "
                     "with engagement before there's a pattern to work from.",
        }), 400

    result, error = sage.generate_ideas(row["name"], scored)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    return jsonify({"ok": True, "result": result})


@app.route("/api/sage", methods=["POST"])
@auth.login_required
def api_sage():
    body = request.get_json(silent=True) or {}
    question = (body.get("message") or "").strip()
    if not question:
        return jsonify({"ok": False, "error": "Ask something first"}), 400

    # Replay recent turns so follow-ups ("why that one?") have their referent.
    with db.get_db() as conn:
        prior = [dict(r) for r in conn.execute(
            "SELECT role, content FROM sage_messages WHERE user_id = ? "
            "ORDER BY id DESC LIMIT 12", (_uid(),)
        ).fetchall()][::-1]

    messages = [{"role": m["role"], "content": m["content"]} for m in prior]
    messages.append({"role": "user", "content": question})

    answer, error = sage.ask(messages)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    with db.get_db() as conn:
        conn.execute("INSERT INTO sage_messages (user_id, role, content) "
                     "VALUES (?, 'user', ?)", (_uid(), question))
        conn.execute("INSERT INTO sage_messages (user_id, role, content) "
                     "VALUES (?, 'assistant', ?)", (_uid(), answer))

    return jsonify({"ok": True, "answer": answer})


@app.route("/api/sage/clear", methods=["POST"])
@auth.login_required
def api_sage_clear():
    with db.get_db() as conn:
        conn.execute("DELETE FROM sage_messages WHERE user_id = ?", (_uid(),))
    return jsonify({"ok": True})


@app.route("/api/sage/config", methods=["POST"])
@auth.login_required
def api_sage_config():
    body = request.get_json(silent=True) or {}
    provider = body.get("provider")
    key = (body.get("key") or "").strip()
    model = (body.get("model") or "").strip()

    if provider not in ("anthropic", "openai"):
        return jsonify({"ok": False, "error": "Pick anthropic or openai"}), 400

    sage.set_setting("ai_provider", provider)
    if model:
        sage.set_setting("ai_model", model)
    # An empty key means "leave the stored one alone" rather than "erase it",
    # so re-saving the provider doesn't silently wipe a working key.
    if key:
        sage.set_setting("ai_key_" + provider, key)

    config = sage.get_config()
    return jsonify({
        "ok": True,
        "provider": config["provider"],
        "has_key": config["has_key"],
        "key_source": config["key_source"],
        "model": config["model"],
    })


@app.route("/api/brand", methods=["POST"])
@auth.login_required
def api_brand():
    """Save the operator's brand profile — used by Sage and the graphic prompt."""
    sage.set_brand(request.get_json(silent=True) or {})
    return jsonify({"ok": True, "has_brand": sage.has_brand()})


@app.route("/settings")
@auth.login_required
def settings():
    sources = _sources_with_stats()
    # `sources` still feeds the counters at the top of the page; the table
    # that listed them lives on Groups, which is the page about sources.
    return render_template(
        "settings.html",
        sources=sources,
        totals={
            "posts": sum(s["post_count"] for s in sources),
            "demo": sum(s["demo_count"] or 0 for s in sources),
            "real": sum(s["post_count"] - (s["demo_count"] or 0) for s in sources),
            "sources": len(sources),
        },
        sage_config=sage.get_config(),
        anthropic_model=sage.ANTHROPIC_MODEL,
        openai_model=sage.OPENAI_MODEL,
        brand=sage.get_brand(),
        version=APP_VERSION,
        active="settings",
    )


@app.route("/groups/<int:source_id>")
@auth.login_required
def group_detail(source_id):
    with db.get_db() as conn:
        source = conn.execute(
            "SELECT * FROM sources WHERE id = ? AND user_id = ?",
            (source_id, _uid()),
        ).fetchone()
    if not source:
        return render_template("404.html", version=APP_VERSION), 404

    # Posts only, same reason as the feed. This page used to list posts and
    # comments in one stream under a heading that counted only the posts, so
    # a 25-post group rendered 31 cards.
    posts = _fetch_posts(source_id=source_id)
    scored = outliers.score_posts(posts)
    visible = [s for s in scored if (s.get("item_type") or "post") == "post"]

    blades, meadow_width = _meadow(visible)

    return render_template(
        "group_detail.html",
        source=dict(source),
        posts=visible,
        blades=blades,
        meadow_width=meadow_width,
        stats=outliers.source_stats(posts) if posts else None,
        tier_labels=outliers.TIER_LABELS,
        version=APP_VERSION,
        active="groups",
    )


BLADE_STEP = 7          # horizontal gap between stalks
BLADE_MAX_H = 108       # tallest a blade may grow, inside a 150 tall canvas
BLADE_MIN_H = 7         # a scored post is never invisible


def _meadow(scored):
    """Turn scored posts into blades of grass standing on the median.

    Height is the multiple on a log scale. Linear would make one 60x post a
    skyscraper beside a field of stubble, which hides exactly the comparison
    this is drawn for — how the merely-good posts differ from each other.
    Doubling the multiple adds a fixed amount of height instead.

    Only posts with a baseline get a blade. Without one there is no multiple,
    so a stalk would be asserting a height the app cannot stand behind.
    """
    ranked = [s for s in scored
              if s.get("has_baseline") and s.get("outlier_multiple")]
    if not ranked:
        return [], 0

    # Oldest on the left, so the field reads left to right like the group did.
    ranked.sort(key=lambda s: (s.get("posted_at") or "", s["id"]))

    tallest = max(s["outlier_multiple"] for s in ranked)
    ceiling = math.log2(max(tallest, 2))

    blades = []
    for i, post in enumerate(ranked):
        share = math.log2(max(post["outlier_multiple"], 1) + 1) / (ceiling + 1)
        height = round(BLADE_MIN_H + share * (BLADE_MAX_H - BLADE_MIN_H), 1)

        body = (post.get("body") or "").strip()
        label = (body[:60] + "…") if len(body) > 60 else (body or "no caption")

        blades.append({
            "id": post["id"],
            "x": 6 + i * BLADE_STEP,
            "height": height,
            # Alternating lean, so a row of equal posts still looks like grass
            # rather than a comb.
            "lean": (2.2 if i % 2 else -2.2) + (0.9 if i % 3 == 0 else 0),
            "multiple": post["outlier_multiple"],
            "breakout": post.get("tier") == "breakout",
            "label": label,
        })

    return blades, 12 + len(blades) * BLADE_STEP


@app.route("/post/<int:post_id>")
@auth.login_required
def post_detail(post_id):
    # Score against the full set so the multiple matches what the feed showed.
    scored = outliers.score_posts(_fetch_posts())
    post = next((s for s in scored if s["id"] == post_id), None)
    if not post:
        return render_template("404.html", version=APP_VERSION), 404

    # A comment on its own is close to meaningless — what it replied to is
    # the point. Comments were opening a page that showed the reply and
    # nothing else, with no way to reach the post it belonged to.
    parent = None
    replies = []
    if (post.get("item_type") or "post") == "comment":
        if post.get("parent_fb_id"):
            parent = next((s for s in scored
                           if s["fb_post_id"] == post["parent_fb_id"]), None)
    else:
        replies = sorted(
            (s for s in scored
             if (s.get("item_type") or "post") == "comment"
             and s.get("parent_fb_id") == post["fb_post_id"]),
            key=lambda s: s["weighted_engagement"], reverse=True,
        )

    with db.get_db() as conn:
        remix_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM remixes WHERE post_id = ? AND user_id = ? "
            "ORDER BY created_at DESC", (post_id, _uid()),
        ).fetchall()]

    for row in remix_rows:
        try:
            row["parsed"] = json.loads(row["output"])
        except (json.JSONDecodeError, TypeError):
            row["parsed"] = None

    return render_template(
        "post_detail.html",
        post=post,
        parent=parent,
        replies=replies,
        remixes=remix_rows,
        angles=remix.ANGLES,
        remix_ready=remix.is_configured(),
        tier_labels=outliers.TIER_LABELS,
        version=APP_VERSION,
        active="feed",
    )


@app.route("/library")
@auth.login_required
def library():
    with db.get_db() as conn:
        saved_ids = [r["post_id"] for r in conn.execute(
            "SELECT post_id FROM saved WHERE user_id = ? ORDER BY created_at DESC",
            (_uid(),)
        ).fetchall()]
        remix_count = conn.execute(
            "SELECT COUNT(*) AS n FROM remixes WHERE user_id = ?", (_uid(),)
        ).fetchone()["n"]

    scored = outliers.score_posts(_fetch_posts())
    by_id = {s["id"]: s for s in scored}
    saved_posts = [by_id[i] for i in saved_ids if i in by_id]

    return render_template(
        "library.html",
        posts=saved_posts,
        remix_count=remix_count,
        tier_labels=outliers.TIER_LABELS,
        version=APP_VERSION,
        active="library",
    )


def _diagnosis():
    """Everything needed to answer "is capture actually working right now".

    Built because answering that took a whole day once. Each check reports a
    state and the thing to do about it, so a scan that is quietly going
    nowhere is one page away from an explanation instead of a guess.
    """
    user = auth.current_user()
    checks = []

    with db.get_db() as conn:
        last = conn.execute(
            """
            SELECT c.created_at, c.post_count, c.new_count, s.name AS source_name
            FROM captures c LEFT JOIN sources s ON s.id = c.source_id
            WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 1
            """, (user["id"],)
        ).fetchone()
        week = conn.execute(
            """
            SELECT COUNT(*) AS n FROM posts
            WHERE user_id = ? AND is_demo = 0
              AND captured_at >= datetime('now', '-7 days')
            """, (user["id"],)
        ).fetchone()["n"]
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND is_demo = 0",
            (user["id"],),
        ).fetchone()["n"]

    # An account key exists at all. Without one the extension cannot post,
    # and the failure surfaces on the page as a bare 401.
    checks.append({
        "name": "Account key",
        "ok": bool(user.get("api_key_prefix")),
        "detail": ("Issued — the extension picks it up automatically"
                   if user.get("api_key_prefix")
                   else "None issued. Open the Capture page while signed in."),
    })

    # Metering is the quiet one. A capped account is refused at ingest, so the
    # extension shows posts captured and nothing delivered, with the reason
    # buried in a panel.
    allowed, reason = billing.capture_allowed(user)
    if billing.is_admin(user):
        meter = "Owner — never metered"
    elif billing.is_pro(user):
        meter = "Pro — unlimited capture"
    else:
        meter = f"Free — {total:,} of {billing.FREE_LIMITS['posts']:,} posts stored"
    checks.append({
        "name": "Plan",
        "ok": bool(allowed),
        "detail": reason or meter,
    })

    # Something arrived, and when. A scan that reports sending while this
    # stays still is not sending.
    if last:
        checks.append({
            "name": "Last capture received",
            "ok": True,
            "detail": (f"{last['post_count']} posts from "
                       f"{last['source_name'] or 'a source'} — {age_of(last['created_at'])}"),
        })
    else:
        checks.append({
            "name": "Last capture received",
            "ok": False,
            "detail": "Nothing has ever arrived. Run a scan with the extension open.",
        })

    checks.append({
        "name": "Storage",
        "ok": not db.storage_is_ephemeral(),
        "detail": ("Captures survive restarts"
                   if not db.storage_is_ephemeral()
                   else "This host resets on deploy — captures will be lost."),
    })

    return {"checks": checks, "week": week, "total": total,
            "endpoint": request.url_root.rstrip("/")}


def age_of(stamp):
    """'4 minutes ago', from a stored UTC timestamp."""
    if not stamp:
        return "never"
    try:
        then = datetime.fromisoformat(str(stamp).replace("Z", ""))
    except ValueError:
        return str(stamp)
    seconds = max(0, (datetime.utcnow() - then).total_seconds())
    for limit, div, word in ((60, 1, "second"), (3600, 60, "minute"),
                             (86400, 3600, "hour")):
        if seconds < limit:
            n = int(seconds // div) or 1
            return f"{n} {word}{'' if n == 1 else 's'} ago"
    n = int(seconds // 86400)
    return f"{n} day{'' if n == 1 else 's'} ago"


@app.route("/diagnostics")
@auth.login_required
def diagnostics():
    import capture_health

    # Evaluated on this page view rather than on a schedule, because there is
    # no scheduler. The alert is global and throttled to one per day per shape
    # of failure, so an admin opening Health is what makes the check run — and
    # an admin opening Health is exactly when it should.
    try:
        capture_health.check_and_alert()
    except Exception:            # never let monitoring take out the page
        app.logger.exception("capture health check failed")

    user = auth.current_user()
    return render_template(
        "diagnostics.html", version=APP_VERSION, active="diagnostics",
        health=capture_health.report(user["id"] if user else None),
        **_diagnosis(),
    )


@app.route("/capture")
@auth.login_required
def capture():
    with db.get_db() as conn:
        recent = [dict(r) for r in conn.execute(
            """
            SELECT c.*, s.name AS source_name
            FROM captures c LEFT JOIN sources s ON s.id = c.source_id
            WHERE c.user_id = ?
            ORDER BY c.created_at DESC LIMIT 10
            """, (_uid(),)
        ).fetchall()]

    return render_template(
        "capture.html",
        recent_captures=recent,
        # Absolute path to the folder Chrome should load, so the user can copy
        # it rather than hunting for it.
        extension_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension"),
        extension_version=_extension_version(),
        is_local=_is_local_dashboard(),
        has_data=db.has_any_posts(_uid()),
        # The name filter moved here from Settings: it is a rule about how
        # scanning behaves, not a personal detail.
        viewer_names=sage.get_setting(db.VIEWER_NAMES_KEY, ""),
        version=APP_VERSION,
        active="capture",
    )


# ---------------------------------------------------------------- ingest API


@app.context_processor
def inject_globals():
    """Values every page needs, so no route can forget them."""
    return {
        "ephemeral": db.storage_is_ephemeral(),
        "user": auth.current_user(),
        "csrf_token": auth.csrf_token,
        "app_name": APP_NAME,
        "app_short_name": APP_SHORT_NAME,
        "app_parent": APP_PARENT,
        "app_tagline": APP_TAGLINE,
        "support_email": SUPPORT_EMAIL,
        "updated": LEGAL_UPDATED,
        # The scoring thresholds, so no template hardcodes "8" and quietly
        # disagrees with the engine when it changes.
        "min_sample": outliers.MIN_SAMPLE,
        "min_baseline": outliers.MIN_BASELINE,
        # The free plan's actual limits. Three pages described it as "one
        # group" long after the source limit was removed, and the pricing
        # page contradicted itself inside a single screen — its header said
        # one group while its own feature list said unlimited.
        "free_limits": billing.FREE_LIMITS,
    }


# Endpoints that legitimately have no session cookie to protect: the extension
# authenticates with an API key, and Stripe signs its webhooks.
# Endpoints that legitimately have no CSRF token: the extension authenticates
# with an API key or its own header, and Stripe signs its webhooks.
CSRF_EXEMPT = {"/api/capture", "/api/ping", "/api/stripe/webhook",
               "/api/extension/key"}


@app.before_request
def enforce_csrf():
    """Reject state-changing requests that don't carry the session's token.

    SameSite=Lax already blocks cross-site form posts, but that is a single
    browser-enforced control. This is the second, and it is server-side.
    """
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if request.path in CSRF_EXEMPT:
        return None
    if not auth.current_user():
        return None                       # nothing to forge against yet
    if auth.check_csrf():
        return None

    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Invalid or missing CSRF token"}), 403
    return render_template("403.html", version=APP_VERSION), 403


# ------------------------------------------------------------------ visits

# Paths that are machinery rather than pages. Counting these would drown the
# real numbers: the extension polls /api/ constantly, and a page pulling four
# assets would read as five visits.
_VISIT_SKIP = ("/static/", "/api/", "/favicon", "/health")


def _visitor_hash():
    """A stable, non-reversible handle for one browser.

    Address and agent, salted with the app's own secret and truncated. It
    survives long enough to tell six page views by one person from six people,
    and it cannot be turned back into an address — which is the whole design.
    There is no third-party analytics script anywhere in this app.
    """
    import hashlib
    forwarded = request.headers.get("X-Forwarded-For", "")
    address = (forwarded.split(",")[0].strip() or request.remote_addr or "?")
    raw = f"{address}|{request.headers.get('User-Agent', '')}|{app.secret_key}"
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:32]


@app.after_request
def track_visit(response):
    """Count real page views, after the page has already been produced.

    In after_request rather than before, so a counter can never be the reason
    a page fails to render, and only for HTML that actually succeeded — a 404
    or a redirect is not a visit.
    """
    try:
        if request.method != "GET":
            return response
        if response.status_code != 200:
            return response
        if not (response.content_type or "").startswith("text/html"):
            return response
        if any(request.path.startswith(p) for p in _VISIT_SKIP):
            return response

        user = auth.current_user()
        db.record_visit(
            request.path,
            visitor=_visitor_hash(),
            user_id=user["id"] if user else None,
            referrer=request.referrer,
        )
    except Exception:
        pass                                # never break a page over a metric
    return response


# ---------------------------------------------------------------- accounts


ALLOW_SIGNUPS = os.environ.get("ALLOW_SIGNUPS", "1") != "0"


@app.route("/login", methods=["GET", "POST"])
def login():
    if auth.current_user():
        return redirect(url_for("feed"))

    error = None
    if request.method == "POST":
        user, error = auth.verify_user(
            request.form.get("email"), request.form.get("password")
        )
        if user:
            auth.login_session(user)
            # Only accept a relative path, so ?next= cannot bounce a freshly
            # signed-in user to another site.
            target = request.args.get("next", "")
            if not target.startswith("/") or target.startswith("//"):
                target = url_for("feed")
            return redirect(target)

    return render_template(
        "login.html", error=error, allow_signups=ALLOW_SIGNUPS,
        version=APP_VERSION,
    ), (400 if error else 200)


@app.route("/register", methods=["GET", "POST"])
def register():
    if auth.current_user():
        return redirect(url_for("feed"))
    if not ALLOW_SIGNUPS:
        return render_template(
            "login.html", error="Registration is closed on this instance.",
            allow_signups=False, version=APP_VERSION,
        ), 403

    error = None
    if request.method == "POST":
        password = request.form.get("password") or ""
        if auth.signup_throttled(client_ip()):
            error = "Too many accounts created from here. Try again later."
        elif password != (request.form.get("password_confirm") or ""):
            error = "Passwords don't match."
        else:
            user, error = auth.create_user(
                request.form.get("email"), password,
                username=request.form.get("username"))
            if user:
                auth.record_signup(client_ip())
                # A pre-existing single-user install would otherwise find its
                # own captures invisible once everything is owner-scoped.
                claimed = db.claim_unowned_data(user["id"])
                auth.login_session(user)
                session["fresh_api_key"] = user["api_key"]
                session["claimed_rows"] = claimed
                return redirect(url_for("capture"))

    return render_template(
        "register.html", error=error, min_length=auth.MIN_PASSWORD_LENGTH,
        form_email=(request.form.get("email") or "").strip(),
        form_username=(request.form.get("username") or "").strip(),
        version=APP_VERSION,
    ), (400 if error else 200)


@app.route("/logout", methods=["POST"])
def logout():
    auth.logout_session()
    return redirect(url_for("login"))


@app.route("/account")
@auth.login_required
def account():
    user = auth.current_user()
    return render_template(
        "account.html",
        account=user,
        # Shown once, immediately after registration — never retrievable later.
        fresh_api_key=session.pop("fresh_api_key", None),
        claimed_rows=session.pop("claimed_rows", 0),
        version=APP_VERSION,
        active="account",
    )


@app.route("/admin/scoring")
@auth.login_required
def scoring_audit_page():
    """Is the ranking model actually sound? Read-only.

    Admin-gated not because the numbers are sensitive but because this is a
    question about the product rather than about anyone's posts, and it reads
    every row in the table to answer it.
    """
    if not _require_admin():
        return render_template("403.html", version=APP_VERSION), 403

    import scoring_audit
    return render_template(
        "scoring_audit.html",
        active="admin",
        report=scoring_audit.audit(_fetch_posts()),
        tier_labels=outliers.TIER_LABELS,
        max_multiple=outliers.MAX_MULTIPLE,
        min_baseline=outliers.MIN_BASELINE,
    )


@app.route("/playbook")
@auth.login_required
def playbook():
    """How to use the thing well — a different question from what it does.

    The app can rank posts and draft variants; it cannot tell you which winner
    suits your voice. Leaving that unsaid implies the top row is always the
    right row, which is the most common way to use this badly.
    """
    return render_template("playbook.html", active="playbook")


@app.route("/welcome")
def landing():
    """The product page, always — signed in or not.

    "/" only shows this to signed-out visitors, which makes it invisible to the
    one person most likely to want to look at it: the operator, who is signed
    in on every device they own. This is also the URL to put in an email or an
    ad, where the reader may well have an account already.
    """
    return render_template("landing.html", allow_signups=ALLOW_SIGNUPS,
                           version=APP_VERSION)


@app.route("/pricing")
def pricing():
    user = auth.current_user()
    return render_template(
        "pricing.html",
        plans=billing.PLANS,
        pro_features=billing.PRO_FEATURES,
        free_features=billing.FREE_FEATURES,
        free_limits=billing.FREE_LIMITS,
        billing_ready=billing.is_configured(),
        is_pro=billing.is_pro(user),
        usage=billing.usage(user["id"]) if user else None,
        version=APP_VERSION,
        active="pricing",
    )


@app.route("/privacy")
def privacy():
    """Public on purpose — the Chrome Web Store listing links straight here,
    and a reviewer hitting a login wall is a rejected submission."""
    return render_template("privacy.html", version=APP_VERSION, active="legal")


@app.route("/terms")
def terms():
    return render_template("terms.html", version=APP_VERSION, active="legal")


@app.route("/billing/checkout/<interval>", methods=["POST"])
@auth.login_required
def billing_checkout(interval):
    user = auth.current_user()
    url, error = billing.create_checkout_session(
        user,
        interval,
        success_url=url_for("account", _external=True) + "?upgraded=1",
        cancel_url=url_for("pricing", _external=True),
    )
    if error:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True, "url": url})


@app.route("/billing/portal", methods=["POST"])
@auth.login_required
def billing_portal():
    url, error = billing.create_portal_session(
        auth.current_user(), return_url=url_for("account", _external=True)
    )
    if error:
        return render_template("403.html", message=error, version=APP_VERSION), 400
    return redirect(url)


@app.route("/api/stripe/webhook", methods=["POST"])
def stripe_webhook():
    """Entitlement is granted here and nowhere else.

    The success redirect is attacker-controllable — anyone can visit it — so
    it only shows a confirmation. What a user is actually entitled to comes
    from this signature-verified call.
    """
    event, error = billing.verify_webhook(
        request.get_data(), request.headers.get("Stripe-Signature", "")
    )
    if error:
        return jsonify({"ok": False, "error": error}), 400

    kind = event["type"]
    obj = event["data"]["object"]

    if kind == "checkout.session.completed":
        user_id = (obj.get("client_reference_id")
                   or (obj.get("metadata") or {}).get("user_id"))
        if user_id:
            billing.apply_subscription(
                int(user_id),
                plan="pro",
                billing_interval=(obj.get("metadata") or {}).get("interval"),
                stripe_customer_id=obj.get("customer"),
                stripe_subscription_id=obj.get("subscription"),
                subscription_status="active",
            )

    elif kind in ("customer.subscription.updated", "customer.subscription.deleted"):
        user_id = billing.user_id_for_customer(obj.get("customer"))
        if user_id:
            status = obj.get("status")
            ended = kind.endswith("deleted") or status in ("canceled", "unpaid")
            period_end = obj.get("current_period_end")
            billing.apply_subscription(
                user_id,
                plan="free" if ended else "pro",
                subscription_status="canceled" if ended else status,
                current_period_end=(
                    datetime.fromtimestamp(period_end, tz=timezone.utc).isoformat()
                    if period_end else None
                ),
            )

    return jsonify({"ok": True})


@app.route("/api/account/connect", methods=["POST"])
@auth.login_required
def api_connect_extension():
    """Issue a key for the one-click connect.

    Keys are stored hashed and cannot be read back, so connecting mints a
    fresh one. That keeps plaintext out of the database entirely; the cost is
    that connecting here disconnects any other browser using the old key,
    which the page says plainly.
    """
    new_key = auth.rotate_api_key(auth.current_user()["id"])
    return jsonify({"ok": True, "api_key": new_key, "endpoint": request.url_root.rstrip("/")})


@app.route("/api/extension/key", methods=["POST"])
@auth.login_required
def api_extension_key():
    """Hand the extension a key using the session it already has.

    Nobody should ever type or paste a key. The extension runs in the same
    browser that is signed in here, and it holds a host permission for this
    origin — so it can ask for a key itself, with the session cookie, and get
    one without the user doing anything at all.

    Two things keep this from being a hole a web page could use:

      * the custom header. A page cannot send it cross-origin without a CORS
        preflight, and this route sends no Access-Control-Allow-Origin, so
        the browser refuses the response. The extension is exempt from CORS
        for origins in its host_permissions, which is exactly the asymmetry
        wanted here.
      * the session cookie is SameSite=Lax, so a cross-site POST from another
        page carries no session at all and lands on the login redirect.

    It only rotates when it has to. Keys are stored hashed and cannot be read
    back, so issuing one used to mean minting one — and minting revokes
    whatever was in use. That turned every concurrent call into a fight: two
    batches hitting a stale key both asked for a replacement, the second
    rotation invalidated the first, and the extension chased a key that was
    revoked before it could spend it. A scan of fifty delivered six.

    So a caller that already holds a working key gets that key back
    unchanged. The extension presents what it has; if it still verifies and
    belongs to this account, nothing rotates and no other browser is kicked
    off. Rotation is left for the case it was meant for — a caller with no
    valid key at all.
    """
    if request.headers.get("X-Tallgrass-Extension") != "1":
        return jsonify({"ok": False, "error": "Not an extension request"}), 403

    user = auth.current_user()
    presented = request.headers.get("X-Outlier-Key", "").strip()

    if presented:
        owner = auth.user_for_api_key(presented)
        if owner and owner["id"] == user["id"]:
            return jsonify({
                "ok": True,
                "api_key": presented,
                "rotated": False,
                "endpoint": request.url_root.rstrip("/"),
            })

    return jsonify({
        "ok": True,
        "api_key": auth.rotate_api_key(user["id"]),
        "rotated": True,
        "endpoint": request.url_root.rstrip("/"),
    })


@app.route("/api/account/rotate-key", methods=["POST"])
@auth.login_required
def api_rotate_key():
    new_key = auth.rotate_api_key(auth.current_user()["id"])
    return jsonify({"ok": True, "api_key": new_key})


@app.route("/api/account/password", methods=["POST"])
@auth.login_required
def api_change_password():
    body = request.get_json(silent=True) or {}
    user = auth.current_user()

    # Re-authenticate before changing the credential, so a hijacked session
    # cannot lock the real owner out.
    _, error = auth.verify_user(user["email"], body.get("current") or "")
    if error:
        return jsonify({"ok": False, "error": "Current password is incorrect."}), 400

    error = auth.set_password(user["id"], body.get("new") or "")
    if error:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True})


def _is_local_dashboard():
    """True when the browser is talking to a dashboard on its own machine.

    This decides which install route to show. Loading the extension from the
    project folder — and the self-update that depends on it — only works when
    the server's filesystem IS the user's filesystem. On a hosted deployment
    (Render) the only route is downloading a zip.
    """
    host = (request.host or "").split(":")[0].lower()
    return host in ("localhost", "127.0.0.1", "::1", "[::1]")


def _extension_version():
    """The version of the extension this dashboard is serving.

    Read from disk on each call rather than reused from APP_VERSION, because
    an extension already loaded in a browser can be older than the copy here —
    that difference is exactly what the popup reports. On a running server the
    two are the same file and therefore the same number.
    """
    return _manifest_version(APP_VERSION)


@app.route("/api/ping", methods=["GET", "POST", "OPTIONS"])
def api_ping():
    """The extension calls this to confirm the dashboard is reachable."""
    if request.method == "OPTIONS":
        return "", 204
    return jsonify({
        "ok": True,
        "version": APP_VERSION,
        "extension_version": _extension_version(),
        "is_local": _is_local_dashboard(),
    })


def _warn_approaching_cap(api_user):
    """Tell a free account it is nearing the cap, once, before it bites.

    Volume is the only difference between the tiers, so the moment somebody
    runs out is the entire upgrade conversation — and discovering it by having
    a scan refused halfway through is the worst possible way to have it. This
    lands while capture still works, with the number that matters.

    Fired once per account: the flag is a settings row, so a user who upgrades
    and later downgrades gets a fresh warning rather than silence.
    """
    try:
        if billing.is_pro(api_user) or billing.is_admin(api_user):
            return
        cap = billing.FREE_LIMITS.get("posts")
        if not cap:
            return

        stored = billing.usage(api_user["id"])["posts"]
        if stored < cap * 0.8 or stored >= cap:
            return                       # not yet, or already stopped

        with db.get_db() as conn:
            seen = conn.execute(
                "SELECT 1 FROM user_settings WHERE user_id = ? AND key = 'cap_warned'",
                (api_user["id"],),
            ).fetchone()
            if seen:
                return
            conn.execute(
                "INSERT OR REPLACE INTO user_settings (user_id, key, value) "
                "VALUES (?, 'cap_warned', '1')", (api_user["id"],),
            )

        db.notify(
            api_user["id"], "quota",
            f"{stored:,} of {cap:,} posts stored",
            body=("Capture stops at the cap. Everything else — Sage, remix, "
                  "ideas, export — stays exactly as it is."),
            url="/pricing",
        )
    except Exception:
        pass                             # a nudge is never worth failing a capture


@app.route("/api/capture", methods=["POST", "OPTIONS"])
def api_capture():
    """Ingest a batch of posts scraped by the extension.

    Authenticated by API key rather than session cookie: this endpoint is
    called cross-origin from facebook.com, and accepting ambient browser
    authority there would let any page drive it for a signed-in user.
    """
    if request.method == "OPTIONS":
        return "", 204

    api_user = auth.user_for_api_key(request.headers.get("X-Outlier-Key", "").strip())
    if not api_user:
        return jsonify({
            "ok": False,
            "error": "Invalid or missing API key — copy it from your account "
                     "page into the extension.",
        }), 401

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"ok": False, "error": "Expected a JSON body"}), 400

    source = payload.get("source") or {}
    posts = payload.get("posts") or []

    if not source.get("fb_id"):
        return jsonify({"ok": False, "error": "source.fb_id is required"}), 400
    if not isinstance(posts, list):
        return jsonify({"ok": False, "error": "posts must be a list"}), 400

    allowed, limit_reason = billing.capture_allowed(api_user)
    if allowed is False:
        return jsonify({"ok": False, "error": limit_reason, "upgrade": True}), 402

    new_count = 0
    with db.get_db() as conn:
        # Cached: a feed batch carries a source object on most rows, and
        # several dozen of them resolve to the same handful of groups.
        source_ids = {}

        def resolve(spec):
            fb_id = str(spec["fb_id"])
            if fb_id not in source_ids:
                source_ids[fb_id] = db.upsert_source(
                    conn,
                    fb_id=fb_id,
                    kind=spec.get("kind", "group"),
                    name=spec.get("name") or "Untitled source",
                    url=spec.get("url"),
                    member_count=spec.get("member_count"),
                    user_id=api_user["id"],
                )
            return source_ids[fb_id]

        # Resolved lazily. On a feed capture every post carries its own
        # origin, so creating the page-level "Home feed" source would leave an
        # empty row cluttering /groups that the user never captured.
        source_id = None

        # The operator's own name, stripped here rather than in the extension.
        #
        # Every previous attempt at this tried to recognise the reader's name
        # from Facebook's markup, and every one of them missed. Doing it on
        # the server means it does not depend on finding the right container,
        # and it does not depend on which build of the extension is installed
        # — an old extension that still sends "Jeff" gets it stripped anyway.
        viewer_parts = db.viewer_name_parts(conn, api_user["id"])

        # How many authors each short caption in THIS batch has already
        # appeared under — asked once for the whole batch rather than once per
        # post, which grew with everything the account had ever captured.
        author_counts = db.caption_author_counts(
            conn, api_user["id"], [p.get("body") for p in posts])

        for post in posts:
            if not post.get("fb_post_id"):
                continue

            # Done before the id matters: the extension already computed
            # fb_post_id and sent it, so clearing the body here cannot change
            # the identity of the row or duplicate it on the next scan.
            if db.is_viewer_name_body(post.get("body"), viewer_parts):
                post["body"] = ""
                post["body_from_image"] = 0

            # A post captured from the home or groups feed carries its own
            # origin, because the post above it came from somewhere else.
            # Filing a whole feed under one source would score unrelated
            # posts against a shared median, which is the one thing this
            # product must not do.
            post_source = post.get("source")
            if isinstance(post_source, dict) and post_source.get("fb_id"):
                post_source_id = resolve(post_source)
            else:
                if source_id is None:
                    source_id = resolve(source)
                post_source_id = source_id

            author_id = db.upsert_author(
                conn,
                name=post.get("author_name"),
                profile_url=post.get("author_url"),
            )

            # A caption that has already arrived under other people's names is
            # not a caption.
            #
            # This needs no setting and no knowledge of whose name it is. Two
            # different authors do not write the same one-word post, so a
            # single token already seen under two or more authors is page
            # furniture whatever it says — which is what catches the case the
            # name filter misses when nobody has filled the field in.
            _body = (post.get("body") or "").strip()
            if db.furniture_caption(_body) and author_counts.get(_body, 0) >= 2:
                post["body"] = ""
                post["body_from_image"] = 0

            if db.upsert_post(conn, post_source_id, author_id, post,
                              user_id=api_user["id"]):
                new_count += 1

        # The capture log points at the page-level source when there is one;
        # for a feed scan it points at whichever source the batch touched.
        logged_source = source_id
        if logged_source is None and source_ids:
            logged_source = next(iter(source_ids.values()))
        conn.execute(
            "INSERT INTO captures (user_id, source_id, post_count, new_count) "
            "VALUES (?, ?, ?, ?)",
            (api_user["id"], logged_source, len(posts), new_count),
        )

    # AFTER the transaction closes, never inside it.
    #
    # This sat inside the `with` block and opened its own connection, so it
    # queued behind the write lock the block still held — eight seconds of
    # busy_timeout, then an exception, then swallowed. Every capture would
    # have paid that stall and the warning would never once have fired.
    _warn_approaching_cap(api_user)

    return jsonify({
        "ok": True,
        "received": len(posts),
        "new": new_count,
        "source_id": logged_source,
        # WHOSE dashboard these landed in.
        #
        # The extension carries its own API key, so it delivers to whichever
        # account minted that key — not to whoever happens to be signed in on
        # the dashboard. When those differ the server accepts everything and
        # reports success, and the dashboard correctly shows nothing, because
        # the posts are not that account's. From the outside that is
        # indistinguishable from data being lost, and it is the third time
        # today something has been invisible rather than wrong.
        #
        # Saying the account name on every batch makes the mismatch obvious in
        # the moment: if that is not you, the key is the problem.
        "account": db.display_name(api_user),
        "sources_touched": len(source_ids),
    })


# ---------------------------------------------------------------- actions


@app.route("/api/save/<int:post_id>", methods=["POST"])
@auth.login_required
def api_save(post_id):
    with db.get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM saved WHERE post_id = ? AND user_id = ?", (post_id, _uid())
        ).fetchone()
        if existing:
            conn.execute("DELETE FROM saved WHERE post_id = ? AND user_id = ?",
                         (post_id, _uid()))
            saved = False
        else:
            conn.execute("INSERT INTO saved (post_id, user_id) VALUES (?, ?)",
                         (post_id, _uid()))
            saved = True
    return jsonify({"ok": True, "saved": saved})


@app.route("/api/remix/<int:post_id>", methods=["POST"])
@auth.login_required
def api_remix(post_id):
    body = request.get_json(silent=True) or {}
    angles = body.get("angles") or None
    # The operator's own steer. Optional — with none supplied the variants are
    # assembled exactly as they were before.
    instructions = (body.get("instructions") or "").strip()

    scored = outliers.score_posts(_fetch_posts())
    post = next((s for s in scored if s["id"] == post_id), None)
    if not post:
        return jsonify({"ok": False, "error": "Post not found"}), 404

    result, error = remix.remix_post(post, angles=angles, instructions=instructions)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO remixes (post_id, user_id, angle, output, model) "
            "VALUES (?, ?, ?, ?, ?)",
            (post_id, _uid(), ",".join(angles or []), json.dumps(result), remix.MODEL),
        )

    return jsonify({"ok": True, "result": result})


@app.route("/api/graphic", methods=["POST"])
@auth.login_required
def api_graphic():
    """Turn a remix variant's hook into a shareable illustration (OpenAI)."""
    body = request.get_json(silent=True) or {}
    hook = (body.get("hook") or body.get("text") or "").strip()
    # The operator's own art direction. Optional — with none supplied the
    # house style applies exactly as it did before.
    instructions = (body.get("instructions") or body.get("prompt") or "").strip()
    # The variant's full copy, not just its opening line. A hook describes no
    # scene, so illustrating one produced pictures unrelated to the post.
    copy = (body.get("body") or "").strip()
    if not hook and not instructions and not copy:
        return jsonify({"ok": False, "error": "Nothing to illustrate."}), 400
    image, error = remix.generate_graphic(hook, instructions=instructions, body=copy)
    if error:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True, "image": image})


@app.route("/api/demo", methods=["POST", "DELETE"])
@auth.login_required
def api_demo():
    """Load or clear clearly-labelled sample data.

    Without the extension installed the app has nothing to show, which makes it
    impossible to tell a working install from a broken one. Demo posts are
    flagged is_demo=1 and can be wiped in one call.
    """
    if request.method == "DELETE":
        db.clear_demo_data(_uid())
        return jsonify({"ok": True, "cleared": True})

    count = seed_demo_data(_uid())
    return jsonify({"ok": True, "seeded": count})


@app.route("/api/source/<int:source_id>", methods=["DELETE", "PATCH"])
@auth.login_required
def api_source(source_id):
    """Rename or delete a single source and everything under it."""
    if request.method == "PATCH":
        body = request.get_json(silent=True) or {}
        fields, values = [], []

        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"ok": False, "error": "Name cannot be empty"}), 400
            fields.append("name = ?")
            values.append(name[:120])

        if "kind" in body:
            kind = (body.get("kind") or "").strip().lower()
            if kind not in ("group", "profile", "page"):
                return jsonify({"ok": False, "error": "Invalid kind"}), 400
            fields.append("kind = ?")
            values.append(kind)

        if not fields:
            return jsonify({"ok": False, "error": "Nothing to update"}), 400

        with db.get_db() as conn:
            values.extend([source_id, _uid()])
            updated = conn.execute(
                f"UPDATE sources SET {', '.join(fields)} WHERE id = ? AND user_id = ?",
                values,
            )
            if not updated.rowcount:
                return jsonify({"ok": False, "error": "Not found"}), 404
        return jsonify({"ok": True})

    # Captures reference sources, and saved/remix rows reference posts, so the
    # dependents have to go before the source itself or the FK trips.
    with db.get_db() as conn:
        post_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM posts WHERE source_id = ? AND user_id = ?",
            (source_id, _uid()),
        ).fetchall()]
        for post_id in post_ids:
            conn.execute("DELETE FROM remixes WHERE post_id = ? AND user_id = ?",
                         (post_id, _uid()))
            conn.execute("DELETE FROM saved WHERE post_id = ? AND user_id = ?",
                         (post_id, _uid()))
        conn.execute("DELETE FROM posts WHERE source_id = ? AND user_id = ?",
                     (source_id, _uid()))
        conn.execute("DELETE FROM captures WHERE source_id = ? AND user_id = ?",
                     (source_id, _uid()))
        removed = conn.execute(
            "DELETE FROM sources WHERE id = ? AND user_id = ?", (source_id, _uid())
        )
        if not removed.rowcount:
            return jsonify({"ok": False, "error": "Not found"}), 404

    return jsonify({"ok": True, "deleted": len(post_ids)})


@app.route("/api/open-folder", methods=["POST"])
@auth.login_required
def api_open_folder():
    """Open the extension folder in the OS file manager.

    Loading an unpacked extension means handing Chrome a folder, and finding
    that folder is the step people get stuck on. The dashboard runs on the
    same machine as the folder, so it can just open it.

    The path is fixed in code and never taken from the request, and the route
    only answers local callers — this exists to save a person a file hunt, not
    to expose a file manager.
    """
    if request.remote_addr not in ("127.0.0.1", "::1", "localhost"):
        return jsonify({"ok": False, "error": "Local requests only"}), 403

    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension")
    if not os.path.isdir(folder):
        return jsonify({"ok": False, "error": "Extension folder not found"}), 404

    try:
        if sys.platform == "win32":
            # startfile takes no shell, so there is nothing to inject into.
            os.startfile(folder)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", folder], check=True)
        else:
            subprocess.run(["xdg-open", folder], check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        return jsonify({"ok": False, "error": f"Could not open it: {exc}"}), 500

    return jsonify({"ok": True, "path": folder})


def _require_admin():
    """The owner, or nothing. Returns the user or None."""
    user = auth.current_user()
    return user if (user and billing.is_admin(user)) else None


@app.route("/admin")
@auth.login_required
def admin():
    """Traffic and signups, for whoever owns the install."""
    if not _require_admin():
        return render_template("403.html", version=APP_VERSION), 403

    days = request.args.get("days", type=int) or 30
    days = max(1, min(days, 365))
    return render_template(
        "admin.html",
        traffic=db.traffic_summary(days),
        users=db.recent_users(50),
        # Presence only, never the values — an admin page is still a web page.
        stripe={
            "key": bool(os.environ.get("STRIPE_SECRET_KEY")),
            "webhook": bool(os.environ.get("STRIPE_WEBHOOK_SECRET")),
        },
        days=days,
        version=APP_VERSION,
        active="admin",
    )


# -------------------------------------------------------------- feedback


def _display_name(user):
    """What one account is called when another account sees it.

    This used to split the email at the @, which for most people publishes
    their actual name — jeffrandle@gmail.com reads as "jeffrandle" — and made
    two people called jeff at different providers into one handle. It is
    db.display_name now: the name they chose, or a member number, and never
    anything reconstructed out of an address.
    """
    return db.display_name(user)


@app.route("/feedback")
@auth.login_required
def feedback_board():
    user = auth.current_user()
    status = request.args.get("status")
    sort = "new" if request.args.get("sort") == "new" else "top"
    items = db.list_feedback(user["id"], status=status, sort=sort)
    for item in items:
        item["author"] = db.display_name(
            {"username": item.get("author_username"), "id": item.get("user_id")})
        item.pop("author_username", None)   # never reaches the template
    return render_template(
        "feedback.html",
        items=items,
        status=status or "",
        sort=sort,
        is_admin=bool(billing.is_admin(user)),
        statuses=db.FEEDBACK_STATUSES,
        version=APP_VERSION,
        active="feedback",
    )


@app.route("/api/username", methods=["POST"])
@auth.login_required
def api_username():
    user = auth.current_user()
    body = request.get_json(silent=True) or {}
    ok, error = db.set_username(user["id"], body.get("username"))
    if not ok:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True, "username": (body.get("username") or "").strip()})


@app.route("/api/feedback", methods=["POST"])
@auth.login_required
def api_feedback_create():
    user = auth.current_user()
    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"ok": False, "error": "Give it a one-line summary."}), 400

    kind = body.get("kind") if body.get("kind") in ("bug", "idea") else "idea"
    fid = db.create_feedback(user["id"], kind, title, body.get("body"))

    # The owner hears about it immediately. This is the entire point of the
    # feature from their side — a report nobody sees is a report nobody fixes.
    db.notify_admins(
        "feedback",
        ("Bug report: " if kind == "bug" else "Idea: ") + title[:120],
        body="From " + _display_name(user),
        url="/feedback",
    )
    return jsonify({"ok": True, "id": fid})


@app.route("/api/feedback/<int:feedback_id>/vote", methods=["POST"])
@auth.login_required
def api_feedback_vote(feedback_id):
    user = auth.current_user()
    if not db.get_feedback(feedback_id):
        return jsonify({"ok": False, "error": "Not found"}), 404
    voted, total = db.toggle_vote(feedback_id, user["id"])
    return jsonify({"ok": True, "voted": voted, "votes": total})


@app.route("/api/feedback/<int:feedback_id>/status", methods=["POST"])
@auth.login_required
def api_feedback_status(feedback_id):
    """Owner only. Moving an item tells everyone who backed it."""
    if not _require_admin():
        return jsonify({"ok": False, "error": "Not allowed"}), 403

    item = db.get_feedback(feedback_id)
    if not item:
        return jsonify({"ok": False, "error": "Not found"}), 404

    body = request.get_json(silent=True) or {}
    status = (body.get("status") or "").strip()
    if not db.set_feedback_status(feedback_id, status, body.get("note")):
        return jsonify({"ok": False, "error": "Unknown status"}), 400

    # Told to everyone who asked for it, not just whoever filed it. Backing
    # something and then never hearing what happened to it is how a feedback
    # board turns into a place people stop bothering with.
    told = set(db.feedback_voters(feedback_id))
    told.add(item["user_id"])
    headline = {
        "planned": "Planned: ",
        "shipped": "Shipped: ",
        "declined": "Not planned: ",
        "open": "Reopened: ",
    }.get(status, "Updated: ")
    for uid in told:
        db.notify(uid, "feedback", headline + item["title"][:120],
                  body=body.get("note") or None, url="/feedback")

    return jsonify({"ok": True, "status": status, "notified": len(told)})


# ----------------------------------------------------------- notifications


@app.route("/api/notifications")
@auth.login_required
def api_notifications():
    user = auth.current_user()
    return jsonify({
        "ok": True,
        "unread": db.unread_count(user["id"]),
        "items": db.notifications_for(user["id"], limit=20),
    })


@app.route("/api/notifications/read", methods=["POST"])
@auth.login_required
def api_notifications_read():
    """Mark one as read, or all of them if no id is given."""
    user = auth.current_user()
    body = request.get_json(silent=True) or {}
    unread = db.mark_notifications_read(user["id"], body.get("id"))
    return jsonify({"ok": True, "unread": unread})


@app.route("/api/viewer-name", methods=["POST"])
@auth.login_required
def api_viewer_name():
    """Declare the names that belong to the reader, not to any author.

    Stored rather than detected. Detecting it from Facebook's own markup was
    tried three times and missed every time; the reader is the one party who
    knows this for certain, so they are asked once and it is applied on every
    capture from then on.
    """
    body = request.get_json(silent=True) or {}
    raw = (body.get("names") or body.get("name") or "").strip()
    # Comma separated, capped — this is a name list, not a document.
    names = [n.strip() for n in raw.split(",") if n.strip()][:5]
    sage.set_setting(db.VIEWER_NAMES_KEY, ", ".join(names)[:200])
    return jsonify({"ok": True, "names": names})


@app.route("/api/post/<int:post_id>", methods=["DELETE"])
@auth.login_required
def api_delete_post(post_id):
    """Delete one captured post, from the card it is on."""
    if not db.delete_post(post_id, _uid()):
        return jsonify({"ok": False, "error": "Not found"}), 404
    return jsonify({"ok": True, "deleted": post_id})


@app.route("/api/clean-captions", methods=["POST"])
@auth.login_required
def api_clean_captions():
    """Blank captions on stored posts that were never captions.

    The capture-side fixes only change rows written after them, so a dashboard
    full of posts titled with a name or a link-card domain stays that way
    forever without this. Deliberately not a reset: no post is deleted, no
    number moves, no baseline shifts.
    """
    body = request.get_json(silent=True) or {}
    raw = body.get("names") or body.get("name") or []
    names = [raw] if isinstance(raw, str) else list(raw)[:5]
    names = [n for n in (str(x).strip() for x in names) if n]

    # Remembered, not just used once. Cleaning the old rows and stopping new
    # ones are the same problem, and typing the name twice to solve both is a
    # trap — the second half quietly never gets done.
    if names:
        sage.set_setting(db.VIEWER_NAMES_KEY, ", ".join(names)[:200])

    result = db.clean_captions(_uid(), names=names)
    return jsonify({"ok": True, **result})


@app.route("/api/reset", methods=["POST"])
@auth.login_required
def api_reset():
    """Wipe every captured post, keeping nothing but an empty schema.

    Needed when a capture ran with broken extractors: those posts carry zeroed
    engagement and wrong source names, which poisons every baseline they touch.
    Re-capturing is the only fix, and that has to start from clean.
    """
    result = db.clear_all_captures(_uid())
    return jsonify({"ok": True, "reset": True, **result})


@app.route("/api/export/<fmt>")
@auth.login_required
def api_export(fmt):
    """Export scored posts for pasting into an LLM or a spreadsheet."""
    source_id = request.args.get("source_id", type=int)
    scored = outliers.score_posts(_fetch_posts(source_id=source_id))

    rows = [
        {
            "author": p.get("author_name"),
            "source": p.get("source_name"),
            "posted_at": p.get("posted_at"),
            "type": p.get("post_type"),
            "likes": p.get("likes"),
            "comments": p.get("comments"),
            "shares": p.get("shares"),
            "outlier_multiple": p.get("outlier_multiple"),
            "tier": p.get("tier"),
            "permalink": p.get("permalink"),
            "body": (p.get("body") or "").strip(),
        }
        for p in scored
    ]

    if fmt == "json":
        buffer = io.BytesIO(json.dumps(rows, indent=2).encode("utf-8"))
        return send_file(buffer, mimetype="application/json",
                         as_attachment=True, download_name="outlier-export.json")

    if fmt == "csv":
        import csv
        text = io.StringIO()
        if rows:
            writer = csv.DictWriter(text, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        buffer = io.BytesIO(text.getvalue().encode("utf-8"))
        return send_file(buffer, mimetype="text/csv",
                         as_attachment=True, download_name="outlier-export.csv")

    if fmt == "markdown":
        lines = [f"# {APP_NAME} export", ""]
        for row in rows:
            headline = (f"{row['outlier_multiple']}x" if row["outlier_multiple"] is not None
                        else "unscored")
            lines.append(f"## {headline} — {row['author']} in {row['source']}")
            lines.append(
                f"*{row['likes']} reactions · {row['comments']} comments · "
                f"{row['shares']} shares · {row['type']} · {row['posted_at']}*"
            )
            lines.append("")
            lines.append(row["body"])
            lines.append("")
        buffer = io.BytesIO("\n".join(lines).encode("utf-8"))
        return send_file(buffer, mimetype="text/markdown",
                         as_attachment=True, download_name="outlier-export.md")

    return jsonify({"ok": False, "error": "Use json, csv, or markdown"}), 400


@app.route("/extension/outlier-extension.zip")
@auth.login_required
def download_extension():
    """Zip the extension folder on the fly so the install button works."""
    import zipfile

    ext_dir = os.path.join(os.path.dirname(__file__), "extension")
    if not os.path.isdir(ext_dir):
        return jsonify({"ok": False, "error": "Extension folder missing"}), 404

    # The dashboard serving this zip is the dashboard the extension should
    # talk to, so stamp this origin into it on the way out. Without this a
    # hosted install starts life pointed at a localhost that was never
    # running, reports itself offline, and asks the user to paste a URL the
    # server already knows.
    home = request.url_root.rstrip("/")

    # No key is stamped into the zip, and downloading no longer rotates one.
    #
    # Baking a key in removed a setup step, but keys are stored hashed and
    # cannot be read back — so stamping one meant MINTING one, and every
    # download silently revoked the key the extension was already using.
    # Fourteen downloads later the extension held a dead key, kept sending
    # with it, and none of the captures landed.
    #
    # The dashboard's auto-connect covers this anyway: opening it while
    # signed in hands the extension a key with nothing to click, and issues
    # one when it is actually needed rather than one per download.
    api_key = ""

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _dirs, files in os.walk(ext_dir):
            for name in files:
                path = os.path.join(root, name)
                arcname = os.path.relpath(path, ext_dir)

                if arcname.replace("\\", "/") == "background.js":
                    with open(path, "r", encoding="utf-8") as handle:
                        source = handle.read()

                    stamped, home_hits = re.subn(
                        r'const DEFAULT_ENDPOINT = "[^"]*"; /\*@@TALLGRASS_HOME@@\*/',
                        'const DEFAULT_ENDPOINT = "%s"; /*@@TALLGRASS_HOME@@*/'
                        % home.replace("\\", ""),
                        source,
                        count=1,
                    )
                    stamped, key_hits = re.subn(
                        r'const DEFAULT_API_KEY = "[^"]*"; /\*@@TALLGRASS_KEY@@\*/',
                        'const DEFAULT_API_KEY = "%s"; /*@@TALLGRASS_KEY@@*/'
                        % api_key.replace("\\", ""),
                        stamped,
                        count=1,
                    )
                    # A silent miss would ship the localhost default and an
                    # unkeyed extension to every user — the exact two steps
                    # this removes.
                    if not (home_hits and key_hits):
                        app.logger.error(
                            "extension zip: stamp markers not found "
                            "(home=%s key=%s); shipping unconfigured background.js",
                            home_hits, key_hits,
                        )
                    archive.writestr(arcname, stamped)
                    continue

                archive.write(path, arcname)
    buffer.seek(0)
    return send_file(buffer, mimetype="application/zip",
                     as_attachment=True, download_name="tallgrass-extension.zip")


@app.errorhandler(404)
def not_found(_error):
    return render_template("404.html", version=APP_VERSION), 404


db.init_db()

if __name__ == "__main__":
    # Debug (and the Werkzeug interactive debugger, which is remote code
    # execution) is off unless explicitly asked for with FLASK_DEBUG=1. Render
    # runs under gunicorn and never reaches this line, but a direct
    # `python app.py` in the wrong place must not expose a console.
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1",
            port=int(os.environ.get("PORT", 5050)))
