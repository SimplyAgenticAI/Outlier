/* Extraction, against the restored V1.7 capture script.
 *
 * The previous version of this file tested the rewritten extractors. Those
 * were reverted because they stopped capturing anything on real Facebook
 * pages, so this covers what the restored script actually does.
 *
 * KNOWN GAP, recorded deliberately rather than hidden: this version reads
 * engagement from the article's visible text, which includes the caption. A
 * post whose copy contains a large number can therefore have that number
 * stored as its reaction count — the "11,000,000 reactions" bug. The fix for
 * it (excluding the caption element structurally) is in git at 32765cb and
 * should be reapplied to THIS file once capture is confirmed working on a
 * real group. Fixing it first is what led to a scanner that captured
 * nothing, and a correct number nobody ever captures is worth nothing.
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

var api = runScan(buildPage([]), "/groups/growth");

/* --------------------------------------------------------------- counts -- */

console.log("parsing counts");
check("plain", api.parseCount("312"), 312);
check("thousands", api.parseCount("1.2K"), 1200);
check("millions", api.parseCount("2M"), 2000000);
check("comma-grouped", api.parseCount("45,678"), 45678);
check("nothing", api.parseCount(""), 0);
// One value above the cap wrecks the median for every post scored against it.
check("a number past the plausibility cap is refused",
      api.parseCount("99000000"), 0);

/* ------------------------------------------------------------- surfaces -- */

console.log("which surface are we on");
[
  ["/groups/claudeai", "Claude AI Community | Facebook", "group:claudeai", "group"],
  ["/janedoe", "Jane Doe | Facebook", "profile:janedoe", "profile"],
  ["/marketplace", "Marketplace | Facebook", null, null],
  ["/watch", "Watch | Facebook", null, null]
].forEach(function (c) {
  var scoped = runScan(buildPage([]), c[0]);
  global.document.title = c[1];
  var got = scoped.detectSource();
  check("detectSource(" + c[0] + ")",
        got ? [got.fb_id, got.kind] : null,
        c[2] ? [c[2], c[3]] : null);
});

/* ----------------------------------------------------------- engagement -- */

console.log("engagement from a labelled post");
var page = buildPage([
  { body: "An ordinary post with a decent amount of caption text on it.",
    likes: 312 }
]);
var scoped = runScan(page, "/groups/growth");
scoped.scanPosts();
var first = scoped.queue()[0] || {};
check("the post is queued", !!first.fb_post_id);
check("its reaction count is read", first.likes, 312);
check("its caption is stored",
      /ordinary post with a decent amount/.test(first.body || ""));

console.log("a reaction summary with no wording");
// Facebook often renders the summary as a bare number beside the emoji
// icons. Every worded pattern misses it, so posts landed marked "not read".
var bare = buildPage([]);
var art = bare.doc.el("div");
art.setAttribute("role", "article");
var head = bare.doc.el("a");
head.setAttribute("role", "link");
head.textContent = "Dana Fletcher";
art.appendChild(head);
var cap = bare.doc.el("div");
cap.setAttribute("dir", "auto");
cap.textContent = "A post whose reaction count carries no label at all.";
art.appendChild(cap);
var count = bare.doc.el("span");        // just the number, no wording
count.textContent = "487";
art.appendChild(count);
var bar = bare.doc.el("div");
bar.setAttribute("role", "button");
bar.setAttribute("aria-label", "Like");
bar.textContent = "Like Comment Share";
art.appendChild(bar);
bare.root.appendChild(art);

var bareApi = runScan(bare, "/groups/growth");
bareApi.scanPosts();
var got = bareApi.queue()[0] || {};
check("the post is captured", !!got.fb_post_id);
check("the bare count is read as reactions", got.likes, 487);

