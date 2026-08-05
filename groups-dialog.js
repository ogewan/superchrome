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
let windowList = [];       // [{id, title, incognito, focused}]
let groupAges = {};        // {groupId: timestampMs}
let splitGroupId = null;   // group being split (null = not in split mode)
let colorPickerTarget = null; // {type: 'custom'|'split'|'row', groupId?, resolve?}
let pendingConfirm = null;     // {kind: 'delete-groups'|'close-windows', ids} awaiting the confirm overlay
let cgTabs = [];               // create-group: flat list of {id, title, windowId, groupId, active}
let cgTargetUserPicked = false; // true once the user manually changes the target dropdown

// Windows view state
let viewMode = 'groups';         // 'groups' | 'windows'
let allWindows = [];             // [{id, title, incognito, focused, tabs, groups, ungrouped}]
let expandedWindowIds = null;    // Set of window ids; null until seeded on first load
let incognitoAllowed = false;    // whether this extension can see incognito windows at all

// Unlike the groups table — where selection lives only in the DOM and is wiped by
// every render — the windows table keeps selection in JS. Expanding a window
// re-renders, and losing your tab picks every time you opened one would make
// cross-window moves unusable.
let winCheckedWindowIds = new Set();
let winCheckedTabIds = new Set();

const $ = id => document.getElementById(id);

// ── Initialization ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  buildColorSwatches('custom-color-swatches', 'grey');
  buildColorSwatches('split-color-swatches', 'blue');
  buildColorSwatches('cg-color-swatches', 'grey');
  bindStaticEvents();
  await loadData();
  renderAll();
});

async function loadData() {
  const [groups, tabs, windows, stored, incogAllowed] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
    // windowTypes keeps devtools/popup windows out of the list — they can hold
    // tabs but are never valid move or merge destinations.
    chrome.windows.getAll({ populate: false, windowTypes: ['normal'] }),
    chrome.storage.local.get('groupAges'),
    chrome.extension.isAllowedIncognitoAccess()
  ]);

  groupAges = stored.groupAges || {};
  incognitoAllowed = incogAllowed;

  const { winMap } = buildWindowLabels(windows);

  // Windows view model: each window with its groups and its loose tabs.
  const tabsByWindow = {};
  tabs.forEach(t => {
    if (!winMap[t.windowId]) return; // tab lives in a devtools/popup window
    (tabsByWindow[t.windowId] = tabsByWindow[t.windowId] || []).push(t);
  });
  allWindows = windowList.map(w => {
    const winTabs = (tabsByWindow[w.id] || []).sort((a, b) => a.index - b.index);
    return {
      ...w,
      tabs: winTabs,
      groups: groups.filter(g => g.windowId === w.id),
      ungrouped: winTabs.filter(t => t.groupId === -1)
    };
  });

  // Seed expansion once, on the focused window, so the view opens somewhere useful.
  if (expandedWindowIds === null) {
    const focused = windowList.find(w => w.focused) || windowList[0];
    expandedWindowIds = new Set(focused ? [focused.id] : []);
  }

  // Drop selections pointing at windows or tabs that no longer exist.
  const liveWindowIds = new Set(allWindows.map(w => w.id));
  const liveTabIds = new Set(allWindows.flatMap(w => w.tabs).map(t => t.id));
  winCheckedWindowIds = new Set([...winCheckedWindowIds].filter(id => liveWindowIds.has(id)));
  winCheckedTabIds = new Set([...winCheckedTabIds].filter(id => liveTabIds.has(id)));

  $('win-incognito-note').style.display = incognitoAllowed ? 'none' : '';

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
    windowTitle: winMap[g.windowId]?.title || `Window ?`
  }));

  // The "Move to" dropdown is rebuilt in updateActionBar rather than here — its
  // contents depend on which groups are checked, because targets on the far side
  // of the incognito boundary must not be offered.
}

// ── Window model ─────────────────────────────────────────────────────────────

/**
 * Single source of truth for window numbering. The positional `Window N` labels
 * used to be recomputed independently in three places, so they could disagree
 * with each other mid-session. Also assigns `windowList`.
 */
function buildWindowLabels(windows) {
  const winMap = {};
  windowList = windows.map((w, i) => {
    const entry = {
      id: w.id,
      title: `Window ${i + 1}`,
      incognito: !!w.incognito,
      focused: !!w.focused
    };
    winMap[w.id] = entry;
    return entry;
  });
  return { winMap, windowList };
}

