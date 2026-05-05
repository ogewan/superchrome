/**
 * Super Tool - Popup Script
 * Handles dock UI interactions and tool switching
 */

const toolMap = {
  'urls-manager': 'icon-urls-manager',
  'open-urls': 'icon-open-urls',
  'remove-dupes': 'icon-remove-dupes',
  'partition-tabs': 'icon-partition-tabs',
  'memory-manager': 'icon-memory-manager',
  'group-control': 'icon-group-control'
};

let currentActiveTool = 'urls-manager';

/**
 * Initialize popup on load
 */
document.addEventListener('DOMContentLoaded', () => {
  loadActiveTool();
  attachEventListeners();
});

/**
 * Load the currently active tool from storage
 */
function loadActiveTool() {
  chrome.runtime.sendMessage({action: 'getActiveTool'}, (response) => {
    currentActiveTool = response.activeTool || 'urls-manager';
    updateActiveIcon();
  });
}

/**
 * Attach event listeners to all dock icons
 */
function attachEventListeners() {
  const icons = document.querySelectorAll('.dock-icon');

  icons.forEach((icon) => {
    // Click handler for single and double clicks
    icon.addEventListener('click', (e) => {
      const tool = icon.getAttribute('data-tool');
      handleDoubleClick(tool);
    });

    // Add right-click menu if needed later
    icon.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Placeholder for context menu
    });
  });
}


/**
 * Handle double click - activate the tool
 */
function handleDoubleClick(tool) {
  console.log(`clicked tool: ${tool}`);

  // Set as active if not already
  if (currentActiveTool !== tool) {
    currentActiveTool = tool;
    chrome.runtime.sendMessage(
        {action: 'setActiveTool', tool: tool}, (response) => {
          if (response.success) {
            updateActiveIcon();
          }
        });
  }

  // Activate the tool
  chrome.runtime.sendMessage(
      {action: 'activateTool', tool: tool}, (response) => {
        if (response.success) {
          console.log(`Tool activated: ${tool}`);

          if (tool === 'urls-manager') {
            // Expand into the URL manager dialog inside the popup window.
            window.location.replace('urls-dialog.html');
            return;
          }

          if (tool === 'group-control') {
            window.location.replace('groups-dialog.html');
            return;
          }

          // Close popup after tool activation
          setTimeout(() => {
            window.close();
          }, 200);
        }
      });
}

/**
 * Update the visual appearance of the active icon
 */
function updateActiveIcon() {
  // Remove active class from all icons
  document.querySelectorAll('.dock-icon').forEach((icon) => {
    icon.classList.remove('active');
  });

  // Add active class to the current tool icon
  const activeIconId = toolMap[currentActiveTool];
  const activeIcon = document.getElementById(activeIconId);
  if (activeIcon) {
    activeIcon.classList.add('active');
  }
}

/**
 * Handle extension icon click while popup is open (double-click on extension
 * icon) This is handled by closing and reopening the popup, which triggers the
 * double-click logic if the extension icon is clicked again
 */
window.addEventListener(
    'focus',
    () => {
        // Popup is focused - can implement auto-activation logic if needed
    });
