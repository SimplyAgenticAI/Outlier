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
