/**
 * Super Tool - Background Service Worker
 * Manages state and communication between popup and content scripts
 */

import {icons as iconMap, imageDataFromDataUriWorker} from './icons.js';

let clickTimers = 0;
let timerCallback;
const windowMap = {};
const windowActiveTabMap = {};
const tabUrlMap = {};
const tabMap = {};
const dupeMap = {};

// Preload icon image data
const iconImageData = {};
const iconImageDataReady = (async () => {
  for (const [tool, dataUri] of Object.entries(iconMap)) {
    iconImageData[tool] = await imageDataFromDataUriWorker(dataUri);
  }
  // Generate group-control icon: three colored bars on a dark rounded background
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1e1e2e';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, 16);
  ctx.fill();
  for (const [i, color] of ['#4688f1', '#3dba4e', '#e8453c'].entries()) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(12, 18 + i * 34, 104, 22, 5);
    ctx.fill();
  }
  iconImageData['group-control'] = ctx.getImageData(0, 0, size, size);
})();

globalThis = {
  ...globalThis,
  windowMap,
  tabUrlMap,
  tabMap,
  dupeMap,
  iconImageData,
  windowActiveTabMap
};

// onActivated, onAttahed, onCreated, onRemoved
chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log('activated');
  windowActiveTabMap[activeInfo.windowId] = activeInfo.tabId;
  updateBadge(activeInfo.windowId);
});
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  console.log('attached');
  addTab(tabId, attachInfo.newWindowId);
});
chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  console.log('detached');
  removeTab(tabId, detachInfo.oldWindowId);
});
chrome.tabs.onCreated.addListener((tab) => {
  console.log('created');
  // tab object not fully initialized yet; url may be missing
  addTab(tab.id, tab.windowId, true);
  // update badge because active tab is not guaranteed to change
  updateBadge(tab.windowId);
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log('removed');
  removeTab(tabId, removeInfo.windowId, true);
  // update badge because active tab is not guaranteed to change (do not update
  // if the removed tab is the active tab)
  if (windowActiveTabMap[removeInfo.windowId] !== tabId)
    updateBadge(removeInfo.windowId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  console.log('updated');
  updateTab(changeInfo.url, tab.url, tabId);
  updateBadge(tab.windowId);
  // console.dir(`tab:${tabId} changeInfo: ${JSON.stringify(changeInfo)}`);
});
chrome.windows.onRemoved.addListener((windowId) => {
  console.log('window removed');
  delete windowMap[windowId];
  delete windowActiveTabMap[windowId];
  delete initializationTable[windowId];
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  console.log('window focus changed');
  // Update badge for the active tab in the focused window
  ///* temporarily till the double count bug fixed
  if (windowId && windowId !== chrome.windows.WINDOW_ID_NONE) {
    if (!windowActiveTabMap[windowId] || !windowMap[windowId]) {
      try {
        await initializeWindow(windowId);
      } catch (error) {
        console.warn(`Failed to initialize focused window ${windowId}:`, error);
        return;
      }
    }
    updateBadge(windowId);
  }  //*/
});

// Initialize with default tool on first install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['activeTool'], (result) => {
    if (!result.activeTool) {
      chrome.storage.local.set({activeTool: 'urls-manager'});
      console.log('Super Tool: Initialized with default tool: urls-manager');
    }
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  // If this is the second click within 300ms, treat as double-click
  if (clickTimers && Date.now() - clickTimers < 300) {
    clearTimeout(timerCallback);
    let activeTool = await chrome.storage.local.get(['activeTool'])
                         .then(result => result.activeTool) ||
        'urls-manager';
    handleToolActivation(activeTool);
    clickTimers = 0;
    return;
  }

  // Record this click time
  clickTimers = Date.now();

  // Set timer for single click
  timerCallback = setTimeout(() => {
    chrome.action.setPopup({popup: 'popup.html'});
    // Open the popup when the extension icon is clicked
    chrome.action.openPopup();
    // remove popup to allow re-click
    chrome.action.setPopup({popup: ''});
  }, 300);
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'setActiveTool') {
    // Update the active tool
    chrome.storage.local.set({activeTool: request.tool}, () => {
      console.log(`Super Tool: Active tool changed to ${request.tool}`);
      sendResponse({success: true});
    });
    return true;  // Keep the message channel open for async response
  }

  if (request.action === 'getActiveTool') {
    chrome.storage.local.get(['activeTool'], (result) => {
      sendResponse({activeTool: result.activeTool || 'urls-manager'});
    });
    return true;  // Keep the message channel open for async response
  }

  if (request.action === 'activateTool') {
    handleToolActivation(request.tool);
    sendResponse({success: true});
    return true;
  }

  if (request.action === 'openUrls') {
    openUrlsJob(request.windows).then(sendResponse);
    return true;  // Keep the message channel open for async response
  }
});

