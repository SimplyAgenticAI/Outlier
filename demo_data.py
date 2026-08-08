"""Sample data so a fresh install has something to render.

Every row is written with is_demo=1 and can be wiped from the Capture page.
This exists to make the difference between "working but empty" and "broken"
visible — it is not a substitute for real captures.

Engagement follows a power-law-ish shape on purpose: most posts sit near the
median with a couple of genuine breakouts, which is what the outlier scoring
is designed to separate.
"""

import random
from datetime import datetime, timedelta, timezone

import db

SEED = 20260807  # fixed so the demo set is identical on every machine

DEMO_SOURCES = [
    {
        "fb_id": "demo-group-ecom",
        "kind": "group",
        "name": "[DEMO] Ecommerce Founders UK",
        "member_count": 24800,
    },
    {
        "fb_id": "demo-group-agency",
        "kind": "group",
        "name": "[DEMO] Agency Owners Lounge",
        "member_count": 9100,
    },
    {
        "fb_id": "demo-group-local",
        "kind": "group",
        "name": "[DEMO] Local Service Business Growth",
        "member_count": 41200,
    },
]

DEMO_AUTHORS = [
    "Sam Okonkwo", "Rachel Fenwick", "Dev Patel", "Marta Nowak",
    "Tom Aldridge", "Jess Kimura", "Femi Adeyemi", "Nina Brandt",
]

# Bodies are written to look like real group posts — some plainly typed, some
# structured — because the remix engine keys off register as much as content.
DEMO_POSTS = [
    ("Spent 4 months building a feature nobody asked for. Killed it last week. "
     "Revenue went up 8%. Turns out the thing was confusing people at checkout.\n\n"
     "Ask before you build. I clearly didn't.", "text", 9.2),
    ("Anyone else getting absolutely destroyed by shipping costs this quarter? "
     "Our margins are down 6 points and it's entirely postage.", "text", 1.1),
    ("Quick one — what's everyone using for inventory sync these days? "
     "Currently on spreadsheets and it's held together with hope.", "text", 0.7),
    ("I fired our biggest client on Tuesday.\n\nThey were 40% of revenue and about "
     "110% of our stress. Two people on my team were ready to quit over them.\n\n"
     "Scariest thing I've done. Zero regrets so far. Ask me in six months.", "text", 12.4),
    ("Reminder that a 2% conversion rate means 98 out of 100 people looked at your "
     "thing and left. Most of your growth is hiding in that 98.", "text", 3.8),
    ("Case study: took a client from 3k to 22k monthly revenue in 7 months. "
     "Full breakdown of what actually moved the needle in the comments.", "photo", 4.1),
    ("Does anyone have a decent VA agency they'd recommend? Been burned twice now.", "text", 0.5),
    ("Hot take: most 'brand strategy' work sold to small businesses is expensive "
     "procrastination. Ship the thing. Fix it in public.", "text", 5.6),
    ("Our best performing ad this month was filmed on a phone in a car park. "
     "The £4k studio production did a third of the numbers.", "video", 6.8),
    ("Genuinely curious how many people here are profitable vs just busy.", "text", 2.2),
    ("Three years in, first month over six figures. Not posting numbers to brag — "
     "posting because in year one I read posts like this and assumed they were fake. "
     "They weren't. It just takes much longer than anyone admits.", "text", 8.1),
    ("What's your actual close rate on discovery calls? Mine's 22% and I can't tell "
     "if that's good or terrible.", "text", 1.9),
    ("Stop offering unlimited revisions. That's it, that's the post.", "text", 4.4),
    ("Built our whole onboarding in Notion and clients keep saying it's the most "
     "organised agency they've worked with. It took a weekend.", "text", 2.7),
    ("Looking for a copywriter who understands B2B SaaS. Budget is real. DM me.", "text", 0.4),
    ("The uncomfortable truth about referrals: they dry up the moment you stop "
     "delivering something remarkable. They're a lagging indicator, not a strategy.", "text", 3.3),
    ("Anyone tried the new ad format? Results seem inconsistent across accounts.", "text", 0.9),
    ("Raised prices 40% in January. Lost 2 clients out of 14. Revenue up 26%. "
     "I should have done it two years earlier.", "text", 7.2),
    ("Small win: automated our reporting and got 6 hours a week back. "
     "Happy to share the setup if useful.", "text", 2.1),
    ("Every single time I've hired fast I've regretted it. Every single time. "
     "And I keep doing it.", "text", 3.9),
    ("What does everyone charge for a one-off audit? Trying to benchmark.", "text", 1.4),
    ("Client asked for a discount because 'it's just a few hours of work'. "
     "Sent them a breakdown of the 11 years it took to make it a few hours.", "text", 6.1),
    ("Local SEO is still absurdly underpriced relative to what it returns. "
     "Most of my competitors have completely abandoned it for social.", "text", 2.9),
    ("Posting this because I wish someone had told me: your first 20 clients "
     "will come from people who already know you. Not ads. Not content. "
     "Go talk to people you've already met.", "text", 5.2),
    ("Anyone going to the trade show next month? Would be good to meet up.", "text", 0.6),
    ("Cut our ad spend by 60% and revenue stayed flat. Six months of budget "
     "was buying us nothing and I only found out by accident.", "text", 7.9),
    ("Free template: the proposal doc that's closed about £400k for us. "
     "No opt-in, link's in the comments.", "link", 4.8),
    ("How are people handling late payers? Currently chasing 3 invoices "
     "over 60 days and losing patience.", "text", 1.6),
    ("Unpopular: you don't need a niche in year one. You need to talk to enough "
     "people to find out what you're actually good at. The niche finds you.", "text", 4.6),
    ("Rebuilt our site in a weekend after 8 months of a designer 'nearly being done'. "
     "It converts better than the mockups did.", "text", 3.1),
]


