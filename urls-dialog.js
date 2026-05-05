const ALLOWED_PROTOCOLS = new Set([
  'http:', 'https:', 'file:', 'ftp:', 'chrome:', 'about:', 'edge:',
  'chrome-extension:', 'view-source:'
]);

const VALID_TAB_GROUP_COLORS = new Set([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'
]);

const elements = {
  output: null,
  status: null,
  cbTitle: null,
  cbAllWindows: null,
  cbGroups: null,
  btnCopy: null,
  btnOpen: null,
  btnBack: null
};

document.addEventListener('DOMContentLoaded', async () => {
  bindElements();
  bindEvents();
  await refreshExport();
});

function bindElements() {
  elements.output = document.getElementById('output');
  elements.status = document.getElementById('status');
  elements.cbTitle = document.getElementById('cb-title');
  elements.cbAllWindows = document.getElementById('cb-allwindows');
  elements.cbGroups = document.getElementById('cb-groups');
  elements.cbLocked = document.getElementById('cb-locked');
  elements.btnCopy = document.getElementById('btn-copy');
  elements.btnOpen = document.getElementById('btn-open');
  elements.btnBack = document.getElementById('btn-back');
}

function bindEvents() {
  elements.cbTitle.addEventListener('change', () => {
    refreshExport();
  });
  elements.cbAllWindows.addEventListener('change', () => {
    refreshExport();
  });
  elements.cbGroups.addEventListener('change', () => {
    refreshExport();
  });
  elements.cbLocked.addEventListener('change', () => {
    elements.output.readOnly = elements.cbLocked.checked;
  });

  elements.btnCopy.addEventListener('click', async () => {
    await copyExport();
  });

  elements.btnOpen.addEventListener('click', async () => {
    await openExport();
  });

  elements.btnBack.addEventListener('click', () => {
    window.location.replace('popup.html');
  });
}

async function refreshExport() {
  try {
    const options = {
      includeTitle: elements.cbTitle.checked,
      includeAllWindows: elements.cbAllWindows.checked,
      preserveGroups: elements.cbGroups.checked
    };

    const exportText = await buildExportText(options);
    elements.output.value = exportText;
    const count = countUrls(exportText);
    setStatus(`Exported ${count} URL${count === 1 ? '' : 's'}.`);
  } catch (error) {
    console.error('Failed to build URL export:', error);
    setStatus('Failed to export URLs.', true);
  }
}

async function buildExportText(options) {
  const windows = await getSourceWindows(options.includeAllWindows);
  const groupsById = await getGroupsById(options.preserveGroups);

  const blocks = windows
                     .map(
                         (windowInfo) =>
                             renderWindowBlock(windowInfo, options, groupsById))
                     .filter(Boolean);

  return blocks.join('\n====\n');
}

async function getSourceWindows(includeAllWindows) {
  if (includeAllWindows) {
    const allWindows =
        await chrome.windows.getAll({populate: true, windowTypes: ['normal']});

    allWindows.sort((left, right) => {
      if (left.focused !== right.focused) {
        return left.focused ? -1 : 1;
      }
      return left.id - right.id;
    });

    return allWindows;
  }

  const focusedWindow = await chrome.windows.getLastFocused(
      {populate: true, windowTypes: ['normal']});
  return [focusedWindow];
}

async function getGroupsById(includeGroups) {
  if (!includeGroups) return new Map();

  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((group) => [group.id, group]));
}

function renderWindowBlock(windowInfo, options, groupsById) {
  const tabs = (windowInfo.tabs || []).slice().sort((left, right) => {
    return left.index - right.index;
  });

  const lines = [];

  if (!options.preserveGroups) {
    for (const tab of tabs) {
      appendTabLines(lines, tab, options.includeTitle);
    }
    return lines.join('\n').trim();
  }

  for (let index = 0; index < tabs.length; index++) {
    const tab = tabs[index];
    const url = (tab.url || '').trim();
    if (!url) continue;

    if (tab.groupId !== -1) {
      const groupId = tab.groupId;
      const group = groupsById.get(groupId) || {title: '', color: 'grey'};
      const title = sanitizeSingleLine(group.title || '');
      const color = normalizeGroupColor(group.color);

      lines.push(`[${title}|#${color}`);
      while (index < tabs.length && tabs[index].groupId === groupId) {
        appendTabLines(lines, tabs[index], options.includeTitle);
        index += 1;
      }
      index -= 1;
      lines.push(']');
      continue;
    }

    appendTabLines(lines, tab, options.includeTitle);
  }

  return lines.join('\n').trim();
}

function appendTabLines(lines, tab, includeTitle) {
  const url = (tab.url || '').trim();
  if (!url) return;

  if (includeTitle) {
    const title = sanitizeSingleLine(tab.title || '');
    if (title) {
      lines.push(title);
    }
  }

  lines.push(url);
}

function sanitizeSingleLine(value) {
  return String(value).replace(/\r?\n/g, ' ').trim();
}

function normalizeGroupColor(value) {
  const color = String(value || 'grey').toLowerCase();
  return VALID_TAB_GROUP_COLORS.has(color) ? color : 'grey';
}

function countUrls(text) {
  return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => parseUrlFromLine(line))
      .length;
}

