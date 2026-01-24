/**
 * Super Tool - Background Service Worker
 * Manages state and communication between popup and content scripts
 */

// Initialize with default tool on first install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['activeTool'], (result) => {
    if (!result.activeTool) {
      chrome.storage.local.set({activeTool: 'get-urls'});
      console.log('Super Tool: Initialized with default tool: get-urls');
    }
  });
});

let clickTimers = 0;
let timerCallback;
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

chrome.tabs.onActivated.addListener(updateBadge);
chrome.tabs.onAttached.addListener(updateBadge);
chrome.tabs.onDetached.addListener(updateBadge);
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener(updateBadge);
chrome.windows.onFocusChanged.addListener(updateBadge);

async function updateBadge() {
  // need to cache this since this is fairly expensive to do frequently
  let windowTabs = await chrome.tabs.query({currentWindow: true});

  // Group tabs by URL
  const urlGroups = {};
  let duplicateFound = false;
  let activeTab = null;

  for (const tab of windowTabs) {
    if (tab.url && !tab.url.startsWith('chrome://') &&
        !tab.url.startsWith('chrome-extension://')) {
      if (!urlGroups[tab.url]) {
        urlGroups[tab.url] = [];
      } else {
        duplicateFound = true;
      }
    }
    if (tab.highlighted) {
      activeTab = tab;
    }
  }

  chrome.action.setBadgeText({
    text: windowTabs.length > 0 ? `${windowTabs.length}` : '',
    tabId: activeTab ? activeTab.id : null
  });
  chrome.action.setBadgeBackgroundColor({
    color: duplicateFound ? '#FF4444' : '#4444FF',
    tabId: activeTab ? activeTab.id : null
  });
}

function handleToolActivation(tool) {
  // Handle tool activation
  console.log(`Super Tool: Activating tool ${tool}`);

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

function activateRemoveDupes() {
  console.log('Remove Duplicates tool activated');
  // TODO: Implement remove-dupes functionality
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
chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log('Super Tool: Tab activated', activeInfo.tabId);
});

// Handle any errors
chrome.runtime.lastError;