// Initial setup
(async () => {
  console.log('Super Tool: Background service worker initialized');
  setIcon('default');
  const windowId = await initializeWindow();
  updateBadge(windowId);
})();

function addHelper(url, tabId) {
  if (!url) return;
  if (tabMap[url]) {
    dupeMap[url] = [...(dupeMap[url] || []), tabId];
  } else {
    tabMap[url] = true;
  }
  // set or update the url for this tab
  tabUrlMap[tabId] = url;
}
async function addTab(tabId, windowId, added = false, initUrl = null) {
  if (!windowMap[windowId]) {
    windowMap[windowId] = 0;
  }
  windowMap[windowId] += 1;

  if (added) {
    try {
      const url = initUrl || (await chrome.tabs.get(tabId)).url;
      addHelper(url, tabId);
    } catch (error) {
      console.error(`Failed to get tab ${tabId}:`, error);
    }
  }
}

function removeHelper(url, tabId) {
  if (!url) return;
  if (dupeMap[url]) {
    dupeMap[url] = dupeMap[url].filter(id => id !== tabId);
    if (dupeMap[url].length === 0) {
      delete dupeMap[url];
    }
  } else {
    delete tabMap[url];
  }
}
async function removeTab(tabId, windowId, removed = false) {
  if (windowMap[windowId]) {
    windowMap[windowId] -= 1;

    if (removed) {
      removeHelper((tabUrlMap[tabId]), tabId);
      // remove tab from tabUrlMap, this is not done in updateTab since it still
      // exists
      delete tabUrlMap[tabId];
    }
  }
}

function updateTab(oldUrl, newUrl, tabId) {
  if (oldUrl && newUrl && oldUrl !== newUrl) {
    removeHelper(oldUrl, tabId);
    addHelper(newUrl, tabId);
  }
}

const initializationTable = {};

async function initializeWindow(initWinId) {
  let windowId = initWinId;
  if (!windowId) {
    windowId =
        (await chrome.windows.getLastFocused({windowTypes: ['normal']})).id;
  }

  if (initializationTable[windowId]) {
    console.log(`window ${windowId} already initialized, skipping`);
    return windowId;
  }

  // Lock immediately to avoid duplicate initialization from rapid focus events.
  initializationTable[windowId] = true;

  let activeTab = windowActiveTabMap[windowId];

  if (!windowMap[windowId]) {
    let windowTabs = [];
    try {
      windowTabs = await chrome.tabs.query({windowId: windowId});
    } catch (error) {
      // The window may have been closed between focus change and query.
      delete initializationTable[windowId];
      throw error;
    }
    console.log(`initialized window ${windowId} (${initWinId}) with ${
        windowTabs.length} tabs`);

    // Set count directly from query result to avoid double-counting with
    // onCreated events that may have already incremented windowMap during the
    // async query. Only call addHelper (not addTab) for URL tracking, and skip
    // tabs already tracked by racing event handlers.
    windowMap[windowId] = 0;
    for (const tab of windowTabs) {
      if (!activeTab && tab.active) {
        activeTab = tab.id;
        windowActiveTabMap[tab.windowId] = activeTab;
      }
      windowMap[tab.windowId] = (windowMap[tab.windowId] || 0) + 1;
      if (!tabUrlMap[tab.id]) {
        addHelper(tab.url, tab.id);
      }
    }
  } else {
    if (!activeTab) {
      try {
        const [tab] =
            await chrome.tabs.query({windowId: windowId, active: true});
        if (tab?.id) {
          windowActiveTabMap[windowId] = tab.id;
        }
      } catch (error) {
        console.warn(
            `Failed to refresh active tab for window ${windowId}:`, error);
      }
    }
    console.log(`initialized window ${windowId} (${
        initWinId}) already tracked with ${windowMap[windowId]} tabs`);
  }
  return windowId;
}

