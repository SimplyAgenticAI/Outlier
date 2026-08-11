/* The updater must never restart the extension by itself.
 *
 * This is the one that cost a day. checkForUpdate ran on a one minute alarm
 * AND on every service worker startup — and MV3 starts the worker constantly.
 * If the dashboard advertised a version different from the running one, and
 * the endpoint was local, it called chrome.runtime.reload().
 *
 * Reloading the extension orphans the content script in every open Facebook
 * tab. So on a day when the dashboard's version kept moving ahead, every scan
 * was racing an extension that kept restarting underneath it: captured
 * climbing, sent stuck at zero, nothing in the dashboard. It looked like a
 * delivery bug, and no amount of fixing delivery could have helped, because
 * the tab doing the delivering was being killed.
 *
 * Reverting the extension to an older build did not help either — this code
 * was in every version.
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

function load(opts) {
  opts = opts || {};
  var world = { reloads: 0, alarmHandler: null, store: {
    endpoint: opts.endpoint || "http://localhost:5050",
    apiKey: "key-1",
    capturing: opts.capturing === true
  } };

  global.chrome = {
    runtime: {
      onMessage: { addListener: function () {} },
      onInstalled: { addListener: function () {} },
      getManifest: function () { return { version: opts.running || "1.0.0" }; },
      reload: function () { world.reloads++; },
      lastError: null
    },
    storage: {
      local: {
        get: function (keys) {
          var out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
            if (world.store[k] !== undefined) out[k] = world.store[k];
          });
          return Promise.resolve(out);
        },
        set: function (o) { Object.assign(world.store, o); return Promise.resolve(); },
        remove: function (keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
            delete world.store[k];
          });
          return Promise.resolve();
        }
      },
      onChanged: { addListener: function () {} }
    },
    alarms: {
      create: function () {},
      onAlarm: { addListener: function (fn) { world.alarmHandler = fn; } }
    },
    action: { setBadgeText: function () {}, setBadgeBackgroundColor: function () {} },
    permissions: { contains: function (_o, cb) { cb(true); } }
  };

  global.fetch = function (url) {
    if (url.indexOf("/api/ping") !== -1) {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () {
          return Promise.resolve({ extension_version: opts.latest || "9.9.9" });
        }
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({}); } });
  };

  delete require.cache[require.resolve(SRC)];
  require(SRC);              // running it calls checkForUpdate on startup
  return world;
}

function settle() { return new Promise(function (r) { setTimeout(r, 30); }); }

Promise.resolve()
  .then(function () {
    console.log("a newer version on a local dashboard does not restart anything");

    /* The exact conditions that were firing all day: a local endpoint and a
     * dashboard reporting a version ahead of the one loaded. */
    var world = load({ running: "2.19.0", latest: "2.20.0" });
    return settle().then(function () {
      check("the extension is not reloaded on startup", world.reloads, 0);
      check("  and the update is recorded for the popup to show",
            world.store.updateStuck, "2.20.0");
    });
  })
  .then(function () {
    console.log();
    console.log("nor on the alarm, however often it fires");

    var world = load({ running: "2.19.0", latest: "2.20.0" });
    return settle()
      .then(function () {
        for (var i = 0; i < 5; i++) world.alarmHandler({ name: "tallgrass-update" });
        return settle();
      })
      .then(function () {
        check("five checks, still no reload", world.reloads, 0);
      });
  })
  .then(function () {
    console.log();
    console.log("and it stays quiet when there is nothing to report");

    var world = load({ running: "2.20.0", latest: "2.20.0" });
    return settle().then(function () {
      check("no reload", world.reloads, 0);
      check("nothing flagged as pending", world.store.updateStuck, undefined);
    });
  })
  .then(function () {
    console.log();
    if (FAILURES.length) {
      console.log(FAILURES.length + " FAILURES");
      process.exit(1);
    }
    console.log("the updater behaves");
    process.exit(0);
  })
  .catch(function (err) {
    console.log("harness error:", (err && err.stack) || err);
    process.exit(1);
  });
