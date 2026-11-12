const DEFAULT_FAVICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

const MEMORY_FLOOR_BYTES = 100 * 1024 * 1024; // 100 MB floor for tabs
const GPU_MEMORY_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB threshold for GPU restart button
const MAX_TABS_TO_SHOW = 7;
const RECENTLY_VISIBLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes (Chromium grace period)
const SCRIPT_TIMEOUT_MS = 1000; // 1s timeout to prevent hanging on frozen tabs/frames
const PROCESS_TIMEOUT_MS = 1200; // 1.2s timeout for chrome.processes.getProcessInfo
const CONCURRENT_LIMIT = 8; // Max concurrent tabs to process at once

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch((err) => {
      console.warn('Async operation error:', err);
      return fallbackValue;
    }),
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.warn('Concurrent task error:', err);
        results[i] = null;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

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

function formatGigabytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 GB';
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

function getHostName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function restartGpuProcess(processId) {
  if (typeof chrome !== 'undefined' && chrome.processes && typeof chrome.processes.terminate === 'function') {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const callback = (success) => {
        if (resolved) return;
        resolved = true;
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(success !== false);
        }
      };

      try {
        const result = chrome.processes.terminate(processId, callback);
        if (result && typeof result.then === 'function') {
          result
            .then((res) => {
              if (!resolved) {
                resolved = true;
                resolve(res !== false);
              }
            })
            .catch((err) => {
              if (!resolved) {
                resolved = true;
                reject(err);
              }
            });
        }
      } catch (err) {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      }
    });
  }

  // Fallback to background script via runtime message
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'restartGpuProcess', processId }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(true);
        }
      });
    });
  }

  throw new Error('chrome.processes.terminate API is not available.');
}

function createGpuProcessCard(gpuProc, onRestartComplete) {
  const card = document.createElement('li');
  card.className = 'tab-card gpu-card';

  const badge = document.createElement('span');
  badge.className = 'rank-badge gpu-badge';
  badge.textContent = 'GPU';

  const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  iconSvg.setAttribute('class', 'favicon gpu-icon');
  iconSvg.setAttribute('viewBox', '0 0 24 24');
  iconSvg.setAttribute('fill', 'none');
  iconSvg.setAttribute('stroke', '#f59e0b');
  iconSvg.setAttribute('stroke-width', '2');
  iconSvg.setAttribute('stroke-linecap', 'round');
  iconSvg.setAttribute('stroke-linejoin', 'round');
  iconSvg.innerHTML = '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>';

  const infoDiv = document.createElement('div');
  infoDiv.className = 'tab-info';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = 'GPU Process';

  const meta = document.createElement('div');
  meta.className = 'tab-meta';

  const memBadge = document.createElement('span');
  memBadge.className = 'memory-badge gpu-mem-badge';
  memBadge.textContent = formatBytes(gpuProc.memory);

  const host = document.createElement('span');
  host.className = 'tab-host';
  host.textContent = 'Hardware Acceleration';

  const reasonBadge = document.createElement('span');
  reasonBadge.className = 'reason-badge gpu-alert-badge';
  reasonBadge.textContent = '>500 MB';
  reasonBadge.title = 'GPU process memory exceeds 500 MB threshold';

  meta.appendChild(memBadge);
  meta.appendChild(host);
  meta.appendChild(reasonBadge);

  infoDiv.appendChild(title);
  infoDiv.appendChild(meta);

  const restartBtn = document.createElement('button');
  restartBtn.className = 'restart-gpu-btn';
  restartBtn.textContent = 'Restart GPU';
  restartBtn.title = 'Restart GPU process using chrome.processes API';

  restartBtn.addEventListener('click', async () => {
    restartBtn.disabled = true;
    restartBtn.textContent = 'Restarting...';
    try {
      await restartGpuProcess(gpuProc.id);
      showToast('GPU process restarted. Memory freed.');
      if (typeof onRestartComplete === 'function') {
        setTimeout(onRestartComplete, 700);
      }
    } catch (err) {
      restartBtn.disabled = false;
      restartBtn.textContent = 'Restart GPU';
      showToast(`Failed to restart GPU: ${err.message || err}`);
    }
  });

  card.appendChild(badge);
  card.appendChild(iconSvg);
  card.appendChild(infoDiv);
  card.appendChild(restartBtn);

  return card;
}

