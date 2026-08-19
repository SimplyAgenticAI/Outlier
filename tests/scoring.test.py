"""The accuracy rules, held in place.

outliers.py decides every number the product asserts, and until now nothing
tested it. Each rule below was learned the hard way — a wrong figure shipped,
got noticed, got fixed — and each one is a rule precisely because the code
reads fine either way. A median that quietly includes failed extractions looks
exactly like one that doesn't.

So these are not tests that the maths runs. They reconstruct the specific
wrong answer the rule exists to prevent, and insist it is not produced.

Run: python tests/scoring.test.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import outliers

FAILURES = []


def check(name, got, want=True):
    ok = got == want
    print(("  ok   " if ok else " FAIL  ") + name +
          ("" if ok else "   got %r, want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def post(pid=1, source=1, likes=0, comments=0, shares=0, read=1, item="post"):
    """One row as score_posts sees it.

    `read` is engagement_read: 1 measured, 0 extraction failed, None for rows
    written before the flag existed.
    """
    return {
        "id": pid, "source_id": source,
        "likes": likes, "comments": comments, "shares": shares,
        "engagement_read": read, "item_type": item,
        "posted_at": "2026-08-01T00:00:00",
        "captured_at": "2026-08-01T00:00:00",
    }


def many(n, start_id=1, **kwargs):
    return [post(pid=start_id + i, **kwargs) for i in range(n)]


def by_id(scored):
    return {row["id"]: row for row in scored}


def main():
    print("without a usable baseline the answer is None, never zero")
    # Three posts is under MIN_SAMPLE, so there is no baseline to compare to.
    # A stored 0.0 stayed available to any caller that forgot has_baseline,
    # and the feed's headline duly printed a multiple above 0 scored posts.
    scored = outliers.score_posts(many(3, likes=100))
    row = scored[0]
    check("outlier_multiple is None", row["outlier_multiple"], None)
    check("robust_z is None", row["robust_z"], None)
    check("baseline is None", row["baseline"], None)
    check("bar_pct is None", row["bar_pct"], None)
    check("has_baseline is False", row["has_baseline"], False)
    check("the tier says so rather than guessing", row["tier"], "unknown")
    check("nothing is 0.0 that could be read as a real figure",
          any(row[f] == 0.0 for f in
              ("outlier_multiple", "robust_z", "baseline", "bar_pct")), False)

    print()
    print("the sample size counts posts that were actually measured")
    # Eight rows, but three failed extraction. Counting rows rather than
    # measurements would call five measured posts enough evidence to score.
    mixed = many(5, start_id=1, likes=100) + many(3, start_id=6, likes=0, read=0)
    check("eight rows present", len(mixed), 8)
    check("but five measurements is not a baseline",
          outliers.score_posts(mixed)[0]["has_baseline"], False)

    enough = many(8, start_id=1, likes=100) + many(3, start_id=20, likes=0, read=0)
    check("eight measurements is", outliers.score_posts(enough)[0]["has_baseline"], True)

    print()
    print("unread posts stay out of the median")
    # Eight measured at 100, eight that could not be read. Including the
    # failures as zeros halves the baseline and doubles every multiple in the
    # group — the whole group is then scored against a number describing a
    # broken extractor rather than the room.
    group = many(8, start_id=1, likes=100) + many(8, start_id=20, likes=0, read=0)
    scored = by_id(outliers.score_posts(group))
    check("baseline is the median of what was read", scored[1]["baseline"], 100.0)
    check("  not dragged toward zero by the failures",
          scored[1]["baseline"] == 50.0, False)
    check("an unread post is not scored against the group",
          scored[20]["has_baseline"], False)
    check("  and is labelled unread, not underperforming",
          scored[20]["rank_basis"], "unread")

    print()
    print("engagement_read decides what counts as measured")
    check("legacy NULL with real counts reads as measured",
          outliers.engagement_known(post(likes=10, read=None)), True)
    check("legacy NULL with nothing is not evidence of anything",
          outliers.engagement_known(post(likes=0, read=None)), False)
    check("an explicit 0 wins over stray counts",
          outliers.engagement_known(post(likes=10, read=0)), False)
    check("an explicit 1 means measured, even at zero engagement",
          outliers.engagement_known(post(likes=0, read=1)), True)

    print()
    print("the multiple is capped")
    # A genuine runaway divided by a small median produces a figure that is
    # not informative, only alarming.
    runaway = many(8, start_id=1, likes=10) + [post(pid=99, likes=100000)]
    scored = by_id(outliers.score_posts(runaway))
    check("baseline is unmoved by the one big post", scored[99]["baseline"], 10.0)
    check("the multiple stops at MAX_MULTIPLE",
          scored[99]["outlier_multiple"], outliers.MAX_MULTIPLE)
    check("  which is 99.9, not 10000.0", scored[99]["outlier_multiple"], 99.9)

    print()
    print("a median too close to zero is not a baseline")
    # Below the floor the median is an artefact of failed capture. Dividing by
    # it turns an ordinary post into a breakout.
    weak = many(8, likes=2)
    row = outliers.score_posts(weak)[0]
    check("not scoreable under the floor", row["has_baseline"], False)
    check("and it says which problem this is", row["low_baseline"], True)
    check("no multiple is offered", row["outlier_multiple"], None)

    print()
    print("comments are their own population")
    # Comments run an order of magnitude below posts. Pooled into one median
    # they drag a healthy group under the floor, and every comment reads as a
    # failure against a number no comment was ever going to reach.
    mixed = (many(8, start_id=1, likes=1000, item="post")
             + many(8, start_id=20, likes=5, item="comment")
             + [post(pid=99, likes=50, item="comment")])
    scored = by_id(outliers.score_posts(mixed))
    check("posts keep their own median", scored[1]["baseline"], 1000.0)
    check("comments keep theirs", scored[20]["baseline"], 5.0)
    check("a standout comment reads as a standout",
          scored[99]["outlier_multiple"], 10.0)
    check("  not as underperforming against the posts",
          scored[99]["tier"], "breakout")

    print()
    print("a group with nothing scored reports no top multiple")
    # The exact shape of the shipped bug: the feed printed a biggest-outlier
    # figure above a count of zero scored posts, because the max was taken
    # across every post rather than only those carrying a baseline.
    stats = outliers.source_stats(many(3, likes=100000))
    check("top_multiple is None", stats["top_multiple"], None)
    check("baseline is None", stats["baseline"], None)
    check("has_baseline is False", stats["has_baseline"], False)
    check("no outliers are claimed", stats["outlier_count"], 0)

    print()
    print("the rollup says how much of the group could be read")
    stats = outliers.source_stats(many(6, start_id=1, likes=100)
                                  + many(4, start_id=20, likes=0, read=0))
    check("measured counted", stats["measured_count"], 6)
    check("unread counted", stats["unread_count"], 4)
    check("as a percentage", stats["measured_pct"], 60)
    # Ten posts captured, six readable. "Scan the group again" is useless
    # advice here — the posts are already there. The extractor is the problem,
    # and the blocker has to say which of the two it is.
    check("enough posts but unreadable ones says so", stats["blocker"], "unreadable")

    thin = outliers.source_stats(many(5, likes=100))
    check("genuinely too few posts is a different answer",
          thin["blocker"], "too-few")
    check("  and that group has nothing unread to blame",
          thin["unread_count"], 0)

    print()
    print("the scale pins the median at 25% and doubles by quarters")
    check("1x sits on the notch", outliers.bar_position(1.0), 25.0)
    check("2x is a quarter past it", outliers.bar_position(2.0), 50.0)
    check("4x another quarter", outliers.bar_position(4.0), 75.0)
    check("8x fills the track", outliers.bar_position(8.0), 100.0)
    check("beyond that it cannot overflow", outliers.bar_position(64.0), 100.0)
    check("and it never reaches zero width", outliers.bar_position(0.01), 2.0)

    print()
    print("tier boundaries are inclusive at the bottom of each band")
    # Called directly: these thresholds decide the badge colour on every card,
    # and going through score_posts would need a bespoke group per boundary.
    check("5.0 is a breakout", outliers._tier(5.0, True), "breakout")
    check("4.9 is not", outliers._tier(4.9, True), "strong")
    check("3.0 is strong", outliers._tier(3.0, True), "strong")
    check("2.9 is not", outliers._tier(2.9, True), "above")
    check("1.5 is above baseline", outliers._tier(1.5, True), "above")
    check("1.4 is typical", outliers._tier(1.4, True), "typical")
    check("0.4 underperformed", outliers._tier(0.4, True), "flop")
    check("no baseline outranks any multiple",
          outliers._tier(50.0, False), "unknown")

    print()
    print("every post says what its position in the list means")
    ranked = outliers.score_posts(
        many(8, start_id=1, likes=100)           # scored against a baseline
        + [post(pid=50, source=2, likes=40)]     # measured, group too small
        + [post(pid=51, source=2, likes=0)]      # measured, got nothing
        + [post(pid=52, source=2, likes=0, read=0)]   # never read
    )
    scored = by_id(ranked)
    check("scored posts say so", scored[1]["rank_basis"], "baseline")
    check("no baseline yet falls back to raw engagement",
          scored[50]["rank_basis"], "engagement")
    check("a real zero is ordered by recency", scored[51]["rank_basis"], "recency")
    check("a failed read is neither of those", scored[52]["rank_basis"], "unread")
    check("and each carries its own label",
          scored[52]["rank_basis_label"],
          outliers.RANK_BASIS_LABELS["unread"])

    print()
    print("scored posts rank above unscored ones")
    order = [row["rank_basis"] for row in ranked]
    check("baseline-scored come first",
          order[:8], ["baseline"] * 8)
    check("and unread sinks to the bottom", order[-1], "unread")

    print()
    print("weighting is shares over comments over reactions")
    check("a share is worth five reactions",
          outliers.weighted_engagement(post(shares=1)),
          outliers.weighted_engagement(post(likes=5)))
    check("a comment is worth three",
          outliers.weighted_engagement(post(comments=1)),
          outliers.weighted_engagement(post(likes=3)))
    check("an override does not leak into the next call",
          outliers.weighted_engagement(post(shares=1), weights=(1, 3, 10)), 10)
    check("  the default is still five",
          outliers.weighted_engagement(post(shares=1)), 5)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("the accuracy rules hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
