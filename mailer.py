"""Outbound email.

The app had no way to send email at all, which is why a password reset could
never arrive: nothing was failing to deliver, nothing was ever sent.

Deliberately stdlib SMTP rather than a provider SDK. Every mail service worth
using speaks SMTP, so this works with Resend, Postmark, SendGrid, Fastmail or
a self-hosted relay without adding a dependency or picking a winner.

Configure with:
    SMTP_HOST       smtp.gmail.com, smtp.resend.com, smtp.postmarkapp.com, ...
    SMTP_PORT       587 (STARTTLS, default) or 465 (implicit TLS)
    SMTP_USER       provider username, or the full address for Gmail
    SMTP_PASSWORD   provider password or API key (SMTP_PASS also accepted)
    MAIL_FROM       optional. Defaults to SMTP_USER with a display name.

SMTP_PASS is accepted as well as SMTP_PASSWORD, and MAIL_FROM is optional,
because the sibling app on this account already has working credentials under
those names — copying them across should not require renaming anything or
inventing a from-address that has to be verified somewhere first.

Unconfigured is a supported state, not an error. is_configured() is false, the
caller falls back to the operator-assisted path, and nobody is left staring at
an inbox waiting for something that was never coming.
"""

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

log = logging.getLogger("tallgrass.mail")

TIMEOUT = 15


# Gmail, because that is what this account actually sends through. Hardcoded
# so the only thing that has to exist in the environment is the one value that
# genuinely cannot live in a git repository — the password. A hostname is not
# a secret, and every variable that does not have to be set by hand is one
# fewer chance to set it on the wrong service or with the wrong capitalisation.
DEFAULT_HOST = "smtp.gmail.com"
DEFAULT_PORT = "587"


def _setting(name, default=""):
    return (os.environ.get(name) or default).strip()


def host():
    return _setting("SMTP_HOST") or DEFAULT_HOST


def _password():
    """SMTP_PASSWORD, or SMTP_PASS as the sibling app spells it."""
    return _setting("SMTP_PASSWORD") or _setting("SMTP_PASS")


def from_address():
    """Who the mail comes from.

    MAIL_FROM when set. Otherwise the authenticating address itself, which is
    the only address most providers will let you send as anyway — so host,
    user and password alone are enough to be working.
    """
    explicit = _setting("MAIL_FROM")
    if explicit:
        return explicit

    user = _setting("SMTP_USER")
    if not user or "@" not in user:
        return ""
    name = _setting("MAIL_FROM_NAME") or _setting("SMTP_FROM_NAME") or "Tallgrass"
    return "%s <%s>" % (name, user)


def is_configured():
    """True when a message could actually be delivered.

    The password is part of this now. It was not, so an instance with a host
    and a user but no password reported itself as configured and then failed
    at authentication — telling somebody their reset link was on its way when
    nothing could possibly send.
    """
    return bool(host() and _setting("SMTP_USER") and _password()
                and from_address())


def config_summary():
    """Presence only, for the admin page. Never the password."""
    user = _setting("SMTP_USER")

    # SMTP_HOST is no longer listed: it has a working default, so it can never
    # be the thing that is missing.
    missing = [name for name, present in (
        ("SMTP_USER", bool(user)),
        ("SMTP_PASSWORD", bool(_password())),
    ) if not present]

    # A from-address that cannot be derived is its own failure, and it is the
    # one that does not show up as an absent variable: SMTP_USER can be set
    # and still not be usable as a sender, because providers like Resend and
    # SendGrid authenticate with a literal username ('resend', 'apikey')
    # rather than an address. Without this the panel could report nothing
    # missing while still refusing to send, which is the worst kind of
    # diagnostic — one that says everything is fine and is wrong.
    if not missing and not from_address():
        missing.append("MAIL_FROM")

    return {
        "configured": is_configured(),
        "host": host(),
        "port": _setting("SMTP_PORT", DEFAULT_PORT),
        "from": from_address(),
        "authenticated": bool(user),
        "missing": missing,
        # Whether a credential was found at all. The host is excluded because
        # it now always has a value: empty user AND password means the
        # variables are not on this service — most likely set on a different
        # one — which is a different problem from a value being wrong.
        "any_set": bool(user or _password()),
    }


def send(to, subject, body):
    """Send one plain-text message. Returns (sent, error).

    Never raises. A failure here must not take down the page that triggered it
    — the caller has an operator-assisted fallback and needs to be told to use
    it, not handed a traceback.
    """
    if not is_configured():
        return False, "Email is not configured on this instance."

    server_host = host()
    port = int(_setting("SMTP_PORT", DEFAULT_PORT) or DEFAULT_PORT)
    user = _setting("SMTP_USER")
    password = _password()

    message = EmailMessage()
    message["From"] = from_address()
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    try:
        context = ssl.create_default_context()
        # 465 is TLS from the first byte; 587 opens plain and upgrades.
        if port == 465:
            with smtplib.SMTP_SSL(server_host, port, timeout=TIMEOUT,
                                  context=context) as server:
                if user:
                    server.login(user, password)
                server.send_message(message)
        else:
            with smtplib.SMTP(server_host, port, timeout=TIMEOUT) as server:
                server.starttls(context=context)
                if user:
                    server.login(user, password)
                server.send_message(message)
    except Exception as exc:                      # noqa: BLE001 - reported, not raised
        # The address is not logged. A failed send is an operational fact; who
        # it was for is the user's business.
        log.warning("smtp send failed via %s:%s — %s", server_host, port, exc)
        return False, "Could not send the email: %s" % exc

    log.info("sent %r via %s:%s", subject, server_host, port)
    return True, None