// Display form for dropdowns: 🕶 marks incognito, ★ marks the focused window.
function windowLabel(w) {
  return `${w.title}${w.incognito ? ' 🕶' : ''}${w.focused ? ' ★' : ''}`;
}

// ── Incognito boundary ───────────────────────────────────────────────────────
// Chrome rejects any attempt to move a tab or a group between an incognito and
// a regular window. Rather than catch the rejection after the fact — which would
// abort a partly-applied batch — every cross-window target list is filtered
// through these helpers, so the UI cannot offer an illegal move in the first
// place.

function incognitoOf(windowId) {
  const w = windowList.find(x => x.id === windowId);
  return w ? w.incognito : null;
}

// The incognito state shared by every given window, or null if they disagree
// (or if none of them are known windows).
function uniformIncognito(windowIds) {
  const states = [...new Set(windowIds.map(incognitoOf).filter(s => s !== null))];
  return states.length === 1 ? states[0] : null;
}

/**
 * Windows that a selection drawn from `sourceWindowIds` may legally move into.
 * A selection straddling the boundary has no legal target at all, so this
 * returns [] — callers surface that as a disabled control plus an explanation.
 */
function compatibleTargets(sourceWindowIds, { excludeSources = false } = {}) {
  if (sourceWindowIds.length === 0) return [];
  const state = uniformIncognito(sourceWindowIds);
  if (state === null) return [];
  const sources = new Set(sourceWindowIds);
  return windowList.filter(w =>
    w.incognito === state && (!excludeSources || !sources.has(w.id))
  );
}

// ── View switching ───────────────────────────────────────────────────────────

/**
 * Both tables are redrawn together after every mutation. Rendering only the
 * active one would leave the other stale — merging two windows, for instance,
 * invalidates group rows just as much as window rows — and re-rendering on
 * switch instead would wipe the groups table's DOM-held selection every time
 * the user flipped views.
 */
function renderAll() {
  renderTable();
  renderWindowTable();
}

function switchView(mode) {
  if (mode === viewMode) return;
  // Split mode is a groups-view interaction; leaving the view abandons it.
  if (mode === 'windows' && splitGroupId !== null) onSplitCancel();

  viewMode = mode;
  $('groups-view').classList.toggle('visible', mode === 'groups');
  $('windows-view').classList.toggle('visible', mode === 'windows');
  $('tab-groups-view').classList.toggle('active', mode === 'groups');
  $('tab-windows-view').classList.toggle('active', mode === 'windows');
}

// ── Windows render ───────────────────────────────────────────────────────────

function renderWindowTable() {
  const tbody = $('windows-body');
  tbody.innerHTML = '';

  if (allWindows.length === 0) {
    $('win-empty-state').style.display = 'block';
    $('windows-table').style.display = 'none';
    updateWindowActionBar();
    return;
  }
  $('win-empty-state').style.display = 'none';
  $('windows-table').style.display = '';

  allWindows.forEach(w => {
    const expanded = expandedWindowIds.has(w.id);

    const tr = document.createElement('tr');
    tr.className = `window-row${w.incognito ? ' incognito' : ''}`;
    tr.dataset.windowId = w.id;
    tr.innerHTML = `
      <td><input type="checkbox" class="win-check" data-window-id="${w.id}"${winCheckedWindowIds.has(w.id) ? ' checked' : ''}></td>
      <td>
        <span class="window-title" data-window-id="${w.id}" title="Click to switch to this window">${escHtml(w.title)}</span>
        ${w.incognito ? '<span class="incognito-badge">Incognito</span>' : ''}
        ${w.focused ? '<span class="focused-badge" title="Currently focused window">★</span>' : ''}
      </td>
      <td>${w.tabs.length}</td>
      <td>${w.groups.length}</td>
      <td>
        <button class="win-expand-btn" data-window-id="${w.id}" title="${expanded ? 'Expanded — click to collapse' : 'Collapsed — click to expand'}">
          ${expanded ? '▼' : '▶'}
        </button>
      </td>
      <td><button class="btn-row-close" data-window-id="${w.id}" title="Close this window and all its tabs">✕</button></td>
    `;
    tbody.appendChild(tr);

    if (!expanded) return;

    // Grouped tabs first, under their group header; loose tabs after.
    w.groups.forEach(g => {
      const groupTabs = w.tabs.filter(t => t.groupId === g.id);
      const gtr = document.createElement('tr');
      gtr.className = 'win-sub-row win-group-row';
      gtr.dataset.parentWindowId = w.id;
      gtr.dataset.groupId = g.id;
      gtr.innerHTML = `
        <td class="win-check-cell"><input type="checkbox" class="win-group-check" data-group-id="${g.id}" title="Select every tab in this group"></td>
        <td class="win-sub-title" colspan="3">
          <span class="win-group-label">
            <span class="win-color-dot" style="background:${COLOR_CSS[g.color] || '#ccc'}"></span>
            ${escHtml(g.title || '(unnamed group)')}
          </span>
        </td>
        <td>${groupTabs.length}</td>
        <td></td>
      `;
      tbody.appendChild(gtr);
      groupTabs.forEach(t => tbody.appendChild(buildWinTabRow(t, w.id, true)));
    });

    w.ungrouped.forEach(t => tbody.appendChild(buildWinTabRow(t, w.id, false)));
  });

  bindWindowDynamicEvents();
  updateWindowActionBar();
}

