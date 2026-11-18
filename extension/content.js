// Runs on flow.google.com (and legacy labs.google/fx). Reads the signed-in account's
// email, Flow credit balance and reset date from the Account panel, then sends them
// to the local tracker. No manual input needed.
(function () {
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastSent = '';
  let busy = false;
  // Tabs opened by the tracker's "Sync all" carry ?fct_sync=1. Captured at document_start, before Flow rewrites the URL.
  let openedForSync = false;
  try {
    if (new URLSearchParams(location.search).has('fct_sync')) sessionStorage.setItem('fct_sync', '1');
    openedForSync = sessionStorage.getItem('fct_sync') === '1';
  } catch {
    openedForSync = new URLSearchParams(location.search).has('fct_sync');
  }
  const closeThisTab = (email) => {
    if (alive()) chrome.runtime.sendMessage({ type: 'FLOW_CREDITS_CLOSE_TAB', email }).catch(() => {});
  };
  if (openedForSync) setTimeout(closeThisTab, 40000); // never leave a stray tab behind

  function detectEmail() {
    // Google's avatar: aria-label="Google Account: Name (you@gmail.com), ..."
    for (const el of document.querySelectorAll('[aria-label*="@"], [data-email], [title*="@"]')) {
      const str = el.getAttribute('data-email') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const m = str.match(EMAIL_RE);
      if (m) return m[0].toLowerCase();
    }
    return '';
  }

  function readPanel() {
    const countEl = document.querySelector('.credits-count');
    if (!countEl) return null;
    const panel = countEl.closest('[role="dialog"]') || countEl.parentElement;
    const text = panel ? panel.innerText : countEl.innerText;
    const credits = (countEl.innerText.match(/([\d,]+)/) || [])[1];
    const email = (text.match(EMAIL_RE) || [])[0] || detectEmail();
    if (!credits) return null;
    return {
      email: (email || '').toLowerCase(),
      available_credits: Number(credits.replace(/,/g, '')),
      // Whole account panel: the server finds the balance and the reset/renewal date in it.
      raw_text: text,
      url: location.href,
      source: 'chrome-extension'
    };
  }

  // Open the Account panel just long enough to read it, then close it again.
  async function openPanelAndRead() {
    let data = readPanel();
    if (data) return data;
    const btn = document.querySelector('[aria-label="Account details"]');
    if (!btn) return null;
    btn.click();
    for (let i = 0; i < 20 && !data; i++) {
      await sleep(150);
      data = readPanel();
    }
    const close = document.querySelector('[aria-label="Close account panel"]');
    if (close) close.click();
    return data;
  }

  function send(data) {
    const key = `${data.email}|${data.available_credits}|${data.raw_text}`;
    if (key === lastSent) return Promise.resolve(null);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'FLOW_CREDITS_SYNC', payload: data }, (res) => {
        if (res && res.ok && res.data && res.data.ok) {
          lastSent = key;
          if (openedForSync && res.data.close_tab) closeThisTab(data.email);
          console.log('[Flow Credits Tracker] synced', res.data.email, res.data.available_credits);
        }
        resolve(res);
      });
    });
  }

  async function sync({ openPanel }) {
    if (busy) return null;
    busy = true;
    try {
      const data = openPanel ? await openPanelAndRead() : readPanel();
      if (data) await send(data);
      return data;
    } catch (e) {
      return null;
    } finally {
      busy = false;
    }
  }

  // 1) On page load: wait for the header avatar, then read the panel once.
  (async () => {
    for (let i = 0; i < 40 && !document.querySelector('[aria-label="Account details"]'); i++) await sleep(250);
    await sync({ openPanel: true });
  })();

  // 2) Whenever the user opens the panel themselves, or the count changes while open.
  let t;
  const observer = new MutationObserver(() => {
    if (!alive()) return teardown();
    if (busy || !document.querySelector('.credits-count')) return; // only care while the account panel is open
    clearTimeout(t);
    t = setTimeout(() => sync({ openPanel: false }), 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true }); // panel opening adds nodes; text edits don't matter

  // 3) Re-check spent credits every 15 min while you're looking at Flow (background sync covers the rest).
  const recheck = setInterval(() => {
    if (!alive()) return teardown();
    if (document.visibilityState === 'visible') sync({ openPanel: true });
  }, 15 * 60 * 1000);

  // After the extension reloads (self-update), this copy is cut off from Chrome: stop everything it runs.
  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }
  function teardown() {
    observer.disconnect();
    clearInterval(recheck);
    clearTimeout(t);
  }
})();
