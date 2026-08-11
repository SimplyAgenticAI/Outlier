/* Getting the batch off the page, and knowing when it did not go.
 *
 * The failure this exists for: reload the extension with a Facebook tab
 * already open and the script injected into that tab is orphaned. It keeps
 * running — the panel updates, posts are read, the captured counter climbs —
 * but every message it sends is dropped. The page reported "Extension worker
 * asleep — retrying" and retried, forever. A sleeping worker wakes when a
 * message arrives; an orphaned one never will. So the retry was not
 * resilience, it was silent data loss with a reassuring label, and it looked
 * exactly like working software right up until you opened the dashboard and
 * found nothing there.
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
console.log("one post is one row, however late Facebook fills it in");

/* A scan set to 200 finished at 202. Not an off-by-two — one duplicate row
 * for each post whose permalink arrived after it was first read.
 *
 * A post is normally captured before Facebook has finished rendering it, then
 * re-read to pick up its numbers. The id comes from the permalink when there
 * is one and a hash of the content when there is not, so a post first seen
 * without its link got a hash and then, the moment the link appeared, a
 * completely different id — and a second row in the dashboard.
 */
var late = buildPage([{ body: "A post read before Facebook finished it", likes: 0 }]);
var lateApi = runScan(late, "/groups/1234567890/");
lateApi.scanPosts();
var firstId = (lateApi.queue()[0] || {}).fb_post_id;

var article = global.document.querySelectorAll('div[role="article"]')[0];
article.children.forEach(function (c) {
  var label = c.getAttribute("aria-label") || "";
  if (/reactions/.test(label)) c.setAttribute("aria-label", "412 reactions");
});
var link = late.doc.el("a");                    // the permalink, arriving late
link.setAttribute("href", "/groups/1234567890/posts/998877/");
link.href = "https://www.facebook.com/groups/1234567890/posts/998877/";
link.setAttribute("role", "link");
link.textContent = "2h";
article.appendChild(link);
lateApi.scanPosts();

var lateIds = lateApi.queue().map(function (p) { return p.fb_post_id; });
check("the post is re-sent with its numbers", lateIds.length > 1, true);
check("  under the id it was first given", new Set(lateIds).size, 1);
check("  which is the one the dashboard already has", lateIds[0], firstId);

console.log();
console.log("an orphaned extension is reported, not retried");

/* Exactly what Chrome does to a content script whose extension was reloaded:
 * the callback runs with lastError set and no response. */
var orphan = scanned();
global.chrome.runtime.sendMessage = function (_m, cb) {
  global.chrome.runtime.lastError = { message: "Extension context invalidated." };
  if (cb) cb(undefined);
  global.chrome.runtime.lastError = null;
};
orphan.flush();

check("the batch is kept rather than dropped", orphan.queue().length, 1);
check("nothing is counted as sent", orphan.stats().sent, 0);
check("the page says the extension needs a reload",
      /reload this page/i.test(orphan.stats().lastError || ""), true);
check("  and does NOT blame a sleeping worker",
      /asleep/i.test(orphan.stats().lastError || ""), false);

/* The same context, reported the other way Chrome words it. */
var orphan2 = scanned();
global.chrome.runtime.sendMessage = function (_m, cb) {
  global.chrome.runtime.lastError = {
    message: "Could not establish connection. Receiving end does not exist."
  };
  if (cb) cb(undefined);
  global.chrome.runtime.lastError = null;
};
orphan2.flush();
check("the other wording is recognised too",
      /reload this page/i.test(orphan2.stats().lastError || ""), true);

/* And sendMessage does not only report a dead context — it throws one. That
 * escaped the interval calling flush and took the batch with it. */
var thrower = scanned();
global.chrome.runtime.sendMessage = function () {
  throw new Error("Extension context invalidated.");
};
thrower.flush();
check("a throw is caught rather than escaping", true);
check("  the batch survives it", thrower.queue().length, 1);
check("  and it is reported as an orphan",
      /reload this page/i.test(thrower.stats().lastError || ""), true);

console.log();
console.log("the reason stays on screen for as long as it is true");

/* The regression that put this section here. Sending was correctly disabled
 * once the context died, but the message saying so was set a single time —
 * and changing group rebuilds STATS from blank while starting a scan clears
 * lastError. After either, the explanation was gone and the stop was silent:
 * posts stacked up under "waiting to send" with nothing to say why, forever.
 * The panel only shows "waiting to send" when there is NO error, so a silent
 * stop is indistinguishable from a healthy queue.
 */
var wiped = scanned();
global.chrome.runtime.sendMessage = function (_m, cb) {
  global.chrome.runtime.lastError = { message: "Extension context invalidated." };
  if (cb) cb(undefined);
  global.chrome.runtime.lastError = null;
};
wiped.flush();
check("the reason is shown the first time",
      /reload this page/i.test(wiped.stats().lastError || ""), true);

wiped.stats().lastError = null;          // as changing group or pressing Start does
wiped.scanPosts();
wiped.flush();
check("and again after something clears it",
      /reload this page/i.test(wiped.stats().lastError || ""), true);
check("  rather than sitting there silently",
      wiped.stats().lastError === null, false);
check("  with the posts still held, not dropped",
      wiped.queue().length > 0, true);

console.log();
console.log("a genuinely sleeping worker is still worth retrying");

var asleep = scanned();
global.chrome.runtime.sendMessage = function (_m, cb) {
  global.chrome.runtime.lastError = {
    message: "The message port closed before a response was received."
  };
  if (cb) cb(undefined);
  global.chrome.runtime.lastError = null;
};
asleep.flush();
check("the batch is kept for the next attempt", asleep.queue().length, 1);
check("and it is NOT called an orphan",
      /reload this page/i.test(asleep.stats().lastError || ""), false);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("delivery behaves");
process.exit(0);
