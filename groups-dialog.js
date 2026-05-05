/**
 * Group Control Panel
 * Manages Chrome tab groups: view, merge, split, rename, recolor, delete,
 * export, import, and move between windows.
 */

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// CSS colors matching Chrome's tab group colors
const COLOR_CSS = {
  grey:   '#9e9ea0',
  blue:   '#4688f1',
  red:    '#e8453c',
  yellow: '#f9b700',
  green:  '#3dba4e',
  pink:   '#f878b0',
  purple: '#a855f7',
  cyan:   '#009688',
  orange: '#fa903e'
};

// State
let allGroups = [];        // [{group, tabs, windowTitle}]
let windowList = [];       // [{id, title}]
let groupAges = {};        // {groupId: timestampMs}
let splitGroupId = null;   // group being split (null = not in split mode)
let colorPickerTarget = null; // {type: 'custom'|'split'|'row', groupId?, resolve?}
let pendingDeleteIds = [];

const $ = id => document.getElementById(id);

// ── Initialization ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  buildColorSwatches('custom-color-swatches', 'grey');
  buildColorSwatches('split-color-swatches', 'blue');
  bindStaticEvents();
  await loadData();
  renderTable();
});

async function loadData() {
  const [groups, tabs, windows, stored] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
    chrome.windows.getAll({ populate: false }),
    chrome.storage.local.get('groupAges')
  ]);

  groupAges = stored.groupAges || {};

  // Map windowId → title/number
  const winMap = {};
  windows.forEach((w, i) => {
    winMap[w.id] = `Window ${i + 1}`;
  });
  windowList = windows.map((w, i) => ({ id: w.id, title: `Window ${i + 1}` }));

  // Map groupId → [tabs]
  const tabsByGroup = {};
  tabs.forEach(t => {
    if (t.groupId !== -1) {
      (tabsByGroup[t.groupId] = tabsByGroup[t.groupId] || []).push(t);
    }
  });

  // Build allGroups, track ages for new groups, prune stale ages
  const now = Date.now();
  const liveIds = new Set(groups.map(g => g.id));
  // Prune stale
  for (const id of Object.keys(groupAges)) {
    if (!liveIds.has(Number(id))) delete groupAges[id];
  }
  // Record first-seen
  groups.forEach(g => {
    if (!groupAges[g.id]) groupAges[g.id] = now;
  });
  chrome.storage.local.set({ groupAges });

  allGroups = groups.map(g => ({
    group: g,
    tabs: (tabsByGroup[g.id] || []).sort((a, b) => a.index - b.index),
    windowTitle: winMap[g.windowId] || `Window ?`
  }));

  // Populate "Move to" window dropdown
  const sel = $('move-select');
  sel.innerHTML = '<option value="">Move to…</option>';
  windowList.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.title;
    sel.appendChild(opt);
  });
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderTable() {
  const tbody = $('groups-body');
  tbody.innerHTML = '';

  if (allGroups.length === 0) {
    $('empty-state').style.display = 'block';
    $('groups-table').style.display = 'none';
    return;
  }
  $('empty-state').style.display = 'none';
  $('groups-table').style.display = '';

  allGroups.forEach(({ group, tabs, windowTitle }) => {
    const inSplitMode = splitGroupId === group.id;
    const displayName = group.title || (tabs[0]?.title) || '(unnamed)';
    const isNamed = !!group.title;
    const age = formatAge(groupAges[group.id]);
    const collapsed = group.collapsed;

    // Group row
    const tr = document.createElement('tr');
    tr.className = 'group-row';
    tr.dataset.groupId = group.id;
    tr.style.borderLeft = `4px solid ${COLOR_CSS[group.color] || '#ccc'}`;

    tr.innerHTML = `
      <td><input type="checkbox" class="group-check" data-group-id="${group.id}"></td>
      <td>
        <span class="color-chip"
              style="background:${COLOR_CSS[group.color] || '#ccc'}"
              data-group-id="${group.id}"
              data-color="${group.color}"
              title="Click to change color"></span>
      </td>
      <td>
        <span class="group-name ${isNamed ? '' : 'unnamed'}"
              data-group-id="${group.id}"
              title="${isNamed ? 'Double-click to rename' : 'Unnamed — double-click to set a name'}"
              >${escHtml(displayName)}</span>
      </td>
      <td><span class="window-label">${escHtml(windowTitle)}</span></td>
      <td><span class="age-label">${age}</span></td>
      <td>${tabs.length}</td>
      <td>
        <button class="expand-btn" data-group-id="${group.id}" title="${collapsed ? 'Collapsed — click to expand' : 'Expanded — click to collapse'}">
          ${collapsed ? '▶' : '▼'}
        </button>
      </td>
      <td><button class="btn-row-delete" data-group-id="${group.id}" title="Ungroup (delete group, keep tabs)">✕</button></td>
    `;
    tbody.appendChild(tr);

    // Tab sub-rows
    tabs.forEach(tab => {
      const tabTr = document.createElement('tr');
      tabTr.className = `tab-row${collapsed && !inSplitMode ? ' hidden' : ''}`;
      tabTr.dataset.parentGroupId = group.id;
      tabTr.innerHTML = `
        <td class="tab-check">${inSplitMode ? `<input type="checkbox" class="tab-split-check" data-tab-id="${tab.id}">` : ''}</td>
        <td class="tab-title" colspan="5" title="${escHtml(tab.title || tab.url)}">${escHtml(tab.title || tab.url)}</td>
        <td class="tab-url" title="${escHtml(tab.url)}">${escHtml(shortUrl(tab.url))}</td>
        <td></td>
      `;
      tbody.appendChild(tabTr);
    });
  });

  bindDynamicEvents();
  updateActionBar();
}