// And the guard: a number inside a sentence is not a count.
var sentence = buildPage([
  { body: "We processed 11,000,000 tokens in the benchmark run this week.",
    likes: 0 }
]);
// strip the labelled count so only the caption remains
var sArt = sentence.root.children[0];
sArt.children.forEach(function (c) {
  if ((c.getAttribute("aria-label") || "").indexOf("reactions") !== -1) {
    c.setAttribute("aria-label", "");
  }
});
var sApi = runScan(sentence, "/groups/growth");
sApi.scanPosts();
var sGot = sApi.queue()[0] || {};
check("a number inside a caption is not read as a count",
      (sGot.likes || 0) < 11000000);

console.log("media and the engagement-read flag reach the payload");
// Both were lost in the V1.7 revert while the dashboard carried on
// rendering thumbnails and a "readable %" that nothing fed.
var withPic = buildPage([
  { body: "A post that carries a photograph alongside its caption.",
    likes: 150,
    image: "https://scontent.example/photo.jpg",
    alt: "May be an image of text that says 'SALE ENDS FRIDAY'" }
]);

var picApi = runScan(withPic, "/groups/growth");
picApi.scanPosts();
var pic = picApi.queue()[0] || {};
check("the post is captured", !!pic.fb_post_id);
check("the image URL is sent", pic.image_url, "https://scontent.example/photo.jpg");
check("engagement_read is set when counts were found", pic.engagement_read, 1);
check("its reaction count survived", pic.likes, 150);

console.log("the action bar is never mistaken for the caption");
// The loose caption pass (added because dir="auto" is not guaranteed) is not
// bounded by the bar the way the strict pass is, so it took the bar's own
// text: caption-less posts came back with a body of "Like Comment Share",
// and every one of them then hashed to the same id.
var noCaption = buildPage([{ body: "", likes: 64 }]);
var ncApi = runScan(noCaption, "/groups/growth");
ncApi.scanPosts();
var ncBodies = ncApi.queue().map(function (p) { return p.body || ""; });
check("no post is given the action bar as its caption",
      ncBodies.every(function (b) { return !/Like\s+Comment\s+Share/i.test(b); }));

console.log("posts whose words are in the picture");
// Reported from a live scan: "skipped, no text" landing on posts that have
// text, and "a lot of posts the text will be in the picture".
var meme = buildPage([
  { body: "",                                  // nothing typed at all
    likes: 920,
    image: "https://scontent.example/meme.jpg",
    alt: "May be an image of text that says 'DISCIPLINE BEATS MOTIVATION'" }
]);
var memeApi = runScan(meme, "/groups/growth");
memeApi.scanPosts();
var m = memeApi.queue()[0] || {};
check("a caption-less meme is captured", !!m.fb_post_id);
check("its words are read out of the image", m.body, "DISCIPLINE BEATS MOTIVATION");
check("and flagged as coming from the image", m.body_from_image, 1);

console.log("a photo post with no words anywhere");
var photo = buildPage([
  { body: "", likes: 310, image: "https://scontent.example/holiday.jpg",
    alt: "May be an image of 3 people, outdoors" }   // no transcription
]);
var photoApi = runScan(photo, "/groups/growth");
photoApi.scanPosts();
var ph = photoApi.queue()[0] || {};
check("still captured, on the strength of the image and its counts",
      !!ph.fb_post_id);
check("with no invented caption", ph.body, "");
check("and its reaction count intact", ph.likes, 310);

console.log("the layout from a real group page report");
/* Taken from tallgrass-page-report.txt, /groups/realestateconversation:
 *   - every div[role="article"] on the page was a COMMENT
 *     (aria-label="Comment by Kathy Opheim Johnson 4 days ago")
 *   - the posts carried no role at all
 *   - the reaction summary sat AFTER the Like button, labelled
 *     "1 reaction; see who reacted to this"
 * Both facts together meant nothing was ever captured.
 */
var real = buildPage([]);
var D = real.doc;

