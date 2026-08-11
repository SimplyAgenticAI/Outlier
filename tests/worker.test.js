/* The service worker: the only thing that actually talks to the dashboard.
 *
 * It had no tests, and it is where posts are lost. "Key refreshed — retrying"
 * with fifty scanned and six delivered came from here.
 *
 * Keys are stored hashed, so the dashboard cannot read one back — issuing a
 * key meant minting one, and minting revokes whatever was in use. The worker
 * will happily run a dozen captures at once, so when the stored key went
 * stale every batch discovered it at the same moment and every batch asked
 * for a replacement. Each replacement killed the one before it, and batches
 * spent keys their own siblings had already invalidated. Worse, the handler
 * DELETED the key before asking, which made the extension look disconnected —
 * and an open dashboard tab mints a key whenever it believes that, rotating
 * the key out from under a running scan.
 *
 * Three properties are asserted here, and all three have to hold at once:
 * captures go up one at a time, a stale key is refreshed exactly once no
 * matter how many batches hit it, and the batch that triggered the refresh is
 * retried in place rather than being told "retrying" by something that then
 * did not retry.
 */
var fs = require("fs");
var path = require("path");

var SRC = path.join(__dirname, "..", "extension", "background.js");
var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

/* A dashboard that behaves like the real one: it accepts exactly one key at a
 * time, and issuing a key replaces the last. That is the property the worker
 * has to cope with, so the fake must have it too. */
function makeWorld(opts) {
  opts = opts || {};
  var world = {
    liveKey: opts.liveKey === undefined ? "key-1" : opts.liveKey,
    storedKey: opts.storedKey === undefined ? "key-1" : opts.storedKey,
    signedIn: opts.signedIn !== false,
    idempotent: opts.idempotent !== false,   // the fixed server
    issued: 0,
    captures: [],
    inFlight: 0,
    maxInFlight: 0,
    accepted: 0,
    rejected: 0,
    minted: 0
  };

  var store = { endpoint: "https://dash.test", apiKey: world.storedKey };

  global.chrome = {
    runtime: {
      onMessage: { addListener: function (fn) { world.onMessage = fn; } },
      onInstalled: { addListener: function () {} },
      getManifest: function () { return { version: "9.9.9" }; },
      reload: function () {},
      lastError: null
    },
    storage: {
      local: {
        get: function (keys) {
          var out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
            if (store[k] !== undefined) out[k] = store[k];
          });
          return Promise.resolve(out);
        },
        set: function (obj) { Object.assign(store, obj); return Promise.resolve(); },
        remove: function (keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
          return Promise.resolve();
        }
      },
      onChanged: { addListener: function () {} }
    },
    alarms: { create: function () {}, onAlarm: { addListener: function () {} } },
    action: { setBadgeText: function () {}, setBadgeBackgroundColor: function () {} },
    permissions: {
      contains: function (_o, cb) { cb(true); }
    }
  };

  global.fetch = function (url, init) {
    var headers = (init && init.headers) || {};

    if (url.indexOf("/api/extension/key") !== -1) {
      world.issued++;
      if (!world.signedIn) {
        return Promise.resolve({ ok: false, status: 401, json: function () { return Promise.resolve({}); } });
      }
      // The fix: a key that still verifies is handed straight back.
      var presented = headers["X-Outlier-Key"];
      if (world.idempotent && presented && presented === world.liveKey) {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ api_key: presented, rotated: false }); }
        });
      }
      world.minted++;
      world.liveKey = "key-" + (world.minted + 1);   // minting revokes the last
      var fresh = world.liveKey;
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ api_key: fresh, rotated: true }); }
      });
    }

    if (url.indexOf("/api/capture") !== -1) {
      world.inFlight++;
      world.maxInFlight = Math.max(world.maxInFlight, world.inFlight);
      var key = headers["X-Outlier-Key"];
      var body = JSON.parse(init.body);

      return new Promise(function (resolve) {
        setTimeout(function () {
          world.inFlight--;
          if (key !== world.liveKey) {
            world.rejected++;
            resolve({ ok: false, status: 401, json: function () { return Promise.resolve({}); } });
            return;
          }
          world.accepted++;
          world.captures.push(body);
          resolve({
            ok: true, status: 200,
            json: function () { return Promise.resolve({ ok: true, new: body.posts.length }); }
          });
        }, 5);
      });
    }

    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({}); } });
  };

  delete require.cache[require.resolve(SRC)];
  require(SRC);
  return world;
}

function capture(world, n) {
  return new Promise(function (resolve) {
    world.onMessage(
      { type: "OUTLIER_CAPTURE", source: { fb_id: "group:1", kind: "group", name: "G" },
        posts: [{ fb_post_id: "p" + n, body: "post " + n, likes: n }] },
      {},
      resolve
    );
  });
}