function updateActionBar() {
  const checked = getCheckedGroupIds();
  const count = checked.length;
  const isSplitting = splitGroupId !== null;

  $('btn-merge').disabled = count < 2 || isSplitting;
  $('btn-delete').disabled = count === 0 || isSplitting;
  $('move-select').disabled = count === 0 || isSplitting;

  // Split: exactly 1 group checked and NOT already splitting
  const splitReady = count === 1 && !isSplitting;
  $('btn-split').disabled = !splitReady;

  // Select-all checkbox state
  const allChecked = count === allGroups.length && allGroups.length > 0;
  $('select-all').checked = allChecked;
  $('select-all').indeterminate = count > 0 && !allChecked;
}

// ── Events ───────────────────────────────────────────────────────────────────

function bindStaticEvents() {
  // Back button
  $('btn-back').addEventListener('click', () => {
    window.location.replace('popup.html');
  });

  // Select all
  $('select-all').addEventListener('change', e => {
    document.querySelectorAll('.group-check').forEach(cb => {
      cb.checked = e.target.checked;
    });
    updateActionBar();
  });

  // Merge mode radio → show/hide custom fields
  document.querySelectorAll('input[name="merge-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      const isCustom = document.querySelector('input[name="merge-mode"]:checked').value === 'custom';
      $('custom-fields').classList.toggle('visible', isCustom);
    });
  });

  // Merge button
  $('btn-merge').addEventListener('click', onMerge);

  // Split button — enters split mode
  $('btn-split').addEventListener('click', onSplitStart);

  // Split confirm / cancel
  $('btn-split-confirm').addEventListener('click', onSplitConfirm);
  $('btn-split-cancel').addEventListener('click', onSplitCancel);

  // Delete button
  $('btn-delete').addEventListener('click', onBulkDelete);

  // Move to window
  $('move-select').addEventListener('change', onMoveToWindow);

  // Export
  $('btn-export').addEventListener('click', onExport);

  // Import
  $('btn-import').addEventListener('change', onImport);

  // Confirm overlay
  $('confirm-cancel').addEventListener('click', () => {
    $('confirm-overlay').classList.remove('visible');
    pendingDeleteIds = [];
  });
  $('confirm-ok').addEventListener('click', () => {
    $('confirm-overlay').classList.remove('visible');
    doDelete(pendingDeleteIds);
  });

  // Color picker popup — close on outside click
  document.addEventListener('click', e => {
    const picker = $('color-picker-popup');
    if (!picker.contains(e.target) && !e.target.classList.contains('color-chip')) {
      picker.classList.remove('visible');
      colorPickerTarget = null;
    }
  });
}