var postBox = D.el("div");                       // no role, like the real page
var name = D.el("a");
name.setAttribute("role", "link");
name.textContent = "Marcus Webb";
postBox.appendChild(name);

var caption = D.el("div");
caption.setAttribute("dir", "auto");
caption.textContent = "Five things I learned scaling a brokerage this year.";
postBox.appendChild(caption);

var likeBtn = D.el("div");
likeBtn.setAttribute("role", "button");
likeBtn.setAttribute("aria-label", "Like");
postBox.appendChild(likeBtn);

var shareBtn = D.el("div");
shareBtn.setAttribute("role", "button");
shareBtn.setAttribute("aria-label", "Share");
postBox.appendChild(shareBtn);

// BELOW the action bar, exactly as the report showed.
var reactions = D.el("div");
reactions.setAttribute("aria-label", "214 reactions; see who reacted to this");
postBox.appendChild(reactions);

// A preview comment, which is what role="article" actually marks here.
var reply = D.el("div");
reply.setAttribute("role", "article");
reply.setAttribute("aria-label", "Comment by Kathy Opheim Johnson 4 days ago");
var replyText = D.el("div");
replyText.setAttribute("dir", "auto");
replyText.textContent = "Great post, this matches my experience exactly.";
reply.appendChild(replyText);
var replyCount = D.el("div");
replyCount.setAttribute("aria-label", "1 reaction; see who reacted to this");
reply.appendChild(replyCount);
postBox.appendChild(reply);

real.root.appendChild(postBox);

var realApi = runScan(real, "/groups/realestateconversation");
realApi.scanPosts();
var rp = realApi.queue()[0] || {};
check("the post is found without role=article", !!rp.fb_post_id);
check("exactly one post, not the comment too", realApi.queue().length, 1);
check("its caption is read",
      /Five things I learned/.test(rp.body || ""));
check("the reaction count BELOW the bar is read", rp.likes, 214);
check("and the comment's own count is not taken", rp.likes !== 1);

/* A video's view count must never be read as its reaction total.
 *
 * The reaction total is chosen as the largest bare number left after the
 * comment and share tallies are removed. A view count is larger than either —
 * and larger than the real reactions — so it won that contest and OVERRODE a
 * correctly-read total. A reel with three likes and 9,809 views arrived in the
 * dashboard showing 9,809 reactions, which then scored it as a huge outlier.
 * Views are now excluded the same way comments and shares already are.
 */
var vid = buildPage([]);
var VD = vid.doc;

var vBox = VD.el("div");
vBox.setAttribute("role", "article");
var vName = VD.el("a");
vName.setAttribute("role", "link");
vName.textContent = "Renz Journey";
vBox.appendChild(vName);

var vCap = VD.el("div");
vCap.setAttribute("dir", "auto");
vCap.textContent = "New reel is up, let me know what you think";
vBox.appendChild(vCap);

// The real reaction summary: only a few.
var vReact = VD.el("div");
vReact.setAttribute("aria-label", "3 reactions; see who reacted to this");
vBox.appendChild(vReact);

// The view count — worded label plus the bare number Facebook renders beside
// it. The bare number is what used to win the reaction contest.
var vViewsLabel = VD.el("div");
vViewsLabel.setAttribute("aria-label", "9,809 views");
vBox.appendChild(vViewsLabel);
var vViewsNum = VD.el("div");
vViewsNum.textContent = "9,809";
vBox.appendChild(vViewsNum);

var vBar = VD.el("div");
vBar.setAttribute("role", "button");
vBar.setAttribute("aria-label", "Like");
vBar.textContent = "Like Comment Share";
vBox.appendChild(vBar);

vid.root.appendChild(vBox);

var vidApi = runScan(vid, "/groups/reels");
vidApi.scanPosts();
var vp = vidApi.queue()[0] || {};
check("the reel is captured", !!vp.fb_post_id);
check("its reactions are the real few, not the view count", vp.likes, 3);
check("the view count is kept separately as plays", vp.video_plays, 9809);

