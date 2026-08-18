/* The service worker: the only thing that talks to the dashboard.
 *
 * "Key refreshed — retrying", forty-one captured and seven delivered.
 *
 * Keys are stored hashed, so the dashboard cannot read one back — asking for
 * a key without presenting one means minting one, and minting revokes
 * whatever is in use. Batches run concurrently, so when a key went stale they
 * all found out together and all asked separately; every replacement killed
 * the one before it, and batches went out spending keys their own siblings
 * had just invalidated.
 *
 * Two things made it self-sustaining. The handler DELETED the key before
 * asking, and an extension with no key looks disconnected — the dashboard's
 * auto-connect mints one whenever it believes that, so merely having the
 * dashboard open rotated the key out from under a scan. And the message said
 * "retrying" when nothing retried: the batch simply waited for a later sweep,
 * by which time another batch had usually rotated the key again.
 *
 * The fake dashboard below has the property that matters — one key at a time,
 * and minting replaces it — so these tests fail if any of that comes back.
 */
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

function makeWorld(opts) {
  opts = opts || {};
  var world = {
    liveKey: opts.liveKey === undefined ? "key-1" : opts.liveKey,
    signedIn: opts.signedIn !== false,
    idempotent: opts.idempotent !== false,
    minted: 0,
    accepted: 0,
    rejected: 0
  };

  var store = {
    endpoint: "https://dash.test",
    apiKey: opts.storedKey === undefined ? "key-1" : opts.storedKey
  };
  world.store = store;

  global.chrome = {
    runtime: {
      onMessage: { addListener: function (fn) { world.onMessage = fn; } },
      onInstalled: { addListener: function () {} },
      getManifest: function () { return { version: "1.0.0" }; },
      reload: function () { world.reloaded = true; },
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
        set: function (o) { Object.assign(store, o); return Promise.resolve(); },
        remove: function (keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
          return Promise.resolve();
        }
      },
      onChanged: { addListener: function () {} }
    },
    alarms: { create: function () {}, onAlarm: { addListener: function () {} } },
    action: { setBadgeText: function () {}, setBadgeBackgroundColor: function () {} },
    permissions: { contains: function (_o, cb) { cb(true); } },
    tabs: {
      query: function (q) {
        world.queried = q;
        return Promise.resolve(opts.openTabs || []);
      },
      update: function (id, props) {
        world.updatedTab = { id: id, props: props };
        return Promise.resolve();
      },
      create: function (props) {
        world.createdTab = props;
        return Promise.resolve({ id: 99 });
      }
    },
    windows: {
      update: function (id, props) {
        world.focusedWindow = { id: id, props: props };
        return Promise.resolve();
      }
    }
  };

  global.fetch = function (url, init) {
    var headers = (init && init.headers) || {};

    if (url.indexOf("/api/extension/key") !== -1) {
      if (!world.signedIn) {
        return Promise.resolve({ ok: false, status: 401,
                                 json: function () { return Promise.resolve({}); } });
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
      world.liveKey = "key-" + (world.minted + 1);      // minting revokes the last
      var fresh = world.liveKey;
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ api_key: fresh, rotated: true }); }
      });
    }

    if (url.indexOf("/api/ping") !== -1) {
      return Promise.resolve({ ok: true, status: 200,
        json: function () { return Promise.resolve({ extension_version: "1.0.0" }); } });
    }

    if (url.indexOf("/api/capture") !== -1) {
      var key = headers["X-Outlier-Key"];
      var body = JSON.parse(init.body);
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (key !== world.liveKey) {
            world.rejected++;
            resolve({ ok: false, status: 401,
                      json: function () { return Promise.resolve({}); } });
            return;
          }
          world.accepted += body.posts.length;
          resolve({ ok: true, status: 200,
            json: function () { return Promise.resolve({ ok: true, new: body.posts.length }); } });
        }, 4);
      });
    }

    return Promise.resolve({ ok: false, status: 404,
                             json: function () { return Promise.resolve({}); } });
  };

  delete require.cache[require.resolve(SRC)];
  require(SRC);
  return world;
}

function capture(world, n) {
  return new Promise(function (resolve) {
    world.onMessage(
      { type: "OUTLIER_CAPTURE",
        source: { fb_id: "group:1", kind: "group", name: "G" },
        posts: [{ fb_post_id: "p" + n, body: "post " + n, likes: n }] },
      {},
      resolve
    );
  });
}