def seed_demo_data(user_id=None):
    """Insert the demo set for one account. Returns posts written."""
    rng = random.Random(SEED)
    now = datetime.now(timezone.utc)
    written = 0

    with db.get_db() as conn:
        for source_index, source in enumerate(DEMO_SOURCES):
            source_id = db.upsert_source(
                conn,
                fb_id=source["fb_id"],
                kind=source["kind"],
                name=source["name"],
                url=f"https://facebook.com/groups/{source['fb_id']}",
                member_count=source["member_count"],
                user_id=user_id,
            )

            # Give each group a different baseline so the scoring has to
            # normalise per-source rather than comparing raw counts.
            base_scale = [42, 18, 96][source_index]

            for post_index, (body, post_type, multiplier) in enumerate(DEMO_POSTS):
                author = DEMO_AUTHORS[(post_index + source_index) % len(DEMO_AUTHORS)]
                author_id = db.upsert_author(conn, name=author)

                jitter = rng.uniform(0.75, 1.3)
                likes = int(base_scale * multiplier * jitter)
                comments = int(likes * rng.uniform(0.06, 0.22))
                shares = int(likes * rng.uniform(0.01, 0.09))

                posted = now - timedelta(
                    days=rng.randint(1, 75), hours=rng.randint(0, 23)
                )

                created = db.upsert_post(
                    conn,
                    source_id,
                    author_id,
                    {
                        "fb_post_id": f"{source['fb_id']}-p{post_index}",
                        "body": body,
                        "permalink": f"https://facebook.com/groups/{source['fb_id']}/posts/{post_index}",
                        "post_type": post_type,
                        "posted_at": posted.strftime("%Y-%m-%dT%H:%M:%S"),
                        "likes": likes,
                        "comments": comments,
                        "shares": shares,
                        "video_plays": int(likes * 12) if post_type == "video" else 0,
                        "is_demo": 1,
                    },
                    user_id=user_id,
                )
                if created:
                    written += 1

    return written
