/* Does a scan actually capture posts?
 *
 * This is the test that was missing, and its absence cost releases. A
 * scan loop that clicked "See more" and returned skipped any post whose
 * control did not vanish -- on every pass, forever -- while every other
 * test passed, because none of them ran a scan.
 */
var H = require("./harness");
var makeDoc = H.makeDoc, buildPage = H.buildPage, runScan = H.runScan;

var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

console.log("opening a group captures nothing on its own");
// Simply switching into a group used to put twenty-odd posts in the
// dashboard before Start had been pressed, because the mutation observer
// scanned on every DOM change. Capture is an action the user takes.
var idle = runScan(buildPage([
  { body: "A post sitting on screen the moment the page opens.", likes: 140 },
  { body: "And another one right below it, also just sitting there.", likes: 95 }
]), "/groups/growth");
check("nothing is queued before a scan is asked for", idle.queue().length, 0);
idle.scanPosts();
check("and it captures normally once one is", idle.queue().length, 2);

console.log("counts arriving late must not re-capture the post");
// Eight posts scrolled past, forty-six captured. The id is a hash that
// includes the reaction counts, and Facebook fills those in progressively —
// so the same post hashed differently on the next sweep and was captured
// again, over and over.
var late = buildPage([
  { body: "A post whose reaction count has not loaded yet at all.", likes: 0 },
  { body: "Another post in the same state, waiting on its numbers.", likes: 0 }
]);
var lateApi = runScan(late, "/groups/growth");
lateApi.scanPosts();
var afterFirst = lateApi.queue().length;

// Facebook fills the counts in, exactly as it does on a real page.
late.root.children.forEach(function (art, i) {
  art.children.forEach(function (child) {
    var label = child.getAttribute("aria-label") || "";
    if (/reactions/.test(label)) {
      child.setAttribute("aria-label", (400 + i * 37) + " reactions");
    }
  });
});
lateApi.scanPosts();
lateApi.scanPosts();

check("captured once on the first sweep", afterFirst, 2);
check("not re-captured as new posts", new Set(lateApi.queue().map(function (p) { return p.fb_post_id; })).size, 2);
// Re-sent, not re-added: the second read carries the counts the first
// missed, and the id is stable so the dashboard updates that row.
// Re-sent, not re-added: the later read carries the counts the first missed,
// and the id is stable so the dashboard UPDATES that row rather than adding
// a second one. Both posts appear twice in the queue — once empty, once with
// their numbers — and both entries carry the same id.
var ids = lateApi.queue().map(function (p) { return p.fb_post_id; });
check("the numbers are picked up on a later sweep",
      lateApi.queue().some(function (p) { return p.likes > 0; }));
check("under the same two ids, so rows update rather than multiply",
      new Set(ids).size, 2);

console.log("a scan of ordinary posts");
var api = runScan(buildPage([
  { body: "First post about growing an audience organically over a long time.", likes: 120 },
  { body: "Second post with a different angle on the very same subject here.", likes: 340 },
  { body: "Third post, still with a decent amount of caption text on it.", likes: 90 }
]), "/groups/growth");
api.scanPosts();
check("the queue is not empty", api.queue().length > 0);
check("every post captured", api.queue().length, 3);
check("bodies stored", api.queue().every(function (p) {
  return p.body && p.body.length > 10;
}));
check("engagement read", api.queue().map(function (p) { return p.likes; }), [120, 340, 90]);

console.log("a post whose See more never goes away");
var stickyPage = buildPage([
  { body: "A long clamped caption Facebook will not let go of, ever.",
    likes: 200, seeMore: true, sticky: true },
  { body: "An ordinary post beside it with plenty of caption text.", likes: 55 }
]);
var api2 = runScan(stickyPage, "/groups/growth");
api2.scanPosts();
api2.scanPosts();                       // second sweep: control still present
check("the sticky post is STILL captured", api2.queue().length, 2);
// KNOWN TRADE-OFF of restoring V1.7: it does not expand "See more", so a
// long caption is stored clamped. Accepted deliberately — the version that
// expanded captions is the one that stopped capturing at all. To be
// reinstated only once capture is confirmed working on a real group.

