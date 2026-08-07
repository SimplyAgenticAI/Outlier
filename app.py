import io
import json
import os
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, render_template, request, send_file

import db
import outliers
import remix
from demo_data import seed_demo_data

app = Flask(__name__)

APP_VERSION = "0.4"

# The extension posts cross-origin from facebook.com, so the ingest endpoints
# need permissive CORS. Everything else is same-origin.
INGEST_PATHS = ("/api/capture", "/api/ping")


@app.after_request
def add_cors_headers(response):
    if request.path in INGEST_PATHS:
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response


def _fetch_posts(source_id=None, limit=None):
    """Pull posts joined to their source and author, ready for scoring."""
    sql = """
        SELECT p.*, s.name AS source_name, s.kind AS source_kind,
               s.fb_id AS source_fb_id, a.name AS author_name,
               (SELECT COUNT(*) FROM saved WHERE saved.post_id = p.id) AS is_saved
        FROM posts p
        LEFT JOIN sources s ON s.id = p.source_id
        LEFT JOIN authors a ON a.id = p.author_id
    """
    params = []
    if source_id:
        sql += " WHERE p.source_id = ?"
        params.append(source_id)
    sql += " ORDER BY p.posted_at DESC"
    if limit:
        sql += f" LIMIT {int(limit)}"

    with db.get_db() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _global_stats(scored):
    breakouts = [s for s in scored if s["tier"] == "breakout"]
    with db.get_db() as conn:
        source_count = conn.execute(
            "SELECT COUNT(*) AS n FROM sources"
        ).fetchone()["n"]
    return {
        "post_count": len(scored),
        "source_count": source_count,
        "breakout_count": len(breakouts),
        "top_multiple": scored[0]["outlier_multiple"] if scored else 0,
    }


# ---------------------------------------------------------------- pages


@app.route("/")
def feed():
    """The outlier feed — posts ranked by how far they beat their own baseline."""
    tier_filter = request.args.get("tier", "all")
    scored = outliers.score_posts(_fetch_posts())

    visible = [s for s in scored if s["has_baseline"]]
    if tier_filter != "all":
        visible = [s for s in visible if s["tier"] == tier_filter]

    return render_template(
        "feed.html",
        posts=visible[:60],
        stats=_global_stats(scored),
        tier_filter=tier_filter,
        tier_labels=outliers.TIER_LABELS,
        has_data=bool(scored),
        version=APP_VERSION,
        active="feed",
    )


@app.route("/groups")
def groups():
    with db.get_db() as conn:
        sources = [dict(r) for r in conn.execute(
            "SELECT * FROM sources ORDER BY last_capture DESC"
        ).fetchall()]

    for source in sources:
        posts = _fetch_posts(source_id=source["id"])
        source["stats"] = outliers.source_stats(posts) if posts else None

    return render_template(
        "groups.html",
        sources=sources,
        version=APP_VERSION,
        active="groups",
    )


@app.route("/groups/<int:source_id>")
def group_detail(source_id):
    with db.get_db() as conn:
        source = conn.execute(
            "SELECT * FROM sources WHERE id = ?", (source_id,)
        ).fetchone()
    if not source:
        return render_template("404.html", version=APP_VERSION), 404

    posts = _fetch_posts(source_id=source_id)
    scored = outliers.score_posts(posts)

    return render_template(
        "group_detail.html",
        source=dict(source),
        posts=scored,
        stats=outliers.source_stats(posts) if posts else None,
        tier_labels=outliers.TIER_LABELS,
        version=APP_VERSION,
        active="groups",
    )


@app.route("/post/<int:post_id>")
def post_detail(post_id):
    # Score against the full set so the multiple matches what the feed showed.
    scored = outliers.score_posts(_fetch_posts())
    post = next((s for s in scored if s["id"] == post_id), None)
    if not post:
        return render_template("404.html", version=APP_VERSION), 404

    with db.get_db() as conn:
        remix_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM remixes WHERE post_id = ? ORDER BY created_at DESC",
            (post_id,),
        ).fetchall()]

    for row in remix_rows:
        try:
            row["parsed"] = json.loads(row["output"])
        except (json.JSONDecodeError, TypeError):
            row["parsed"] = None

    return render_template(
        "post_detail.html",
        post=post,
        remixes=remix_rows,
        angles=remix.ANGLES,
        remix_ready=remix.is_configured(),
        tier_labels=outliers.TIER_LABELS,
        version=APP_VERSION,
        active="feed",
    )


