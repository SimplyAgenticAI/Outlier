/* Popup — capture toggle, dashboard endpoint, connection status. */

const totalEl = document.getElementById("total");
const toggleEl = document.getElementById("toggle");
const dotEl = document.getElementById("dot");
const statusEl = document.getElementById("status-text");
const endpointEl = document.getElementById("endpoint");
const openLink = document.getElementById("open-dashboard");

async function load() {
  const state = await chrome.storage.local.get(["enabled", "endpoint", "totalCaptured"]);

  totalEl.textContent = state.totalCaptured || 0;
  toggleEl.checked = state.enabled !== false;
  endpointEl.value = state.endpoint || "http://localhost:5050";
  openLink.href = endpointEl.value;

  checkConnection();
}

function checkConnection() {
  statusEl.textContent = "checking…";
  dotEl.className = "dot";

  chrome.runtime.sendMessage({ type: "OUTLIER_PING" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      dotEl.className = "dot off";
      statusEl.textContent = "offline";
      return;
    }
    dotEl.className = "dot on";
    statusEl.textContent = "v" + response.version;
  });
}

toggleEl.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: toggleEl.checked });
});

document.getElementById("save-endpoint").addEventListener("click", async () => {
  const value = endpointEl.value.trim().replace(/\/+$/, "");
  if (!value) return;
  await chrome.storage.local.set({ endpoint: value });
  openLink.href = value;
  checkConnection();
});

load();