async function updateBadge(windowId) {
  let activeTab = windowActiveTabMap[windowId];
  let windowCount = windowMap[windowId];
  if (activeTab && windowCount) {
    chrome.action.setBadgeText(
        {text: `${windowCount || ''}`, tabId: activeTab});
    chrome.action.setBadgeBackgroundColor({
      color: Object.keys(dupeMap).length ? '#FF4444' : '#4444FF',
      tabId: activeTab
    });
  }
}

let badgeFlashTimer = null;

// Temporarily overrides the per-window count badge with the removal tally.
// If the service worker is torn down before the restore fires, the next tab
// event calls updateBadge anyway.
function flashRemovalBadge(count) {
  if (badgeFlashTimer) clearTimeout(badgeFlashTimer);
  const windowIds = Object.keys(windowActiveTabMap);
  for (const windowId of windowIds) {
    const tabId = windowActiveTabMap[windowId];
    if (!tabId) continue;
    chrome.action.setBadgeText({text: `-${count}`, tabId});
    chrome.action.setBadgeBackgroundColor({color: '#FF8800', tabId});
  }
  badgeFlashTimer = setTimeout(() => {
    badgeFlashTimer = null;
    for (const windowId of windowIds) updateBadge(Number(windowId));
  }, 2500);
}

function notifyRemoval(count, pinnedDupesKept) {
  let message =
      count ? `Removed ${count} duplicate tab${count === 1 ? '' : 's'}.` :
              'No duplicate tabs found.';
  if (pinnedDupesKept) {
    message += ` ${pinnedDupesKept} pinned duplicate${
        pinnedDupesKept === 1 ? '' : 's'} left in place.`;
  }
  chrome.notifications.create({
    type: 'basic',
    title: 'SuperChrome',
    iconUrl: iconMap['remove-dupes'],
    message
  });
}

async function setIcon(tool) {
  await iconImageDataReady;
  const imageData = iconImageData[tool] || iconImageData['default'];
  if (!imageData) return;
  chrome.action.setIcon({imageData});
}

function handleToolActivation(tool) {
  // Handle tool activation
  console.log(`Super Tool: Activating tool ${tool}`);

  setIcon(tool);
  // Tool-specific activation logic will be implemented here
  switch (tool) {
    case 'urls-manager':
      activateUrlsManager();
      break;
    case 'remove-dupes':
      activateRemoveDupes();
      break;
    case 'partition-tabs':
      activatePartitionTabs();
      break;
    case 'memory-manager':
      activateMemoryManager();
      break;
    case 'group-control':
      activateGroupControlPanel();
      break;
  }
}

// Tool activation functions (placeholder implementations)
async function activateUrlsManager() {
  console.log('URLs Manager tool activated');
  chrome.action.setPopup({popup: 'urls-dialog.html'});
  chrome.action.openPopup();
  chrome.action.setPopup({popup: ''});
}

// Survivor precedence within a set of exact-URL duplicates, most significant
// first. Higher score wins. groupId is compared against -1 rather than
// chrome.tabGroups.TAB_GROUP_ID_NONE so this doesn't depend on the tabGroups
// namespace being live in the worker.
function survivorScore(tab, windowTabCounts) {
  return [
    tab.active ? 1 : 0,
    tab.groupId > -1 ? 1 : 0,
    tab.id,                          // ids are monotonic: higher = newer
    -(windowTabCounts[tab.windowId] || 0),  // fewer tabs in window wins
  ];
}

