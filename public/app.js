const FLOW_URL = 'https://flow.google.com/';
const state = { accounts: [], summary: {}, syncJob: { running: false, items: [] }, syncStarting: false };
const accountFilters = { search: '', plan: 'all', sync: 'all', credits: 'all' };
const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  if (type === 'success') toast.style.borderLeftColor = '#10b981';
  if (type === 'error') toast.style.borderLeftColor = '#ef4444';
  toast.textContent = message;
  $('toastContainer').appendChild(toast);
  setTimeout(() => toast.remove(), 3800);
}

async function apiRequest(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatShortDate(iso) {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

/* ---------- state & rendering ---------- */
async function loadState() {
  try {
    const data = await apiRequest('/api/state');
    state.accounts = data.accounts || [];
    state.summary = data.summary || {};
    renderSummary();
    renderSetupBanner();
    renderAccounts();
  } catch (err) {
    showToast(`Couldn't load data: ${err.message}`, 'error');
  }
}

function renderSummary() {
  const s = state.summary;
  $('statTotalCredits').textContent = (s.total_available_credits || 0).toLocaleString();
  $('statTotalAllowance').textContent = s.synced_accounts ? `of ${(s.total_monthly_allowance || 0).toLocaleString()} this month` : 'No accounts synced yet';
  $('statExpiringSoon').textContent = (s.expiring_within_7_days || 0).toLocaleString();
  $('statSyncedAccounts').textContent = `${s.synced_accounts || 0} / ${s.total_accounts || 0}`;
  $('statUsedThisCycle').textContent = `${(s.total_used_this_cycle || 0).toLocaleString()} credits used this cycle`;

  const rec = state.accounts.find((a) => a.id === s.recommended_account_id);
  $('statRecommendedName').textContent = rec ? rec.label || rec.email : '—';
  $('statRecommendedReason').textContent = s.recommended_reason || '';
  $('recommendedActions').style.display = rec ? 'block' : 'none';
  $('btnLaunchRecommended').onclick = () => rec && openFlow(rec.id);
}

// Synced accounts on a monthly reset are Google AI Pro; free accounts refresh daily.
const isPro = (acc) => acc.is_synced && acc.reset_period !== 'daily';

function sortedAccounts() {
  return [...state.accounts].sort((a, b) => {
    if (a.is_synced !== b.is_synced) return a.is_synced ? -1 : 1;
    if (a.is_synced && b.available_credits !== a.available_credits) return b.available_credits - a.available_credits;
    return (a.label || a.email).localeCompare(b.label || b.email);
  });
}

function filteredAccounts() {
  const search = accountFilters.search.trim().toLocaleLowerCase();
  return sortedAccounts().filter((acc) => {
    if (search && !`${acc.label || ''} ${acc.email || ''}`.toLocaleLowerCase().includes(search)) return false;
    if (accountFilters.plan === 'pro' && !isPro(acc)) return false;
    if (accountFilters.plan === 'free' && !(acc.is_synced && acc.reset_period === 'daily')) return false;
    if (accountFilters.sync === 'synced' && !acc.is_synced) return false;
    if (accountFilters.sync === 'unsynced' && acc.is_synced) return false;
    if (accountFilters.credits === 'available' && !(acc.is_synced && acc.available_credits > 0)) return false;
    if (accountFilters.credits === 'empty' && !(acc.is_synced && acc.available_credits === 0)) return false;
    return true;
  });
}

function clearAccountFilters() {
  Object.assign(accountFilters, { search: '', plan: 'all', sync: 'all', credits: 'all' });
  $('accountSearch').value = '';
  for (const id of ['accountPlanFilter', 'accountSyncFilter', 'accountCreditsFilter']) $(id).value = 'all';
  renderAccounts();
}

function creditsBox(acc) {
  if (!acc.is_synced) {
    const hint = state.summary.cookie_sync
      ? 'Click Sync to read this account’s balance in the background.'
      : 'Background sync needs Chrome Safe Storage access in Keychain. Allow access and restart the tracker.';
    return `<div class="credit-meter-box unsynced"><div class="credits-total">Not synced yet</div><p class="unsynced-hint">${hint}</p></div>`;
  }
  const pct = acc.remaining_percent;
  const color = pct <= 20 ? '#ef4444' : pct <= 50 ? '#f59e0b' : '#10b981';
  const soon = acc.days_until_reset <= 7 && acc.available_credits > 0 ? 'reset-soon' : '';
  const when = acc.days_until_reset === 0 ? 'today' : `in ${acc.days_until_reset}d`;
  const resetText = acc.reset_period === 'daily' ? 'Free · refreshes daily' : `Resets ${formatShortDate(acc.next_reset_date)} · ${when}`;
  const topup = acc.topup_credits > 0 ? ` <span class="topup">+${acc.topup_credits.toLocaleString()} top-up</span>` : '';
  return `
    <div class="credit-meter-box">
      <div class="meter-header">
        <div>
          <span class="credits-big">${acc.available_credits.toLocaleString()}</span>
          <span class="credits-total">/ ${acc.monthly_allowance.toLocaleString()}</span>${topup}
        </div>
        <div class="meter-percent" style="color:${color}">${pct}%</div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${color};"></div></div>
      <div class="meter-footer">
        <div class="reset-badge ${acc.reset_period === 'daily' ? '' : soon}">${resetText}</div>
        <div title="${escapeHtml(new Date(acc.last_synced_at).toLocaleString())}">Synced ${timeAgo(acc.last_synced_at)}</div>
      </div>
    </div>`;
}

function renderAccounts() {
  const container = $('accountsContainer');
  const accounts = filteredAccounts();
  const filtered = accountFilters.search.trim() || ['plan', 'sync', 'credits'].some((key) => accountFilters[key] !== 'all');
  $('btnClearAccountFilters').hidden = !filtered;
  $('accountResultsCount').textContent = `${accounts.length} of ${state.accounts.length} accounts · Most credits first`;
  if (!state.accounts.length) {
    container.innerHTML = `
      <div class="empty-state">
        <h3 style="font-size:18px; margin-bottom:8px;">No accounts yet</h3>
        <p style="color:var(--text-secondary); margin-bottom:18px;">Add the Google accounts from your Chrome profiles.</p>
        <button class="btn btn-primary" onclick="openProfilesModal()">+ Add accounts</button>
      </div>`;
    return;
  }
  if (!accounts.length) {
    container.innerHTML = '<div class="empty-state"><h3>No matching accounts</h3><p>Try another search or clear your filters.</p></div>';
    return;
  }
  const recId = state.summary.recommended_account_id;
  container.innerHTML = `<div class="accounts-grid">${accounts
    .map((acc) => {
      const isRec = acc.id === recId;
      return `
        <div class="account-card ${isRec ? 'recommended' : ''}">
          ${isRec ? '<div class="recommended-badge">★ Use next</div>' : ''}
          <div class="card-top">
            <div class="account-identity">
              <div class="avatar-dot" style="background:${escapeHtml(acc.color || '#6366f1')}">${escapeHtml((acc.label || acc.email).slice(0, 2).toUpperCase())}</div>
              <div style="min-width:0;">
                <div class="account-title"><span class="account-name">${escapeHtml(acc.label || acc.email)}</span>${isPro(acc) ? '<span class="pro-badge" title="Google AI Pro">PRO</span>' : ''}</div>
                <div class="account-email">${escapeHtml(acc.email)}</div>
              </div>
            </div>
            <button class="icon-btn" title="Remove from tracker" onclick="removeAccount('${acc.id}')">✕</button>
          </div>
          ${creditsBox(acc)}
          <div class="card-actions">
            <button class="btn btn-sm account-sync-btn" data-sync-account="${escapeHtml(acc.id)}" onclick="syncAccount('${acc.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              <span>Sync</span>
            </button>
            <button class="btn btn-sm" onclick="openFlow('${acc.id}')">Open Flow</button>
          </div>
        </div>`;
    })
    .join('')}</div>`;
  updateAccountSyncButtons();
}

/* ---------- account actions ---------- */
async function openFlow(id) {
  try {
    await apiRequest(`/api/accounts/${id}/launch-browser`, { method: 'POST', body: JSON.stringify({ url: FLOW_URL }) });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function removeAccount(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc || !window.confirm(`Stop tracking ${acc.label || acc.email}? You can add it again from “Add accounts”.`)) return;
  try {
    await apiRequest(`/api/accounts/${id}`, { method: 'DELETE' });
    loadState();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ---------- add accounts from Chrome profiles ---------- */
async function openProfilesModal() {
  const list = $('profilesList');
  list.innerHTML = '<div class="empty-state">Reading Chrome profiles…</div>';
  $('profilesModalBackdrop').classList.add('open');
  try {
    const { profiles } = await apiRequest('/api/chrome-profiles');
    const untracked = profiles.filter((p) => !p.tracked);
    $('btnAddAllProfiles').disabled = !untracked.length;
    $('btnAddAllProfiles').textContent = untracked.length ? `Add all (${untracked.length})` : 'All added';
    list.innerHTML = profiles.length
      ? profiles
          .map(
            (p) => `
        <div class="profile-row">
          <div class="avatar-dot">${escapeHtml(p.name.slice(0, 2).toUpperCase())}</div>
          <div class="profile-meta">
            <div class="profile-name">${escapeHtml(p.name)}</div>
            <div class="profile-email">${escapeHtml(p.email)} · ${escapeHtml(p.profile_dir)}</div>
          </div>
          ${p.tracked ? '<span class="profile-added">✓ Added</span>' : `<button class="btn btn-sm btn-primary" data-profile="${escapeHtml(p.profile_dir)}">Add</button>`}
        </div>`
          )
          .join('')
      : '<div class="empty-state">No signed-in Chrome profiles found.</div>';
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

async function importProfiles(profileDirs) {
  try {
    const res = await apiRequest('/api/chrome-profiles/import', {
      method: 'POST',
      body: JSON.stringify(profileDirs ? { profile_dirs: profileDirs } : {})
    });
    if (res.added.length) showToast(`Added ${res.added.length} account${res.added.length > 1 ? 's' : ''}`, 'success');
    loadState();
    openProfilesModal();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ---------- one-time extension setup ---------- */
let setupPoll = null;

function renderSetupBanner() {
  // Silent cookie sync needs no extension, so don't nag about it when that's working.
  // The extension is then only for the optional toolbar popup, reachable from the sync panel.
  if (state.summary.cookie_sync) {
    $('setupBanner').style.display = 'none';
    return;
  }
  const missing = state.accounts.filter((a) => a.chrome_profile && !a.extension_installed);
  $('setupBanner').style.display = missing.length ? 'flex' : 'none';
  $('setupBannerText').textContent = `${missing.length} of ${state.accounts.length} Chrome profiles can add the optional toolbar extension.`;
}

async function renderSetupList() {
  const { profiles } = await apiRequest('/api/chrome-profiles');
  const rows = profiles.filter((p) => p.tracked).sort((a, b) => Number(a.extension_installed) - Number(b.extension_installed));
  $('setupList').innerHTML = rows
    .map(
      (p) => `
      <div class="profile-row">
        <div class="avatar-dot">${escapeHtml(p.name.slice(0, 2).toUpperCase())}</div>
        <div class="profile-meta">
          <div class="profile-name">${escapeHtml(p.name)}</div>
          <div class="profile-email">${escapeHtml(p.email)} · ${escapeHtml(p.profile_dir)}</div>
        </div>
        ${p.extension_installed ? '<span class="profile-added">✓ Installed</span>' : `<button class="btn btn-sm btn-primary" data-setup-profile="${escapeHtml(p.profile_dir)}">Open Extensions</button>`}
      </div>`
    )
    .join('');
}

async function openSetupModal() {
  $('setupModalBackdrop').classList.add('open');
  await renderSetupList();
  if (!setupPoll) setupPoll = setInterval(renderSetupList, 2500);
}

function closeSetupModal() {
  $('setupModalBackdrop').classList.remove('open');
  clearInterval(setupPoll);
  setupPoll = null;
  loadState();
}

/* ---------- sync all: progress + auto-sync settings ---------- */
const SYNC_ICON = { queued: '·', syncing: '⟳', synced: '✓', failed: '✗', skipped: '–' };
let syncSettings = null;

function updateAccountSyncButtons() {
  const job = state.syncJob;
  const busy = state.syncStarting || Boolean(job.running);
  document.querySelectorAll('[data-sync-account]').forEach((button) => {
    const item = job.items?.find((item) => item.account_id === button.dataset.syncAccount);
    const syncing = job.running && item?.status === 'syncing';
    button.disabled = busy;
    button.classList.toggle('syncing', Boolean(syncing));
    button.setAttribute('aria-busy', String(Boolean(syncing)));
    button.querySelector('span').textContent = syncing ? 'Syncing…' : 'Sync';
    button.title = item?.status === 'failed' ? item.message : 'Sync this account in the background';
  });
  $('btnSyncAll').disabled = busy;
}

function renderSyncJob(job) {
  state.syncJob = job;
  const items = job.items || [];
  const count = (st) => items.filter((i) => i.status === st).length;
  const current = items.find((i) => i.status === 'syncing');

  $('syncPanel').classList.toggle('active', Boolean(job.running));
  $('syncPanel').classList.toggle('show-items', items.length > 0);
  $('btnSyncAll').disabled = Boolean(job.running);
  $('btnSyncAll').querySelector('span').textContent = job.running ? 'Syncing…' : 'Sync all';
  $('btnSyncAll').classList.toggle('syncing', Boolean(job.running));
  $('btnCancelSync').style.display = job.running ? 'inline-flex' : 'none';
  $('syncFill').style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 0}%`;

  const auto = syncSettings && syncSettings.auto_sync;
  if (job.running) {
    $('syncTitle').textContent = `Syncing ${Math.min(job.done + 1, job.total)} of ${job.total}${current ? ` · ${current.label}` : ''}`;
    $('syncSub').textContent = 'Reading account balances in the background. No windows open.';
  } else if (job.finished_at) {
    const parts = [`${count('synced')} updated`];
    if (count('failed')) parts.push(`${count('failed')} failed`);
    if (count('skipped')) parts.push(`${count('skipped')} skipped`);
    $('syncTitle').textContent = `Last sync ${timeAgo(job.finished_at)}: ${parts.join(', ')}`;
    $('syncSub').textContent = auto ? `Runs automatically every ${syncSettings.interval_hours} h. Hover an account for details.` : 'Automatic sync is off.';
  } else {
    $('syncTitle').textContent = 'Sync';
    $('syncSub').textContent = auto ? `Runs automatically every ${syncSettings.interval_hours} h · last ${timeAgo(syncSettings.last_auto_sync_at)}` : 'Automatic sync is off.';
  }

  $('syncItems').innerHTML = items
    .map(
      (i) =>
        `<span class="sync-chip ${i.status}" title="${escapeHtml(i.message || i.status)}">${SYNC_ICON[i.status]} ${escapeHtml(i.label)}${
          i.status === 'synced' && i.credits !== null ? ` · ${Number(i.credits).toLocaleString()}` : ''
        }</span>`
    )
    .join('');
  updateAccountSyncButtons();
}

// Progress arrives as 'job' events from the tracker; no polling needed.
async function refreshSyncJob() {
  try {
    renderSyncJob(await apiRequest('/api/sync-job'));
  } catch {
    // tracker briefly unavailable; the next event retries
  }
}

async function startSync(accountIds = null) {
  if (state.syncStarting || state.syncJob.running) return;
  state.syncStarting = true;
  updateAccountSyncButtons();
  try {
    const job = await apiRequest('/api/sync-all', {
      method: 'POST',
      body: JSON.stringify(accountIds ? { account_ids: accountIds } : {})
    });
    renderSyncJob(job);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    state.syncStarting = false;
    updateAccountSyncButtons();
  }
}

function startSyncAll() {
  return startSync();
}

function syncAccount(id) {
  return startSync([id]);
}

async function saveSyncSettings() {
  syncSettings = await apiRequest('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ auto_sync: $('autoSyncToggle').checked, interval_hours: Number($('autoSyncInterval').value) })
  });
  refreshSyncJob();
}

/* ---------- server: start at login / stop ---------- */
async function setStartAtLogin(enabled) {
  try {
    syncSettings = await apiRequest('/api/settings', { method: 'PUT', body: JSON.stringify({ start_at_login: enabled }) });
    showToast(enabled ? 'Flow Credits will start when you log in' : 'Flow Credits won’t start at login', 'success');
  } catch (err) {
    $('startAtLoginToggle').checked = !enabled;
    showToast(err.message, 'error');
  }
}

async function stopServer() {
  if (!window.confirm('Stop the Flow Credits server? Syncing stops until you start it again.')) return;
  await apiRequest('/api/shutdown', { method: 'POST', body: '{}' }).catch(() => {});
  document.querySelector('.app-container').innerHTML = `
    <div class="empty-state" style="margin-top:80px;">
      <h3 style="font-size:18px; margin-bottom:8px;">Server stopped</h3>
      <p style="color:var(--text-secondary);">Start it again by double-clicking <strong>Start Flow Credits.command</strong>${
        syncSettings && syncSettings.start_at_login ? ', or it starts by itself at your next login' : ''
      }. This page reloads when it's back.</p>
    </div>`;
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('accountSearch').addEventListener('input', (event) => {
    accountFilters.search = event.target.value;
    renderAccounts();
  });
  for (const [id, key] of [['accountPlanFilter', 'plan'], ['accountSyncFilter', 'sync'], ['accountCreditsFilter', 'credits']]) {
    $(id).addEventListener('change', (event) => {
      accountFilters[key] = event.target.value;
      renderAccounts();
    });
  }
  $('btnClearAccountFilters').addEventListener('click', clearAccountFilters);


  $('btnSyncAll').addEventListener('click', startSyncAll);
  $('btnCancelSync').addEventListener('click', () => apiRequest('/api/sync-job/cancel', { method: 'POST', body: '{}' }).then(refreshSyncJob));
  $('autoSyncToggle').addEventListener('change', saveSyncSettings);
  $('autoSyncInterval').addEventListener('change', saveSyncSettings);
  apiRequest('/api/settings').then((st) => {
    syncSettings = st;
    $('autoSyncToggle').checked = st.auto_sync;
    $('autoSyncInterval').value = String(st.interval_hours);
    $('startAtLoginToggle').checked = st.start_at_login;
    refreshSyncJob();
  });

  $('startAtLoginToggle').addEventListener('change', (e) => setStartAtLogin(e.target.checked));
  $('btnStopServer').addEventListener('click', stopServer);

  $('btnAddAccount').addEventListener('click', openProfilesModal);
  $('btnCloseProfilesModal').addEventListener('click', () => $('profilesModalBackdrop').classList.remove('open'));
  $('btnAddAllProfiles').addEventListener('click', () => importProfiles(null));
  $('profilesList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-profile]');
    if (btn) {
      btn.disabled = true;
      importProfiles([btn.dataset.profile]);
    }
  });

  $('btnOpenSetup').addEventListener('click', openSetupModal);
  $('btnCloseSetupModal').addEventListener('click', closeSetupModal);
  $('btnSetupSyncNow').addEventListener('click', () => {
    closeSetupModal();
    startSyncAll();
  });
  $('setupList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-setup-profile]');
    if (!btn) return;
    try {
      await apiRequest('/api/chrome-profiles/open-extensions', { method: 'POST', body: JSON.stringify({ profile_dir: btn.dataset.setupProfile }) });
      btn.textContent = 'Opened · path copied';
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Live updates: the tracker pushes an event whenever data or the sync job changes.
  const events = new EventSource('/api/events');
  let stateTimer = null;
  let bootId = null;
  events.addEventListener('state', () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(loadState, 300);
  });
  events.addEventListener('job', refreshSyncJob);
  events.addEventListener('open', () => {
    // (Re)connected: catch up on anything missed while disconnected.
    loadState();
    refreshSyncJob();
  });
  events.addEventListener('hello', (e) => {
    const id = JSON.parse(e.data).boot_id;
    if (bootId && id !== bootId) location.reload(); // tracker restarted, maybe with new code
    bootId = id;
  });
});
