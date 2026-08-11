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