async function getProcessInfoData() {
  if (typeof chrome === 'undefined' || !chrome.processes || typeof chrome.processes.getProcessInfo !== 'function') {
    return null;
  }

  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn('chrome.processes.getProcessInfo timed out');
        resolve(null);
      }
    }, PROCESS_TIMEOUT_MS);

    const handleProcesses = (processes) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      if (chrome.runtime && chrome.runtime.lastError) {
        console.warn('chrome.processes.getProcessInfo error:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }

      if (!processes) {
        resolve(null);
        return;
      }

      const map = new Map();
      let totalBytes = 0;
      const gpuProcesses = [];

      for (const pid in processes) {
        const proc = processes[pid];
        if (!proc) continue;

        const procId = proc.id !== undefined ? proc.id : parseInt(pid, 10);
        const mem = (typeof proc.privateMemory === 'number' && proc.privateMemory > 0)
          ? proc.privateMemory
          : (proc.jsMemoryAllocated || 0);

        totalBytes += mem;

        const isGpu =
          (proc.type && String(proc.type).toLowerCase() === 'gpu') ||
          (Array.isArray(proc.tasks) && proc.tasks.some((t) => t.title && t.title.toLowerCase().includes('gpu')));

        if (isGpu) {
          gpuProcesses.push({
            id: procId,
            osProcessId: proc.osProcessId,
            memory: mem,
            type: proc.type || 'gpu'
          });
        }

        if (Array.isArray(proc.tasks)) {
          const seenTabsInProc = new Set();
          for (const task of proc.tasks) {
            if (task.tabId !== undefined && task.tabId !== -1 && !seenTabsInProc.has(task.tabId)) {
              seenTabsInProc.add(task.tabId);
              map.set(task.tabId, (map.get(task.tabId) || 0) + mem);
            }
          }
        }
      }

      resolve({ map, totalBytes, gpuProcesses });
    };

    try {
      const result = chrome.processes.getProcessInfo([], true, handleProcesses);
      if (result && typeof result.then === 'function') {
        result.then(handleProcesses).catch((err) => {
          console.warn('getProcessInfo promise rejection:', err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
      }
    } catch (err) {
      console.warn('Failed to call chrome.processes.getProcessInfo:', err);
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

async function getTabMemory(tab) {
  if (!tab || !tab.id || tab.discarded) {
    return 0;
  }

  const url = tab.url || '';
  if (isRestrictedUrl(url) || tab.status === 'loading') {
    return 0;
  }

  if (typeof chrome === 'undefined' || !chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    return 0;
  }

  try {
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          if (typeof performance === 'undefined' || !performance.memory) {
            return 0;
          }
          return Math.max(
            performance.memory.totalJSHeapSize || 0,
            performance.memory.usedJSHeapSize || 0
          );
        } catch (_) {
          return 0;
        }
      }
    });

    const results = await withTimeout(scriptPromise, SCRIPT_TIMEOUT_MS, null);
    if (Array.isArray(results) && results[0] && typeof results[0].result === 'number') {
      return results[0].result;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Checks for Chromium "is discardable" restriction reasons:
 * 1. "tab is recently visible" (active or focused within grace period)
 * 2. "the user has edited the tab's content" (form inputs modified or beforeunload guard)
 */
async function checkTabDiscardReasons(tab) {
  const reasons = [];

  if (!tab || !tab.id || tab.discarded) {
    return reasons;
  }

  // 1. "tab is recently visible"
  const isRecentlyVisible =
    tab.active ||
    (tab.lastAccessed && Date.now() - tab.lastAccessed < RECENTLY_VISIBLE_THRESHOLD_MS);

  if (isRecentlyVisible) {
    reasons.push('tab is recently visible');
  }

  // 2. "the user has edited the tab's content"
  const url = tab.url || '';
  if (isRestrictedUrl(url) || tab.status === 'loading') {
    return reasons;
  }

  if (typeof chrome === 'undefined' || !chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    return reasons;
  }

  try {
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          // Check for beforeunload handler
          if (typeof window.onbeforeunload === 'function') {
            return true;
          }

          // Check for form inputs or textareas edited away from defaults
          const inputs = document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select, [contenteditable="true"]'
          );
          for (const el of inputs) {
            if (el.tagName === 'TEXTAREA') {
              if (el.value !== el.defaultValue) return true;
            } else if (el.tagName === 'SELECT') {
              for (const opt of el.options) {
                if (opt.selected !== opt.defaultSelected) return true;
              }
            } else if (el.tagName === 'INPUT') {
              if (el.type === 'checkbox' || el.type === 'radio') {
                if (el.checked !== el.defaultChecked) return true;
              } else if (el.value !== el.defaultValue) {
                return true;
              }
            } else if (el.isContentEditable) {
              if (el.innerText && el.innerText.trim().length > 0) return true;
            }
          }
          return false;
        } catch (_) {
          return false;
        }
      }
    });

    const results = await withTimeout(scriptPromise, SCRIPT_TIMEOUT_MS, null);
    if (results && results[0] && results[0].result === true) {
      reasons.push("the user has edited the tab's content");
    }
  } catch (_) {
    // Ignore scripting failures on protected pages
  }

  return reasons;
}