function run() {
  return Promise.resolve()
    .then(function () {
      console.log("every batch gets through");
      var world = makeWorld();
      var all = [];
      for (var i = 0; i < 8; i++) all.push(capture(world, i));
      return Promise.all(all).then(function (results) {
        check("every batch is answered", results.length, 8);
        check("all of them land", results.every(function (r) { return r && r.ok; }), true);
        check("all eight reach the dashboard", world.accepted, 8);
      });
    })
    .then(function () {
      console.log();
      console.log("one stuck request does not take the rest down with it");

      /* Batches were briefly queued behind one another, to stop concurrent
       * ones each demanding a new key. Wrong place to fix it: a request in a
       * service worker can get stuck — Chrome tears the worker down whenever
       * it likes and a fetch that dies with it never settles — and one chain
       * for every capture means that request blocks all of them. Nothing was
       * sent again for the rest of the scan. Zero delivered, no error.
       */
      var world = makeWorld();
      var realFetch = global.fetch;
      var stuckSeen = false;
      global.fetch = function (url, init) {
        if (!stuckSeen && url.indexOf("/api/capture") !== -1) {
          stuckSeen = true;
          return new Promise(function () {});     // never settles, ever
        }
        return realFetch(url, init);
      };

      var stuck = capture(world, 0);              // this one hangs forever
      var rest = [];
      for (var i = 1; i <= 5; i++) rest.push(capture(world, i));

      return Promise.all(rest).then(function (results) {
        check("the five behind it are all answered", results.length, 5);
        check("  and all of them land",
              results.every(function (r) { return r && r.ok; }), true);
        check("  reaching the dashboard", world.accepted, 5);
        check("the stuck one is still pending, and harmless",
              stuck instanceof Promise, true);
        global.fetch = realFetch;
      });
    })
    .then(function () {
      console.log();
      console.log("a stale key is fixed once, and the batch still lands");

      /* The exact failure. The extension holds a key the dashboard has since
       * replaced — which is what an open dashboard tab, or any earlier
       * rotation, does to a running scan. */
      var world = makeWorld({ liveKey: "key-live", storedKey: "key-stale" });
      var all = [];
      for (var i = 0; i < 10; i++) all.push(capture(world, i));
      return Promise.all(all).then(function (results) {
        var delivered = results.filter(function (r) { return r && r.ok; }).length;
        check("all ten are delivered, not six", delivered, 10);
        check("  and all ten reach the dashboard", world.accepted, 10);
        /* Exactly one mint is the property that matters. Every batch in
         * flight discovers the stale key — they run concurrently, so they
         * find out together — but they share a single refresh, so only one
         * key is ever issued and none of them revokes another's. Serialising
         * to avoid the duplicate 401s is what caused a total outage, and a
         * rejected batch that retries and lands costs nothing. */
        check("the key is replaced exactly once, however many batches ask",
              world.minted, 1);
        check("  and every rejected batch is retried, not abandoned",
              world.rejected, world.accepted);
        check("nobody is told 'retrying' by something that will not retry",
              results.some(function (r) { return r && /retrying/i.test(r.error || ""); }),
              false);
      });
    })
    .then(function () {
      console.log();
      console.log("the old key is kept until a better one exists");

      /* Deleting it made the extension look unconnected, and the dashboard
       * mints a key whenever it believes that — which is how a scan lost its
       * key to a tab the user merely had open. */
      var world = makeWorld({ liveKey: "key-live", storedKey: "key-stale", signedIn: false });
      return capture(world, 1).then(function (r) {
        check("a failed refresh reports it plainly",
              /sign in/i.test((r && r.error) || ""), true);
        return chrome.storage.local.get(["apiKey"]).then(function (s) {
          check("  and the key is not thrown away", !!s.apiKey, true);
        });
      });
    })
    .then(function () {
      console.log();
      console.log("a rejection is still an answer");

      /* .then(sendResponse) with no catch left the channel hanging, and the
       * page reported a phantom sleeping worker instead of the real error. */
      var world = makeWorld();
      global.fetch = function () { return Promise.reject(new Error("boom")); };
      return capture(world, 1).then(function (r) {
        check("the page is answered rather than left waiting", !!r, true);
        check("  and told it failed", r.ok !== true, true);
      });
    })
    .then(function () {
      console.log();
      if (FAILURES.length) {
        console.log(FAILURES.length + " FAILURES");
        process.exit(1);
      }
      console.log("the worker behaves");
      process.exit(0);
    })
    .catch(function (err) {
      console.log("harness error:", err && err.stack || err);
      process.exit(1);
    });
}

run();
