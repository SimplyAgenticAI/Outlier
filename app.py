import io
import json
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

APP_VERSION = "6.9"

# The product name lives here and nowhere else. APP_SHORT_NAME is what prose
# uses on the second mention — spelling out the full name mid-sentence reads
# like boilerplate.
APP_NAME = "Tallgrass"
APP_SHORT_NAME = "Tallgrass"

# The umbrella brand. Shown under the mark, not inside it.
APP_PARENT = "by MacRandle Acres"
APP_TAGLINE = "Find the standout posts in your Facebook groups, and write the next one."

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


@app.route("/")
@auth.login_required
def feed():
    """The outlier feed — posts ranked by how far they beat their own baseline."""
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


@app.route("/settings")
@auth.login_required
def settings():
    sources = _sources_with_stats()
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

    return render_template(
        "group_detail.html",
        source=dict(source),
        posts=visible,
        stats=outliers.source_stats(posts) if posts else None,
        tier_labels=outliers.TIER_LABELS,
        version=APP_VERSION,
        active="groups",
    )


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
        if password != (request.form.get("password_confirm") or ""):
            error = "Passwords don't match."
        else:
            user, error = auth.create_user(request.form.get("email"), password)
            if user:
                # A pre-existing single-user install would otherwise find its
                # own captures invisible once everything is owner-scoped.
                claimed = db.claim_unowned_data(user["id"])
                auth.login_session(user)
                session["fresh_api_key"] = user["api_key"]
                session["claimed_rows"] = claimed
                return redirect(url_for("capture"))

    return render_template(
        "register.html", error=error, min_length=auth.MIN_PASSWORD_LENGTH,
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

    It rotates, because keys are stored hashed and cannot be read back. The
    extension only calls this when it has no working key, so a rotation
    happens when one is actually needed rather than on every download — which
    is the bug that silently revoked fourteen keys in a row.
    """
    if request.headers.get("X-Tallgrass-Extension") != "1":
        return jsonify({"ok": False, "error": "Not an extension request"}), 403

    new_key = auth.rotate_api_key(auth.current_user()["id"])
    return jsonify({
        "ok": True,
        "api_key": new_key,
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
    """Read the version straight from the extension manifest on disk.

    This is what makes self-update work: the file changes whenever the
    extension does, so the running copy can notice it has fallen behind.
    """
    path = os.path.join(os.path.dirname(__file__), "extension", "manifest.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle).get("version", "0.0.0")
    except (OSError, json.JSONDecodeError):
        return "0.0.0"


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

        for post in posts:
            if not post.get("fb_post_id"):
                continue

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

    return jsonify({
        "ok": True,
        "received": len(posts),
        "new": new_count,
        "source_id": logged_source,
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

    scored = outliers.score_posts(_fetch_posts())
    post = next((s for s in scored if s["id"] == post_id), None)
    if not post:
        return jsonify({"ok": False, "error": "Post not found"}), 404

    result, error = remix.remix_post(post, angles=angles)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO remixes (post_id, user_id, angle, output, model) "
            "VALUES (?, ?, ?, ?, ?)",
            (post_id, _uid(), ",".join(angles or []), json.dumps(result), remix.MODEL),
        )

    return jsonify({"ok": True, "result": result})


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
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"ok": False, "error": "Name cannot be empty"}), 400

        with db.get_db() as conn:
            updated = conn.execute(
                "UPDATE sources SET name = ? WHERE id = ? AND user_id = ?",
                (name[:120], source_id, _uid()),
            )
            if not updated.rowcount:
                return jsonify({"ok": False, "error": "Not found"}), 404
        return jsonify({"ok": True, "name": name[:120]})

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
    app.run(debug=True, port=int(os.environ.get("PORT", 5050)))
