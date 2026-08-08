"""Turn a winning post into new posts.

Finding the outlier is half the job — the other half is writing your own
version that performs as well or better. This takes the original copy plus
its engagement profile and produces variants on different angles.
"""

import os

MODEL = "claude-opus-5"

# What actually made the post work varies, so generate across distinct angles
# rather than N rewrites of the same idea.
ANGLES = {
    "same_hook": "Keep the hook structure that worked, change the story and specifics entirely.",
    "contrarian": "Take the opposite position from the original while keeping the same energy.",
    "personal": "Rewrite as a first-person story with a concrete personal stake.",
    "listicle": "Restructure the same insight as a numbered list or breakdown.",
    "question": "Lead with a question that makes the reader want to answer in the comments.",
}

VARIANT_SCHEMA = {
    "type": "object",
    "properties": {
        "why_it_worked": {
            "type": "string",
            "description": "Two sentences on the specific mechanic that drove engagement on the original.",
        },
        "variants": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "angle": {"type": "string"},
                    "body": {"type": "string", "description": "The full post copy, ready to publish."},
                    "hook": {"type": "string", "description": "The opening line, isolated."},
                },
                "required": ["angle", "body", "hook"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["why_it_worked", "variants"],
    "additionalProperties": False,
}

SYSTEM = """You write organic social copy for Facebook groups and pages.

You are given a post that measurably outperformed its group's baseline, along \
with its engagement numbers. Your job is to work out what mechanic drove that \
result, then write new posts that use the same mechanic on different material.

Rules:
- Never reproduce the original's specifics — the story, numbers, names, and \
examples must be genuinely new. You are reusing structure, not content.
- Match the register of the source group. If the original is blunt and plain, \
do not make it polished.
- No hashtag stuffing, no emoji walls, no engagement-bait phrasing like \
"comment YES below" unless the original itself did that.
- Write the way a person posts, not the way a brand posts."""


def is_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def remix_post(post, angles=None, count=3):
    """Generate variants of a winning post.

    Returns (result_dict, error_string). Callers show the error inline rather
    than failing the page — a missing key shouldn't take out the post view.
    """
    if not is_configured():
        return None, "ANTHROPIC_API_KEY is not set — add it to enable remixing."

    try:
        import anthropic
    except ImportError:
        return None, "The anthropic package is not installed. Run: pip install anthropic"

    chosen = angles or list(ANGLES.keys())[:count]
    angle_text = "\n".join(f"- {a}: {ANGLES[a]}" for a in chosen if a in ANGLES)

    engagement = (
        f"{post.get('likes', 0)} reactions, "
        f"{post.get('comments', 0)} comments, "
        f"{post.get('shares', 0)} shares"
    )
    multiple = post.get("outlier_multiple")

    user_content = f"""Here is the post that outperformed.

Posted in: {post.get('source_name', 'a Facebook group')}
Performance: {engagement}{f" — {multiple}x the median post in that group" if multiple else ""}
Format: {post.get('post_type', 'text')}

--- ORIGINAL POST ---
{post.get('body', '').strip()}
--- END ORIGINAL ---

Write one variant for each of these angles:
{angle_text}"""

    client = anthropic.Anthropic()
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=8000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            output_config={
                "effort": "high",
                "format": {"type": "json_schema", "schema": VARIANT_SCHEMA},
            },
            messages=[{"role": "user", "content": user_content}],
        )
    except anthropic.RateLimitError:
        return None, "Rate limited by the API — try again in a moment."
    except anthropic.AuthenticationError:
        return None, "ANTHROPIC_API_KEY was rejected. Check the key is valid."
    except anthropic.APIStatusError as exc:
        return None, f"API error ({exc.status_code}): {exc.message}"
    except anthropic.APIConnectionError:
        return None, "Could not reach the API — check your network connection."

    if response.stop_reason == "refusal":
        return None, "The model declined to rewrite this post."

    import json

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return None, "The model returned no usable output."

    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "Could not parse the model's response."