console.log("a feed of loading skeletons and real posts");
/* From tallgrass-page-report (1).txt, /groups/665320572142756:
 *   div[role="article"]: 4  — 2 comments, and 2 empty "Loading..." shells
 *   [aria-posinset]    : 5  — Facebook's own marker for a feed item
 * The old code took the two skeletons as posts and, because it had "found
 * some", returned before trying anything else. Four articles, no posts,
 * nothing captured.
 */
var mixed = buildPage([]);
var M = mixed.doc;

// The placeholder Facebook renders while a post loads.
var shell = M.el("div");
shell.setAttribute("role", "article");
var shellLabel = M.el("div");
shellLabel.setAttribute("aria-label", "Loading...");
shell.appendChild(shellLabel);
mixed.root.appendChild(shell);

// A real post, marked the way the feed marks them.
var unit = M.el("div");
unit.setAttribute("aria-posinset", "3");
var uName = M.el("a");
uName.setAttribute("role", "link");
uName.textContent = "Ephraim Kungap";
unit.appendChild(uName);
var uBody = M.el("div");
uBody.setAttribute("dir", "auto");
uBody.textContent = "The habit that changed how I run my mornings this year.";
unit.appendChild(uBody);
var uLike = M.el("div");
uLike.setAttribute("role", "button");
uLike.setAttribute("aria-label", "Like");
unit.appendChild(uLike);
var uCount = M.el("div");
uCount.setAttribute("aria-label", "482 reactions; see who reacted to this");
unit.appendChild(uCount);
mixed.root.appendChild(unit);

var mixedApi = runScan(mixed, "/groups/665320572142756/");
mixedApi.scanPosts();
var mp = mixedApi.queue()[0] || {};
check("the loading skeleton is not taken as a post", mixedApi.queue().length, 1);
check("the real post is found by aria-posinset", !!mp.fb_post_id);
check("its caption is read", /habit that changed/.test(mp.body || ""));
check("its reaction count is read", mp.likes, 482);

console.log("a container must not swallow the next post");
// Reported: the same picture on post after post, and wrong comment/share
// counts. Both came from the walk-up only stopping at a SECOND anchor — with
// one permalink on screen it climbed until it held a slab of the feed.
var twoUp = buildPage([
  { body: "The first post, with a photograph of its own attached.",
    likes: 300, image: "https://scontent.example/first.jpg" },
  { body: "The second post, with a completely different picture.",
    likes: 90, image: "https://scontent.example/second.jpg" }
]);
var twoApi = runScan(twoUp, "/groups/growth");
twoApi.scanPosts();
var q = twoApi.queue();
check("both posts captured separately", q.length, 2);
check("each keeps its own picture",
      q.map(function (x) { return x.image_url; }),
      ["https://scontent.example/first.jpg", "https://scontent.example/second.jpg"]);
check("counts are not pooled", q.map(function (x) { return x.likes; }), [300, 90]);

console.log("the same image is never attached twice");
var dupes = buildPage([
  { body: "A post that owns this picture outright and says so.",
    likes: 120, image: "https://scontent.example/shared.jpg" },
  { body: "A different post that must not inherit that picture.",
    likes: 45, image: "https://scontent.example/shared.jpg" }
]);
var dupApi = runScan(dupes, "/groups/growth");
dupApi.scanPosts();
var dq = dupApi.queue();
check("both posts still captured", dq.length, 2);
check("only the first keeps the image",
      dq.map(function (x) { return x.image_url; }),
      ["https://scontent.example/shared.jpg", null]);

console.log("the target is a limit, not a suggestion");
var many = [];
for (var n = 0; n < 12; n++) {
  many.push({ body: "Post number " + n + " with plenty of caption text on it.",
              likes: 50 + n });
}
var limited = buildPage(many);
var limitApi = runScan(limited, "/groups/growth", { maxPosts: 5 });
limitApi.scanPosts();
limitApi.scanPosts();      // the passive sweep used to sail straight past
check("capture stops at the target", limitApi.queue().length, 5);

