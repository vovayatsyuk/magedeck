import { reactive, computed, watch, shallowRef } from 'vue';
import * as api from './api.js';
import {
  visibleModules,
  enabledFirst,
  filterMembers as membersOf,
  inferVerb,
  pickTargets,
  rangeSelect,
  selectedNames,
  legacyEntry,
  entryTime,
  dependentsIn,
  plural,
  BUILTIN_FILTERS,
  matches,
  parseSshTarget,
  snapshotChanges,
} from './logic.js';

/** Mac spells its modifiers with symbols; nothing else does. */
const mac = /Mac/.test(navigator.platform || navigator.userAgent);
export const KEYS = mac
  ? { search: '⌘K', confirm: '⌘↩', reload: '⌘R', alt: '⌥' }
  : { search: 'Ctrl+K', confirm: 'Ctrl+Enter', reload: 'Ctrl+R', alt: 'Alt' };

const GREEN = '#3f9a54';
const RED = '#d0563e';

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const state = reactive({
  magentos: [],
  magentoId: null,

  // Current magento only.
  modules: [],
  snapshots: [],
  history: [],

  // Global, persisted.
  filters: [],
  presets: [],
  locked: [],

  query: '',
  filter: 'All modules', // built-in name, or a saved filter's id
  checked: {}, // name -> seq, so chips keep selection order

  running: false,
  // Command in flight, `{ enable, disable, source }`; rows show their target state.
  pending: null,
  // Lets views skip animations during a magento switch.
  switching: false,
  dialog: null,
  form: {},
  modulesError: '',
  formError: '',
  checking: false,
});

let seq = 0;
let historySeq = 0;
// Rows are prepended, so an index key would break keyed patching and animations.
const historyId = () => `h${Date.now().toString(36)}${(++historySeq).toString(36)}`;
let lastIndex = null;
const nextSeq = () => ++seq;

// Enabled first, by the state each module had when the view last changed — a
// filter, a search, another install, modules added or gone — not by its state
// now. A row the user just switched stays put instead of jumping halves.
const sortedOn = shallowRef(new Map());
watch(
  [() => state.magentoId, () => state.filter, () => state.query, () => state.modules.map((m) => m.name).join('\n')],
  () => (sortedOn.value = new Map(state.modules.map((m) => [m.name, m.on]))),
  { immediate: true },
);

export const visible = computed(() =>
  enabledFirst(
    visibleModules(state.modules, state.filter, state.query, state.checked, state.filters, state.locked),
    sortedOn.value,
  ),
);

export const selected = computed(() => selectedNames(state.modules, state.checked));

export const filterMembers = computed(() => {
  const out = {};
  for (const key of [...BUILTIN_FILTERS, ...state.filters.map((f) => f.id)]) {
    out[key] = membersOf(state.modules, key, state.checked, state.filters, state.locked);
  }
  return out;
});

export const lockedSet = computed(() => new Set(state.locked));

// Locked modules move only via their own switch, the Locked filter, history
// replay, or a snapshot or preset. Every other bulk action must filter targets
// through one of these two.
const unlocked = (names) => names.filter((n) => !lockedSet.value.has(n));

export const movableIn = (key, modules) =>
  key === 'Locked' ? modules : modules.filter((m) => !lockedSet.value.has(m.name));

export const magento = computed(() => state.magentos.find((m) => m.id === state.magentoId) || null);

export function displayPath(m) {
  if (!m) return '';
  return m.kind === 'ssh' ? `ssh://${m.user ? `${m.user}@` : ''}${m.host}:${m.path}` : m.path;
}

// The last action becomes the primary (⌘↩).
export function showError(title, detail, actions = []) {
  openDialog('alert', {}, {
    title,
    body: String(detail?.message ?? detail),
    actions: actions.filter(Boolean),
  });
}

// Loose match: Magento's wording changes between versions.
const forcible = (message) => /constraint|depend/i.test(message);

async function guard(title, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(title, error);
    showError(title, error);
  }
}

export async function init() {
  await guard('Could not load your data', async () => {
    state.filters = await api.loadFilters();
    state.locked = await api.loadLocked();
    state.presets = await api.loadPresets();
    state.magentos = await api.magentoList();
    await api.pruneMagentos(state.magentos.map((m) => m.id));
    const last = await api.lastMagentoId();
    const pick = state.magentos.find((m) => m.id === last) || state.magentos[0];
    if (pick) await selectMagento(pick.id);
    else openDialog('install', { type: 'local' }, { mode: 'create' });
  });
}

