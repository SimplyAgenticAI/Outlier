"""Outlier detection — the core of the product.

Ranking by raw engagement just surfaces whoever has the biggest audience.
What actually matters is which posts beat the baseline *for the place they
were posted in*: a 400-reaction post in a 2k-member group is a bigger signal
than a 4k-reaction post from a creator who averages 8k.

So every post is scored against the median of its own source (group/profile).
Median and MAD rather than mean and standard deviation, because engagement is
heavily right-skewed and a single viral post would drag a mean-based baseline
up enough to hide everything else.
"""

from datetime import datetime, timezone

# Shares are the strongest virality signal (they put the post in front of a new
# audience), comments next, reactions cheapest. Raw totals are kept separately
# so the UI can still show the real numbers.
WEIGHT_LIKES = 1
WEIGHT_COMMENTS = 3
WEIGHT_SHARES = 5

# Below this many posts, a median isn't a baseline — it's noise. Sources under
# the threshold are reported as "needs more data" rather than given fake scores.
MIN_SAMPLE = 8

# A median this low means the source is either dead or — far more often — was
# captured with extractors that failed to read engagement, leaving most posts
# at zero. Dividing by a near-zero median turns an ordinary post into a
# "8647x breakout", so such sources are marked unscored instead.
MIN_BASELINE = 8

# Comments run far lower than posts, so the posts threshold would leave most
# groups' comments permanently unscored. Low enough to admit real discussion,
# high enough that a median of 1 or 2 still can't manufacture outliers.
MIN_BASELINE_COMMENT = 3

# Ratios above this are not informative, only alarming. Anything this far out
# is already the top of the feed; the exact figure adds nothing.
MAX_MULTIPLE = 99.9

# Posts younger than this are still accumulating engagement. They're scored but
# flagged, so a 2-hour-old post doesn't get written off as underperforming.
STILL_CLIMBING_HOURS = 48


def weighted_engagement(post):
    return (
        (post["likes"] or 0) * WEIGHT_LIKES
        + (post["comments"] or 0) * WEIGHT_COMMENTS
        + (post["shares"] or 0) * WEIGHT_SHARES
    )


def total_engagement(post):
    return (post["likes"] or 0) + (post["comments"] or 0) + (post["shares"] or 0)


def _median(values):
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _mad(values, median):
    """Median absolute deviation — the robust analogue of standard deviation."""
    if not values:
        return 0.0
    return _median([abs(v - median) for v in values])


def _hours_since(timestamp):
    if not timestamp:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(timestamp[:19], fmt).replace(tzinfo=timezone.utc)
            return (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
        except ValueError:
            continue
    return None


def score_posts(posts):
    """Score every post against the baseline of its own source.

    `posts` are sqlite3.Row objects (or dicts) carrying at least:
    id, source_id, likes, comments, shares, posted_at.

    Returns a list of dicts with the original fields plus the scoring output.
    """
    # Grouped by source AND item type. A comment pulling 200 reactions where
    # comments typically get 5 is a genuine standout; measured against posts
    # averaging 8,000 it looks like a failure. They are different populations
    # and need different medians.
    by_source = {}
    for post in posts:
        key = (post["source_id"], post.get("item_type") or "post")
        by_source.setdefault(key, []).append(post)

    scored = []
    for _key, group_posts in by_source.items():
        engagements = [weighted_engagement(p) for p in group_posts]
        baseline = _median(engagements)
        mad = _mad(engagements, baseline)

        is_comment = (group_posts[0].get("item_type") or "post") == "comment"
        floor = MIN_BASELINE_COMMENT if is_comment else MIN_BASELINE

        # Both conditions must hold for a ratio to mean anything: enough items
        # to have a median, and a median far enough from zero to divide by.
        sufficient = len(group_posts) >= MIN_SAMPLE and baseline >= floor
        low_baseline = baseline < floor

        for post in group_posts:
            eng = weighted_engagement(post)

            # How many times the typical post did this one beat?
            if baseline > 0:
                multiple = min(eng / baseline, MAX_MULTIPLE)
            else:
                multiple = 0.0

            # Robust z-score. The 0.6745 constant rescales MAD so that for
            # normally-distributed data it matches a standard deviation.
            if mad > 0:
                robust_z = 0.6745 * (eng - baseline) / mad
            else:
                robust_z = 0.0

            age_hours = _hours_since(post["posted_at"])
            still_climbing = age_hours is not None and age_hours < STILL_CLIMBING_HOURS

            record = dict(post)
            record.update(
                {
                    "weighted_engagement": eng,
                    "total_engagement": total_engagement(post),
                    "baseline": baseline,
                    "outlier_multiple": round(multiple, 1),
                    "robust_z": round(robust_z, 2),
                    "has_baseline": sufficient,
                    "low_baseline": low_baseline,
                    "still_climbing": still_climbing,
                    "age_hours": round(age_hours, 1) if age_hours is not None else None,
                    "tier": _tier(multiple, sufficient),
                }
            )
            scored.append(record)

    scored.sort(key=lambda r: r["outlier_multiple"], reverse=True)
    return scored


def _tier(multiple, has_baseline):
    """Human-readable band. Drives the badge colour and glow in the UI."""
    if not has_baseline:
        return "unknown"
    if multiple >= 5:
        return "breakout"
    if multiple >= 3:
        return "strong"
    if multiple >= 1.5:
        return "above"
    if multiple >= 0.5:
        return "typical"
    return "flop"


TIER_LABELS = {
    "breakout": "Breakout",
    "strong": "Strong outlier",
    "above": "Above baseline",
    "typical": "Typical",
    "flop": "Underperformed",
    "unknown": "Needs more data",
}


def source_stats(items):
    """Per-source rollup, reported for posts and comments separately.

    A single median across both is meaningless: comments run an order of
    magnitude lower, so mixing them drags a group's baseline below the floor
    and reports a perfectly healthy group as unscoreable. The headline numbers
    describe posts; comments are carried alongside.
    """
    posts = [p for p in items if (p.get("item_type") or "post") == "post"]
    comments = [p for p in items if (p.get("item_type") or "post") == "comment"]

    post_engagements = [weighted_engagement(p) for p in posts]
    baseline = _median(post_engagements)

    scored = score_posts(items)
    scored_posts = [s for s in scored if (s.get("item_type") or "post") == "post"]
    scored_comments = [s for s in scored if (s.get("item_type") or "post") == "comment"]

    outlier_posts = [s for s in scored_posts if s["tier"] in ("breakout", "strong")]
    top_comments = [s for s in scored_comments if s["tier"] in ("breakout", "strong")]

    return {
        "post_count": len(posts),
        "comment_count": len(comments),
        "total_count": len(items),
        "baseline": round(baseline, 1),
        "outlier_count": len(outlier_posts),
        "top_comment_count": len(top_comments),
        "has_baseline": len(posts) >= MIN_SAMPLE and baseline >= MIN_BASELINE,
        "low_baseline": bool(posts) and baseline < MIN_BASELINE,
        "top_multiple": max((s["outlier_multiple"] for s in scored_posts), default=0),
        "comments_scored": any(s["has_baseline"] for s in scored_comments),
    }
