"""Which accounts are silently getting nothing.

There are per-user diagnostics and there is no view across users, so the only
person whose experience is actually visible is whoever is looking at their own
Health page. That was survivable while this had one user. It is not survivable
now that people pay: an account whose captures quietly fail does not file a
bug, it stops paying, and the first signal is the cancellation.

Four ways to get nothing out of this product, in the order they hurt:

  never   Signed up, never captured a post. The install didn't take, and this
          is the largest bucket in most products.
  blind   Capturing fine, but the counts aren't being read — so every post
          lands unscored and the feed stays empty of anything ranked.
  unscored
          Plenty captured and still nothing to show, because no source clears
          the sample and baseline floors. The product works and looks broken.
  stalled Captured once and stopped. Might be churn, might be a holiday.

Read-only, aggregate, and deliberately not a list of what anyone posted: this
answers "is it working for them", not "what are they reading".
"""

import db
import outliers


STALLED_DAYS = 14          # no capture in this long counts as stopped
BLIND_RATE = 50.0          # below this % of counts read, they see nothing ranked
RECENT_DAYS = 30           # window the blindness check looks at


def _classify(row):
    """The most actionable thing wrong with this account, or None."""
    if not row["posts"]:
        return "never"
    # Blindness before staleness: an account still capturing but reading
    # nothing is actively broken, and saying "stopped" would send whoever
    # reads this looking at the wrong thing.
    if row["recent_posts"] and row["read_rate"] is not None \
            and row["read_rate"] < BLIND_RATE:
        return "blind"
    if row["posts"] >= outliers.MIN_SAMPLE and not row["scoreable_sources"]:
        return "unscored"
    if row["days_since_capture"] is None or row["days_since_capture"] > STALLED_DAYS:
        return "stalled"
    return None


def report():
    """One row per account, worst first. Never raises on an empty install."""
    with db.get_db() as conn:
        users = conn.execute(
            """
            SELECT u.id, u.email, u.plan, u.created_at, u.is_admin,
                   (SELECT COUNT(*) FROM posts p
                     WHERE p.user_id = u.id AND p.is_demo = 0) AS posts,
                   (SELECT COUNT(*) FROM posts p
                     WHERE p.user_id = u.id AND p.is_demo = 0
                       AND p.captured_at >= datetime('now', '-%d days')) AS recent_posts,
                   (SELECT COUNT(*) FROM posts p
                     WHERE p.user_id = u.id AND p.is_demo = 0
                       AND p.captured_at >= datetime('now', '-%d days')
                       AND p.engagement_read = 1) AS recent_read,
                   (SELECT MAX(p.captured_at) FROM posts p
                     WHERE p.user_id = u.id AND p.is_demo = 0) AS last_capture,
                   (SELECT COUNT(*) FROM sources s WHERE s.user_id = u.id) AS sources
            FROM users u
            ORDER BY u.created_at DESC
            """ % (RECENT_DAYS, RECENT_DAYS)
        ).fetchall()

        rows = []
        for user in users:
            record = dict(user)

            record["read_rate"] = (
                round(100.0 * record["recent_read"] / record["recent_posts"], 1)
                if record["recent_posts"] else None)

            record["days_since_capture"] = None
            if record["last_capture"]:
                gap = conn.execute(
                    "SELECT CAST(julianday('now') - julianday(?) AS INTEGER) AS d",
                    (record["last_capture"],)).fetchone()
                record["days_since_capture"] = gap["d"] if gap else None

            # How many of their sources the scorer would actually rank. This is
            # the difference between "captured a lot" and "shown anything",
            # and nothing in the app reported it before.
            record["scoreable_sources"] = 0
            if record["posts"]:
                posts = conn.execute(
                    "SELECT * FROM posts WHERE user_id = ? AND is_demo = 0",
                    (record["id"],)).fetchall()
                scored = outliers.score_posts([dict(p) for p in posts])
                record["scoreable_sources"] = len(
                    {s["source_id"] for s in scored if s.get("has_baseline")})

            record["problem"] = _classify(record)
            rows.append(record)

    order = {"blind": 0, "unscored": 1, "never": 2, "stalled": 3, None: 4}
    rows.sort(key=lambda r: (order.get(r["problem"], 5), -(r["posts"] or 0)))

    counts = {}
    for record in rows:
        if record["problem"]:
            counts[record["problem"]] = counts.get(record["problem"], 0) + 1

    return {
        "users": rows,
        "counts": counts,
        "total": len(rows),
        "affected": sum(counts.values()),
        "stalled_days": STALLED_DAYS,
        "blind_rate": BLIND_RATE,
        "recent_days": RECENT_DAYS,
        "min_sample": outliers.MIN_SAMPLE,
    }


PROBLEM_LABELS = {
    "never": "Never captured",
    "blind": "Counts not being read",
    "unscored": "Nothing scoreable",
    "stalled": "Stopped capturing",
}

PROBLEM_ADVICE = {
    "never": "The install did not take. Worth an email — this is the bucket "
             "where a product loses people without ever hearing why.",
    "blind": "Posts are arriving with their counts unread, so their feed has "
             "nothing ranked in it. Check Health, then ask them for a page "
             "report from a group that looks wrong.",
    "unscored": "They have captured plenty and still see nothing ranked, "
                "because no source clears the sample or baseline floor. The "
                "product is working exactly as designed and looks broken.",
    "stalled": "Captured once and stopped. Could be a holiday, could be that "
               "it stopped working for them and they did not say.",
}