console.log("comment and share tallies rendered as plain text");
// Reactions came through because Facebook labels them; comments and shares
// are plain text, and reading labels only left both at zero for every post.
function withFooter(texts, label) {
  var page = buildPage([]);
  var art = page.doc.el("div");
  art.setAttribute("aria-posinset", "1");
  var a = page.doc.el("a");
  a.setAttribute("role", "link");
  a.textContent = "Dana Fletcher";
  art.appendChild(a);
  var body = page.doc.el("div");
  body.setAttribute("dir", "auto");
  body.textContent = "A post with its tallies written out underneath it.";
  art.appendChild(body);
  var like = page.doc.el("div");
  like.setAttribute("role", "button");
  like.setAttribute("aria-label", "Like");
  art.appendChild(like);
  if (label) {
    var lab = page.doc.el("div");
    lab.setAttribute("aria-label", label);
    art.appendChild(lab);
  }
  texts.forEach(function (txt) {
    var n = page.doc.el("span");
    n.textContent = txt;
    art.appendChild(n);
  });
  page.root.appendChild(art);
  var api = runScan(page, "/groups/growth");
  api.scanPosts();
  return api.queue()[0] || {};
}

var footer = withFooter(["12 comments", "3 shares"], "486 reactions");
check("reactions still read from the label", footer.likes, 486);
check("comments read from plain text", footer.comments, 12);
check("shares read from plain text", footer.shares, 3);

var prose = withFooter(["We closed 12 deals this quarter and shared the news"], "486 reactions");
check("a sentence mentioning a number is not a tally", prose.comments, 0);
check("nor a share count", prose.shares, 0);

console.log("the reported post: 265 reactions, 54 comments, 22 shares");
/* Recorded as "142 reactions, 0 comments, 0 shares". Two faults:
 *   - Facebook renders per-reaction-type counts beside the total, and the
 *     first match won, so a part was taken for the whole.
 *   - The footer is one node reading "54 comments · 22 shares", and the rule
 *     required a node to be exactly one "N unit" segment, so both were zero.
 */
var reported = buildPage([]);
var R = reported.doc;
var rArt = R.el("div");
rArt.setAttribute("aria-posinset", "1");

var rWho = R.el("a");
rWho.setAttribute("role", "link");
rWho.textContent = "Ana Silva";
rArt.appendChild(rWho);

var rBody = R.el("div");
rBody.setAttribute("dir", "auto");
rBody.textContent = "The post whose numbers came through wrong in the dashboard.";
rArt.appendChild(rBody);

// Per-type counts sitting beside the total, exactly as Facebook renders them.
["142 Likes", "78 Loves", "45 Cares"].forEach(function (label) {
  var n = R.el("div");
  n.setAttribute("aria-label", label);
  rArt.appendChild(n);
});
var rTotal = R.el("div");
rTotal.setAttribute("aria-label", "265 reactions; see who reacted to this");
rArt.appendChild(rTotal);

var rLike = R.el("div");
rLike.setAttribute("role", "button");
rLike.setAttribute("aria-label", "Like");
rArt.appendChild(rLike);

// The footer, as one node.
var rFooter = R.el("span");
rFooter.textContent = "54 comments · 22 shares";
rArt.appendChild(rFooter);

reported.root.appendChild(rArt);

var rApi = runScan(reported, "/groups/growth");
rApi.scanPosts();
var got = rApi.queue()[0] || {};
check("the reaction TOTAL is taken, not one type", got.likes, 265);
check("comments read from the combined footer", got.comments, 54);
check("shares read from the same node", got.shares, 22);

