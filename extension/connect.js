/* Runs only on the Outlier dashboard, and exists to remove a step.
 *
 * Typing a dashboard URL and pasting a key into a popup is friction that
 * solves nothing: the page the user is already signed in to knows both. It
 * hands them over directly, so connecting is one click and there is nothing
 * to mistype — and nothing to lose when Chrome clears extension storage,
 * which it does whenever the extension is removed and re-added.
 *
 * The page can only reach this script if its origin is in the manifest's
 * content_scripts matches, so an arbitrary site cannot push credentials in.
 */

(function () {
  "use strict";

  // Tell the page an extension is present, and whether it is already wired to
  // this dashboard. The page needs the second half to decide between "connect
  // it now, silently" and "leave the existing key alone" — connecting mints a
  // fresh key, so doing it on every page load would rotate the key forever.
  function announce() {
    chrome.storage.local.get(["endpoint", "apiKey"], function (stored) {
      var endpoint = String((stored && stored.endpoint) || "");
      var connected = !!(stored && stored.apiKey) &&
                      endpoint.replace(/\/+$/, "") === window.location.origin;

      window.dispatchEvent(new CustomEvent("outlier:extension-present", {
        detail: {
          version: chrome.runtime.getManifest().version,
          connected: connected,
          endpoint: endpoint
        }
      }));
    });
  }

  window.addEventListener("outlier:connect", function (event) {
    var detail = (event && event.detail) || {};
    var apiKey = String(detail.apiKey || "").trim();

    // Always the page's own origin — never a value from the payload, so a
    // tampered page cannot redirect captures somewhere else.
    var endpoint = window.location.origin;

    if (!apiKey) {
      window.dispatchEvent(new CustomEvent("outlier:connect-result", {
        detail: { ok: false, error: "No account key in the page" }
      }));
      return;
    }

    chrome.storage.local.set({ endpoint: endpoint, apiKey: apiKey }, function () {
      var failed = chrome.runtime.lastError;
      window.dispatchEvent(new CustomEvent("outlier:connect-result", {
        detail: failed
          ? { ok: false, error: failed.message }
          : { ok: true, endpoint: endpoint }
      }));
    });
  });

  // The page may load before or after this script, so announce both ways.
  window.addEventListener("outlier:ping-extension", announce);
  announce();
})();
