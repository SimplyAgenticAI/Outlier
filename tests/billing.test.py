"""Entitlement, and the ways it could be given away.

billing.py is live in production and had no test. The risk here is not that
Stripe stops working — Stripe will tell you. It is that the app grants paid
access, or admin, to somebody who did not buy it: a webhook trusted without a
signature, a field written that was never meant to be writable, a cancelled
subscription that keeps working.

Nothing here talks to Stripe. Every path tested is one that decides
entitlement locally, which is exactly the set that fails silently.

Run: python tests/billing.test.py
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


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    for key in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
                "STRIPE_PRICE_MONTH", "STRIPE_PRICE_YEAR"):
        os.environ.pop(key, None)

    import db
    import billing

    db.init_db()
    with db.get_db() as conn:
        conn.execute("INSERT INTO users (id, email, password_hash, is_admin) "
                     "VALUES (1, 'free@example.com', 'x', 0)")
        conn.execute("INSERT INTO users (id, email, password_hash, is_admin) "
                     "VALUES (2, 'boss@example.com', 'x', 1)")
        conn.execute("INSERT INTO sources (id, user_id, fb_id, kind, name) "
                     "VALUES (1, 1, 'group:g', 'group', 'A Group')")

    def user(uid):
        with db.get_db() as conn:
            return dict(conn.execute(
                "SELECT * FROM users WHERE id = ?", (uid,)).fetchone())

    print("a webhook is not trusted without a signing secret")
    # Without verification this endpoint is an unauthenticated
    # "make me a subscriber" button.
    event, error = billing.verify_webhook(b'{"type":"checkout.session.completed"}',
                                          "t=1,v1=whatever")
    check("no event is returned", event, None)
    check("and it says why", "STRIPE_WEBHOOK_SECRET" in error, True)

    print()
    print("entitlement writes are restricted to entitlement fields")
    # apply_subscription builds its UPDATE from keyword arguments. If the
    # allow-list ever stops filtering, a webhook payload becomes a way to write
    # any column on the users table — is_admin being the one that matters.
    billing.apply_subscription(
        1,
        plan="pro",
        subscription_status="active",
        is_admin=1,                       # not an entitlement field
        email="attacker@example.com",     # nor this
        password_hash="replaced",         # nor this
    )
    after = user(1)
    check("the plan was set", after["plan"], "pro")
    check("the status was set", after["subscription_status"], "active")
    check("is_admin was NOT granted", bool(after["is_admin"]), False)
    check("the email was NOT changed", after["email"], "free@example.com")
    check("the password hash was NOT changed", after["password_hash"], "x")

    print()
    print("an update with nothing writable in it writes nothing")
    before = user(1)
    billing.apply_subscription(1, is_admin=1, email="x@y.z")
    check("the row is untouched", user(1), before)

    print()
    print("paid access follows the subscription status")
    check("active is pro", billing.is_pro(user(1)), True)
    for status, expected in (("trialing", True), ("past_due", True),
                             ("canceled", False), ("unpaid", False),
                             ("incomplete_expired", False), (None, False)):
        billing.apply_subscription(1, subscription_status=status)
        label = status or "no status"
        check("%s -> %s" % (label, "pro" if expected else "not pro"),
              billing.is_pro(user(1)), expected)

    print()
    print("losing the plan loses access even if the status looks fine")
    billing.apply_subscription(1, plan="free", subscription_status="active")
    check("plan free is not pro", billing.is_pro(user(1)), False)

    print()
    print("the instance owner is never metered")
    boss = user(2)
    check("an admin reads as pro without paying", billing.is_pro(boss), True)
    check("and is admin", billing.is_admin(boss), True)
    check("a free user is not admin", billing.is_admin(user(1)), False)
    check("nobody is not admin", billing.is_admin(None), False)
    check("nobody is not pro", billing.is_pro(None), False)

    print()
    print("the free tier stops at its post limit")
    limit = billing.FREE_LIMITS["posts"]

    def seed(n, is_demo=0, start=0):
        with db.get_db() as conn:
            for i in range(n):
                conn.execute(
                    "INSERT INTO posts (user_id, fb_post_id, source_id, body, "
                    "post_type, posted_at, likes, comments, shares, "
                    "engagement_read, captured_at, is_demo, item_type) "
                    "VALUES (1, ?, 1, 'b', 'text', '2026-08-01T00:00:00', "
                    "10, 0, 0, 1, '2026-08-01T00:00:00', ?, 'post')",
                    ("fb-%d-%d" % (is_demo, start + i), is_demo))

    seed(limit - 1)
    allowed, reason = billing.capture_allowed(user(1))
    check("one under the limit is allowed", allowed, True)
    check("with no reason given", reason, None)

    seed(1, start=limit)
    allowed, reason = billing.capture_allowed(user(1))
    check("at the limit it stops", allowed, False)
    check("and names the limit", str(limit) in reason.replace(",", ""), True)

    print()
    print("sample data does not count against the limit")
    check("the real count is the limit", billing.usage(1)["posts"], limit)
    seed(50, is_demo=1, start=9000)
    check("demo posts are excluded", billing.usage(1)["posts"], limit)

    print()
    print("upgrading lifts the stop immediately")
    billing.apply_subscription(1, plan="pro", subscription_status="active")
    allowed, _ = billing.capture_allowed(user(1))
    check("a pro account captures past the free limit", allowed, True)
    check("and so does the owner", billing.capture_allowed(user(2))[0], True)

    print()
    print("checkout refuses what it cannot bill")
    url, error = billing.create_checkout_session(user(1), "fortnight", "/ok", "/no")
    check("an unknown interval is rejected", url, None)
    check("  by name", "interval" in error.lower(), True)
    url, error = billing.create_checkout_session(user(1), "month", "/ok", "/no")
    check("no Stripe key means no checkout", url, None)
    check("  and it says billing is not configured",
          "isn't configured" in error, True)
    check("is_configured agrees", billing.is_configured(), False)

    print()
    print("the billing portal needs an actual customer")
    url, error = billing.create_portal_session(user(1), "/back")
    check("unconfigured is refused first", url, None)
    os.environ["STRIPE_SECRET_KEY"] = "sk_test_not_a_real_key"
    url, error = billing.create_portal_session(user(1), "/back")
    check("a user with no Stripe customer is refused", url, None)
    check("  and told why", "No subscription", error[:15], )
    os.environ.pop("STRIPE_SECRET_KEY", None)

    print()
    print("customers map back to accounts")
    billing.apply_subscription(1, stripe_customer_id="cus_abc123")
    check("a known customer resolves", billing.user_id_for_customer("cus_abc123"), 1)
    check("an unknown one does not", billing.user_id_for_customer("cus_nope"), None)
    check("and neither does nothing", billing.user_id_for_customer(None), None)

    print()
    print("prices come from the environment when it is set")
    check("a built-in price is used by default",
          billing.price_id("month"), billing.DEFAULT_PRICES["month"])
    os.environ["STRIPE_PRICE_MONTH"] = "price_from_env"
    check("the environment wins", billing.price_id("month"), "price_from_env")
    check("  without affecting the other interval",
          billing.price_id("year"), billing.DEFAULT_PRICES["year"])
    os.environ.pop("STRIPE_PRICE_MONTH", None)
    check("an unknown interval has no price", billing.price_id("fortnight"), None)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("entitlement is only granted to those who bought it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
