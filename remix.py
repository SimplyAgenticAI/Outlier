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


def _config():
    """The user's chosen provider and key — the SAME place Sage reads from.

    Remixing used to check os.environ['ANTHROPIC_API_KEY'] only, so a key saved
    through the app (which lives in settings, not the environment) was never
    seen and remix reported "not configured" no matter how often it was added.
    """
    import sage
    return sage.get_config()


def is_configured():
    try:
        return _config()["has_key"]
    except Exception:                       # no request context, etc.
        return False


def remix_post(post, angles=None, count=3):
    """Generate variants of a winning post.

    Returns (result_dict, error_string). Callers show the error inline rather
    than failing the page — a missing key shouldn't take out the post view.
    """
    cfg = _config()
    if not cfg["has_key"]:
        return None, "Add an AI key on the Settings page to enable remixing."

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

    if cfg["provider"] == "openai":
        return _remix_openai(cfg, user_content)
    return _remix_anthropic(cfg, user_content)


def _remix_anthropic(cfg, user_content):
    try:
        import anthropic
    except ImportError:
        return None, "The anthropic package is not installed. Run: pip install anthropic"

    import json
    client = anthropic.Anthropic(api_key=cfg["key"])
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
        return None, "Rate limited by Anthropic — try again in a moment."
    except anthropic.AuthenticationError:
        return None, "That Anthropic key was rejected. Check the key on the Settings page."
    except anthropic.APIStatusError as exc:
        return None, f"Anthropic error ({exc.status_code}): {exc.message}"
    except anthropic.APIConnectionError:
        return None, "Could not reach Anthropic — check your network connection."

    if response.stop_reason == "refusal":
        return None, "The model declined to rewrite this post."

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return None, "The model returned no usable output."
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "Could not parse the model's response."


def _remix_openai(cfg, user_content):
    try:
        import openai
    except ImportError:
        return None, "The openai package is not installed. Run: pip install openai"

    import json
    client = openai.OpenAI(api_key=cfg["key"])
    schema_hint = (
        "Respond ONLY with a JSON object of exactly this shape: "
        '{"why_it_worked": "<two sentences>", "variants": '
        '[{"angle": "<name>", "hook": "<opening line>", "body": "<full post copy>"}]}'
    )
    try:
        response = client.chat.completions.create(
            model=cfg["model"] or "gpt-4o",
            messages=[
                {"role": "system", "content": SYSTEM + "\n\n" + schema_hint},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
        )
    except openai.AuthenticationError:
        return None, "That OpenAI key was rejected. Check the key on the Settings page."
    except openai.RateLimitError:
        return None, "Rate limited by OpenAI — try again in a moment."
    except openai.APIStatusError as exc:
        return None, f"OpenAI error ({exc.status_code})."
    except openai.APIConnectionError:
        return None, "Could not reach OpenAI — check your network connection."

    text = (response.choices[0].message.content or "").strip()
    if not text:
        return None, "The model returned no usable output."
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "Could not parse the model's response."


# ------------------------------------------------------------------ graphics

def _openai_key():
    """The OpenAI key specifically.

    Image generation only exists on OpenAI, so it needs that key regardless of
    which provider drives the text features — a user on Claude for remixing can
    still generate graphics if they have also saved an OpenAI key.
    """
    import sage
    return sage.get_setting("ai_key_openai", "") or os.environ.get("OPENAI_API_KEY", "")


def graphic_configured():
    try:
        return bool(_openai_key())
    except Exception:
        return False


def generate_graphic(hook):
    """Turn a post's hook into a shareable illustration. Returns (image, error).

    `image` is a data: URL (gpt-image-1 returns base64) or an https URL (DALL-E).
    Text is deliberately kept OUT of the image — image models render lettering
    as garbage, so the graphic is a clean illustration of the idea, not a card.
    """
    key = _openai_key()
    if not key:
        return None, "Add an OpenAI key on the Settings page to generate graphics."

    try:
        import openai
    except ImportError:
        return None, "The openai package is not installed. Run: pip install openai"

    client = openai.OpenAI(api_key=key)
    prompt = (
        "A bold, clean, eye-catching social-media illustration that visually "
        "captures the idea of this post. Modern, high-contrast, scroll-stopping. "
        "Do NOT put any text, words, letters or captions in the image. Idea: "
        + (hook or "").strip()[:400]
    )

    last_err = None
    # gpt-image-1 first (best quality, returns base64); fall back to dall-e-3,
    # which is available without organisation verification.
    for model in ("gpt-image-1", "dall-e-3"):
        try:
            resp = client.images.generate(model=model, prompt=prompt, size="1024x1024", n=1)
            item = resp.data[0]
            b64 = getattr(item, "b64_json", None)
            if b64:
                return "data:image/png;base64," + b64, None
            url = getattr(item, "url", None)
            if url:
                return url, None
            last_err = "no image returned"
        except openai.AuthenticationError:
            return None, "That OpenAI key was rejected. Check it on the Settings page."
        except openai.RateLimitError:
            return None, "Rate limited by OpenAI — try again in a moment."
        except openai.APIConnectionError:
            return None, "Could not reach OpenAI — check your network connection."
        except Exception as exc:                    # model unavailable, content policy, etc.
            last_err = getattr(exc, "message", None) or str(exc)
            continue

    return None, f"Could not generate a graphic: {last_err}"
