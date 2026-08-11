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
console.log("the URL drifting does not delete the queue");

/* Two hundred captured, zero sent, no error anywhere.
 *
 * flush used to read `if (!source) { QUEUE = []; return; }` — if it could not
 * name the page at that instant, every post waiting to be sent was deleted.
 * Facebook is a single page app and the URL moves constantly while you
 * scroll: a photo viewer, a reel, a post permalink. Any of those, landing
 * between capture and send, destroyed the batch silently. Nothing was logged,
 * no error was shown, and the captured counter carried on climbing.
 */
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

// Back on the group, everything still works.
global.location = new URL("https://www.facebook.com/groups/1234567890/");
global.window.location = global.location;

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
      /reload this facebook tab/i.test(orphan.stats().lastError || ""), true);
check("  and does NOT blame a sleeping worker",
      /asleep/i.test(orphan.stats().lastError || ""), false);

/* A real orphan reported the ambiguous way is still caught — but on evidence,
 * not on wording. "Receiving end does not exist" is what a genuinely dead
 * extension says AND what a sleeping worker says, so the message decides
 * nothing and the live check decides everything. Here the context is really
 * gone: touching the runtime throws, exactly as Chrome makes it. */
var orphan2 = scanned();
global.chrome.runtime.sendMessage = function (_m, cb) {
  // Dead before the callback runs, which is the order Chrome does it in.
  global.chrome.runtime.getManifest = function () {
    throw new Error("Extension context invalidated.");
  };
  global.chrome.runtime.lastError = {
    message: "Could not establish connection. Receiving end does not exist."
  };
  if (cb) cb(undefined);
  global.chrome.runtime.lastError = null;
};
orphan2.flush();
check("a genuinely dead context is caught however it is worded",
      /reload this facebook tab/i.test(orphan2.stats().lastError || ""), true);

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
      /reload this facebook tab/i.test(thrower.stats().lastError || ""), true);

console.log();
console.log("a sleeping worker is a nap, not a death");

/* THE bug. "Receiving end does not exist" was treated as a dead extension,
 * but Chrome lets the service worker sleep after half a minute idle and the
 * first message after that routinely fails with exactly those words before it
 * is woken. So the most ordinary event in the extension's life turned
 * delivery off permanently — and silently, because the explanation was wiped
 * by the next group change. The panel sat on "waiting to send", nothing sent,
 * nothing marked wrong, for as long as the tab stayed open.
 *
 * The words alone must decide nothing. Only a context that fails a live check
 * counts as gone.
 */
var napped = scanned();
var asleepOnce = true;
global.chrome.runtime.sendMessage = function (_m, cb) {
  if (asleepOnce) {
    asleepOnce = false;
    global.chrome.runtime.lastError = {
      message: "Could not establish connection. Receiving end does not exist."
    };
    if (cb) cb(undefined);
    global.chrome.runtime.lastError = null;
    return;
  }
  if (cb) cb({ ok: true, new: 1 });          // awake now, as it really is
};

napped.flush();
check("the batch is held, not lost", napped.queue().length, 1);
check("  and the page does NOT declare the extension dead",
      /reload this/i.test(napped.stats().lastError || ""), false);

napped.flush();                              // the worker is up by now
check("the very next attempt delivers", napped.stats().sent, 1);
check("  leaving nothing queued", napped.queue().length, 0);
check("  and no error behind", napped.stats().lastError, null);

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
      /reload this facebook tab/i.test(asleep.stats().lastError || ""), false);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("delivery behaves");
process.exit(0);
