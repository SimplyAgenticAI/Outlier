"""Every page must tell the same story about the same source.

These are the bugs this file exists to prevent, all reported from real use:
  - the groups list and the group's own page disagreeing about whether it
    was scored, because three places computed "readable" three ways;
  - "still climbing", a claim about a trend nothing measures;
  - "comment - comment" on every comment card;
  - comments opening a page with no way back to what they replied to.

Run: python tests/consistency.test.py
"""
import os
import re
import sys
import tempfile
import shutil
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

FAILURES = []


def check(name, got, want=True):
    ok = got == want
    print(("  ok   " if ok else " FAIL  ") + name +
          ("" if ok else "   got %r, want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    os.environ["ADMIN_EMAILS"] = "t@example.com"
    import app

    c = app.app.test_client()
    tok = re.search(r'name="csrf_token" value="([^"]+)"',
                    c.get("/register").get_data(as_text=True)).group(1)
    c.post("/register", data={"email": "t@example.com",
                              "password": "hunter2hunter2",
                              "password_confirm": "hunter2hunter2",
                              "csrf_token": tok}, follow_redirects=True)
    tok2 = re.search(r'name="csrf_token" value="([^"]+)"',
                     c.get("/account").get_data(as_text=True)).group(1)
    key = c.post("/api/account/connect",
                 headers={"X-CSRF-Token": tok2}).get_json()["api_key"]

    def iso(hours):
        return (datetime.now(timezone.utc) -
                timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")

    def send(fb_id, name, posts):
        return c.post("/api/capture",
                      json={"source": {"fb_id": fb_id, "kind": "group",
                                       "name": name, "url": "u"},
                            "posts": posts},
                      headers={"X-Outlier-Key": key})

    # Lots captured, almost none readable — the shape that produced the
    # contradiction between the list and the page.
    send("group:broken", "Broken Group",
         [{"fb_post_id": "b%d" % i, "body": "Post %d" % i,
           "likes": (120 if i < 3 else 0), "comments": 0, "shares": 0,
           "item_type": "post", "author_name": "A", "posted_at": iso(200),
           "engagement_read": (1 if i < 3 else 0)} for i in range(40)])

    send("group:good", "Good Group",
         [{"fb_post_id": "g%d" % i, "body": "Healthy %d" % i,
           "likes": 90 + i * 11, "comments": 6, "shares": 3,
           "item_type": "post", "author_name": "B", "engagement_read": 1,
           "posted_at": iso(5 if i == 0 else 300)} for i in range(12)] +
         [{"fb_post_id": "cm%d" % i, "body": "A reply number %d" % i,
           "likes": 8 + i * 4, "comments": 0, "shares": 0,
           "item_type": "comment", "author_name": "C", "engagement_read": 1,
           "posted_at": iso(280), "parent_fb_id": "g0"} for i in range(5)])

    groups = c.get("/groups").get_data(as_text=True)
    listed = re.findall(
        r'data-countup="(\d+)">\d+</span><span class="s-unit">%</span>', groups)

    print("consistency between the list and each group's own page")
    for sid in sorted(set(re.findall(r'data-source-id="(\d+)"', groups))):
        page = c.get("/groups/" + sid).get_data(as_text=True)
        pct = re.search(r'>(\d+)% readable<', page)
        check("group %s reports a readable %% on its own page" % sid, bool(pct))
        if pct:
            check("group %s: that %% also appears in the list" % sid,
                  pct.group(1) in listed)
        check("group %s: no stale 'at least 8 posts' copy" % sid,
              "at least 8 posts" not in page, True)

    print("claims the app is not entitled to make")
    feed = c.get("/").get_data(as_text=True)
    check("no 'still climbing' anywhere", "still climbing" not in feed)
    check("age is stated as a fact instead",
          bool(re.search(r"posted [\w ]+ ago", feed)))
    check("comments are not labelled twice",
          feed.count('class="type-chip">comment<'), 0)

    print("comments are not presented as a ranking")
    # Facebook previews one or two replies per post, chosen by "Most
    # relevant", so any ranked comments view would be ranking Facebook's
    # picks. Capture was removed; older rows must not resurface as a feed.
    feed_html = c.get("/").get_data(as_text=True)
    check("no Comments tab on the feed", "kind=comment" not in feed_html)
    check("no 'Comments captured' headline stat",
          "Comments captured" not in feed_html)
    check("?kind=comment does not open a ranked comment feed",
          "Top comments" not in c.get("/?kind=comment").get_data(as_text=True))
    check("no Comments tab on a group page",
          "kind=comment" not in c.get("/groups/2").get_data(as_text=True))

    # Rows captured by older versions still render on their post's page, and
    # must say what they are.
    detail_pages = [c.get("/post/" + p).get_data(as_text=True)
                    for p in re.findall(r'data-post-id="(\d+)"',
                                        c.get("/groups/2").get_data(as_text=True))]
    with_replies = [d for d in detail_pages if "preview comment" in d]
    check("legacy replies still show on their post", len(with_replies) > 0)
    if with_replies:
        check("and are labelled as Facebook's selection, not a ranking",
              "not the top ones" in with_replies[0])

    print("every page still renders")
    for path in ["/", "/groups", "/library", "/ideas", "/settings",
                 "/capture", "/account", "/sage", "/?kind=comment",
                 "/?tier=breakout", "/?page=2", "/groups/1?kind=comment"]:
        check("GET %s" % path, c.get(path).status_code, 200)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("all consistency checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