async function loadTopTabs() {
  const loading = document.getElementById('loading');
  const tabList = document.getElementById('tab-list');
  const emptyState = document.getElementById('empty');
  const summary = document.getElementById('tabs-summary');
  const refreshBtn = document.getElementById('refresh-btn');
  const totalMemoryEl = document.getElementById('total-memory-value');
  const discardAllBtn = document.getElementById('discard-all-btn');
  const overviewLabelEl = document.getElementById('overview-label');
  const overviewHintEl = document.getElementById('overview-hint');

  loading.style.display = 'flex';
  tabList.innerHTML = '';
  emptyState.style.display = 'none';
  refreshBtn.disabled = true;
  if (discardAllBtn) {
    discardAllBtn.disabled = true;
  }

  try {
    const tabs = await withTimeout(chrome.tabs.query({}), 2000, []);
    if (!tabs || tabs.length === 0) {
      emptyState.textContent = 'No open tabs found.';
      emptyState.style.display = 'block';
      summary.textContent = '0 open tabs';
      if (totalMemoryEl) totalMemoryEl.textContent = '0.00 GB';
      if (discardAllBtn) {
        discardAllBtn.textContent = 'Discard Discardable (0)';
        discardAllBtn.disabled = true;
      }
      return;
    }

    const processInfo = await getProcessInfoData();

    const tabsWithMemory = await mapConcurrent(tabs, CONCURRENT_LIMIT, async (tab) => {
      let memory = 0;
      if (processInfo && processInfo.map && processInfo.map.has(tab.id)) {
        memory = processInfo.map.get(tab.id);
      } else {
        memory = await getTabMemory(tab);
      }
      return {
        ...tab,
        memory
      };
    });

    // Calculate total memory using processes API (or fallback to tab heap)
    let totalBrowserBytes = 0;
    if (processInfo && typeof processInfo.totalBytes === 'number' && processInfo.totalBytes > 0) {
      totalBrowserBytes = processInfo.totalBytes;
      if (overviewLabelEl) overviewLabelEl.textContent = 'Total Memory';
      if (overviewHintEl) overviewHintEl.textContent = 'All browser processes (processes API)';
    } else {
      totalBrowserBytes = tabsWithMemory.reduce((sum, tab) => sum + (tab.memory || 0), 0);
      if (overviewLabelEl) overviewLabelEl.textContent = 'Tab Memory';
      if (overviewHintEl) overviewHintEl.textContent = 'Processes API unavailable; tab heap only';
    }
    if (totalMemoryEl) {
      totalMemoryEl.textContent = formatBytes(totalBrowserBytes);
    }

    // Inspect discard reasons for tabs
    const tabsWithReasons = await mapConcurrent(tabsWithMemory, CONCURRENT_LIMIT, async (tab) => {
      const discardReasons = await checkTabDiscardReasons(tab);
      return {
        ...tab,
        discardReasons
      };
    });

    // Identify all tabs that are discardable without requiring force discard:
    // (not sleeping, not active, and no discard restriction reasons)
    const discardableTabs = tabsWithReasons.filter(
      (tab) => !tab.discarded && !tab.active && (!tab.discardReasons || tab.discardReasons.length === 0)
    );

    if (discardAllBtn) {
      discardAllBtn.textContent = `Discard Discardable (${discardableTabs.length})`;
      discardAllBtn.disabled = discardableTabs.length === 0;
      discardAllBtn.onclick = async () => {
        discardAllBtn.disabled = true;
        discardAllBtn.textContent = 'Discarding...';
        let count = 0;
        for (const tab of discardableTabs) {
          try {
            await chrome.tabs.discard(tab.id);
            count++;
          } catch (err) {
            console.warn(`Failed to discard tab ${tab.id}:`, err);
          }
        }
        showToast(`Discarded ${count} tab${count === 1 ? '' : 's'}.`);
        await loadTopTabs();
      };
    }

    // Check for GPU processes exceeding 500 MB
    const highMemGpuProcesses = (processInfo && Array.isArray(processInfo.gpuProcesses))
      ? processInfo.gpuProcesses.filter((p) => p.memory > GPU_MEMORY_THRESHOLD_BYTES)
      : [];

    // Apply the 100 MB floor and sort descending
    const qualifyingTabs = tabsWithReasons
      .filter((tab) => tab.memory >= MEMORY_FLOOR_BYTES)
      .sort((a, b) => b.memory - a.memory);

    // Show at most the top 7
    const topTabs = qualifyingTabs.slice(0, MAX_TABS_TO_SHOW);

    if (topTabs.length === 0 && highMemGpuProcesses.length === 0) {
      emptyState.textContent = 'No tabs currently consuming over 100 MB.';
      emptyState.style.display = 'block';
      summary.textContent = 'Floor: 100 MB (0 above threshold)';
      return;
    }

    if (highMemGpuProcesses.length > 0 && topTabs.length > 0) {
      summary.textContent = `GPU > 500 MB • ${topTabs.length} tab${topTabs.length === 1 ? '' : 's'} consuming over 100 MB`;
    } else if (highMemGpuProcesses.length > 0) {
      summary.textContent = `GPU process consuming > 500 MB`;
    } else {
      summary.textContent = `${topTabs.length} tab${topTabs.length === 1 ? '' : 's'} consuming over 100 MB`;
    }

    // Render GPU process restart card(s) in the list if memory > 500 MB
    highMemGpuProcesses.forEach((gpuProc) => {
      tabList.appendChild(createGpuProcessCard(gpuProc, loadTopTabs));
    });

    topTabs.forEach((tab, index) => {
      const card = document.createElement('li');
      card.className = 'tab-card';

      const rank = document.createElement('span');
      rank.className = 'rank-badge';
      rank.textContent = `#${index + 1}`;

      const favicon = document.createElement('img');
      favicon.className = 'favicon';
      favicon.src = tab.favIconUrl || DEFAULT_FAVICON;
      favicon.onerror = () => {
        favicon.src = DEFAULT_FAVICON;
      };

      const infoDiv = document.createElement('div');
      infoDiv.className = 'tab-info';

      const title = document.createElement('div');
      title.className = 'tab-title';
      title.textContent = tab.title || tab.url || 'Untitled Tab';
      title.title = tab.title || tab.url || 'Untitled Tab';

      const meta = document.createElement('div');
      meta.className = 'tab-meta';

      const memBadge = document.createElement('span');
      memBadge.className = 'memory-badge';
      if (tab.discarded) {
        memBadge.textContent = '0 MB (Sleeping)';
        memBadge.classList.add('sleeping-badge');
      } else {
        memBadge.textContent = formatBytes(tab.memory);
      }

      const host = document.createElement('span');
      host.className = 'tab-host';
      host.textContent = getHostName(tab.url);

      meta.appendChild(memBadge);
      if (host.textContent) {
        meta.appendChild(host);
      }

      // If tab has discard restrictions, show a badge explaining the reason
      let reasonBadge = null;
      if (tab.discardReasons && tab.discardReasons.length > 0) {
        reasonBadge = document.createElement('span');
        reasonBadge.className = 'reason-badge';
        const hasEdits = tab.discardReasons.includes("the user has edited the tab's content");
        const isRecent = tab.discardReasons.includes("tab is recently visible");

        if (hasEdits && isRecent) {
          reasonBadge.textContent = 'Edited • Recent';
        } else if (hasEdits) {
          reasonBadge.textContent = 'Edited content';
        } else {
          reasonBadge.textContent = 'Recently visible';
        }
        reasonBadge.title = `Is discardable reasons: ${tab.discardReasons.join(', ')}`;
        meta.appendChild(reasonBadge);
      }

      infoDiv.appendChild(title);
      infoDiv.appendChild(meta);

      const discardBtn = document.createElement('button');
      discardBtn.className = 'discard-btn';

      if (tab.discarded) {
        discardBtn.textContent = 'Sleeping';
        discardBtn.disabled = true;
        discardBtn.classList.add('discarded');
      } else {
        const needsForceDiscard = tab.discardReasons && tab.discardReasons.length > 0;

        if (needsForceDiscard) {
          // Red button for tabs with "tab is recently visible" or "the user has edited the tab's content"
          discardBtn.textContent = 'Force Discard';
          discardBtn.classList.add('force-btn');
          discardBtn.title = `Force discard tab (reasons: ${tab.discardReasons.join(', ')})`;
        } else {
          // Normal blue button for standard discardable tabs
          discardBtn.textContent = 'Discard';
        }

        discardBtn.addEventListener('click', async () => {
          discardBtn.disabled = true;
          discardBtn.textContent = 'Discarding...';

          if (discardBtn.classList.contains('force-btn')) {
            // Execute Force Discard via background worker
            try {
              const res = await chrome.runtime.sendMessage({
                action: 'forceDiscardTab',
                tabId: tab.id
              });

              if (res && res.error) {
                throw new Error(res.error);
              }

              discardBtn.textContent = 'Sleeping';
              discardBtn.classList.add('discarded');
              discardBtn.classList.remove('force-btn');
              memBadge.textContent = '0 MB (Sleeping)';
              memBadge.classList.add('sleeping-badge');
              if (reasonBadge) {
                reasonBadge.remove();
              }
            } catch (err) {
              discardBtn.disabled = false;
              discardBtn.textContent = 'Force Discard';
              showToast(err.message || 'Failed to force discard tab.');
            }
          } else {
            // Normal blue discard
            try {
              await chrome.tabs.discard(tab.id);
              discardBtn.textContent = 'Sleeping';
              discardBtn.classList.add('discarded');
              memBadge.textContent = '0 MB (Sleeping)';
              memBadge.classList.add('sleeping-badge');
            } catch (err) {
              // If standard discard fails, automatically upgrade button to Force Discard (red)
              discardBtn.disabled = false;
              discardBtn.textContent = 'Force Discard';
              discardBtn.classList.add('force-btn');
              showToast(`Normal discard blocked (${err.message || 'tab not discardable'}). Use Force Discard.`);
            }
          }
        });
      }

      card.appendChild(rank);
      card.appendChild(favicon);
      card.appendChild(infoDiv);
      card.appendChild(discardBtn);

      tabList.appendChild(card);
    });
  } catch (err) {
    showToast('Failed to load tabs: ' + (err.message || err));
  } finally {
    loading.style.display = 'none';
    refreshBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadTopTabs();
  document.getElementById('refresh-btn').addEventListener('click', loadTopTabs);
});