@app.route("/library")
def library():
    with db.get_db() as conn:
        saved_ids = [r["post_id"] for r in conn.execute(
            "SELECT post_id FROM saved ORDER BY created_at DESC"
        ).fetchall()]
        remix_count = conn.execute(
            "SELECT COUNT(*) AS n FROM remixes"
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
def capture():
    with db.get_db() as conn:
        recent = [dict(r) for r in conn.execute(
            """
            SELECT c.*, s.name AS source_name
            FROM captures c LEFT JOIN sources s ON s.id = c.source_id
            ORDER BY c.created_at DESC LIMIT 10
            """
        ).fetchall()]

    return render_template(
        "capture.html",
        recent_captures=recent,
        has_data=db.has_any_posts(),
        version=APP_VERSION,
        active="capture",
    )


# ---------------------------------------------------------------- ingest API


@app.route("/api/ping", methods=["GET", "POST", "OPTIONS"])
def api_ping():
    """The extension calls this to confirm the dashboard is reachable."""
    if request.method == "OPTIONS":
        return "", 204
    return jsonify({"ok": True, "version": APP_VERSION})


@app.route("/api/capture", methods=["POST", "OPTIONS"])
def api_capture():
    """Ingest a batch of posts scraped by the extension."""
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"ok": False, "error": "Expected a JSON body"}), 400

    source = payload.get("source") or {}
    posts = payload.get("posts") or []

    if not source.get("fb_id"):
        return jsonify({"ok": False, "error": "source.fb_id is required"}), 400
    if not isinstance(posts, list):
        return jsonify({"ok": False, "error": "posts must be a list"}), 400

    new_count = 0
    with db.get_db() as conn:
        source_id = db.upsert_source(
            conn,
            fb_id=str(source["fb_id"]),
            kind=source.get("kind", "group"),
            name=source.get("name") or "Untitled source",
            url=source.get("url"),
            member_count=source.get("member_count"),
        )

        for post in posts:
            if not post.get("fb_post_id"):
                continue
            author_id = db.upsert_author(
                conn,
                name=post.get("author_name") or "Unknown",
                profile_url=post.get("author_url"),
            )
            if db.upsert_post(conn, source_id, author_id, post):
                new_count += 1

        conn.execute(
            "INSERT INTO captures (source_id, post_count, new_count) VALUES (?, ?, ?)",
            (source_id, len(posts), new_count),
        )

    return jsonify({
        "ok": True,
        "received": len(posts),
        "new": new_count,
        "source_id": source_id,
    })


# ---------------------------------------------------------------- actions


@app.route("/api/save/<int:post_id>", methods=["POST"])
def api_save(post_id):
    with db.get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM saved WHERE post_id = ?", (post_id,)
        ).fetchone()
        if existing:
            conn.execute("DELETE FROM saved WHERE post_id = ?", (post_id,))
            saved = False
        else:
            conn.execute("INSERT INTO saved (post_id) VALUES (?)", (post_id,))
            saved = True
    return jsonify({"ok": True, "saved": saved})


@app.route("/api/remix/<int:post_id>", methods=["POST"])
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
            "INSERT INTO remixes (post_id, angle, output, model) VALUES (?, ?, ?, ?)",
            (post_id, ",".join(angles or []), json.dumps(result), remix.MODEL),
        )

    return jsonify({"ok": True, "result": result})


@app.route("/api/demo", methods=["POST", "DELETE"])
def api_demo():
    """Load or clear clearly-labelled sample data.

    Without the extension installed the app has nothing to show, which makes it
    impossible to tell a working install from a broken one. Demo posts are
    flagged is_demo=1 and can be wiped in one call.
    """
    if request.method == "DELETE":
        db.clear_demo_data()
        return jsonify({"ok": True, "cleared": True})

    count = seed_demo_data()
    return jsonify({"ok": True, "seeded": count})


@app.route("/api/export/<fmt>")
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
        lines = ["# Outlier export", ""]
        for row in rows:
            lines.append(f"## {row['outlier_multiple']}x — {row['author']} in {row['source']}")
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
def download_extension():
    """Zip the extension folder on the fly so the install button works."""
    import zipfile

    ext_dir = os.path.join(os.path.dirname(__file__), "extension")
    if not os.path.isdir(ext_dir):
        return jsonify({"ok": False, "error": "Extension folder missing"}), 404

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _dirs, files in os.walk(ext_dir):
            for name in files:
                path = os.path.join(root, name)
                archive.write(path, os.path.relpath(path, ext_dir))
    buffer.seek(0)
    return send_file(buffer, mimetype="application/zip",
                     as_attachment=True, download_name="outlier-extension.zip")


@app.errorhandler(404)
def not_found(_error):
    return render_template("404.html", version=APP_VERSION), 404


db.init_db()

if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5050)))
