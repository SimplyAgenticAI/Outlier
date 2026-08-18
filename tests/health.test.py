"""The canary has to actually sing.

A monitor that never fires is worse than no monitor, because it is also a
reason not to look. So these tests do not check that the numbers render —
they manufacture the exact failure the thing exists to catch (a Facebook
markup change, which arrives as a cliff in one extracted field between one
week's captures and the last) and insist it is detected.

Run: python tests/health.test.py
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


def seed(db, user_id, source_id, n, days_ago, engagement=True, author=True):
    """n posts captured `days_ago`, with the given fields present or missing."""
    with db.get_db() as conn:
        for i in range(n):
            conn.execute(
                """
                INSERT INTO posts (user_id, fb_post_id, source_id, author_id,
                                   body, permalink, post_type, posted_at,
                                   likes, comments, shares, engagement_read,
                                   captured_at, is_demo, item_type)
                VALUES (?, ?, ?, ?, ?, ?, 'text', '2026-08-01T00:00:00',
                        ?, 0, 0, ?, datetime('now', ?), 0, 'post')
                """,
                (user_id, "fb-%s-%s-%s" % (days_ago, i, source_id), source_id,
                 (1 if author else None),
                 "body %d" % i, "https://facebook.com/p/%s-%s" % (days_ago, i),
                 (10 if engagement else 0),
                 (1 if engagement else 0),
                 "-%d days" % days_ago),
            )


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    import db
    import capture_health

    db.init_db()
    with db.get_db() as conn:
        conn.execute("INSERT INTO users (id, email, password_hash, is_admin) "
                     "VALUES (1, 'a@example.com', 'x', 1)")
        conn.execute("INSERT INTO sources (id, user_id, fb_id, kind, name) "
                     "VALUES (1, 1, 'group:g', 'group', 'A Group')")

    print("not enough data is its own answer")
    r = capture_health.report()
    check("with nothing captured it says unknown", r["state"], "unknown")
    check("  and does not claim health", r["comparable"], False)

    # A healthy baseline: 40 good posts across the older window.
    seed(db, 1, 1, 40, days_ago=20)
    print()
    print("a healthy week reads healthy")
    seed(db, 1, 1, 30, days_ago=2)
    r = capture_health.report()
    check("state is healthy", r["state"], "healthy")
    check("nothing tripped", r["tripped"], [])
    check("recent window counted", r["recent_count"], 30)
    check("baseline window counted", r["baseline_count"], 40)

    print()
    print("a markup change is caught")
    # Wipe the good recent week, replace with a week where engagement stopped
    # extracting — exactly what a Facebook change looks like from here.
    with db.get_db() as conn:
        conn.execute("DELETE FROM posts WHERE captured_at >= datetime('now', '-7 days')")
    seed(db, 1, 1, 30, days_ago=2, engagement=False)
    r = capture_health.report()
    check("state is degraded", r["state"], "degraded")
    check("engagement is named as the failure", "engagement" in r["tripped"], True)
    eng = [f for f in r["fields"] if f["name"] == "engagement"][0]
    check("the drop is reported", eng["recent"], 0.0)
    check("  against a healthy baseline", eng["baseline"], 100.0)
    check("author did NOT trip — only what broke is reported",
          "author" in r["tripped"], False)

    print()
    print("the alert fires once, not once per page view")
    capture_health.check_and_alert()
    first = len(db.notifications_for(1, limit=50))
    capture_health.check_and_alert()
    capture_health.check_and_alert()
    after = len(db.notifications_for(1, limit=50))
    check("an admin was notified", first >= 1, True)
    check("repeat checks do not pile up copies", after, first)

    print()
    print("recovery re-arms it")
    with db.get_db() as conn:
        conn.execute("DELETE FROM posts WHERE captured_at >= datetime('now', '-7 days')")
    seed(db, 1, 1, 30, days_ago=2)
    r = capture_health.check_and_alert()
    check("back to healthy", r["state"], "healthy")
    # Break it again — a fresh break must alert even though one already did.
    with db.get_db() as conn:
        conn.execute("DELETE FROM posts WHERE captured_at >= datetime('now', '-7 days')")
    seed(db, 1, 1, 30, days_ago=2, engagement=False)
    capture_health.check_and_alert()
    check("a NEW break alerts again", len(db.notifications_for(1, limit=50)) > after, True)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("the canary sings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