console.log("a post that expands on click");
var api3 = runScan(buildPage([
  { body: "Short fragment of a caption here", likes: 70, seeMore: true }
]), "/groups/growth");
api3.scanPosts();
check("captured on the first pass, not deferred", api3.queue().length, 1);

console.log("an article with no recognisable signals");
var api5 = runScan(buildPage([
  { body: "A post on a page whose markup exposes none of the usual signals.",
    likes: 33, bare: true }
]), "/groups/growth");
api5.scanPosts();
check("captured rather than silently dropped", api5.queue().length, 1);

console.log("many posts, one author, no captions");
// The stall: hashing author+body collapsed every caption-less post by the
// same person onto one id, so 200 posts deduped to the number of authors.
var sameAuthor = [];
for (var n = 0; n < 12; n++) {
  sameAuthor.push({ body: "", author: "Group Admin", likes: 30 + n * 5 });
}
var api6 = runScan(buildPage(sameAuthor), "/groups/growth");
api6.scanPosts();
// Photo posts and memes are captured now, so each must keep its own
// identity: hashing author+body alone collapsed every caption-less post by
// one person onto a single id, which is how two hundred once became three.
check("each caption-less post keeps its own identity", api6.queue().length, 12);

console.log("an open Messenger chat is not a feed");
var chatPage = buildPage([
  { body: "A genuine feed post with a decent amount of caption text.", likes: 88 }
]);
var chat = chatPage.doc.el("div");
chat.setAttribute("aria-label", "Messenger");
var bubble = chatPage.doc.el("div");
bubble.setAttribute("role", "article");
var bubbleText = chatPage.doc.el("div");
bubbleText.setAttribute("dir", "auto");
bubbleText.textContent = "hey are we still on for tomorrow afternoon or not";
bubble.appendChild(bubbleText);
chat.appendChild(bubble);
chatPage.root.appendChild(chat);

var api7 = runScan(chatPage, "/groups/growth");
api7.scanPosts();
check("the chat message was not captured", api7.queue().length, 1);
check("and the post still was", api7.queue()[0].body.indexOf("genuine feed post") !== -1);

console.log("a post nested inside a wrapper article");
// Facebook wraps feed items, and a shared post renders the original inside
// the sharer's article. Treating "nested" as proof of comment-ness meant the
// panel reported every item as a reply and captured nothing.
var wrapped = buildPage([]);
var outer = wrapped.doc.el("div");
outer.setAttribute("role", "article");
var inner = wrapped.doc.el("div");
inner.setAttribute("role", "article");
var innerHead = wrapped.doc.el("a");
innerHead.setAttribute("role", "link");
innerHead.textContent = "Someone Real";
inner.appendChild(innerHead);
var innerBody = wrapped.doc.el("div");
innerBody.setAttribute("dir", "auto");
innerBody.textContent = "A genuine post that happens to sit inside a wrapper.";
inner.appendChild(innerBody);
var innerShare = wrapped.doc.el("div");
innerShare.setAttribute("aria-label", "Send this to friends or post it on your profile");
inner.appendChild(innerShare);
var innerCounts = wrapped.doc.el("div");
innerCounts.setAttribute("aria-label", "77 reactions");
inner.appendChild(innerCounts);
outer.appendChild(inner);
wrapped.root.appendChild(outer);

var api8 = runScan(wrapped, "/groups/growth");
api8.scanPosts();
check("a nested post carrying Share is still captured", api8.queue().length > 0);

console.log("a real reply is still skipped");
var withReply = buildPage([
  { body: "The post everyone is replying to, with plenty of text.", likes: 500 }
]);
var host = withReply.root.children[0];
var rep = withReply.doc.el("div");
rep.setAttribute("role", "article");
var repBody = withReply.doc.el("div");
repBody.setAttribute("dir", "auto");
repBody.textContent = "A reply that Facebook chose to preview here";
rep.appendChild(repBody);
var repBtn = withReply.doc.el("div");
repBtn.setAttribute("aria-label", "Reply");
rep.appendChild(repBtn);
host.appendChild(rep);

