"""Every way an account can be silently getting nothing.

The point of the cross-user view is that nobody in it has complained. So the
test cannot be "does it render" — it has to build each failure on purpose and
insist the right one is named, including the two that are easy to confuse: an
account still capturing but reading nothing looks a lot like an account that
stopped, and an account with plenty captured and nothing ranked looks a lot
like an account with nothing captured.

Run: python tests/users.test.py
"""
import os
import sys
import tempfile
import shutil

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

FAILURES = []


def check(name, got, want=True):
    ok = got == want
    print(("  ok   " if ok else " FAIL  ") + name +
          ("" if ok else "   got %r, want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def make_user(db, uid, email):
    with db.get_db() as conn:
        conn.execute("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')",
                     (uid, email))
        conn.execute("INSERT INTO sources (id, user_id, fb_id, kind, name) "
                     "VALUES (?, ?, ?, 'group', ?)",
                     (uid, uid, "group:%d" % uid, "Group %d" % uid))


def seed(db, uid, n, days_ago, likes, read=1):
    with db.get_db() as conn:
        for i in range(n):
            conn.execute(
                """
                INSERT INTO posts (user_id, fb_post_id, source_id, author_id, body,
                                   permalink, post_type, posted_at, likes, comments,
                                   shares, engagement_read, captured_at, is_demo, item_type)
                VALUES (?, ?, ?, 1, 'text', 'https://fb/p', 'text',
                        '2026-08-01T00:00:00', ?, 0, 0, ?, datetime('now', ?), 0, 'post')
                """,
                (uid, "fb-%d-%d-%d" % (uid, days_ago, i), uid, likes, read,
                 "-%d days" % days_ago))


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    import db
    import user_health

    db.init_db()

    # 1 never captured. 2 blind. 3 nothing scoreable. 4 stalled. 5 fine.
    for uid, email in [(1, "never@x"), (2, "blind@x"), (3, "unscored@x"),
                       (4, "stalled@x"), (5, "fine@x")]:
        make_user(db, uid, email)

    seed(db, 2, 12, days_ago=2, likes=40, read=0)     # capturing, counts unread
    seed(db, 3, 12, days_ago=2, likes=1)              # read, but baseline under floor
    seed(db, 4, 12, days_ago=40, likes=200)           # good data, long stopped
    seed(db, 5, 12, days_ago=2, likes=200)            # working

    report = user_health.report()
    by_email = {u["email"]: u for u in report["users"]}

    print("each way of getting nothing is named correctly")
    check("signed up and never captured", by_email["never@x"]["problem"], "never")
    check("capturing but counts unread", by_email["blind@x"]["problem"], "blind")
    check("captured plenty, nothing scoreable", by_email["unscored@x"]["problem"], "unscored")
    check("captured once and stopped", by_email["stalled@x"]["problem"], "stalled")
    check("a working account is not flagged", by_email["fine@x"]["problem"], None)

    print()
    print("the numbers behind each verdict")
    check("blind reads 0% of counts", by_email["blind@x"]["read_rate"], 0.0)
    check("  and so has no scoreable source", by_email["blind@x"]["scoreable_sources"], 0)
    check("unscored read everything", by_email["unscored@x"]["read_rate"], 100.0)
    check("  and still cannot be ranked", by_email["unscored@x"]["scoreable_sources"], 0)
    check("the working account has one", by_email["fine@x"]["scoreable_sources"], 1)
    check("stalled is counted in days", by_email["stalled@x"]["days_since_capture"] >= 14, True)

    print()
    print("the worst problems come first")
    problems = [u["problem"] for u in report["users"]]
    check("blind outranks stalled", problems.index("blind") < problems.index("stalled"), True)
    check("unscored outranks never", problems.index("unscored") < problems.index("never"), True)
    check("the fine account is last", problems[-1], None)

    print()
    print("the rollup counts what it found")
    check("four accounts flagged", report["affected"], 4)
    check("five accounts total", report["total"], 5)
    check("one of each", report["counts"],
          {"blind": 1, "unscored": 1, "never": 1, "stalled": 1})

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("silent failures are visible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