async function activateRemoveDupes() {
  let duplicatesRemoved = 0;
  let pinnedDupesKept = 0;
  console.log('Remove Duplicates tool activated');

  const allTabs = await chrome.tabs.query({});

  // Snapshot window sizes up front so the tiebreaker stays stable as tabs are
  // removed.
  const windowTabCounts = {};
  for (const tab of allTabs) {
    windowTabCounts[tab.windowId] = (windowTabCounts[tab.windowId] || 0) + 1;
  }

  // pendingUrl covers tabs still loading or discarded, which report an empty
  // url and used to be skipped entirely.
  const byUrl = new Map();
  for (const tab of allTabs) {
    const url = (tab.url || tab.pendingUrl || '').trim();
    if (!url) continue;
    byUrl.set(url, [...(byUrl.get(url) || []), tab]);
  }

  const dupeTabs = [];
  for (const tabs of byUrl.values()) {
    if (tabs.length < 2) continue;

    const pinned = tabs.filter(tab => tab.pinned);
    if (pinned.length) {
      // Pinned tabs are never removed, so a URL pinned more than once keeps
      // more than one instance.
      if (pinned.length > 1) pinnedDupesKept += pinned.length - 1;
      for (const tab of tabs) {
        if (!tab.pinned) dupeTabs.push(tab.id);
      }
      continue;
    }

    const ranked = [...tabs].sort((a, b) => {
      const scoreA = survivorScore(a, windowTabCounts);
      const scoreB = survivorScore(b, windowTabCounts);
      for (let i = 0; i < scoreA.length; i++) {
        if (scoreA[i] !== scoreB[i]) return scoreB[i] - scoreA[i];
      }
      return 0;
    });
    for (const tab of ranked.slice(1)) dupeTabs.push(tab.id);
  }

  console.log(`Duplicate tabs to remove: ${dupeTabs}`);
  for (const tabId of dupeTabs) {
    try {
      await chrome.tabs.remove(tabId);
      duplicatesRemoved++;
    } catch (error) {
      console.error(`Failed to remove tab ${tabId}:`, error);
    }
  }

  // Rebuild duplicate tracking after removals to keep badge color accurate.
  const remainingTabs = await chrome.tabs.query({});
  for (const key of Object.keys(tabMap)) delete tabMap[key];
  for (const key of Object.keys(dupeMap)) delete dupeMap[key];
  for (const key of Object.keys(tabUrlMap)) delete tabUrlMap[key];
  for (const tab of remainingTabs) {
    addHelper(tab.url, tab.id);
  }

  for (const windowId of Object.keys(windowActiveTabMap)) {
    updateBadge(Number(windowId));
  }

  console.log(
      `Removed ${duplicatesRemoved} of ${dupeTabs.length} duplicate tabs.`);

  flashRemovalBadge(duplicatesRemoved);
  notifyRemoval(duplicatesRemoved, pinnedDupesKept);
}

function activatePartitionTabs() {
  console.log('Partition Tabs tool activated');
  // simple partition: move half of tabs to a new window
  chrome.windows.getLastFocused({populate: true}).then((currentWindow) => {
    const isIncognito = currentWindow.incognito;
    const tabs = currentWindow.tabs || [];
    const half = Math.floor(tabs.length / 2);
    const tabsToMove = tabs.slice(0, half).map(tab => tab.id);
    if (tabsToMove.length > 0) {
      chrome.windows.create({tabId: tabsToMove[0], incognito: isIncognito})
          .then((newWindow) => {
            if (tabsToMove.length > 1) {
              chrome.tabs.move(
                  tabsToMove.slice(1), {windowId: newWindow.id, index: -1});
            }
          });
    }
  });
  // TODO: Implement full partition-tabs functionality
}

