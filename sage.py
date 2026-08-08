"""Sage — the built-in analyst.

Sage answers questions about your captured data and recommends what to post.
It is given the real numbers as context rather than being asked to guess: the
scoring model, per-source baselines, tier distribution, and the top outliers
with their actual copy.

Two providers are supported. The user supplies their own key; keys are stored
locally in the app's own database and never leave this machine except as an
Authorization header to the provider they chose.
"""

import json
import os

import db
import outliers

ANTHROPIC_MODEL = "claude-opus-5"
OPENAI_MODEL = "gpt-4o"

MAX_POSTS_IN_CONTEXT = 25
MAX_BODY_CHARS = 420


SYSTEM = """You are Sage, the analyst built into Outlier — a tool that finds \
breakout posts in Facebook groups.

What Outlier measures, and why it is different from follower-count tools:
every post is scored against the MEDIAN post of its own source, not against \
posts globally. A 300-reaction post in a group whose median is 40 is a bigger \
signal than a 3,000-reaction post from a page that averages 8,000. The score \
is reported as a multiple ("7.4x"). Engagement is weighted before comparison: \
shares count 5x, comments 3x, reactions 1x, because shares put a post in \
front of a new audience. Median and MAD are used rather than mean and standard \
deviation because engagement is heavily right-skewed. A source needs at least \
8 posts before it gets a baseline at all, and posts under 48 hours old are \
flagged "still climbing" because they are still accumulating.

Tiers: breakout is 5x or more, strong is 3-5x, above baseline is 1.5-3x, \
typical is around the median, underperformed is below half.

How to answer:
- Ground every claim in the numbers you were given. Cite the actual multiple \
and the group when you point at a post.
- Distinguish structure from topic. A post usually wins because of its hook, \
its specificity, or a concrete stake — say which, don't just describe what it \
was about.
- If the data does not support an answer, say so and name what is missing. \
A source with no baseline, or one whose posts have zero engagement recorded, \
cannot be reasoned about — flag it rather than inventing a read.
- Sample data is generated demonstration content, not real Facebook posts. \
Never present it as evidence about a real audience. If the only data available \
is sample data, say that plainly first.
- Be direct and concrete. No preamble, no restating the question."""


# --------------------------------------------------------------- settings


def _uid():
    """Owner of the current request. Config is per-account, not per-install."""
    import auth
    user = auth.current_user()
    return user["id"] if user else -1


def get_setting(key, default=None):
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT value FROM user_settings WHERE user_id = ? AND key = ?",
            (_uid(), key),
        ).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
            """,
            (_uid(), key, value),
        )


def get_config():
    """Provider config, with env vars as a fallback for the keys."""
    provider = get_setting("ai_provider", "anthropic")
    stored = get_setting("ai_key_" + provider, "")
    env_key = os.environ.get(
        "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY", ""
    )
    key = stored or env_key
    return {
        "provider": provider,
        "has_key": bool(key),
        "key": key,
        "key_source": "saved" if stored else ("environment" if env_key else None),
        "model": get_setting(
            "ai_model",
            ANTHROPIC_MODEL if provider == "anthropic" else OPENAI_MODEL,
        ),
    }


def is_configured():
    return get_config()["has_key"]


# --------------------------------------------------------------- context


def build_context():
    """Assemble the live picture of the user's data for Sage to reason over."""
    from app import _fetch_posts  # imported here to avoid a circular import

    posts = _fetch_posts()
    if not posts:
        return {"empty": True, "summary": "No posts have been captured yet."}

    scored = outliers.score_posts(posts)
    real = [s for s in scored if not s.get("is_demo")]
    demo = [s for s in scored if s.get("is_demo")]

    by_source = {}
    for post in scored:
        by_source.setdefault(post["source_name"] or "Unknown", []).append(post)

    sources = []
    for name, group in by_source.items():
        engaged = [p for p in group if p["total_engagement"] > 0]
        sources.append({
            "name": name,
            "posts": len(group),
            "is_sample": bool(group[0].get("is_demo")),
            "baseline": round(group[0]["baseline"], 1),
            "has_baseline": group[0]["has_baseline"],
            "engagement_recorded_pct": round(len(engaged) / len(group) * 100),
            "best_multiple": max(p["outlier_multiple"] for p in group),
        })

    tiers = {}
    for post in scored:
        tiers[post["tier"]] = tiers.get(post["tier"], 0) + 1

    top = sorted(
        [s for s in scored if s["has_baseline"]],
        key=lambda s: s["outlier_multiple"],
        reverse=True,
    )[:MAX_POSTS_IN_CONTEXT]

    return {
        "empty": False,
        "totals": {
            "posts": len(scored),
            "real_captured": len(real),
            "sample_generated": len(demo),
            "sources": len(sources),
        },
        "tier_counts": tiers,
        "sources": sources,
        "top_outliers": [
            {
                "id": p["id"],
                "multiple": p["outlier_multiple"],
                "tier": p["tier"],
                "source": p["source_name"],
                "is_sample": bool(p.get("is_demo")),
                "author": p["author_name"],
                "type": p["post_type"],
                "reactions": p["likes"],
                "comments": p["comments"],
                "shares": p["shares"],
                "still_climbing": p["still_climbing"],
                "body": (p["body"] or "")[:MAX_BODY_CHARS],
            }
            for p in top
        ],
    }


