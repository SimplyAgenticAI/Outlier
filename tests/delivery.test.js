/* Getting the batch off the page.
 *
 * The failure this exists for: captured climbing while sent stays at zero,
 * with nothing on screen marked wrong.
 *
 * flush read `if (!source) { QUEUE = []; return; }` — if it could not name
 * the page at that instant, every post waiting to be sent was deleted. Not
 * held, not reported: deleted. Facebook is a single page app and the URL
 * moves constantly while a scan scrolls, through photo viewers, reels and
 * post permalinks, and any of those arriving between capture and send
 * destroyed the batch. Nothing was logged and no error was shown, so the
 * captured counter climbed over an empty queue — which is indistinguishable
 * from a scan that is working.
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

function scanned() {
  var page = buildPage([
    { body: "A post that needs to reach the dashboard", likes: 90, comments: 4, shares: 2 }
  ]);
  var api = runScan(page, "/groups/1234567890/");
  api.scanPosts();
  return api;
}

console.log("a healthy send delivers, and says so");

var ok = scanned();
ok.flush();
check("the batch leaves the queue", ok.queue().length, 0);
check("and is counted as sent", ok.stats().sent, 1);
check("with no error left showing", ok.stats().lastError, null);

console.log();
console.log("the URL drifting does not delete the queue");

var drifted = scanned();
check("a post is queued while the group is on screen", drifted.queue().length, 1);

// Facebook opens the photo viewer, as it does when a scan scrolls past media.
global.location = new URL("https://www.facebook.com/photo/?fbid=987654321");
global.window.location = global.location;
check("  and the page is no longer identifiable", drifted.detectSource(), null);

drifted.flush();
check("the post is NOT thrown away", drifted.stats().sent, 1);
check("  and it is filed under the group it came from",
      drifted.lastSource() && drifted.lastSource().fb_id, "group:1234567890");
check("  leaving nothing stranded", drifted.queue().length, 0);

/* A reel, and a post permalink — the other two the scan walks through. */
[
  "https://www.facebook.com/reel/1122334455",
  "https://www.facebook.com/watch/?v=5566778899"
].forEach(function (url) {
  var api = scanned();
  global.location = new URL(url);
  global.window.location = global.location;
  api.flush();
  check("survives a drift to " + url.replace("https://www.facebook.com", ""),
        api.stats().sent, 1);
});

global.location = new URL("https://www.facebook.com/groups/1234567890/");
global.window.location = global.location;

console.log();
console.log("reading an optional field cannot cost the post");

/* Captured climbing while sent stays at zero, with delivery working fine.
 *
 * SEEN.add ran before the payload was built, and the last two fields were
 * still being extracted inside the object literal below it. Those read the
 * live page, so they can throw — and when one did, the post was marked
 * captured and never queued. It looked exactly like a delivery failure and
 * was not one. The payload is built first now, and each optional field falls
 * back rather than aborting.
 */
var brittle = buildPage([{ body: "A post whose date makes the reader throw", likes: 55 }]);
var brittleApi = runScan(brittle, "/groups/1234567890/");

// The guard itself: a reader that throws yields the fallback, not an
// exception that unwinds past the queueing.
var opt = brittleApi.optional;
check("a throwing reader falls back",
      opt(function () { throw new Error("boom"); }, null), null);
check("  and a working one is used",
      opt(function () { return "photo"; }, "text"), "photo");
check("  undefined counts as nothing read",
      opt(function () { return undefined; }, "text"), "text");

brittleApi.scanPosts();
check("the post is queued", brittleApi.queue().length, 1);
check("  carrying no date rather than none of the post",
      brittleApi.queue()[0] && brittleApi.queue()[0].posted_at, null);
check("  and its engagement intact", brittleApi.queue()[0].likes, 55);

brittleApi.flush();
check("  and it reaches the dashboard", brittleApi.stats().sent, 1);

console.log();
console.log("a batch that fails is kept, not lost");

var failed = scanned();
global.chrome.runtime.sendMessage = function (_m, cb) {
  if (cb) cb({ ok: false, error: "Dashboard returned 500" });
};
failed.flush();
check("the posts go back on the queue", failed.queue().length, 1);
check("  none are counted as sent", failed.stats().sent, 0);
check("  and the reason is on screen",
      /500/.test(failed.stats().lastError || ""), true);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("delivery behaves");
process.exit(0);
