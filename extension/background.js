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

  // Nothing stored — go through the shared refresh, so a cold start holding
  // several batches cannot mint several keys at once.
  return await refreshKey();
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
    /* Present the key we already hold.
     *
     * Keys are stored hashed, so the dashboard cannot read one back: asking
     * without presenting one is asking for a rotation, and a rotation revokes
     * whatever is in use. Batches run concurrently, so when a key goes stale
     * they all discover it together and all ask — and each replacement kills
     * the one before it. That is "Key refreshed — retrying" on repeat, with a
     * fraction of the scan delivered.
     *
     * Presenting it lets the dashboard verify it and return the same one, so
     * nothing is revoked and no other batch is disturbed.
     */
    const held = await chrome.storage.local.get(["apiKey"]);
    const headers = { "X-Tallgrass-Extension": "1" };
    if (held.apiKey) headers["X-Outlier-Key"] = held.apiKey;

    const response = await fetch(`${endpoint}/api/extension/key`, {
      method: "POST",
      credentials: "include",
      headers: headers
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OUTLIER_CAPTURE") {
    handleCapture(message).then(sendResponse);
    return true;  // keep the channel open for the async reply
  }

  if (message.type === "OUTLIER_PING") {
    testConnection().then(sendResponse);
    return true;
  }
});


/* One key refresh at a time, shared by everyone who asks. Batches run
 * concurrently and discover a stale key together; each asking separately
 * produced a rotation each, and every rotation revoked the one before it. */
let keyRefresh = null;

function refreshKey() {
  if (!keyRefresh) {
    keyRefresh = fetchKeyFromDashboard().finally(() => { keyRefresh = null; });
  }
  return keyRefresh;
}

async function handleCapture(message) {
  const endpoint = await getEndpoint();

  if (!(await hasHostPermission(endpoint))) {
    return {
      ok: false,
      error: "No Chrome permission for " + endpoint + " — re-save it in the popup"
    };
  }

  const postBatch = (key) => fetch(`${endpoint}/api/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Outlier-Key": key },
    body: JSON.stringify({ source: message.source, posts: message.posts })
  });

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      return {
        ok: false,
        error: "Sign in at " + endpoint + " in this browser — the key is then automatic."
      };
    }

    let response = await postBatch(apiKey);

    /* A stale key is recoverable, so recover from it here and now.
     *
     * This deleted the key, asked for another, and returned "Key refreshed —
     * retrying". None of that held up. Deleting it made the extension look
     * disconnected, and the dashboard's auto-connect mints a key whenever it
     * believes that — so an open dashboard tab rotated the key out from under
     * the scan. And nothing retried: the batch waited for a later sweep, by
     * which time another batch had usually rotated the key again.
     *
     * The key is kept until a better one exists, the refresh is shared so
     * twenty batches produce one replacement rather than twenty, and the same
     * batch goes again immediately on the new key.
     */
    if (response.status === 401) {
      const fresh = await refreshKey();
      if (fresh) response = await postBatch(fresh);

      if (!fresh || response.status === 401) {
        return {
          ok: false,
          error: "Sign in at " + endpoint + " in this browser to reconnect."
        };
      }
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

  /* Reported, never installed.
   *
   * This called chrome.runtime.reload() whenever the dashboard advertised a
   * newer version and the folder was local. Reloading the extension orphans
   * the content script in every open Facebook tab — captured climbing, sent
   * stuck at zero, nothing in the dashboard. It ran on a one minute alarm AND
   * on every service worker startup, and MV3 starts the worker constantly, so
   * on any day the dashboard's version moved ahead it fired again and again,
   * killing the tab doing the delivering. No extension update justifies
   * pulling the floor out from under a running scan.
   *
   * The popup shows that a newer version exists. Installing it is a decision
   * made when not mid-scan.
   */
  await chrome.storage.local.set({ updateStuck: latest });
  console.log(`[Tallgrass] update available ${running} → ${latest}`);
}

chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

// Also check on startup, so a reload adopts changes immediately rather than
// waiting out the alarm period.
checkForUpdate();
