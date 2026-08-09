/* Tallgrass — Facebook capture.
 *
 * Rewritten from scratch. The previous file grew through dozens of surgical
 * edits until it contained a hundred and fifty duplicated lines — so some
 * fixes were being applied to code the browser never ran — plus several
 * layers of heuristics that could each silently drop a post. This one is
 * built around three rules learned the hard way:
 *
 *   1. NEVER identify a post by a value that can collide. Two posts by the
 *      same author with no caption hashed to the same id, so a group of two
 *      hundred deduped down to three. A captured post is marked on the DOM
 *      element itself — one element, one post, collisions impossible.
 *
 *   2. NEVER skip a post to be clever. Every "skip it and get it next pass"
 *      optimisation has ended with posts skipped on every pass forever. Take
 *      what is on screen now.
 *
 *   3. NEVER let a heuristic be the only path. Author and caption each have
 *      a strict read and a loose fallback, and a post is kept if ANY of
 *      text, media or engagement was found.
 *
 * Facebook regenerates its class names per build, so nothing here keys off a
 * class — extraction hangs off ARIA roles, aria-labels and visible text.
 */

(function () {
  "use strict";

  if (window.__tallgrassLoaded) return;      // survive SPA re-injection
  window.__tallgrassLoaded = true;

  /* ------------------------------------------------------------- state -- */

  var QUEUE = [];
  var enabled = true;
  var autoScrolling = false;
  var scrollTimer = null;
  var idleScrolls = 0;
  var lastHeight = 0;   // document height, to tell 'no new posts' from 'nothing captured'
  var capturedCount = 0;
  var currentSourceId = null;
  var endpointLabel = null;
  var hasApiKey = false;
  var seq = 0;                        // tie-breaker for indistinguishable posts

  var DEFAULT_MAX_POSTS = 200;
  var DEFAULT_MAX_MINUTES = 10;
  var maxPosts = DEFAULT_MAX_POSTS;
  var maxMinutes = DEFAULT_MAX_MINUTES;
  var scanStartedAt = 0;

  // Marks an element as captured. Living on the node means it disappears
  // exactly when Facebook discards the node, which is the correct lifetime.
  var MARK = "__tallgrassCaptured";

  function blankStats() {
    return {
      articles: 0,        // article nodes inside the feed region
      skippedChat: 0,     // Messenger, dialogs, nav
      // Per-pass, reset at the top of every scan. These were cumulative
      // while `articles` was per-pass, so after a few sweeps the skip count
      // exceeded the on-screen count automatically and the panel reported
      // "all read as replies" whether or not that was true.
      skippedComment: 0,
      skippedEmpty: 0,
      unattributed: 0,
      firstSkip: null,    // why the first skipped item was skipped
      errors: 0,
      captured: 0,
      withEngagement: 0,
      withMedia: 0,
      withAuthor: 0,
      expanded: 0,        // "See more" clicks
      sent: 0,
      added: 0,
      queued: 0,
      lastError: null,
      done: null,
      log: []
    };
  }

  var STATS = blankStats();

  function logLine(text) {
    STATS.log.unshift(new Date().toLocaleTimeString().slice(0, 8) + "  " + text);
    if (STATS.log.length > 40) STATS.log.pop();
  }

  /* ------------------------------------------------------------ numbers -- */

  // No group post realistically clears this. A number above it is not a
  // count, and one such value wrecks the median for every post scored
  // against it.
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

  /* Is this token plausibly a count rather than a clock or a date?
   *
   * parseCount turns "5h" into 5 and "2024" into 2024, so a post's age was
   * being stored as its reaction count. h/d/w/y are unambiguously time;
   * lowercase m is minutes, uppercase M is millions, and Facebook is
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

  /* ------------------------------------------------------------- source -- */

  var RESERVED_SLUGS = [
    "", "watch", "marketplace", "groups", "home.php", "gaming", "events",
    "notifications", "messages", "friends", "saved", "settings", "bookmarks",
    "search", "stories", "reel", "reels", "video", "photo", "help", "policies",
    "privacy", "login", "recover", "pages", "business", "ads"
  ];

  // Facebook renders several <h1>s, so reading the first names every group
  // "Notifications". The document title is the reliable source.
  function nameFromTitle(fallback) {
    var title = (document.title || "")
      .replace(/^\(\d+\+?\)\s*/, "")                  // unread badge
      .replace(/\s*\|\s*Facebook\s*$/i, "")
      .trim();
    if (title.indexOf("|") !== -1) title = title.split("|")[0].trim();

    var junk = ["", "Facebook", "Notifications", "Home", "Watch", "Marketplace",
                "Groups", "Feed", "Your Groups", "Groups Feed"];
    if (title && junk.indexOf(title) === -1) return title.slice(0, 120);
    return fallback;
  }

  // A page and a profile share a URL shape, so the DOM decides. Getting it
  // wrong costs a label and nothing else — scoring keys off identity.
  function looksLikeAPage() {
    var main = document.querySelector('div[role="main"]') || document.body;
    var text = (main.innerText || "").slice(0, 1200);
    if (/\b(followers|following)\b/i.test(text) && !/\bfriends\b/i.test(text)) return true;
    return !!document.querySelector('div[aria-label="Like"], div[aria-label="Follow"]');
  }

  /* Where are we, and can one source describe everything on screen?
   *
   * A group or profile timeline is one source per page. The feeds are not —
   * consecutive posts come from different places, so each is attributed
   * individually and the page-level source is marked perPost.
   */
  function detectSource() {
    var url = location.href;
    var path = location.pathname.replace(/\/+$/, "");

    if (/^\/groups\/feed$/.test(path)) {
      return { fb_id: "feed:groups", kind: "feed", name: "Groups feed",
               url: location.origin + "/groups/feed", perPost: true };
    }

    var groupMatch = url.match(/\/groups\/([^/?#]+)/);
    if (groupMatch && groupMatch[1] !== "feed") {
      var slug = groupMatch[1];
      var name = nameFromTitle(null);
      if (!name) {
        var self = document.querySelector('a[href*="/groups/' + slug + '"]');
        var text = self ? (self.textContent || "").trim() : "";
        if (text && text.length < 120) name = text;
      }
      return {
        fb_id: "group:" + slug, kind: "group",
        name: name || ("Facebook group " + slug),
        url: location.origin + "/groups/" + slug
      };
    }

    if (path === "" || path === "/home.php") {
      return { fb_id: "feed:home", kind: "feed", name: "Home feed",
               url: location.origin + "/", perPost: true };
    }

    var numericId = (url.match(/profile\.php\?id=(\d+)/) || [])[1];
    if (numericId) {
      return {
        fb_id: "profile:" + numericId,
        kind: looksLikeAPage() ? "page" : "profile",
        name: nameFromTitle("Facebook profile " + numericId),
        url: location.origin + "/profile.php?id=" + numericId
      };
    }

    var legacyPage = url.match(/\/pages\/[^/]+\/(\d+)/);
    if (legacyPage) {
      return {
        fb_id: "page:" + legacyPage[1], kind: "page",
        name: nameFromTitle("Facebook page " + legacyPage[1]),
        url: location.origin + "/" + legacyPage[1]
      };
    }

    var vanity = (path.match(/^\/([^/?#]+)/) || [])[1] || "";
    if (vanity && RESERVED_SLUGS.indexOf(vanity.toLowerCase()) === -1) {
      var isPage = looksLikeAPage();
      return {
        fb_id: (isPage ? "page:" : "profile:") + vanity,
        kind: isPage ? "page" : "profile",
        name: nameFromTitle(vanity),
        url: location.origin + "/" + vanity
      };
    }

    return null;
  }

  /* -------------------------------------------------------- the articles -- */

  /* Chat bubbles carry role="article" too, so an open Messenger conversation
   * was being captured as posts. Dialogs, notification flyouts and the
   * composer are the same problem, and all of them live outside main.
   */
  var NOT_FEED =
    '[aria-label*="Messenger" i], [aria-label*="Chat" i], [role="dialog"], ' +
    '[role="complementary"], [role="banner"], [role="navigation"]';

  function feedArticles() {
    var main = document.querySelector('div[role="main"]') || document.body;
    var all = main.querySelectorAll('div[role="article"]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].closest(NOT_FEED)) { STATS.skippedChat++; continue; }
      out.push(all[i]);
    }
    return out;
  }

  /* A reply, definitively.
   *
   * Not "probably a post" — the burden of proof sits on calling something a
   * comment, because a comment stored as a post is a visible wart while a
   * post dropped is invisible. An earlier scoring classifier needed positive
   * evidence of post-ness and discarded anything it could not recognise.
   */
  function commentVerdict(article) {
    var label = article.getAttribute("aria-label") || "";
    if (/^(comment|reply) by/i.test(label)) return "aria-label says so";

    var nested = !!(article.parentElement &&
                    article.parentElement.closest('div[role="article"]'));
    if (!nested) return null;

    /* Nested is NOT proof on its own.
     *
     * Facebook wraps feed items, and a shared post renders the original
     * inside the sharer's article, so "nested" caught real posts too — and
     * because it returned early, the panel reported every item as a reply
     * and captured nothing.
     *
     * A post carries a Share control; a reply carries Reply and never Share.
     * Require that positive evidence before discarding anything.
     */
    var hasShare = !!ownQuery(article,
      '[aria-label*="Share" i], [aria-label*="Send this to friends" i]');
    if (hasShare) return null;

    var hasReply = !!ownQuery(article, '[aria-label*="Reply" i]');
    if (hasReply) return "nested, has Reply, no Share";

    return null;      // nested but unrecognisable — capture it
  }

  // The first descendant matching `selector` that belongs to THIS article.
  function ownQuery(article, selector) {
    var found = article.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) {
      if (owned(article, found[i])) return found[i];
    }
    return null;
  }

  function isDefinitelyAComment(article) {
    return !!commentVerdict(article);
  }

  // Elements owned by THIS article, not by a reply nested inside it.
  // querySelector searches all descendants, and a post contains its own
  // comments — which is how a post was once identified by its replies.
  function owned(article, el) {
    return el.closest('div[role="article"]') === article;
  }

  /* The Like/Comment/Share bar. Everything below it belongs to the replies,
   * which is how a comment's text once became a post's caption.
   */
  function findActionBar(article) {
    var buttons = article.querySelectorAll('div[role="button"], span[role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      if (!owned(article, el)) continue;
      var label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (label === "like" || label === "comment" || label === "share") return el;
      var text = (el.textContent || "").trim().toLowerCase();
      if (/^like\b/.test(text) && text.length < 40) return el;
    }
    return null;
  }

  function isBelowBar(el, bar) {
    if (!bar || !el) return false;
    return !!(bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  /* ---------------------------------------------------------- expansion -- */

  /* Facebook clamps a long caption behind "See more", and reading innerText
   * off a clamped post stores a fragment. Expanding is a local DOM toggle —
   * no request, nothing written, nothing anyone else can see.
   *
   * The click happens and the scan continues in the SAME pass. Deferring to
   * the next sweep meant a post whose control did not vanish was skipped on
   * every pass forever.
   */
  function expandCaption(article, bar) {
    var buttons = article.querySelectorAll('div[role="button"], span[role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      if (isBelowBar(el, bar)) continue;              // a reply's expander
      if (!owned(article, el)) continue;
      if (!/^see more$/i.test((el.textContent || "").trim())) continue;
      try { el.click(); STATS.expanded++; } catch (e) { /* detached node */ }
      return true;
    }
    return false;
  }

  /* --------------------------------------------------------------- text -- */

  var CHROME_RE = /^(like|comment|share|reply|see more|see less|all reactions|most relevant|top comments|newest|write a comment|view more comments|·|\d+[hdwmy])$/i;
  var NOT_A_NAME = /^(like|comment|share|reply|see more|follow|join|group|admin|moderator|top contributor|author|·|\d+[hdwmy]|anonymous participant)$/i;

  /* The caption: the longest text block above the action bar.
   *
   * Returns the element as well, because engagement extraction has to
   * exclude it — that exclusion is the whole guard against reading a number
   * out of the post's own words and storing it as a reaction count.
   */
  function extractBody(article, authorName, bar) {
    var strict = captionPass(article, authorName, bar);
    if (strict.text) return strict;

    // Nothing above the bar. Either there is no caption, or findActionBar
    // latched onto something near the top and declared the whole post to be
    // below it. Retry without the cutoff rather than drop the post.
    return captionPass(article, authorName, null);
  }

  function captionPass(article, authorName, bar) {
    var found = pickLongestText(
      article, authorName, bar, 'div[dir="auto"], span[dir="auto"]');
    if (found.text) return found;

    /* dir="auto" is a convention, not a guarantee.
     *
     * Facebook does not put it on every caption, and when it is missing the
     * strict selector matched nothing — so a post with plenty of visible
     * text was recorded as empty and thrown away. Fall back to any leaf-ish
     * block: a div or span that holds text rather than more elements.
     */
    return pickLongestText(article, authorName, bar, "div, span, p");
  }

  function pickLongestText(article, authorName, bar, selector) {
    var blocks = article.querySelectorAll(selector);
    var best = "";
    var bestEl = null;

    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (isBelowBar(el, bar)) continue;
      if (!owned(article, el)) continue;

      var text = (el.innerText || "").trim();
      if (!text || text.length <= best.length) continue;
      if (CHROME_RE.test(text)) continue;
      if (authorName && text.replace(/\s+/g, " ") === authorName) continue;
      if (authorName && text.indexOf(authorName) === 0 &&
          text.length < authorName.length + 25) continue;

      // A block whose text is entirely a link is navigation, not copy.
      var link = el.querySelector('a[role="link"]');
      if (link && (link.innerText || "").trim().length >= text.length - 2) continue;

      // In the loose pass this would otherwise pick the article's own
      // wrapper, whose text is the whole post plus its chrome.
      if (el.children && el.children.length > 6) continue;

      best = text;
      bestEl = el;
    }
    return { text: best.slice(0, 5000), el: bestEl };
  }

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

  /* ------------------------------------------------------------- author -- */

  function extractAuthor(article, bar) {
    var strict = authorPass(article, bar);
    if (strict) return strict;

    // findActionBar can latch high in the article, putting everything
    // "below" it. Retry unbounded rather than attribute the post to nobody.
    var loose = authorPass(article, null);
    if (loose) return loose;

    // Some layouts render the name as a plain heading rather than a link,
    // and giving up here put "Author not captured" on every card.
    var headings = article.querySelectorAll("h2, h3, h4, strong");
    for (var i = 0; i < headings.length; i++) {
      var node = headings[i];
      if (!owned(article, node)) continue;
      var name = (node.textContent || "").trim().replace(/\s+/g, " ");
      if (!name || name.length < 2 || name.length > 80) continue;
      if (NOT_A_NAME.test(name) || CHROME_RE.test(name)) continue;
      if (/^\d[\d.,]*\s*[KMB]?$/.test(name)) continue;
      return { name: name, url: null };
    }

    // null, never "Unknown" — the dashboard has to tell a missing author
    // from a person actually called that.
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
      if (!owned(article, el)) continue;

      var text = (el.textContent || "").trim().replace(/\s+/g, " ");
      var anchor = el.tagName === "A" ? el : el.closest("a");
      var href = (anchor && anchor.href) || "";

      if (!text || text.length < 2 || text.length > 80) continue;
      if (NOT_A_NAME.test(text)) continue;
      if (text.charAt(0) === "#") continue;
      // A link into the group is the group's name, not a person's.
      if (href.indexOf("/groups/") !== -1 && href.indexOf("/user/") === -1) continue;
      if (/^\d[\d.,:\s]*$/.test(text)) continue;

      return { name: text, url: href ? href.split("?")[0] : null };
    }
    return null;
  }

  /* --------------------------------------------------------- engagement -- */

  /* The guard is structural: read everything above the action bar EXCEPT the
   * caption element and its descendants.
   *
   * Restricting this to aria-labels carrying an engagement word did stop a
   * caption reading "processed 11,000,000 tokens" from becoming the reaction
   * count — and then read nothing at all on layouts without those labels, so
   * every group reported 0% readable. The caption is the only place a
   * fabricated count ever came from. Exclude it, and nothing else.
   */
  function engagementStrings(article, bar, captionEl) {
    var out = [];
    var i, el, text;

    var labelled = article.querySelectorAll("[aria-label]");
    for (i = 0; i < labelled.length; i++) {
      el = labelled[i];
      if (!owned(article, el)) continue;
      if (isBelowBar(el, bar)) continue;               // per-reply counts
      var label = el.getAttribute("aria-label") || "";
      if (!label || label.length > 120) continue;
      if (ALT_PREAMBLE_RE.test(label)) continue;       // generated image prose
      if (!/\d/.test(label)) continue;
      out.push(label);
    }

    var blocks = article.querySelectorAll(
      'span, div[dir="auto"], span[dir="auto"], div[role="button"]'
    );
    for (i = 0; i < blocks.length; i++) {
      el = blocks[i];
      if (!owned(article, el)) continue;
      if (isBelowBar(el, bar)) continue;
      if (withinCaption(el, captionEl)) continue;      // never the post's copy
      if (el.children && el.children.length > 3) continue;   // a container
      text = (el.innerText || "").trim().replace(/\s+/g, " ");
      if (!text || text.length > 48 || !/\d/.test(text)) continue;
      out.push(text);
    }
    return out;
  }

  function withinCaption(el, captionEl) {
    if (!captionEl || !el) return false;
    var node = el;
    while (node) {
      if (node === captionEl) return true;
      node = node.parentElement;
    }
    return false;
  }

  function extractEngagement(article, bar, captionEl) {
    var result = { likes: 0, comments: 0, shares: 0, video_plays: 0, read: false };
    var parts = engagementStrings(article, bar, captionEl);
    var haystack = parts.join("\n");

    // Gaps are [ \t]* rather than \s* because the strings are newline-joined:
    // with "312 reactions" and "47 comments" on consecutive lines, \s* matched
    // the word on one line and the number on the next, recording 312 as 47.
    function first(patterns) {
      for (var p = 0; p < patterns.length; p++) {
        var m = haystack.match(patterns[p]);
        if (m) {
          var n = parseCount(m[1]);
          if (n) return n;
        }
      }
      return 0;
    }

    result.likes = first([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+reactions?/i,
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]*(?:people[ \t]+)?reacted/i,
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+likes?\b/i,
      /and[ \t]+([\d][\d.,]*[ \t]*[KMB]?)[ \t]+others?/i,
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+others?[ \t]+reacted/i,
      /See who reacted[^\d\n]*([\d][\d.,]*[ \t]*[KMB]?)/i,
      /All reactions:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i,
      /(?:Like|reaction)s?:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i
    ]);
    result.comments = first([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+comments?/i,
      /comments?:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i
    ]);
    result.shares = first([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+shares?/i,
      /shares?:[ \t]*([\d][\d.,]*[ \t]*[KMB]?)/i
    ]);
    result.video_plays = first([
      /([\d][\d.,]*[ \t]*[KMB]?)[ \t]+(?:views?|plays?)/i
    ]);

    // The reaction summary often carries no wording at all — just the number
    // beside the icons — so take a bare count from the vetted strings.
    if (!result.likes) {
      for (var h = 0; h < parts.length; h++) {
        var token = parts[h].split(/[\s·•|]+/)[0];
        if (!looksLikeACount(token)) continue;
        var n = parseCount(token);
        if (n) { result.likes = n; break; }
      }
    }

    // There is deliberately no fallback for the comment count. One used to
    // take every number in the post and call the largest below the reaction
    // total the comment count, so "we closed 12 deals" became 12 comments —
    // a number nobody measured, weighted 3x into the score.
    result.read = !!(result.likes || result.comments || result.shares ||
                     result.video_plays);
    return result;
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

  /* ----------------------------------------------------------- identity -- */

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

  function parseRelativeTime(label) {
    var match = label.match(/(\d+)\s*(m|h|d|w|y)\b/i);
    if (!match) return null;
    var amount = parseInt(match[1], 10);
    var msPer = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 };
    var unit = match[2].toLowerCase();
    if (!msPer[unit]) return null;
    return new Date(Date.now() - amount * msPer[unit]).toISOString().slice(0, 19);
  }

  function extractTimestamp(article) {
    var abbr = article.querySelector("abbr[data-utime]");
    if (abbr) {
      var utime = parseInt(abbr.getAttribute("data-utime"), 10);
      if (utime) return new Date(utime * 1000).toISOString().slice(0, 19);
    }
    var links = article.querySelectorAll('a[aria-label], abbr[title], a[href*="/posts/"]');
    for (var i = 0; i < links.length; i++) {
      var label = links[i].getAttribute("aria-label") ||
                  links[i].getAttribute("title") ||
                  (links[i].textContent || "");
      var parsed = parseRelativeTime(String(label).trim());
      if (parsed) return parsed;
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

  /* The id the dashboard stores under.
   *
   * The permalink when Facebook exposes one — it usually only does on hover.
   * Otherwise a hash of everything distinguishing. If that comes out thin, a
   * sequence number is added: two rows for one post is a visible, deletable
   * problem, whereas a colliding id silently merges hundreds of posts into
   * one, which is what pinned the counter at 3.
   */
  function buildPostId(permalink, body, author, extra) {
    if (permalink) {
      var idMatch = permalink.match(/(?:posts|permalink|videos|reel)\/(\d+)/);
      return idMatch ? idMatch[1] : permalink;
    }
    var parts = [author || "", (body || "").slice(0, 200),
                 extra.posted || "", extra.image || "", extra.counts || ""];
    var distinct = parts.filter(function (x) { return x; }).length;
    if (distinct < 2) parts.push("s" + (seq++));
    return "h" + hashString(parts.join("|"));
  }

  /* ---------------------------------------------------------------- scan -- */

  /* Which source a single article belongs to.
   *
   * On a one-source page this is that source. On a feed it has to come out of
   * the post's own header, because the next post down is from somewhere else
   * and a baseline is only meaningful against posts from the same place.
   */
  function sourceForArticle(article, pageSource) {
    if (!pageSource || !pageSource.perPost) return pageSource;

    var bar = findActionBar(article);

    var links = article.querySelectorAll('a[href*="/groups/"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (isBelowBar(link, bar) || !owned(article, link)) continue;
      var slug = (link.getAttribute("href") || "").match(/\/groups\/([^/?#]+)/);
      if (!slug || slug[1] === "feed") continue;
      var label = (link.textContent || "").trim();
      if (!label || label.length > 120 || CHROME_RE.test(label)) continue;
      return { fb_id: "group:" + slug[1], kind: "group", name: label,
               url: location.origin + "/groups/" + slug[1] };
    }

    var author = extractAuthor(article, bar);
    if (author.url && author.name) {
      var tail = author.url.split("?")[0].replace(/\/+$/, "").split("/").pop();
      var id = (author.url.match(/id=(\d+)/) || [])[1] || tail;
      if (id && RESERVED_SLUGS.indexOf(String(id).toLowerCase()) === -1) {
        return { fb_id: "profile:" + id, kind: "profile",
                 name: author.name, url: author.url };
      }
    }

    // Unattributable on a feed. Filing it under "Home feed" would score
    // unrelated posts against one shared median.
    return null;
  }

  function scanPosts() {
    try {
      return scanPostsInner();
    } catch (err) {
      // Even the setup can throw — detectSource, feedArticles, a selector
      // Chrome rejects. Silently, from inside setInterval.
      STATS.errors++;
      STATS.lastError = "scan failed: " +
        (err && err.message ? err.message : String(err)).slice(0, 80);
      console.error("[Tallgrass] scan failed:", err);
      try { renderHud(); } catch (e) { /* nothing left to do */ }
      return 0;
    }
  }

  function scanPostsInner() {
    if (!enabled) return 0;

    var source = detectSource();
    if (!source) return 0;

    // Counters belong to one source; carrying them across a navigation makes
    // it look like posts were captured here that came from somewhere else.
    if (source.fb_id !== currentSourceId) {
      currentSourceId = source.fb_id;
      QUEUE = [];
      STATS = blankStats();
      capturedCount = 0;
      logLine("— " + source.name.slice(0, 30) + " —");
    }

    var articles = feedArticles();
    STATS.articles = articles.length;
    STATS.skippedComment = 0;
    STATS.skippedEmpty = 0;
    STATS.unattributed = 0;
    STATS.firstSkip = null;
    STATS.errors = 0;

    for (var i = 0; i < articles.length; i++) {
      try {
        captureArticle(articles[i], source);
      } catch (err) {
        /* One article must never take the sweep down with it.
         *
         * scanPosts runs from setInterval, so an exception anywhere in it
         * aborted the whole pass and every pass after — the counter sat at
         * zero and the panel showed nothing, because the code that would
         * have reported the problem never ran either. Now the failure is
         * per-article and it is visible.
         */
        STATS.errors++;
        if (!STATS.lastError) {
          STATS.lastError = (err && err.message ? err.message : String(err)).slice(0, 90);
        }
        console.error("[Tallgrass] article failed:", err);
      }
    }

    STATS.queued = QUEUE.length;
    renderHud();
    return STATS.captured;
  }

  function captureArticle(article, source) {
    {
      // One element, one post. No hash, so nothing can collide.
      if (article[MARK]) return;

      var commentReason = commentVerdict(article);
      if (commentReason) {
        STATS.skippedComment++;
        if (!STATS.firstSkip) STATS.firstSkip = "reply: " + commentReason;
        return;
      }

      var postSource = sourceForArticle(article, source);
      if (!postSource) {
        STATS.unattributed++;
        if (!STATS.firstSkip) STATS.firstSkip = "no source could be identified";
        return;
      }

      var bar = findActionBar(article);

      // Expand, then read what is on screen NOW.
      expandCaption(article, bar);

      var author = extractAuthor(article, bar);
      var caption = extractBody(article, author.name, bar);
      var body = caption.text;
      var engagement = extractEngagement(article, bar, caption.el);
      var media = extractMedia(article, bar);

      var fromImage = false;
      if ((!body || body.length < 12) && media.image_text) {
        body = media.image_text;                     // Facebook's own OCR
        fromImage = true;
      }
      if (body && author.name && body.replace(/\s+/g, " ") === author.name) body = "";

      var hasText = !!body && body.length >= 12;
      var hasMedia = !!(media.image_url || media.has_video);

      // A shell has none of the three. Requiring a caption discarded
      // image-only posts, memes and short reactions — often a group's best
      // performers, so it biased the baseline as well as losing rows.
      if (!hasText && !hasMedia && !engagement.read) {
        STATS.skippedEmpty++;
        if (!STATS.firstSkip) {
          /* What was in there, in one line.
           *
           * "empty" alone gave no way to tell an article with no text from
           * one whose text the selectors could not see — completely
           * different problems. This reports both the shape and the actual
           * visible text, so the next fix is aimed rather than guessed.
           */
          var raw = (article.innerText || "").replace(/\s+/g, " ").trim();
          STATS.firstSkip = "empty · dirAuto=" +
            article.querySelectorAll('div[dir="auto"], span[dir="auto"]').length +
            " spans=" + article.querySelectorAll("span").length +
            " bar=" + (bar ? "y" : "n") +
            " text=\"" + raw.slice(0, 60) + "\"";
        }
        return;
      }

      var permalink = extractPermalink(article);
      var posted = extractTimestamp(article);
      var postId = buildPostId(permalink, body, author.name || "", {
        posted: posted || "",
        image: media.image_url || "",
        counts: [engagement.likes, engagement.comments, engagement.shares].join(",")
      });

      article[MARK] = true;
      capturedCount++;
      STATS.captured++;
      if (engagement.read) STATS.withEngagement++;
      if (hasMedia) STATS.withMedia++;
      if (author.name) STATS.withAuthor++;

      logLine(engagement.likes + "r " + engagement.comments + "c " +
              engagement.shares + "s  " + (body || "(no caption)").slice(0, 28));

      QUEUE.push({
        fb_post_id: postSource.fb_id + "-" + postId,
        body: body,
        permalink: permalink,
        post_type: extractPostType(article),
        posted_at: posted,
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
        body_from_image: fromImage ? 1 : 0,
        engagement_read: engagement.read ? 1 : 0,
        // Only when it differs from the batch's source: on a single group
        // every post shares one, and repeating it would bloat the payload.
        source: postSource.fb_id === source.fb_id ? undefined : {
          fb_id: postSource.fb_id, kind: postSource.kind,
          name: postSource.name, url: postSource.url
        }
      });
    }
  }

  /* ---------------------------------------------------------------- send -- */

  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  function flush() {
    if (!QUEUE.length) return;

    var source = detectSource();
    if (!source) { QUEUE = []; return; }

    var batch = QUEUE.splice(0, QUEUE.length);
    STATS.queued = 0;

    if (!contextAlive()) {
      QUEUE = batch.concat(QUEUE);
      STATS.lastError = "Extension was reloaded — refresh this tab.";
      renderHud();
      return;
    }

    chrome.runtime.sendMessage(
      { type: "OUTLIER_CAPTURE", source: source, posts: batch },
      function (response) {
        if (chrome.runtime.lastError) {
          STATS.lastError = "Extension worker asleep — retrying";
          QUEUE = batch.concat(QUEUE);          // never lose the batch
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
        renderHud();
      }
    );
  }

  /* ----------------------------------------------------------------- HUD -- */

  var hud, hudBody, hudLog, hudBtn, saveBtn;

  function styleEl(el, styles) {
    // Assigned directly rather than through a <style> tag: Facebook's CSP
    // blocks stylesheet injection from a content script.
    Object.keys(styles).forEach(function (k) { el.style[k] = styles[k]; });
  }

  function row(label, value, accent) {
    var line = document.createElement("div");
    styleEl(line, { display: "flex", justifyContent: "space-between",
                    padding: "0.3em 0", fontSize: "1.02em" });

    var l = document.createElement("span");
    l.textContent = label;
    // Was #567a67, which measured under 3:1 here and was hard to read.
    styleEl(l, { color: "#b8d4c6", fontWeight: "600",
                 flexShrink: "0", marginRight: "0.6em" });

    var v = document.createElement("span");
    v.textContent = value;
    styleEl(v, { color: accent || "#ffffff", fontWeight: "700",
                 minWidth: "0", overflow: "hidden",
                 textOverflow: "ellipsis", whiteSpace: "nowrap" });

    line.appendChild(l);
    line.appendChild(v);
    return line;
  }

  function buildHud() {
    hud = document.createElement("div");
    styleEl(hud, {
      position: "fixed", top: "80px", right: "18px",
      width: "430px", height: "560px",
      minWidth: "340px", minHeight: "320px",
      maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)",
      zIndex: "2147483647", display: "flex", flexDirection: "column",
      borderRadius: "14px", overflow: "hidden",
      background: "rgba(7, 20, 13, 0.97)",
      border: "1px solid rgba(110,231,183,0.32)",
      boxShadow: "0 16px 48px rgba(0,0,0,0.6)", color: "#eafff3",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "13px", lineHeight: "1.5", resize: "both"
    });

    var header = document.createElement("div");
    styleEl(header, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0.85em 1.1em", cursor: "move", flexShrink: "0",
      borderBottom: "1px solid rgba(110,231,183,0.18)",
      background: "rgba(16,48,31,0.6)"
    });

    var title = document.createElement("span");
    styleEl(title, { display: "inline-flex", alignItems: "baseline", gap: "0.45em" });

    var titleMain = document.createElement("span");
    titleMain.textContent = "Tallgrass";
    styleEl(titleMain, { fontWeight: "700", fontSize: "1.2em", letterSpacing: "-0.2px" });
    title.appendChild(titleMain);

    /* The running version, in the panel.
     *
     * A hosted install does NOT self-update: reloading at chrome://extensions
     * re-reads whatever is in the folder, so unless a fresh zip was unzipped
     * over it the browser keeps running the old build. Days were spent
     * shipping fixes with no way to tell whether the fix was even loaded.
     */
    var titleVer = document.createElement("span");
    try {
      titleVer.textContent = "v" + chrome.runtime.getManifest().version;
    } catch (e) {
      titleVer.textContent = "v?";
    }
    styleEl(titleVer, { fontWeight: "600", fontSize: "0.78em", color: "#6ee7b7" });
    title.appendChild(titleVer);

    var close = document.createElement("span");
    close.textContent = "×";
    close.title = "Hide";
    styleEl(close, { cursor: "pointer", opacity: "0.6", fontSize: "1.5em", lineHeight: "1" });
    close.addEventListener("click", function () { hud.style.display = "none"; });

    header.appendChild(title);
    header.appendChild(close);

    var content = document.createElement("div");
    styleEl(content, { display: "flex", flexDirection: "column", flex: "1",
                       padding: "1em 1.1em", overflow: "hidden", minHeight: "0" });

    hudBody = document.createElement("div");
    styleEl(hudBody, { flexShrink: "0" });

    hudLog = document.createElement("pre");
    styleEl(hudLog, {
      flex: "1", minHeight: "0", overflow: "auto", margin: "0.7em 0 0",
      padding: "0.6em 0.7em", fontSize: "11.5px", lineHeight: "1.45",
      background: "rgba(0,0,0,0.28)", borderRadius: "8px",
      color: "#9fc7b2", whiteSpace: "pre-wrap", wordBreak: "break-word",
      scrollbarWidth: "thin", scrollbarColor: "rgba(52,211,153,0.55) transparent"
    });

    hudBtn = document.createElement("button");
    styleEl(hudBtn, {
      width: "100%", marginTop: "0.8em", padding: "0.8em", borderRadius: "9px",
      border: "none", cursor: "pointer", fontWeight: "700", fontSize: "1.05em",
      flexShrink: "0"
    });
    hudBtn.addEventListener("click", function () {
      if (autoScrolling) stopAutoScroll("Stopped");
      else startAutoScroll();
    });

    /* Save the raw markup of what the scanner is looking at.
     *
     * Facebook's HTML differs by account, locale and A/B bucket, and it
     * cannot be reached from anywhere except this browser. Without it every
     * fix to the extractors is a guess — which is exactly how this went for
     * days. The file lands in Downloads; nothing is transmitted anywhere.
     */
    saveBtn = document.createElement("button");
    saveBtn.textContent = "Save what it sees (for support)";
    styleEl(saveBtn, {
      width: "100%", marginTop: "0.5em", padding: "0.65em", borderRadius: "8px",
      border: "1px solid rgba(217,180,95,0.45)", cursor: "pointer",
      background: "rgba(217,180,95,0.12)", color: "#e8c66f",
      fontSize: "0.92em", flexShrink: "0", display: "none"
    });
    saveBtn.addEventListener("click", savePageReport);

    var manual = document.createElement("button");
    manual.textContent = "Scan what's on screen";
    styleEl(manual, {
      width: "100%", marginTop: "0.5em", padding: "0.65em", borderRadius: "8px",
      border: "1px solid rgba(110,231,183,0.24)", cursor: "pointer",
      background: "transparent", color: "#9fc7b2", fontSize: "0.92em",
      flexShrink: "0"
    });
    manual.addEventListener("click", function () { scanPosts(); flush(); });

    content.appendChild(hudBody);
    content.appendChild(hudLog);
    content.appendChild(hudBtn);
    content.appendChild(manual);
    content.appendChild(saveBtn);

    hud.appendChild(header);
    hud.appendChild(content);
    document.body.appendChild(hud);

    makeDraggable(hud, header);
  }

  function makeDraggable(panel, handle) {
    var dragging = false, offsetX = 0, offsetY = 0;
    handle.addEventListener("mousedown", function (e) {
      dragging = true;
      var box = panel.getBoundingClientRect();
      offsetX = e.clientX - box.left;
      offsetY = e.clientY - box.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      panel.style.left = Math.max(0, e.clientX - offsetX) + "px";
      panel.style.top = Math.max(0, e.clientY - offsetY) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", function () { dragging = false; });
  }

  function renderHud() {
    if (!hud) return;
    hudBody.textContent = "";

    var source = detectSource();
    var KINDS = { group: "Group", profile: "Profile", page: "Page", feed: "Feed" };
    hudBody.appendChild(row(
      source ? (KINDS[source.kind] || "Source") : "Page",
      source ? source.name.slice(0, 26) : "not a supported page",
      source ? "#6ee7b7" : "#e07a5f"
    ));

    var mode = !enabled ? "Paused" : (autoScrolling ? "Auto-scrolling" : "Capturing");
    hudBody.appendChild(row("Status", mode, enabled ? "#6ee7b7" : "#e07a5f"));
    hudBody.appendChild(row("Dashboard",
      hasApiKey ? (endpointLabel || "…") : "not connected",
      hasApiKey ? "#b8d4c6" : "#d9b45f"));

    hudBody.appendChild(row("Captured", capturedCount + " / " + maxPosts,
      capturedCount >= maxPosts ? "#6ee7b7" : null));
    hudBody.appendChild(row("Sent to dashboard", String(STATS.sent)));
    hudBody.appendChild(row("New (not duplicates)", String(STATS.added), "#6ee7b7"));

    var coverage = STATS.captured
      ? Math.round(STATS.withEngagement / STATS.captured * 100) : 0;
    hudBody.appendChild(row("With engagement",
      STATS.captured ? coverage + "%" : "—",
      coverage >= 60 ? "#6ee7b7" : (STATS.captured ? "#d9b45f" : "#b8d4c6")));
    hudBody.appendChild(row("With an author",
      STATS.captured ? Math.round(STATS.withAuthor / STATS.captured * 100) + "%" : "—"));

    if (autoScrolling) {
      var mins = Math.round((Date.now() - scanStartedAt) / 60000 * 10) / 10;
      hudBody.appendChild(row("Elapsed", mins + " / " + maxMinutes + " min"));
    }

    // Nothing captured is never left unexplained: each cause has a different
    // fix, and they used to be indistinguishable from one another.
    // Only shown when something is wrong. A working scan has no reason to
    // display counters about what it discarded.
    if (capturedCount === 0 && STATS.articles > 0) {
      hudBody.appendChild(row("On screen",
        STATS.articles + " items · " + STATS.skippedComment + " replies · " +
        STATS.skippedEmpty + " unreadable"));
    }

    if (STATS.errors) {
      hudBody.appendChild(row("⚠ errors this sweep", String(STATS.errors), "#e07a5f"));
    }
    if (STATS.lastError) {
      var errLine = document.createElement("div");
      errLine.textContent = STATS.lastError;
      styleEl(errLine, {
        marginTop: "0.5em", padding: "0.5em 0.6em", borderRadius: "7px",
        background: "rgba(224,122,95,0.14)", color: "#ffb59d",
        fontSize: "0.92em", wordBreak: "break-word"
      });
      hudBody.appendChild(errLine);
    }
    if (STATS.done && !autoScrolling) {
      hudBody.appendChild(row("Done", STATS.done, "#6ee7b7"));
    }

    hudLog.textContent = STATS.log.length ? STATS.log.join("\n")
                                          : "Nothing captured yet.\nPress Start.";
    // Offered only when a scan has run and found nothing.
    if (saveBtn) {
      saveBtn.style.display =
        (capturedCount === 0 && STATS.articles > 0) ? "" : "none";
    }

    hudBtn.textContent = autoScrolling ? "Stop" : "Start auto-scroll";
    hudBtn.style.background = autoScrolling
      ? "rgba(224,122,95,0.92)" : "linear-gradient(135deg, #34d399, #10b981)";
    hudBtn.style.color = autoScrolling ? "#fff" : "#04150c";
  }


  /* Write the raw markup of the first few articles to a file.
   *
   * This exists because the extractors have been tuned against a
   * reconstruction of Facebook's HTML rather than the real thing, and the
   * real thing is only reachable from this browser. One click, one file in
   * Downloads, nothing sent over the network.
   */
  function savePageReport() {
    var lines = [];
    var source = detectSource();

    lines.push("TALLGRASS PAGE REPORT");
    lines.push("version : " + (function () {
      try { return chrome.runtime.getManifest().version; } catch (e) { return "?"; }
    })());
    lines.push("url     : " + location.pathname);
    lines.push("source  : " + (source ? source.kind + " / " + source.name : "none"));
    lines.push("captured: " + capturedCount);
    lines.push("");

    var main = document.querySelector('div[role="main"]');
    lines.push("role=main present   : " + (main ? "yes" : "NO"));
    lines.push("articles in main    : " +
      (main ? main.querySelectorAll('div[role="article"]').length : 0));
    lines.push("articles in document: " +
      document.querySelectorAll('div[role="article"]').length);
    lines.push("role=feed present   : " +
      (document.querySelector('[role="feed"]') ? "yes" : "no"));
    lines.push("");

    var articles = feedArticles();
    var limit = Math.min(articles.length, 3);
    for (var i = 0; i < limit; i++) {
      var article = articles[i];
      var bar = findActionBar(article);
      var author = extractAuthor(article, bar);
      var caption = extractBody(article, author.name, bar);
      var engagement = extractEngagement(article, bar, caption.el);
      var media = extractMedia(article, bar);

      lines.push("======== ARTICLE " + (i + 1) + " ========");
      lines.push("verdict     : " + (commentVerdict(article) || "post"));
      lines.push("action bar  : " + (bar ? "found" : "NOT FOUND"));
      lines.push("author      : " + (author.name || "NOT READ"));
      lines.push("caption     : " + (caption.text ? caption.text.length + " chars" : "NOT READ"));
      lines.push("engagement  : " + engagement.likes + "r " + engagement.comments +
                 "c " + engagement.shares + "s" + (engagement.read ? "" : "  <- NOTHING READ"));
      lines.push("media       : " + (media.image_url ? media.image_count + " image(s)" : "none"));
      lines.push("dir=auto    : " +
        article.querySelectorAll('div[dir="auto"], span[dir="auto"]').length);
      lines.push("spans       : " + article.querySelectorAll("span").length);
      lines.push("aria-labels : " + JSON.stringify(
        Array.prototype.slice.call(article.querySelectorAll("[aria-label]"))
          .map(function (el) { return el.getAttribute("aria-label"); })
          .filter(function (l) { return l && l.length < 70; })
          .slice(0, 18)));
      lines.push("");
      lines.push("--- visible text ---");
      lines.push((article.innerText || "").slice(0, 800));
      lines.push("");
      lines.push("--- markup ---");
      lines.push((article.outerHTML || "").slice(0, 60000));
      lines.push("");
    }

    var text = lines.join(String.fromCharCode(10));
    try {
      var blob = new Blob([text], { type: "text/plain" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "tallgrass-page-report.txt";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      STATS.lastError = null;
      logLine("Saved tallgrass-page-report.txt to Downloads");
    } catch (e) {
      console.log(text);            // the console always works
      STATS.lastError = "Could not save the file — the report is in the console (F12).";
    }
    renderHud();
  }

  /* --------------------------------------------------------- auto-scroll -- */

  function startAutoScroll() {
    autoScrolling = true;
    idleScrolls = 0;
    lastHeight = 0;
    scanStartedAt = Date.now();
    STATS.done = null;
    renderHud();

    scrollTimer = setInterval(function () {
      var before = capturedCount;
      scanPosts();
      flush();

      if (capturedCount >= maxPosts) {
        return stopAutoScroll("Target reached — " + capturedCount + " posts");
      }
      if ((Date.now() - scanStartedAt) / 60000 >= maxMinutes) {
        return stopAutoScroll("Time limit — " + capturedCount + " posts");
      }

      /* "Idle" means the page stopped producing new material, not that this
       * pass captured nothing.
       *
       * Keying it to captures meant a scan that was failing to capture
       * declared itself finished after ten seconds and stopped — which
       * looked like "it scans a few posts then stops". Watch the scroll
       * position instead: while the document keeps growing there is more to
       * see, whatever the capture rate.
       */
      var grew = capturedCount > before ||
                 document.documentElement.scrollHeight > lastHeight;
      lastHeight = document.documentElement.scrollHeight;
      idleScrolls = grew ? 0 : idleScrolls + 1;

      if (idleScrolls >= 12) {
        return stopAutoScroll("Reached the end — " + capturedCount + " posts");
      }
      // Two thirds of a screen, not most of one: Facebook renders only a
      // handful of posts at a time, and overshooting scrolled straight past
      // material that had not been rendered yet.
      window.scrollBy(0, Math.round(window.innerHeight * 0.65));
    }, 2000);
  }

  function stopAutoScroll(reason) {
    autoScrolling = false;
    if (scrollTimer) clearInterval(scrollTimer);
    scrollTimer = null;
    if (reason) { STATS.done = reason; logLine(reason); }
    flush();
    renderHud();
  }

  /* ---------------------------------------------------------------- wire -- */

  chrome.storage.local.get(
    ["enabled", "maxPosts", "maxMinutes", "endpoint", "apiKey"],
    function (state) {
      enabled = state.enabled !== false;
      maxPosts = state.maxPosts || DEFAULT_MAX_POSTS;
      maxMinutes = state.maxMinutes || DEFAULT_MAX_MINUTES;
      hasApiKey = !!state.apiKey;
      endpointLabel = state.endpoint
        ? String(state.endpoint).replace(/^https?:\/\//, "").replace(/\/+$/, "")
        : null;
      renderHud();
    }
  );

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    if (changes.apiKey) hasApiKey = !!changes.apiKey.newValue;
    if (changes.endpoint) {
      endpointLabel = changes.endpoint.newValue
        ? String(changes.endpoint.newValue).replace(/^https?:\/\//, "").replace(/\/+$/, "")
        : null;
    }
    renderHud();
  });

  buildHud();
  scanPosts();

  // A passive sweep, because Facebook loads posts as you scroll by hand.
  // Marking the element means re-running this is cheap and cannot
  // double-count — an earlier counter climbed past 300 while stationary.
  setInterval(function () { if (enabled) { scanPosts(); flush(); } }, 2000);

  /* Exposed for the offline tests, and for debugging against live Facebook:
   * select a post in devtools and run __tallgrass.extractBody($0, null, null). */
  window.__tallgrass = window.__outlier = {
    detectSource: detectSource,
    feedArticles: feedArticles,
    isDefinitelyAComment: isDefinitelyAComment,
    findActionBar: findActionBar,
    isBelowBar: isBelowBar,
    extractBody: extractBody,
    extractAuthor: extractAuthor,
    extractEngagement: extractEngagement,
    extractMedia: extractMedia,
    extractPostType: extractPostType,
    extractPermalink: extractPermalink,
    extractTimestamp: extractTimestamp,
    textFromAlt: textFromAlt,
    looksLikeACount: looksLikeACount,
    parseCount: parseCount,
    scanPosts: scanPosts,
    stats: function () { return STATS; },
    queue: function () { return QUEUE; }
  };
})();
