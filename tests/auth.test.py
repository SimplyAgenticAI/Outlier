"""Three credentials, kept apart.

auth.py holds passwords, session cookies and the extension's API keys, and
until now none of it was tested. These are not tests that sign-in works —
they are tests that the specific ways it could stop being safe are caught:
a key stored in the clear, a throttle that a correct password walks through,
an error message that tells an attacker which emails exist, a capture endpoint
that quietly starts accepting a browser session.

Run: python tests/auth.test.py
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


GOOD_PASSWORD = "correct-horse-battery"


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    os.environ["APP_SECRET"] = "test-only-secret"
    os.environ.pop("ADMIN_EMAILS", None)

    import db
    import auth
    import app as appmod

    db.init_db()

    print("an account is created, and the password is not kept")
    user, error = auth.create_user("owner@example.com", GOOD_PASSWORD, "birchwood")
    check("no error", error, None)
    check("the account exists", bool(user), True)
    check("the password is nowhere in the row",
          GOOD_PASSWORD in str(dict(user)).replace("api_key", ""), False)
    check("the stored hash is not the password",
          user["password_hash"] == GOOD_PASSWORD, False)
    check("and it is a scrypt hash", user["password_hash"].startswith("scrypt:"), True)

    print()
    print("the first account owns the instance, later ones do not")
    check("first account is admin", bool(user["is_admin"]), True)
    second, _ = auth.create_user("member@example.com", GOOD_PASSWORD, "member")
    check("the second is not", bool(second["is_admin"]), False)

    print()
    print("registration refuses what it should")
    _, error = auth.create_user("not-an-email", GOOD_PASSWORD)
    check("a malformed address", error is not None, True)
    _, error = auth.create_user("short@example.com", "abc")
    check("a password under the minimum", error is not None, True)
    _, error = auth.create_user("OWNER@example.com", GOOD_PASSWORD)
    check("a duplicate email, case-insensitively", error is not None, True)
    _, error = auth.create_user("other@example.com", GOOD_PASSWORD, "Birchwood")
    check("a taken username, case-insensitively", error is not None, True)
    _, error = auth.create_user("other@example.com", GOOD_PASSWORD, "admin")
    check("a reserved username", error, "That name is reserved.")
    _, error = auth.create_user("other@example.com", GOOD_PASSWORD, "12345")
    check("a username that could pass as a member number", error is not None, True)

    print()
    print("only the hash of an API key is stored")
    raw = user["api_key"]
    check("the key is shown once on creation", raw.startswith("olk_"), True)
    with db.get_db() as conn:
        row = dict(conn.execute(
            "SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())
    check("the raw key is not in the row", raw in str(row), False)
    check("only its prefix is", row["api_key_prefix"], raw[:12])
    check("a stored hash is not the key", row["api_key_hash"] == raw, False)

    print()
    print("a key is only accepted if it is the real one")
    found = auth.user_for_api_key(raw)
    check("the real key resolves to its owner", found["id"], user["id"])
    check("a key with no prefix is refused", auth.user_for_api_key("nope"), None)
    check("an empty key is refused", auth.user_for_api_key(""), None)
    # Right prefix, wrong secret — the case a prefix-only lookup would pass.
    forged = raw[:12] + "x" * (len(raw) - 12)
    check("the right prefix with the wrong body is refused",
          auth.user_for_api_key(forged), None)

    print()
    print("rotating a key invalidates the old one")
    fresh = auth.rotate_api_key(user["id"])
    check("a new key is issued", fresh != raw, True)
    check("the new one works", auth.user_for_api_key(fresh)["id"], user["id"])
    check("the old one no longer does", auth.user_for_api_key(raw), None)

    print()
    print("sign-in does not reveal which emails exist")
    _, unknown = auth.verify_user("nobody@example.com", GOOD_PASSWORD)
    _, wrong = auth.verify_user("member@example.com", "not-the-password")
    check("an unknown account and a wrong password read the same",
          unknown, wrong)
    auth._ATTEMPTS.clear()

    print()
    print("the login throttle holds even against the right password")
    for _ in range(auth.MAX_ATTEMPTS):
        auth.verify_user("member@example.com", "wrong")
    ok, error = auth.verify_user("member@example.com", GOOD_PASSWORD)
    check("the correct password is refused once throttled", ok, None)
    check("and it says so rather than 'incorrect'", "Too many" in error, True)
    auth._ATTEMPTS.clear()
    ok, error = auth.verify_user("member@example.com", GOOD_PASSWORD)
    check("clearing the window lets them back in", ok is not None, True)

    print()
    print("a successful sign-in resets the counter")
    for _ in range(auth.MAX_ATTEMPTS - 1):
        auth.verify_user("member@example.com", "wrong")
    auth.verify_user("member@example.com", GOOD_PASSWORD)
    for _ in range(auth.MAX_ATTEMPTS - 1):
        auth.verify_user("member@example.com", "wrong")
    ok, _ = auth.verify_user("member@example.com", GOOD_PASSWORD)
    check("so near-misses do not accumulate across sessions", ok is not None, True)
    auth._ATTEMPTS.clear()

    print()
    print("signups are throttled per address, counted on success")
    auth._SIGNUPS.clear()
    check("a fresh address is allowed", auth.signup_throttled("1.2.3.4"), False)
    for _ in range(auth.MAX_SIGNUPS):
        auth.record_signup("1.2.3.4")
    check("its allowance runs out", auth.signup_throttled("1.2.3.4"), True)
    check("a different address is unaffected", auth.signup_throttled("5.6.7.8"), False)
    auth._SIGNUPS.clear()

    print()
    print("ADMIN_EMAILS promotes an account that already exists")
    check("member is not admin yet",
          bool(auth.verify_user("member@example.com", GOOD_PASSWORD)[0]["is_admin"]),
          False)
    os.environ["ADMIN_EMAILS"] = "member@example.com, someone@else.com"
    promoted, _ = auth.verify_user("member@example.com", GOOD_PASSWORD)
    check("signing in applies it", bool(promoted["is_admin"]), True)
    with db.get_db() as conn:
        stored = conn.execute("SELECT is_admin FROM users WHERE email = ?",
                              ("member@example.com",)).fetchone()["is_admin"]
    check("and it is persisted, not just returned", bool(stored), True)
    os.environ.pop("ADMIN_EMAILS", None)

    print()
    print("changing a password replaces the hash and enforces the minimum")
    def stored_hash():
        with db.get_db() as conn:
            return conn.execute("SELECT password_hash FROM users WHERE id = ?",
                                (user["id"],)).fetchone()["password_hash"]

    before = stored_hash()
    error = auth.set_password(user["id"], "short")
    check("a short password is refused", error is not None, True)
    check("nothing changed", stored_hash(), before)
    check("a long one is accepted", auth.set_password(user["id"], "a-brand-new-passphrase"), None)
    check("the old password stops working",
          auth.verify_user("owner@example.com", GOOD_PASSWORD)[0], None)
    auth._ATTEMPTS.clear()
    check("the new one works",
          auth.verify_user("owner@example.com", "a-brand-new-passphrase")[0] is not None,
          True)

    print()
    print("CSRF needs a token that matches the session")
    with appmod.app.test_request_context("/", method="POST"):
        token = auth.csrf_token()
        check("a token is issued", bool(token), True)
        check("the same token is reused within a session", auth.csrf_token(), token)
    with appmod.app.test_request_context(
            "/", method="POST", headers={"X-CSRF-Token": "wrong"}):
        auth.csrf_token()
        check("a wrong token fails", auth.check_csrf(), False)
    with appmod.app.test_request_context("/", method="POST"):
        auth.csrf_token()
        check("a missing token fails", auth.check_csrf(), False)
    # Through the real request path, since the guard runs as a before_request
    # rather than inside the view. The client has to be signed in first, or
    # login_required answers 401 and the CSRF check never runs — which is a
    # perfectly good answer, but not the one under test here.
    client = appmod.app.test_client()
    with client.session_transaction() as sess:
        sess["user_id"] = user["id"]
        sess["csrf_token"] = "known-token"
    posted = client.post("/api/username", json={"username": "hollowmere"},
                         headers={"X-CSRF-Token": "known-token"})
    check("a matching token is not rejected as CSRF",
          posted.status_code != 403, True)
    blocked = client.post("/api/username", json={"username": "hollowmere"},
                          headers={"X-CSRF-Token": "not-it"})
    check("a mismatched one is blocked", blocked.status_code, 403)
    missing = client.post("/api/username", json={"username": "hollowmere"})
    check("no token at all is blocked", missing.status_code, 403)

    print()
    print("signing in clears whatever was in the session first")
    with appmod.app.test_request_context("/"):
        from flask import session as flask_session
        flask_session["planted"] = "session-fixation"
        auth.login_session({"id": user["id"]})
        check("planted values do not survive", "planted" in flask_session, False)
        check("the user is signed in", flask_session["user_id"], user["id"])
        auth.logout_session()
        check("logging out empties it", dict(flask_session), {})

    print()
    print("the capture endpoint never accepts a browser session")
    # The whole reason it is exempt from CSRF: it must carry no ambient
    # authority. A cookie-authenticated caller has to be refused.
    signed_in = appmod.app.test_client()
    with signed_in.session_transaction() as sess:
        sess["user_id"] = user["id"]
    response = signed_in.post("/api/capture", json={"posts": []})
    check("a signed-in session alone is refused", response.status_code, 401)
    keyed = appmod.app.test_client().post(
        "/api/capture", json={"posts": []}, headers={"X-Outlier-Key": fresh})
    check("a valid API key is accepted", keyed.status_code != 401, True)

    print()
    print("dashboard endpoints refuse anonymous callers")
    anon = appmod.app.test_client()
    check("an API path answers 401, not a redirect",
          anon.get("/api/notifications").status_code, 401)
    page = anon.get("/settings")
    check("a page redirects to sign-in", page.status_code, 302)
    check("  and remembers where you were going",
          "next=/settings" in page.headers.get("Location", ""), True)

    print()
    print("every response carries its security headers")
    # These are the layer that still holds if the escaping discipline in the
    # templates or the client ever slips, so they have to be present on the
    # pages that render captured text — not just configured somewhere.
    headers = anon.get("/login").headers
    csp = headers.get("Content-Security-Policy", "")
    check("a CSP is sent", bool(csp), True)
    check("script-src is strict — no 'unsafe-inline'",
          "script-src 'self'" in csp and "unsafe-inline' 'self'" not in csp, True)
    check("  and no inline script is allowed anywhere",
          "script-src 'self' 'unsafe-inline'" in csp, False)
    check("objects are blocked", "object-src 'none'" in csp, True)
    check("framing is blocked", "frame-ancestors 'none'" in csp, True)
    check("forms cannot post off-origin", "form-action 'self'" in csp, True)
    # Post thumbnails come straight from Facebook's CDN and are not re-hosted.
    check("images may still come from https", "img-src 'self' data: https:" in csp, True)
    check("MIME sniffing is off", headers.get("X-Content-Type-Options"), "nosniff")
    check("referrers are trimmed cross-origin",
          headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
    check("legacy framing header is set", headers.get("X-Frame-Options"), "DENY")
    check("HSTS is NOT sent off-Render",
          "Strict-Transport-Security" in headers, False)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("the credentials stay apart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