console.log("the footer as a screenshot showed it: icons and bare numbers");
/* From a photograph of /groups/vibecodinglife. The post by Uche Okere shows
 *   [thumb] 84   [speech] 169   [arrow] 8
 * — three bare numbers beside icons, with no words anywhere near them. Every
 * pattern needs a unit ("169 comments"), so comments and shares could never
 * match and sat at zero while reactions came through from an aria-label.
 */
var shot = buildPage([]);
var S = shot.doc;

var feed = S.el("div");
feed.setAttribute("role", "feed");

var shotPost = S.el("div");
shotPost.setAttribute("aria-posinset", "2");
var sWho = S.el("a");
sWho.setAttribute("role", "link");
sWho.textContent = "Uche Okere";
shotPost.appendChild(sWho);
var sWhen = S.el("a");
sWhen.setAttribute("href", "/groups/vibecodinglife/posts/2101912077063985/");
sWhen.textContent = "3d";
shotPost.appendChild(sWhen);
var sBody = S.el("div");
sBody.setAttribute("dir", "auto");
sBody.textContent = "How much revenue have you made from vibe coding?";
shotPost.appendChild(sBody);
var sLike = S.el("div");
sLike.setAttribute("role", "button");
sLike.setAttribute("aria-label", "Like");
shotPost.appendChild(sLike);
["84", "169", "8"].forEach(function (n) {
  var cell = S.el("span");
  cell.textContent = n;
  shotPost.appendChild(cell);
});
feed.appendChild(shotPost);
shot.root.appendChild(feed);

// The right-hand column: "Recent media", four images, no post anywhere.
var aside = S.el("div");
aside.setAttribute("role", "complementary");
for (var mi = 0; mi < 4; mi++) {
  var tile = S.el("div");
  var tImg = S.el("img");
  tImg.setAttribute("src", "https://scontent.example/media" + mi + ".jpg");
  tImg.src = "https://scontent.example/media" + mi + ".jpg";
  tImg.naturalWidth = 400; tImg.naturalHeight = 400;
  tile.appendChild(tImg);
  var tLink = S.el("a");
  tLink.setAttribute("href", "/groups/vibecodinglife/posts/999" + mi + "/");
  tLink.textContent = "See all";
  tile.appendChild(tLink);
  aside.appendChild(tile);
}
shot.root.appendChild(aside);

var shotApi = runScan(shot, "/groups/vibecodinglife");
shotApi.scanPosts();
var sq = shotApi.queue();
check("only the feed post is captured", sq.length, 1);
check("the sidebar media is not", sq.length === 1);
var sp = sq[0] || {};
check("reactions from the counts row", sp.likes, 84);
check("comments from the counts row", sp.comments, 169);
check("shares from the counts row", sp.shares, 8);
check("and it links to the post, not the group",
      /\/posts\/2101912077063985/.test(sp.permalink || ""));

console.log("2.5K reactions, 82 comments, 183 shares");
/* Reported: comments and shares correct, reactions recorded as 1.7K — one
 * reaction type rather than the total, which Facebook renders alongside it.
 */
function postWithCounts(numbers, perTypeLabel) {
  var page = buildPage([]);
  var P = page.doc;
  var feedBox = P.el("div");
  feedBox.setAttribute("role", "feed");
  var art = P.el("div");
  art.setAttribute("aria-posinset", "1");
  var who = P.el("a");
  who.setAttribute("role", "link");
  who.textContent = "Priya Raman";
  art.appendChild(who);
  var body = P.el("div");
  body.setAttribute("dir", "auto");
  body.textContent = "The post whose reaction total came through as a part.";
  art.appendChild(body);
  var like = P.el("div");
  like.setAttribute("role", "button");
  like.setAttribute("aria-label", "Like");
  art.appendChild(like);
  if (perTypeLabel) {
    // Facebook labels the per-type breakdown; the footer numbers are bare.
    var typed = P.el("div");
    typed.setAttribute("aria-label", perTypeLabel);
    art.appendChild(typed);
  }
  numbers.forEach(function (n) {
    var cell = P.el("span");
    cell.textContent = n;
    art.appendChild(cell);
  });
  feedBox.appendChild(art);
  page.root.appendChild(feedBox);
  var api = runScan(page, "/groups/growth");
  api.scanPosts();
  return api.queue()[0] || {};
}

