/* Service worker — the only thing that talks to the dashboard.
 * Content scripts hand batches here so the cross-origin POST happens from an
 * extension context rather than from facebook.com.
 */

const DEFAULT_ENDPOINT = "http://localhost:5050";

async function getEndpoint() {
  const stored = await chrome.storage.local.get(["endpoint"]);
  return (stored.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
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

async function handleCapture(message) {
  const endpoint = await getEndpoint();
  try {
    const response = await fetch(`${endpoint}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: message.source, posts: message.posts })
    });

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

async function testConnection() {
  const endpoint = await getEndpoint();
  try {
    const response = await fetch(`${endpoint}/api/ping`);
    const data = await response.json();
    return { ok: true, version: data.version, endpoint };
  } catch (error) {
    return { ok: false, endpoint };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["enabled", "endpoint"]);
  await chrome.storage.local.set({
    enabled: stored.enabled !== false,
    endpoint: stored.endpoint || DEFAULT_ENDPOINT
  });
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
  const stored = await chrome.storage.local.get(["autoUpdate", "capturing"]);
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
  if (!latest || latest === running) return;

  await chrome.storage.local.set({ lastUpdateFrom: running, lastUpdateTo: latest });
  console.log(`[Outlier] updating extension ${running} → ${latest}`);
  chrome.runtime.reload();
}

chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

// Also check on startup, so a reload adopts changes immediately rather than
// waiting out the alarm period.
checkForUpdate();
