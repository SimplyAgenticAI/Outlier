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
check("See more was clicked", stickyPage.root
  .querySelectorAll('div[role="button"]')
  .some(function (b) { return b.clicked > 0; }));

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
check("each post kept its own identity", api6.queue().length, 12);

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
check("the reply is not queued", api9.queue().length, 1);

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
check("the failure is recorded, not swallowed", api10.stats().errors, 1);
check("and the message is kept for the panel",
      /boom from Facebook markup/.test(api10.stats().lastError || ""));

console.log("comments are counted, never captured");
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
check("nothing in the queue is a comment", api4.queue().every(function (p) {
  return p.item_type === "post";
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