// Runs after every command too: a partial failure may leave states unapplied. Never throws.
async function refreshModules(id = state.magentoId) {
  try {
    state.modules = await api.moduleList(id);
    state.modulesError = '';
  } catch (error) {
    state.modules = [];
    state.modulesError = String(error?.message ?? error);
  }
}

/** Re-reads the current install's modules, for ones installed since they were
 *  loaded. It shows as a switch to the same install: the picker spins. */
export async function reloadModules() {
  if (!state.magentoId || state.running || state.switching) return;
  state.switching = true;
  try {
    await refreshModules();
    // A module gone from config.php cannot stay selected.
    const names = new Set(state.modules.map((m) => m.name));
    for (const name of Object.keys(state.checked)) if (!names.has(name)) delete state.checked[name];
  } finally {
    state.switching = false;
  }
}

// Legacy rows have `verb` + `names`, or only `cmd`, which may hold one line per
// verb. One without an id predates ids too: a fresh one would date it today.
function migrateEntry(h) {
  const row = h.id ? { ...h, at: entryTime(h) } : { ...h, id: historyId(), at: null };
  if (row.cmd?.includes('\n')) row.cmd = row.cmd.split('\n').join(' && ');
  if (row.enable || row.disable) return row;
  const { verb, names = [] } = row.names ? row : { ...row, ...(legacyEntry(row.cmd) ?? {}) };
  return { ...row, enable: verb === 'enable' ? names : [], disable: verb === 'disable' ? names : [] };
}

export async function selectMagento(id) {
  state.switching = true;
  try {
    state.magentoId = id;
    lastIndex = null;
    state.checked = {};
    const [, snapshots, history] = await Promise.all([
      refreshModules(id),
      api.loadSnapshots(id),
      api.loadHistory(id),
    ]);
    state.snapshots = snapshots ?? [];
    state.history = history.map(migrateEntry);
    await api.saveLastMagentoId(id);
    // `null` means never stored; an empty list means the user cleared them.
    if (snapshots === null) await ensureInitialSnapshot();
  } finally {
    state.switching = false;
  }
}

export function toggleModule(name, event) {
  const names = visible.value.map((m) => m.name);
  const index = names.indexOf(name);
  if (event?.shiftKey && lastIndex !== null && lastIndex !== index) {
    state.checked = rangeSelect(state.checked, names, lastIndex, index, !state.checked[name], nextSeq);
  } else if (state.checked[name]) {
    delete state.checked[name];
  } else {
    state.checked[name] = nextSeq();
  }
  lastIndex = index;
}

export function toggleAll() {
  lastIndex = null;
  const rows = visible.value;
  const allChecked = rows.length > 0 && rows.every((m) => state.checked[m.name]);
  for (const m of rows) {
    if (allChecked) delete state.checked[m.name];
    else if (!state.checked[m.name]) state.checked[m.name] = nextSeq();
  }
}

// A range, since a fast drag skips rows.
export function setCheckedRange(from, to, on) {
  const names = visible.value.map((m) => m.name);
  state.checked = rangeSelect(state.checked, names, from, to, on, nextSeq);
  lastIndex = to;
}

export function deselect(name) {
  delete state.checked[name];
}

export function clearSelection() {
  lastIndex = null;
  state.checked = {};
}

export function setQuery(q) {
  lastIndex = null;
  state.query = q;
}

export function setFilter(key) {
  lastIndex = null;
  state.filter = key;
}

// Least to most preferred: the last becomes the alert's primary.
function retryFor(enable, disable, title, detail, force, source) {
  if (force || !forcible(detail)) return [];
  // Dependents are named for whichever verb failed, so they can only be
  // added back to a one-sided run. A restore gets the plain retry.
  const side = enable.length && !disable.length ? enable : disable.length && !enable.length ? disable : null;
  const deps = side ? unlocked(dependentsIn(detail, side)) : [];
  return [
    { label: 'Retry with -f', onOk: () => applyPlan(enable, disable, title, { force: true, source }) },
    deps.length && {
      label: `Retry with deps (+${deps.length})`,
      onOk: () =>
        applyPlan(
          side === enable ? [...enable, ...deps] : enable,
          side === disable ? [...disable, ...deps] : disable,
          `${title} + deps`,
          { source },
        ),
    },
  ].filter(Boolean);
}