function bindDynamicEvents() {
  // Checkboxes
  document.querySelectorAll('.group-check').forEach(cb => {
    cb.addEventListener('change', updateActionBar);
  });

  // Expand/collapse toggle buttons
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const groupId = Number(btn.dataset.groupId);
      const entry = allGroups.find(g => g.group.id === groupId);
      if (!entry) return;
      const newCollapsed = !entry.group.collapsed;
      await chrome.tabGroups.update(groupId, { collapsed: newCollapsed });
      entry.group.collapsed = newCollapsed;
      renderTable();
    });
  });

  // Color chip click → show color picker
  document.querySelectorAll('.color-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const groupId = Number(chip.dataset.groupId);
      showColorPicker(e.target, 'row', groupId);
    });
  });

  // Group name double-click → inline edit
  document.querySelectorAll('.group-name').forEach(span => {
    span.addEventListener('dblclick', () => {
      const groupId = Number(span.dataset.groupId);
      startInlineRename(span, groupId);
    });
  });

  // Row delete buttons
  document.querySelectorAll('.btn-row-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const groupId = Number(btn.dataset.groupId);
      pendingDeleteIds = [groupId];
      doDelete([groupId]);
    });
  });
}

// ── Color picker ─────────────────────────────────────────────────────────────

function buildColorSwatches(containerId, selected) {
  const container = $(containerId);
  container.innerHTML = '';
  GROUP_COLORS.forEach(color => {
    const s = document.createElement('span');
    s.className = `color-swatch${color === selected ? ' selected' : ''}`;
    s.style.background = COLOR_CSS[color];
    s.dataset.color = color;
    s.title = color;
    s.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('selected'));
      s.classList.add('selected');
    });
    container.appendChild(s);
  });
}

function showColorPicker(anchorEl, type, groupId) {
  const picker = $('color-picker-popup');
  picker.innerHTML = '';
  GROUP_COLORS.forEach(color => {
    const s = document.createElement('span');
    s.className = 'color-swatch';
    s.style.background = COLOR_CSS[color];
    s.dataset.color = color;
    s.title = color;
    s.addEventListener('click', async () => {
      picker.classList.remove('visible');
      if (type === 'row' && groupId) {
        await chrome.tabGroups.update(groupId, { color });
        const entry = allGroups.find(g => g.group.id === groupId);
        if (entry) entry.group.color = color;
        renderTable();
        setStatus('Color updated.');
      }
    });
    picker.appendChild(s);
  });
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';
  picker.classList.add('visible');
  colorPickerTarget = { type, groupId };
}

function getSelectedSwatch(containerId) {
  const sel = document.querySelector(`#${containerId} .color-swatch.selected`);
  return sel ? sel.dataset.color : 'grey';
}

// ── Inline rename ─────────────────────────────────────────────────────────────

function startInlineRename(span, groupId) {
  const current = allGroups.find(g => g.group.id === groupId);
  const currentTitle = current?.group.title || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-name-input';
  input.value = currentTitle;
  input.maxLength = 64;
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newTitle = input.value.trim();
    await chrome.tabGroups.update(groupId, { title: newTitle });
    if (current) current.group.title = newTitle;
    renderTable();
    setStatus('Group renamed.');
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      renderTable();
    }
  });
}

// ── Merge ────────────────────────────────────────────────────────────────────

