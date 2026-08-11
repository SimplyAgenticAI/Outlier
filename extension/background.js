/* Service worker — the only thing that talks to the dashboard.
 * Content scripts hand batches here so the cross-origin POST happens from an
 * extension context rather than from facebook.com.
 */

/* Where this copy of the extension came from.
 *
 * The dashboard builds the zip, so it stamps its own origin in here on the way
 * out — the download from tallgrass.example already knows to talk to
 * tallgrass.example. Nobody types a URL, and a hosted install never sits there
 * pointing at a localhost that was never running.
 *
 * The literal below is the development default and is rewritten verbatim by
 * download_extension() in app.py; the marker is what it matches on, so don't
 * reformat this line.
 */
const DEFAULT_ENDPOINT = "http://localhost:5050"; /*@@TALLGRASS_HOME@@*/

/* The account key, stamped in alongside the origin.
 *
 * You were signed in when you downloaded this, so the server minted a key and
 * baked it in. There is nothing to copy and nothing to paste — the extension
 * works the moment Chrome loads it. Left empty in the repo copy and in the
 * shareable zip, which deliberately carries no credentials.
 */
const DEFAULT_API_KEY = ""; /*@@TALLGRASS_KEY@@*/

function toOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return String(url || "").replace(/\/+$/, "");
  }
}

async function getEndpoint() {
  const stored = await chrome.storage.local.get(["endpoint"]);
  // Normalised to an origin: a pasted page URL such as ".../pricing" would
  // otherwise produce ".../pricing/api/capture" and 404 on every batch.
  return toOrigin(stored.endpoint || DEFAULT_ENDPOINT);
}

// The dashboard is multi-account now, so a capture has to say whose it is.
// The key is a bearer token: it is the only credential the extension holds.
async function getApiKey() {
  const stored = await chrome.storage.local.get(["apiKey"]);
  const existing = (stored.apiKey || "").trim();
  if (existing) return existing;

  // Nothing stored — ask the dashboard for one. See fetchKeyFromDashboard.
  return await fetchKeyFromDashboard();
}

/* Get a key without the user doing anything.
 *
 * They are already signed in to the dashboard in this browser, and this
 * extension holds a host permission for that origin — so it can make the
 * request itself, with the session cookie, and store the result. There is
 * nothing to copy, nothing to paste, and no "no account key set" to hit.
 *
 * The custom header is what stops a web page doing the same: a page cannot
 * send it cross-origin without a CORS preflight, and the route sends no
 * Access-Control-Allow-Origin, so the browser refuses the response. An
 * extension with host permissions is exempt from CORS, which is the
 * asymmetry this relies on.
 */
async function fetchKeyFromDashboard() {
  const endpoint = await getEndpoint();
  if (!endpoint) return "";

  try {
    const response = await fetch(`${endpoint}/api/extension/key`, {
      method: "POST",
      credentials: "include",
      headers: { "X-Tallgrass-Extension": "1" }
    });
    if (!response.ok) return "";          // not signed in, or not our server

    const data = await response.json();
    if (!data || !data.api_key) return "";

    await chrome.storage.local.set({ apiKey: data.api_key });
    return data.api_key;
  } catch (error) {
    return "";                            // offline, or no permission yet
  }
}

async function bumpCounter(newCount) {
  const stored = await chrome.storage.local.get(["totalCaptured"]);
  const total = (stored.totalCaptured || 0) + newCount;
  await chrome.storage.local.set({ totalCaptured: total, lastCapture: Date.now() });

  // Badge shows the running total so progress is visible without opening the popup.
  chrome.action.setBadgeText({ text: total > 999 ? "999+" : String(total) });
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
}

function describe(err) {
  if (!err) return "The extension hit an unknown error";
  return String(err.message || err).slice(0, 200);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  /* Always answer, even when answering is bad news.
   *
   * These used to be .then(sendResponse) with no catch. A rejection anywhere
   * inside meant sendResponse was never called, the channel stayed open
   * until it timed out, and the page saw only "worker asleep" — so a real
   * error surfaced as a phantom sleeping worker and the batch was retried
   * forever instead of being reported.
   */
  if (message.type === "OUTLIER_CAPTURE") {
    handleCapture(message)
      .catch((err) => ({ ok: false, error: describe(err) }))
      .then(sendResponse);
    return true;  // keep the channel open for the async reply
  }

  if (message.type === "OUTLIER_PING") {
    testConnection()
      .catch((err) => ({ ok: false, error: describe(err) }))
      .then(sendResponse);
    return true;
  }
});