// Both directions in one call, so a restore is never left half-applied.
export async function applyPlan(enable, disable, title, { force = false, source = null } = {}) {
  // Single-flight: every entry point funnels through here.
  if ((!enable.length && !disable.length) || state.running) return false;
  state.running = true;
  state.pending = { enable: new Set(enable), disable: new Set(disable), source };
  try {
    const result = await api.moduleApply(state.magentoId, enable, disable, force);
    await refreshModules();
    state.history.unshift({
      id: historyId(),
      title,
      enable,
      disable,
      cmd: result.command,
      time: now(),
      at: Date.now(),
      dot: enable.length ? GREEN : RED,
    });
    await api.saveHistory(state.magentoId, state.history);
    return true;
  } catch (error) {
    console.error('module:apply failed', error);
    const detail = String(error?.message ?? error);
    const count = enable.length + disable.length;
    showError(`Could not apply ${plural(count)}`, detail, retryFor(enable, disable, title, detail, force, source));
    return false;
  } finally {
    state.running = false;
    state.pending = null;
  }
}

/** Flushes the cache, and the generated static files first when asked. It
 *  goes to history, but there is nothing in it to revert or replay. */
export async function flushCache(staticContent) {
  if (!state.magentoId || state.running) return false;
  state.running = true;
  state.pending = { enable: new Set(), disable: new Set(), source: staticContent ? 'flush:static' : 'flush:cache' };
  try {
    const result = await api.magentoFlush(state.magentoId, staticContent);
    state.history.unshift({
      id: historyId(),
      kind: 'flush',
      title: staticContent ? 'Flushed cache and static content' : 'Flushed cache',
      enable: [],
      disable: [],
      cmd: result.command,
      time: now(),
      at: Date.now(),
    });
    await api.saveHistory(state.magentoId, state.history);
    return true;
  } catch (error) {
    console.error('magento:flush failed', error);
    showError(staticContent ? 'Could not flush cache and static content' : 'Could not flush cache', error);
    return false;
  } finally {
    state.running = false;
    state.pending = null;
  }
}

export const apply = (verb, names, title, opts) =>
  verb === 'enable' ? applyPlan(names, [], title, opts) : applyPlan([], names, title, opts);

export async function confirmApply(verb, modules, { scope, fromSelection = false, source = null } = {}) {
  const names = modules.map((m) => m.name);
  if (!names.length) return;
  // Fetched from the backend so it matches what actually runs.
  const command = await api.moduleCommand(state.magentoId, verb, names).catch(() => '');
  openDialog('apply', {}, { verb, names, scope, fromSelection, command, source });
}

/** What a bulk enable or disable works from: the selection, or else the
 *  visible list, less locked modules outside the Locked filter. */
const bulkPool = () =>
  movableIn(
    state.filter,
    selected.value.length ? state.modules.filter((m) => state.checked[m.name]) : visible.value,
  );

export async function confirmFromKeyboard(opposite = false) {
  const pool = bulkPool();
  let verb = inferVerb(pool);
  if (opposite) verb = verb === 'enable' ? 'disable' : 'enable';
  await confirmApply(verb, pickTargets(verb, pool), { fromSelection: selected.value.length > 0 });
}

/** Only the modules the verb would change, as ⌘↩ picks them. */
export async function applyFromButton(verb) {
  const targets = pickTargets(verb, bulkPool());
  if (!selected.value.length) {
    await confirmApply(verb, targets);
    return;
  }
  if (!targets.length) return;
  const names = targets.map((m) => m.name);
  await apply(verb, names, `${verb === 'enable' ? 'Enabled' : 'Disabled'} ${plural(names.length)}`);
}

export async function applyFilter(key, verb) {
  const targets = pickTargets(verb, movableIn(key, filterMembers.value[key] || []));
  const saved = state.filters.find((f) => f.id === key);

  if (!targets.length) return;
  if (saved) {
    const verbed = verb === 'enable' ? 'Enabled' : 'Disabled';
    await apply(verb, targets.map((m) => m.name), `${verbed} filter · ${saved.name}`, { source: key });
    return;
  }
  await confirmApply(verb, targets, {
    scope: `Applies to every module in the “${key}” filter, ignoring the current search.`,
    source: key,
  });
}