// The total beside its parts, then the comment and share tallies.
var big = postWithCounts(["2.5K", "82", "183"], "1.7K reactions");
check("the reaction TOTAL wins over a per-type count", big.likes, 2500);
check("comments still correct", big.comments, 82);
check("shares still correct", big.shares, 183);

// And the guard: comments larger than reactions must not be swapped in.
var small = postWithCounts(["84", "169", "8"]);
check("a larger comment count is not read as reactions", small.likes, 84);
check("comments unchanged", small.comments, 169);
check("shares unchanged", small.shares, 8);

/* -------------------------------------------------- feed post origins -- */

console.log();
console.log("a feed post is filed under its own origin, or skipped");

var feedApi = runScan(buildPage([]), "/");
check("the home feed is a supported source", feedApi.detectSource().kind, "feed");
check("  named, not 'unsupported'", feedApi.detectSource().name, "Home feed");

var FD = buildPage([]).doc;

// A group post on the feed: a header link to /groups/<id> carrying the name.
function feedArticle(build) {
  var art = FD.el("div");
  art.setAttribute("role", "article");
  var nameLink = FD.el("a");
  nameLink.setAttribute("role", "link");
  nameLink.textContent = "Renz Journey";
  nameLink.href = "https://www.facebook.com/renz.journey";
  nameLink.setAttribute("href", "/renz.journey");
  art.appendChild(nameLink);
  build(art);
  var bar = FD.el("div");
  bar.setAttribute("role", "button");
  bar.setAttribute("aria-label", "Like");
  bar.textContent = "Like Comment Share";
  art.appendChild(bar);
  return art;
}

var groupPost = feedArticle(function (art) {
  var g = FD.el("a");
  g.textContent = "Empaths & Old Souls";
  g.href = "https://www.facebook.com/groups/1234567890";
  g.setAttribute("href", "/groups/1234567890");
  art.appendChild(g);
});
var gSrc = feedApi.extractPostSource(groupPost, { name: "Renz Journey", url: "https://www.facebook.com/renz.journey" }, feedApi.findActionBar(groupPost));
check("a group post is filed under the group", gSrc && gSrc.fb_id, "group:1234567890");
check("  with the group's name", gSrc && gSrc.name, "Empaths & Old Souls");

// A post with no group link is filed under its author (a Page or a person).
var authorPost = feedArticle(function () {});
var aSrc = feedApi.extractPostSource(authorPost,
  { name: "Renz Journey", url: "https://www.facebook.com/renz.journey" },
  feedApi.findActionBar(authorPost));
check("otherwise it's filed under the author", aSrc && aSrc.fb_id, "profile:renz.journey");

// No group link and no readable author -> null, so the caller skips it.
var orphan = feedArticle(function () {});
var oSrc = feedApi.extractPostSource(orphan, { name: "", url: "" }, feedApi.findActionBar(orphan));
check("an unreadable origin returns null (skipped, never misfiled)", oSrc, null);

console.log();
console.log("ads and suggestions are recognised");
var ad = FD.el("div");
ad.textContent = "Sponsored\nBuy our thing now";
check("a Sponsored post is flagged", feedApi.isSponsoredOrSuggested(ad), true);
var sugg = FD.el("div");
sugg.textContent = "Suggested for you\nA page you might like";
check("a Suggested post is flagged", feedApi.isSponsoredOrSuggested(sugg), true);
var normal = FD.el("div");
normal.textContent = "Just sharing my morning coffee thoughts";
check("a normal post is not flagged", feedApi.isSponsoredOrSuggested(normal), false);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("extraction behaves");
process.exit(0);
