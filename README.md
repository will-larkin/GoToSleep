<p align="center">
  <img src="./assets/GoToSleep.gif" alt="Banner" width="500" />
</p>

# GoToSleep

A lightweight Chromium browser extension (Manifest V3) that tracks tab memory usage and puts tabs to sleep to free up system RAM.

Sam Altman stole all my RAM

## Features

- **Memory Monitoring**: Scans open tabs and identifies the top memory-heavy tabs alongside total browser process memory.
- **Tab Discarding**:
  - **Put to Sleep**: Discards tabs using Chrome's native discarding API without losing their URL or history.
  - **Force Discard**: Bypasses `beforeunload` blockers, unsaved form guards, and switches away from active tabs to ensure they can be suspended.
- **Batch Discard**: One-click "Discard Discardable" button to suspend all eligible background tabs at once.
- **Context Menus**: Right-click any tab to immediately put it to sleep or force discard it.
- **GPU Process Support**: Detects high GPU memory consumption and offers process restart capabilities where supported.

## Installation

Since this extension is unpacked:

1. Clone or download this repository.
2. Open your Chromium-based browser (Chrome, Edge, Brave, etc.) with the --enable-experimental-extension-apis flag and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `GoToSleep` root folder.
5. The GoToSleep icon will appear in your extension toolbar.

## Permissions

- `tabs` & `contextMenus`: View open tabs and add right-click sleep actions to tab bars.
- `scripting`: Clear `beforeunload` listeners when force-discarding stubborn tabs.
- `processes`: Read per-tab process memory and provide process management (where Chromium supports the API).
- `<all_urls>`: Inspect and manage tabs across domains.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

