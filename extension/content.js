/* Outlier content script — reads posts already rendered on the page.
 *
 * Facebook generates its class names per build, so nothing here keys off a
 * class. Everything hangs off ARIA roles, aria-labels, and visible text
 * patterns, which change far less often. Even so: THESE SELECTORS WILL DRIFT.
 * When capture goes quiet, the extraction helpers below are what needs a look.
 */

(function () {
  "use strict";

  var SEEN = new Set();     // post ids sent this page-load
  var QUEUE = [];
  var FLUSH_MS = 4000;      // batch rather than firing per post while scrolling
  var enabled = true;

  /* ------------------------------------------------------ number parsing */

  // Facebook renders counts as "1.2K", "3.4M", "1,204", sometimes "1.2 k".
  function parseCount(text) {
    if (!text) return 0;
    var match = String(text).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!match) return 0;

    var value = parseFloat(match[1]);
    if (isNaN(value)) return 0;

    var suffix = (match[2] || "").toUpperCase();
    if (suffix === "K") value *= 1e3;
    else if (suffix === "M") value *= 1e6;
    else if (suffix === "B") value *= 1e9;
    return Math.round(value);
  }

  /* ------------------------------------------------------ source identity */

  function detectSource() {
    var url = location.href;

    var groupMatch = url.match(/\/groups\/([^/?#]+)/);
    if (groupMatch) {
      var heading = document.querySelector('h1 a, [role="banner"] h1, h1');
      return {
        fb_id: "group:" + groupMatch[1],
        kind: "group",
        name: heading ? heading.textContent.trim() : "Facebook group " + groupMatch[1],
        url: location.origin + "/groups/" + groupMatch[1]
      };
    }

    var profileMatch = url.match(/facebook\.com\/([^/?#]+)/);
    if (profileMatch && !["watch", "marketplace", "groups", "home.php"].includes(profileMatch[1])) {
      var title = document.querySelector("h1");
      return {
        fb_id: "profile:" + profileMatch[1],
        kind: "profile",
        name: title ? title.textContent.trim() : profileMatch[1],
        url: location.origin + "/" + profileMatch[1]
      };
    }

    return null;  // feed, watch, marketplace — nothing worth attributing
  }

  /* ------------------------------------------------------ post extraction */

  function extractPermalink(article) {
    var links = article.querySelectorAll('a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"], a[href*="/videos/"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].href;
      if (href && href.indexOf("facebook.com") !== -1) {
        return href.split("?")[0];
      }
    }
    return null;
  }

  function extractPostId(article, permalink) {
    if (permalink) {
      var idMatch = permalink.match(/(?:posts|permalink|videos)\/(\d+)/);
      if (idMatch) return idMatch[1];
      return permalink;
    }
    // No permalink in the DOM (common in group feeds) — fall back to a hash of
    // the author + body so the same post dedupes across scroll passes.
    var body = extractBody(article);
    var author = extractAuthor(article).name;
    if (!body && !author) return null;
    return "h" + hashString(author + "|" + body.slice(0, 180));
  }

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function extractAuthor(article) {
    // The author link sits in the post header — first profile link that isn't
    // a hashtag or a group link.
    var candidates = article.querySelectorAll('h3 a, h4 a, strong a, span a[role="link"]');
    for (var i = 0; i < candidates.length; i++) {
      var text = candidates[i].textContent.trim();
      var href = candidates[i].href || "";
      if (text && text.length < 80 && href.indexOf("/groups/") === -1 && text.indexOf("#") !== 0) {
        return { name: text, url: href.split("?")[0] };
      }
    }
    return { name: "Unknown", url: null };
  }

  function extractBody(article) {
    // Post copy lives in a dir="auto" block; the header and footer use the same
    // attribute, so take the longest block as the body.
    var blocks = article.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    var longest = "";
    for (var i = 0; i < blocks.length; i++) {
      var text = blocks[i].innerText ? blocks[i].innerText.trim() : "";
      if (text.length > longest.length) longest = text;
    }
    return longest.slice(0, 5000);
  }

  function extractEngagement(article) {
    var result = { likes: 0, comments: 0, shares: 0, video_plays: 0 };
    var text = article.innerText || "";

    // Reaction total is usually exposed on the reaction bar's aria-label.
    var reactionEl = article.querySelector('[aria-label*="reaction"], [aria-label*="Reaction"]');
    if (reactionEl) {
      result.likes = parseCount(reactionEl.getAttribute("aria-label"));
    }
    if (!result.likes) {
      // Fallback: the bare number sitting next to the reaction icons.
      var likeMatch = text.match(/(?:^|\n)\s*([\d.,]+[KMB]?)\s*(?:\n|$)/);
      if (likeMatch) result.likes = parseCount(likeMatch[1]);
    }

    var commentMatch = text.match(/([\d.,]+[KMB]?)\s+comments?/i);
    if (commentMatch) result.comments = parseCount(commentMatch[1]);

    var shareMatch = text.match(/([\d.,]+[KMB]?)\s+shares?/i);
    if (shareMatch) result.shares = parseCount(shareMatch[1]);

    var playMatch = text.match(/([\d.,]+[KMB]?)\s+(?:views|plays)/i);
    if (playMatch) result.video_plays = parseCount(playMatch[1]);

    return result;
  }

  function extractPostType(article) {
    var text = (article.innerText || "").toLowerCase();
    if (article.querySelector('a[href*="/reel/"]') || text.indexOf("reel") !== -1) return "reel";
    if (article.querySelector("video")) return "video";

    var images = article.querySelectorAll('img[src*="scontent"]');
    if (images.length > 3) return "album";
    if (images.length > 1) return "photo";

    if (article.querySelector('a[href*="l.facebook.com/l.php"]')) return "link";
    return "text";
  }

  function extractTimestamp(article) {
    // Facebook puts the absolute time in a tooltip/aria-label on the permalink.
    var timeEl = article.querySelector("abbr[data-utime]");
    if (timeEl && timeEl.getAttribute("data-utime")) {
      return new Date(parseInt(timeEl.getAttribute("data-utime"), 10) * 1000)
        .toISOString().slice(0, 19);
    }
    // Relative labels ("3h", "2d") are all that's usually available in-feed.
    var relative = article.querySelector('a[aria-label*="ago"], a[href*="/posts/"] span');
    if (relative) {
      var parsed = parseRelativeTime(relative.textContent.trim());
      if (parsed) return parsed;
    }
    return new Date().toISOString().slice(0, 19);
  }

  function parseRelativeTime(label) {
    var match = label.match(/(\d+)\s*(m|h|d|w|y)\b/i);
    if (!match) return null;

    var amount = parseInt(match[1], 10);
    var unit = match[2].toLowerCase();
    var msPer = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 };
    if (!msPer[unit]) return null;

    return new Date(Date.now() - amount * msPer[unit]).toISOString().slice(0, 19);
  }

  /* ------------------------------------------------------ scan + queue */

  function scanPosts() {
    if (!enabled) return;

    var source = detectSource();
    if (!source) return;

    var articles = document.querySelectorAll('div[role="article"]');
    articles.forEach(function (article) {
      // Comments are also role="article"; real posts are the outer ones.
      if (article.closest('div[role="article"]') !== article) return;

      var permalink = extractPermalink(article);
      var postId = extractPostId(article, permalink);
      if (!postId || SEEN.has(postId)) return;

      var body = extractBody(article);
      if (!body || body.length < 12) return;  // skip chrome and empty shells

      SEEN.add(postId);

      var author = extractAuthor(article);
      var engagement = extractEngagement(article);

      QUEUE.push({
        fb_post_id: source.fb_id + "-" + postId,
        body: body,
        permalink: permalink,
        post_type: extractPostType(article),
        posted_at: extractTimestamp(article),
        author_name: author.name,
        author_url: author.url,
        likes: engagement.likes,
        comments: engagement.comments,
        shares: engagement.shares,
        video_plays: engagement.video_plays
      });
    });
  }

  function flush() {
    if (!QUEUE.length) return;

    var source = detectSource();
    if (!source) { QUEUE = []; return; }

    var batch = QUEUE.splice(0, QUEUE.length);
    chrome.runtime.sendMessage(
      { type: "OUTLIER_CAPTURE", source: source, posts: batch },
      function (response) {
        if (chrome.runtime.lastError) return;  // service worker asleep; retry next flush
        if (response && response.ok) {
          console.log("[Outlier] sent " + batch.length + " posts, " + response.new + " new");
        }
      }
    );
  }

  /* ------------------------------------------------------ wiring */

  chrome.storage.local.get(["enabled"], function (state) {
    enabled = state.enabled !== false;
  });

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
  });

  // Re-scan as new posts render during scroll. Debounced — Facebook mutates
  // the DOM constantly and scanning on every mutation would stall the tab.
  var scanTimer;
  var mutationObserver = new MutationObserver(function () {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPosts, 700);
  });

  mutationObserver.observe(document.body, { childList: true, subtree: true });

  setInterval(flush, FLUSH_MS);
  setTimeout(scanPosts, 1500);
})();
