/* Tallgrass — Facebook capture.
 *
 * RESTORED from V1.7 (79fbd9f) at the operator's request: capture worked on
 * their real groups then and progressively stopped working through the
 * rewrites that followed. Everything after this point in the extension's
 * history was tuned against a reconstruction of Facebook's markup rather
 * than the real page, and each "fix" moved it further from working.
 *
 * Known trade-offs, deliberately accepted to get capture back:
 *   - Comments are captured again (they are stored but not ranked anywhere).
 *   - Engagement can occasionally read a number out of the post's own text.
 * Both are fixable once capture is confirmed working on a real group; the
 * order matters, because a correct number nobody ever captures is worth
 * nothing.
 *
 * Original header follows.
 *
 * Outlier content script.
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
      candidates: 0,   // top-level ones (comments excluded)
      skipped: 0,      // rejected as shells / author-name-only
      commentsSkipped: 0,  // replies seen and deliberately not captured
      usingFallback: false,
      fallbackNoted: false,
      queued: 0,
      sent: 0,
      added: 0,
      withEngagement: 0,
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

  /* The Like/Comment/Share bar. Everything below it belongs to the replies.
   *
   * Two passes, and the order matters. A real button whose visible text is
   * exactly "Like" is unambiguous; an aria-label beginning "Send this to
   * friends" is not — Facebook uses that wording on share controls that can
   * sit ABOVE the reaction summary. Matching it first made that control the
   * "bar", so the reaction count counted as below it and was thrown away,
   * and the post landed in the dashboard marked "not read".
   */
  function findActionBar(article) {
    var candidates = article.querySelectorAll('[role="button"], [aria-label]');
    var i, el;

    // Pass 1: an actual Like/Comment/Share button.
    for (i = 0; i < candidates.length; i++) {
      el = candidates[i];
      var text = (el.textContent || "").trim();
      if (/^(like|comment|share)$/i.test(text)) return el;
      var label = (el.getAttribute("aria-label") || "").trim();
      if (/^(like|comment|share)$/i.test(label)) return el;
    }

    // Pass 2: the looser wordings, and the LAST one rather than the first —
    // the action bar sits below the post's content, so when in doubt the
    // later candidate keeps more of the post above the cutoff.
    var fallback = null;
    for (i = 0; i < candidates.length; i++) {
      el = candidates[i];
      var lbl = (el.getAttribute("aria-label") || "").trim();
      if (/^(like|comment|share|leave a comment|send this to friends)/i.test(lbl)) {
        fallback = el;
      }
    }
    return fallback;
  }

  // Elements owned by THIS article, not by a reply nested inside it.
  // querySelector searches all descendants, and a post contains its own
  // comments — so an unscoped lookup finds the comments' media and buttons.
  function owned(article, el) {
    return el.closest('div[role="article"]') === article;
  }

  // True when `el` sits after the action bar — i.e. in the comments.
  function isBelowBar(el, bar) {
    if (!bar || !el) return false;
    return !!(bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // Which post a comment belongs to. Nested comments have the post as an
  // ancestor; siblings are matched to the nearest preceding post instead.

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

    /* Nested inside another article — but that is not proof on its own.
     *
     * Facebook wraps feed items, and a shared post renders the original
     * inside the sharer's article, so treating nesting as conclusive
     * discarded real posts. Now that only confident comments are skipped
     * entirely, a false "confident comment" costs the post itself.
     *
     * A post carries a Share control; a reply carries Reply and never Share.
     * Require that before calling it settled.
     */
    if (article.parentElement && article.parentElement.closest('div[role="article"]')) {
      var hasShare = ownQuery(article,
        '[aria-label*="Share" i], [aria-label*="Send this to friends" i]');
      var hasReply = ownQuery(article, '[aria-label*="Reply" i]');
      if (!hasShare && hasReply) {
        return { isPost: false, confident: true, why: "nested, Reply, no Share" };
      }
      if (!hasShare) {
        // Nested and unrecognisable: not captured as a comment, not
        // discarded either — let the scoring below decide.
        score -= 1; reasons.push("nested");
      }
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

  /* Text made up entirely of Facebook's own controls.
   *
   * CHROME_RE only matches a control on its own; a run of them
   * ("Like Comment Share", "See more · Reply") slips through, and the loose
   * caption pass will take it as the post's body when there is no caption.
   */
  var CHROME_WORDS = /^(like|comment|comments|share|shares|reply|replies|see more|see less|all reactions|most relevant|top comments|newest|write a comment|view more comments|·|\||\d+|\d+[hdwmy])$/i;

  function isOnlyChrome(text) {
    var parts = String(text).split(/[\s·|]+/).filter(Boolean);
    if (!parts.length || parts.length > 8) return false;
    for (var i = 0; i < parts.length; i++) {
      if (!CHROME_WORDS.test(parts[i])) return false;
    }
    return true;
  }

  function extractBody(article, authorName, bar) {
    // The caption is the longest text block ABOVE the action bar. Without the
    // cutoff a long comment beats a short caption — which is how "that's
    // funny, flat earthers will think this is a real picture" got saved as
    // the body of a post captioned "Artemis 2 captures its first views".
    var strict = longestTextBlock(
      article, authorName, bar, 'div[dir="auto"], span[dir="auto"]');
    if (strict) return strict;

    /* dir="auto" is a convention, not a guarantee.
     *
     * A live page report showed articles with plenty of visible text and
     * dirAuto=0 — the selector matched nothing, the post was recorded as
     * having no caption, and it was dropped as a shell. This fallback only
     * runs when the strict pass found nothing, so it can add captures and
     * never remove them.
     */
    return longestTextBlock(article, authorName, bar, "div, span, p");
  }

  function longestTextBlock(article, authorName, bar, selector) {
    var blocks = article.querySelectorAll(selector);
    var best = "";

    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (isBelowBar(el, bar)) continue;          // comments live below it

      // The action bar is not "above" itself, so the loose pass happily took
      // its own text — a caption-less post came back with a body of
      // "Like Comment Share", and every such post then hashed to the same id.
      if (bar && (el === bar || (bar.contains && bar.contains(el)))) continue;

      var text = el.innerText ? el.innerText.trim() : "";
      if (!text || text.length <= best.length) continue;
      if (CHROME_RE.test(text)) continue;
      if (isOnlyChrome(text)) continue;

      // The header block is just the author's name, sometimes with a timestamp.
      if (authorName && text.replace(/\s+/g, " ") === authorName) continue;
      if (authorName && text.indexOf(authorName) === 0 && text.length < authorName.length + 25) continue;

      // A block whose text is entirely a link is navigation, not post copy.
      var link = el.querySelector('a[role="link"]');
      if (link && (link.innerText || "").trim().length >= text.length - 2) continue;

      // Belt and braces: anything owned by a different article isn't ours.
      if (el.closest('div[role="article"]') !== article) continue;

      // In the loose pass this would otherwise pick the article's own
      // wrapper, whose text is the whole post plus all of its chrome.
      if (el.children && el.children.length > 6) continue;

      best = text;
    }
    return best.slice(0, 5000);
  }

  /* Is this token a count rather than a timestamp or a year?
   *
   * parseCount turns "5h" into 5 and "2024" into 2024, so a post's age would
   * otherwise be stored as its reaction count. h/d/w/y are unambiguously
   * time; lowercase m is minutes, uppercase M is millions, and Facebook is
   * consistent about the case.
   */
  function looksLikeACount(token) {
    var text = String(token || "").trim();
    if (!text) return false;
    if (/^\d+\s*[hdwy]$/i.test(text)) return false;
    if (/^\d+\s*m$/.test(text)) return false;
    if (/^(19|20)\d{2}$/.test(text.replace(/,/g, ""))) return false;
    if (/^\d{1,2}:\d/.test(text)) return false;
    if (/^\d{1,2}\/\d/.test(text)) return false;
    return /^\d[\d.,]*\s*[KMB]?$/.test(text);
  }

  /* The reaction summary with no wording attached.
   *
   * Every pattern above needs a word — "reactions", "likes", "reacted".
   * Facebook frequently renders the summary as a bare number beside the
   * emoji icons, so on those layouts nothing matched and every post landed
   * in the dashboard marked "not read".
   *
   * Only elements whose ENTIRE text is a count are considered, which is what
   * keeps a number inside the caption out: a caption is never exactly "312".
   * Runs only when the worded patterns found nothing, so it can add reads
   * and never remove them.
   */
  function bareCountAboveBar(article, bar) {
    var nodes = article.querySelectorAll(
      'span, div[dir="auto"], span[dir="auto"], div[role="button"]');
    var best = 0;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest('div[role="article"]') !== article) continue;
      if (isBelowBar(el, bar)) continue;
      if (el.children && el.children.length) continue;   // a leaf, not a box

      var text = (el.innerText || "").trim();
      if (!text || text.length > 12) continue;
      if (!looksLikeACount(text)) continue;

      // The reaction total is the largest bare number above the bar; comment
      // and share tallies carry their own words and are matched separately.
      var n = parseCount(text);
      if (n > best) best = n;
    }
    return best;
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
      /([\d][\d.,]*\s*[KMB]?)\s+likes?\b/i
    ]);

    result.comments = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s+comments?/i,
      /comments?:?\s*([\d][\d.,]*\s*[KMB]?)/i
    ]);

    result.shares = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s+shares?/i,
      /shares?:?\s*([\d][\d.,]*\s*[KMB]?)/i
    ]);

    if (!result.likes) result.likes = bareCountAboveBar(article, bar);

    result.video_plays = firstMatch([
      /([\d][\d.,]*\s*[KMB]?)\s+(?:views|plays)/i
    ]);

    // Last resort for reactions: a bare number sitting alone on its own line
    // just above the Like/Comment/Share row.
    if (!result.likes) {
      var loose = (article.innerText || "").match(/(?:^|\n)\s*([\d][\d.,]*\s*[KMB]?)\s*\n(?=[\s\S]{0,80}(?:Like|Comment|Share))/i);
      if (loose) result.likes = parseCount(loose[1]);
    }

    return result;
  }

  /* Visual content — restored after the V1.7 revert dropped it.
   *
   * What a post looked like is half of why it worked, and the dashboard has
   * rendered thumbnails all along while the extension stopped sending any.
   * Purely additive: this only fills extra fields on the payload and cannot
   * affect whether a post is captured.
   */
