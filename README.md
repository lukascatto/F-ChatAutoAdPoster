# F-Chat Auto-Advertiser

A modern, lightweight, and background-throttling-proof browser extension designed to automate advertisement postings to F-Chat 3.0 channels. It respects client rate-limits, allows custom spacing between posts, and includes a live BBCode preview editor.

---

## Key Features

* **Sequential Auto-Posting**: Spreads out postings to target channels using a configurable Post Delay.
* **Smart Cooldown Handling**: Detects channel-specific native cooldowns (typically 10 minutes) and automatically posts as soon as the timer and the Post Delay expire.
* **Unthrottled Background Execution**: Uses a custom Web Worker scheduler running on a separate OS thread to ensure it ticks precisely every second even when the tab is out of focus, minimized, or you are completely alt-tabbed.
* **No CSP Blocks**: Uses a secure extension iframe wrapper to bypass the website's Content Security Policy (CSP), keeping your browser console completely clear of warnings.
* **In-Place Live UI Updates**: Displays countdown clock badges that tick down smoothly in real time without scroll-jumping or checkbox flickering.
* **Live BBCode Preview**: Displays formatted BBCode in real time with support for nested `[noparse]`, custom colors, character profiles `[user]`, clickable avatars `[icon]`, and emojis `[eicon]` loaded from official assets.
* **Test Mode**: Toggles single-channel selection so you can safely send a single test ad to a channel before starting automation.
* **F-Chat 3.0 Theme & Brand**: Features the official F-Chat desktop client icon and matching dark navy theme variables.

---

## Installation Guide

### For Google Chrome Users

1. **Download the Extension**: Download or clone this repository to a folder on your computer (e.g. `autoposter-extension`).
2. **Open Extensions Page**: Launch Google Chrome, click the three-dot menu, go to **Extensions** > **Manage Extensions** (or type `chrome://extensions/` in the URL bar).
3. **Enable Developer Mode**: Turn **ON** the **Developer mode** toggle in the top-right corner.
4. **Load the Project**: Click the **Load unpacked** button in the top-left corner.
5. **Select Folder**: Browse to and select the `autoposter-extension` (or whatever you'll rename the folder to) folder containing `manifest.json`.

---

### For Mozilla Firefox Users

1. **Download the Extension**: Download or clone this repository to a folder on your computer.
2. **Open Debugging Panel**: Launch Firefox and type `about:debugging` in the address bar.
3. **Select This Firefox**: Click on **This Firefox** in the left sidebar menu.
4. **Load Temporary Add-on**: Click the **Load Temporary Add-on...** button.
5. **Select Manifest File**: Navigate to your extension folder and select the `manifest.json` file. 

*Note: In Firefox, temporarily loaded extensions remain active until you close the browser.*

---

## How to Use

1. Navigate to **[F-Chat 3.0](https://www.f-list.net/chat3/)** and log in to your account.
2. Open the extension popup from your browser's toolbar.
3. Click the **Refresh (🔄)** icon to scan and list all active joined channels:
   * Channels that don't support ads (e.g. chat-only channels) will show `No Ads Tab` and are disabled.
   * Channels currently on cooldown will show an orange timer badge.
4. Select the target channels you want to advertise in.
5. Type your copy inside the **Ad Content** textarea. Click **Show Preview** to test BBCode formatting.
6. Configure the **Post Delay (s)** (minimum 1 second) to space out postings and prevent spam flags.
7. Click the purple **Start Autoposting** button. The button will turn red and the status header badge will change to green `Active`.
8. To stop background posting at any time, simply open the popup and click the red **Stop Autoposting** button.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
