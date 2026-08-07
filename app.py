import os

from flask import Flask, render_template

app = Flask(__name__)

APP_VERSION = "0.1"


def get_mock_dashboard_data():
    return {
        "stat_cards": [
            {"icon": "crown", "label": "Top creator", "value": "Matty McTech", "sub": "13.6M engagement"},
            {"icon": "calendar", "label": "Best day to post", "value": "Sunday", "sub": "3.7K avg per post"},
            {"icon": "play", "label": "Most used format", "value": "Text", "sub": "34% of posts"},
            {"icon": "thumb", "label": "Avg engagement", "value": "2.7K", "sub": "per post across 14K captured"},
            {"icon": "clock", "label": "Best time to post", "value": "Fri 12pm", "sub": "15.1K avg per post"},
            {"icon": "film", "label": "Reels share", "value": "33%", "sub": "4.6K of 14K posts"},
            {"icon": "share", "label": "Share rate", "value": "7.4%", "sub": "of engagement is shares"},
            {"icon": "chart", "label": "Posting cadence", "value": "31.9", "sub": "posts per week"},
            {"icon": "doc", "label": "Longest caption", "value": "11.2K", "sub": "characters"},
        ],
        "engagement_leaders": [
            {"rank": 1, "name": "Matty McTech", "posts": 300, "groups": 0, "engagement": "13.6M", "avg": "45.2K avg"},
            {"rank": 2, "name": "The School Of Hard Knocks", "posts": 277, "groups": 0, "engagement": "4.2M", "avg": "15.3K avg"},
            {"rank": 3, "name": "Alex Hormozi", "posts": "1.1K", "groups": 0, "engagement": "3.8M", "avg": "3.6K avg"},
            {"rank": 4, "name": "Fearless Motivation", "posts": 256, "groups": 0, "engagement": "3.4M", "avg": "13.4K avg"},
            {"rank": 5, "name": "Brainy Monkey", "posts": 319, "groups": 0, "engagement": "2.8M", "avg": "8.8K avg"},
        ],
        "biggest_audience": [
            {"rank": 1, "name": "Anwar Jibawi", "posts": 38, "groups": 0, "followers": "25M"},
            {"rank": 2, "name": "The School Of Hard Knocks", "posts": 277, "groups": 0, "followers": "23M"},
            {"rank": 3, "name": "Prince Ea", "posts": 441, "groups": 0, "followers": "17M"},
            {"rank": 4, "name": "Keenya Kelly", "posts": 457, "groups": 0, "followers": "11M"},
            {"rank": 5, "name": "David Wolfe", "posts": 93, "groups": 0, "followers": "11M"},
        ],
        "content_mix": {
            "total": 13995,
            "segments": [
                {"label": "Reel", "count": 4608, "pct": 33},
                {"label": "Photo", "count": 4367, "pct": 31},
                {"label": "Album", "count": 287, "pct": 2},
                {"label": "Link", "count": 7, "pct": 0},
                {"label": "Text", "count": 4726, "pct": 34},
            ],
        },
        "engagement_composition": {
            "tabs": ["Reel", "Photo", "Album", "Link", "Text"],
            "active": "Reel",
            "count": 4608,
            "total_engagement": "26.9M total engagement",
            "likes_pct": 88,
            "likes": "23.7M",
            "comments": "1.4M",
            "shares": "1.8M",
        },
        "posting_activity": {
            "days": [
                {"day": "Mon", "value": 2390},
                {"day": "Tue", "value": 2438},
                {"day": "Wed", "value": 2095},
                {"day": "Thu", "value": 2036},
                {"day": "Fri", "value": 1819},
                {"day": "Sat", "value": 1604},
                {"day": "Sun", "value": 1613},
            ],
        },
    }


@app.route("/")
@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html", data=get_mock_dashboard_data(), version=APP_VERSION)


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5050)))
