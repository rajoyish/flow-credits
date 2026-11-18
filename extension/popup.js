const TRACKER = 'http://localhost:3847';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let polling = null;

function row(a, recId) {
  const name = esc(a.label || a.email);
  if (!a.is_synced) {
    return `<div class="row" data-id="${esc(a.id)}" title="${esc(a.email)}"><span class="name dim">${name}</span><span class="right dim">not synced</span></div>`;
  }
  const pct = a.remaining_percent;
  const cls = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : '';
  const reset = a.reset_period === 'daily' ? 'daily' : a.days_until_reset === 0 ? 'today' : `${a.days_until_reset}d`;
  return `<div class="row" data-id="${esc(a.id)}" title="${esc(a.email)} · open Flow">
    <span class="name ${a.id === recId ? 'next' : ''}">${a.id === recId ? '★ ' : ''}${name}</span>
    <span class="right"><span class="credits ${cls}">${(a.available_credits + (a.topup_credits || 0)).toLocaleString()}</span><span class="meta">${reset}</span></span>
  </div>`;
}

async function refresh() {
  try {
    const [{ accounts, summary }, job] = await Promise.all([
      fetch(`${TRACKER}/api/state`).then((r) => r.json()),
      fetch(`${TRACKER}/api/sync-job`).then((r) => r.json())
    ]);
    const rec = accounts.find((a) => a.id === summary.recommended_account_id);
    $('total').textContent = summary.total_available_credits.toLocaleString();
    $('sub').textContent = rec ? `Use next: ${rec.label || rec.email}` : `${summary.synced_accounts} of ${summary.total_accounts} synced`;

    const synced = accounts.filter((a) => a.is_synced).sort((a, b) => b.urgency_score - a.urgency_score);
    const rest = accounts.filter((a) => !a.is_synced);
    $('list').innerHTML = accounts.length
      ? [...synced, ...rest].map((a) => row(a, summary.recommended_account_id)).join('')
      : '<div class="empty">No accounts yet. Add them from the dashboard.</div>';

    $('sync').disabled = job.running;
    $('sync').textContent = job.running ? `Syncing ${Math.min(job.done + 1, job.total)} of ${job.total}…` : 'Sync all';
    if (job.running && !polling) polling = setInterval(refresh, 1500);
    if (!job.running && polling) {
      clearInterval(polling);
      polling = null;
    }
  } catch {
    $('total').textContent = '—';
    $('sub').textContent = 'Tracker isn’t running';
    $('list').innerHTML = '<div class="empty">Double-click “Start Flow Credits.command”.</div>';
    $('sync').disabled = true;
  }
}

// Click an account: open Flow in its Chrome profile.
$('list').addEventListener('click', async (e) => {
  const r = e.target.closest('.row');
  if (!r) return;
  await fetch(`${TRACKER}/api/accounts/${r.dataset.id}/launch-browser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).catch(() => {});
  window.close();
});

$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  await fetch(`${TRACKER}/api/sync-all`, { method: 'POST' }).catch(() => {});
  refresh();
});

$('dash').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: TRACKER });
});

refresh();
