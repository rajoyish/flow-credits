const FLOW_URL = 'https://flow.google.com/';
const state = { accounts: [], summary: {} };
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

function sortedAccounts() {
  return [...state.accounts].sort((a, b) => {
    if (a.is_synced !== b.is_synced) return a.is_synced ? -1 : 1;
    if (a.is_synced && b.urgency_score !== a.urgency_score) return b.urgency_score - a.urgency_score;
    return (a.label || a.email).localeCompare(b.label || b.email);
  });
}

function creditsBox(acc) {
  if (!acc.is_synced) {
    const hint = acc.extension_installed
      ? 'Extension installed. It syncs on the next “Sync all”.'
      : `Extension not installed in this Chrome profile. <a href="#" onclick="openSetupModal(); return false;">Set up extension</a>`;
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
  if (!state.accounts.length) {
    container.innerHTML = `
      <div class="empty-state">
        <h3 style="font-size:18px; margin-bottom:8px;">No accounts yet</h3>
        <p style="color:var(--text-secondary); margin-bottom:18px;">Add the Google accounts from your Chrome profiles.</p>
        <button class="btn btn-primary" onclick="openProfilesModal()">+ Add accounts</button>
      </div>`;
    return;
  }
  const recId = state.summary.recommended_account_id;
  container.innerHTML = `<div class="accounts-grid">${sortedAccounts()
    .map((acc) => {
      const isRec = acc.id === recId;
      return `
        <div class="account-card ${isRec ? 'recommended' : ''}">
          ${isRec ? '<div class="recommended-badge">★ Use next</div>' : ''}
          <div class="card-top">
            <div class="account-identity">
              <div class="avatar-dot" style="background:${escapeHtml(acc.color || '#6366f1')}">${escapeHtml((acc.label || acc.email).slice(0, 2).toUpperCase())}</div>
              <div style="min-width:0;">
                <div class="account-title">${escapeHtml(acc.label || acc.email)}</div>
                <div class="account-email">${escapeHtml(acc.email)}</div>
              </div>
            </div>
            <button class="icon-btn" title="Remove from tracker" onclick="removeAccount('${acc.id}')">✕</button>
          </div>
          ${creditsBox(acc)}
          <div class="card-actions">
            <button class="btn btn-sm" onclick="openFlow('${acc.id}')">Open Flow</button>
          </div>
        </div>`;
    })
    .join('')}</div>`;
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
  const missing = state.accounts.filter((a) => a.chrome_profile && !a.extension_installed);
  $('setupBanner').style.display = missing.length ? 'flex' : 'none';
  $('setupBannerText').textContent = `${missing.length} of ${state.accounts.length} Chrome profiles still need the extension (one-time setup).`;
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

function renderSyncJob(job) {
  const items = job.items || [];
  const count = (st) => items.filter((i) => i.status === st).length;
  const current = items.find((i) => i.status === 'syncing');

  $('syncPanel').classList.toggle('active', Boolean(job.running));
  $('syncPanel').classList.toggle('show-items', items.length > 0);
  $('btnSyncAll').disabled = Boolean(job.running);
  $('btnSyncAll').textContent = job.running ? '⟳ Syncing…' : '⟳ Sync all';
  $('btnCancelSync').style.display = job.running ? 'inline-flex' : 'none';
  $('syncFill').style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 0}%`;

  const auto = syncSettings && syncSettings.auto_sync;
  if (job.running) {
    $('syncTitle').textContent = `Syncing ${Math.min(job.done + 1, job.total)} of ${job.total}${current ? ` · ${current.label}` : ''}`;
    $('syncSub').textContent = 'Opening Flow in each Chrome profile. Windows close by themselves.';
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
}

// Progress arrives as 'job' events from the tracker; no polling needed.
async function refreshSyncJob() {
  try {
    renderSyncJob(await apiRequest('/api/sync-job'));
  } catch {
    // tracker briefly unavailable; the next event retries
  }
}

async function startSyncAll() {
  try {
    await apiRequest('/api/sync-all', { method: 'POST', body: '{}' });
    refreshSyncJob();
  } catch (err) {
    showToast(err.message, 'error');
  }
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