def _context_block():
    context = build_context()
    if context.get("empty"):
        return "The user has captured no posts yet. Say so and point them at the Capture page."
    return (
        "Here is the user's current data as JSON. These are the only numbers "
        "you may cite.\n\n```json\n"
        + json.dumps(context, indent=1)
        + "\n```"
    )


# --------------------------------------------------------------- providers


def _ask_anthropic(config, messages):
    try:
        import anthropic
    except ImportError:
        return None, "The anthropic package is not installed. Run: pip install anthropic"

    client = anthropic.Anthropic(api_key=config["key"])
    try:
        response = client.messages.create(
            model=config["model"] or ANTHROPIC_MODEL,
            max_tokens=4000,
            system=[
                {"type": "text", "text": SYSTEM},
                # The data block is large and stable across a conversation, so
                # cache it rather than re-billing it on every turn.
                {"type": "text", "text": _context_block(),
                 "cache_control": {"type": "ephemeral"}},
            ],
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            messages=messages,
        )
    except anthropic.AuthenticationError:
        return None, "That Anthropic key was rejected."
    except anthropic.RateLimitError:
        return None, "Rate limited by Anthropic — try again shortly."
    except anthropic.APIStatusError as exc:
        return None, f"Anthropic error ({exc.status_code}): {exc.message}"
    except anthropic.APIConnectionError:
        return None, "Could not reach Anthropic — check your connection."

    if response.stop_reason == "refusal":
        return None, "Sage declined to answer that."

    text = "".join(b.text for b in response.content if b.type == "text")
    return (text or None), (None if text else "Sage returned an empty response.")


def _ask_openai(config, messages):
    try:
        import openai
    except ImportError:
        return None, "The openai package is not installed. Run: pip install openai"

    client = openai.OpenAI(api_key=config["key"])
    try:
        response = client.chat.completions.create(
            model=config["model"] or OPENAI_MODEL,
            max_tokens=4000,
            messages=[
                {"role": "system", "content": SYSTEM + "\n\n" + _context_block()}
            ] + messages,
        )
    except openai.AuthenticationError:
        return None, "That OpenAI key was rejected."
    except openai.RateLimitError:
        return None, "Rate limited by OpenAI — try again shortly."
    except openai.APIStatusError as exc:
        return None, f"OpenAI error ({exc.status_code})."
    except openai.APIConnectionError:
        return None, "Could not reach OpenAI — check your connection."

    text = response.choices[0].message.content
    return (text or None), (None if text else "Sage returned an empty response.")


def ask(messages):
    """Send a conversation to whichever provider is configured.

    `messages` is a list of {role, content} with roles user/assistant.
    Returns (answer, error) — never raises, so a bad key shows inline.
    """
    config = get_config()
    if not config["has_key"]:
        return None, "No API key set. Add one in Settings to talk to Sage."

    if config["provider"] == "openai":
        return _ask_openai(config, messages)
    return _ask_anthropic(config, messages)