async function onMerge() {
  const ids = getCheckedGroupIds();
  if (ids.length < 2) return;

  const mode = document.querySelector('input[name="merge-mode"]:checked').value;
  const entries = ids.map(id => allGroups.find(g => g.group.id === id)).filter(Boolean);

  let primaryEntry;
  let mergedName;
  let mergedColor;

  if (mode === 'first') {
    primaryEntry = entries[0];
    mergedName = primaryEntry.group.title;
    mergedColor = primaryEntry.group.color;
  } else if (mode === 'largest') {
    primaryEntry = entries.reduce((a, b) => a.tabs.length >= b.tabs.length ? a : b);
    mergedName = primaryEntry.group.title;
    mergedColor = primaryEntry.group.color;
  } else {
    // custom
    primaryEntry = entries[0];
    mergedName = $('custom-name').value.trim();
    mergedColor = getSelectedSwatch('custom-color-swatches');
  }

  const primaryId = primaryEntry.group.id;
  const secondaryEntries = entries.filter(e => e.group.id !== primaryId);

  // Collect all tab IDs from secondary groups
  const tabsToMove = secondaryEntries.flatMap(e => e.tabs.map(t => t.id));

  if (tabsToMove.length > 0) {
    await chrome.tabs.group({ tabIds: tabsToMove, groupId: primaryId });
  }

  // Apply name/color to primary
  await chrome.tabGroups.update(primaryId, {
    title: mergedName || undefined,
    color: mergedColor
  });

  setStatus(`Merged ${ids.length} groups.`);
  await loadData();
  renderTable();
}

// ── Split ────────────────────────────────────────────────────────────────────

function onSplitStart() {
  const ids = getCheckedGroupIds();
  if (ids.length !== 1) return;
  splitGroupId = ids[0];

  // Expand the group row so sub-rows are visible with checkboxes
  const entry = allGroups.find(g => g.group.id === splitGroupId);
  if (entry) entry.group.collapsed = false;

  renderTable();
  $('split-confirm-bar').classList.add('visible');
  setStatus('Select tabs to split into a new group, then confirm.');
}

async function onSplitConfirm() {
  const checked = [...document.querySelectorAll('.tab-split-check:checked')];
  if (checked.length === 0) {
    setStatus('Select at least one tab to split.', true);
    return;
  }

  const tabIds = checked.map(cb => Number(cb.dataset.tabId));
  const newName = $('split-name').value.trim();
  const newColor = getSelectedSwatch('split-color-swatches');

  // Ungroup selected tabs, then re-group them as a new group
  const windowId = allGroups.find(g => g.group.id === splitGroupId)?.group.windowId;
  await chrome.tabs.ungroup(tabIds);
  const newGroupId = await chrome.tabs.group({
    tabIds,
    createProperties: windowId ? { windowId } : undefined
  });
  await chrome.tabGroups.update(newGroupId, {
    title: newName || undefined,
    color: newColor
  });

  onSplitCancel();
  setStatus('Split complete.');
  await loadData();
  renderTable();
}

function onSplitCancel() {
  splitGroupId = null;
  $('split-confirm-bar').classList.remove('visible');
  $('split-name').value = '';
  renderTable();
}

// ── Delete ───────────────────────────────────────────────────────────────────

function onBulkDelete() {
  const ids = getCheckedGroupIds();
  if (ids.length === 0) return;

  if (ids.length > 1) {
    $('confirm-msg').textContent =
      `Delete ${ids.length} groups? Tabs will be ungrouped but not closed.`;
    pendingDeleteIds = ids;
    $('confirm-overlay').classList.add('visible');
  } else {
    doDelete(ids);
  }
}

async function doDelete(ids) {
  for (const id of ids) {
    const entry = allGroups.find(g => g.group.id === id);
    if (!entry) continue;
    const tabIds = entry.tabs.map(t => t.id);
    if (tabIds.length > 0) await chrome.tabs.ungroup(tabIds);
    // Chrome auto-removes the group once all tabs are ungrouped
  }
  setStatus(`Deleted ${ids.length} group${ids.length > 1 ? 's' : ''}.`);
  pendingDeleteIds = [];
  await loadData();
  renderTable();
}

// ── Move to window ────────────────────────────────────────────────────────────

async function onMoveToWindow() {
  const targetWindowId = Number($('move-select').value);
  if (!targetWindowId) return;
  const ids = getCheckedGroupIds();
  if (ids.length === 0) {
    $('move-select').value = '';
    return;
  }

  for (const groupId of ids) {
    const entry = allGroups.find(g => g.group.id === groupId);
    if (!entry) continue;
    const tabIds = entry.tabs.map(t => t.id);
    if (tabIds.length === 0) continue;

    // Move tabs to target window
    await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });
    // Re-group them in the target window
    const newGroupId = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId: targetWindowId }
    });
    await chrome.tabGroups.update(newGroupId, {
      title: entry.group.title || undefined,
      color: entry.group.color
    });
  }

  $('move-select').value = '';
  setStatus(`Moved ${ids.length} group${ids.length > 1 ? 's' : ''} to window.`);
  await loadData();
  renderTable();
}

