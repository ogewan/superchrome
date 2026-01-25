/**
 * Super Tool - Background Service Worker
 * Manages state and communication between popup and content scripts
 */

let clickTimers = 0;
let timerCallback;
let windowMap = {};
let tabUrlMap = {};
let tabMap = {};
let dupeMap = {};

// onActivated, onAttahed, onCreated, onRemoved
chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log('activated');
  updateBadge(activeInfo.tabId, activeInfo.windowId);
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
  updateBadge(tab.id, tab.windowId);
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log('removed');
  removeTab(tabId, removeInfo.windowId, true);
  // update badge because active tab is not guaranteed to change
  updateBadge(tabId, removeInfo.windowId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  console.log('updated');
  updateTab(changeInfo.url, tab.url, tabId);
  updateBadge(tabId, tab.windowId);
  // console.dir(`tab:${tabId} changeInfo: ${JSON.stringify(changeInfo)}`);
});

// Initialize with default tool on first install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['activeTool'], (result) => {
    if (!result.activeTool) {
      chrome.storage.local.set({activeTool: 'get-urls'});
      console.log('Super Tool: Initialized with default tool: get-urls');
    }
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  // If this is the second click within 300ms, treat as double-click
  if (clickTimers && Date.now() - clickTimers < 300) {
    clearTimeout(timerCallback);
    let activeTool = await chrome.storage.local.get(['activeTool'])
                         .then(result => result.activeTool) ||
        'get-urls';
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
      sendResponse({activeTool: result.activeTool || 'get-urls'});
    });
    return true;  // Keep the message channel open for async response
  }

  if (request.action === 'activateTool') {
    handleToolActivation(request.tool);
    sendResponse({success: true});
    return true;
  }
});

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
    const url = initUrl || (await chrome.tabs.get(tabId)).url;
    addHelper(url, tabId);
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

async function updateBadge(tabId, windowId) {
  console.log('Super Tool: Updating badge', tabId, windowId);
  // need to cache this since this is fairly expensive to do frequently

  if (!windowMap[windowId]) {
    let windowTabs = await chrome.tabs.query({currentWindow: true});

    for (const tab of windowTabs) {
      addTab(tab.id, windowId, true, tab.url);
    }
  }

  console.log(`window ${windowId} has ${windowMap[windowId]} tabs on tab ${
      tabId} w/ dupe count ${Object.keys(dupeMap).length}`);
  chrome.action.setBadgeText({text: `${windowMap[windowId] || ''}`, tabId});
  chrome.action.setBadgeBackgroundColor(
      {color: Object.keys(dupeMap).length ? '#FF4444' : '#4444FF', tabId});
}

function setIcon(tool) {
  const iconDataUri = iconMap[tool] || iconMap['default'];
  chrome.action.setIcon({imageData: iconDataUri});
}

function handleToolActivation(tool) {
  // Handle tool activation
  console.log(`Super Tool: Activating tool ${tool}`);

  setIcon(tool);
  // Tool-specific activation logic will be implemented here
  switch (tool) {
    case 'get-urls':
      activateGetUrls();
      break;
    case 'open-urls':
      activateOpenUrls();
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
function activateGetUrls() {
  console.log('Get URLs tool activated');
  // TODO: Implement get-urls functionality
}

function activateOpenUrls() {
  console.log('Open URLs tool activated');
  // TODO: Implement open-urls functionality
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

// Listen for tab changes and update extension icon if needed
/*chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log('Super Tool: Tab activated', activeInfo.tabId);
});*/

// Handle any errors
chrome.runtime.lastError;

// stores icons; method name to icon data uri
const iconMap = {
  'default': ``,
  'urls-manager': ``,
  'remove-dupes': ``,
  'partition-tabs': ``,
  'memory-manager': ``
};