function buildWinTabRow(tab, windowId, inGroup) {
  const tr = document.createElement('tr');
  tr.className = `win-sub-row win-tab-row${inGroup ? ' nested' : ''}`;
  tr.dataset.parentWindowId = windowId;
  tr.innerHTML = `
    <td class="win-check-cell"><input type="checkbox" class="win-tab-check"
        data-tab-id="${tab.id}" data-window-id="${windowId}" data-group-id="${tab.groupId}"${winCheckedTabIds.has(tab.id) ? ' checked' : ''}></td>
    <td class="win-sub-title" colspan="3" title="${escHtml(tab.title || tab.url)}">${escHtml(tab.title || tab.url)}</td>
    <td class="win-sub-url" title="${escHtml(tab.url)}">${escHtml(shortUrl(tab.url))}</td>
    <td></td>
  `;
  return tr;
}

function bindWindowDynamicEvents() {
  document.querySelectorAll('.win-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.windowId);
      if (cb.checked) winCheckedWindowIds.add(id);
      else winCheckedWindowIds.delete(id);
      updateWindowActionBar();
    });
  });

  document.querySelectorAll('.win-tab-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.tabId);
      if (cb.checked) winCheckedTabIds.add(id);
      else winCheckedTabIds.delete(id);
      updateWindowActionBar();
    });
  });

  // A group checkbox is only a bulk toggle over its member tabs — the tab boxes
  // stay the single source of truth for what actually moves.
  document.querySelectorAll('.win-group-check').forEach(cb => {
    cb.addEventListener('change', () => {
      document.querySelectorAll(`.win-tab-check[data-group-id="${cb.dataset.groupId}"]`)
        .forEach(t => {
          t.checked = cb.checked;
          const id = Number(t.dataset.tabId);
          if (cb.checked) winCheckedTabIds.add(id);
          else winCheckedTabIds.delete(id);
        });
      updateWindowActionBar();
    });
  });

  document.querySelectorAll('.win-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.windowId);
      if (expandedWindowIds.has(id)) expandedWindowIds.delete(id);
      else expandedWindowIds.add(id);
      renderWindowTable();
    });
  });

  document.querySelectorAll('.window-title').forEach(el => {
    el.addEventListener('click', async () => {
      // Focusing another window dismisses this popup — that is the point.
      try {
        await chrome.windows.update(Number(el.dataset.windowId), { focused: true });
      } catch (err) {
        setWinStatus(err.message, true);
      }
    });
  });

  document.querySelectorAll('.btn-row-close').forEach(btn => {
    btn.addEventListener('click', () => confirmCloseWindows([Number(btn.dataset.windowId)]));
  });
}

