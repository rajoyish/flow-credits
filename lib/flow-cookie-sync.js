// Silent Flow sync: read each Chrome profile's Google login cookies straight from
// disk, decrypt them with the key macOS keeps in the Keychain, and ask Flow for the
// credit balance over its own RPC. No browser window is opened.
//
// macOS + Google Chrome only. Chrome stores each profile's cookies in an SQLite file
// inside the profile folder, with each value encrypted AES-128-CBC under a key derived
// (PBKDF2) from the "Chrome Safe Storage" Keychain password. The first read of that
// Keychain item shows a one-time macOS prompt; click "Always Allow".

import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

let cachedKey = null; // derived AES key, cached for the process once the Keychain allows it

/** Derive (and cache) the AES key from the Chrome Safe Storage Keychain password. */
function getKey() {
  if (cachedKey) return cachedKey;
  // Throws if the user denies the Keychain prompt or Chrome isn't installed.
  const pass = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], {
    encoding: 'utf8'
  }).trim();
  cachedKey = crypto.pbkdf2Sync(pass, 'saltysalt', 1003, 16, 'sha1');
  return cachedKey;
}

/** True when silent sync can run on this machine (macOS, Chrome present, Keychain readable). */
export function cookieSyncAvailable() {
  if (process.platform !== 'darwin') return false;
  if (!fs.existsSync(CHROME_DIR)) return false;
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/** Read and decrypt the cookies a profile holds for `host`, as a "name=value; …" header. */
function cookieHeader(profileDir, host) {
  const profilePath = path.join(CHROME_DIR, profileDir);
  const cookieFile = path.join(profilePath, 'Cookies');
  if (!fs.existsSync(cookieFile)) {
    throw Object.assign(new Error(`No cookie store for profile "${profileDir}"`), { code: 'COOKIE_UNAVAILABLE' });
  }

  // Copy the store (and its WAL) so we never touch the file Chrome is using live.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cookies-'));
  try {
    for (const f of ['Cookies', 'Cookies-wal', 'Cookies-journal']) {
      const src = path.join(profilePath, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }
    const db = new DatabaseSync(path.join(tmp, 'Cookies'), { readOnly: true });
    const metaVersion = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value || 0);
    const rows = db.prepare('SELECT host_key, name, value, encrypted_value FROM cookies').all();
    db.close();

    const key = getKey();
    const iv = Buffer.alloc(16, ' ');
    const pairs = [];
    for (const r of rows) {
      const hk = r.host_key;
      const matches = hk === host || (hk.startsWith('.') && (host === hk.slice(1) || host.endsWith(hk)));
      if (!matches) continue;

      let value = r.value;
      const enc = Buffer.from(r.encrypted_value || []);
      if (!value && enc.length) {
        const scheme = enc.subarray(0, 3).toString('latin1');
        if (scheme !== 'v10') continue; // only the AES-CBC scheme used on macOS
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        let plain = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
        // Chrome cookie schema v24+ prefixes the plaintext with a 32-byte SHA-256 of the host.
        if (metaVersion >= 24) plain = plain.subarray(32);
        value = plain.toString('utf8');
      }
      if (value) pairs.push(`${r.name}=${value}`);
    }
    if (!pairs.length) {
      throw Object.assign(new Error(`No ${host} cookies in profile "${profileDir}"`), { code: 'COOKIE_UNAVAILABLE' });
    }
    return pairs.join('; ');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const field = (html, k) => (html.match(new RegExp(`"${k}":"([^"]*)"`)) || [])[1] || '';

function toISODate(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Read one profile's Flow balance via cookies. Returns a reading shaped like the
 * fields /api/sync-inbound accepts, or throws on failure.
 *
 * The `nzlxg` RPC answers: [balance, periodCode, _, _, null, balance, [resetEpochSec, nanos]]
 * periodCode 3 => Free (daily refresh); otherwise Pro (monthly reset).
 */
export async function readFlowBalance(profileDir, expectedEmail = '', signal) {
  const cookie = cookieHeader(profileDir, 'flow.google.com');
  return fetchFlowBalance(cookie, expectedEmail, fetch, signal);
}

// Separate the network request from Chrome/Keychain access so session failures can
// be checked without using anyone's real credentials.
export async function fetchFlowBalance(cookie, expectedEmail = '', fetchImpl = fetch, jobSignal) {
  const common = { cookie, 'user-agent': UA };
  const timeout = AbortSignal.timeout(45000);
  const signal = jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;

  const pageRes = await fetchImpl('https://flow.google.com/', { headers: common, signal });
  if (!pageRes.ok) throw new Error(`Flow page returned HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const at = field(html, 'SNlM0e');
  const bl = field(html, 'cfb2h');
  const email = field(html, 'oPEP7c').toLowerCase();
  if (!at) {
    const err = new Error('Google did not accept this profile’s saved Flow session. Open Flow in this profile, sign in if asked, then sync again.');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }
  if (!email || (expectedEmail && email !== expectedEmail.trim().toLowerCase())) {
    throw Object.assign(new Error('Flow returned a different or unidentified Google account.'), { code: 'ACCOUNT_MISMATCH' });
  }

  const body = new URLSearchParams({ 'f.req': JSON.stringify([[['nzlxg', '[]', null, 'generic']]]), at });
  const rpcRes = await fetchImpl(
    `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=nzlxg&source-path=%2F&bl=${encodeURIComponent(bl)}&hl=en&rt=c`,
    {
      method: 'POST',
      signal,
      body,
      headers: {
        ...common,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        origin: 'https://flow.google.com',
        referer: 'https://flow.google.com/',
        'x-same-domain': '1'
      }
    }
  );
  if (!rpcRes.ok) throw new Error(`Flow credits RPC returned HTTP ${rpcRes.status}`);
  const text = await rpcRes.text();
  const m = text.match(/"wrb\.fr","nzlxg",("(?:[^"\\]|\\.)*")/);
  if (!m) throw new Error('Flow credits RPC returned no balance');
  const data = JSON.parse(JSON.parse(m[1])); // unwrap the JSON-string-inside-JSON

  const available = Number(data[0]);
  if (!Number.isFinite(available)) throw new Error('Flow credits RPC balance was not a number');
  const isDaily = data[1] === 3;
  const resetEpoch = Array.isArray(data[6]) ? Number(data[6][0]) : null;
  const nextResetDate = resetEpoch ? toISODate(resetEpoch) : null;

  return {
    email,
    available_credits: available,
    reset_period: isDaily ? 'daily' : 'monthly',
    plan_name: isDaily ? 'Free' : 'Google AI Pro',
    monthly_allowance: isDaily ? 50 : undefined,
    next_reset_date: nextResetDate,
    reset_day: !isDaily && resetEpoch ? new Date(resetEpoch * 1000).getDate() : undefined,
    source: 'cookie-sync'
  };
}
