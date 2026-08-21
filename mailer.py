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


def _setting(name, default=""):
    return (os.environ.get(name) or default).strip()


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
    """True when there is somewhere to send mail and a from-address to use."""
    return bool(_setting("SMTP_HOST") and from_address())


def config_summary():
    """Presence only, for the admin page. Never the password."""
    return {
        "configured": is_configured(),
        "host": _setting("SMTP_HOST"),
        "port": _setting("SMTP_PORT", "587"),
        "from": from_address(),
        "authenticated": bool(_setting("SMTP_USER")),
        # Named so a half-configured instance says which piece is missing
        # rather than just refusing to send.
        "missing": [name for name, present in (
            ("SMTP_HOST", bool(_setting("SMTP_HOST"))),
            ("SMTP_USER", bool(_setting("SMTP_USER"))),
            ("SMTP_PASSWORD", bool(_password())),
        ) if not present],
    }


def send(to, subject, body):
    """Send one plain-text message. Returns (sent, error).

    Never raises. A failure here must not take down the page that triggered it
    — the caller has an operator-assisted fallback and needs to be told to use
    it, not handed a traceback.
    """
    if not is_configured():
        return False, "Email is not configured on this instance."

    host = _setting("SMTP_HOST")
    port = int(_setting("SMTP_PORT", "587") or 587)
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
            with smtplib.SMTP_SSL(host, port, timeout=TIMEOUT,
                                  context=context) as server:
                if user:
                    server.login(user, password)
                server.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=TIMEOUT) as server:
                server.starttls(context=context)
                if user:
                    server.login(user, password)
                server.send_message(message)
    except Exception as exc:                      # noqa: BLE001 - reported, not raised
        # The address is not logged. A failed send is an operational fact; who
        # it was for is the user's business.
        log.warning("smtp send failed via %s:%s — %s", host, port, exc)
        return False, "Could not send the email: %s" % exc

    log.info("sent %r via %s:%s", subject, host, port)
    return True, None