function updateWindowActionBar() {
  const winIds = getCheckedWindowIds();
  const checkedTabs = getCheckedWinTabs();

  $('btn-suspend-windows').disabled = winIds.length === 0;
  $('btn-close-windows').disabled = winIds.length === 0;

  // ── Merge: 2+ windows, all on the same side of the incognito boundary ──
  const mergeable = winIds.length >= 2 && uniformIncognito(winIds) !== null;
  const mergeSel = $('win-merge-target');
  const prevTarget = mergeSel.value;
  mergeSel.innerHTML = '';
  if (mergeable) {
    const chosen = windowList.filter(w => winIds.includes(w.id));
    chosen.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = windowLabel(w);
      mergeSel.appendChild(opt);
    });
    // Default to the focused window when it is part of the selection.
    const preferred = chosen.find(w => String(w.id) === prevTarget)
      || chosen.find(w => w.focused)
      || chosen[0];
    mergeSel.value = String(preferred.id);
  }
  mergeSel.disabled = !mergeable;
  $('btn-merge-windows').disabled = !mergeable;

  const hint = $('win-merge-hint');
  if (winIds.length >= 2 && !mergeable) {
    hint.textContent = 'Incognito and regular windows can’t be merged together.';
    hint.className = 'merge-hint error';
  } else {
    hint.textContent = '';
    hint.className = 'merge-hint';
  }

  // ── Move tabs: targets limited to the checked tabs' side of the boundary ──
  const sourceWindowIds = [...new Set(checkedTabs.map(t => t.windowId))];
  const targets = compatibleTargets(sourceWindowIds);
  const moveSel = $('win-move-select');
  const prevMove = moveSel.value;
  moveSel.innerHTML = '<option value="">Move tabs to…</option>';
  targets.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = windowLabel(w);
    moveSel.appendChild(opt);
  });
  if (targets.length > 0) {
    const opt = document.createElement('option');
    opt.value = 'new';
    opt.textContent = 'New window';
    moveSel.appendChild(opt);
  }
  moveSel.value = [...moveSel.options].some(o => o.value === prevMove) ? prevMove : '';
  const straddles = checkedTabs.length > 0 && targets.length === 0;
  moveSel.disabled = checkedTabs.length === 0 || straddles;
  moveSel.title = straddles
    ? 'The checked tabs span incognito and regular windows — they can’t move together.'
    : 'Move the checked tabs to another window. Tabs that belong to a group leave that group.';

  // ── Select-all checkbox state ──
  const allChecked = winIds.length === allWindows.length && allWindows.length > 0;
  $('win-select-all').checked = allChecked;
  $('win-select-all').indeterminate = winIds.length > 0 && !allChecked;
}

function getCheckedWindowIds() {
  return allWindows.filter(w => winCheckedWindowIds.has(w.id)).map(w => w.id);
}

function getCheckedWinTabs() {
  return allWindows.flatMap(w => w.tabs).filter(t => winCheckedTabIds.has(t.id));
}

function clearWinSelection() {
  winCheckedWindowIds.clear();
  winCheckedTabIds.clear();
}

// ── Window operations ────────────────────────────────────────────────────────

async function onMergeWindows() {
  const ids = getCheckedWindowIds();
  if (ids.length < 2) return;
  if (uniformIncognito(ids) === null) {
    setWinStatus('Incognito and regular windows can’t be merged together.', true);
    return;
  }

  const targetId = Number($('win-merge-target').value);
  if (!targetId || !ids.includes(targetId)) return;

  // Capture the label now — window numbering shifts once source windows close.
  const targetLabel = windowLabel(windowList.find(w => w.id === targetId));
  const sources = allWindows.filter(w => ids.includes(w.id) && w.id !== targetId);

  try {
    for (const src of sources) {
      // Groups move as groups: chrome.tabs.move would pull their tabs out of the
      // group on the way across, so tabGroups.move is the only way to land a
      // group in another window intact (and keep its id, and so its tracked age).
      for (const g of src.groups) {
        await chrome.tabGroups.move(g.id, { windowId: targetId, index: -1 });
      }
      const looseIds = src.ungrouped.map(t => t.id);
      if (looseIds.length > 0) {
        await chrome.tabs.move(looseIds, { windowId: targetId, index: -1 });
      }
      // Chrome closes a window on its own once the last tab leaves it.
    }
    setWinStatus(`Merged ${sources.length} window${sources.length !== 1 ? 's' : ''} into ${targetLabel}.`);
  } catch (err) {
    setWinStatus(`Merge failed: ${err.message}`, true);
  }

  clearWinSelection();
  await loadData();
  renderAll();
}

function confirmCloseWindows(ids) {
  if (ids.length === 0) return;
  const tabCount = allWindows
    .filter(w => ids.includes(w.id))
    .reduce((n, w) => n + w.tabs.length, 0);

  pendingConfirm = { kind: 'close-windows', ids };
  $('confirm-msg').textContent =
    `Close ${ids.length} window${ids.length !== 1 ? 's' : ''} and ${tabCount} tab${tabCount !== 1 ? 's' : ''}? ` +
    `The tabs will be closed, not just ungrouped.`;
  $('confirm-ok').textContent = 'Close';
  $('confirm-overlay').classList.add('visible');
}

async function doCloseWindows(ids) {
  let closed = 0;
  for (const id of ids) {
    // A window can already be gone (merged away, or closed by hand) — skip it
    // rather than aborting the rest of the batch.
    try {
      await chrome.windows.remove(id);
      closed++;
    } catch (_) { /* already closed */ }
  }
  setWinStatus(`Closed ${closed} window${closed !== 1 ? 's' : ''}.`);
  clearWinSelection();
  await loadData();
  renderAll();
}