function activateMemoryManager() {
  console.log('Memory Manager tool activated');
  // TODO: Implement memory-manager functionality
}

async function activateGroupControlPanel() {
  console.log('Group Control Panel activated');
  chrome.action.setPopup({popup: 'groups-dialog.html'});
  chrome.action.openPopup();
  chrome.action.setPopup({popup: ''});
}

// --- Open URLs (URL manager "Open") -------------------------------------------
//
// Opening a large export at once loads every page together. Instead the first
// batch loads normally, and every later tab is opened one at a time and
// discarded as soon as Chrome has its URL. A batch ends when all its tabs are
// done or OPEN_BATCH_TIMEOUT_MS has passed, whichever comes first; tabs a
// batch didn't reach in time roll into the next one.

const OPEN_BATCH_SIZE = 10;
const OPEN_BATCH_TIMEOUT_MS = 5000;

/**
 * `windowBlocks` is the URL manager's parsed export: one array of items per
 * window, each item `{type: 'tab', url}` or `{type: 'group', urls, title,
 * color}`. Block 0 opens in the last focused window, the rest in new windows.
 */
async function openUrlsJob(windowBlocks) {
  const tasks = [];
  windowBlocks.forEach((items, windowIndex) => {
    for (const item of items) {
      if (item.type === 'tab') {
        tasks.push({windowIndex, url: item.url, group: null});
      } else if (item.type === 'group') {
        for (const url of item.urls) {
          tasks.push({windowIndex, url, group: item});
        }
      }
    }
  });

  const job = {
    windowIds: {},
    placeholderTabIds: {},
    groupIds: new Map(),
    opened: 0,
    loaded: 0,
    suspended: 0,
    unsuspended: 0,
    failedToOpen: 0
  };

  // First batch: open them all, then wait for them to finish loading.
  let next = 0;
  let deadline = Date.now() + OPEN_BATCH_TIMEOUT_MS;
  const loads = [];
  while (next < tasks.length && next < OPEN_BATCH_SIZE) {
    const tab = await openTask(job, tasks[next++]);
    if (!tab) continue;
    job.loaded++;
    loads.push(waitForTab(tab.id, isTabLoaded, deadline));
  }
  await Promise.all(loads);

  // Later batches: open one tab, discard it, then open the next.
  while (next < tasks.length) {
    deadline = Date.now() + OPEN_BATCH_TIMEOUT_MS;
    const end = Math.min(next + OPEN_BATCH_SIZE, tasks.length);

    while (next < end && Date.now() < deadline) {
      const tab = await openTask(job, tasks[next++]);
      if (!tab) continue;

      // A new window's first tab is made active, and Chrome won't discard the
      // active tab, so it's left to load.
      if (tab.active) {
        job.loaded++;
        continue;
      }

      if (await suspendWhenCommitted(tab.id, deadline)) {
        job.suspended++;
      } else {
        job.unsuspended++;
      }
    }
  }

  const result = summarizeOpenJob(job);
  notifyOpenResult(result.message);
  return result;
}

/** Create one task's tab, its window if needed, and its group membership. */
async function openTask(job, task) {
  try {
    const windowId = await windowForTask(job, task.windowIndex);
    const tab =
        await chrome.tabs.create({windowId, url: task.url, active: false});
    job.opened++;

    // A new window starts with an about:blank tab. Activate the first real
    // tab before removing it, or Chrome would pick a neighbour to activate,
    // possibly one already discarded, which would reload it.
    const placeholderTabId = job.placeholderTabIds[task.windowIndex];
    if (placeholderTabId) {
      delete job.placeholderTabIds[task.windowIndex];
      await chrome.tabs.update(tab.id, {active: true});
      tab.active = true;
      await chrome.tabs.remove(placeholderTabId).catch(() => {});
    }

    if (task.group) {
      await addTabToGroup(job, task.group, tab.id, windowId);
    }
    return tab;
  } catch (error) {
    console.error('Super Tool: Failed to open URL', task.url, error);
    job.failedToOpen++;
    return null;
  }
}

