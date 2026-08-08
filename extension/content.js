/* Outlier content script.
 *
 * Facebook regenerates its class names per build, so nothing here keys off a
 * class — extraction hangs off ARIA roles, aria-labels, and visible text.
 * Those still drift, which is why this ships with an on-page HUD: when capture
 * goes quiet you can see whether the problem is "no posts matched", "matched
 * but no text", or "sent but the dashboard rejected it".
 */

(function () {
  "use strict";

  if (window.__outlierLoaded) return;   // survive SPA re-injection
  window.__outlierLoaded = true;

  var SEEN = new Set();
  var QUEUE = [];
  var enabled = true;
  var autoScrolling = false;
  var scrollTimer = null;
  var idleScrolls = 0;
  var currentSourceId = null;   // resets counters when you move to a new group

  // A scan needs a finish line. Left alone it would scroll until Facebook
  // stops serving posts, which in a large group is effectively forever, and
  // engagement on very old posts is not comparable to recent ones anyway.
  var DEFAULT_MAX_POSTS = 200;
  var DEFAULT_MAX_MINUTES = 10;
  var maxPosts = DEFAULT_MAX_POSTS;
  var maxMinutes = DEFAULT_MAX_MINUTES;
  var scanStartedAt = 0;
  var endpointLabel = null;

  function hostOf(url) {
    try {
      var parsed = new URL(url);
      return parsed.hostname + (parsed.port ? ":" + parsed.port : "");
    } catch (e) {
      return url;
    }
  }

  function blankStats() {
    return {
      articles: 0,     // role="article" nodes on the page
      // Per-scan gauges — what is on screen right now, reset each pass.
      candidates: 0,       // posts visible
      commentsOnPage: 0,   // comments visible
      // Cumulative — counted once per item, after the dedup check.
      skipped: 0,          // rejected as shells / author-name-only
      commentsFound: 0,    // comments actually captured
      usingFallback: false,
      fallbackNoted: false,
      queued: 0,
      sent: 0,
      added: 0,
      withEngagement: 0,   // how many carried a real reaction count
      withMedia: 0,        // how many carried an image or video
      lastError: null,
      done: null,          // why the scan finished, once it has
      log: []
    };
  }

  var STATS = blankStats();

  // Counts belong to one group. Carrying them across a navigation makes it
  // look like posts were captured here that came from somewhere else.
  function resetForSource(source) {
    var id = source ? source.fb_id : null;
    if (id === currentSourceId) return false;

    currentSourceId = id;
    SEEN = new Set();
    QUEUE = [];
    STATS = blankStats();
    if (source) logLine("— " + source.name.slice(0, 30) + " —");
    return true;
  }

  function logLine(text) {
    STATS.log.unshift(new Date().toLocaleTimeString().slice(0, 8) + "  " + text);
    if (STATS.log.length > 40) STATS.log.pop();
  }

  /* ------------------------------------------------------ number parsing */

  // No Facebook group post realistically clears this. A number above it came
  // from something that isn't a reaction count — a follower total, an id, a
  // year range — and one such value wrecks a group's median for every post
  // scored against it.
  var MAX_PLAUSIBLE_COUNT = 20000000;

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

    value = Math.round(value);
    return value > MAX_PLAUSIBLE_COUNT ? 0 : value;
  }

  /* ------------------------------------------------------ source identity */

  // Facebook renders several <h1>s (nav landmarks like "Notifications" among
  // them), so reading the first one names every group the same thing. The
  // document title is the reliable source: "Frequency Healing | Facebook".
  function nameFromTitle(fallback) {
    var title = (document.title || "")
      // Unread badge: "(9) Neil deGrasse Tyson" — otherwise the same group
      // saves under a different name every time the count changes.
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*\|\s*Facebook\s*$/i, "")
      .trim();

    // A pipe still present means Facebook appended a post preview
    // ("Neil deGrasse Tyson | How do you feel about…"). Keep the group.
    if (title.indexOf("|") !== -1) title = title.split("|")[0].trim();

    // Facebook often still shows the previous page's title for a moment after
    // an in-app navigation, so a landing-page name here is stale, not real.
    var junk = ["", "Facebook", "Notifications", "Home", "Watch", "Marketplace",
                "Groups", "Feed", "Your Groups", "Groups Feed"];
    if (title && junk.indexOf(title) === -1) return title.slice(0, 120);
    return fallback;
  }

  function detectSource() {
    var url = location.href;

    var groupMatch = url.match(/\/groups\/([^/?#]+)/);
    if (groupMatch && groupMatch[1] !== "feed") {
      var slug = groupMatch[1];
      var name = nameFromTitle(null);

      // Second try: the group's own header link back to itself carries its name.
      if (!name) {
        var selfLink = document.querySelector('a[href*="/groups/' + slug + '"]');
        if (selfLink) {
          var text = (selfLink.textContent || "").trim();
          if (text && text.length < 120) name = text;
        }
      }

      return {
        fb_id: "group:" + slug,
        kind: "group",
        name: name || ("Facebook group " + slug),
        url: location.origin + "/groups/" + slug
      };
    }

    var reserved = ["watch", "marketplace", "groups", "home.php", "gaming",
                    "events", "notifications", "messages", "profile.php", ""];
    var profileMatch = url.match(/facebook\.com\/([^/?#]*)/);
    if (profileMatch && reserved.indexOf(profileMatch[1]) === -1) {
      return {
        fb_id: "profile:" + profileMatch[1],
        kind: "profile",
        name: nameFromTitle(profileMatch[1]),
        url: location.origin + "/" + profileMatch[1]
      };
    }

    return null;
  }

  /* ------------------------------------------------------ post extraction */

  function extractPermalink(article) {
    var links = article.querySelectorAll(
      'a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"], ' +
      'a[href*="/videos/"], a[href*="/reel/"]'
    );
    for (var i = 0; i < links.length; i++) {
      if (links[i].href && links[i].href.indexOf("facebook.com") !== -1) {
        return links[i].href.split("?")[0];
      }
    }
    return null;
  }

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function extractPostId(article, permalink, body, author) {
    if (permalink) {
      var idMatch = permalink.match(/(?:posts|permalink|videos|reel)\/(\d+)/);
      if (idMatch) return idMatch[1];
      return permalink;
    }
    // Group feeds frequently render without a permalink until hover, so fall
    // back to hashing author+body — stable enough to dedupe across scrolls.
    if (!body && !author) return null;
    return "h" + hashString(author + "|" + body.slice(0, 200));
  }

  // Names that are chrome, not people.
  var NOT_A_NAME = /^(like|comment|share|reply|see more|follow|join|group|admin|moderator|top contributor|author|·|\d+[hdwmy]|anonymous participant)$/i;

  function extractAuthor(article, bar) {
    // The author link lives in the post header, above the action bar. Casting
    // wider than that picks up commenters, tagged users, and link previews —
    // which is how posts ended up attributed to "Unknown" or to a commenter.
    var candidates = article.querySelectorAll(
      'h2 a[role="link"], h3 a[role="link"], h4 a[role="link"], ' +
      'h2 a, h3 a, h4 a, strong a, a[role="link"] strong, ' +
      'span a[role="link"], a[role="link"]'
    );

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (isBelowBar(el, bar)) continue;
      if (el.closest('div[role="article"]') !== article) continue;

      var text = (el.textContent || "").trim().replace(/\s+/g, " ");
      var anchor = el.tagName === "A" ? el : el.closest("a");
      var href = (anchor && anchor.href) || "";

      if (!text || text.length < 2 || text.length > 80) continue;
      if (NOT_A_NAME.test(text)) continue;
      if (text.charAt(0) === "#") continue;
      // A link into the group itself is the group name, not a person.
      if (href.indexOf("/groups/") !== -1 && href.indexOf("/user/") === -1) continue;
      // Reject anything that is plainly a timestamp or a bare number.
      if (/^\d[\d.,:\s]*$/.test(text)) continue;

      return { name: text, url: href ? href.split("?")[0] : null };
    }

    // Fallback: a profile URL in the header still identifies the author even
    // when the visible name is rendered in a way the selectors miss.
    var profile = article.querySelector(
      'a[href*="/user/"], a[href*="profile.php"], a[href*="facebook.com/"][role="link"]'
    );
    if (profile && !isBelowBar(profile, bar)) {
      var slug = (profile.href || "").split("?")[0].replace(/\/$/, "").split("/").pop();
      if (slug && !/^\d+$/.test(slug) && slug !== "groups") {
        return { name: slug.replace(/[._-]/g, " "), url: profile.href.split("?")[0] };
      }
    }

    return { name: "Unknown", url: null };
  }

  var CHROME_RE = /^(like|comment|share|reply|see more|see less|all reactions|most relevant|top comments|newest|write a comment|view more comments|\d+\s*(comments?|shares?|likes?|reactions?)|·|\d+[hdwmy])$/i;

  /* The post/comment boundary.
   *
   * Facebook gives comments role="article" too, and does not reliably nest
   * them inside the post's own article — so "exclude nested articles" let
   * every comment through as a post. Worse, a comment is often longer than
   * the caption, so picking the longest text block returned the comment even
   * for posts that were correctly identified.
   *
   * Two structural facts fix both: a post offers Share (a comment offers
   * Reply), and everything belonging to the post sits ABOVE the Like/Comment/
   * Share bar while comments sit below it.
   */

  function findActionBar(article) {
    var candidates = article.querySelectorAll('[role="button"], [aria-label]');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var label = (el.getAttribute("aria-label") || "").trim();
      var text = (el.textContent || "").trim();
      if (/^(like|comment|share)$/i.test(text)) return el;
      if (/^(like|comment|share|leave a comment|send this to friends)/i.test(label)) return el;
    }
    return null;
  }

  // True when `el` sits after the action bar — i.e. in the comments.
  function isBelowBar(el, bar) {
    if (!bar || !el) return false;
    return !!(bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // Which post a comment belongs to. Nested comments have the post as an
  // ancestor; siblings are matched to the nearest preceding post instead.
  function parentPostId(article, source) {
    var owner = article.parentElement &&
                article.parentElement.closest('div[role="article"]');
    if (owner && looksLikePost(owner)) {
      var link = extractPermalink(owner);
      var id = extractPostId(owner, link, extractBody(owner, "", findActionBar(owner)), "");
      return id ? source.fb_id + "-" + id : null;
    }

    var all = Array.prototype.slice.call(document.querySelectorAll('div[role="article"]'));
    var index = all.indexOf(article);
    for (var i = index - 1; i >= 0; i--) {
      if (looksLikePost(all[i])) {
        var pl = extractPermalink(all[i]);
        var pid = extractPostId(all[i], pl, extractBody(all[i], "", findActionBar(all[i])), "");
        return pid ? source.fb_id + "-" + pid : null;
      }
    }
    return null;
  }

  // Elements belonging to THIS article, excluding anything owned by a nested
  // article. querySelector searches all descendants, and a post contains its
  // own comments — so an unscoped lookup finds the comments' Reply buttons
  // and concludes the post is a comment.
  function ownQuery(article, selector) {
    var found = article.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) {
      if (found[i].closest('div[role="article"]') === article) return found[i];
    }
    return null;
  }

  /* Post vs comment.
   *
   * A previous version gated on a single signal — Reply present and Share
   * absent meant comment — which rejected every post the moment Share
   * detection missed, and Share detection misses often because that button's
   * label varies. Signals are weighed instead, so no single miss can zero out
   * a whole scan.
   */
  function classify(article) {
    var score = 0;
    var reasons = [];

    // Facebook labels comment containers explicitly. Strongest signal there is.
    var ownLabel = article.getAttribute("aria-label") || "";
    if (/^comment by/i.test(ownLabel) || /^reply by/i.test(ownLabel)) {
      return { isPost: false, confident: true, why: "aria-label says comment" };
    }

    // Nested inside another article: a comment, or a shared-post preview.
    if (article.parentElement && article.parentElement.closest('div[role="article"]')) {
      return { isPost: false, confident: true, why: "nested in another article" };
    }

    // Feed items carry positional metadata; comments do not.
    if (article.hasAttribute("aria-posinset")) { score += 3; reasons.push("posinset"); }

    // A permalink to a post is definitional.
    var link = extractPermalink(article);
    if (link && /\/(posts|permalink|videos|reel)\//.test(link)) {
      score += 3; reasons.push("permalink");
    }

    // Share belongs to posts — but only this article's own Share button.
    if (ownQuery(article, '[aria-label*="Send this to friends" i], [aria-label*="Share" i]')) {
      score += 2; reasons.push("share");
    }

    // Reply belongs to comments — again, only its own.
    if (ownQuery(article, '[aria-label*="Reply" i]')) { score -= 2; reasons.push("reply"); }

    // Posts show a share/comment tally; comments almost never do.
    if (ownQuery(article, '[aria-label*="shares" i], [aria-label*="comments" i]')) {
      score += 1; reasons.push("tally");
    }

    return {
      isPost: score >= 2,
      confident: score >= 3 || score <= -1,
      why: reasons.join("+") || "no signals"
    };
  }

  function looksLikePost(article) {
    return classify(article).isPost;
  }

  function extractBody(article, authorName, bar) {
    // The caption is the longest text block ABOVE the action bar. Without the
    // cutoff a long comment beats a short caption — which is how "that's
    // funny, flat earthers will think this is a real picture" got saved as
    // the body of a post captioned "Artemis 2 captures its first views".
    var blocks = article.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    var best = "";

    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (isBelowBar(el, bar)) continue;          // comments live below it

      var text = el.innerText ? el.innerText.trim() : "";
      if (!text || text.length <= best.length) continue;
      if (CHROME_RE.test(text)) continue;

      // The header block is just the author's name, sometimes with a timestamp.
      if (authorName && text.replace(/\s+/g, " ") === authorName) continue;
      if (authorName && text.indexOf(authorName) === 0 && text.length < authorName.length + 25) continue;

      // A block whose text is entirely a link is navigation, not post copy.
      var link = el.querySelector('a[role="link"]');
      if (link && (link.innerText || "").trim().length >= text.length - 2) continue;

      // Belt and braces: anything owned by a different article isn't ours.
      if (el.closest('div[role="article"]') !== article) continue;

      best = text;
    }
    return best.slice(0, 5000);
  }

  function extractEngagement(article, bar) {
    var result = { likes: 0, comments: 0, shares: 0, video_plays: 0 };

    // Facebook splits counts across text nodes and aria-labels inconsistently
    // between layouts, and often puts the number in an aria-label while the
    // visible text shows only an icon. Searching one combined haystack of
    // every aria-label plus the visible text catches all of those variants —
    // matching only innerText is why real captures came back as zeros.
    //
    // The haystack stops at the action bar. Below it are per-comment reaction
    // counts, and reading those gave posts their top comment's numbers.
    var labels = [];
    var labelled = article.querySelectorAll("[aria-label]");
    for (var i = 0; i < labelled.length; i++) {
      var el = labelled[i];
      if (el.closest('div[role="article"]') !== article) continue;
      if (isBelowBar(el, bar)) continue;
      labels.push(el.getAttribute("aria-label"));
    }

    var visible = article.innerText || "";
    if (bar) {
      // Trim visible text at the action bar too, using the bar's own label as
      // the split point.
      var barText = (bar.textContent || "").trim();
      if (barText) {
        var cut = visible.indexOf(barText);
        if (cut > 0) visible = visible.slice(0, cut);
      }
    }
    var haystack = labels.join("\n") + "\n" + visible;

    function firstMatch(patterns) {
      for (var p = 0; p < patterns.length; p++) {
        var m = haystack.match(patterns[p]);
        if (m) {
          var n = parseCount(m[1]);
          if (n) return n;
        }
      }
      return 0;
    }

    result.likes = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s*(?:people\s+)?reacted/i,
      /(?:Like|reaction)s?:?\s*([\d][\d.,]*\s*[KMB]?)/i,
      /([\d][\d.,]*\s*[KMB]?)\s+reactions?/i,
      /See who reacted[^\d]*([\d][\d.,]*\s*[KMB]?)/i,
      /([\d][\d.,]*\s*[KMB]?)\s+likes?\b/i,
      // Facebook also renders the summary as a list of reaction names
      // followed by a total: "Like, Love and 47 others".
      /and\s+([\d][\d.,]*\s*[KMB]?)\s+others?/i,
      /([\d][\d.,]*\s*[KMB]?)\s+others?\s+reacted/i,
      // Some locales/layouts label the whole row rather than the count.
      /All reactions:?\s*([\d][\d.,]*\s*[KMB]?)/i
    ]);

    result.comments = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s+comments?/i,
      /comments?:?\s*([\d][\d.,]*\s*[KMB]?)/i
    ]);

    result.shares = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s+shares?/i,
      /shares?:?\s*([\d][\d.,]*\s*[KMB]?)/i
    ]);

    result.video_plays = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s+(?:views|plays)/i
    ]);

    // Structural fallback, used when every label pattern misses.
    //
    // Facebook's summary row sits immediately above the action bar and holds
    // the reaction total as bare text next to icons. Walking backwards from
    // the bar finds it without depending on any wording, which is what makes
    // this survive the layout and locale changes that break the patterns.
    if (!result.likes && bar) {
      var row = bar.parentElement;
      for (var hop = 0; hop < 4 && row; hop++) {
        var previous = row.previousElementSibling;
        while (previous) {
          var text = (previous.innerText || "").trim();
          // A summary row is short and mostly digits; post copy is not.
          if (text && text.length < 60 && /\d/.test(text)) {
            var candidate = parseCount(text.split(/\s+/)[0]);
            if (candidate) { result.likes = candidate; break; }
          }
          previous = previous.previousElementSibling;
        }
        if (result.likes) break;
        row = row.parentElement;
      }
    }

    // Same idea for the comment tally, which usually sits beside the
    // reaction count rather than carrying its own label.
    if (!result.comments) {
      var counts = (visible.match(/\b\d[\d.,]*\s*[KMB]?\b/g) || [])
        .map(parseCount).filter(function (n) { return n > 0; });
      if (counts.length >= 2 && result.likes) {
        // Anything smaller than the reaction total on the same row is a
        // plausible comment count; the largest such value is the best guess.
        var below = counts.filter(function (n) { return n < result.likes; });
        if (below.length) result.comments = Math.max.apply(null, below);
      }
    }

    return result;
  }

  /* Visual content.
   *
   * What a post looked like is half of why it worked, so the image is stored
   * alongside the copy. Facebook serves post media from its CDN with a
   * distinctive host, which separates real content from avatars, emoji
   * sprites and UI chrome — those come from other paths and are tiny.
   */
  var MIN_MEDIA_PX = 130;

  function extractMedia(article, bar) {
    var images = article.querySelectorAll("img");
    var found = [];

    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (isBelowBar(img, bar)) continue;                       // comment media
      if (img.closest('div[role="article"]') !== article) continue;

      var src = img.currentSrc || img.src || "";
      if (!src || src.indexOf("data:") === 0) continue;
      if (!/scontent|fbcdn/i.test(src)) continue;               // not post media

      // Profile pictures live on the same CDN, so size is what separates a
      // post image from the author's avatar.
      var width = img.naturalWidth || img.width || 0;
      var height = img.naturalHeight || img.height || 0;
      if (width && width < MIN_MEDIA_PX) continue;
      if (height && height < MIN_MEDIA_PX) continue;

      var label = (img.getAttribute("alt") || "").toLowerCase();
      if (/profile picture|avatar/.test(label)) continue;

      found.push({ src: src, area: (width || 0) * (height || 0) });
    }

    // Largest first: on an album the biggest render is the one on display.
    found.sort(function (a, b) { return b.area - a.area; });

    var video = article.querySelector("video");
    var hasVideo = !!(video && !isBelowBar(video, bar)) ||
                   !!ownQuery(article, 'a[href*="/reel/"], a[href*="/videos/"]');

    return {
      image_url: found.length ? found[0].src : null,
      image_count: found.length,
      has_video: hasVideo
    };
  }

  function extractPostType(article) {
    if (article.querySelector('a[href*="/reel/"]')) return "reel";
    if (article.querySelector("video")) return "video";

    var images = article.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]');
    if (images.length > 4) return "album";
    if (images.length > 1) return "photo";
    if (article.querySelector('a[href*="l.facebook.com/l.php"]')) return "link";
    return "text";
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

  function extractTimestamp(article) {
    var abbr = article.querySelector("abbr[data-utime]");
    if (abbr && abbr.getAttribute("data-utime")) {
      return new Date(parseInt(abbr.getAttribute("data-utime"), 10) * 1000)
        .toISOString().slice(0, 19);
    }
    var links = article.querySelectorAll('a[aria-label], a[href*="/posts/"]');
    for (var i = 0; i < links.length; i++) {
      var label = links[i].getAttribute("aria-label") || links[i].textContent || "";
      var parsed = parseRelativeTime(label.trim());
      if (parsed) return parsed;
    }
    return new Date().toISOString().slice(0, 19);
  }

  /* ------------------------------------------------------ scan */

  function scanPosts() {
    if (!enabled) return 0;

    var source = detectSource();
    if (!source) {
      STATS.lastError = "Not on a group or profile page";
      renderHud();
      return 0;
    }

    // Facebook is a single-page app, so moving between groups never reloads
    // this script — the switch has to be noticed here.
    if (resetForSource(source) && autoScrolling) {
      stopAutoScroll("Moved to a new group — counters reset");
    }

    var articles = document.querySelectorAll('div[role="article"]');
    STATS.articles = articles.length;

    // Classify everything first. If not a single article scores as a post
    // while plenty exist, the signals have drifted rather than the page being
    // pure comments — fall back to "top-level article = post" so a scan
    // degrades instead of silently returning nothing.
    var verdicts = [];
    var postCount = 0;
    for (var v = 0; v < articles.length; v++) {
      var verdict = classify(articles[v]);
      verdicts.push(verdict);
      if (verdict.isPost) postCount++;
    }

    var fallback = false;
    if (postCount === 0 && articles.length >= 3) {
      fallback = true;
      for (var f = 0; f < articles.length; f++) {
        // Keep the confident comment verdicts; promote only the ambiguous.
        if (!verdicts[f].confident) verdicts[f] = { isPost: true, why: "fallback" };
      }
      if (!STATS.fallbackNoted) {
        STATS.fallbackNoted = true;
        logLine("⚠ post signals missing — treating top-level items as posts");
      }
    }
    STATS.usingFallback = fallback;

    var found = 0;
    STATS.candidates = 0;
    STATS.commentsOnPage = 0;

    articles.forEach(function (article, articleIndex) {
      // Comments carry role="article" as well, and are not reliably nested
      // inside the post — so this has to be a positive test for post-ness,
      // not merely a nesting check. Comments are still captured, just tagged
      // and scored against other comments rather than against posts.
      var isPost = verdicts[articleIndex].isPost;

      // Per-scan gauges: what is on screen right now. Reset every pass.
      if (isPost) STATS.candidates++;
      else STATS.commentsOnPage++;

      var bar = findActionBar(article);
      var author = extractAuthor(article, bar);
      var body = extractBody(article, author.name, bar);
      var permalink = extractPermalink(article);
      var postId = extractPostId(article, permalink, body, author.name);

      // Everything past this point counts only ONCE per item. Counting before
      // the dedup check meant the passive re-scan — which fires roughly every
      // 800ms because Facebook mutates constantly — re-counted the same
      // comments on every pass. Sitting still on one screen climbed past 300.
      if (!postId || SEEN.has(postId)) return;

      // Reject shells: no text, or "text" that is just the author's name
      // echoed out of the header.
      if (!body || body.length < 12) { STATS.skipped++; return; }
      if (body.replace(/\s+/g, " ") === author.name) { STATS.skipped++; return; }

      SEEN.add(postId);
      if (!isPost) STATS.commentsFound++;
      found++;

      var engagement = extractEngagement(article, bar);
      var media = extractMedia(article, bar);
      if (engagement.likes || engagement.comments || engagement.shares) {
        STATS.withEngagement++;
      }
      if (media.image_url || media.has_video) STATS.withMedia++;
      logLine((isPost ? "" : "↳ ") + engagement.likes + "r " +
              engagement.comments + "c " + engagement.shares + "s  " +
              body.slice(0, 30));

      QUEUE.push({
        fb_post_id: source.fb_id + "-" + postId,
        body: body,
        permalink: permalink,
        post_type: isPost ? extractPostType(article) : "comment",
        posted_at: extractTimestamp(article),
        author_name: author.name,
        author_url: author.url,
        likes: engagement.likes,
        comments: engagement.comments,
        shares: engagement.shares,
        video_plays: engagement.video_plays,
        item_type: isPost ? "post" : "comment",
        parent_fb_id: isPost ? null : parentPostId(article, source),
        image_url: media.image_url,
        image_count: media.image_count,
        has_video: media.has_video
      });
    });

    STATS.queued = QUEUE.length;
    renderHud();
    return found;
  }

  function flush() {
    if (!QUEUE.length) return;

    var source = detectSource();
    if (!source) { QUEUE = []; return; }

    var batch = QUEUE.splice(0, QUEUE.length);
    STATS.queued = 0;

    if (!contextAlive()) {
      QUEUE = batch.concat(QUEUE);
      handleOrphaned();
      return;
    }

    chrome.runtime.sendMessage(
      { type: "OUTLIER_CAPTURE", source: source, posts: batch },
      function (response) {
        if (chrome.runtime.lastError) {
          STATS.lastError = "Extension worker asleep — retrying";
          QUEUE = batch.concat(QUEUE);   // don't lose the batch
          renderHud();
          return;
        }
        if (!response || !response.ok) {
          STATS.lastError = (response && response.error) || "Dashboard rejected the batch";
          QUEUE = batch.concat(QUEUE);
          renderHud();
          return;
        }
        STATS.sent += batch.length;
        STATS.added += response.new || 0;
        STATS.lastError = null;
        logLine("→ sent " + batch.length + ", " + (response.new || 0) + " new");
        renderHud();
      }
    );
  }

  /* ------------------------------------------------------ auto-scroll */

  // When the extension reloads (self-update), scripts already injected into
  // open tabs are orphaned — chrome.runtime.id goes undefined and every API
  // call throws. Without this the HUD just silently stops working.
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function handleOrphaned() {
    stopAutoScroll(null);
    if (!hud) return;
    STATS.lastError = "Extension updated. Reload this page to continue.";
    renderHud();

    if (hudBtn) {
      hudBtn.textContent = "Reload page";
      hudBtn.style.background = "linear-gradient(135deg, #d9b45f, #b8933f)";
      hudBtn.style.color = "#1a1305";
      hudBtn.onclick = function () { window.location.reload(); };
    }
  }

  function startAutoScroll() {
    if (autoScrolling) return;
    if (!contextAlive()) { handleOrphaned(); return; }

    autoScrolling = true;
    idleScrolls = 0;
    scanStartedAt = Date.now();
    STATS.lastError = null;
    STATS.done = null;
    // Tells the service worker not to self-update mid-capture.
    try { chrome.storage.local.set({ capturing: true }); } catch (e) {}
    renderHud();

    scrollTimer = setInterval(function () {
      var before = window.scrollY;
      window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: "smooth" });

      // Give Facebook a beat to render, then scan what appeared.
      setTimeout(function () {
        var found = scanPosts();
        flush();

        // Three ways a scan ends, all of them deliberate.
        if (SEEN.size >= maxPosts) {
          stopAutoScroll(null, "Target reached — " + SEEN.size + " posts");
          return;
        }

        var minutes = (Date.now() - scanStartedAt) / 60000;
        if (minutes >= maxMinutes) {
          stopAutoScroll(null, "Time limit — " + SEEN.size + " posts in " +
                               Math.round(minutes) + " min");
          return;
        }

        // Bottom of the feed: scroll position stopped moving and nothing new
        // came in. Facebook lazy-loads, so allow several idle passes first.
        if (window.scrollY <= before + 8 && found === 0) {
          idleScrolls++;
          if (idleScrolls >= 6) {
            stopAutoScroll(null, "Reached the end — " + SEEN.size + " posts");
          }
        } else {
          idleScrolls = 0;
        }
      }, 1100);
    }, 2200);
  }

  function stopAutoScroll(reason, done) {
    autoScrolling = false;
    clearInterval(scrollTimer);
    scrollTimer = null;
    if (reason) STATS.lastError = reason;
    if (done) {
      STATS.done = done;
      logLine("✓ " + done);
    }
    try { chrome.storage.local.set({ capturing: false }); } catch (e) {}
    if (contextAlive()) flush();
    renderHud();
  }

  /* ------------------------------------------------------ diagnostics */

  /* Facebook's markup differs by account, locale and A/B bucket, so an
   * extractor that works on one feed can return zeros on another. This dumps
   * exactly what each strategy saw for the posts currently on screen, so a
   * failure can be diagnosed from the report instead of guessed at.
   *
   * Post text is truncated and no identifiers are included — the useful part
   * is the shape of the markup, not the content.
   */
  function diagnose() {
    var source = detectSource();
    var articles = document.querySelectorAll('div[role="article"]');
    var lines = [];

    lines.push("OUTLIER DIAGNOSTIC");
    lines.push("page: " + (source ? source.kind + " / " + source.name.slice(0, 40)
                                  : "unsupported"));
    lines.push("articles on page: " + articles.length);
    lines.push("");

    var limit = Math.min(articles.length, 4);
    for (var i = 0; i < limit; i++) {
      var article = articles[i];
      var verdict = classify(article);
      var bar = findActionBar(article);
      var author = extractAuthor(article, bar);
      var body = extractBody(article, author.name, bar);
      var engagement = extractEngagement(article, bar);
      var media = extractMedia(article, bar);

      lines.push("--- item " + (i + 1) + " ---");
      lines.push("verdict     : " + (verdict.isPost ? "POST" : "comment") +
                 "  (" + verdict.why + ")");
      lines.push("action bar  : " + (bar ? "found <" + bar.tagName.toLowerCase() +
                 " aria-label=\"" + (bar.getAttribute("aria-label") || "") + "\">"
                 : "NOT FOUND"));
      lines.push("author      : " + author.name);
      lines.push("body chars  : " + body.length + "  " +
                 JSON.stringify(body.slice(0, 60)));
      lines.push("engagement  : " + engagement.likes + "r " + engagement.comments +
                 "c " + engagement.shares + "s " + engagement.video_plays + "v");
      lines.push("media       : " + (media.image_url ? media.image_count + " image(s)"
                 : "none") + (media.has_video ? " + video" : ""));

      // The aria-labels are what the count patterns actually match against,
      // so when engagement reads zero this is the part that explains why.
      var labels = [];
      var labelled = article.querySelectorAll("[aria-label]");
      for (var j = 0; j < labelled.length && labels.length < 12; j++) {
        if (labelled[j].closest('div[role="article"]') !== article) continue;
        var label = labelled[j].getAttribute("aria-label");
        if (label && label.length < 70) labels.push(label);
      }
      lines.push("aria-labels : " + (labels.length ? JSON.stringify(labels) : "none"));

      if (!engagement.likes) {
        // Whatever sits just above the action bar is where the count should be.
        var nearBar = bar && bar.parentElement
          ? (bar.parentElement.innerText || "").trim().slice(0, 120)
          : "(no bar)";
        lines.push("text at bar : " + JSON.stringify(nearBar));
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /* ------------------------------------------------------ HUD */

  var hud, hudBody, hudBtn;

  function styleEl(el, styles) {
    // Assigning style properties directly rather than injecting a <style> tag,
    // because Facebook's CSP blocks stylesheet injection from content scripts.
    Object.keys(styles).forEach(function (key) { el.style[key] = styles[key]; });
  }

  var hudLog, hudEndpoint;

  var HUD_MIN_W = 300;
  var HUD_MIN_H = 240;

  /* Anchored by top/left, not bottom/right.
   *
   * CSS `resize` always grows an element down and to the right from its
   * top-left corner. Anchored by bottom/right instead, the corner you drag is
   * the one that's pinned — so the grip stays put while the opposite edge
   * moves, and the panel appears to resize backwards. Pinning top/left makes
   * the drag follow the cursor, which is the whole point of a resize grip.
   */
  function loadHudBox() {
    var defaults = function () {
      return {
        width: 380,
        height: 460,
        left: Math.max(8, window.innerWidth - 380 - 20),
        top: Math.max(8, window.innerHeight - 460 - 20)
      };
    };

    try {
      var saved = JSON.parse(localStorage.getItem("outlierHud") || "{}");
      if (saved.left === undefined || saved.top === undefined) {
        // Either nothing saved, or a box stored under the old bottom/right
        // scheme. Convert rather than restoring a position that now means
        // something different.
        var box = defaults();
        if (saved.width) box.width = saved.width;
        if (saved.height) box.height = saved.height;
        if (saved.right !== undefined) {
          box.left = window.innerWidth - box.width - saved.right;
        }
        if (saved.bottom !== undefined) {
          box.top = window.innerHeight - box.height - saved.bottom;
        }
        return clampHudBox(box);
      }
      return clampHudBox({
        width: saved.width || 380,
        height: saved.height || 460,
        left: saved.left,
        top: saved.top
      });
    } catch (e) {
      return defaults();
    }
  }

  // Keep the panel on screen. A saved position from a larger monitor, or a
  // window that has since been narrowed, would otherwise place it out of view
  // with no way to drag it back.
  function clampHudBox(box) {
    box.width = Math.max(HUD_MIN_W, Math.min(box.width, window.innerWidth - 16));
    box.height = Math.max(HUD_MIN_H, Math.min(box.height, window.innerHeight - 16));
    box.left = Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8));
    box.top = Math.max(8, Math.min(box.top, window.innerHeight - box.height - 8));
    return box;
  }

  function saveHudBox() {
    try {
      var rect = hud.getBoundingClientRect();
      localStorage.setItem("outlierHud", JSON.stringify({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }));
    } catch (e) { /* private mode — position just won't persist */ }
  }

  function buildHud() {
    var box = loadHudBox();

    hud = document.createElement("div");
    styleEl(hud, {
      position: "fixed",
      top: box.top + "px", left: box.left + "px",
      width: box.width + "px", height: box.height + "px",
      minWidth: HUD_MIN_W + "px", minHeight: HUD_MIN_H + "px",
      // Never let the panel exceed the viewport in either axis.
      maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)",
      zIndex: "2147483647",
      display: "flex", flexDirection: "column",
      padding: "0", borderRadius: "14px", overflow: "hidden",
      background: "rgba(7, 20, 13, 0.97)",
      border: "1px solid rgba(110,231,183,0.32)",
      boxShadow: "0 16px 48px rgba(0,0,0,0.6)", color: "#eafff3",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "13px", lineHeight: "1.5",
      resize: "both"   // native corner grip
    });

    /* --- draggable header --- */
    var header = document.createElement("div");
    styleEl(header, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0.9em 1.1em", cursor: "move", flexShrink: "0",
      background: "rgba(16,40,27,0.75)",
      borderBottom: "1px solid rgba(110,231,183,0.18)"
    });

    var title = document.createElement("span");
    title.textContent = "Outlier";
    styleEl(title, { fontWeight: "700", fontSize: "1.2em", letterSpacing: "-0.2px" });

    var controls = document.createElement("span");
    styleEl(controls, { display: "flex", gap: "0.9em", alignItems: "center" });

    var collapse = document.createElement("span");
    collapse.textContent = "–";
    collapse.title = "Collapse";
    styleEl(collapse, { cursor: "pointer", opacity: "0.6", fontSize: "1.5em", lineHeight: "1" });

    var close = document.createElement("span");
    close.textContent = "×";
    close.title = "Hide until reload";
    styleEl(close, { cursor: "pointer", opacity: "0.6", fontSize: "1.5em", lineHeight: "1" });
    close.addEventListener("click", function () { hud.style.display = "none"; });

    controls.appendChild(collapse);
    controls.appendChild(close);
    header.appendChild(title);
    header.appendChild(controls);

    var content = document.createElement("div");
    styleEl(content, {
      display: "flex", flexDirection: "column", flex: "1",
      padding: "1em 1.1em", overflow: "hidden", minHeight: "0"
    });

    var expandedHeight = box.height;
    collapse.addEventListener("click", function () {
      var hidden = content.style.display === "none";
      if (!hidden) expandedHeight = hud.getBoundingClientRect().height;
      content.style.display = hidden ? "flex" : "none";
      hud.style.height = hidden ? expandedHeight + "px" : "auto";
      collapse.textContent = hidden ? "–" : "+";
    });

    // Drag by the header. Position is kept in right/bottom so the panel stays
    // anchored the same way it was authored.
    var dragging = false, startX, startY, startLeft, startTop;
    header.addEventListener("mousedown", function (event) {
      if (event.target === close || event.target === collapse) return;
      dragging = true;
      startX = event.clientX; startY = event.clientY;
      var rect = hud.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      event.preventDefault();
    });
    document.addEventListener("mousemove", function (event) {
      if (!dragging) return;
      var rect = hud.getBoundingClientRect();
      var maxLeft = window.innerWidth - rect.width - 8;
      var maxTop = window.innerHeight - rect.height - 8;
      hud.style.left =
        Math.max(8, Math.min(startLeft + (event.clientX - startX), maxLeft)) + "px";
      hud.style.top =
        Math.max(8, Math.min(startTop + (event.clientY - startY), maxTop)) + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      saveHudBox();
    });
    // Resizing was only ever making the box bigger, not the text — which
    // defeats the point of resizing it. Everything inside is sized in em, so
    // scaling the root font-size scales the whole panel together.
    function rescale() {
      var rect = hud.getBoundingClientRect();
      // Scaling on width alone made the text grow when dragged wider, which
      // pushed the buttons past the bottom edge. Take whichever axis grew
      // least so the contents always still fit vertically.
      var scale = Math.min((rect.width || 380) / 380, (rect.height || 460) / 460);
      scale = Math.max(0.85, Math.min(scale, 2.1));
      hud.style.fontSize = (13 * scale).toFixed(2) + "px";
    }

    new ResizeObserver(function () {
      rescale();
      saveHudBox();
    }).observe(hud);
    rescale();

    /* --- stat rows --- */
    hudBody = document.createElement("div");
    styleEl(hudBody, { flexShrink: "0" });

    /* --- live log --- */
    var logLabel = document.createElement("div");
    logLabel.textContent = "Recent posts (reactions / comments / shares)";
    styleEl(logLabel, {
      fontSize: "0.85em", color: "#567a67", margin: "0.9em 0 0.45em", flexShrink: "0"
    });

    hudLog = document.createElement("div");
    styleEl(hudLog, {
      flex: "1", minHeight: "60px", overflowY: "auto",
      padding: "0.6em 0.75em", borderRadius: "9px",
      background: "rgba(4,14,9,0.7)", border: "1px solid rgba(110,231,183,0.14)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "0.84em", lineHeight: "1.65", color: "#7fa693",
      whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      scrollbarWidth: "thin"
    });

    /* --- buttons --- */
    hudBtn = document.createElement("button");
    styleEl(hudBtn, {
      width: "100%", marginTop: "0.9em", padding: "0.8em", borderRadius: "9px",
      border: "none", cursor: "pointer", fontWeight: "700", fontSize: "1.05em",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      flexShrink: "0"
    });
    hudBtn.addEventListener("click", function () {
      if (autoScrolling) stopAutoScroll("Stopped");
      else startAutoScroll();
    });

    var rowBtns = document.createElement("div");
    styleEl(rowBtns, { display: "flex", gap: "0.5em", marginTop: "0.5em", flexShrink: "0" });

    var manual = document.createElement("button");
    manual.textContent = "Scan visible";
    var dash = document.createElement("button");
    dash.textContent = "Open dashboard";

    [manual, dash].forEach(function (button) {
      styleEl(button, {
        flex: "1", padding: "0.65em", borderRadius: "8px",
        border: "1px solid rgba(110,231,183,0.24)", cursor: "pointer",
        background: "transparent", color: "#7fa693", fontSize: "0.9em"
      });
    });

    manual.addEventListener("click", function () { scanPosts(); flush(); });

    var pause = document.createElement("button");
    styleEl(pause, {
      width: "100%", marginTop: "0.5em", padding: "0.6em", borderRadius: "8px",
      border: "1px solid rgba(110,231,183,0.2)", cursor: "pointer",
      background: "transparent", color: "#7fa693", fontSize: "0.88em"
    });
    function renderPause() {
      pause.textContent = enabled
        ? "Pause capture (currently watching)"
        : "Resume capture";
      pause.style.color = enabled ? "#7fa693" : "#6ee7b7";
    }
    pause.addEventListener("click", function () {
      try {
        chrome.storage.local.set({ enabled: !enabled });
      } catch (e) { /* orphaned context; the reload prompt covers it */ }
    });
    hud.__renderPause = renderPause;
    renderPause();

    var diag = document.createElement("button");
    diag.textContent = "Diagnose";
    diag.title = "Copy a report of what the extractor sees on this page";
    styleEl(diag, {
      flex: "1", padding: "0.65em", borderRadius: "8px",
      border: "1px solid rgba(217,180,95,0.35)", cursor: "pointer",
      background: "transparent", color: "#d9b45f", fontSize: "0.9em"
    });
    diag.addEventListener("click", function () {
      var report = diagnose();
      navigator.clipboard.writeText(report).then(function () {
        STATS.lastError = "Diagnostic copied — paste it to get the extractors tuned.";
        renderHud();
      }).catch(function () {
        // Clipboard can be blocked; the console is always available.
        console.log(report);
        STATS.lastError = "Clipboard blocked — the report is in the console (F12).";
        renderHud();
      });
    });

    dash.addEventListener("click", function () {
      chrome.storage.local.get(["endpoint"], function (state) {
        window.open(state.endpoint || "http://localhost:5050", "_blank");
      });
    });

    rowBtns.appendChild(manual);
    rowBtns.appendChild(diag);

    var rowBtns2 = document.createElement("div");
    styleEl(rowBtns2, { display: "flex", gap: "0.5em", marginTop: "0.5em", flexShrink: "0" });
    rowBtns2.appendChild(dash);

    // Stats and log share one scrollable region; the buttons are pinned below
    // it. Previously the stats block could not shrink, so as rows were added
    // it pushed the controls past the bottom edge of the panel.
    var scroller = document.createElement("div");
    styleEl(scroller, {
      flex: "1", minHeight: "0", overflowY: "auto", overflowX: "hidden",
      display: "flex", flexDirection: "column"
    });

    scroller.appendChild(hudBody);
    scroller.appendChild(logLabel);
    scroller.appendChild(hudLog);

    content.appendChild(scroller);
    content.appendChild(hudBtn);
    content.appendChild(rowBtns);
    content.appendChild(rowBtns2);
    content.appendChild(pause);

    hud.appendChild(header);
    hud.appendChild(content);
    document.body.appendChild(hud);
  }

  function row(label, value, accent) {
    var line = document.createElement("div");
    styleEl(line, {
      display: "flex", justifyContent: "space-between",
      padding: "0.22em 0", fontSize: "0.98em"
    });

    var l = document.createElement("span");
    l.textContent = label;
    styleEl(l, { color: "#567a67", flexShrink: "0", marginRight: "0.6em" });

    var v = document.createElement("span");
    v.textContent = value;
    // Truncate rather than overflow: a long group name must not push its own
    // value out of the panel.
    styleEl(v, {
      color: accent || "#eafff3", fontWeight: "700",
      minWidth: "0", overflow: "hidden",
      textOverflow: "ellipsis", whiteSpace: "nowrap"
    });

    line.appendChild(l);
    line.appendChild(v);
    return line;
  }

  function renderHud() {
    if (!hud) return;
    hudBody.textContent = "";

    var source = detectSource();
    hudBody.appendChild(row(
      source ? (source.kind === "group" ? "Group" : "Profile") : "Page",
      source ? source.name.slice(0, 24) : "unsupported",
      source ? "#6ee7b7" : "#e07a5f"
    ));
    // State first. Capture runs as you scroll, not only after Start — that is
    // useful but surprising, and unexplained it looks like numbers moving on
    // their own while the page sits still.
    var mode, modeColour;
    if (!enabled) {
      mode = "Paused"; modeColour = "#e07a5f";
    } else if (autoScrolling) {
      mode = "Auto-scrolling"; modeColour = "#6ee7b7";
    } else {
      mode = "Watching as you scroll"; modeColour = "#d9b45f";
    }
    hudBody.appendChild(row("Status", mode, modeColour));

    // Which dashboard this is feeding. Without it you can scan happily into
    // localhost while reading a hosted dashboard and never see your posts.
    hudBody.appendChild(row("Sending to", endpointLabel || "…",
                            endpointLabel ? "#7fa693" : null));
    var where = source ? (source.kind === "group" ? "in this group"
                                                 : "on this profile") : "on page";
    hudBody.appendChild(row("Posts " + where, String(STATS.candidates)));
    if (STATS.commentsOnPage || STATS.commentsFound) {
      hudBody.appendChild(row(
        "Comments",
        STATS.commentsFound + " kept / " + STATS.commentsOnPage + " on screen"
      ));
    }
    hudBody.appendChild(row(
      "Captured this group",
      SEEN.size + " / " + maxPosts,
      SEEN.size >= maxPosts ? "#6ee7b7" : null
    ));
    hudBody.appendChild(row("Sent to dashboard", String(STATS.sent)));
    hudBody.appendChild(row("New (not duplicates)", String(STATS.added), "#6ee7b7"));

    if (autoScrolling) {
      var elapsed = Math.round((Date.now() - scanStartedAt) / 60000 * 10) / 10;
      hudBody.appendChild(row("Elapsed", elapsed + " / " + maxMinutes + " min"));
    }

    // Engagement coverage is the number that matters: posts land with zeroed
    // counts when the reaction selectors drift, and outlier scoring is
    // meaningless without them. Surfacing the ratio makes that visible
    // immediately rather than after a hundred useless captures.
    var coverage = STATS.sent ? Math.round(STATS.withEngagement / STATS.sent * 100) : 0;
    hudBody.appendChild(row(
      "With engagement", STATS.sent ? coverage + "%" : "—",
      coverage >= 60 ? "#6ee7b7" : (STATS.sent ? "#d9b45f" : "#7fa693")
    ));

    if (STATS.withMedia) {
      hudBody.appendChild(row("With images/video", String(STATS.withMedia)));
    }
    if (STATS.skipped) hudBody.appendChild(row("Skipped (no text)", String(STATS.skipped)));
    if (STATS.queued) hudBody.appendChild(row("Queued", String(STATS.queued)));

    if (STATS.articles > 0 && STATS.candidates === 0) {
      hudBody.appendChild(row("⚠ selectors", "drifted", "#d9b45f"));
    }
    if (STATS.sent >= 10 && coverage < 30) {
      hudBody.appendChild(row("⚠ engagement", "not reading", "#d9b45f"));
    }

    // A finished scan should hand you the next action, not just stop.
    if (STATS.done && !autoScrolling) {
      var doneBox = document.createElement("div");
      doneBox.textContent = STATS.done;
      styleEl(doneBox, {
        marginTop: "0.65em", padding: "0.6em 0.75em", fontSize: "0.92em",
        color: "#6ee7b7", borderRadius: "8px",
        background: "rgba(52,211,153,0.12)",
        border: "1px solid rgba(110,231,183,0.35)"
      });
      hudBody.appendChild(doneBox);

      var ideas = document.createElement("button");
      ideas.textContent = "Get post ideas from this scan →";
      styleEl(ideas, {
        width: "100%", marginTop: "0.5em", padding: "0.7em", borderRadius: "8px",
        border: "1px solid rgba(110,231,183,0.4)", cursor: "pointer",
        background: "rgba(52,211,153,0.14)", color: "#6ee7b7",
        fontSize: "0.95em", fontWeight: "650"
      });
      ideas.addEventListener("click", function () {
        chrome.storage.local.get(["endpoint"], function (state) {
          var base = state.endpoint || "http://localhost:5050";
          window.open(base + "/ideas?source=" + encodeURIComponent(currentSourceId), "_blank");
        });
      });
      hudBody.appendChild(ideas);
    }

    if (STATS.lastError) {
      var err = document.createElement("div");
      err.textContent = STATS.lastError;
      styleEl(err, {
        marginTop: "0.65em", padding: "0.6em 0.75em", fontSize: "0.92em",
        color: "#f0c274", borderRadius: "8px",
        background: "rgba(217,180,95,0.12)",
        border: "1px solid rgba(217,180,95,0.3)"
      });
      hudBody.appendChild(err);
    }

    hudLog.textContent = STATS.log.length
      ? STATS.log.join("\n")
      : "Nothing captured yet.\nPress Start auto-scroll.";

    if (hud.__renderPause) hud.__renderPause();

    hudBtn.textContent = autoScrolling ? "Stop auto-scroll" : "Start auto-scroll";
    hudBtn.style.background = autoScrolling
      ? "rgba(224,122,95,0.92)" : "linear-gradient(135deg, #34d399, #10b981)";
    hudBtn.style.color = autoScrolling ? "#fff" : "#04150c";
  }

  /* ------------------------------------------------------ wiring */

  chrome.storage.local.get(
    ["enabled", "maxPosts", "maxMinutes", "endpoint"],
    function (state) {
      enabled = state.enabled !== false;
      maxPosts = state.maxPosts || DEFAULT_MAX_POSTS;
      maxMinutes = state.maxMinutes || DEFAULT_MAX_MINUTES;
      endpointLabel = hostOf(state.endpoint || "http://localhost:5050");
      renderHud();
    }
  );

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled && autoScrolling) stopAutoScroll("Capture turned off");
    }
    if (changes.maxPosts) maxPosts = changes.maxPosts.newValue || DEFAULT_MAX_POSTS;
    if (changes.maxMinutes) maxMinutes = changes.maxMinutes.newValue || DEFAULT_MAX_MINUTES;
    if (changes.endpoint) endpointLabel = hostOf(changes.endpoint.newValue || "");
    renderHud();
  });

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === "OUTLIER_START") { startAutoScroll(); sendResponse({ ok: true }); }
    if (message.type === "OUTLIER_STOP")  { stopAutoScroll("Stopped"); sendResponse({ ok: true }); }
    if (message.type === "OUTLIER_SCAN")  { scanPosts(); flush(); sendResponse({ ok: true, stats: STATS }); }
    if (message.type === "OUTLIER_STATS") { sendResponse({ ok: true, stats: STATS, scrolling: autoScrolling }); }
  });

  // Passive scan as posts render during ordinary scrolling, debounced because
  // Facebook mutates the DOM constantly.
  var scanTimer;
  new MutationObserver(function () {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPosts, 800);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(flush, 4000);

  // Poll for orphaning even when idle, so a tab left open across an update
  // shows the reload prompt rather than looking alive but doing nothing.
  setInterval(function () {
    if (!contextAlive()) handleOrphaned();
  }, 5000);

  // A position saved on a wider window, or a browser since resized smaller,
  // would leave the panel partly or wholly off-screen with no way to drag it
  // back — the header you grab would be outside the viewport.
  window.addEventListener("resize", function () {
    if (!hud) return;
    clearTimeout(window.__outlierClamp);
    window.__outlierClamp = setTimeout(function () {
      var rect = hud.getBoundingClientRect();
      var box = clampHudBox({
        width: rect.width, height: rect.height, left: rect.left, top: rect.top
      });
      hud.style.width = box.width + "px";
      hud.style.height = box.height + "px";
      hud.style.left = box.left + "px";
      hud.style.top = box.top + "px";
      saveHudBox();
    }, 150);
  });

  buildHud();
  setTimeout(function () { scanPosts(); renderHud(); }, 1500);

  // Exposed for debugging against live Facebook: select a post in devtools and
  // run __outlier.extractBody($0) to see exactly what the extractors read.
  // Also what the offline fixture tests drive.
  window.__outlier = {
    detectSource: detectSource,
    looksLikePost: looksLikePost,
    classify: classify,
    ownQuery: ownQuery,
    findActionBar: findActionBar,
    isBelowBar: isBelowBar,
    extractBody: extractBody,
    extractAuthor: extractAuthor,
    extractEngagement: extractEngagement,
    extractPostType: extractPostType,
    extractMedia: extractMedia,
    extractPermalink: extractPermalink,
    extractTimestamp: extractTimestamp,
    parseCount: parseCount,
    scanPosts: scanPosts,
    diagnose: diagnose,
    stats: STATS,
    queue: function () { return QUEUE; }
  };
})();
