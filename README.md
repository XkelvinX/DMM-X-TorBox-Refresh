# DMM X TorBox Auto Refresh

A lightweight, privacy-focused userscript for **Debrid Media Manager (DMM)** and **TorBox** that adds native **TRaSH Guides** (`WEB-DL ▾`, `Remux ▾`) and **Dolby Vision** filter chips synchronized across DMM's **Torrents** and **Usenet** tabs, monitors active Torrent & Usenet downloads, and automatically refreshes your TorBox WebDAV server as soon as new media files become available for **Infuse**, **VidHub**, or any WebDAV player.

Built specifically for **iOS Safari (wBlock)** and desktop userscript managers (**Tampermonkey**, **Violentmonkey**).

---

## 🚀 1-Click Install

**[👉 Install DMM X TorBox Auto Refresh (`DMMTorBox-Refresh.user.js`)](https://raw.githubusercontent.com/XkelvinX/DMM-X-TorBox-Refresh/main/DMMTorBox-Refresh.user.js)**

---

## ✨ Key Features

- **TRaSH Guides & Dolby Vision Filter Chips (Torrents + Usenet Sync)**:
  Adds native-styled **`WEB-DL ▾`**, **`Remux ▾`** (with official Radarr/Sonarr TRaSH Guides Tiers 1–2, 1, 2, 3, and 1–3), and **`Dolby Vision`** chips at the start of the DMM filter bar, followed immediately by DMM's native **`TB ✓`** cached filter. Defaults to **`WEB-DL: T1–2` + `Dolby Vision` + `TB ✓`** on load and synchronizes filter changes bidirectionally between the **Torrents** and **Usenet** tabs.
- **Zero-Touch API Key Sync from DMM**:
  If you have already connected your TorBox account in Debrid Media Manager (`localStorage['tb:apiKey']`), the userscript automatically imports your API key on first load, tracks account switches, and shares the key across `debridmediamanager.com` and `torbox.app`.
- **Automatic WebDAV Refresh for Infuse**:
  Tracks both **Torrents** (`/v1/api/torrents/mylist`) and **Usenet** (`/v1/api/usenet/mylist`), accelerating polling to every 3 seconds whenever you send a Torrent or Usenet release from DMM to TorBox. As soon as a new file finishes processing (`download_finished` + `download_present`), the script triggers `https://webdav.torbox.app/refresh` so your WebDAV directory updates immediately.
- **Cross-Tab Coordination & Battery-Friendly Lifecycle**:
  Uses cooperative cross-tab leases so multiple open DMM/TorBox tabs never duplicate API requests or WebDAV refreshes. Runs only while the tab is visible (with a 60-second grace window to finish an already-started cycle when switching apps on iOS).
- **Native DMM Dark UI**:
  Renders a compact, non-intrusive circular floating control positioned cleanly above DMM's native `Refresh library` indicator.

---

## 📱 Setup Guide

### iOS / iPadOS (Safari + wBlock)
1. Install **wBlock** from the App Store and enable the **wBlock Scripts** Safari extension in **Settings → Apps → Safari → Extensions**.
2. Open the **[raw userscript URL](https://raw.githubusercontent.com/XkelvinX/DMM-X-TorBox-Refresh/main/DMMTorBox-Refresh.user.js)** in Safari or add it inside the wBlock app under **Userscripts**.
3. Open **[debridmediamanager.com](https://debridmediamanager.com/)**:
   - If you are already logged into TorBox on DMM, your API key is detected automatically!
   - Otherwise, tap the circular floating button in the bottom-left corner and select **Definir/trocar API key** to paste your TorBox API key.

### Desktop (Chrome / Firefox / Edge / macOS Safari)
1. Install **Tampermonkey** or **Violentmonkey**.
2. Click the **[1-Click Install link](https://raw.githubusercontent.com/XkelvinX/DMM-X-TorBox-Refresh/main/DMMTorBox-Refresh.user.js)** and confirm installation.
3. Visit **[debridmediamanager.com](https://debridmediamanager.com/)** or **[torbox.app](https://torbox.app/)**.

---

## 🟢 Floating Indicator Reference

| Indicator | State | Meaning |
| :--- | :--- | :--- |
| **`+` (Gear/Cross)** | **Configure** | No TorBox API key found yet. Tap to configure or log into TorBox in DMM. |
| **Cloud (Gray)** | **Monitoring** | Active and synced. No pending downloads waiting for WebDAV refresh. |
| **Cloud (Cyan)** | **Busy / Checking** | Checking TorBox lists or refreshing WebDAV. |
| **`1`, `3+`, `?` (White)** | **Pending** | Number of known files currently downloading/processing on TorBox (`+` or `?` means file list is still being enumerated). |
| **`OK` (Green)** | **Synced** | WebDAV was just refreshed after new files became ready (shown for 6 seconds). |
| **Clock (Gray)** | **Waiting / Other Tab** | Respecting the 10s WebDAV cooldown, API rate limit, or another open tab is handling polling. |
| **`\|\|` (Pause)** | **Paused** | Monitoring is paused by the user. Tap to resume. |
| **`!` (Yellow)** | **Warning / Retry** | Temporary network/API issue. Retries automatically with exponential backoff. |
| **`!` (Red)** | **Auth / Plan Error** | Invalid TorBox API key or free TorBox plan (`PLAN_RESTRICTED_FEATURE` has no API/WebDAV access). |

---

## 🔒 Privacy & Security

- **No hardcoded keys or third-party servers**: Your TorBox API key is stored locally inside your userscript manager (`GM_setValue`) and is only sent to `https://api.torbox.app` and `https://webdav.torbox.app`.
- **Sanitized Diagnostics**: The built-in diagnostics viewer (`Ver diagnóstico`) logs only HTTP status codes and response formats—never your API key or media filenames.