async function onSuspendWindows() {
  const ids = getCheckedWindowIds();
  if (ids.length === 0) return;

  const tabs = allWindows.filter(w => ids.includes(w.id)).flatMap(w => w.tabs);
  const { attempted, suspended } = await discardTabs(tabs);

  if (attempted === 0) {
    setWinStatus('Nothing to suspend (tabs are active or already suspended).', true);
    return;
  }
  setWinStatus(`Suspended ${suspended} tab${suspended !== 1 ? 's' : ''} in ${ids.length} window${ids.length !== 1 ? 's' : ''}.`);
  await loadData();
  renderAll();
}

async function onMoveTabsToWindow() {
  const sel = $('win-move-select');
  const choice = sel.value;
  if (!choice) return;

  const tabs = getCheckedWinTabs();
  if (tabs.length === 0) { sel.value = ''; return; }

  const sourceWindowIds = [...new Set(tabs.map(t => t.windowId))];
  const targets = compatibleTargets(sourceWindowIds);
  if (targets.length === 0) {
    setWinStatus('Tabs can’t move between incognito and regular windows.', true);
    sel.value = '';
    return;
  }

  const tabIds = tabs.map(t => t.id);
  try {
    if (choice === 'new') {
      // Seeding with tabId alone makes the new window inherit that tab's
      // incognito state; created unfocused so this panel stays open.
      const win = await chrome.windows.create({ tabId: tabIds[0], focused: false });
      if (tabIds.length > 1) {
        await chrome.tabs.move(tabIds.slice(1), { windowId: win.id, index: -1 });
      }
      setWinStatus(`Moved ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} to a new window.`);
    } else {
      const targetId = Number(choice);
      // Re-check against the freshly computed target list rather than trusting
      // the dropdown, in case windows changed since it was built.
      if (!targets.some(w => w.id === targetId)) {
        setWinStatus('Tabs can’t move between incognito and regular windows.', true);
        sel.value = '';
        return;
      }
      await chrome.tabs.move(tabIds, { windowId: targetId, index: -1 });
      setWinStatus(`Moved ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''}.`);
    }
  } catch (err) {
    setWinStatus(`Move failed: ${err.message}`, true);
  }

  sel.value = '';
  clearWinSelection();
  await loadData();
  renderAll();
}

// ── Create window from tabs ──────────────────────────────────────────────────

function openNewWindow() {
  setNwStatus('');
  const list = $('nw-tab-list');
  list.innerHTML = '';

  allWindows.forEach(w => {
    if (w.tabs.length === 0) return;

    const head = document.createElement('div');
    head.className = 'cg-window-head';
    head.textContent = `${windowLabel(w)} (${w.tabs.length} tab${w.tabs.length !== 1 ? 's' : ''})`;
    list.appendChild(head);

    w.tabs.forEach(t => {
      const row = document.createElement('label');
      row.className = 'cg-tab-row';
      row.innerHTML = `
        <input type="checkbox" class="nw-check" data-tab-id="${t.id}" data-window-id="${w.id}">
        <span class="cg-tab-title" title="${escHtml(t.title || t.url)}">${escHtml(t.title || t.url)}</span>
      `;
      list.appendChild(row);
    });
  });

  list.querySelectorAll('.nw-check').forEach(cb => {
    cb.addEventListener('change', updateNewWindowState);
  });

  updateNewWindowState();
  $('newwindow-overlay').classList.add('visible');
}

function updateNewWindowState() {
  applyIncognitoGuard('.nw-check');
  $('nw-create').disabled = document.querySelectorAll('.nw-check:checked').length === 0;
}

async function onCreateWindow() {
  const boxes = [...document.querySelectorAll('.nw-check:checked')];
  if (boxes.length === 0) {
    setNwStatus('Select at least one tab.', true);
    return;
  }
  const sourceWindowIds = [...new Set(boxes.map(cb => Number(cb.dataset.windowId)))];
  if (uniformIncognito(sourceWindowIds) === null) {
    setNwStatus('Incognito and regular tabs can’t share a window.', true);
    return;
  }

  const ids = boxes.map(cb => Number(cb.dataset.tabId));
  try {
    // tabId alone — the new window inherits that tab's incognito state, and
    // passing `incognito` alongside `tabId` can conflict with it.
    const win = await chrome.windows.create({ tabId: ids[0], focused: false });
    if (ids.length > 1) {
      await chrome.tabs.move(ids.slice(1), { windowId: win.id, index: -1 });
    }
  } catch (err) {
    setNwStatus(`Create failed: ${err.message}`, true);
    return;
  }

  closeNewWindow();
  setWinStatus(`Created a window from ${ids.length} tab${ids.length !== 1 ? 's' : ''}.`);
  await loadData();
  renderAll();
}

