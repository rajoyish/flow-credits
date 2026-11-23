# Flow Credits

A local macOS dashboard that tracks the **Google Flow credits** of every Google account in your Chrome profiles, and tells you which account to use next before its credits reset.

- Finds your Google accounts from your Chrome profiles: no forms to fill in.
- Syncs balances and reset dates in the background and opens Flow in Chrome profiles that need session recovery.
- Knows the difference between **Google AI Pro** accounts (monthly reset) and **free** accounts (50 credits that refresh daily).
- Recommends which account to use next, so monthly credits don't expire unused.
- Includes an optional Chrome extension with a toolbar popup showing every account at a glance.

Everything runs on your Mac. No data leaves it.

## Requirements

- macOS
- Google Chrome, with one Google account signed into each Chrome profile you want to track
- Node.js 22.5 or newer (uses the built-in `node:sqlite`)

No `npm install` is needed: there are no dependencies.

## Quick start

1. **Start the server.** Double-click **`Start Flow Credits.command`** (or run `npm start`). The dashboard opens at <http://localhost:3847>.
2. **Add your accounts.** Click **+ Add accounts → Add all**. Accounts are read from your Chrome profiles.
3. **Sync.** Click **⟳ Sync all**. At the macOS prompt for the Chrome Safe Storage key, click **Always Allow**. The same sync runs on the schedule set in the **Auto-sync** panel.

That's it. Syncing reads each profile's Flow balance in the background; **no Chrome extension is required.**

### Optional: the toolbar popup

If you want every account's credits in a Chrome toolbar popup, install the extension in each profile (one time, about 20 seconds each). Click **Set up extension** in the sync panel, then for each profile:

1. Click **Open Extensions**. That profile's `chrome://extensions` page opens and the extension folder path is copied.
2. Turn on **Developer mode** (top right), then click **Load unpacked**.
3. In the folder picker press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, then <kbd>⌘</kbd><kbd>V</kbd>, <kbd>Return</kbd>, and click **Select**.

Chrome only runs an extension in the profiles it is installed in, so this is needed once per profile.

## Using it

### Dashboard

