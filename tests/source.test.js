/* Which surface a scan is on, and where each post came from.
 *
 * Two gaps this covers, both of which silently captured nothing:
 *
 *  - profile.php was a reserved path segment, so every profile WITHOUT a
 *    vanity URL — which is most of them — reported "not a group or profile"
 *    and scanned nothing. The id lives in the query string, and the old
 *    match only ever looked at the path.
 *  - the home feed and the groups feed were both reserved too ("" and
 *    "groups"), so the two surfaces with the most posts on them were the two
 *    that could not be scanned.
 *
 * And the thing that makes feeds correct rather than merely possible: on a
 * feed each post has its own origin. Filing a feed's posts under one source
 * would score unrelated posts against a shared median, which is the single
 * thing this product must not do.
 */
var H = require("./harness");
var runScan = H.runScan, buildPage = H.buildPage;

var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

function sourceAt(urlPath) {
  var page = buildPage([]);
  var api = runScan(page, urlPath);
  return api.detectSource();
}

console.log("every surface the user was told works, works");

var group = sourceAt("/groups/1234567890/");
check("a group is a group", group && group.kind, "group");
check("  and keeps its id", group && group.fb_id, "group:1234567890");

var vanity = sourceAt("/zuck");
check("a vanity profile is a profile", vanity && vanity.kind, "profile");
check("  and keeps its handle", vanity && vanity.fb_id, "profile:zuck");

/* The regression. profile.php sat in the reserved list, so this returned
 * null and the HUD said the page was unsupported. */
var numeric = sourceAt("/profile.php?id=100044556677889");
check("a numeric profile is detected at all", numeric !== null);
check("  as a profile", numeric && numeric.kind, "profile");
check("  keyed by its id", numeric && numeric.fb_id, "profile:100044556677889");
check("  with a url that actually opens it", numeric && numeric.url,
      "https://www.facebook.com/profile.php?id=100044556677889");

var home = sourceAt("/");
check("the home feed is scannable", home !== null);
check("  and is marked as a feed", home && home.kind, "feed");
check("  whose posts are filed individually", home && home.per_post, true);

check("home.php is the same surface",
      (sourceAt("/home.php") || {}).fb_id, "feed:home");
check("the groups feed is scannable",
      (sourceAt("/groups/feed/") || {}).fb_id, "feed:groups");

/* Not everything is a profile. Before, any unreserved path segment was
 * treated as one, so these would have been scanned as people. */
check("marketplace is not a person", sourceAt("/marketplace/"), null);
check("watch is not a person", sourceAt("/watch/"), null);
check("stories is not a person", sourceAt("/stories/12345"), null);
check("the settings page is not a person", sourceAt("/settings"), null);

console.log();
console.log("on a feed, each post keeps its own origin");

/* A post rendered in the home feed, carrying a link to the group it was
 * actually posted in — which is how Facebook renders group posts in a feed. */
function feedPost(groupId, groupName) {
  var page = buildPage([{
    body: "A post that came from somewhere else",
    likes: 40, comments: 3, shares: 1,
    links: [{ href: "/groups/" + groupId + "/", text: groupName }]
  }]);
  return page;
}

var api = runScan(feedPost("998877", "Coastal Growers"), "/");
var article = global.document.querySelectorAll('div[role="article"]')[0];
var pageSource = api.detectSource();
var origin = api.postOrigin(
  article,
  "https://www.facebook.com/groups/998877/posts/5555/",
  pageSource
);

check("the post is filed under its group, not the feed",
      origin && origin.fb_id, "group:998877");
check("  and not under the page it was read from",
      origin && origin.fb_id !== pageSource.fb_id, true);
check("  carrying the group's readable name",
      origin && origin.name, "Coastal Growers");

/* Identity has to survive being seen twice. The same post read inside its
 * own group must resolve to the same id, or the dashboard shows it twice. */
var inGroup = runScan(feedPost("998877", "Coastal Growers"), "/groups/998877/");
var article2 = global.document.querySelectorAll('div[role="article"]')[0];
var origin2 = api.postOrigin(
  article2,
  "https://www.facebook.com/groups/998877/posts/5555/",
  inGroup.detectSource()
);
check("the same post seen in its group is one row, not two",
      origin2.fb_id, origin.fb_id);

/* A post with nothing to go on falls back to the page, rather than throwing
 * or producing an origin of "undefined". */
var bare = buildPage([{ body: "no links at all", likes: 5 }]);
var bareApi = runScan(bare, "/groups/4242/");
var bareArticle = global.document.querySelectorAll('div[role="article"]')[0];
var fallback = bareApi.postOrigin(bareArticle, null, bareApi.detectSource());
check("a post with no origin falls back to the page",
      fallback && fallback.fb_id, "group:4242");

console.log();
console.log("a post's identity does not drift while you look at it");

/* The scan suite caught this about one run in six, by luck: it only fails
 * when two sweeps straddle a second boundary. The id used to include
 * extractTimestamp's wall-clock fallback, so a post whose date could not be
 * read hashed differently every second and returned as a new row on the next
 * sweep. Asserted directly here so it cannot creep back in unnoticed.
 */
var undated = buildPage([{ body: "A post with no readable date on it", likes: 12 }]);
var undatedApi = runScan(undated, "/groups/4242/");
var undatedArticle = global.document.querySelectorAll('div[role="article"]')[0];

check("a card with no date says so, rather than inventing one",
      undatedApi.readableTimestamp(undatedArticle), null);

var first = undatedApi.extractTimestamp(undatedArticle);
undatedArticle.__tallgrassFirstSeen = "2020-01-01T00:00:00";   // as if a sweep ago
check("the fallback is stamped once and then held",
      undatedApi.extractTimestamp(undatedArticle), "2020-01-01T00:00:00");
check("  and it is a real timestamp, not empty", /^\d{4}-/.test(first), true);

undatedApi.scanPosts();
var idsBefore = undatedApi.queue().map(function (p) { return p.fb_post_id; });
undatedArticle.__tallgrassFirstSeen = "2031-06-06T06:06:06";   // clock moves on
undatedApi.scanPosts();
var idsAfter = undatedApi.queue().map(function (p) { return p.fb_post_id; });

check("the id survives the clock moving",
      idsAfter.filter(function (id) { return idsBefore.indexOf(id) === -1; }), []);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("sources behave");
process.exit(0);