async function copyExport() {
  const text = elements.output.value.trim();
  if (!text) {
    setStatus('Nothing to copy.');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    fallbackCopy(text);
  }

  setStatus('Copied URLs to clipboard.');
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

async function openExport() {
  const text = elements.output.value;
  const parsedWindowBlocks =
      splitWindowBlocks(text).map(parseWindowBlock).filter((items) => {
        return items.length > 0;
      });

  if (!parsedWindowBlocks.length) {
    setStatus('Nothing to open.');
    return;
  }

  try {
    let totalOpened = 0;
    let currentWindow = null;

    try {
      currentWindow =
          await chrome.windows.getLastFocused({windowTypes: ['normal']});
    } catch (error) {
      const fallbackWindow =
          await chrome.windows.create({url: 'about:blank', focused: false});
      currentWindow = {id: fallbackWindow.id};
    }

    for (let index = 0; index < parsedWindowBlocks.length; index++) {
      const items = parsedWindowBlocks[index];
      let windowId = currentWindow.id;
      let placeholderTabId = null;

      if (index > 0) {
        const newWindow =
            await chrome.windows.create({url: 'about:blank', focused: false});
        windowId = newWindow.id;
        placeholderTabId = newWindow.tabs?.[0]?.id || null;
      }

      const openedTabIds = await openItemsInWindow(items, windowId);
      totalOpened += openedTabIds.length;

      if (placeholderTabId && openedTabIds.length) {
        await chrome.tabs.remove(placeholderTabId).catch(() => {});
      }
    }

    setStatus(`Opened ${totalOpened} URL${totalOpened === 1 ? '' : 's'}.`);
  } catch (error) {
    console.error('Failed to open URLs:', error);
    setStatus('Failed to open one or more URLs.', true);
  }
}

async function openItemsInWindow(items, windowId) {
  const openedTabIds = [];

  for (const item of items) {
    if (item.type === 'tab') {
      const tab = await chrome.tabs.create(
          {windowId: windowId, url: item.url, active: false});
      openedTabIds.push(tab.id);
      continue;
    }

    if (item.type === 'group') {
      const groupTabIds = [];

      for (const url of item.urls) {
        const tab = await chrome.tabs.create(
            {windowId: windowId, url: url, active: false});
        groupTabIds.push(tab.id);
        openedTabIds.push(tab.id);
      }

      if (!groupTabIds.length) continue;

      const groupId = await chrome.tabs.group({tabIds: groupTabIds});
      const updateProperties = {};
      if (item.title) {
        updateProperties.title = item.title;
      }
      if (item.color && VALID_TAB_GROUP_COLORS.has(item.color)) {
        updateProperties.color = item.color;
      }

      if (Object.keys(updateProperties).length > 0) {
        await chrome.tabGroups.update(groupId, updateProperties);
      }
    }
  }

  return openedTabIds;
}

function splitWindowBlocks(text) {
  const blocks = [];
  let currentLines = [];

  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.trim() === '====') {
      blocks.push(currentLines.join('\n'));
      currentLines = [];
      continue;
    }

    currentLines.push(rawLine);
  }

  if (currentLines.length) {
    blocks.push(currentLines.join('\n'));
  }

  return blocks;
}

function parseWindowBlock(blockText) {
  const items = [];
  const lines = blockText.replace(/\r\n/g, '\n').split('\n');
  let currentGroup = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!currentGroup) {
      const groupHeader = parseGroupHeader(line);
      if (groupHeader) {
        currentGroup = {...groupHeader, urls: []};
        continue;
      }

      const url = parseUrlFromLine(line);
      if (url) {
        items.push({type: 'tab', url: url});
      }
      continue;
    }

    if (line === ']') {
      if (currentGroup.urls.length) {
        items.push({
          type: 'group',
          title: currentGroup.title,
          color: currentGroup.color,
          urls: [...currentGroup.urls]
        });
      }
      currentGroup = null;
      continue;
    }

    const nestedGroupHeader = parseGroupHeader(line);
    if (nestedGroupHeader) {
      if (currentGroup.urls.length) {
        items.push({
          type: 'group',
          title: currentGroup.title,
          color: currentGroup.color,
          urls: [...currentGroup.urls]
        });
      }
      currentGroup = {...nestedGroupHeader, urls: []};
      continue;
    }

    const groupedUrl = parseUrlFromLine(line);
    if (groupedUrl) {
      currentGroup.urls.push(groupedUrl);
    }
  }

  if (currentGroup?.urls.length) {
    items.push({
      type: 'group',
      title: currentGroup.title,
      color: currentGroup.color,
      urls: [...currentGroup.urls]
    });
  }

  return items;
}

function parseGroupHeader(line) {
  if (!line.startsWith('[')) return null;

  let body = line.slice(1).trim();
  if (body.endsWith(']')) {
    body = body.slice(0, -1).trim();
  }

  const pipeIndex = body.lastIndexOf('|');
  if (pipeIndex === -1) return null;

  const title = sanitizeSingleLine(body.slice(0, pipeIndex));
  let color = body.slice(pipeIndex + 1).trim();
  if (color.startsWith('#')) {
    color = color.slice(1);
  }

  return {title: title, color: normalizeGroupColor(color)};
}

function parseUrlFromLine(line) {
  const value = line.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return value;
  } catch (error) {
    return null;
  }
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? '#b42318' : '#1f5d2f';
}