var api9 = runScan(withReply, "/groups/growth");
api9.scanPosts();
// KNOWN TRADE-OFF: V1.7 captures replies as well, tagged item_type
// "comment". They are stored but ranked nowhere — the dashboard has no
// comments feed — so they are inert rather than misleading.
// Comments are excluded outright now: Facebook previews one or two replies
// per post and chooses them itself, so no honest ranking can come from them.
check("the reply is not captured at all", api9.queue().length, 1);
check("and everything captured is a post",
      api9.queue().every(function (p) { return p.item_type === "post"; }));

console.log("one article that throws must not kill the sweep");
// scanPosts runs from setInterval, so an exception anywhere in it aborted
// the whole pass and every pass after -- 0 captured, and nothing shown,
// because the reporting code never ran either.
var poisoned = buildPage([
  { body: "A perfectly good post before the bad one, with text.", likes: 40 },
  { body: "The article that explodes when touched at all.", likes: 60 },
  { body: "A perfectly good post after the bad one, with text.", likes: 90 }
]);
var bad = poisoned.root.children[1];
bad.querySelectorAll = function () { throw new Error("boom from Facebook markup"); };

var api10 = runScan(poisoned, "/groups/growth");
api10.scanPosts();
check("the healthy posts either side are still captured", api10.queue().length, 2);
// V1.7 has no per-sweep error counter; the message is what matters.
check("the failure is recorded, not swallowed",
      /failed/.test(api10.stats().lastError || ""));
check("and the message is kept for the panel",
      /boom from Facebook markup/.test(api10.stats().lastError || ""));

console.log("a caption with no dir=auto attribute");
// Reported from a live scan: "3 items, 1 reply, 2 empty". The posts had
// plenty of visible text; the selector just could not see it, because
// dir="auto" is a convention Facebook does not always follow.
var plain = buildPage([]);
var art2 = plain.doc.el("div");
art2.setAttribute("role", "article");
var h = plain.doc.el("a");
h.setAttribute("role", "link");
h.textContent = "Marcus Webb";
art2.appendChild(h);
var caption = plain.doc.el("div");          // deliberately NO dir attribute
caption.textContent = "Five things I learned scaling a team from three to thirty.";
art2.appendChild(caption);
var counts2 = plain.doc.el("div");
counts2.setAttribute("aria-label", "214 reactions");
art2.appendChild(counts2);
var bar2 = plain.doc.el("div");
bar2.setAttribute("role", "button");
bar2.setAttribute("aria-label", "Like");
bar2.textContent = "Like Comment Share";
art2.appendChild(bar2);
plain.root.appendChild(art2);

var api11 = runScan(plain, "/groups/growth");
api11.scanPosts();
check("the post is captured", api11.queue().length, 1);
check("and its caption came through",
      /Five things I learned/.test((api11.queue()[0] || {}).body || ""));
check("along with its engagement", (api11.queue()[0] || {}).likes, 214);

console.log("replies are tagged, not ranked");
var wc = buildPage([
  { body: "A real post with a decent amount of caption text on it.", likes: 400 }
]);
var art = wc.root.children[0];
var reply = wc.doc.el("div");
reply.setAttribute("role", "article");
var replyBody = wc.doc.el("div");
replyBody.setAttribute("dir", "auto");
replyBody.textContent = "A reply Facebook decided to preview under this post";
reply.appendChild(replyBody);
var replyBtn = wc.doc.el("div");
replyBtn.setAttribute("role", "button");
replyBtn.textContent = "Reply";
reply.appendChild(replyBtn);
art.appendChild(reply);

var api4 = runScan(wc, "/groups/growth");
api4.scanPosts();
check("a reply is stored as item_type comment, never as a post",
      api4.queue().every(function (p) {
        return p.item_type === "post" || p.item_type === "comment";
      }));

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("scan behaves");
// The content script installs timers and observers; without this the process
// stays alive after the assertions have all run.
process.exit(0);
