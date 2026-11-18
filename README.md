# Flow Credits

A local macOS dashboard that tracks the **Google Flow credits** of every Google account in your Chrome profiles, and tells you which account to use next before its credits reset.

- Finds your Google accounts from your Chrome profiles: no forms to fill in.
- Syncs every account's balance and reset date automatically in the background.
- Knows the difference between **Google AI Pro** accounts (monthly reset) and **free** accounts (50 credits that refresh daily).
- Recommends which account to use next, so monthly credits don't expire unused.
- Includes a Chrome extension with a toolbar popup showing every account at a glance.

Everything runs on your Mac. No data leaves it.

## Requirements

- macOS
- Google Chrome, with one Google account signed into each Chrome profile you want to track
- Node.js 22.5 or newer (uses the built-in `node:sqlite`)

No `npm install` is needed: there are no dependencies.

## Quick start

1. **Start the server.** Double-click **`Start Flow Credits.command`** (or run `npm start`). The dashboard opens at <http://localhost:3847>.
2. **Add your accounts.** Click **+ Add accounts → Add all**. Accounts are read from your Chrome profiles.
3. **Install the extension in each Chrome profile** (one time, about 20 seconds per profile). Click **Set up extension** in the sync panel, then for each profile:
   1. Click **Open Extensions**. That profile's `chrome://extensions` page opens and the extension folder path is copied.
   2. Turn on **Developer mode** (top right), then click **Load unpacked**.
   3. In the folder picker press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, then <kbd>⌘</kbd><kbd>V</kbd>, <kbd>Return</kbd>, and click **Select**.

   Each profile ticks itself off once Chrome has loaded the extension.
4. **Sync.** Click **⟳ Sync all**. From then on it syncs automatically.

Chrome only runs an extension in the profiles it is installed in, so step 3 is needed once per profile.

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

## How syncing works

1. For each account, the server opens `https://flow.google.com/?fct_sync=1` in a new window of that account's Chrome profile.
2. The extension opens Flow's account panel (your avatar), reads the email, credit balance and "Resets …" / "Credits refresh daily …" line, and sends them to the server.
3. The extension closes that window, plus any empty New Tab window Chrome opened alongside it. Windows with your own tabs stay open.
4. The dashboard and popup update straight away.

Opening Flow yourself in any profile also syncs that account. Profiles without the extension are skipped and shown in the setup banner.

The extension reloads itself whenever its files change, so updates reach every profile automatically after its next sync.

## Data and privacy

- **Database:** account data is stored in `data/flow-credits.db` (SQLite), with an automatic JSON copy in `data/accounts-backup.json`.
- **Settings and log:** auto-sync settings are in `data/settings.json`, and the server log in `data/server.log`.
- **Local only:** the server only listens on `127.0.0.1`, and the extension only talks to `localhost:3847`.
- **What the server reads from Chrome:** the server reads Chrome's `Local State` file to list profiles and their signed-in email, and each profile's preferences file to check whether the extension is installed. It never reads cookies, passwords or browsing data.
- **The `tabs` permission** is used only to find and close the windows opened for a sync.

`data/` is excluded from git.

## Project structure

```
server.js                    HTTP server, SQLite, Chrome profile detection, sync runner, LaunchAgent
public/                      Dashboard (index.html, app.js, styles.css)
extension/                   Chrome extension (Manifest V3)
  content.js                 Reads the Flow account panel
  background.js              Relays readings to the server, closes sync windows, self-updates
  popup.html, popup.js       Toolbar popup
  icons/                     Extension icons
Start Flow Credits.command   Double-click launcher
data/                        Local database, backup, settings, log (git-ignored)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| An account shows "Extension not installed" | Install the extension in that profile via **Set up extension**. |
| An account failed to sync | Hover its chip in the sync panel for the reason. Usually it isn't signed in to Flow in that profile. |
| A sync window didn't close | Reload the extension once in that profile (`chrome://extensions` → ↻). Versions before 2.4 can't update themselves. |
| The dashboard doesn't load | Double-click **Start Flow Credits.command**, or check `data/server.log`. |
| Port 3847 is busy | Start with another port: `PORT=4000 npm start` (the extension expects 3847). |

## Limitations

- macOS and Google Chrome only.
- Flow shows credits only inside its account panel. If Google changes that panel, reading may need an update in `extension/content.js`.