const snapshotOf = (name) => ({
  id: `s${Date.now()}`,
  name,
  time: now(),
  on: state.modules.filter((m) => m.on).length,
  off: state.modules.filter((m) => !m.on).length,
  state: Object.fromEntries(state.modules.map((m) => [m.name, m.on ? 1 : 0])),
});

async function persistSnapshots() {
  await api.saveSnapshots(state.magentoId, state.snapshots);
}

async function ensureInitialSnapshot() {
  if (state.snapshots.length || !state.modules.length) return;
  state.snapshots = [snapshotOf('Initial state')];
  await persistSnapshots();
}

/** What a snapshot is called when its name is left blank. */
export const defaultSnapshotName = () => `Snapshot ${state.snapshots.length + 1}`;

export async function createSnapshot(name) {
  state.snapshots.unshift(snapshotOf(name || defaultSnapshotName()));
  await persistSnapshots();
}

export async function renameSnapshot(id, name) {
  const s = state.snapshots.find((x) => x.id === id);
  if (!s) return;
  s.name = name;
  await persistSnapshots();
}

export async function deleteSnapshot(id) {
  state.snapshots = state.snapshots.filter((s) => s.id !== id);
  await persistSnapshots();
}

export const snapshotPlan = (snapshot) => snapshotChanges(state.modules, snapshot);

export async function restoreSnapshot(snapshot) {
  const { enable, disable } = snapshotPlan(snapshot);
  if (!enable.length && !disable.length) return;
  clearSelection();
  await applyPlan(enable, disable, `Restored ${snapshot.name}`);
}

export const presetPlan = (preset) => snapshotChanges(state.modules, preset);

export async function applyPreset(preset) {
  const { enable, disable } = presetPlan(preset);
  if (!enable.length && !disable.length) return;
  await applyPlan(enable, disable, `Applied preset · ${preset.name}`, { source: preset.id });
}

export function confirmPresetAdd(names, add, { title, nested = false }) {
  const locked = names.filter((n) => lockedSet.value.has(n));
  if (!locked.length) return add(names);
  const k = locked.length;
  const which =
    k === names.length
      ? k === 1 ? `${locked[0]} is locked` : `All ${k} are locked`
      : `${k} of them ${k === 1 ? 'is' : 'are'} locked`;
  openDialog(
    'confirm',
    {},
    {
      title,
      body: `${which}. Applying the preset will switch ${k === 1 ? 'it' : 'them'} regardless of the lock.`,
      actions: [
        k < names.length && { label: 'Skip locked', onOk: () => add(unlocked(names)) },
        { label: 'Add anyway', onOk: () => add(names) },
      ].filter(Boolean),
      parent: nested ? { dialog: state.dialog, form: state.form } : undefined,
    },
  );
}

export async function savePreset(preset) {
  const next = preset.id ? { ...preset } : { ...preset, id: `p${Date.now()}` };
  const i = state.presets.findIndex((p) => p.id === next.id);
  if (i === -1) state.presets.unshift(next);
  else state.presets[i] = next;
  await api.savePresets(state.presets);
}

export async function addToPreset(id, names) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  const on = new Map(state.modules.map((m) => [m.name, m.on]));
  const add = names.filter((n) => on.has(n)).map((n) => [n, on.get(n) ? 1 : 0]);
  await savePreset({ ...preset, state: { ...preset.state, ...Object.fromEntries(add) } });
}

export async function removeFromPreset(id, names) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  const next = { ...preset.state };
  for (const n of names) delete next[n];
  await savePreset({ ...preset, state: next });
}

async function removeFromPresets(names) {
  const drop = new Set(names);
  state.presets = state.presets.map((p) =>
    Object.keys(p.state || {}).some((n) => drop.has(n))
      ? { ...p, state: Object.fromEntries(Object.entries(p.state).filter(([n]) => !drop.has(n))) }
      : p,
  );
  await api.savePresets(state.presets);
}

export function movePreset(from, to) {
  const list = state.presets;
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  state.presets = next;
}