// ── Export ───────────────────────────────────────────────────────────────────

function onExport() {
  const ids = getCheckedGroupIds();
  const toExport = ids.length > 0
    ? allGroups.filter(e => ids.includes(e.group.id))
    : allGroups;

  if (toExport.length === 0) {
    setStatus('No groups to export.', true);
    return;
  }

  // Group by window
  const byWindow = {};
  toExport.forEach(e => {
    (byWindow[e.group.windowId] = byWindow[e.group.windowId] || []).push(e);
  });

  const blocks = [];
  Object.values(byWindow).forEach((entries, i) => {
    if (i > 0) blocks.push('====');
    entries.forEach(({ group, tabs }) => {
      const name = group.title || '';
      blocks.push(`[${name}|#${group.color}`);
      tabs.forEach(t => blocks.push(t.url));
      blocks.push(']');
    });
  });

  const text = blocks.join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `groups-export-${dateStamp()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${toExport.length} group${toExport.length > 1 ? 's' : ''}.`);
}

// ── Import ───────────────────────────────────────────────────────────────────

async function onImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const text = await file.text();
  const windowBlocks = text.split(/\n?====\n?/).filter(Boolean);

  let created = 0;
  for (const block of windowBlocks) {
    created += await importWindowBlock(block);
  }
  setStatus(`Imported ${created} group${created !== 1 ? 's' : ''}.`);
  await loadData();
  renderTable();
}

async function importWindowBlock(blockText) {
  const lines = blockText.trim().split('\n');
  let groupCount = 0;
  let inGroup = false;
  let groupName = '';
  let groupColor = 'blue';
  let groupUrls = [];

  const VALID_COLORS = new Set(GROUP_COLORS);
  const ALLOWED_PROTOCOLS = new Set([
    'http:', 'https:', 'file:', 'ftp:', 'chrome:', 'about:',
    'edge:', 'chrome-extension:', 'view-source:'
  ]);

  const commitGroup = async () => {
    if (groupUrls.length === 0) return;
    const tabs = await Promise.all(groupUrls.map(url =>
      chrome.tabs.create({ url, active: false })
    ));
    const tabIds = tabs.map(t => t.id);
    const gId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(gId, {
      title: groupName || undefined,
      color: groupColor
    });
    groupCount++;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[') && trimmed !== ']') {
      // Group header: [Name|#color  OR  [Name|color  OR  [|color
      const inner = trimmed.slice(1);
      const pipeIdx = inner.lastIndexOf('|');
      if (pipeIdx !== -1) {
        groupName = inner.slice(0, pipeIdx).trim();
        let colorPart = inner.slice(pipeIdx + 1).trim().replace(/^#/, '');
        groupColor = VALID_COLORS.has(colorPart) ? colorPart : 'blue';
      } else {
        groupName = inner;
        groupColor = 'blue';
      }
      inGroup = true;
      groupUrls = [];
      continue;
    }

    if (trimmed === ']') {
      if (inGroup) await commitGroup();
      inGroup = false;
      groupName = '';
      groupUrls = [];
      continue;
    }

    if (inGroup) {
      try {
        const u = new URL(trimmed);
        if (ALLOWED_PROTOCOLS.has(u.protocol)) groupUrls.push(trimmed);
      } catch (_) {
        // skip invalid URLs
      }
    }
  }

  // Handle unclosed group block
  if (inGroup && groupUrls.length > 0) await commitGroup();

  return groupCount;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCheckedGroupIds() {
  return [...document.querySelectorAll('.group-check:checked')]
    .map(cb => Number(cb.dataset.groupId));
}

function formatAge(ts) {
  if (!ts) return '?';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '< 1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch (_) {
    return url;
  }
}

function escHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status-line ${isError ? 'error' : 'success'}`;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}
