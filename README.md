# DMM X TorBox Auto Refresh

A lightweight, privacy-focused userscript for **Debrid Media Manager (DMM)** and **TorBox** that sends clean `.nzb` files directly from DMM to TorBox in a single tap, monitors active Torrent & Usenet downloads, and automatically refreshes your TorBox WebDAV server as soon as new media files become available for **Infuse**, **VidHub**, or any WebDAV player.

Built specifically for **iOS Safari (wBlock)** and desktop userscript managers (**Tampermonkey**, **Violentmonkey**).

---

## 🚀 1-Click Install

**[👉 Install DMM X TorBox Auto Refresh (`DMMTorBox-Refresh.user.js`)](https://raw.githubusercontent.com/XkelvinX/DMM-X-TorBox-Refresh/main/DMMTorBox-Refresh.user.js)**

---

## ✨ Key Features

- **1-Tap Clean NZB to TorBox (Zero File Switching on iOS)**:
  When you tap any **NZB** button in DMM's **Usenet** search tab (or on `/anonymize-nzb`), DMM downloads and sanitizes the `.nzb` in memory. This userscript intercepts the cleaned XML before the browser download prompt appears and uploads it directly to `POST /v1/api/usenet/createusenetdownload` (automatically extracting any embedded `<meta type="password">`).
- **Inline Button Feedback & Automatic iOS Fallback**:
  The clicked **NZB** button in DMM highlights in cyan while uploading and turns green (`NZB ✓ TorBox`) once accepted by TorBox. If TorBox is unreachable or returns an error, the script automatically falls back to saving the `.nzb` file locally so you never lose a download.
- **Zero-Touch API Key Sync from DMM**:
  If you have already connected your TorBox account in Debrid Media Manager (`localStorage['tb:apiKey']`), the userscript automatically imports your API key on first load and shares it across `debridmediamanager.com` and `torbox.app`.
- **Automatic WebDAV Refresh for Infuse**:
  Tracks both **Torrents** (`/v1/api/torrents/mylist`) and **Usenet** (`/v1/api/usenet/mylist`). Whenever a new file finishes processing (`download_finished` + `download_present`), the script triggers `https://webdav.torbox.app/refresh` so your WebDAV directory updates immediately.
- **Cross-Tab Coordination & Battery-Friendly Lifecycle**:
  Uses cooperative cross-tab leases so multiple open DMM/TorBox tabs never duplicate API requests or WebDAV refreshes. Runs only while the tab is visible (with a 60-second grace window to finish an already-started cycle when switching apps on iOS).
- **Native DMM 4.0.1 Dark UI**:
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

## 🔄 How the 1-Tap Usenet Workflow Works

1. Search for content in DMM and open the **Usenet** tab.
2. Tap the **NZB** button next to any result:
   - DMM fetches and strips personal headers from the `.nzb`.
   - **DMM X TorBox Auto Refresh** intercepts the sanitized `.nzb` in memory and sends it straight to your TorBox Usenet queue.
   - The row button turns green (`NZB ✓ TorBox`) and the floating indicator switches to fast polling (every 3 seconds).
3. As soon as TorBox finishes downloading and unpacking the Usenet release, the script refreshes `webdav.torbox.app/refresh` and displays **`OK`** in green.
4. Switch to **Infuse** to watch your new media.

---

## 🟢 Floating Indicator Reference

| Indicator | State | Meaning |
| :--- | :--- | :--- |
| **`+` (Gear/Cross)** | **Configure** | No TorBox API key found yet. Tap to configure or log into TorBox in DMM. |
| **Cloud (Gray)** | **Monitoring** | Active and synced. No pending downloads waiting for WebDAV refresh. |
| **Cloud / `…` (Cyan)** | **Busy / Sending NZB** | Uploading a clean `.nzb` to TorBox, checking lists, or refreshing WebDAV. |
| **`1`, `3+`, `?` (White)** | **Pending** | Number of known files currently downloading/processing on TorBox (`+` or `?` means file list is still being enumerated). |
| **`OK` (Green)** | **Synced** | WebDAV was just refreshed after new files became ready (shown for 6 seconds). |
| **Clock (Gray)** | **Waiting / Other Tab** | Respecting the 10s WebDAV cooldown, API rate limit, or another open tab is handling polling. |
| **`\|\|` (Pause)** | **Paused** | Monitoring is paused by the user. Tap to resume. |
| **`!` (Yellow)** | **Warning / Retry** | Temporary network/API issue or NZB fallback triggered. Retries automatically with exponential backoff. |
| **`!` (Red)** | **Auth / Plan Error** | Invalid TorBox API key or free TorBox plan (`PLAN_RESTRICTED_FEATURE` has no API/WebDAV access). |

---

## 🔒 Privacy & Security

- **No hardcoded keys or third-party servers**: Your TorBox API key is stored locally inside your userscript manager (`GM_setValue`) and is only sent to `https://api.torbox.app` and `https://webdav.torbox.app`.
- **Sanitized Diagnostics**: The built-in diagnostics viewer (`Ver diagnóstico`) logs only HTTP status codes and response formats—never your API key or media filenames.
