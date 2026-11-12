function isRestrictedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const lower = url.toLowerCase();
  const restrictedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'chrome-untrusted://',
    'chrome-search://',
    'chrome-error://',
    'edge://',
    'about:',
    'view-source:',
    'data:',
    'blob:',
    'devtools:',
    'javascript:',
    'opera:',
    'brave:'
  ];
  if (restrictedPrefixes.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  if (
    lower.includes('chromewebstore.google.com') ||
    lower.includes('chrome.google.com/webstore') ||
    lower.includes('microsoftedge.microsoft.com/addons')
  ) {
    return true;
  }
  return false;
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch((err) => {
      console.warn('Async operation error:', err);
      return fallbackValue;
    }),
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

async function forceDiscardTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error('Tab not found');
  }

  if (tab.discarded) {
    return tab;
  }

  // 1. Remove beforeunload guards and suppress form prompts in MAIN world
  const url = tab.url || '';

  if (!isRestrictedUrl(url) && chrome.scripting) {
    try {
      await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => {
            try {
              window.onbeforeunload = null;
              window.addEventListener(
                'beforeunload',
                (e) => {
                  e.stopImmediatePropagation();
                  delete e.returnValue;
                },
                true
              );
              // Mark fields as saved/default so Chrome form protection is satisfied
              document.querySelectorAll('input, textarea').forEach((el) => {
                try {
                  el.defaultValue = el.value;
                } catch (_) {}
              });
            } catch (_) {}
          }
        }),
        1500,
        null
      );
    } catch (_) {
      // Ignore scripting errors on special or restricted pages
    }
  }

  // 2. If tab is active (which triggers "tab is recently visible"), make it non-active
  if (tab.active) {
    const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    const otherTab = tabsInWindow.find((t) => t.id !== tab.id);
    if (otherTab) {
      await chrome.tabs.update(otherTab.id, { active: true });
    } else {
      // If single tab in window, create a temporary blank tab
      await chrome.tabs.create({ windowId: tab.windowId, active: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // 3. Discard the tab
  return await chrome.tabs.discard(tab.id);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "put-tab-to-sleep",
    title: "Put this tab to sleep",
    contexts: ["tab"]
  });
  chrome.contextMenus.create({
    id: "force-discard-tab",
    title: "Force put this tab to sleep",
    contexts: ["tab"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab && tab.id !== undefined) {
    if (info.menuItemId === "force-discard-tab") {
      try {
        await forceDiscardTab(tab.id);
      } catch (err) {
        console.error('Failed to force discard tab:', err);
      }
    } else if (info.menuItemId === "put-tab-to-sleep") {
      try {
        await chrome.tabs.discard(tab.id);
      } catch (_) {
        // Fall back to force discard if tab is active or edited
        try {
          await forceDiscardTab(tab.id);
        } catch (err) {
          console.error('Failed to put tab to sleep:', err);
        }
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'forceDiscardTab') {
    forceDiscardTab(message.tabId)
      .then((res) => sendResponse({ success: true, tab: res }))
      .catch((err) => sendResponse({ error: err.message || 'Failed to force discard tab' }));
    return true; // Keep message channel open for async response
  }

  if (message.action === 'restartGpuProcess' || message.action === 'terminateProcess') {
    const processId = message.processId;
    if (typeof chrome !== 'undefined' && chrome.processes && typeof chrome.processes.terminate === 'function') {
      try {
        const result = chrome.processes.terminate(processId, (success) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, result: success !== false });
          }
        });
        if (result && typeof result.then === 'function') {
          result
            .then((res) => sendResponse({ success: true, result: res !== false }))
            .catch((err) => sendResponse({ error: err.message || 'Failed to terminate process' }));
        }
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to terminate process' });
      }
    } else {
      sendResponse({ error: 'chrome.processes.terminate is not supported' });
    }
    return true;
  }
});
