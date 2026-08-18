"""Has extraction quietly stopped working?

This product fails silently. Facebook ships markup changes constantly, and
when one lands the extension does not error — it captures posts with no
engagement, or no author, or stops finding posts at all. The dashboard looks
exactly the same. Every extraction bug so far was found by the operator
noticing something wrong on their own screen, which is not a monitoring
strategy and does not scale past one person.

The signal is already in the table. Every row carries captured_at plus the
fields extraction is supposed to fill, so the share of recent captures that
came out complete can be compared against the share that used to. A markup
change shows up as a cliff: rows captured before it are fine, rows captured
after are missing the same field.

Deliberately compares COHORTS BY CAPTURE DATE rather than looking at totals.
A total including every row ever stored moves too slowly to notice a cliff —
one bad week hidden inside a year of good rows is a rounding error, and it is
also the week everything broke.

No schema change and no new writes: this reads what is already there.
"""

import db


# What extraction is supposed to produce. Each is a column that should be
# populated on a healthy capture, named the way the operator would say it.
FIELDS = [
    ("engagement", "engagement_read = 1",
     "Reaction, comment and share counts were read."),
    ("author", "author_id IS NOT NULL",
     "The post's author was identified."),
    ("content", "(body IS NOT NULL AND body != '') OR image_url IS NOT NULL",
     "The post had words or a picture attached."),
    ("timestamp", "posted_at IS NOT NULL",
     "When it was posted was read."),
    ("permalink", "permalink IS NOT NULL AND permalink != ''",
     "A link back to the post on Facebook."),
]

# The recent window, and the stretch before it that counts as "normal".
RECENT_DAYS = 7
BASELINE_DAYS = 35        # 28 days of baseline sitting behind the recent 7

# A cliff, in percentage points. Extraction quality wanders a few points with
# the mix of posts captured; twenty points is a break, not a wobble.
DROP_POINTS = 20.0

# Below this many rows in either window the comparison is arithmetic on noise.
MIN_ROWS = 20


def _rates(conn, where_extra, params):
    """The share of rows in a window that got each field, as percentages."""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM posts WHERE is_demo = 0 " + where_extra,
        params).fetchone()
    total = row["n"] if row else 0
    if not total:
        return 0, {}

    rates = {}
    for name, predicate, _label in FIELDS:
        hit = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE is_demo = 0 AND (%s) %s"
            % (predicate, where_extra), params).fetchone()
        rates[name] = round(100.0 * (hit["n"] if hit else 0) / total, 1)
    return total, rates


def report(user_id=None):
    """Recent capture quality against the stretch before it.

    user_id None reads every account — a markup change is not one person's
    problem, and the aggregate notices it sooner than any single library does.
    """
    where = ""
    params = []
    if user_id is not None:
        where = " AND user_id = ?"
        params.append(user_id)

    recent_clause = (
        where + " AND captured_at >= datetime('now', '-%d days')" % RECENT_DAYS)
    baseline_clause = (
        where
        + " AND captured_at <  datetime('now', '-%d days')" % RECENT_DAYS
        + " AND captured_at >= datetime('now', '-%d days')" % BASELINE_DAYS)

    with db.get_db() as conn:
        recent_n, recent = _rates(conn, recent_clause, list(params))
        base_n, base = _rates(conn, baseline_clause, list(params))

    out = {
        "recent_days": RECENT_DAYS,
        "baseline_days": BASELINE_DAYS - RECENT_DAYS,
        "recent_count": recent_n,
        "baseline_count": base_n,
        "drop_points": DROP_POINTS,
        "fields": [],
        "tripped": [],
    }

    # Not enough on either side is a real answer, and a different one from
    # "healthy". Saying so beats printing a green tick over three rows.
    comparable = recent_n >= MIN_ROWS and base_n >= MIN_ROWS
    out["comparable"] = comparable
    out["min_rows"] = MIN_ROWS

    for name, _predicate, label in FIELDS:
        recent_pct = recent.get(name)
        base_pct = base.get(name)
        delta = None
        tripped = False
        if comparable and recent_pct is not None and base_pct is not None:
            delta = round(recent_pct - base_pct, 1)
            tripped = delta <= -DROP_POINTS
        out["fields"].append({
            "name": name,
            "label": label,
            "recent": recent_pct,
            "baseline": base_pct,
            "delta": delta,
            "tripped": tripped,
        })
        if tripped:
            out["tripped"].append(name)

    if not comparable:
        out["state"] = "unknown"
    elif out["tripped"]:
        out["state"] = "degraded"
    else:
        out["state"] = "healthy"
    return out


# ----------------------------------------------------------------- alerting

# One notification per day per shape of failure. Without the throttle every
# page view during an outage files another copy, and the person who most needs
# to read it is the one whose inbox is being buried.
_ALERT_KEY = "capture_health_alerted"


def check_and_alert():
    """Raise an admin notification when the global signal breaks. Never raises."""
    try:
        current = report()
    except Exception:
        return None

    if current["state"] != "degraded":
        # Recovered — clear the marker so the next break alerts again rather
        # than being swallowed as a repeat of the last one.
        try:
            db.set_setting(_ALERT_KEY, "")
        except Exception:
            pass
        return current

    signature = ",".join(sorted(current["tripped"]))
    stamp = _today()
    marker = "%s|%s" % (stamp, signature)
    try:
        if db.get_setting(_ALERT_KEY, "") == marker:
            return current
        db.set_setting(_ALERT_KEY, marker)
        names = ", ".join(current["tripped"])
        db.notify_admins(
            "capture_health",
            "Capture quality dropped: %s" % names,
            "Across all accounts, %s came out of the last %d days of captures "
            "materially worse than the %d days before. This is what a Facebook "
            "markup change looks like. Open Health for the numbers."
            % (names, current["recent_days"], current["baseline_days"]),
            "/diagnostics",
        )
    except Exception:
        pass
    return current


def _today():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")
