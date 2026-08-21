"""One bad post must not cost the whole batch.

Reported from a real scan: 197 posts captured, 147 delivered, then
"Dashboard returned 500". A 500 from /api/capture rejects everything in the
request, and the extension puts the whole batch back on the queue to fail the
same way next sweep — so a single unstorable post could strand fifty good ones
indefinitely.

These tests do not assert that capture works. They manufacture a post that
cannot be stored and insist the rest of the batch still lands, that the
failure is counted rather than hidden, and that the reason is recorded
somewhere the operator can read it.

Run: python tests/capture.test.py
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

FAILURES = []


def check(name, got, want=True):
    ok = got == want
    print(("  ok   " if ok else " FAIL  ") + name +
          ("" if ok else "   got %r, want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def post(n, body=None):
    return {
        "fb_post_id": "p%d" % n,
        "body": body if body is not None else "post number %d" % n,
        "author_name": "Author %d" % n,
        "post_type": "text",
        "posted_at": "2026-08-01T00:00:00",
        "likes": 10 + n, "comments": n, "shares": 0,
        "engagement_read": 1,
    }


SOURCE = {"fb_id": "group:ceomindsetgroup", "kind": "group",
          "name": "CEO Mindset Group"}


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    os.environ["APP_SECRET"] = "test-only-secret"

    import db
    import auth
    import app as appmod

    db.init_db()
    user, _ = auth.create_user("owner@example.com", "a-long-enough-passphrase",
                               "birchwood")
    key = user["api_key"]
    client = appmod.app.test_client()

    def send(posts):
        return client.post("/api/capture",
                           json={"source": SOURCE, "posts": posts},
                           headers={"X-Outlier-Key": key})

    print("a healthy batch lands whole")
    response = send([post(n) for n in range(10)])
    check("accepted", response.status_code, 200)
    body = response.get_json()
    check("all ten received", body["received"], 10)
    check("all ten new", body["new"], 10)
    check("none skipped", body["skipped"], 0)

    print()
    print("the same batch again is all duplicates, not an error")
    # This is what makes the extension's retry safe: a batch that landed
    # before a connection dropped comes back counted, not inserted twice.
    body = send([post(n) for n in range(10)]).get_json()
    check("received again", body["received"], 10)
    check("but nothing is new", body["new"], 0)
    with db.get_db() as conn:
        total = conn.execute("SELECT COUNT(*) AS n FROM posts").fetchone()["n"]
    check("and nothing was duplicated in the table", total, 10)

    print()
    print("one unstorable post does not reject the other forty-nine")
    # The failure is forced at the storage layer, which is where anything
    # unexpected in a real batch would surface.
    real_upsert = db.upsert_post

    def explode_on_p25(conn, source_id, author_id, p, user_id=None):
        if p.get("fb_post_id") == "p25":
            raise ValueError("simulated bad row")
        return real_upsert(conn, source_id, author_id, p, user_id=user_id)

    db.upsert_post = explode_on_p25
    try:
        response = send([post(n) for n in range(20, 70)])   # 50 posts, p25 bad
    finally:
        db.upsert_post = real_upsert

    check("the batch is NOT rejected", response.status_code, 200)
    body = response.get_json()
    check("all fifty were received", body["received"], 50)
    check("forty-nine stored", body["new"], 49)
    check("the one failure is counted", body["skipped"], 1)

    with db.get_db() as conn:
        stored = {r["fb_post_id"] for r in conn.execute(
            "SELECT fb_post_id FROM posts").fetchall()}
    check("the bad post is absent", "p25" in stored, False)
    check("its neighbours are present",
          "p24" in stored and "p26" in stored, True)

    print()
    print("and the reason is recorded where the operator will see it")
    recorded = db.get_setting("last_capture_error", "")
    check("something was recorded", bool(recorded), True)
    check("it names the exception type", "ValueError" in recorded, True)
    check("and the post it happened on", "p25" in recorded, True)

    print()
    print("a crash outside the loop is still an answer, not a blank 500")
    real_counts = db.caption_author_counts
    db.caption_author_counts = lambda *a, **k: (_ for _ in ()).throw(
        RuntimeError("simulated failure before the loop"))
    try:
        response = send([post(n) for n in range(100, 105)])
    finally:
        db.caption_author_counts = real_counts

    check("it is a 500", response.status_code, 500)
    body = response.get_json()
    check("but it is JSON, not an HTML error page", body is not None, True)
    check("  and says so plainly", body["ok"], False)
    check("  pointing at where the detail is",
          "admin" in body["error"], True)
    recorded = db.get_setting("last_capture_error", "")
    check("the reason is recorded", "RuntimeError" in recorded, True)

    print()
    print("deliberate HTTP answers are not swallowed as crashes")
    # The handler must pass HTTPExceptions straight through, or every 404 and
    # 401 in the app would start reporting itself as an internal error.
    check("a bad key is still 401",
          client.post("/api/capture", json={"source": SOURCE, "posts": []},
                      headers={"X-Outlier-Key": "olk_wrong"}).status_code, 401)
    check("an unknown URL is still 404",
          client.get("/no-such-page-at-all").status_code, 404)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("a bad post costs one post")
    return 0


if __name__ == "__main__":
    sys.exit(main())