export const persistPresets = () => api.savePresets(state.presets);

export async function deletePreset(id) {
  state.presets = state.presets.filter((p) => p.id !== id);
  await api.savePresets(state.presets);
}

export async function clearHistory() {
  state.history = [];
  await api.saveHistory(state.magentoId, []);
}

export async function addToFilter(id, names) {
  const filter = state.filters.find((f) => f.id === id);
  if (!filter) return;
  await saveFilter({ ...filter, members: [...new Set([...(filter.members || []), ...names])] });
}

export async function removeFromFilter(id, names) {
  const filter = state.filters.find((f) => f.id === id);
  if (!filter) return;
  const drop = new Set(names);
  await saveFilter({ ...filter, members: (filter.members || []).filter((n) => !drop.has(n)) });
}

export async function lockModules(names) {
  state.locked = [...new Set([...state.locked, ...names])];
  await api.saveLocked(state.locked);
}

function namesList(names) {
  const q = names.map((n) => `“${n}”`);
  if (q.length <= 3) return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q.at(-1)}` : q[0];
  return `${q.slice(0, 2).join(', ')} and ${q.length - 2} more`;
}

export function confirmLock(names, { nested = false } = {}) {
  const fresh = unlocked(names);
  const lock = (dropFromPresets) =>
    guard('Could not lock the modules', async () => {
      if (nested) closeDialog();
      await lockModules(names);
      if (dropFromPresets) await removeFromPresets(fresh);
    });

  const presets = state.presets.filter((p) => fresh.some((n) => n in (p.state || {})));
  if (!presets.length) return lock(false);

  const held = fresh.filter((n) => presets.some((p) => n in p.state));
  const k = held.length;
  const who =
    fresh.length === 1 ? `${held[0]} is` : k === fresh.length ? `All ${k} are` : `${k} of them ${k === 1 ? 'is' : 'are'}`;
  openDialog(
    'confirm',
    {},
    {
      title: `Lock ${fresh.length === 1 ? fresh[0] : plural(fresh.length)}?`,
      body: `${who} in ${presets.length === 1 ? 'the preset' : 'presets'} ${namesList(presets.map((p) => p.name))}. Applying a preset switches its modules even when they are locked.`,
      actions: [
        { label: 'Lock anyway', onOk: () => lock(false) },
        { label: 'Lock and remove from presets', onOk: () => lock(true) },
      ],
      width: '620px',
      parent: nested ? { dialog: state.dialog, form: state.form } : undefined,
    },
  );
}

export async function unlockModules(names) {
  const drop = new Set(names);
  state.locked = state.locked.filter((n) => !drop.has(n));
  await api.saveLocked(state.locked);
}

export const isEditableFilter = (key) => key === 'Locked' || state.filters.some((f) => f.id === key);

export function openAddModules() {
  const key = state.filter;
  if (!isEditableFilter(key)) return;
  const name = key === 'Locked' ? key : state.filters.find((f) => f.id === key).name;
  openDialog('addModules', { query: '', picks: [] }, { key, name });
}

/** The modules a filter or preset form already holds. */
const formModules = (dialog, form) =>
  dialog.kind === 'preset' ? Object.keys(form.state || {}) : form.members || [];

/** Picks into the open filter or preset form, which comes back on close. */
export function openFormAddModules() {
  const parent = { dialog: state.dialog, form: state.form };
  const name = String(state.form.name ?? '').trim();
  openDialog('addModules', { query: '', picks: [] }, { name, parent });
}

export const addCandidates = computed(() => {
  const d = state.dialog;
  if (d?.kind !== 'addModules') return [];
  const have = d.parent
    ? new Set(formModules(d.parent.dialog, d.parent.form))
    : new Set((filterMembers.value[d.key] || []).map((m) => m.name));
  const query = state.form.query || '';
  return state.modules
    .filter((m) => !have.has(m.name) && matches(m, query))
    .sort((a, b) => a.name.localeCompare(b.name));
});

export function toggleAddPick(name) {
  const picks = state.form.picks || [];
  state.form.picks = picks.includes(name) ? picks.filter((n) => n !== name) : [...picks, name];
}

// With no picks, an empty search would add every module, so require a query.
export const addAllTargets = computed(() => {
  const picks = state.form.picks || [];
  if (picks.length) return picks;
  return String(state.form.query ?? '').trim() ? addCandidates.value.map((m) => m.name) : [];
});

export async function saveFilter(filter) {
  const next = filter.id ? { ...filter } : { ...filter, id: `f${Date.now()}` };
  const i = state.filters.findIndex((f) => f.id === next.id);
  if (i === -1) state.filters.push(next);
  else state.filters[i] = next;
  await api.saveFilters(state.filters);
}

// In memory only: saving each drag step would race, so callers persist on release.
export function moveFilter(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.filters.length || to >= state.filters.length) return;
  const next = [...state.filters];
  next.splice(to, 0, next.splice(from, 1)[0]);
  state.filters = next;
}

export const persistFilters = () => api.saveFilters(state.filters);

export async function deleteFilter(id) {
  state.filters = state.filters.filter((f) => f.id !== id);
  if (state.filter === id) state.filter = 'All modules';
  await api.saveFilters(state.filters);
}

export async function saveMagento(m) {
  const isNew = !m.id;
  const saved = await api.magentoSave(m);
  const i = state.magentos.findIndex((x) => x.id === saved.id);
  if (i === -1) state.magentos.push(saved);
  else state.magentos[i] = saved;
  if (isNew || !state.magentoId || state.magentoId === saved.id) await selectMagento(saved.id);
}

export function moveMagento(from, to) {
  const list = state.magentos;
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  state.magentos = next;
}

export const persistMagentos = () => api.magentoReorder(state.magentos.map((m) => m.id));

export async function deleteMagento(id) {
  // Order matters: a failure strands snapshots (swept at launch) instead of
  // wiping those of a magento that survives.
  await api.magentoDelete(id);
  await api.deleteMagentoUiData(id);
  state.magentos = state.magentos.filter((m) => m.id !== id);
  if (state.magentoId === id) {
    const next = state.magentos[0];
    if (next) await selectMagento(next.id);
    else Object.assign(state, { magentoId: null, modules: [], snapshots: [], history: [] });
  }
}

export function openDialog(kind, form = {}, extra = {}) {
  mirrored = '';
  state.dialog = { kind, ...extra };
  state.form = form;
  state.formError = '';
}

watch(() => state.form, () => (state.formError = ''), { deep: true });

export function closeDialog() {
  const parent = state.dialog?.parent;
  if (!parent) {
    state.dialog = null;
    return;
  }
  state.dialog = parent.dialog;
  state.form = parent.form;
  state.formError = '';
}

export const dialogCommand = computed(() =>
  state.dialog?.kind === 'apply' ? state.dialog.command : '',
);

// Here, not in the component: ⌘↩ calls `dialogPrimary` directly.
const REQUIRED = {
  install: (f) => {
    if (f.type !== 'ssh') return ['path', 'title'];
    const auth = { key: ['keyPath'], password: ['password'] }[f.auth] ?? [];
    return ['host', 'remotePath', ...auth, 'title'];
  },
  filter: () => ['name'],
  preset: () => ['name'],
  // A new one may go unnamed and takes the default; a rename may not blank it.
  snapshot: () => (state.dialog?.mode === 'edit' ? ['name'] : []),
};

export const requiredFields = computed(() => REQUIRED[state.dialog?.kind]?.(state.form) ?? []);

export const missingFields = computed(() =>
  requiredFields.value.filter((k) => !String(state.form[k] ?? '').trim()),
);

export async function browseFolder() {
  const picked = await api.pickFolder(state.form.path);
  if (!picked) return;
  state.form.path = picked;
  mirrorTitle(basename(picked));
}

function spreadSshTarget(text) {
  const parsed = parseSshTarget(text);
  if (!parsed?.host) return;
  Object.assign(state.form, parsed);
  if (parsed.keyPath) state.form.auth = 'key';
}

// The last auto-filled title; anything else was typed by hand and is kept.
let mirrored = '';

function mirrorTitle(value) {
  const f = state.form;
  if (!value) return;
  if (String(f.title ?? '').trim() && f.title !== mirrored) return;
  f.title = value;
  mirrored = value;
}

const basename = (path) => path.replace(/\/+$/, '').split('/').pop() || path;

export function hostTyped(text) {
  spreadSshTarget(text);
  mirrorTitle(state.form.host);
}

export function pathTyped(text) {
  mirrorTitle(basename(text));
}

export async function browseKey() {
  const picked = await api.pickKeyFile(state.form.keyPath);
  if (picked) state.form.keyPath = picked;
}

const FAILURE_TITLE = {
  delete: 'Could not delete that',
  filter: 'Could not save the filter',
  preset: 'Could not save the preset',
  snapshot: 'Could not save the snapshot',
  install: 'Could not save the Magento install',
};

export async function dialogPrimary() {
  const d = state.dialog;
  if (!d) return;
  const f = state.form;
  if (state.checking) return;
  if (missingFields.value.length) {
    state.formError = 'Fill in the highlighted fields.';
    return;
  }

  if (d.kind === 'addModules') {
    const names = addAllTargets.value;
    if (!names.length) return;
    if (d.parent) {
      const form = d.parent.form;
      if (d.parent.dialog.kind !== 'preset') {
        form.members = [...new Set([...(form.members || []), ...names])];
        closeDialog();
        return;
      }
      const on = new Map(state.modules.map((m) => [m.name, m.on ? 1 : 0]));
      const title = `Add ${plural(names.length)} to ${d.name ? `“${d.name}”` : 'the preset'}?`;
      confirmPresetAdd(
        names,
        (add) => {
          form.state = { ...form.state, ...Object.fromEntries(add.map((n) => [n, on.get(n) ?? 1])) };
          closeDialog();
        },
        { title, nested: true },
      );
      return;
    }
    if (d.key === 'Locked') {
      confirmLock(names, { nested: true });
      return;
    }
    closeDialog();
    await guard('Could not add the modules', () => addToFilter(d.key, names));
    return;
  }

  const install =
    d.kind === 'install'
      ? {
          id: d.id || '',
          title: f.title.trim(),
          kind: f.type === 'ssh' ? 'ssh' : 'local',
          path: (f.type === 'ssh' ? f.remotePath : f.path) || '',
          host: f.type === 'ssh' ? f.host : undefined,
          user: f.type === 'ssh' ? f.user : undefined,
          port: f.type === 'ssh' ? Number(f.port) || undefined : undefined,
          auth: f.type === 'ssh' ? f.auth || 'agent' : 'agent',
          keyPath: f.type === 'ssh' && f.auth === 'key' ? f.keyPath : undefined,
          password: f.type === 'ssh' && f.auth !== 'agent' ? f.password : undefined,
          php: String(f.php ?? '').trim() || undefined,
          version: f.version || '',
        }
      : null;

  if (install) {
    state.checking = true;
    try {
      await api.magentoCheck(install);
    } catch (error) {
      state.formError = String(error);
      return;
    } finally {
      state.checking = false;
    }
  }

  closeDialog();

  if (d.kind === 'alert' || d.kind === 'confirm') {
    await d.actions?.at(-1)?.onOk?.();
    return;
  }

  if (d.kind === 'apply') {
    const verbed = d.verb === 'enable' ? 'Enabled' : 'Disabled';
    await apply(d.verb, d.names, `${verbed} ${plural(d.names.length)}`, { source: d.source });
    return;
  }

  await guard(FAILURE_TITLE[d.kind] || 'Something went wrong', async () => {
    if (d.kind === 'delete') {
      await d.onOk?.();
      return;
    }
    if (d.kind === 'filter') {
      await saveFilter({
        id: d.id,
        name: f.name.trim(),
        color: f.color || '#3b82f6',
        query: (f.query || '').trim(),
        members: [...new Set(f.members || [])],
      });
      return;
    }
    if (d.kind === 'preset') {
      await savePreset({ id: d.id, name: f.name.trim(), state: { ...(f.state || {}) } });
      return;
    }
    if (d.kind === 'snapshot') {
      const name = (f.name || '').trim();
      await (d.mode === 'edit' ? renameSnapshot(d.id, name) : createSnapshot(name));
      return;
    }
    if (d.kind === 'install') {
      await saveMagento(install);
    }
  });
}

export async function dialogAction(action) {
  closeDialog();
  await action?.onOk?.();
}

export function confirmDelete({ title, body, okLabel, onOk }) {
  openDialog('delete', {}, { title, body, okLabel, onOk });
}
