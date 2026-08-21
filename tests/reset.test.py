"""Getting back into an account you are locked out of.

There was no password reset at all — no route, no token, and no way for the
app to send email — so somebody who forgot their password had no way back in.
This pins the replacement, and specifically the ways a reset flow becomes a
way IN for the wrong person: a link that survives being used, one that never
expires, one that can be found by reading the database, or a form that tells
a stranger which email addresses have accounts here.

Run: python tests/reset.test.py
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


PASSWORD = "the-original-passphrase"
NEW_PASSWORD = "a-replacement-passphrase"


def main():
    tmp = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = tmp
    os.environ["APP_SECRET"] = "test-only-secret"
    for key in ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM",
                "ADMIN_EMAILS"):
        os.environ.pop(key, None)

    import db
    import auth
    import mailer
    import app as appmod

    db.init_db()
    owner, _ = auth.create_user("owner@example.com", PASSWORD, "birchwood")
    locked, _ = auth.create_user("locked@example.com", PASSWORD, "fernlake")

    print("email is simply not configured here, and says so")
    check("is_configured is false", mailer.is_configured(), False)
    sent, error = mailer.send("a@b.c", "subject", "body")
    check("sending reports a failure rather than pretending", sent, False)
    check("  and names the reason", "not configured" in error, True)

    print()
    print("a reset link is issued, and only its hash is stored")
    raw, user = auth.create_reset_token("locked@example.com")
    check("a token comes back", bool(raw), True)
    check("for the right account", user["id"], locked["id"])
    with db.get_db() as conn:
        row = dict(conn.execute(
            "SELECT * FROM password_resets WHERE user_id = ?",
            (locked["id"],)).fetchone())
    check("the raw token is not in the table", raw in str(row), False)
    check("the row is unused", row["used_at"], None)
    check("and undelivered until an email actually goes out", row["delivered"], 0)

    print()
    print("an unknown address is refused without saying so")
    # The route's job is to answer identically either way; this is the half
    # that has to return nothing to work with.
    missing, muser = auth.create_reset_token("stranger@example.com")
    check("no token", missing, None)
    check("no user", muser, None)

    print()
    print("the link works exactly once")
    check("it is valid before use", auth.reset_token_valid(raw), True)
    uid, error = auth.consume_reset_token(raw, NEW_PASSWORD)
    check("it resets the right account", uid, locked["id"])
    check("with no error", error, None)
    check("the new password works",
          auth.verify_user("locked@example.com", NEW_PASSWORD)[0] is not None, True)
    check("the old one does not",
          auth.verify_user("locked@example.com", PASSWORD)[0], None)
    auth._ATTEMPTS.clear()
    check("the link is now invalid", auth.reset_token_valid(raw), False)
    again, error = auth.consume_reset_token(raw, "yet-another-passphrase")
    check("spending it twice fails", again, None)
    check("  and says it is spent", "expired or already been used" in error, True)
    check("the second password was NOT applied",
          auth.verify_user("locked@example.com", "yet-another-passphrase")[0], None)
    auth._ATTEMPTS.clear()

    print()
    print("a short password does not burn the link")
    raw2, _ = auth.create_reset_token("locked@example.com")
    uid, error = auth.consume_reset_token(raw2, "short")
    check("it is refused", uid, None)
    check("  for the stated reason", "at least" in error, True)
    check("but the link still works", auth.reset_token_valid(raw2), True)
    uid, _ = auth.consume_reset_token(raw2, "a-perfectly-fine-passphrase")
    check("and can still be spent properly", uid, locked["id"])
    auth._ATTEMPTS.clear()

    print()
    print("requesting a new link retires the old one")
    first, _ = auth.create_reset_token("locked@example.com")
    second, _ = auth.create_reset_token("locked@example.com")
    check("the newer link works", auth.reset_token_valid(second), True)
    check("the older one does not", auth.reset_token_valid(first), False)

    print()
    print("an expired link is dead")
    expired, _ = auth.create_reset_token("owner@example.com")
    with db.get_db() as conn:
        conn.execute(
            "UPDATE password_resets SET expires_at = '2000-01-01 00:00:00' "
            "WHERE used_at IS NULL AND user_id = ?", (owner["id"],))
    check("it no longer validates", auth.reset_token_valid(expired), False)
    uid, error = auth.consume_reset_token(expired, "should-not-apply-at-all")
    check("and cannot be spent", uid, None)
    check("the account is untouched",
          auth.verify_user("owner@example.com", PASSWORD)[0] is not None, True)
    auth._ATTEMPTS.clear()

    print()
    print("a garbage token is not a way in")
    for junk in ("", "x", "../../etc/passwd", "None", "0"):
        check("%r is rejected" % junk, auth.reset_token_valid(junk), False)

    print()
    print("changing a password by hand kills outstanding links")
    live, _ = auth.create_reset_token("owner@example.com")
    check("the link is live", auth.reset_token_valid(live), True)
    auth.set_password(owner["id"], "changed-from-the-account-page")
    check("setting a password retires it", auth.reset_token_valid(live), False)

    print()
    print("resetting clears the lockout that caused it")
    # Somebody guesses their own password wrong until they are throttled, then
    # resets. Meeting them with "too many attempts" straight after would leave
    # them locked out by the very thing that was meant to let them back in.
    for _ in range(auth.MAX_ATTEMPTS):
        auth.verify_user("locked@example.com", "wrong")
    check("they are throttled", auth._throttled("locked@example.com"), True)
    raw3, _ = auth.create_reset_token("locked@example.com")
    auth.consume_reset_token(raw3, "back-in-at-last-passphrase")
    check("the reset clears it", auth._throttled("locked@example.com"), False)
    check("and they can sign straight in",
          auth.verify_user("locked@example.com", "back-in-at-last-passphrase")[0]
          is not None, True)

    print()
    print("the request form answers identically either way")
    auth._RESETS.clear()
    client = appmod.app.test_client()
    real = client.post("/forgot", data={"email": "locked@example.com"})
    fake = client.post("/forgot", data={"email": "nobody@example.com"})
    check("same status", real.status_code, fake.status_code)
    check("same page", real.data, fake.data)
    check("and it does not confirm the account exists",
          b"locked@example.com" in real.data, False)

    print()
    print("the reset page states a dead link on arrival")
    dead = client.get("/reset/definitely-not-a-real-token")
    check("the page still renders", dead.status_code, 200)
    check("and says the link expired", b"has expired" in dead.data, True)
    check("without offering a password form",
          b'name="password"' in dead.data, False)

    print()
    print("sign-in offers a way to start all this")
    page = client.get("/login")
    check("the login page links to it", b"/forgot" in page.data, True)
    check("  in words somebody would look for",
          b"Forgot your password?" in page.data, True)

    print()
    print("the whole flow works through the app")
    auth._RESETS.clear()
    fresh, _ = auth.create_reset_token("locked@example.com")
    form = client.get("/reset/" + fresh)
    check("a live link renders the form", b'name="password"' in form.data, True)
    mismatch = client.post("/reset/" + fresh,
                           data={"password": "one-passphrase-here",
                                 "password_confirm": "a-different-one"})
    check("mismatched confirmations are refused", mismatch.status_code, 400)
    check("  and the link survives it", auth.reset_token_valid(fresh), True)
    done = client.post("/reset/" + fresh,
                       data={"password": "final-chosen-passphrase",
                             "password_confirm": "final-chosen-passphrase"})
    check("a good submission redirects", done.status_code, 302)
    check("  to sign in", "/login" in done.headers.get("Location", ""), True)
    check("the user is NOT auto-signed-in",
          client.get("/settings").status_code, 302)
    check("the new password is live",
          auth.verify_user("locked@example.com", "final-chosen-passphrase")[0]
          is not None, True)
    auth._ATTEMPTS.clear()

    print()
    print("only an admin can mint a link for somebody else")
    stranger = appmod.app.test_client()
    with stranger.session_transaction() as sess:
        sess["user_id"] = locked["id"]          # a normal, non-admin account
        sess["csrf_token"] = "t"
    denied = stranger.post("/api/admin/reset-link",
                           json={"email": "owner@example.com"},
                           headers={"X-CSRF-Token": "t"})
    check("a normal user is refused", denied.status_code, 403)

    boss = appmod.app.test_client()
    with boss.session_transaction() as sess:
        sess["user_id"] = owner["id"]           # first account, so admin
        sess["csrf_token"] = "t"
    issued = boss.post("/api/admin/reset-link",
                       json={"email": "locked@example.com"},
                       headers={"X-CSRF-Token": "t"})
    check("the owner gets a link", issued.status_code, 200)
    payload = issued.get_json()
    check("  marked ok", payload["ok"], True)
    check("  for the right account", payload["email"], "locked@example.com")
    check("  and it actually works",
          auth.reset_token_valid(payload["link"].rsplit("/", 1)[-1]), True)
    unknown = boss.post("/api/admin/reset-link",
                        json={"email": "ghost@example.com"},
                        headers={"X-CSRF-Token": "t"})
    check("an unknown account is a plain 404 for the owner",
          unknown.status_code, 404)

    print()
    print("outstanding requests are visible to the owner")
    auth._RESETS.clear()
    auth.create_reset_token("locked@example.com")
    pending = db.pending_reset_requests()
    check("the request is listed", len(pending) >= 1, True)
    check("with the account it belongs to", pending[0]["email"], "locked@example.com")
    check("and flagged as not emailed", pending[0]["delivered"], 0)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("%d FAILURES: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("locked out is no longer locked out for good")
    return 0


if __name__ == "__main__":
    sys.exit(main())
