const TRACKER = 'http://localhost:3847';
const BLANK_TAB = /^(chrome:\/\/newtab|chrome:\/\/new-tab-page|about:blank)/;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay a Flow reading from content.js to the local tracker.
  if (msg && msg.type === 'FLOW_CREDITS_SYNC') {
    fetch(`${TRACKER}/api/sync-inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...msg.payload, ext_version: chrome.runtime.getManifest().version })
    })
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // A tab the tracker opened for a sync job has reported its balance: close it.
  if (msg && msg.type === 'FLOW_CREDITS_CLOSE_TAB' && sender.tab) {
    closeSyncWindows(sender.tab, msg.email || '').finally(selfUpdateSoon);
  }
});

/**
 * Close the sync tab's window, plus any window of this profile that only holds empty
 * New Tab pages (Chrome can open one when it starts a profile). Windows with real tabs stay.
 */
async function closeSyncWindows(syncTab, email) {
  let closedWindows = 0;
  let keptWindows = 0;
  let closedTab = false;
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    for (const w of windows) {
      const tabs = w.tabs || [];
      const hasSyncTab = tabs.some((t) => t.id === syncTab.id);
      const onlyBlankOrSync = tabs.every((t) => t.id === syncTab.id || BLANK_TAB.test(t.url || t.pendingUrl || ''));
      if (onlyBlankOrSync && (hasSyncTab || tabs.length > 0)) {
        await chrome.windows.remove(w.id);
        closedWindows++;
      } else if (hasSyncTab) {
        await chrome.tabs.remove(syncTab.id);
        closedTab = true;
        keptWindows++;
      } else {
        keptWindows++;
      }
    }
  } catch (e) {
    await chrome.tabs.remove(syncTab.id).catch(() => {});
    closedTab = true;
  }
  fetch(`${TRACKER}/api/sync-closed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, closed_windows: closedWindows, kept_windows: keptWindows, closed_tab_only: closedTab })
  }).catch(() => {});
}

/** Unpacked extensions don't pick up file changes until reloaded; do it ourselves. */
let updateTimer = null;
function selfUpdateSoon() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try {
      const { version } = await fetch(`${TRACKER}/api/extension-version`).then((r) => r.json());
      if (version && version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
    } catch {
      // tracker offline
    }
  }, 3000);
}
selfUpdateSoon();