// Windows are created when their first tab is reached, so a block whose tabs
// all fail to parse never leaves an empty window behind.
async function windowForTask(job, windowIndex) {
  if (job.windowIds[windowIndex] !== undefined) {
    return job.windowIds[windowIndex];
  }

  if (windowIndex === 0) {
    try {
      const current =
          await chrome.windows.getLastFocused({windowTypes: ['normal']});
      job.windowIds[0] = current.id;
      return current.id;
    } catch (error) {
      // No normal window open; fall through and create one.
    }
  }

  const newWindow =
      await chrome.windows.create({url: 'about:blank', focused: false});
  job.windowIds[windowIndex] = newWindow.id;
  job.placeholderTabIds[windowIndex] = newWindow.tabs?.[0]?.id || null;
  return newWindow.id;
}

// A group's tabs can span batches, so the group is created with its first tab
// and later tabs join it by id.
async function addTabToGroup(job, group, tabId, windowId) {
  const groupId = job.groupIds.get(group);
  if (groupId !== undefined) {
    await chrome.tabs.group({groupId, tabIds: [tabId]});
    return;
  }

  // Without an explicit windowId the group is created in the focused window,
  // which would pull the tab out of a background window.
  const newGroupId =
      await chrome.tabs.group({tabIds: [tabId], createProperties: {windowId}});
  job.groupIds.set(group, newGroupId);

  const updateProperties = {};
  if (group.title) updateProperties.title = group.title;
  if (group.color) updateProperties.color = group.color;
  if (Object.keys(updateProperties).length > 0) {
    await chrome.tabGroups.update(newGroupId, updateProperties);
  }
}

/**
 * Discard a freshly created tab once Chrome has committed its URL. Discarding
 * before that can leave a blank tab that restores to nothing. If `deadline`
 * passes first, the discard is tried anyway. Resolves true on success.
 */
async function suspendWhenCommitted(tabId, deadline) {
  try {
    await waitForTab(tabId, isTabUrlCommitted, deadline);
    await chrome.tabs.discard(tabId);
    return true;
  } catch (error) {
    return false;
  }
}

// While a navigation is pending Chrome reports it in pendingUrl, and url is
// empty or still the previous document.
function isTabUrlCommitted(tab) {
  return Boolean(tab.url) && !tab.pendingUrl;
}

function isTabLoaded(tab) {
  return tab.status === 'complete';
}

/** Resolve once `test(tab)` holds, the tab is gone, or `deadline` passes. */
function waitForTab(tabId, test, deadline) {
  return new Promise((resolve) => {
    let timer = null;

    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && test(tab)) finish();
    };

    // Listen before checking, so an update landing in between isn't missed.
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(finish, Math.max(0, deadline - Date.now()));

    chrome.tabs.get(tabId).then((tab) => {
      if (test(tab)) finish();
    }).catch(finish);
  });
}

function summarizeOpenJob(job) {
  const plural = (count) => (count === 1 ? '' : 's');
  const notes = [];
  if (job.suspended) notes.push(`${job.suspended} suspended`);
  if (job.unsuspended) notes.push(`${job.unsuspended} could not be suspended`);
  if (job.failedToOpen) notes.push(`${job.failedToOpen} failed to open`);

  let message = `Opened ${job.opened} URL${plural(job.opened)}`;
  if (notes.length) message += ` (${notes.join(', ')})`;

  return {
    message: `${message}.`,
    hasFailures: job.unsuspended > 0 || job.failedToOpen > 0,
    opened: job.opened,
    loaded: job.loaded,
    suspended: job.suspended
  };
}

function notifyOpenResult(message) {
  chrome.notifications.create({
    type: 'basic',
    title: 'SuperChrome',
    iconUrl: iconMap['urls-manager'],
    message
  });
}

// Handle any errors
chrome.runtime.lastError;