IDEAS_SCHEMA = {
    "type": "object",
    "properties": {
        "read": {
            "type": "string",
            "description": "Two or three sentences on what is actually working in this group, grounded in the numbers.",
        },
        "ideas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "hook": {"type": "string", "description": "The opening line on its own."},
                    "body": {"type": "string", "description": "The full post, ready to publish."},
                    "why": {"type": "string", "description": "One sentence: which observed pattern this borrows, and from which post."},
                    "format": {"type": "string", "description": "text, photo, video, or link."},
                },
                "required": ["hook", "body", "why", "format"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["read", "ideas"],
    "additionalProperties": False,
}

IDEAS_SYSTEM = SYSTEM + """

Right now you are writing new post ideas for one specific group.

Work from what the outliers in that group have in common — the hook shape, the
degree of specificity, whether there is a personal stake, the length, the
register. Then write posts that use those mechanics on entirely new material.

Hard rules:
- Never reuse an original's story, numbers, names, or examples. You are
  borrowing structure, not content.
- Match the group's register. A blunt, plainly-typed group should not get
  polished marketing copy.
- No hashtag stuffing, no emoji walls, no "comment YES below" engagement bait
  unless the group's own winners do that.
- Each idea must cite which observed pattern it borrows and from which post.
- If the group's data is too thin or its engagement was not recorded, say so
  in `read` and return fewer ideas rather than inventing a pattern."""


def generate_ideas(source_name, posts, count=3):
    """Write new post ideas modelled on what outperformed in one group."""
    config = get_config()
    if not config["has_key"]:
        return None, "No API key set. Add one in Settings to generate ideas."

    if not posts:
        return None, "No scored posts in this group yet."

    lines = []
    for post in posts[:15]:
        lines.append(
            f"[{post['outlier_multiple']}x {post['tier']}] "
            f"{post['likes']} reactions / {post['comments']} comments / "
            f"{post['shares']} shares · {post['post_type']}\n"
            f"{(post['body'] or '').strip()[:400]}\n"
        )

    user_content = (
        f"Group: {source_name}\n"
        f"Median post scores {posts[0]['baseline']:.0f} on the weighted scale.\n\n"
        f"Its top-performing posts, best first:\n\n"
        + "\n---\n".join(lines)
        + f"\n\nWrite {count} new post ideas for this group."
    )

    messages = [{"role": "user", "content": user_content}]

    if config["provider"] == "openai":
        return _ideas_openai(config, messages)
    return _ideas_anthropic(config, messages)


def _ideas_anthropic(config, messages):
    try:
        import anthropic
    except ImportError:
        return None, "The anthropic package is not installed."

    client = anthropic.Anthropic(api_key=config["key"])
    try:
        response = client.messages.create(
            model=config["model"] or ANTHROPIC_MODEL,
            max_tokens=8000,
            system=IDEAS_SYSTEM,
            thinking={"type": "adaptive"},
            output_config={
                "effort": "high",
                "format": {"type": "json_schema", "schema": IDEAS_SCHEMA},
            },
            messages=messages,
        )
    except anthropic.AuthenticationError:
        return None, "That Anthropic key was rejected."
    except anthropic.APIStatusError as exc:
        return None, f"Anthropic error ({exc.status_code}): {exc.message}"
    except anthropic.APIConnectionError:
        return None, "Could not reach Anthropic."

    if response.stop_reason == "refusal":
        return None, "The model declined this request."

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return None, "No usable output."
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "Could not parse the response."


def _ideas_openai(config, messages):
    try:
        import openai
    except ImportError:
        return None, "The openai package is not installed."

    client = openai.OpenAI(api_key=config["key"])
    try:
        response = client.chat.completions.create(
            model=config["model"] or OPENAI_MODEL,
            max_tokens=8000,
            response_format={"type": "json_object"},
            messages=[{
                "role": "system",
                "content": IDEAS_SYSTEM + "\n\nRespond with JSON matching: "
                           + json.dumps(IDEAS_SCHEMA),
            }] + messages,
        )
    except openai.AuthenticationError:
        return None, "That OpenAI key was rejected."
    except openai.APIStatusError as exc:
        return None, f"OpenAI error ({exc.status_code})."
    except openai.APIConnectionError:
        return None, "Could not reach OpenAI."

    text = response.choices[0].message.content
    if not text:
        return None, "No usable output."
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "Could not parse the response."


SUGGESTED = [
    "What's actually working across my groups right now?",
    "Which post should I remix first, and why that one?",
    "What do my breakout posts have in common?",
    "Which of my groups is worth the most attention?",
    "What should I post this week?",
]
