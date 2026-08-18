"""Does the scoring model actually work?

Every number the product stands on is asserted, not derived. Shares are worth
5x because shares felt like the strongest signal; MIN_SAMPLE is 8 because 8
felt like enough; the breakout line sits at 5x because 5x felt like a lot.
None of it has ever been checked against real captures.

That matters more here than it would in most software, because the model IS
the product. The landing page, the feed, the playbook and the whole argument
against most-engagement leaderboards rest on this arithmetic being sensible.

So this module asks four questions of whatever data it is pointed at, and
answers them without touching a row:

  1. Do the weights matter?    Re-rank under other schemes and see what moves.
  2. Are the tiers meaningful? Or does everything land in one band.
  3. Are the floors right?     What do MIN_SAMPLE and MIN_BASELINE exclude.
  4. Is the input clean?       Rows still carrying the pre-V17.5 share bug.

It measures the REAL engine — outliers.score_posts with a weights override —
rather than a reimplementation, because a copy is free to drift from the file
that ships and then reassure us about code nobody runs.
"""

import outliers


# Alternatives worth asking about, each a (reactions, comments, shares) triple.
#
# Chosen to bracket the current scheme rather than to flatter it: one that
# ignores the distinction entirely, one that halves the spread, one that
# doubles down on shares, and one that says comments are the real signal
# because they cost the reader the most effort.
WEIGHT_SCHEMES = [
    ("current", (1, 3, 5), "What ships today."),
    ("flat", (1, 1, 1), "No distinction at all — every interaction equal."),
    ("mild", (1, 2, 3), "Same ordering, half the spread."),
    ("share-heavy", (1, 3, 10), "Shares worth double what they are now."),
    ("comment-heavy", (1, 5, 3), "Comments as the strongest signal, not shares."),
]

# How deep a top list has to agree before the weights count as "not load
# bearing". Ten is what a person actually looks at in the feed.
TOP_N = 10


def _ranked_ids(posts, weights):
    """Scoreable posts, best first, under one weight scheme."""
    scored = outliers.score_posts(posts, weights=weights)
    ranked = [s for s in scored
              if s.get("has_baseline") and s.get("outlier_multiple") is not None]
    ranked.sort(key=lambda s: s["outlier_multiple"], reverse=True)
    return [s["id"] for s in ranked]


def _overlap(a, b, n):
    """How many of the top n are the same posts, ignoring their order."""
    if not a or not b:
        return None
    top_a, top_b = set(a[:n]), set(b[:n])
    return len(top_a & top_b)


def _displacement(base, other):
    """Mean places a post moves between two rankings.

    Set overlap alone hides reordering — the same ten posts in a completely
    different order is a different feed. Only posts present in both are
    counted, because a post that drops out entirely has no destination.
    """
    where = {pid: i for i, pid in enumerate(other)}
    moves = [abs(i - where[pid]) for i, pid in enumerate(base) if pid in where]
    if not moves:
        return None
    return round(sum(moves) / float(len(moves)), 1)


