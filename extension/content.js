/* Tallgrass content script.
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
  var hasApiKey = false;

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
      skipped: 0,          // rejected as shells — no text, no media, no counts
      mediaOnly: 0,        // kept on the strength of an image/video alone
      textFromImage: 0,    // caption read out of the graphic's alt text
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
    // Strict first: the author link lives in the post header, above the action
    // bar. Casting wider than that picks up commenters, tagged users and link
    // previews — which is how posts ended up attributed to a commenter.
    var strict = authorPass(article, bar);
    if (strict) return strict;

    // Nothing above the bar. Same failure as extractBody: when findActionBar
    // latches onto something near the top of the article, every candidate
    // counts as "below" it and the post is attributed to nobody. A name
    // picked from the whole article is occasionally the wrong person; the
    // literal string "Unknown" printed where a name goes is always wrong.
    var relaxed = authorPass(article, null);
    if (relaxed) return relaxed;

    // Genuinely could not read it. null rather than "Unknown" — the UI needs
    // to be able to tell "no author captured" from a person with that name,
    // and "Unknown" reads as a real byline on the card.
    return { name: null, url: null };
  }

  function authorPass(article, bar) {
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

    return null;   // caller decides what an unreadable author means
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
    // Strict first: the caption is the longest text block ABOVE the action
    // bar. Without the cutoff a long comment beats a short caption — which is
    // how "that's funny, flat earthers will think this is a real picture" got
    // saved as the body of a post captioned "Artemis 2 captures its first
    // views".
    var strict = bodyPass(article, authorName, bar);
    if (strict) return strict;

    // Nothing above the bar. Either the post genuinely has no caption, or
    // findActionBar latched onto something near the top of the article and
    // declared the entire post to be "below" it — in which case the strict
    // pass discards real text and the post is dropped as an empty shell.
    // That was the "skipped, no text" case on posts that plainly had text.
    //
    // Retrying without the cutoff risks picking up a comment, which is the
    // lesser failure: a post saved with the wrong caption is visible and
    // fixable, a post never saved at all is invisible.
    return bodyPass(article, authorName, null);
  }

  function bodyPass(article, authorName, bar) {
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

  /* Text rendered into the graphic rather than typed into the post.
   *
   * Facebook runs its own OCR for screen readers and publishes the result in
   * the image's alt attribute: "May be an image of text that says 'SALE ENDS
   * FRIDAY'". A meme or a quote card carries its entire message that way, and
   * discarding it means the post is captured as a caption-less shell — or
   * dropped outright — when its words were sitting in the DOM the whole time.
   *
   * The boilerplate preamble is stripped so what is stored reads as the post's
   * text, and quoted runs are preferred because those are the transcription.
   */
  var ALT_PREAMBLE_RE = /^(may be an image of|may be a graphic of|may be an? |image may contain:?|no photo description available)\s*/i;

  var MIN_IMAGE_TEXT = 12;

  function textFromAlt(alt) {
    var raw = String(alt || "").trim();
    if (!raw) return "";
    if (/^no photo description available/i.test(raw)) return "";
    if (/profile picture|avatar/i.test(raw)) return "";

    // "…and text that says 'WORDS'" — everything before the lead-in is scene
    // description ("2 people, smiling"), everything after is the transcription.
    var says = raw.match(/text that says[:\s]*([\s\S]+)/i);
    if (says) {
      var transcribed = says[1].trim().replace(/^['"‘’“”]+|['"‘’“”.]+$/g, "").trim();
      return transcribed.length >= MIN_IMAGE_TEXT ? transcribed.slice(0, 5000) : "";
    }

    // No lead-in, but quoted runs are still the OCR'd words.
    var quoted = raw.match(/['"‘’“”]([^'"‘’“”]{4,})['"‘’“”]/g);
    if (quoted && quoted.length) {
      var joined = quoted.map(function (chunk) {
        return chunk.replace(/^['"‘’“”]|['"‘’“”]$/g, "").trim();
      }).join(" ");
      if (joined.length >= MIN_IMAGE_TEXT) return joined.slice(0, 5000);
    }

    // What's left is either a scene description Facebook generated ("3 people,
    // outdoors") or a real description the author wrote by hand. Only the
    // second is worth keeping, and length is the only signal separating them —
    // generated ones are short and comma-listed.
    if (ALT_PREAMBLE_RE.test(raw)) return "";
    var stripped = raw.trim();
    return stripped.length >= 40 ? stripped.slice(0, 5000) : "";
  }

  /* Is this token plausibly an engagement count?
   *
   * The structural fallback grabs the first number it finds above the action
   * bar, and the things that sit there besides a reaction total are a
   * timestamp ("5h", "3d") and a date ("2024"). parseCount happily turns "5h"
   * into 5 and "2024" into 2024, so a post's age was being stored as its
   * reaction count and a year as a four-figure one — which then set the
   * group's median and every multiple scored against it.
   */
  function looksLikeACount(token) {
    var text = String(token || "").trim();
    if (!text) return false;
    // h/d/w/y are unambiguously time. "m" is not: lowercase is minutes or
    // months, uppercase is millions — and Facebook is consistent about the
    // case, so "2m" is an age and "2M" is a count.
    if (/^\d+\s*[hdwy]$/i.test(text)) return false;           // 5h, 3d, 2w
    if (/^\d+\s*m$/.test(text)) return false;                 // 2m — minutes
    if (/^(19|20)\d{2}$/.test(text.replace(/,/g, ""))) return false;   // a year
    if (/^\d{1,2}:\d/.test(text)) return false;               // 10:30
    if (/^\d{1,2}\/\d/.test(text)) return false;              // 3/4
    return /^\d[\d.,]*\s*[KMB]?$/.test(text);
  }

  // Words that mark a string as describing engagement rather than being post
  // copy that happens to contain a number.
  // Plurals must be part of each alternative: \breaction\b does not match
  // "reactions", because the trailing s is a word character and kills the
  // boundary. Facebook writes the plural far more often than the singular.
  var ENGAGEMENT_WORD_RE =
    /\b(reactions?|reacted|likes?|loves?|cares?|haha|wow|sad|angry|comments?|shares?|shared|views?|plays?|others?)\b/i;

  // A summary row's whole text is the count — "312", "1.2K", "312 · 47".
  // Prose never looks like this, which is what keeps captions out.
  var SUMMARY_ROW_RE = /^[\d.,]+\s*[KMB]?(\s*[·•|]\s*[\d.,]+\s*[KMB]?)*$/;

  var ENGAGEMENT_WORDS_G =
    /\b(reactions?|reacted|likes?|loves?|cares?|haha|wow|sad|angry|comments?|shares?|shared|views?|plays?|others?)\b/gi;

  /* Is this element's whole text a summary row, rather than prose that
   * happens to contain an engagement word?
   *
   * "I bought 500 shares of the company last year" contains "shares" and a
   * number, and an engagement-word test alone admits it — the caption then
   * supplies a share count nobody measured. Strip the counts, the engagement
   * words and the punctuation; a real summary row has almost nothing left,
   * while a sentence still has its sentence.
   */
  function isSummaryText(text) {
    if (!/\d/.test(text)) return false;
    if (text.length > 40) return false;
    if (SUMMARY_ROW_RE.test(text)) return true;

    var residue = text
      .replace(/[\d.,]+\s*[KMB]?/gi, " ")
      .replace(ENGAGEMENT_WORDS_G, " ")
      .replace(/\b(and|all|see|who|to|this|the)\b/gi, " ")
      .replace(/[^a-z]/gi, "");
    return residue.length <= 3;
  }

  /* Every string in this article that is UI chrome describing engagement.
   *
   * Deliberately excludes the caption. See extractEngagement for why — the
   * caption is where fabricated counts came from, and no amount of pattern
   * tightening fixes a haystack that contains arbitrary prose.
   */
  function engagementChrome(article, bar) {
    var out = [];

    var labelled = article.querySelectorAll("[aria-label]");
    for (var i = 0; i < labelled.length; i++) {
      var el = labelled[i];
      if (el.closest('div[role="article"]') !== article) continue;
      if (isBelowBar(el, bar)) continue;          // per-comment counts
      var label = el.getAttribute("aria-label") || "";
      if (!label) continue;
      // An aria-label with no engagement word is describing something else —
      // an image, a link preview, a menu — and must not be searched for counts.
      if (!ENGAGEMENT_WORD_RE.test(label)) continue;
      // Facebook's generated image descriptions are prose and can contain both
      // a number and an engagement word ("...text that says 500 SHARES").
      if (ALT_PREAMBLE_RE.test(label)) continue;
      out.push(label);
    }

    // The summary row: walk back from the action bar, keeping only elements
    // whose entire text is a count or a count plus an engagement word.
    if (bar) {
      var row = bar.parentElement;
      for (var hop = 0; hop < 4 && row; hop++) {
        var previous = row.previousElementSibling;
        var seen = 0;
        while (previous && seen < 6) {
          var text = (previous.innerText || "").trim().replace(/\s+/g, " ");
          // Row text is held to the stricter shape test: this is the branch a
          // caption can actually reach, and an engagement-word check alone
          // lets "500 shares of the company" through as a share count.
          if (text && isSummaryText(text)) out.push(text);
          previous = previous.previousElementSibling;
          seen++;
        }
        row = row.parentElement;
      }
    }

    return out;
  }

  function extractEngagement(article, bar) {
    var result = { likes: 0, comments: 0, shares: 0, video_plays: 0, read: false };

    // The haystack is UI chrome ONLY — never the post's own copy.
    //
    // It used to include article.innerText trimmed at the action bar, which
    // is the whole caption. A post in an AI group reading "11,000,000 tokens
    // processed" was stored as 11M reactions; the real post had four. Any
    // scheme that lets a caption reach these patterns will keep inventing
    // numbers, so the caption is excluded structurally rather than filtered.
    //
    // Two sources are legitimate:
    //   1. aria-labels that name an engagement concept. Facebook writes the
    //      count there even when the visible element is just an icon.
    //   2. the summary row directly above the action bar, whose text is a
    //      bare count and nothing else.
    var haystackParts = engagementChrome(article, bar);
    var haystack = haystackParts.join("\n");

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

    // Every gap here is [ \t]* rather than \s*, and every label-first pattern
    // requires a colon.
    //
    // The chrome strings are joined with newlines, and \s* crosses one: with
    // "312 reactions" and "47 comments" on consecutive lines, /reactions?:?\s*
    // (\d+)/ matched the word on line one and the number on line two, so a
    // post with 312 reactions was recorded as having 47. Number-first patterns
    // are also tried before label-first ones, since that is the form Facebook
    // actually uses and it cannot straddle a line break.
    result.likes = firstMatch([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+reactions?/i,
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]*(?:people[ \t]+)?reacted/i,
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+likes?\b/i,
      // Facebook also renders the summary as a list of reaction names
      // followed by a total: "Like, Love and 47 others".
      /and[ \t]+([\d][\d.,]*[ \t]*[KMB]?)[ \t]+others?/i,
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+others?[ \t]+reacted/i,
      /See who reacted[^\d\n]*([\d][\d.,]*[ \t]*[KMB]?)/i,
      // Some locales/layouts label the whole row rather than the count.
      /All reactions:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i,
      /(?:Like|reaction)s?:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i
    ]);

    result.comments = firstMatch([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+comments?/i,
      /comments?:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i
    ]);

    result.shares = firstMatch([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+shares?/i,
      /shares?:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i
    ]);

    result.video_plays = firstMatch([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+(?:views?|plays?)/i
    ]);

    // Structural fallback, used when every label pattern misses.
    //
    // Facebook's summary row sits immediately above the action bar and holds
    // the reaction total as bare text next to icons, with no wording to match.
    // It reads only the strings engagementChrome already vetted, so a caption
    // cannot reach it — the previous version walked raw siblings and took the
    // first number it saw, which is how post copy became a reaction count.
    if (!result.likes) {
      for (var h = 0; h < haystackParts.length; h++) {
        var part = haystackParts[h];
        if (!SUMMARY_ROW_RE.test(part)) continue;      // bare counts only
        var first = part.split(/[\s·•|]+/)[0];
        if (!looksLikeACount(first)) continue;
        var candidate = parseCount(first);
        if (candidate) { result.likes = candidate; break; }
      }
    }

    // There is deliberately no fallback for the comment count.
    //
    // There used to be one: take every number in the post, keep those smaller
    // than the reaction total, and call the largest of them the comment count.
    // That reads the post's own copy. "We closed 12 deals this quarter" on a
    // post with 300 reactions was silently stored as 12 comments — a number
    // nobody measured, indistinguishable on the card from one that was, and
    // feeding straight into the weighted score at 3x. A missing count has to
    // stay missing.

    // Whether any of this was actually read, as opposed to defaulting to zero.
    // Without it, "0 reactions" claims the post got none when the truth is
    // that nothing could be found — and those are completely different facts.
    result.read = !!(result.likes || result.comments || result.shares ||
                     result.video_plays);
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

      var alt = img.getAttribute("alt") || "";
      if (/profile picture|avatar/i.test(alt)) continue;

      found.push({ src: src, alt: alt, area: (width || 0) * (height || 0) });
    }

    // Largest first: on an album the biggest render is the one on display.
    found.sort(function (a, b) { return b.area - a.area; });

    var video = article.querySelector("video");
    var hasVideo = !!(video && !isBelowBar(video, bar)) ||
                   !!ownQuery(article, 'a[href*="/reel/"], a[href*="/videos/"]');

    // Any image's alt may carry the transcription, not just the largest —
    // a quote card sitting second in an album still holds the words.
    var altText = "";
    for (var k = 0; k < found.length && !altText; k++) {
      altText = textFromAlt(found[k].alt);
    }

    return {
      image_url: found.length ? found[0].src : null,
      image_count: found.length,
      has_video: hasVideo,
      image_text: altText
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
      var postId = extractPostId(article, permalink, body, author.name || "");

      // Everything past this point counts only ONCE per item. Counting before
      // the dedup check meant the passive re-scan — which fires roughly every
      // 800ms because Facebook mutates constantly — re-counted the same
      // comments on every pass. Sitting still on one screen climbed past 300.
      if (!postId || SEEN.has(postId)) return;

      // Engagement and media are read BEFORE the keep/skip decision, because
      // they are part of that decision. Requiring a caption discarded whole
      // categories of real post: image-only posts, memes whose words are
      // rendered into the graphic, and short reactions ("This 👏"). Those are
      // frequently a group's best performers, so dropping them didn't just
      // lose rows — it biased the baseline the survivors are scored against.
      var engagement = extractEngagement(article, bar);
      var media = extractMedia(article, bar);

      var bodyFromImage = false;
      if ((!body || body.length < 12) && media.image_text) {
        body = media.image_text;      // Facebook's own OCR, see textFromAlt
        bodyFromImage = true;
      }

      // "Text" that is only the author's name echoed out of the header is a
      // header, not a caption — drop it rather than store it as the body.
      if (body && author.name && body.replace(/\s+/g, " ") === author.name) body = "";

      var hasText = !!body && body.length >= 12;
      var hasMedia = !!(media.image_url || media.has_video);
      var hasEngagement = !!(engagement.likes || engagement.comments ||
                             engagement.shares);

      // A genuine shell has none of the three. Anything else is a real item.
      if (!hasText && !hasMedia && !hasEngagement) { STATS.skipped++; return; }

      SEEN.add(postId);
      if (!isPost) STATS.commentsFound++;
      found++;

      if (hasEngagement) STATS.withEngagement++;
      if (hasMedia) STATS.withMedia++;
      if (!hasText) STATS.mediaOnly++;
      if (bodyFromImage) STATS.textFromImage++;
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
        has_video: media.has_video,
        body_from_image: bodyFromImage ? 1 : 0,
        engagement_read: engagement.read ? 1 : 0
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

    lines.push("TALLGRASS DIAGNOSTIC");
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
      lines.push("author      : " + (author.name || "NOT READ"));
      lines.push("body chars  : " + body.length + "  " +
                 JSON.stringify(body.slice(0, 60)));
      lines.push("engagement  : " + engagement.likes + "r " + engagement.comments +
                 "c " + engagement.shares + "s " + engagement.video_plays + "v" +
                 (engagement.read ? "" : "   <- NOTHING READ"));
      lines.push("media       : " + (media.image_url ? media.image_count + " image(s)"
                 : "none") + (media.has_video ? " + video" : ""));
      lines.push("image text  : " + (media.image_text
                 ? JSON.stringify(media.image_text.slice(0, 80)) : "none"));

      // Why this item would be kept or dropped, so a missing post can be
      // traced to the rule that rejected it rather than guessed at.
      var keeps = [];
      if (body.length >= 12) keeps.push("text");
      if (media.image_url || media.has_video) keeps.push("media");
      if (engagement.likes || engagement.comments || engagement.shares) keeps.push("counts");
      lines.push("would keep  : " + (keeps.length ? "yes (" + keeps.join(", ") + ")"
                                                  : "NO — nothing found"));

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

  var HUD_MIN_W = 340;
  var HUD_MIN_H = 320;
  // Sized so every stat row, the log and the buttons all fit without
  // resizing. Anything smaller and something is always clipped.
  var HUD_DEFAULT_W = 430;
  var HUD_DEFAULT_H = 580;

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
        width: HUD_DEFAULT_W,
        height: HUD_DEFAULT_H,
        left: Math.max(8, window.innerWidth - HUD_DEFAULT_W - 20),
        top: Math.max(8, window.innerHeight - HUD_DEFAULT_H - 20)
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
        width: saved.width || HUD_DEFAULT_W,
        height: saved.height || HUD_DEFAULT_H,
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
    // A vine down the inside edge, drawn on when the panel opens. Purely
    // decorative — pointer-events off so it never intercepts a drag — and it
    // carries the same organic-growth idea as the dashboard's meadow.
    var vine = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    vine.setAttribute("viewBox", "0 0 40 600");
    vine.setAttribute("preserveAspectRatio", "none");
    vine.setAttribute("aria-hidden", "true");
    styleEl(vine, {
      position: "absolute", left: "0", top: "0",
      width: "40px", height: "100%",
      pointerEvents: "none", opacity: "0.5", zIndex: "0"
    });
    vine.innerHTML =
      '<path d="M14 600 C 6 520, 26 470, 16 400 C 8 340, 26 300, 15 240 ' +
      'C 6 190, 24 150, 14 90 C 9 55, 18 30, 15 0" ' +
      'fill="none" stroke="rgba(52,211,153,0.5)" stroke-width="1.5" ' +
      'stroke-linecap="round"/>' +
      // Leaves along the stem, alternating sides.
      '<path d="M16 460 q 14 -10 20 -2 q -12 10 -20 2 Z" fill="rgba(52,211,153,0.3)"/>' +
      '<path d="M15 350 q -13 -10 -19 -2 q 11 10 19 2 Z" fill="rgba(52,211,153,0.26)"/>' +
      '<path d="M17 250 q 14 -9 20 -1 q -12 9 -20 1 Z" fill="rgba(52,211,153,0.3)"/>' +
      '<path d="M14 150 q -13 -9 -19 -1 q 11 9 19 1 Z" fill="rgba(52,211,153,0.24)"/>' +
      '<circle cx="15" cy="40" r="2.4" fill="rgba(110,231,183,0.55)"/>';

    var stem = vine.querySelector("path");
    var stemLength = 900;                     // longer than the path; safe to over-dash
    stem.style.strokeDasharray = stemLength;
    stem.style.strokeDashoffset = stemLength;
    stem.style.transition = "stroke-dashoffset 1.6s cubic-bezier(0.22,1,0.36,1)";
    setTimeout(function () { stem.style.strokeDashoffset = "0"; }, 60);

    var header = document.createElement("div");
    styleEl(header, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0.9em 1.1em", cursor: "move", flexShrink: "0",
      background: "rgba(16,40,27,0.75)",
      borderBottom: "1px solid rgba(110,231,183,0.18)",
      position: "relative", zIndex: "1"
    });

    var title = document.createElement("span");
    styleEl(title, { fontWeight: "700", fontSize: "1.2em", letterSpacing: "-0.2px",
                     display: "inline-flex", alignItems: "baseline", gap: "0.35em" });

    var titleMain = document.createElement("span");
    titleMain.textContent = "Tallgrass";
    title.appendChild(titleMain);

    var titleSuffix = document.createElement("span");
    titleSuffix.textContent = "by MacRandle Acres";
    styleEl(titleSuffix, { fontWeight: "500", fontSize: "0.6em", color: "#7fa693",
                           letterSpacing: "0.02em" });
    title.appendChild(titleSuffix);

    // A slow pulse on the mark while capture is live — the panel is often
    // parked in a corner while you scroll, and a still panel and a stopped
    // one look identical.
    var pulse = document.createElement("span");
    pulse.className = "outlier-pulse";
    styleEl(pulse, {
      width: "7px", height: "7px", borderRadius: "50%", flex: "none",
      background: "#6ee7b7", boxShadow: "0 0 0 0 rgba(110,231,183,0.55)",
      alignSelf: "center", marginRight: "0.1em"
    });
    hud.__pulse = pulse;

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
    header.appendChild(pulse);
    header.appendChild(title);
    header.appendChild(controls);

    var content = document.createElement("div");
    styleEl(content, {
      display: "flex", flexDirection: "column", flex: "1",
      padding: "1em 1.1em 1em 1.5em",   // extra left inset clears the vine
      overflow: "hidden", minHeight: "0",
      position: "relative", zIndex: "1"
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
      var scale = Math.min((rect.width || HUD_DEFAULT_W) / HUD_DEFAULT_W,
                           (rect.height || HUD_DEFAULT_H) / HUD_DEFAULT_H);
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
      scrollbarWidth: "thin",
      scrollbarColor: "rgba(52,211,153,0.55) transparent"
    });

    /* --- buttons --- */
    hudBtn = document.createElement("button");
    styleEl(hudBtn, {
      width: "100%", marginTop: "0.9em", padding: "0.8em", borderRadius: "9px",
      border: "none", cursor: "pointer", fontWeight: "700", fontSize: "1.05em",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      flexShrink: "0",
      transition: "transform 0.16s cubic-bezier(0.22,1,0.36,1), " +
                  "box-shadow 0.2s cubic-bezier(0.22,1,0.36,1), " +
                  "filter 0.2s ease"
    });
    hudBtn.addEventListener("mouseenter", function () {
      hudBtn.style.transform = "translateY(-1px)";
      hudBtn.style.filter = "brightness(1.06)";
    });
    hudBtn.addEventListener("mouseleave", function () {
      hudBtn.style.transform = "";
      hudBtn.style.filter = "";
    });
    hudBtn.addEventListener("mousedown", function () {
      hudBtn.style.transform = "translateY(1px)";
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
      button.style.transition = "border-color 0.18s ease, background 0.18s ease, " +
                                "color 0.18s ease";
      button.addEventListener("mouseenter", function () {
        button.style.background = "rgba(110,231,183,0.11)";
        button.style.borderColor = "rgba(110,231,183,0.45)";
      });
      button.addEventListener("mouseleave", function () {
        button.style.background = "transparent";
        button.style.borderColor = "rgba(110,231,183,0.24)";
      });
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
      display: "flex", flexDirection: "column",
      // Room for the scrollbar so it never sits on top of a number.
      paddingRight: "0.55em",
      scrollbarWidth: "thin",
      scrollbarColor: "rgba(52,211,153,0.55) transparent"
    });

    scroller.appendChild(hudBody);
    scroller.appendChild(logLabel);
    scroller.appendChild(hudLog);

    content.appendChild(scroller);
    content.appendChild(hudBtn);
    content.appendChild(rowBtns);
    content.appendChild(rowBtns2);
    content.appendChild(pause);

    hud.appendChild(vine);
    hud.appendChild(header);
    hud.appendChild(content);
    document.body.appendChild(hud);

    // Arrive rather than appear. The panel drops onto a page the user is
    // already looking at, and something that materialises with no transition
    // reads as a rendering glitch on Facebook's own chrome.
    animate(hud, [
      { opacity: 0, transform: "translateY(14px) scale(0.97)" },
      { opacity: 1, transform: "translateY(0) scale(1)" }
    ], { duration: 420, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "backwards" });

    // Rows stagger in behind it, so the eye lands on the panel first and the
    // numbers second.
    animate(content, [
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0)" }
    ], { duration: 520, delay: 120, easing: "cubic-bezier(0.22,1,0.36,1)",
         fill: "backwards" });
  }


  /* Animation without a stylesheet.
   *
   * Facebook's CSP rejects an injected <style> tag, so @keyframes is not
   * available here. element.animate() runs on the same compositor and is not
   * subject to style-src, which makes it the only way to move anything in
   * this panel.
   */
  var REDUCED_MOTION = window.matchMedia &&
                       window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function animate(el, frames, options) {
    if (REDUCED_MOTION || !el || !el.animate) return null;
    try {
      return el.animate(frames, options);
    } catch (e) {
      return null;   // older engines; the panel is still fully usable
    }
  }

  var pulseAnimation = null;

  // A living panel reads as "still working"; a frozen one reads as crashed.
  // Runs only while capture is actually live, so it means something.
  function setPulse(active, colour) {
    var dot = hud && hud.__pulse;
    if (!dot) return;
    dot.style.background = colour;

    if (!active) {
      if (pulseAnimation) { pulseAnimation.cancel(); pulseAnimation = null; }
      dot.style.boxShadow = "0 0 0 0 rgba(0,0,0,0)";
      dot.style.opacity = "0.45";
      return;
    }
    dot.style.opacity = "1";
    if (pulseAnimation) return;          // already running; don't restack it

    pulseAnimation = animate(dot, [
      { boxShadow: "0 0 0 0 rgba(110,231,183,0.55)", transform: "scale(1)" },
      { boxShadow: "0 0 0 7px rgba(110,231,183,0)",  transform: "scale(1.15)" },
      { boxShadow: "0 0 0 0 rgba(110,231,183,0)",    transform: "scale(1)" }
    ], { duration: 2200, iterations: Infinity, easing: "cubic-bezier(0.22,1,0.36,1)" });
  }

  // Values that changed since the last render get a brief lift. Without it a
  // number ticking up in a dense list is genuinely easy to miss.
  var LAST_VALUES = {};

  function flashIfChanged(el, label, value) {
    var previous = LAST_VALUES[label];
    LAST_VALUES[label] = value;
    if (previous === undefined || previous === value) return;
    animate(el, [
      { color: "#6ee7b7", transform: "translateY(-2px)" },
      { color: el.style.color || "#eafff3", transform: "translateY(0)" }
    ], { duration: 620, easing: "cubic-bezier(0.22,1,0.36,1)" });
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

    flashIfChanged(v, label, value);

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
      mode = "Capturing"; modeColour = "#6ee7b7";
    }
    hudBody.appendChild(row("Status", mode, modeColour));
    setPulse(enabled, modeColour);

    // Which dashboard this is feeding. Until an account is connected there is
    // no dashboard, and naming the seeded default would be misleading.
    hudBody.appendChild(row(
      "Dashboard",
      hasApiKey ? (endpointLabel || "…") : "Not connected",
      hasApiKey ? "#7fa693" : "#d9b45f"
    ));
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
    if (STATS.textFromImage) {
      hudBody.appendChild(row("Text read from image", String(STATS.textFromImage), "#6ee7b7"));
    }
    if (STATS.mediaOnly) {
      hudBody.appendChild(row("Image/video only", String(STATS.mediaOnly)));
    }
    // Named for what it means now: nothing at all was found, not merely
    // "no caption" — captions are optional and no longer a reason to drop.
    if (STATS.skipped) hudBody.appendChild(row("Skipped (empty)", String(STATS.skipped)));
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

    var nextLabel = autoScrolling ? "Stop auto-scroll" : "Start auto-scroll";
    if (hudBtn.textContent !== nextLabel) {
      // Only on an actual state change — renderHud runs on every scan pass,
      // and animating each one would leave the button permanently twitching.
      animate(hudBtn, [
        { transform: "scale(1)" },
        { transform: "scale(1.03)" },
        { transform: "scale(1)" }
      ], { duration: 340, easing: "cubic-bezier(0.22,1,0.36,1)" });
    }
    hudBtn.textContent = nextLabel;
    hudBtn.style.background = autoScrolling
      ? "rgba(224,122,95,0.92)" : "linear-gradient(135deg, #34d399, #10b981)";
    hudBtn.style.color = autoScrolling ? "#fff" : "#04150c";
    hudBtn.style.boxShadow = autoScrolling
      ? "0 4px 18px rgba(224,122,95,0.3)" : "0 4px 18px rgba(52,211,153,0.28)";
  }

  /* ------------------------------------------------------ wiring */

  chrome.storage.local.get(
    ["enabled", "maxPosts", "maxMinutes", "endpoint", "apiKey"],
    function (state) {
      enabled = state.enabled !== false;
      maxPosts = state.maxPosts || DEFAULT_MAX_POSTS;
      maxMinutes = state.maxMinutes || DEFAULT_MAX_MINUTES;
      hasApiKey = !!(state.apiKey || "").trim();
      endpointLabel = hasApiKey ? hostOf(state.endpoint || "") : null;
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
    if (changes.apiKey) hasApiKey = !!(changes.apiKey.newValue || "").trim();
    if (changes.endpoint || changes.apiKey) {
      chrome.storage.local.get(["endpoint", "apiKey"], function (state) {
        hasApiKey = !!(state.apiKey || "").trim();
        endpointLabel = hasApiKey ? hostOf(state.endpoint || "") : null;
        renderHud();
      });
    }
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
