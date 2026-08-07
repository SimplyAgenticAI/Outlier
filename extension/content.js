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

  var STATS = {
    articles: 0,     // role="article" nodes on the page
    candidates: 0,   // top-level ones (comments excluded)
    queued: 0,
    sent: 0,
    added: 0,
    lastError: null
  };

  /* ------------------------------------------------------ number parsing */

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
    if (groupMatch && groupMatch[1] !== "feed") {
      var heading = document.querySelector('[role="main"] h1, h1');
      return {
        fb_id: "group:" + groupMatch[1],
        kind: "group",
        name: heading ? heading.textContent.trim().slice(0, 120)
                      : "Facebook group " + groupMatch[1],
        url: location.origin + "/groups/" + groupMatch[1]
      };
    }

    var reserved = ["watch", "marketplace", "groups", "home.php", "gaming",
                    "events", "notifications", "messages", "profile.php", ""];
    var profileMatch = url.match(/facebook\.com\/([^/?#]*)/);
    if (profileMatch && reserved.indexOf(profileMatch[1]) === -1) {
      var title = document.querySelector('[role="main"] h1, h1');
      return {
        fb_id: "profile:" + profileMatch[1],
        kind: "profile",
        name: title ? title.textContent.trim().slice(0, 120) : profileMatch[1],
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

  function extractAuthor(article) {
    var candidates = article.querySelectorAll(
      'h2 a, h3 a, h4 a, strong a, span a[role="link"], a[role="link"] strong'
    );
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.textContent || "").trim();
      var href = el.href || (el.closest("a") ? el.closest("a").href : "") || "";
      if (text && text.length > 1 && text.length < 80 &&
          href.indexOf("/groups/") === -1 && text.charAt(0) !== "#") {
        return { name: text, url: href.split("?")[0] };
      }
    }
    return { name: "Unknown", url: null };
  }

  function extractBody(article) {
    // Post copy sits in a dir="auto" block, but so do the header, the
    // engagement row, and each comment. Take the longest block that isn't
    // obviously chrome.
    var blocks = article.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    var longest = "";
    for (var i = 0; i < blocks.length; i++) {
      var text = blocks[i].innerText ? blocks[i].innerText.trim() : "";
      if (text.length <= longest.length) continue;
      if (/^(like|comment|share|reply|see more|all reactions)$/i.test(text)) continue;
      longest = text;
    }
    return longest.slice(0, 5000);
  }

  function extractEngagement(article) {
    var result = { likes: 0, comments: 0, shares: 0, video_plays: 0 };
    var text = article.innerText || "";

    // Strategy 1 — the reaction bar exposes a total on its aria-label.
    var reactionEl = article.querySelector(
      '[aria-label*="reaction" i], [aria-label*="Like:" i], [aria-label*="reacted" i]'
    );
    if (reactionEl) {
      result.likes = parseCount(reactionEl.getAttribute("aria-label"));
    }

    // Strategy 2 — the bare count rendered beside the reaction icons.
    if (!result.likes) {
      var reactionRow = article.querySelector('[aria-label*="See who reacted" i]');
      if (reactionRow) result.likes = parseCount(reactionRow.textContent);
    }

    // Strategy 3 — a standalone number on its own line above the action row.
    if (!result.likes) {
      var loose = text.match(/(?:^|\n)\s*([\d][\d.,]*[KMB]?)\s*(?:\n|$)/);
      if (loose) result.likes = parseCount(loose[1]);
    }

    var commentMatch = text.match(/([\d][\d.,]*\s*[KMB]?)\s+comments?/i);
    if (commentMatch) result.comments = parseCount(commentMatch[1]);

    var shareMatch = text.match(/([\d][\d.,]*\s*[KMB]?)\s+shares?/i);
    if (shareMatch) result.shares = parseCount(shareMatch[1]);

    var playMatch = text.match(/([\d][\d.,]*\s*[KMB]?)\s+(?:views|plays)/i);
    if (playMatch) result.video_plays = parseCount(playMatch[1]);

    return result;
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

    var articles = document.querySelectorAll('div[role="article"]');
    STATS.articles = articles.length;

    var found = 0;
    STATS.candidates = 0;

    articles.forEach(function (article) {
      // Comments are role="article" too. A top-level post has no *ancestor*
      // article — closest() on the element itself always matches, so the check
      // has to start from the parent.
      var parent = article.parentElement;
      if (parent && parent.closest('div[role="article"]')) return;
      STATS.candidates++;

      var body = extractBody(article);
      var author = extractAuthor(article);
      var permalink = extractPermalink(article);
      var postId = extractPostId(article, permalink, body, author.name);

      if (!postId || SEEN.has(postId)) return;
      if (!body || body.length < 12) return;

      SEEN.add(postId);
      found++;

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
        renderHud();
      }
    );
  }

  /* ------------------------------------------------------ auto-scroll */

  function startAutoScroll() {
    if (autoScrolling) return;
    autoScrolling = true;
    idleScrolls = 0;
    STATS.lastError = null;
    renderHud();

    scrollTimer = setInterval(function () {
      var before = window.scrollY;
      window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: "smooth" });

      // Give Facebook a beat to render, then scan what appeared.
      setTimeout(function () {
        var found = scanPosts();
        flush();

        // Bottom of the feed: scroll position stopped moving and nothing new
        // came in. Facebook lazy-loads, so allow several idle passes first.
        if (window.scrollY <= before + 8 && found === 0) {
          idleScrolls++;
          if (idleScrolls >= 6) {
            stopAutoScroll("Reached the end of the feed");
          }
        } else {
          idleScrolls = 0;
        }
      }, 1100);
    }, 2200);
  }

  function stopAutoScroll(reason) {
    autoScrolling = false;
    clearInterval(scrollTimer);
    scrollTimer = null;
    if (reason) STATS.lastError = reason;
    flush();
    renderHud();
  }

  /* ------------------------------------------------------ HUD */

  var hud, hudBody, hudBtn;

  function styleEl(el, styles) {
    // Assigning style properties directly rather than injecting a <style> tag,
    // because Facebook's CSP blocks stylesheet injection from content scripts.
    Object.keys(styles).forEach(function (key) { el.style[key] = styles[key]; });
  }

  function buildHud() {
    hud = document.createElement("div");
    styleEl(hud, {
      position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647",
      width: "232px", padding: "13px 15px", borderRadius: "13px",
      background: "rgba(8, 22, 15, 0.94)", border: "1px solid rgba(110,231,183,0.28)",
      boxShadow: "0 10px 34px rgba(0,0,0,0.5)", color: "#eafff3",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "12px", lineHeight: "1.5", backdropFilter: "blur(10px)"
    });

    var header = document.createElement("div");
    styleEl(header, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      marginBottom: "9px"
    });

    var title = document.createElement("span");
    title.textContent = "Outlier";
    styleEl(title, { fontWeight: "700", fontSize: "13px", letterSpacing: "-0.2px" });

    var close = document.createElement("span");
    close.textContent = "×";
    close.title = "Hide";
    styleEl(close, { cursor: "pointer", opacity: "0.5", fontSize: "16px", lineHeight: "1" });
    close.addEventListener("click", function () { hud.style.display = "none"; });

    header.appendChild(title);
    header.appendChild(close);

    hudBody = document.createElement("div");

    hudBtn = document.createElement("button");
    styleEl(hudBtn, {
      width: "100%", marginTop: "10px", padding: "8px", borderRadius: "8px",
      border: "none", cursor: "pointer", fontWeight: "650", fontSize: "12.5px"
    });
    hudBtn.addEventListener("click", function () {
      if (autoScrolling) stopAutoScroll("Stopped");
      else startAutoScroll();
    });

    var manual = document.createElement("button");
    manual.textContent = "Scan visible posts";
    styleEl(manual, {
      width: "100%", marginTop: "6px", padding: "7px", borderRadius: "8px",
      border: "1px solid rgba(110,231,183,0.22)", cursor: "pointer",
      background: "transparent", color: "#7fa693", fontSize: "12px"
    });
    manual.addEventListener("click", function () { scanPosts(); flush(); });

    hud.appendChild(header);
    hud.appendChild(hudBody);
    hud.appendChild(hudBtn);
    hud.appendChild(manual);
    document.body.appendChild(hud);
  }

  function row(label, value, accent) {
    var line = document.createElement("div");
    styleEl(line, { display: "flex", justifyContent: "space-between" });

    var l = document.createElement("span");
    l.textContent = label;
    styleEl(l, { color: "#567a67" });

    var v = document.createElement("span");
    v.textContent = value;
    styleEl(v, { color: accent || "#eafff3", fontWeight: "620" });

    line.appendChild(l);
    line.appendChild(v);
    return line;
  }

  function renderHud() {
    if (!hud) return;
    hudBody.textContent = "";

    var source = detectSource();
    hudBody.appendChild(row("Page", source ? source.kind : "unsupported",
                            source ? "#6ee7b7" : "#e07a5f"));
    hudBody.appendChild(row("Posts on page", String(STATS.candidates)));
    hudBody.appendChild(row("Captured", String(STATS.sent)));
    hudBody.appendChild(row("New in dashboard", String(STATS.added), "#6ee7b7"));
    if (STATS.queued) hudBody.appendChild(row("Queued", String(STATS.queued)));

    // When articles are present but none qualify, the extractors have drifted —
    // surface that rather than showing a silent zero.
    if (STATS.articles > 0 && STATS.candidates === 0) {
      hudBody.appendChild(row("⚠ selectors", "drifted", "#d9b45f"));
    }

    if (STATS.lastError) {
      var err = document.createElement("div");
      err.textContent = STATS.lastError;
      styleEl(err, {
        marginTop: "7px", paddingTop: "7px", fontSize: "11px", color: "#d9b45f",
        borderTop: "1px solid rgba(110,231,183,0.14)"
      });
      hudBody.appendChild(err);
    }

    hudBtn.textContent = autoScrolling ? "Stop auto-scroll" : "Start auto-scroll";
    hudBtn.style.background = autoScrolling
      ? "rgba(224,122,95,0.9)" : "linear-gradient(135deg, #34d399, #10b981)";
    hudBtn.style.color = autoScrolling ? "#fff" : "#04150c";
  }

  /* ------------------------------------------------------ wiring */

  chrome.storage.local.get(["enabled"], function (state) {
    enabled = state.enabled !== false;
    renderHud();
  });

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled && autoScrolling) stopAutoScroll("Capture turned off");
      renderHud();
    }
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

  buildHud();
  setTimeout(function () { scanPosts(); renderHud(); }, 1500);

  // Exposed for debugging against live Facebook: select a post in devtools and
  // run __outlier.extractBody($0) to see exactly what the extractors read.
  // Also what the offline fixture tests drive.
  window.__outlier = {
    detectSource: detectSource,
    extractBody: extractBody,
    extractAuthor: extractAuthor,
    extractEngagement: extractEngagement,
    extractPostType: extractPostType,
    extractPermalink: extractPermalink,
    extractTimestamp: extractTimestamp,
    parseCount: parseCount,
    scanPosts: scanPosts,
    stats: STATS,
    queue: function () { return QUEUE; }
  };
})();