- **Summary:** total available credits, the account to use next, credits expiring within 7 days, and how many accounts are synced.
- **Sync panel:** live progress of a sync, the **Auto-sync** switch and interval (default every 6 hours), and the extension setup banner while any profile still needs it.
- **Account cards:** balance, reset date (or "Free · refreshes daily"), last sync time, **Open Flow** (opens Flow in that account's Chrome profile), and ✕ to stop tracking an account.
- **Footer:** **Start at login** and **Stop server**.

The dashboard updates live. It never needs a refresh.

### Extension popup

Click the ✦ icon in Chrome's toolbar to see every account's credits and days until reset. Click an account to open Flow in its profile, or press **Sync all**.

### Start at login

Turn on **Start at login** at the bottom of the dashboard to run the server in the background whenever you log in. This installs a per-user LaunchAgent at `~/Library/LaunchAgents/com.flowcredits.tracker.plist`; turning the switch off removes it.

- **Stop server** stops it until you start it again or next log in.
- If the server crashes, macOS restarts it.
- With Start at login on, **Start Flow Credits.command** starts the background service instead of running in a Terminal window.

The LaunchAgent points at the Node.js binary that was running when you turned the switch on. If that Node version is removed later, turn the switch off and on again.

“Use next” chooses the largest remaining balance among accounts resetting within 7 days, then the earlier reset date when balances match. If none reset within 7 days, it chooses the nearest reset date, then the larger balance. Only synced, active accounts with credits qualify. Account cards remain sorted by highest available credits.

## How syncing works

**Silent sync (default).** For each account, the server reads that Chrome profile's `flow.google.com` login cookies straight from disk, decrypts them with the key macOS keeps in your Keychain, and asks Flow for the balance and reset date over Flow's own request — the same data the account panel shows. Nothing opens on screen. All your accounts sync in a few seconds, and Chrome doesn't even need to be running.

The Keychain key is read once per server run (the one-time *"Always Allow"* prompt); cookies are copied to a temp file and read there, never modified. See `lib/flow-cookie-sync.js`.

**Chrome recovery.** Scheduled **Auto-sync**, **Sync all**, and per-account **Sync** first try the saved Flow session. For profiles with missing or expired Flow sessions, the tracker opens Flow in Chrome and retries the balance. An enabled Flow Credits extension can report the balance as soon as the page loads. If a tracked profile was deleted, the tracker relinks it when it finds exactly one existing Chrome profile signed in with the same email.

With the optional extension installed, opening Flow yourself also syncs that account, and the dashboard and popup update straight away.

## Data and privacy

- **Database:** account data is stored in `~/Desktop/Flow Credits/flow-credits.db` (SQLite), with an automatic JSON copy in `accounts-backup.json` in the same folder.
- **Settings and log:** auto-sync settings are in `settings.json`. The tracker writes to `server.log` and keeps roughly the latest 128 KB when the log exceeds 256 KB.
- **Upgrade:** the first start with the default location copies the previous tracker files from the project's `data/` folder and compacts the SQLite database. The old files remain available as a backup. If Start at login was already enabled, toggle it off and back on to refresh the service configuration for the next login.
- **Custom location:** set `FLOW_CREDITS_DATA_DIR` to use an explicit data folder.
- **Chrome cleanup:** the tracker’s saved credit history lives outside Chrome. In Chrome’s **Delete browsing data** dialog, select **Cached images and files** only to clear the browser cache while keeping sign-ins for sync.
- **Local only:** the server only listens on `127.0.0.1`, the extension only talks to `localhost:3847`, and nothing is sent anywhere except directly to Google's own `flow.google.com` to read your balance — exactly as your browser does.
- **What the server reads from Chrome:** Chrome's `Local State` file (to list profiles and their signed-in email), each profile's preferences file (to check whether the extension is installed), and — for silent sync — each profile's `flow.google.com` cookies, which it decrypts with the Chrome Safe Storage key from your Keychain and uses only to fetch that account's Flow credit balance. Cookies are read from a temporary copy and never modified; nothing is logged or stored beyond the balance and reset date. It does not read passwords or other sites' cookies.
- **The `tabs` permission** (extension only) supports closing legacy sync tabs. Chrome recovery tabs stay open so you can sign in if needed.

`data/` is excluded from git.

## Project structure

```
server.js                    HTTP server, SQLite, Chrome profile detection, sync runner, LaunchAgent
lib/flow-cookie-sync.js      Silent sync: decrypt a profile's cookies, read the Flow balance
public/                      Dashboard (index.html, app.js, styles.css)
extension/                   Chrome extension (Manifest V3)
  content.js                 Reads the Flow account panel
  background.js              Relays readings to the server, closes sync windows, self-updates
  popup.html, popup.js       Toolbar popup
  icons/                     Extension icons
Start Flow Credits.command   Double-click launcher
data/                        Legacy tracker files (git-ignored)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| The first sync does nothing / no prompt | macOS needs the Keychain prompt approved. Run **⟳ Sync all** and click **Always Allow**. If you clicked Deny, open **Keychain Access**, find **Chrome Safe Storage**, and allow `node` access. |
| An account failed to sync | Hover its chip for the reason. If Flow opened and asks you to sign in, sign in there and click **Sync all** again. If the profile is missing, sign in to Chrome with that account so the tracker can find its replacement. |
| The dashboard doesn't load | Double-click **Start Flow Credits.command**, or check `data/server.log`. |
| Port 3847 is busy | Start with another port: `PORT=4000 npm start` (the extension expects 3847). |

## Limitations

- macOS and Google Chrome only.
- Flow shows credits only inside its account panel. If Google changes that panel, reading may need an update in `extension/content.js`.