async function onCreateEmptyWindow() {
  try {
    await chrome.windows.create({ focused: false });
  } catch (err) {
    setNwStatus(`Create failed: ${err.message}`, true);
    return;
  }
  closeNewWindow();
  setWinStatus('Created an empty window.');
  await loadData();
  renderAll();
}

function closeNewWindow() {
  $('newwindow-overlay').classList.remove('visible');
  $('nw-tab-list').innerHTML = '';
}

/**
 * Grey out every tab sitting on the far side of the incognito boundary from
 * whatever is already checked, so a picker can never assemble a selection that
 * Chrome would refuse to move. Clearing the selection restores the full list.
 * Returns the selection's incognito state, or null when nothing is checked.
 */
function applyIncognitoGuard(checkboxSelector) {
  const boxes = [...document.querySelectorAll(checkboxSelector)];
  const checkedWindowIds = boxes.filter(b => b.checked).map(b => Number(b.dataset.windowId));
  const state = checkedWindowIds.length > 0 ? uniformIncognito(checkedWindowIds) : null;

  boxes.forEach(b => {
    const blocked = state !== null && incognitoOf(Number(b.dataset.windowId)) !== state;
    b.disabled = blocked;
    b.closest('.cg-tab-row')?.classList.toggle('blocked', blocked);
  });
  return state;
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderTable() {
  const tbody = $('groups-body');
  tbody.innerHTML = '';

  if (allGroups.length === 0) {
    $('empty-state').style.display = 'block';
    $('groups-table').style.display = 'none';
    updateActionBar(); // otherwise buttons keep the enabled state of the last render
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
  $('btn-suspend').disabled = count === 0 || isSplitting;

  // Rebuild the move targets from the checked groups' own windows, so a target
  // across the incognito boundary is never on offer in the first place.
  const sourceWindowIds = [...new Set(
    checked.map(id => allGroups.find(g => g.group.id === id)?.group.windowId).filter(Boolean)
  )];
  const targets = compatibleTargets(sourceWindowIds);
  const sel = $('move-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Move to…</option>';
  targets.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = windowLabel(w);
    sel.appendChild(opt);
  });
  sel.value = targets.some(w => String(w.id) === prev) ? prev : '';

  const straddles = count > 0 && targets.length === 0;
  sel.disabled = count === 0 || isSplitting || straddles;
  sel.title = straddles
    ? 'The selected groups span incognito and regular windows — they can’t move together.'
    : 'Move selected groups to another window';

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

  // Suspend button
  $('btn-suspend').addEventListener('click', onSuspend);

  // Move to window
  $('move-select').addEventListener('change', onMoveToWindow);

  // Create group from tabs
  $('btn-new-group').addEventListener('click', openCreateGroup);
  $('cg-cancel').addEventListener('click', closeCreateGroup);
  $('cg-create').addEventListener('click', onCreateGroup);
  $('cg-target').addEventListener('change', () => { cgTargetUserPicked = true; });

  // Export
  $('btn-export').addEventListener('click', onExport);

  // Import
  $('btn-import').addEventListener('change', onImport);

  // View toggle
  $('tab-groups-view').addEventListener('click', () => switchView('groups'));
  $('tab-windows-view').addEventListener('click', () => switchView('windows'));

  // Windows view
  $('win-select-all').addEventListener('change', e => {
    if (e.target.checked) allWindows.forEach(w => winCheckedWindowIds.add(w.id));
    else winCheckedWindowIds.clear();
    renderWindowTable();
  });
  $('btn-merge-windows').addEventListener('click', onMergeWindows);
  $('btn-suspend-windows').addEventListener('click', onSuspendWindows);
  $('btn-close-windows').addEventListener('click', () => confirmCloseWindows(getCheckedWindowIds()));
  $('win-move-select').addEventListener('change', onMoveTabsToWindow);

  // Create window from tabs
  $('btn-new-window').addEventListener('click', openNewWindow);
  $('nw-cancel').addEventListener('click', closeNewWindow);
  $('nw-create').addEventListener('click', onCreateWindow);
  $('nw-empty').addEventListener('click', onCreateEmptyWindow);

  // Confirm overlay — shared by group delete and window close, so the pending
  // action decides what OK actually does.
  $('confirm-cancel').addEventListener('click', () => {
    $('confirm-overlay').classList.remove('visible');
    pendingConfirm = null;
  });
  $('confirm-ok').addEventListener('click', () => {
    $('confirm-overlay').classList.remove('visible');
    const pending = pendingConfirm;
    pendingConfirm = null;
    if (!pending) return;
    if (pending.kind === 'close-windows') doCloseWindows(pending.ids);
    else doDelete(pending.ids);
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
  renderAll();
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
  renderAll();
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
    $('confirm-ok').textContent = 'Delete';
    pendingConfirm = { kind: 'delete-groups', ids };
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
  await loadData();
  renderAll();
}

// ── Suspend ──────────────────────────────────────────────────────────────────

/**
 * Discard whatever in `tabs` can be discarded. Skips each window's active tab
 * (discard rejects on it) and tabs already discarded, and catches per tab so one
 * failure doesn't abort the batch. Shared by the group and window suspend paths.
 */
async function discardTabs(tabs) {
  const ids = tabs.filter(t => !t.active && !t.discarded).map(t => t.id);
  if (ids.length === 0) return { attempted: 0, suspended: 0 };

  const results = await Promise.all(
    ids.map(id => chrome.tabs.discard(id).then(() => true).catch(() => false))
  );
  return { attempted: ids.length, suspended: results.filter(Boolean).length };
}

async function onSuspend() {
  const ids = getCheckedGroupIds();
  if (ids.length === 0) return;

  const tabs = ids.flatMap(id => allGroups.find(g => g.group.id === id)?.tabs || []);
  const { attempted, suspended } = await discardTabs(tabs);

  if (attempted === 0) {
    setStatus('Nothing to suspend (tabs are active or already suspended).', true);
    return;
  }
  setStatus(`Suspended ${suspended} tab${suspended !== 1 ? 's' : ''} in ${ids.length} group${ids.length !== 1 ? 's' : ''}.`);
  await loadData();
  renderAll();
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

  // Re-check the boundary against live data rather than trusting the dropdown.
  const sourceWindowIds = [...new Set(
    ids.map(id => allGroups.find(g => g.group.id === id)?.group.windowId).filter(Boolean)
  )];
  if (!compatibleTargets(sourceWindowIds).some(w => w.id === targetWindowId)) {
    setStatus('Groups can’t move between incognito and regular windows.', true);
    $('move-select').value = '';
    return;
  }

  try {
    for (const groupId of ids) {
      // Moving the group itself keeps its id, and therefore its tracked age.
      // The previous move-tabs-then-regroup path minted a fresh group every
      // time, so every move silently reset the Age column to "< 1m".
      await chrome.tabGroups.move(groupId, { windowId: targetWindowId, index: -1 });
    }
    setStatus(`Moved ${ids.length} group${ids.length > 1 ? 's' : ''} to window.`);
  } catch (err) {
    setStatus(`Move failed: ${err.message}`, true);
  }

  $('move-select').value = '';
  await loadData();
  renderAll();
}

// ── Create group from tabs ────────────────────────────────────────────────────

async function openCreateGroup() {
  cgTargetUserPicked = false;
  $('cg-name').value = '';
  buildColorSwatches('cg-color-swatches', 'grey');
  setCgStatus('');

  // Fresh query so the picker reflects current windows/tabs.
  const [windows, tabs] = await Promise.all([
    chrome.windows.getAll({ populate: false, windowTypes: ['normal'] }),
    chrome.tabs.query({})
  ]);

  // Same numbering as the main table — both route through buildWindowLabels.
  const { winMap } = buildWindowLabels(windows);

  cgTabs = tabs
    .filter(t => winMap[t.windowId]) // normal windows only
    .map(t => ({
      id: t.id,
      title: t.title || t.url || '(untitled)',
      windowId: t.windowId,
      groupId: t.groupId,
      active: t.active
    }));

  // Map groupId → {title, color} for in-group badges.
  const groupMeta = {};
  allGroups.forEach(({ group }) => {
    groupMeta[group.id] = { title: group.title, color: group.color };
  });

  // The target dropdown is built in updateCreateGroupState — its contents depend
  // on which side of the incognito boundary the selected tabs are on.

  // Render tab list grouped by window.
  const list = $('cg-tab-list');
  list.innerHTML = '';
  windowList.forEach(w => {
    const winTabs = cgTabs.filter(t => t.windowId === w.id);
    if (winTabs.length === 0) return;

    const head = document.createElement('div');
    head.className = 'cg-window-head';
    head.textContent = `${windowLabel(w)} (${winTabs.length} tab${winTabs.length !== 1 ? 's' : ''})`;
    list.appendChild(head);

    winTabs.forEach(t => {
      const row = document.createElement('label');
      row.className = 'cg-tab-row';
      const meta = t.groupId !== -1 ? groupMeta[t.groupId] : null;
      const badge = meta
        ? `<span class="cg-group-badge"><span class="cg-group-dot" style="background:${COLOR_CSS[meta.color] || '#ccc'}"></span>${escHtml(meta.title || 'in group')}</span>`
        : '';
      row.innerHTML = `
        <input type="checkbox" class="cg-check" data-tab-id="${t.id}" data-window-id="${t.windowId}">
        <span class="cg-tab-title" title="${escHtml(t.title)}">${escHtml(t.title)}</span>
        ${badge}
      `;
      list.appendChild(row);
    });
  });

  list.querySelectorAll('.cg-check').forEach(cb => {
    cb.addEventListener('change', updateCreateGroupState);
  });

  updateCreateGroupState();
  $('creategroup-overlay').classList.add('visible');
}

function updateCreateGroupState() {
  const state = applyIncognitoGuard('.cg-check');
  const checked = [...document.querySelectorAll('.cg-check:checked')];
  $('cg-create').disabled = checked.length === 0;

  // Offer only targets on the same side of the incognito boundary as the
  // selection — grouping tabs means moving them into one window first.
  const target = $('cg-target');
  const prev = target.value;
  const allowed = state === null ? windowList : windowList.filter(w => w.incognito === state);
  target.innerHTML = '';
  allowed.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = windowLabel(w);
    target.appendChild(opt);
  });
  if (allowed.some(w => String(w.id) === prev)) target.value = prev;

  // Auto-default the target to the window with the most selected tabs,
  // unless the user has manually overridden it.
  if (!cgTargetUserPicked && checked.length > 0) {
    const counts = {};
    checked.forEach(cb => {
      const wid = cb.dataset.windowId;
      counts[wid] = (counts[wid] || 0) + 1;
    });
    const best = Object.keys(counts).reduce((a, b) => counts[b] > counts[a] ? b : a);
    if (allowed.some(w => String(w.id) === best)) target.value = best;
  }
}

async function onCreateGroup() {
  const boxes = [...document.querySelectorAll('.cg-check:checked')];
  if (boxes.length === 0) {
    setCgStatus('Select at least one tab.', true);
    return;
  }

  const target = Number($('cg-target').value);
  if (!target) {
    setCgStatus('Pick a target window.', true);
    return;
  }

  // Grouping means gathering the tabs into one window first, so the whole
  // selection plus the target must sit on one side of the incognito boundary.
  const sourceWindowIds = [...new Set(boxes.map(cb => Number(cb.dataset.windowId)))];
  if (!compatibleTargets(sourceWindowIds).some(w => w.id === target)) {
    setCgStatus('Tabs can’t be grouped across incognito and regular windows.', true);
    return;
  }

  const ids = boxes.map(cb => Number(cb.dataset.tabId));
  try {
    await chrome.tabs.move(ids, { windowId: target, index: -1 });
    const gId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: target } });
    await chrome.tabGroups.update(gId, {
      title: $('cg-name').value.trim() || undefined,
      color: getSelectedSwatch('cg-color-swatches')
    });
  } catch (err) {
    setCgStatus(`Create failed: ${err.message}`, true);
    return;
  }

  closeCreateGroup();
  setStatus(`Created group from ${ids.length} tab${ids.length !== 1 ? 's' : ''}.`);
  await loadData();
  renderAll();
}

function closeCreateGroup() {
  $('creategroup-overlay').classList.remove('visible');
  $('cg-tab-list').innerHTML = '';
  cgTabs = [];
  cgTargetUserPicked = false;
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
  renderAll();
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

function writeStatus(elId, msg, isError) {
  const el = $(elId);
  el.textContent = msg;
  el.className = `status-line ${isError ? 'error' : 'success'}`;
  if (msg) {
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
  }
}

function setStatus(msg, isError = false) { writeStatus('status', msg, isError); }
function setWinStatus(msg, isError = false) { writeStatus('win-status', msg, isError); }
function setNwStatus(msg, isError = false) { writeStatus('nw-status', msg, isError); }
function setCgStatus(msg, isError = false) { writeStatus('cg-status', msg, isError); }
