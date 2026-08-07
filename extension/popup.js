/* Popup — start/stop capture, endpoint config, live status.
 *
 * Every control reports what happened. A button that silently no-ops is
 * indistinguishable from a broken extension.
 */

const el = (id) => document.getElementById(id);

const capturedEl = el("captured");
const totalEl = el("total");
const startBtn = el("start-btn");
const scanBtn = el("scan-btn");
const toggleEl = el("toggle");
const dotEl = el("dot");
const statusEl = el("status-text");
const endpointEl = el("endpoint");
const msgEl = el("msg");
const openLink = el("open-dashboard");

let scrolling = false;
let activeTabId = null;
let onFacebook = false;

function say(text, kind) {
  msgEl.textContent = text;
  msgEl.className = "msg" + (kind ? " " + kind : "");
}

/* ---------------------------------------------------------- content script */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// The content script only exists on Facebook tabs, so a failed message means
// "wrong page", not "extension broken" — say so rather than failing silently.
function askContentScript(type) {
  return new Promise((resolve) => {
    if (activeTabId === null) return resolve(null);
    chrome.tabs.sendMessage(activeTabId, { type }, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response);
    });
  });
}

async function refreshFromPage() {
  const response = await askContentScript("OUTLIER_STATS");
  if (!response || !response.ok) {
    onFacebook = false;
    startBtn.disabled = true;
    scanBtn.disabled = true;
    capturedEl.textContent = "—";
    say("Open a Facebook group, then press Start.", "warn");
    return;
  }

  onFacebook = true;
  startBtn.disabled = false;
  scanBtn.disabled = false;
  scrolling = response.scrolling;
  capturedEl.textContent = response.stats.sent || 0;

  startBtn.textContent = scrolling ? "Stop auto-scroll" : "Start auto-scroll";
  startBtn.className = scrolling ? "btn stop" : "btn";

  if (response.stats.lastError) say(response.stats.lastError, "warn");
  else if (response.stats.articles > 0 && response.stats.candidates === 0) {
    say("Posts detected but none readable — selectors may need updating.", "warn");
  } else if (scrolling) say("Scrolling and capturing…", "ok");
  else say("");
}

/* ---------------------------------------------------------- dashboard */

function checkConnection() {
  statusEl.textContent = "checking…";
  dotEl.className = "dot";

  const running = chrome.runtime.getManifest().version;

  chrome.runtime.sendMessage({ type: "OUTLIER_PING" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      dotEl.className = "dot off";
      statusEl.textContent = "offline";
      el("ext-version").textContent = "v" + running;
      return;
    }
    dotEl.className = "dot on";
    statusEl.textContent = "v" + response.version;

    // A mismatch means newer files are on disk and the next check will adopt
    // them — unless this copy was loaded from a zip, which never changes.
    const latest = response.extension_version;
    if (latest && latest !== running) {
      el("ext-version").innerHTML =
        '<span style="color:#d9b45f">v' + running + " → v" + latest + "</span>";
      say("Update available. Reloading shortly…", "warn");
    } else {
      el("ext-version").textContent = "v" + running + " (current)";
    }
  });
}

/* ---------------------------------------------------------- wiring */

startBtn.addEventListener("click", async () => {
  const response = await askContentScript(scrolling ? "OUTLIER_STOP" : "OUTLIER_START");
  if (!response) {
    say("Couldn't reach the page — reload the Facebook tab.", "err");
    return;
  }
  scrolling = !scrolling;
  startBtn.textContent = scrolling ? "Stop auto-scroll" : "Start auto-scroll";
  startBtn.className = scrolling ? "btn stop" : "btn";
  say(scrolling ? "Scrolling and capturing…" : "Stopped.", "ok");
});

scanBtn.addEventListener("click", async () => {
  say("Scanning…");
  const response = await askContentScript("OUTLIER_SCAN");
  if (!response) {
    say("Couldn't reach the page — reload the Facebook tab.", "err");
    return;
  }
  setTimeout(refreshFromPage, 700);
});

toggleEl.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: toggleEl.checked });
  say(toggleEl.checked ? "Capture on." : "Capture paused.", "ok");
});

el("save-endpoint").addEventListener("click", async () => {
  const value = endpointEl.value.trim().replace(/\/+$/, "");
  if (!value) {
    say("Enter a dashboard URL first.", "err");
    return;
  }
  if (!/^https?:\/\//.test(value)) {
    say("URL must start with http:// or https://", "err");
    return;
  }

  await chrome.storage.local.set({ endpoint: value });
  openLink.href = value;
  say("Saved. Testing…");

  chrome.runtime.sendMessage({ type: "OUTLIER_PING" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      dotEl.className = "dot off";
      statusEl.textContent = "offline";
      say("Saved, but nothing answered there. Is the dashboard running?", "err");
      return;
    }
    dotEl.className = "dot on";
    statusEl.textContent = "v" + response.version;
    say("Connected to dashboard v" + response.version, "ok");
  });
});

/* ---------------------------------------------------------- init */

const autoUpdateEl = el("auto-update");
autoUpdateEl.addEventListener("change", () => {
  chrome.storage.local.set({ autoUpdate: autoUpdateEl.checked });
  say(autoUpdateEl.checked
    ? "Auto-update on — picks up changes within a minute."
    : "Auto-update off.", "ok");
});

(async function init() {
  const tab = await getActiveTab();
  activeTabId = tab ? tab.id : null;

  const state = await chrome.storage.local.get([
    "enabled", "endpoint", "totalCaptured", "autoUpdate", "lastUpdateFrom", "lastUpdateTo"
  ]);
  totalEl.textContent = state.totalCaptured || 0;
  toggleEl.checked = state.enabled !== false;
  autoUpdateEl.checked = state.autoUpdate !== false;
  endpointEl.value = state.endpoint || "http://localhost:5050";
  openLink.href = endpointEl.value;

  // Report a completed self-update once, then clear the marker.
  if (state.lastUpdateTo && state.lastUpdateTo === chrome.runtime.getManifest().version) {
    say("Updated to v" + state.lastUpdateTo + ". Reload any open Facebook tabs.", "ok");
    chrome.storage.local.remove(["lastUpdateFrom", "lastUpdateTo"]);
  }

  checkConnection();
  refreshFromPage();
  setInterval(refreshFromPage, 1500);   // keep counts live while scrolling
})();