def audit(posts):
    """Everything the model can be asked about this data. Reads only."""
    posts = list(posts)
    report = {"total_posts": len(posts)}

    scored = outliers.score_posts(posts)
    report["scored"] = [s for s in scored if s.get("has_baseline")]
    report["scoreable_count"] = len(report["scored"])
    report.pop("scored")

    # ---------------------------------------------------------- 1. weights
    base_order = _ranked_ids(posts, None)
    depth = min(TOP_N, len(base_order))
    schemes = []
    for name, weights, note in WEIGHT_SCHEMES:
        order = _ranked_ids(posts, weights)
        schemes.append({
            "name": name,
            "weights": weights,
            "note": note,
            "same_in_top": _overlap(base_order, order, depth),
            "top_depth": depth,
            "mean_move": _displacement(base_order, order),
            "top_id": order[0] if order else None,
        })
    report["schemes"] = schemes
    report["top_depth"] = depth

    # The headline: if every alternative keeps the same top posts, the exact
    # weights are not load bearing and arguing about them is wasted effort.
    others = [s for s in schemes if s["name"] != "current"]
    agree = [s for s in others if s["same_in_top"] == depth]
    report["weights_load_bearing"] = bool(depth) and len(agree) < len(others)

    # ------------------------------------------------------------ 2. tiers
    tiers = {}
    for record in scored:
        tiers[record["tier"]] = tiers.get(record["tier"], 0) + 1
    report["tiers"] = tiers

    # Concentration is asked of the posts that actually GOT a band. "unknown"
    # is not a band, it is the absence of one — counting it in the numerator
    # while dividing by the scoreable count produced 114%, which is how this
    # bug announced itself.
    banded = {k: v for k, v in tiers.items() if k != "unknown"}
    banded_total = sum(banded.values())
    biggest = max(banded.values()) if banded else 0
    # One band holding most of them means the bands are not separating
    # anything, whichever band it is.
    report["banded_count"] = banded_total
    report["tier_concentration"] = (
        round(100.0 * biggest / banded_total, 1) if banded_total else None)
    report["tier_dominant"] = (
        max(banded, key=banded.get) if banded else None)

    caps = [r for r in scored
            if r.get("outlier_multiple") == outliers.MAX_MULTIPLE]
    report["at_cap"] = len(caps)

    # ----------------------------------------------------------- 3. floors
    by_source = {}
    for post in posts:
        by_source.setdefault(post["source_id"], []).append(post)

    sources = []
    for source_id, group in by_source.items():
        measured = [p for p in group if outliers.engagement_known(p)]
        engagements = [outliers.weighted_engagement(p) for p in measured]
        baseline = outliers._median(engagements)
        sources.append({
            "source_id": source_id,
            "name": (group[0].get("source_name") or "source %s" % source_id),
            "posts": len(group),
            "measured": len(measured),
            "baseline": round(baseline, 1),
            "fails_sample": len(measured) < outliers.MIN_SAMPLE,
            "fails_baseline": baseline < outliers.MIN_BASELINE,
            "scoreable": (len(measured) >= outliers.MIN_SAMPLE
                          and baseline >= outliers.MIN_BASELINE),
        })
    sources.sort(key=lambda s: s["posts"], reverse=True)
    report["sources"] = sources
    report["sources_blocked_by_sample"] = sum(1 for s in sources if s["fails_sample"])
    report["sources_blocked_by_baseline"] = sum(
        1 for s in sources if s["fails_baseline"] and not s["fails_sample"])

    # The measurement rate is the health signal underneath all of this. A
    # source where most captures failed to read engagement has a baseline
    # describing the few that worked.
    total_measured = sum(s["measured"] for s in sources)
    report["measured_rate"] = (
        round(100.0 * total_measured / len(posts), 1) if posts else None)

    # ------------------------------------------------------------ 4. input
    # The pre-V17.5 bug copied the view count into shares, so the two match
    # exactly on affected rows. Real posts do not have shares equal to views.
    suspect = [p for p in posts
               if (p.get("shares") or 0) > 0
               and (p.get("shares") or 0) == (p.get("video_plays") or 0)]
    report["suspect_share_rows"] = len(suspect)
    report["suspect_examples"] = [
        {"id": p["id"], "shares": p["shares"],
         "source": p.get("source_name") or p["source_id"]}
        for p in suspect[:5]
    ]
    # Those rows are weighted 5x and sit in their group's median, so they
    # distort every other post in the same source, not only themselves.
    report["sources_touched_by_suspect"] = len(
        {p["source_id"] for p in suspect})

    # ------------------------------------------------------- how much to
    # believe any of the above. Stated rather than left for the reader to
    # work out, because a confident-looking table computed from nine posts is
    # exactly the kind of number this product exists to argue against.
    n = report["scoreable_count"]
    if n < 30:
        report["confidence"] = "too thin"
        report["confidence_note"] = (
            "%d scoreable posts is not enough to conclude anything. Capture "
            "for a week and look again." % n)
    elif n < 150:
        report["confidence"] = "indicative"
        report["confidence_note"] = (
            "%d scoreable posts shows direction, not proof. Treat a clear "
            "result as a hypothesis worth acting on and a narrow one as "
            "noise." % n)
    else:
        report["confidence"] = "solid"
        report["confidence_note"] = (
            "%d scoreable posts is enough to act on." % n)

    return report
