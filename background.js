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
  // Clean up windowMap
  delete windowMap[windowId];
  delete windowActiveTabMap[windowId];
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  console.log('window focus changed');
  // Update badge for the active tab in the focused window
  if (windowId && windowId !== chrome.windows.WINDOW_ID_NONE) {
    if (!windowActiveTabMap[windowId]) {
      initializeWindow(windowId);
    }
    updateBadge(windowId);
  }
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

async function initializeWindow(initWinId) {
  let windowId = initWinId || (await chrome.windows.getCurrent()).id;
  let activeTab = windowActiveTabMap[windowId];
  if (!windowMap[windowId]) {
    let windowTabs = await chrome.tabs.query({currentWindow: true});

    for (const tab of windowTabs) {
      if (!activeTab && tab.active) {
        activeTab = tab.id;
        windowId = tab.windowId;
        windowActiveTabMap[windowId] = activeTab;
      }
      addTab(tab.id, windowId || tab.windowId, true, tab.url);
    }
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
  }
}

// Tool activation functions (placeholder implementations)
function activateUrlsManager() {
  console.log('URLs Manager tool activated');
  // TODO: Implement urls-manager functionality
}

async function activateRemoveDupes() {
  let duplicatesRemoved = 0;
  console.log('Remove Duplicates tool activated');
  // TODO: Implement remove-dupes functionality
  let dupeTabs = Object.values(dupeMap).flat();
  console.log(`Duplicate tabs to remove: ${dupeTabs}`);
  for (const tabId of dupeTabs) {
    try {
      await chrome.tabs.remove(tabId);
      duplicatesRemoved++;
    } catch (error) {
      console.error(`Failed to remove tab ${tabId}:`, error);
    }
  }
  console.log(
      `Removed ${duplicatesRemoved} of ${dupeTabs.length} duplicate tabs.`);
}

function activatePartitionTabs() {
  console.log('Partition Tabs tool activated');
  // TODO: Implement partition-tabs functionality
}

function activateMemoryManager() {
  console.log('Memory Manager tool activated');
  // TODO: Implement memory-manager functionality
}

// Handle any errors
chrome.runtime.lastError;
