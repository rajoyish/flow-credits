import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { format } from 'node:util';
import { cookieSyncAvailable, readFlowBalance } from './lib/flow-cookie-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3847);
const LEGACY_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.FLOW_CREDITS_DATA_DIR
  ? path.resolve(process.env.FLOW_CREDITS_DATA_DIR)
  : path.join(os.homedir(), 'Desktop', 'Flow Credits');
const DB_PATH = path.join(DATA_DIR, 'flow-credits.db');
const JSON_BACKUP_PATH = path.join(DATA_DIR, 'accounts-backup.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// SQLite includes committed WAL entries when it creates the compact snapshot.
// Use an exclusive link so an existing destination database is never replaced.
const legacyDbPath = path.join(LEGACY_DATA_DIR, 'flow-credits.db');
if (!process.env.FLOW_CREDITS_DATA_DIR && !fs.existsSync(DB_PATH) && fs.existsSync(legacyDbPath)) {
  const stagingDir = fs.mkdtempSync(path.join(DATA_DIR, '.migration-'));
  const snapshotPath = path.join(stagingDir, 'flow-credits.db');
  try {
    const legacyDb = new DatabaseSync(legacyDbPath, { readOnly: true });
    try {
      legacyDb.prepare('VACUUM INTO ?').run(snapshotPath);
    } finally {
      legacyDb.close();
    }
    fs.chmodSync(snapshotPath, 0o600);
    for (const name of ['settings.json', 'accounts-backup.json', 'server.log']) {
      const source = path.join(LEGACY_DATA_DIR, name);
      const dest = path.join(DATA_DIR, name);
      try {
        fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'EEXIST') throw err;
      }
    }
    try {
      fs.linkSync(snapshotPath, DB_PATH);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  } finally {
    fs.rmSync(snapshotPath, { force: true });
    fs.rmdirSync(stagingDir);
  }
}

const db = new DatabaseSync(DB_PATH);

function writeServerLog(level, ...args) {
  console[level](...args);
  const logPath = path.join(DATA_DIR, 'server.log');
  try {
    fs.appendFileSync(logPath, `${format(...args)}\n`, { mode: 0o600 });
    const size = fs.statSync(logPath).size;
    if (size > 256 * 1024) {
      const tail = Buffer.alloc(128 * 1024);
      const log = fs.openSync(logPath, 'r');
      try {
        fs.readSync(log, tail, 0, tail.length, size - tail.length);
      } finally {
        fs.closeSync(log);
      }
      fs.writeFileSync(logPath, tail.subarray(tail.indexOf(10) + 1));
    }
  } catch (err) {
    console.error('Failed to write tracker log:', err.message);
  }
}

// Reuse prepared statements: preparing on every request churns native SQLite memory.
const statementCache = new Map();
function prepare(sql) {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA journal_size_limit = 262144; -- shrink the write-ahead log back to <=256 KB after checkpoints
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    plan_name TEXT NOT NULL DEFAULT 'Google AI Pro',
    available_credits INTEGER NOT NULL DEFAULT 1000,
    monthly_allowance INTEGER NOT NULL DEFAULT 1000,
    topup_credits INTEGER NOT NULL DEFAULT 0,
    reset_day INTEGER NOT NULL DEFAULT 1,
    next_reset_date TEXT NOT NULL,
    last_reset_cycle TEXT DEFAULT '',
    chrome_profile TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT DEFAULT '',
    color TEXT DEFAULT '#6366f1',
    last_synced_at TEXT DEFAULT '',
    sync_source TEXT DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_logs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
`);

// Free Flow accounts refresh daily; Google AI Pro accounts reset monthly.
if (!prepare('PRAGMA table_info(accounts)').all().some((c) => c.name === 'reset_period')) {
  db.exec("ALTER TABLE accounts ADD COLUMN reset_period TEXT NOT NULL DEFAULT 'monthly'");
}

/**
 * Compute the next reset YYYY-MM-DD given a billing reset_day (1..31) and a reference date.
 */
function computeNextResetDate(resetDay, fromDate = new Date()) {
  const day = Math.max(1, Math.min(31, Number(resetDay) || 1));
  const year = fromDate.getFullYear();
  const month = fromDate.getMonth(); // 0-indexed
  const todayDay = fromDate.getDate();

  // Helper to clamp day to the number of days in (y, m)
  const getClampedDate = (y, m, d) => {
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const clampedDay = Math.min(d, daysInMonth);
    return new Date(y, m, clampedDay, 0, 0, 0, 0);
  };

  let candidate = getClampedDate(year, month, day);
  const todayMidnight = new Date(year, month, todayDay, 0, 0, 0, 0);

  if (candidate <= todayMidnight) {
    candidate = getClampedDate(year, month + 1, day);
  }

  return formatDateISO(candidate);
}

function formatDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysUntilDate(dateStr, now = new Date()) {
  if (!dateStr) return 30;
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return 30;
  const target = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const diffMs = target.getTime() - today.getTime();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Enrich an account row with computed metrics:
 * - days_until_reset
 * - usage_percent
 * - burn_rate_needed (credits/day to use before reset)
 * - urgency_score (credits to spend per day before reset)
 */
function enrichAccount(acc) {
  const daysLeft = daysUntilDate(acc.next_reset_date);
  const totalPool = Math.max(1, acc.monthly_allowance + (acc.topup_credits || 0));
  const totalAvailable = acc.available_credits + (acc.topup_credits || 0);
  const usedCredits = Math.max(0, acc.monthly_allowance - acc.available_credits);
  const remainingPercent = Math.min(100, Math.max(0, Math.round((acc.available_credits / Math.max(1, acc.monthly_allowance)) * 100)));

  // Credits per day you should spend before reset so monthly credits don't expire unused
  const effectiveDays = Math.max(1, daysLeft);
  const recommendedDailySpend = Math.round((acc.available_credits / effectiveDays) * 10) / 10;

  // Urgency score: high when you have >0 monthly credits AND reset is coming up soon
  let urgencyScore = 0;
  if (acc.status === 'active' && acc.available_credits > 0) {
    urgencyScore = Math.round((acc.available_credits / effectiveDays) * 100) / 100;
  }

  return {
    ...acc,
    total_available: totalAvailable,
    used_credits: usedCredits,
    remaining_percent: remainingPercent,
    days_until_reset: daysLeft,
    recommended_daily_spend: recommendedDailySpend,
    urgency_score: acc.last_synced_at ? urgencyScore : 0,
    // Accounts imported from Chrome hold placeholder numbers until their first real sync.
    is_synced: Boolean(acc.last_synced_at)
  };
}

/* Live updates for open dashboards (Server-Sent Events). */
const sseClients = new Set();
const BOOT_ID = crypto.randomUUID(); // dashboards reload themselves when this changes (new server code)
function broadcast(event) {
  for (const res of sseClients) {
    if (res.writableEnded || res.destroyed) sseClients.delete(res);
    else res.write(`event: ${event}\ndata: {}\n\n`);
  }
}

let backupTimer = null;
function writeJsonBackup() {
  broadcast('state'); // every data change goes through here
  clearTimeout(backupTimer);
  backupTimer = setTimeout(writeJsonBackupNow, 2000);
}

function writeJsonBackupNow() {
  clearTimeout(backupTimer);
  backupTimer = null;
  try {
    // History is only kept for the backup; cap it so the database doesn't grow forever.
    db.exec('DELETE FROM credit_logs WHERE id NOT IN (SELECT id FROM credit_logs ORDER BY created_at DESC LIMIT 2000)');
    const accounts = prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
    const logs = prepare('SELECT * FROM credit_logs ORDER BY created_at DESC LIMIT 500').all();
    fs.writeFileSync(
      JSON_BACKUP_PATH,
      JSON.stringify({ updatedAt: new Date().toISOString(), accounts, logs }, null, 2),
      'utf8'
    );
  } catch (err) {
    writeServerLog('error', 'Failed to write JSON backup:', err.message);
  }
}

// Whether silent cookie sync is available, checked once and cached (avoids re-spawning
// the `security` Keychain lookup on every state fetch).
let cookieSyncReadyCache = null;
function cookieSyncReady() {
  if (cookieSyncReadyCache === null) cookieSyncReadyCache = cookieSyncAvailable();
  return cookieSyncReadyCache;
}

// Prioritize a useful balance while avoiding credits expiring within a week.
// Among accounts in that window, use the largest balance first.
function recommendAccount(accounts) {
  const candidates = accounts.filter((a) =>
    a.is_synced && a.status === 'active' && (a.available_credits > 0 || a.topup_credits > 0)
  );
  const expiringSoon = candidates.filter((a) => a.days_until_reset <= 7);
  const balance = (a) => a.available_credits + (a.topup_credits || 0);
  return (expiringSoon.length ? expiringSoon : candidates)
    .sort((a, b) =>
      (expiringSoon.length
        ? balance(b) - balance(a) || a.days_until_reset - b.days_until_reset
        : a.days_until_reset - b.days_until_reset || balance(b) - balance(a)) ||
      (a.label || a.email).localeCompare(b.label || b.email) ||
      a.id.localeCompare(b.id)
    )[0] || null;
}

function getAllAccountsWithSummary() {
  const rawAccounts = prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
  const enriched = rawAccounts.map((a) => ({
    ...enrichAccount(a),
    extension_installed: a.chrome_profile ? profileHasExtension(a.chrome_profile) : false
  }));
  const synced = enriched.filter((a) => a.is_synced);

  const recommendedAccount = recommendAccount(enriched);

  const summary = {
    total_accounts: enriched.length,
    active_accounts: enriched.filter((a) => a.status === 'active').length,
    synced_accounts: synced.length,
    total_available_credits: synced.reduce((sum, a) => sum + a.available_credits + (a.topup_credits || 0), 0),
    total_monthly_allowance: synced.reduce((sum, a) => sum + a.monthly_allowance, 0),
    total_used_this_cycle: synced.reduce((sum, a) => sum + a.used_credits, 0),
    expiring_within_7_days: synced
      .filter((a) => a.status === 'active' && a.days_until_reset <= 7)
      .reduce((sum, a) => sum + a.available_credits, 0),
    recommended_account_id: recommendedAccount ? recommendedAccount.id : null,
    recommended_account_email: recommendedAccount ? recommendedAccount.email : null,
    recommended_reason: recommendedAccount
      ? `${recommendedAccount.available_credits.toLocaleString()} credits expiring in ${recommendedAccount.days_until_reset} day${recommendedAccount.days_until_reset === 1 ? '' : 's'} (~${recommendedAccount.recommended_daily_spend}/day)`
      : synced.length
        ? 'No synced accounts with remaining credits'
        : 'No accounts synced yet. Click ⟳ Sync all.',
    cookie_sync: cookieSyncReady()
  };

  return { accounts: enriched, summary };
}

/**
 * Parse text scraped from Google One AI Credits (`one.google.com/ai/credits`) or Google Flow (`labs.google/fx/tools/flow`)
 * and extract credit balance, monthly allowance, and reset date if present.
 */
function parseGoogleCreditsText(text = '') {
  const result = {
    available_credits: null,
    monthly_allowance: null,
    next_reset_date: null,
    reset_day: null,
    reset_period: null,
    plan_name: null,
    email: null
  };

  if (!text || typeof text !== 'string') return result;

  // Email match
  const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/);
  if (emailMatch) {
    result.email = emailMatch[1].toLowerCase();
  }

  // Common patterns on one.google.com/ai/credits and labs.google/fx/tools/flow:
  // e.g. "740 / 1,000 credits", "740 of 1,000", "740 credits remaining", "850 AI credits left"
  const fractionMatch =
    text.match(/([\d,]+)\s*(?:\/|of)\s*([\d,]+)\s*(?:AI\s*)?(?:monthly\s*)?credits?/i) ||
    text.match(/remaining[:\s]*([\d,]+)\s*(?:\/|of)\s*([\d,]+)/i);

  if (fractionMatch) {
    const avail = Number(fractionMatch[1].replace(/,/g, ''));
    const total = Number(fractionMatch[2].replace(/,/g, ''));
    if (!Number.isNaN(avail)) result.available_credits = avail;
    if (!Number.isNaN(total) && total > 0) result.monthly_allowance = total;
  } else {
    const singlePatterns = [
      /([\d,]+)\s*(?:Google\s*)?Flow\s*credits?/i, // flow.google.com account panel: "55 Google Flow credits"
      /([\d,]+)\s*(?:AI\s*)?credits?\s*(?:remaining|left|available)/i,
      /(?:available|remaining|balance)[:\s]*([\d,]+)\s*(?:AI\s*)?credits?/i,
      /AI\s*credits?\s*balance[:\s]*([\d,]+)/i,
      /\b([\d,]+)\s*AI\s*credits\b/i
    ];
    for (const pattern of singlePatterns) {
      const m = text.match(pattern);
      if (m) {
        const val = Number(m[1].replace(/,/g, ''));
        if (!Number.isNaN(val) && val >= 0 && val <= 1000000) {
          result.available_credits = val;
          break;
        }
      }
    }
  }

  // Free accounts: "Credits refresh daily at 11:21 AM" (50 credits a day, no monthly date)
  const daily = text.match(/refresh(?:es)?\s+daily(?:\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
  if (daily) {
    const now = new Date();
    const next = new Date(now);
    if (daily[1]) {
      let h = Number(daily[1]) % 12;
      if (/pm/i.test(daily[3])) h += 12;
      next.setHours(h, Number(daily[2]), 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
    } else {
      next.setDate(next.getDate() + 1);
    }
    result.reset_period = 'daily';
    result.plan_name = 'Free';
    result.monthly_allowance = 50;
    result.next_reset_date = formatDateISO(next);
    return result;
  }

  // Reset date patterns: "Resets on May 14", "Refreshes Dec 5, 2026", "Next reset: 2026-12-05"
  const isoDateMatch = text.match(/(?:resets?|refreshes?|renews?|next\s+billing)[^0-9]*(\d{4}-\d{2}-\d{2})/i);
  if (isoDateMatch) {
    result.next_reset_date = isoDateMatch[1];
    result.reset_day = Number(isoDateMatch[1].split('-')[2]);
  } else {
    const monthNames = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
    const naturalMatch =
      text.match(new RegExp(`(?:resets?|refreshes?|renews?|expires?)\\s*(?:on\\s*)?${monthNames}\\.?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`, 'i')) ||
      text.match(new RegExp(`(?:resets?|refreshes?|renews?|expires?)\\s*(?:on\\s*)?(\\d{1,2})\\s+${monthNames}(?:,?\\s*(\\d{4}))?`, 'i'));

    if (naturalMatch) {
      let monthStr, dayNum, yearNum;
      if (/^\d+$/.test(naturalMatch[1])) {
        dayNum = Number(naturalMatch[1]);
        monthStr = naturalMatch[2];
        yearNum = naturalMatch[3] ? Number(naturalMatch[3]) : null;
      } else {
        monthStr = naturalMatch[1];
        dayNum = Number(naturalMatch[2]);
        yearNum = naturalMatch[3] ? Number(naturalMatch[3]) : null;
      }
      const monthIndex = new Date(`${monthStr} 1, 2026`).getMonth();
      if (!Number.isNaN(monthIndex) && dayNum >= 1 && dayNum <= 31) {
        result.reset_day = dayNum;
        const now = new Date();
        const y = yearNum || now.getFullYear();
        let candidate = new Date(y, monthIndex, dayNum);
        if (!yearNum && candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
          candidate = new Date(y + 1, monthIndex, dayNum);
        }
        result.next_reset_date = formatDateISO(candidate);
        result.reset_period = 'monthly';
      }
    }
  }

  return result;
}

/**
 * Find Chrome / Brave / Chromium binary on macOS for isolated account session / profile launching.
 */
const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function findMacBrowserBinary() {
  const candidates = [
    CHROME_BINARY,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Open Google Flow in the account's linked Chrome profile.
 */
function launchAccountBrowserSession(account, targetUrl) {
  const browserBin = findMacBrowserBinary();
  const url = targetUrl || 'https://flow.google.com/';
  if (!browserBin) {
    execFile('open', [url]);
    return { launched: true, browser: 'macOS default' };
  }
  const args = account.chrome_profile ? [`--profile-directory=${account.chrome_profile}`, url] : [url];
  spawn(browserBin, args, { detached: true, stdio: 'ignore' }).unref();
  return { launched: true, browser: path.basename(browserBin) };
}

/**
 * Read the signed-in Google account of every local Chrome profile from Chrome's "Local State" file.
 */
const CHROME_LOCAL_STATE = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Local State'
);

let localStateCache = { mtimeMs: 0, infoCache: {} };
function chromeProfileInfo() {
  const mtimeMs = fs.statSync(CHROME_LOCAL_STATE).mtimeMs;
  if (mtimeMs !== localStateCache.mtimeMs) {
    const infoCache = JSON.parse(fs.readFileSync(CHROME_LOCAL_STATE, 'utf8')).profile?.info_cache || {};
    // Keep only the fields we use.
    const slim = {};
    for (const [dir, v] of Object.entries(infoCache)) slim[dir] = { user_name: v.user_name, name: v.name, gaia_name: v.gaia_name };
    localStateCache = { mtimeMs, infoCache: slim };
  }
  return localStateCache.infoCache;
}

function listChromeProfiles() {
  let cache = {};
  try {
    cache = chromeProfileInfo();
  } catch {
    return [];
  }
  const tracked = new Map(prepare('SELECT email, id FROM accounts').all().map((r) => [r.email, r.id]));
  return Object.entries(cache)
    .map(([dir, info]) => {
      const email = (info.user_name || '').trim().toLowerCase();
      const name = (info.name || '').trim();
      return {
        profile_dir: dir,
        email,
        name: !name || name.includes('@') ? email.split('@')[0] : name,
        full_name: info.gaia_name || '',
        tracked: tracked.has(email),
        extension_installed: profileHasExtension(dir),
        account_id: tracked.get(email) || null
      };
    })
    .filter((p) => p.email)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Is the Flow Credits extension loaded (and enabled) in this Chrome profile?
 * Unpacked extensions are recorded in the profile's "Secure Preferences" / "Preferences".
 */
const EXTENSION_DIR = path.join(__dirname, 'extension');
const CHROME_USER_DATA = path.dirname(CHROME_LOCAL_STATE);

function chromeProfileExists(dir) {
  return Boolean(dir && dir !== '.' && dir !== '..' && path.basename(dir) === dir &&
    fs.statSync(path.join(CHROME_USER_DATA, dir), { throwIfNoEntry: false })?.isDirectory());
}

function resolveSyncProfile(account, profiles) {
  const linked = account.chrome_profile;
  const email = account.email.trim().toLowerCase();
  const linkedEmail = profiles?.[linked]?.user_name?.trim().toLowerCase();
  if (chromeProfileExists(linked) && (!profiles || Object.hasOwn(profiles, linked)) &&
      (!linkedEmail || linkedEmail === email)) return linked;

  const matches = Object.entries(profiles || {}).filter(([dir, info]) =>
    info.user_name?.trim().toLowerCase() === email && chromeProfileExists(dir)
  );
  if (matches.length !== 1) return null;

  const [replacement] = matches[0];
  prepare('UPDATE accounts SET chrome_profile = ?, updated_at = ? WHERE id = ?')
    .run(replacement, new Date().toISOString(), account.id);
  writeJsonBackup();
  return replacement;
}

// Cache only the answer per preferences file, keyed by its modification time (the files are large).
const extensionCache = new Map(); // file path -> { mtimeMs, installed: true | false | null }

function extensionStateInFile(file) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const hit = extensionCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.installed;
  let installed = null; // null = not mentioned in this file
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')).extensions?.settings || {};
  for (const ext of Object.values(settings)) {
    if (ext.path === EXTENSION_DIR) {
      installed = Array.isArray(ext.disable_reasons) ? ext.disable_reasons.length === 0 : !ext.disable_reasons;
      break;
    }
  }
  extensionCache.set(file, { mtimeMs, installed });
  return installed;
}

function profileHasExtension(profileDir) {
  for (const file of ['Secure Preferences', 'Preferences']) {
    try {
      const installed = extensionStateInFile(path.join(CHROME_USER_DATA, profileDir, file));
      if (installed !== null) return installed;
    } catch {
      // file missing or unreadable; try the next one
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Sync settings and background-first sync runner.
 * ------------------------------------------------------------------ */
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

/* ------------------------------------------------------------------ *
 * Start at login: a per-user LaunchAgent that runs this server when you log in.
 * Writing/removing the file takes effect at the next login; it never touches the running server.
 * ------------------------------------------------------------------ */
const LAUNCH_AGENT_LABEL = 'com.flowcredits.tracker';
const LAUNCH_AGENT_PATH = path.join(process.env.HOME || '', 'Library/LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

function setStartAtLogin(enabled) {
  if (!enabled) {
    fs.rmSync(LAUNCH_AGENT_PATH, { force: true });
    return;
  }
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dataEnvironment = process.env.FLOW_CREDITS_DATA_DIR
    ? `<key>EnvironmentVariables</key><dict><key>FLOW_CREDITS_DATA_DIR</key><string>${esc(DATA_DIR)}</string></dict>`
    : '';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(path.join(__dirname, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(__dirname)}</string>
  ${dataEnvironment}
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, but not after "Stop server" (clean exit). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/dev/null</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(LAUNCH_AGENT_PATH), { recursive: true });
  fs.writeFileSync(LAUNCH_AGENT_PATH, plist);
}

function readSettings() {
  const defaults = { auto_sync: true, interval_hours: 6, last_auto_sync_at: '' };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')), start_at_login: fs.existsSync(LAUNCH_AGENT_PATH) };
  } catch {
    return { ...defaults, start_at_login: fs.existsSync(LAUNCH_AGENT_PATH) };
  }
}
function writeSettings(patch) {
  const { start_at_login, ...next } = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

let syncJob = { running: false, items: [] };
let syncController;
const CHROME_RECOVERY_ERRORS = new Set(['COOKIE_UNAVAILABLE', 'AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'KEYCHAIN_UNAVAILABLE']);

function finishSyncItem(item, status, message, errorCode) {
  item.status = status;
  item.message = message;
  if (errorCode) item.error_code = errorCode;
  else delete item.error_code;
  broadcast('job');
}

async function syncFromCookies(item, profile, signal) {
  const reading = await readFlowBalance(profile, item.email, signal);
  signal.throwIfAborted();
  if (item.status === 'synced') return;
  const result = applyReading({ ...reading, account_id: item.account_id });
  if (result.status !== 200) throw new Error(result.body.error || 'Reading rejected');
  item.credits = result.body.available_credits;
  finishSyncItem(item, 'synced', item.browser_opened ? 'Synced after opening Chrome' : 'Synced in the background');
}

async function recoverInChrome(item, profile, useCookie, signal) {
  try {
    signal.throwIfAborted();
    const info = chromeProfileInfo()[profile];
    const profileEmail = info?.user_name?.trim().toLowerCase();
    if (!info || !chromeProfileExists(profile) || (profileEmail && profileEmail !== item.email.toLowerCase())) {
      finishSyncItem(item, 'failed', 'Chrome profile is missing. Sign in to Chrome with this account, then sync again.', 'PROFILE_MISSING');
      return;
    }
    if (!useCookie && !profileHasExtension(profile)) {
      finishSyncItem(item, 'failed', 'Allow Chrome Safe Storage access or enable the Flow Credits extension for this profile.', 'KEYCHAIN_UNAVAILABLE');
      return;
    }
    item.browser_opened = true;
    finishSyncItem(item, 'syncing', 'Opening Flow in Chrome');
    await new Promise((resolve, reject) => {
      // `fct_sync` tells the extension this tab was opened for a sync job, so it closes it afterwards.
      const child = spawn(CHROME_BINARY, [`--profile-directory=${profile}`, '--new-window', 'https://flow.google.com/?fct_sync=1'], {
        detached: true, stdio: 'ignore'
      });
      child.once('error', reject);
      child.once('spawn', resolve);
      child.unref();
    });
    if (item.status === 'syncing') finishSyncItem(item, 'syncing', 'Waiting for a balance from Chrome');
  } catch (err) {
    if (signal.aborted) finishSyncItem(item, 'skipped', 'Cancelled');
    else finishSyncItem(item, 'failed', `Could not open Chrome: ${err.message}`, 'CHROME_LAUNCH_FAILED');
    return;
  }

  const retrySignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  try {
    while (item.status === 'syncing') {
      await delay(5000, undefined, { signal: retrySignal });
      if (!useCookie || item.status !== 'syncing') continue;
      try {
        await syncFromCookies(item, profile, retrySignal);
      } catch (err) {
        retrySignal.throwIfAborted();
        if (!CHROME_RECOVERY_ERRORS.has(err.code)) throw err;
      }
    }
  } catch (err) {
    if (item.status === 'synced') return;
    if (signal.aborted) finishSyncItem(item, 'skipped', 'Cancelled');
    else if (retrySignal.aborted) {
      const message = useCookie
        ? 'Flow opened in Chrome. Sign in or select this account there, then sync again.'
        : 'Flow opened in Chrome. Sign in there if prompted. Check that the Flow Credits extension is enabled or allow Chrome Safe Storage access.';
      finishSyncItem(item, 'failed', message, 'CHROME_READING_PENDING');
    } else finishSyncItem(item, 'failed', `Could not read Flow after opening Chrome: ${err.message}`, err.code || 'SYNC_FAILED');
  }
}

function publicJob() {
  const { items = [], ...rest } = syncJob;
  const done = items.filter((i) => ['synced', 'failed', 'skipped'].includes(i.status)).length;
  return { ...rest, total: items.length, done, items };
}

async function runSyncJob(trigger, accountIds = null) {
  if (syncJob.running) return publicJob();
  let accounts = prepare("SELECT * FROM accounts WHERE status = 'active' ORDER BY label COLLATE NOCASE").all();
  if (accountIds) accounts = accounts.filter((a) => accountIds.includes(a.id));

  syncJob = {
    running: true,
    cancelled: false,
    trigger,
    started_at: new Date().toISOString(),
    finished_at: null,
    items: accounts.map((a) => ({
      account_id: a.id,
      email: a.email,
      label: a.label || a.email,
      status: 'queued',
      message: '',
      credits: null
    }))
  };
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  syncController = new AbortController();
  const { signal } = syncController;

  (async () => {
    const useCookie = cookieSyncReady();
    let profiles;
    try {
      profiles = chromeProfileInfo();
    } catch {
      // Existing profile directories can still be used for silent sync.
    }
    const recovery = [];
    for (const item of syncJob.items) {
      if (signal.aborted) {
        finishSyncItem(item, 'skipped', 'Cancelled');
        continue;
      }
      const acc = accountById.get(item.account_id);
      const profile = resolveSyncProfile(acc, profiles);
      if (!profile) {
        finishSyncItem(item, 'failed', 'No matching Chrome profile found. Sign in to Chrome with this account, then sync again.', 'PROFILE_MISSING');
        continue;
      }
      finishSyncItem(item, 'syncing', 'Reading saved Flow session');

      try {
        if (!useCookie) {
          throw Object.assign(new Error('Chrome Safe Storage is unavailable.'), { code: 'KEYCHAIN_UNAVAILABLE' });
        }
        await syncFromCookies(item, profile, signal);
      } catch (err) {
        if (signal.aborted) finishSyncItem(item, 'skipped', 'Cancelled');
        else if (CHROME_RECOVERY_ERRORS.has(err.code)) {
          recovery.push({ item, profile });
          finishSyncItem(item, 'queued', 'Waiting to open Flow in Chrome');
        } else finishSyncItem(item, 'failed', `Background sync failed: ${err.message}`, err.code || 'SYNC_FAILED');
      }
    }
    await Promise.all(recovery.map(({ item, profile }) => recoverInChrome(item, profile, useCookie, signal)));
  })().catch((err) => {
    writeServerLog('error', 'Sync job failed:', err.message);
    for (const item of syncJob.items) {
      if (item.status === 'queued' || item.status === 'syncing') {
        finishSyncItem(item, 'failed', 'Sync was interrupted. Try again.', 'SYNC_FAILED');
      }
    }
  }).finally(() => {
    syncJob.running = false;
    syncJob.finished_at = new Date().toISOString();
    broadcast('job');
    broadcast('state');
    if (trigger === 'auto') writeSettings({ last_auto_sync_at: syncJob.finished_at });
  });

  broadcast('job');
  return publicJob();
}

// Automatic background sync: check every 5 minutes whether a full sync is due.
setInterval(() => {
  const s = readSettings();
  if (!s.auto_sync || syncJob.running) return;
  const last = s.last_auto_sync_at ? Date.parse(s.last_auto_sync_at) : 0;
  if (Date.now() - last >= s.interval_hours * 3600 * 1000) runSyncJob('auto');
}, 5 * 60 * 1000);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        // Stop buffering: drop what we have and ignore the rest of the upload.
        tooLarge = true;
        body = '';
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Standard monthly Google AI Pro Flow grant. Used as a floor for Pro accounts.
const PRO_MONTHLY_ALLOWANCE = 1000;

/**
 * Infer an account's monthly_allowance. Flow's API doesn't report the grant, so:
 *  - Free (daily) accounts always get 50.
 *  - Pro (monthly) accounts get at least the standard Pro grant, at least the credits
 *    currently available (a fresh or topped-up balance can exceed the base grant), and
 *    never less than a known larger allowance (e.g. an Ultra tier already on file).
 * Using max() means the value only ever grows, so a stale free-tier default (50) stuck
 * on a Pro account is corrected on the next sync without ever shrinking a real grant.
 */
function inferMonthlyAllowance(period, availableNow, existing) {
  if (period === 'daily') return 50;
  return Math.max(existing || 0, availableNow || 0, PRO_MONTHLY_ALLOWANCE);
}

/**
 * Apply one Flow credit reading to the database: find or create the account, update
 * its balance / reset date / plan, and log the delta. Shared by the Chrome extension
 * endpoint (/api/sync-inbound) and the silent cookie sync. Returns { status, body }.
 *
 * Accepts either structured fields (available_credits, next_reset_date, reset_period,
 * plan_name, monthly_allowance, reset_day) or raw page text to parse.
 */
function applyReading(body) {
  const nowIso = new Date().toISOString();

  const parsed = parseGoogleCreditsText(body.raw_text || '');
  writeServerLog('log',
    `[sync-inbound] ${body.email || '?'}: credits=${body.available_credits ?? parsed.available_credits} reset=${
      body.next_reset_date || parsed.next_reset_date
    } (${body.reset_period || parsed.reset_period || 'no date found'})`
  );
  const email = ((body.email || parsed.email || '') + '').trim().toLowerCase();
  const accountId = body.account_id || null;

  let target = null;
  if (accountId) {
    target = prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  }
  if (!target && email) {
    target = prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  }

  const avail =
    body.available_credits !== undefined && body.available_credits !== null
      ? Number(body.available_credits)
      : parsed.available_credits;
  const allowance =
    body.monthly_allowance !== undefined && body.monthly_allowance !== null
      ? Number(body.monthly_allowance)
      : parsed.monthly_allowance;
  const resetDay =
    body.reset_day !== undefined && body.reset_day !== null ? Number(body.reset_day) : parsed.reset_day;
  const nextResetDate = body.next_reset_date || parsed.next_reset_date || null;
  const resetPeriod = body.reset_period || parsed.reset_period || null;

  // No balance found on the page (e.g. Flow's account panel was closed): don't mark the account as synced.
  if (avail === null || avail === undefined || Number.isNaN(Number(avail))) {
    return {
      status: 422,
      body: {
        error: 'No credit balance found. In Flow, click your avatar to open the account panel, then sync again.',
        parsed
      }
    };
  }

  if (!target && !email) {
    return {
      status: 400,
      body: {
        error:
          'Could not identify which Google account to sync. Please select an account or ensure your Google email is visible on the page.',
        parsed
      }
    };
  }

  // If account doesn't exist yet and we have an email, auto-create it!
  if (!target && email) {
    const id = crypto.randomUUID();
    const rDay = resetDay || new Date().getDate();
    const nReset = nextResetDate || computeNextResetDate(rDay);
    const aCredits = avail !== null && avail !== undefined ? avail : allowance || 0;
    const mAllowance = inferMonthlyAllowance(resetPeriod || 'monthly', aCredits, allowance);
    const plan = body.plan_name || (resetPeriod === 'daily' ? 'Free' : 'Google AI Pro');

    prepare(`
      INSERT INTO accounts (
        id, email, label, plan_name, available_credits, monthly_allowance,
        topup_credits, reset_day, next_reset_date, last_reset_cycle,
        chrome_profile, status, notes, color, last_synced_at, sync_source,
        created_at, updated_at, reset_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      email,
      email.split('@')[0],
      plan,
      aCredits,
      mAllowance,
      0,
      rDay,
      nReset,
      '',
      '',
      'active',
      'Auto-created via Google Browser Sync',
      '#6366f1',
      nowIso,
      body.source || 'browser-sync',
      nowIso,
      nowIso,
      resetPeriod || 'monthly'
    );

    prepare(`
      INSERT INTO credit_logs (id, account_id, delta, balance_after, reason, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, aCredits, aCredits, 'Auto-synced from Google AI Credits page', body.source || 'browser-sync', nowIso);

    writeJsonBackup();
    return {
      status: 200,
      body: {
        ok: true,
        action: 'created',
        close_tab: false,
        email,
        available_credits: aCredits,
        ...getAllAccountsWithSummary()
      }
    };
  }

  // Update existing account
  const updatedAvail = avail !== null && avail !== undefined && !Number.isNaN(avail) ? avail : target.available_credits;
  const updatedResetDay =
    resetDay !== null && resetDay !== undefined && !Number.isNaN(resetDay) ? resetDay : target.reset_day;
  const updatedNextReset = nextResetDate || computeNextResetDate(updatedResetDay);
  const updatedPeriod = resetPeriod || target.reset_period || 'monthly';
  // Flow's API omits the monthly grant; infer it. An explicitly-reported allowance (rare,
  // from page text) is used as the baseline but still floored for the plan.
  const allowanceBaseline =
    allowance !== null && allowance !== undefined && !Number.isNaN(allowance) ? allowance : target.monthly_allowance;
  const updatedAllowance = inferMonthlyAllowance(updatedPeriod, updatedAvail, allowanceBaseline);
  const updatedPlan =
    body.plan_name || (updatedPeriod === 'daily' ? 'Free' : updatedPeriod === 'monthly' ? 'Google AI Pro' : target.plan_name);

  const delta = updatedAvail - target.available_credits;

  prepare(`
    UPDATE accounts
    SET available_credits = ?,
        monthly_allowance = ?,
        reset_day = ?,
        next_reset_date = ?,
        reset_period = ?,
        plan_name = ?,
        last_synced_at = ?,
        sync_source = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    updatedAvail,
    updatedAllowance,
    updatedResetDay,
    updatedNextReset,
    updatedPeriod,
    updatedPlan,
    nowIso,
    body.source || 'browser-sync',
    nowIso,
    target.id
  );

  if (delta !== 0) {
    prepare(`
      INSERT INTO credit_logs (id, account_id, delta, balance_after, reason, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), target.id, delta, updatedAvail, 'Synced from Google AI Credits / Flow', body.source || 'browser-sync', nowIso);
  }

  writeJsonBackup();
  // Flow can report a reading through the extension during or after browser recovery.
  const jobItem = syncJob.items.find((item) => item.account_id === target.id &&
    (item.status === 'failed' || (item.status === 'syncing' && item.browser_opened)));
  const fromExtension = body.source !== 'cookie-sync' && email === target.email.toLowerCase();
  if (jobItem && fromExtension) {
    jobItem.credits = updatedAvail;
    finishSyncItem(jobItem, 'synced', 'Synced after reconnecting');
  }
  // Close the Chrome window the sync job opened once it has reported this account's balance.
  const closeTab = fromExtension && syncJob.items.some((item) => item.account_id === target.id && item.browser_opened);
  return {
    status: 200,
    body: {
      ok: true,
      action: 'updated',
      close_tab: closeTab,
      email: target.email,
      available_credits: updatedAvail,
      next_reset_date: updatedNextReset,
      ...getAllAccountsWithSummary()
    }
  };
}

const server = http.createServer(async (req, res) => {
  // Enable CORS so the 1-Click Bookmarklet & Chrome Extension on one.google.com or labs.google can post directly to localhost
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Allow-Private-Network': 'true'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  try {
    // GET /api/state -> all accounts and the summary
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, getAllAccountsWithSummary());
    }

    // GET /api/extension-version -> version of the extension files on disk (extension self-reloads on mismatch)
    if (req.method === 'GET' && pathname === '/api/extension-version') {
      const { version } = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
      return sendJson(res, 200, { version });
    }

    // POST /api/sync-closed -> extension reports what it closed after a sync
    if (req.method === 'POST' && pathname === '/api/sync-closed') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').toLowerCase();
      const note = body.closed_windows
        ? `window closed${body.kept_windows ? `, ${body.kept_windows} of your windows kept` : ''}`
        : body.closed_tab_only
          ? 'tab closed (window has your other tabs)'
          : 'nothing closed';
      writeServerLog('log', `[sync-closed] ${email}: ${note}`);
      const item = [...(syncJob.items || [])].reverse().find((i) => i.email === email);
      if (item) {
        item.message = note;
        broadcast('job');
      }
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/events -> live update stream for the dashboard
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ boot_id: BOOT_ID })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      const drop = () => {
        clearInterval(ping);
        sseClients.delete(res);
      };
      req.on('close', drop);
      res.on('error', drop);
      return;
    }

    // GET /api/chrome-profiles -> Google accounts signed into local Chrome profiles
    if (req.method === 'GET' && pathname === '/api/chrome-profiles') {
      return sendJson(res, 200, { profiles: listChromeProfiles() });
    }

    // POST /api/chrome-profiles/import -> add accounts for the given profile dirs (or all untracked ones)
    if (req.method === 'POST' && pathname === '/api/chrome-profiles/import') {
      const body = await readJsonBody(req);
      const wanted = Array.isArray(body.profile_dirs) ? new Set(body.profile_dirs) : null;
      const nowIso = new Date().toISOString();
      const palette = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#14b8a6'];
      let count = prepare('SELECT COUNT(*) as c FROM accounts').get().c;
      const added = [];
      const linked = [];

      for (const p of listChromeProfiles()) {
        if (wanted && !wanted.has(p.profile_dir)) continue;
        if (p.tracked) {
          // Already tracked (e.g. created by extension sync): just link it to its Chrome profile.
          prepare(`UPDATE accounts SET chrome_profile = ?, updated_at = ? WHERE id = ? AND (chrome_profile IS NULL OR chrome_profile = '')`)
            .run(p.profile_dir, nowIso, p.account_id);
          linked.push(p.email);
          continue;
        }
        // Real balance and reset date arrive on the first extension sync; until then assume a full Pro month.
        const resetDay = new Date().getDate();
        prepare(`
          INSERT INTO accounts (
            id, email, label, plan_name, available_credits, monthly_allowance,
            topup_credits, reset_day, next_reset_date, last_reset_cycle,
            chrome_profile, status, notes, color, last_synced_at, sync_source,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'Google AI Pro', 1000, 1000, 0, ?, ?, '', ?, 'active', '', ?, '', 'chrome-profile', ?, ?)
        `).run(
          crypto.randomUUID(),
          p.email,
          p.name,
          resetDay,
          computeNextResetDate(resetDay),
          p.profile_dir,
          palette[count++ % palette.length],
          nowIso,
          nowIso
        );
        added.push(p.email);
      }

      writeJsonBackup();
      return sendJson(res, 200, { ok: true, added, linked, ...getAllAccountsWithSummary() });
    }

    // POST /api/chrome-profiles/open-extensions -> open chrome://extensions in that profile, copy extension path
    if (req.method === 'POST' && pathname === '/api/chrome-profiles/open-extensions') {
      const body = await readJsonBody(req);
      const profile = listChromeProfiles().find((p) => p.profile_dir === body.profile_dir);
      if (!profile) return sendJson(res, 404, { error: 'Chrome profile not found.' });
      const browserBin = findMacBrowserBinary();
      if (!browserBin) return sendJson(res, 500, { error: 'Google Chrome not found.' });
      spawn(browserBin, [`--profile-directory=${profile.profile_dir}`, 'chrome://extensions'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      // Put the extension folder on the clipboard for the "Load unpacked" picker (Cmd+Shift+G, Cmd+V).
      const pb = spawn('pbcopy');
      pb.stdin.end(EXTENSION_DIR);
      return sendJson(res, 200, { ok: true, extension_dir: EXTENSION_DIR });
    }

    // POST /api/shutdown -> stop the tracker (clean exit, so the login agent won't restart it)
    if (req.method === 'POST' && pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true });
      writeServerLog('log', 'Stopped from the dashboard.');
      for (const c of sseClients) c.end();
      setTimeout(shutdown, 200);
      return;
    }

    // Sync-all job: start / progress / cancel, and auto-sync settings
    if (req.method === 'POST' && pathname === '/api/sync-all') {
      const { origin } = req.headers;
      if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}` &&
          !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        return sendJson(res, 403, { error: 'Start syncing from the local tracker or Chrome extension.' });
      }
      const body = await readJsonBody(req).catch(() => ({}));
      return sendJson(res, 200, await runSyncJob('manual', Array.isArray(body.account_ids) ? body.account_ids : null));
    }
    if (req.method === 'GET' && pathname === '/api/sync-job') {
      return sendJson(res, 200, publicJob());
    }
    if (req.method === 'POST' && pathname === '/api/sync-job/cancel') {
      syncJob.cancelled = true;
      syncController?.abort();
      return sendJson(res, 200, publicJob());
    }
    if (pathname === '/api/settings') {
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const patch = {};
        if (typeof body.auto_sync === 'boolean') patch.auto_sync = body.auto_sync;
        if (Number(body.interval_hours) >= 1) patch.interval_hours = Math.min(168, Number(body.interval_hours));
        if (typeof body.start_at_login === 'boolean') setStartAtLogin(body.start_at_login);
        writeSettings(patch);
      }
      return sendJson(res, 200, readSettings());
    }

    // DELETE /api/accounts/:id
    const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (req.method === 'DELETE' && accountMatch) {
      const id = accountMatch[1];
      prepare('DELETE FROM accounts WHERE id = ?').run(id);
      writeJsonBackup();
      return sendJson(res, 200, getAllAccountsWithSummary());
    }

    // POST /api/accounts/:id/launch-browser -> opens isolated or profile-bound Chrome session for this account
    const launchMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/launch-browser$/);
    if (req.method === 'POST' && launchMatch) {
      const id = launchMatch[1];
      const existing = prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'Account not found.' });

      const body = await readJsonBody(req);
      const info = launchAccountBrowserSession(existing, body.url);
      return sendJson(res, 200, { ok: true, ...info });
    }

    // POST /api/sync-inbound -> called by the Chrome extension and the silent cookie sync with a Flow reading
    if (req.method === 'POST' && pathname === '/api/sync-inbound') {
      const body = await readJsonBody(req);
      const result = applyReading(body);
      return sendJson(res, result.status, result.body);
    }

    // Serve static files from public/
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    if (err.message === 'Payload too large') return sendJson(res, 413, { error: err.message });
    writeServerLog('error', 'Server error:', err);
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

/** Flush pending writes, then exit cleanly (exit 0 = launchd won't restart us). */
function shutdown() {
  if (backupTimer) writeJsonBackupNow();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold the write-ahead log back into the database file
    db.close();
  } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown); // launchd / logout
process.on('SIGINT', shutdown); // Ctrl+C in Terminal

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Flow Credits is already running on http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  writeServerLog('log', `Flow Credits Tracker running on http://localhost:${PORT} (SQLite DB: ${DB_PATH})`);
});