async function handleCapture(message) {
  const endpoint = await getEndpoint();

  if (!(await hasHostPermission(endpoint))) {
    return {
      ok: false,
      error: "No Chrome permission for " + endpoint + " — re-save it in the popup"
    };
  }

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      return {
        ok: false,
        error: "Sign in at " + endpoint + " in this browser — the key is then automatic."
      };
    }

    const response = await fetch(`${endpoint}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Outlier-Key": apiKey },
      body: JSON.stringify({ source: message.source, posts: message.posts })
    });

    if (response.status === 401) {
      /* Throw the dead key away.
       *
       * Keeping it meant the extension looked connected forever: the
       * dashboard's auto-connect only re-issues when it believes there is
       * no key, and a REVOKED key is indistinguishable from a live one
       * until it is used. Captures piled up locally and never landed, with
       * nothing on either side saying why.
       */
      // Throw the dead key away and immediately ask for a live one. A
      // revoked key is indistinguishable from a good one until it is used,
      // so without this the extension would keep sending with it forever.
      await chrome.storage.local.remove(["apiKey"]);
      const fresh = await fetchKeyFromDashboard();
      if (fresh) {
        return { ok: false, error: "Key refreshed — retrying", retry: true };
      }
      return {
        ok: false,
        error: "Sign in at " + endpoint + " in this browser to reconnect."
      };
    }
    if (response.status === 402) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error || "Plan limit reached", upgrade: true };
    }
    if (!response.ok) {
      return { ok: false, error: `Dashboard returned ${response.status}` };
    }

    const data = await response.json();
    if (data.new) await bumpCounter(data.new);
    return data;
  } catch (error) {
    // Dashboard not running is the common case — don't spam the console.
    return { ok: false, error: "Could not reach the dashboard at " + endpoint };
  }
}

// A blocked origin and an unreachable server both surface as a TypeError from
// fetch, which is why "could not reach the dashboard" was being reported for
// what was actually a missing permission. Check the permission explicitly so
// the two can be told apart.
function hasHostPermission(endpoint) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = new URL(endpoint).origin + "/*";
    } catch (error) {
      return resolve(false);
    }
    chrome.permissions.contains({ origins: [origin] }, (has) => resolve(!!has));
  });
}

async function testConnection() {
  const endpoint = await getEndpoint();

  if (!(await hasHostPermission(endpoint))) {
    return {
      ok: false,
      endpoint,
      error: "Chrome hasn't granted access to " + endpoint +
             ". Re-save it in the popup and approve the prompt."
    };
  }

  try {
    const response = await fetch(`${endpoint}/api/ping`);
    const data = await response.json();
    return {
      ok: true,
      version: data.version,
      extension_version: data.extension_version,
      is_local: data.is_local,
      endpoint
    };
  } catch (error) {
    return { ok: false, endpoint, error: "No response from " + endpoint };
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // Only seed defaults on a genuine first install. This handler also fires on
  // update and on every chrome.runtime.reload(), and writing the endpoint back
  // each time is how a configured dashboard kept reverting to localhost.
  if (details.reason !== "install") return;

  const stored = await chrome.storage.local.get(["enabled", "endpoint", "apiKey"]);
  const seed = { enabled: stored.enabled !== false };
  if (!stored.endpoint) seed.endpoint = DEFAULT_ENDPOINT;
  if (!stored.apiKey && DEFAULT_API_KEY) seed.apiKey = DEFAULT_API_KEY;
  await chrome.storage.local.set(seed);
});

/* ------------------------------------------------------------ self-update
 *
 * Chrome Web Store extensions update themselves. An unpacked one does not —
 * but chrome.runtime.reload() re-reads the extension folder from disk, so if
 * that folder IS the repo, reloading picks up whatever changed.
 *
 * The dashboard reports the version in extension/manifest.json. When that
 * differs from the version actually running, the files on disk are newer
 * than this process and a reload will adopt them.
 */

const UPDATE_ALARM = "outlier-update-check";

// chrome.runtime.reload() re-reads the extension folder from disk. That only
// produces a NEW version when the folder is the live project — i.e. when the
// dashboard is running on this same machine.
//
// Against a hosted dashboard (Render), the server's manifest can be newer
// while the folder on disk is a downloaded zip that never changes. Reloading
// then re-reads the same old files, the mismatch survives, and the next alarm
// reloads again — forever. So: only self-update against a local dashboard,
// and give up after one ineffective attempt regardless.
function isLocalEndpoint(endpoint) {
  try {
    const host = new URL(endpoint).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch (error) {
    return false;
  }
}

async function checkForUpdate() {
  const stored = await chrome.storage.local.get([
    "autoUpdate", "capturing", "updateAttemptedFor"
  ]);
  if (stored.autoUpdate === false) return;

  // Reloading mid-scroll would drop the in-memory queue and orphan the
  // content script while the user is watching it work. Wait for idle.
  if (stored.capturing) return;

  const endpoint = await getEndpoint();
  let data;
  try {
    const response = await fetch(`${endpoint}/api/ping`, { cache: "no-store" });
    data = await response.json();
  } catch (error) {
    return;   // dashboard down — nothing to compare against
  }

  const latest = data.extension_version;
  const running = chrome.runtime.getManifest().version;
  if (!latest || latest === running) {
    // Back in sync — clear any stale "update pending" state.
    if (stored.updateAttemptedFor) {
      await chrome.storage.local.remove(["updateAttemptedFor", "updateStuck"]);
    }
    return;
  }

  if (!isLocalEndpoint(endpoint)) {
    // Hosted dashboard: reloading cannot help. Flag it so the popup can tell
    // the user to download a fresh copy instead of silently doing nothing.
    await chrome.storage.local.set({ updateStuck: latest });
    return;
  }

  if (stored.updateAttemptedFor === latest) {
    // We already reloaded for this version and it did not take, so the folder
    // is not the live project. Stop looping and say so.
    await chrome.storage.local.set({ updateStuck: latest });
    return;
  }

  await chrome.storage.local.set({
    updateAttemptedFor: latest,
    lastUpdateFrom: running,
    lastUpdateTo: latest
  });
  console.log(`[Tallgrass] updating extension ${running} → ${latest}`);
  chrome.runtime.reload();
}

chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

// Also check on startup, so a reload adopts changes immediately rather than
// waiting out the alarm period.
checkForUpdate();