/* Words rendered into the graphic rather than typed.
   *
   * Facebook runs OCR for screen readers and publishes it in the image's
   * alt: "May be an image of text that says 'SALE ENDS FRIDAY'". A quote
   * card carries its whole message there, and discarding it meant capturing
   * the post as a caption-less shell.
   */
  var ALT_PREAMBLE_RE = /^(may be an image of|may be a graphic of|may be an? |image may contain:?|no photo description available)/i;

  function textFromAlt(alt) {
    var raw = String(alt || "").trim();
    if (!raw) return "";
    if (/^no photo description available/i.test(raw)) return "";
    if (/profile picture|avatar/i.test(raw)) return "";

    // "...and text that says 'WORDS'" — everything before the lead-in is
    // scene description, everything after is the transcription.
    var says = raw.match(/text that says[:\s]*([\s\S]+)/i);
    if (says) {
      var transcribed = says[1].trim().replace(/^["'‘’“”]+|["'‘’“”.]+$/g, "").trim();
      return transcribed.length >= 12 ? transcribed.slice(0, 5000) : "";
    }

    var quoted = raw.match(/["'‘’“”]([^"'‘’“”]{4,})["'‘’“”]/g);
    if (quoted && quoted.length) {
      var joined = quoted.map(function (chunk) {
        return chunk.replace(/^["'‘’“”]|["'‘’“”]$/g, "").trim();
      }).join(" ");
      if (joined.length >= 12) return joined.slice(0, 5000);
    }

    // What remains is either a generated scene description or one a person
    // wrote. Length is the only signal separating them.
    if (ALT_PREAMBLE_RE.test(raw)) return "";
    return raw.length >= 40 ? raw.slice(0, 5000) : "";
  }

  /* -------------------------------------------------------------- media -- */

  var MIN_MEDIA_PX = 130;

  function extractMedia(article, bar) {
    var images = article.querySelectorAll("img");
    var found = [];

    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (isBelowBar(img, bar)) continue;
      if (!owned(article, img)) continue;

      var src = img.currentSrc || img.src || "";
      if (!src || src.indexOf("data:") === 0) continue;
      if (!/scontent|fbcdn/i.test(src)) continue;

      // Avatars come from the same CDN; size is what separates them.
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
                   !!article.querySelector('a[href*="/reel/"], a[href*="/videos/"]');

    // Any image's alt may carry the transcription, not only the largest.
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

  /* Chat bubbles carry role="article" too, so an open Messenger conversation
   * was captured as posts. Only the two containers that are unambiguously
   * not a feed are excluded — anything broader is a guess about Facebook's
   * layout, and guesses like that are what stopped this capturing at all.
   */
  var NOT_FEED = '[aria-label*="Messenger" i], [role="dialog"]';

  function feedArticles() {
    var all = document.querySelectorAll('div[role="article"]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].closest(NOT_FEED)) continue;
      out.push(all[i]);
    }
    return out;
  }

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

    var articles = feedArticles();
    STATS.articles = articles.length;

    // Classify everything first. If not a single article scores as a post
    // while plenty exist, the signals have drifted rather than the page being
    // pure comments — fall back to "top-level article = post" so a scan
    // degrades instead of silently returning nothing.
    var verdicts = [];
    var postCount = 0;
    for (var v = 0; v < articles.length; v++) {
      var verdict;
      try {
        verdict = classify(articles[v]);
      } catch (err) {
        // One malformed article must not abort the classification pass and
        // take the whole sweep with it.
        verdict = { isPost: true, confident: false, why: "classify failed" };
        STATS.lastError = "classify failed: " +
          (err && err.message ? err.message : String(err)).slice(0, 60);
      }
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

    articles.forEach(function (article, articleIndex) {
      try {
        captureOne(article, articleIndex, source);
      } catch (err) {
        // scanPosts runs on a timer, so an exception here used to abort the
        // whole sweep and every sweep after it — silently, since the code
        // that would report it never ran.
        STATS.lastError = "article failed: " +
          (err && err.message ? err.message : String(err)).slice(0, 70);
        console.error("[Tallgrass] article failed:", err);
      }
    });

    STATS.queued = QUEUE.length;
    renderHud();
    return found;

    function captureOne(article, articleIndex, source) {
      var verdict = verdicts[articleIndex];

      /* Comments are counted and skipped, never captured.
       *
       * Facebook previews one or two replies under a post, chosen by "Most
       * relevant" — its own algorithm, not an engagement ranking. Ranking
       * two samples drawn from a hundred and ninety five by someone else is
       * not a ranking, so they are of no use here.
       *
       * The test is "am I SURE this is a comment", not "am I sure this is a
       * post". classify needs a score of 2 to call something a post, and an
       * article with no recognisable signals scores 0 — requiring positive
       * proof of post-ness is what once discarded everything and captured
       * nothing at all. Skipping only CONFIDENT comments (nested in another
       * article, an aria-label saying so, or a clearly negative score) keeps
       * the ambiguous ones, which is the safe direction to be wrong in.
       */
      if (verdict.confident && !verdict.isPost) {
        STATS.commentsSkipped++;
        return;
      }

      STATS.candidates++;

      var bar = findActionBar(article);
      var author = extractAuthor(article, bar);
      var body = extractBody(article, author.name, bar);
      var permalink = extractPermalink(article);
      var postId = extractPostId(article, permalink, body, author.name);

      if (!postId || SEEN.has(postId)) return;

      // Reject shells: no text, or "text" that is just the author's name
      // echoed out of the header.
      if (!body || body.length < 12) { STATS.skipped++; return; }
      if (body.replace(/\s+/g, " ") === author.name) { STATS.skipped++; return; }

      SEEN.add(postId);
      found++;

      var engagement = extractEngagement(article, bar);
      var media = extractMedia(article, bar);

      // Whether anything was actually read, as opposed to defaulting to zero.
      // Without it "0 reactions" claims the post got none, when the truth is
      // that nothing could be found — completely different facts, and the
      // dashboard's "readable %" depends on the distinction.
      var engagementRead = !!(engagement.likes || engagement.comments ||
                              engagement.shares || engagement.video_plays);
      if (engagementRead) STATS.withEngagement++;
      if (media.image_url || media.has_video) STATS.withMedia++;

      // Words rendered into the graphic rather than typed. Facebook runs OCR
      // for screen readers and publishes it in the image's alt.
      var bodyFromImage = false;
      if ((!body || body.length < 12) && media.image_text) {
        body = media.image_text;
        bodyFromImage = true;
      }
      logLine(engagement.likes + "r " +
              engagement.comments + "c " + engagement.shares + "s  " +
              body.slice(0, 30));

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
        video_plays: engagement.video_plays,
        item_type: "post",
        image_url: media.image_url,
        image_count: media.image_count,
        has_video: media.has_video,
        body_from_image: bodyFromImage ? 1 : 0,
        engagement_read: engagementRead ? 1 : 0
      });
    }
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

  /* ------------------------------------------------------ HUD */

  var hud, hudBody, hudBtn;

  function styleEl(el, styles) {
    // Assigning style properties directly rather than injecting a <style> tag,
    // because Facebook's CSP blocks stylesheet injection from content scripts.
    Object.keys(styles).forEach(function (key) { el.style[key] = styles[key]; });
  }

  var hudLog, hudEndpoint;

  function loadHudBox() {
    try {
      var saved = JSON.parse(localStorage.getItem("outlierHud") || "{}");
      return {
        width: saved.width || 380,
        height: saved.height || 460,
        right: saved.right !== undefined ? saved.right : 20,
        bottom: saved.bottom !== undefined ? saved.bottom : 20
      };
    } catch (e) {
      return { width: 380, height: 460, right: 20, bottom: 20 };
    }
  }

  function saveHudBox() {
    try {
      localStorage.setItem("outlierHud", JSON.stringify({
        width: parseInt(hud.style.width, 10),
        height: parseInt(hud.style.height, 10),
        right: parseInt(hud.style.right, 10),
        bottom: parseInt(hud.style.bottom, 10)
      }));
    } catch (e) { /* private mode — position just won't persist */ }
  }

  function buildHud() {
    var box = loadHudBox();

    hud = document.createElement("div");
    styleEl(hud, {
      position: "fixed",
      bottom: box.bottom + "px", right: box.right + "px",
      width: box.width + "px", height: box.height + "px",
      minWidth: "300px", minHeight: "240px",
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
    styleEl(title, { display: "inline-flex", alignItems: "baseline", gap: "0.45em" });

    var titleMain = document.createElement("span");
    titleMain.textContent = "Tallgrass";
    styleEl(titleMain, { fontWeight: "700", fontSize: "1.2em", letterSpacing: "-0.2px" });
    title.appendChild(titleMain);

    // A hosted install does not self-update, so the running build has to be
    // visible — otherwise there is no way to tell a fix that did not work
    // from a fix that never loaded.
    var titleVer = document.createElement("span");
    try {
      titleVer.textContent = "v" + chrome.runtime.getManifest().version;
    } catch (e) {
      titleVer.textContent = "v?";
    }
    styleEl(titleVer, { fontWeight: "600", fontSize: "0.78em", color: "#6ee7b7" });
    title.appendChild(titleVer);

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

    collapse.addEventListener("click", function () {
      var hidden = content.style.display === "none";
      content.style.display = hidden ? "flex" : "none";
      hud.style.height = hidden ? loadHudBox().height + "px" : "auto";
      collapse.textContent = hidden ? "–" : "+";
    });

    // Drag by the header. Position is kept in right/bottom so the panel stays
    // anchored the same way it was authored.
    var dragging = false, startX, startY, startRight, startBottom;
    header.addEventListener("mousedown", function (event) {
      if (event.target === close || event.target === collapse) return;
      dragging = true;
      startX = event.clientX; startY = event.clientY;
      startRight = parseInt(hud.style.right, 10);
      startBottom = parseInt(hud.style.bottom, 10);
      event.preventDefault();
    });
    document.addEventListener("mousemove", function (event) {
      if (!dragging) return;
      hud.style.right = Math.max(0, startRight - (event.clientX - startX)) + "px";
      hud.style.bottom = Math.max(0, startBottom - (event.clientY - startY)) + "px";
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
      whiteSpace: "pre",
      scrollbarWidth: "thin",
      scrollbarColor: "rgba(52,211,153,0.45) rgba(255,255,255,0.03)"
    });

    /* --- buttons --- */
    hudBtn = document.createElement("button");
    styleEl(hudBtn, {
      width: "100%", marginTop: "0.9em", padding: "0.8em", borderRadius: "9px",
      border: "none", cursor: "pointer", fontWeight: "700", fontSize: "1.05em",
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
    dash.addEventListener("click", function () {
      chrome.storage.local.get(["endpoint"], function (state) {
        window.open(state.endpoint || "http://localhost:5050", "_blank");
      });
    });

    rowBtns.appendChild(manual);
    rowBtns.appendChild(dash);


    // Stats and log share one scrollable region; the buttons are pinned below
    // it. Previously the stats block could not shrink, so as rows were added
    // it pushed the controls past the bottom edge of the panel.
    var scroller = document.createElement("div");
    styleEl(scroller, {
      flex: "1", minHeight: "0", overflowY: "auto", overflowX: "hidden",
      display: "flex", flexDirection: "column",
      // The bar sat directly over the right-hand column, clipping the very
      // numbers the panel exists to show.
      paddingRight: "0.7em",
      // Chrome's default bar is a wide light grey slab on a dark panel.
      // Set through element.style because Facebook's CSP rejects an
      // injected stylesheet, so ::-webkit-scrollbar rules are unavailable.
      scrollbarWidth: "thin",
      scrollbarColor: "rgba(52,211,153,0.6) rgba(255,255,255,0.04)"
    });

    scroller.appendChild(hudBody);
    scroller.appendChild(logLabel);
    scroller.appendChild(hudLog);

    content.appendChild(scroller);
    content.appendChild(hudBtn);
    content.appendChild(rowBtns);

    hud.appendChild(header);
    hud.appendChild(content);
    document.body.appendChild(hud);
  }

  function row(label, value, accent) {
    var line = document.createElement("div");
    styleEl(line, {
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      gap: "0.8em", padding: "0.3em 0", fontSize: "1.02em"
    });

    var l = document.createElement("span");
    l.textContent = label;
    // Was #567a67 — a thin grey measuring under 3:1 against this panel and
    // hard to read at 13px.
    styleEl(l, { color: "#b8d4c6", fontWeight: "600", flexShrink: "0" });

    var v = document.createElement("span");
    v.textContent = value;
    // Truncate rather than overflow: a long group name must not push its own
    // value out past the edge of the panel.
    styleEl(v, {
      color: accent || "#ffffff", fontWeight: "700",
      minWidth: "0", overflow: "hidden",
      textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right"
    });

    line.appendChild(l);
    line.appendChild(v);
    return line;
  }


  /* Write what the scanner is looking at to a file.
   *
   * Every extractor here has been tuned against a reconstruction of
   * Facebook's markup rather than the page itself, because the page is only
   * reachable from the browser that is signed in. That is why engagement
   * kept reading as zero and each fix was a guess. One click, one file in
   * Downloads, nothing sent anywhere.
   */
  function savePageReport() {
    var lines = [];
    var source = detectSource();
    var version = "?";
    try { version = chrome.runtime.getManifest().version; } catch (e) {}

    lines.push("TALLGRASS PAGE REPORT");
    lines.push("version : " + version);
    lines.push("url     : " + location.pathname);
    lines.push("source  : " + (source ? source.kind + " / " + source.name : "none"));
    lines.push("articles: " + document.querySelectorAll('div[role="article"]').length);
    lines.push("");

    var articles = feedArticles();
    var limit = Math.min(articles.length, 3);
    for (var i = 0; i < limit; i++) {
      var article = articles[i];
      var bar = findActionBar(article);
      var author = extractAuthor(article, bar);
      var body = extractBody(article, author.name, bar);
      var engagement = extractEngagement(article, bar);

      lines.push("======== ARTICLE " + (i + 1) + " ========");
      lines.push("verdict    : " + JSON.stringify(classify(article)));
      lines.push("action bar : " + (bar ? JSON.stringify(
        (bar.getAttribute("aria-label") || bar.textContent || "").slice(0, 40)) : "NOT FOUND"));
      lines.push("author     : " + (author.name || "NOT READ"));
      lines.push("caption    : " + (body ? body.length + " chars" : "NOT READ"));
      lines.push("engagement : " + engagement.likes + "r " + engagement.comments +
                 "c " + engagement.shares + "s" +
                 (engagement.likes || engagement.comments || engagement.shares
                    ? "" : "   <- NOTHING READ"));
      lines.push("dir=auto   : " +
        article.querySelectorAll('div[dir="auto"], span[dir="auto"]').length);
      lines.push("aria-labels: " + JSON.stringify(
        Array.prototype.slice.call(article.querySelectorAll("[aria-label]"))
          .map(function (el) { return el.getAttribute("aria-label"); })
          .filter(function (l) { return l && l.length < 70; })
          .slice(0, 20)));
      lines.push("");
      lines.push("--- visible text ---");
      lines.push((article.innerText || "").slice(0, 700));
      lines.push("");
      lines.push("--- markup ---");
      lines.push((article.outerHTML || "").slice(0, 50000));
      lines.push("");
    }

    var text = lines.join(String.fromCharCode(10));
    try {
      var link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      link.download = "tallgrass-page-report.txt";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      logLine("Saved tallgrass-page-report.txt to Downloads");
    } catch (e) {
      console.log(text);
      STATS.lastError = "Could not save the file — the report is in the console (F12).";
    }
    renderHud();
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
    // Which dashboard this is feeding. Without it you can scan happily into
    // localhost while reading a hosted dashboard and never see your posts.
    hudBody.appendChild(row("Sending to", endpointLabel || "…",
                            endpointLabel ? "#7fa693" : null));
    var where = source ? (source.kind === "group" ? "in this group"
                                                 : "on this profile") : "on page";
    hudBody.appendChild(row("Posts " + where, String(STATS.candidates)));
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

    // Captures that cannot be sent are the worst silent failure in the
    // product: the counter climbs, everything looks healthy, and the
    // dashboard stays empty.
    if (STATS.lastError) {
      var errBox = document.createElement("div");
      errBox.textContent = STATS.lastError;
      styleEl(errBox, {
        margin: "0.6em 0 0", padding: "0.55em 0.7em", borderRadius: "8px",
        background: "rgba(224,122,95,0.16)",
        border: "1px solid rgba(224,122,95,0.4)",
        color: "#ffb59d", fontSize: "0.92em", lineHeight: "1.45"
      });
      hudBody.appendChild(errBox);
    } else if (STATS.queued > 0 && STATS.sent === 0) {
      hudBody.appendChild(row("⚠ waiting to send", String(STATS.queued), "#d9b45f"));
    }

    hudLog.textContent = STATS.log.length
      ? STATS.log.join("\n")
      : "Nothing captured yet.\nPress Start auto-scroll.";

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
    extractPermalink: extractPermalink,
    extractTimestamp: extractTimestamp,
    parseCount: parseCount,
    scanPosts: scanPosts,
    // Not in the UI — a developer tool belongs in the console, not in the
    // product. Run __outlier.savePageReport() if the extractors need
    // debugging against a real page.
    savePageReport: savePageReport,
    // A function, not the object: STATS is reassigned when the source
    // changes, so a captured reference goes stale and reads as all zeros.
    stats: function () { return STATS; },
    queue: function () { return QUEUE; }
  };
})();