function many(world, n) {
  var all = [];
  for (var i = 0; i < n; i++) all.push(capture(world, i));
  return Promise.all(all);
}

Promise.resolve()
  .then(function () {
    console.log("a healthy scan delivers every batch");
    var world = makeWorld();
    return many(world, 10).then(function (results) {
      check("all ten are answered", results.length, 10);
      check("all ten land", results.every(function (r) { return r && r.ok; }), true);
      check("all ten posts reach the dashboard", world.accepted, 10);
      check("no key is minted at all", world.minted, 0);
    });
  })
  .then(function () {
    console.log();
    console.log("a stale key costs one refresh, not one per batch");

    /* The screenshot: the extension holds a key the dashboard has already
     * replaced, which is what an open dashboard tab or any earlier rotation
     * does to a running scan. */
    var world = makeWorld({ liveKey: "key-live", storedKey: "key-stale" });
    return many(world, 20).then(function (results) {
      var delivered = results.filter(function (r) { return r && r.ok; }).length;
      check("all twenty are delivered, not a fraction", delivered, 20);
      check("  and every post reaches the dashboard", world.accepted, 20);
      check("exactly one key is issued for all of them", world.minted, 1);
      check("nobody is told 'retrying' by something that will not retry",
            results.some(function (r) { return r && /retrying/i.test(r.error || ""); }),
            false);
    });
  })
  .then(function () {
    console.log();
    console.log("the key is never thrown away while it is the only one we have");

    /* Deleting it made the extension look disconnected, and the dashboard
     * mints a key whenever it believes that — so an open dashboard tab
     * rotated the key out from under the scan. */
    var world = makeWorld({ liveKey: "key-live", storedKey: "key-stale", signedIn: false });
    return capture(world, 1).then(function (r) {
      check("a refresh that cannot happen is reported plainly",
            /sign in/i.test((r && r.error) || ""), true);
      check("  and the key is still there", !!world.store.apiKey, true);
    });
  })
  .then(function () {
    console.log();
    console.log("a rejection is still an answer");
    var world = makeWorld();
    global.fetch = function () { return Promise.reject(new Error("boom")); };
    return capture(world, 1).then(function (r) {
      check("the page is answered rather than left waiting", !!r, true);
      check("  and told it failed", r.ok !== true, true);
    });
  })
  /* Open dashboard focuses the one that is open.
   *
   * It called window.open(url, "_blank"), and "_blank" means a brand new tab
   * every time — so every trip back from Facebook left another dashboard
   * behind and the operator was closing eight of them. */
  .then(function () {
    console.log();
    console.log("Open dashboard reuses the tab that is already open");

    function openDashboard(world) {
      return new Promise(function (resolve) {
        world.onMessage({ type: "OUTLIER_OPEN_DASHBOARD", path: "/" }, null, resolve);
      });
    }

    var withTab = makeWorld({ openTabs: [{ id: 7, windowId: 3, url: "https://dash.test/groups" }] });
    require(SRC);
    return openDashboard(withTab).then(function (r) {
      check("it reports reuse", r && r.reused, true);
      check("the existing tab is activated", withTab.updatedTab.props.active, true);
      check("and pointed at the requested page", withTab.updatedTab.props.url, "https://dash.test/");
      check("its window is brought forward", withTab.focusedWindow.id, 3);
      check("NO second dashboard is opened", withTab.createdTab === undefined, true);
      check("the lookup is scoped to the dashboard origin",
            withTab.queried.url, "https://dash.test/*");
    });
  })
  .then(function () {
    // Nothing open yet — it must still open one, or the button does nothing.
    var noTab = makeWorld({ openTabs: [] });
    delete require.cache[require.resolve(SRC)];
    require(SRC);
    return new Promise(function (resolve) {
      noTab.onMessage({ type: "OUTLIER_OPEN_DASHBOARD", path: "/ideas?source=4" }, null, resolve);
    }).then(function (r) {
      check("with none open it opens one", r && r.reused, false);
      check("at the right address", noTab.createdTab.url, "https://dash.test/ideas?source=4");
      check("and nothing was activated", noTab.updatedTab === undefined, true);
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
    console.log("harness error:", (err && err.stack) || err);
    process.exit(1);
  });
