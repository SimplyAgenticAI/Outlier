"""Subscriptions via Stripe Checkout.

This module never sees a card number. Checkout is a Stripe-hosted page: the
user is redirected there, enters payment details on Stripe's domain, and comes
back with nothing sensitive in hand. Entitlement is then set from a
signature-verified webhook rather than from the redirect, because a redirect
URL is attacker-controllable and a webhook is not.
"""

import os

import db

# Pricing.
#
# The tool replaces manual group research and hands back finished copy, so it
# sits well above a utility and well below the $100+ social-listening suites
# it competes against. $19 is low enough to be an easy yes without a
# procurement conversation, high enough to fund support and hosting.
#
# The annual price is ten months for twelve — a discount that is legible at a
# glance and needs no explaining.
PLANS = {
    "month": {
        "label": "Monthly",
        "amount": 1900,          # cents
        "display": "$19",
        "period": "per month",
        "note": "Cancel any time.",
    },
    "year": {
        "label": "Yearly",
        "amount": 19000,
        "display": "$190",
        "period": "per year",
        "note": "Two months free — works out at $15.83/mo.",
        "badge": "Save 17%",
    },
}

FREE_LIMITS = {"sources": None, "posts": 1000}   # None = unlimited

# One difference between the tiers, and it is volume.
#
# The old lists claimed Sage, remix, ideas and export were Pro-only. Nothing
# in the code has ever enforced that — capture_allowed is the single gate in
# the app and it counts posts. So the pricing page was telling free users they
# could not have things they already had, which is the one direction a pricing
# page must never be wrong in: it argues against the product to the people
# still deciding whether it works.
#
# Holding features back also hides the thing worth paying for. Somebody who
# has never seen a remix has no reason to want more capture; somebody who has
# used it on their own winning post has an obvious one.
PRO_FEATURES = [
    "Everything in Free, with nothing held back",
    "Unlimited captured posts and comments",
    "Scan as many groups as often as you like",
    "Priority on new features as they land",
]

FREE_FEATURES = [
    "Every feature — Sage, remix, ideas, export",
    "Full outlier scoring and the meadow",
    "Unlimited groups, pages and profiles",
    "1,000 captured posts",
]


def is_configured():
    return bool(os.environ.get("STRIPE_SECRET_KEY"))


def _client():
    import stripe
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    return stripe


# The live prices for this account, so a fresh deploy bills correctly with
# nothing to configure. A price id is not a secret — it identifies what is
# being sold, and is useless without the secret key that authorises a charge.
#
# The environment still wins when set, which is what makes test mode possible:
# test prices are different objects entirely, and a test key with a live price
# id fails outright.
DEFAULT_PRICES = {
    "month": "price_1U2zlNKAWBo2NxJskmsfzvgs",   # $19 / month
    "year":  "price_1U2zm4KAWBo2NxJssRLfeyyR",   # $190 / year
}


def price_id(interval):
    """The Stripe price to bill, environment first."""
    override = os.environ.get(
        "STRIPE_PRICE_MONTH" if interval == "month" else "STRIPE_PRICE_YEAR"
    )
    return override or DEFAULT_PRICES.get(interval)


def create_checkout_session(user, interval, success_url, cancel_url):
    """Returns (checkout_url, error)."""
    if interval not in PLANS:
        return None, "Unknown billing interval."
    if not is_configured():
        return None, "Billing isn't configured on this instance yet."

    price = price_id(interval)
    if not price:
        return None, (
            "No Stripe price configured for that interval. Set "
            f"STRIPE_PRICE_{'MONTH' if interval == 'month' else 'YEAR'}."
        )

    try:
        stripe = _client()
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": price, "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,
            customer=user.get("stripe_customer_id") or None,
            customer_email=None if user.get("stripe_customer_id") else user["email"],
            # Ties the completed checkout back to an account without trusting
            # anything the browser sends back on the return trip.
            client_reference_id=str(user["id"]),
            metadata={"user_id": str(user["id"]), "interval": interval},
            allow_promotion_codes=True,
        )
        return session.url, None
    except Exception as exc:                      # noqa: BLE001 - surfaced to the user
        return None, f"Stripe rejected the request: {exc}"


def create_portal_session(user, return_url):
    """Stripe's own billing portal — card updates, invoices, cancellation."""
    if not is_configured():
        return None, "Billing isn't configured on this instance yet."
    if not user.get("stripe_customer_id"):
        return None, "No subscription on this account yet."

    try:
        stripe = _client()
        session = stripe.billing_portal.Session.create(
            customer=user["stripe_customer_id"], return_url=return_url
        )
        return session.url, None
    except Exception as exc:                      # noqa: BLE001
        return None, f"Stripe rejected the request: {exc}"


def verify_webhook(payload, signature):
    """Returns (event, error). Signature verification is mandatory.

    Without it this endpoint is an unauthenticated "make me a subscriber"
    button, since anyone can POST a plausible-looking JSON body to it.
    """
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET")
    if not secret:
        return None, "STRIPE_WEBHOOK_SECRET is not set — refusing to trust this call."

    try:
        stripe = _client()
        return stripe.Webhook.construct_event(payload, signature, secret), None
    except Exception as exc:                      # noqa: BLE001
        return None, f"Signature check failed: {exc}"


def apply_subscription(user_id, **fields):
    """Write entitlement. Only ever called from a verified webhook."""
    allowed = {
        "plan", "billing_interval", "stripe_customer_id",
        "stripe_subscription_id", "subscription_status", "current_period_end",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return

    columns = ", ".join(f"{k} = ?" for k in updates)
    with db.get_db() as conn:
        conn.execute(
            f"UPDATE users SET {columns} WHERE id = ?",
            (*updates.values(), user_id),
        )


def user_id_for_customer(customer_id):
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT id FROM users WHERE stripe_customer_id = ?", (customer_id,)
        ).fetchone()
    return row["id"] if row else None


# ---------------------------------------------------------------- limits


def usage(user_id):
    with db.get_db() as conn:
        sources = conn.execute(
            "SELECT COUNT(*) AS n FROM sources WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        posts = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND is_demo = 0",
            (user_id,),
        ).fetchone()["n"]
    return {"sources": sources, "posts": posts}


def is_admin(user):
    """Owner of the instance. Never metered, never nagged to upgrade."""
    return bool(user and user.get("is_admin"))


def is_pro(user):
    """Paid access. past_due still counts — losing a card shouldn't lock
    someone out of their own research mid-billing-cycle."""
    if is_admin(user):
        return True
    return bool(
        user
        and user.get("plan") == "pro"
        and user.get("subscription_status") in ("active", "trialing", "past_due")
    )


def capture_allowed(user):
    """Returns (allowed, reason). Enforced at ingest, where it actually bites."""
    if is_admin(user) or is_pro(user):
        return True, None

    counts = usage(user["id"])

    # Post count is the hard stop and must be tested first. Checked after the
    # source limit it would never fire: once one group exists every later call
    # returns "existing_only" and short-circuits past this.
    if counts["posts"] >= FREE_LIMITS["posts"]:
        return False, (
            f"Free covers {FREE_LIMITS['posts']:,} posts and you've reached it. "
            "Upgrade for unlimited capture."
        )

    return True, None
