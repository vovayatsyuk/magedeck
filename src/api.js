// Two stores: magentos live in Rust (`magentos.json`) because running
// bin/magento needs their path and ssh details; filters, presets, snapshots and
// history live here (`ui.json`) and Rust never reads them.

import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { keepOnly } from './logic.js';

const HISTORY_LIMIT = 200;

const SEED_FILTERS = [
  {
    id: 'all-but-core',
    name: 'All but core',
    color: '#ffffff',
    query: '!Magento_ !PayPal_ !Mollie_',
  },
];

/** Opens in the home dir unless a path is given. Resolves to null when the user cancels. */
export const pickFolder = async (defaultPath) =>
  open({ directory: true, multiple: false, defaultPath: defaultPath || (await homeDir()) });

/** Opens in `~/.ssh`, where the keys are and where a file dialog never starts. */
export const pickKeyFile = async (defaultPath) =>
  open({
    multiple: false,
    defaultPath: defaultPath || `${(await homeDir()).replace(/\/+$/, '')}/.ssh`,
  });

// ---------------------------------------------------------------- magentos

export const magentoList = () => invoke('magento_list');
export const magentoSave = (magento) => invoke('magento_save', { magento });
export const magentoDelete = (id) => invoke('magento_delete', { id });
export const magentoReorder = (ids) => invoke('magento_reorder', { ids });
export const magentoCheck = (magento) => invoke('magento_check', { magento });

// ----------------------------------------------------------------- modules

export const moduleList = (magentoId) => invoke('module_list', { magentoId });

/** The command the backend will run, for the confirm dialog to show. */
export const moduleCommand = (magentoId, verb, names, force = false) =>
  invoke('module_command', { magentoId, verb, names, force });

export const moduleApply = (magentoId, enable, disable, force = false) =>
  invoke('module_apply', { magentoId, enable, disable, force });

// ---------------------------------------------------------------- ui state

let uiStore;
async function ui() {
  if (!uiStore) uiStore = await load('ui.json');
  return uiStore;
}

async function read(key, fallback) {
  const value = await (await ui()).get(key);
  return value === undefined || value === null ? fallback : value;
}

async function write(key, value) {
  return writeAll({ [key]: value });
}

/** One save for several keys, so a crash cannot land between them. */
async function writeAll(entries) {
  const store = await ui();
  for (const [key, value] of Object.entries(entries)) await store.set(key, value);
  await store.save();
}

export async function loadFilters() {
  const stored = await read('filters', null);
  if (stored) return stored;
  await write('filters', SEED_FILTERS);
  return SEED_FILTERS;
}

export const saveFilters = (filters) => write('filters', filters);

/** Global like the filters: a preset names modules, not an install, and
 *  applies to whichever Magento has them. */
export const loadPresets = () => read('presets', []);
export const savePresets = (presets) => write('presets', presets);

/** Module names, global like the filters: a module worth guarding on one
 *  install is usually worth guarding on the others. */
export const loadLocked = () => read('locked', []);
export const saveLocked = (names) => write('locked', names);

export const lastMagentoId = () => read('lastMagentoId', null);
export const saveLastMagentoId = (id) => write('lastMagentoId', id);

async function readSlice(key, magentoId) {
  return (await read(key, {}))[magentoId] || [];
}

async function writeSlice(key, magentoId, list) {
  const all = await read(key, {});
  await write(key, { ...all, [magentoId]: list });
}

/**
 * null means no stored entry — the only case that may mint an "Initial
 * state". An empty array means the user deleted them all, and seeding over
 * that would destroy real data.
 */
export async function loadSnapshots(magentoId) {
  const all = await read('snapshots', {});
  return Object.prototype.hasOwnProperty.call(all, magentoId) ? all[magentoId] : null;
}
export const saveSnapshots = (magentoId, list) => writeSlice('snapshots', magentoId, list);

export const loadHistory = (magentoId) => readSlice('history', magentoId);
export const saveHistory = (magentoId, list) =>
  writeSlice('history', magentoId, list.slice(0, HISTORY_LIMIT));

/**
 * Call this *after* deleting the magento itself: the two files cannot be
 * written atomically, and an interruption should strand snapshots (swept by
 * `pruneMagentos`) rather than wipe those of a magento that still exists.
 */
export async function deleteMagentoUiData(magentoId) {
  const [snapshots, history] = [await read('snapshots', {}), await read('history', {})];
  delete snapshots[magentoId];
  delete history[magentoId];
  await writeAll({ snapshots, history });
}

/** Startup sweep, so an interrupted delete self-heals. */
export async function pruneMagentos(validIds) {
  const entries = {};
  const snapshots = keepOnly(await read('snapshots', {}), validIds);
  if (snapshots) entries.snapshots = snapshots;
  const history = keepOnly(await read('history', {}), validIds);
  if (history) entries.history = history;

  const last = await read('lastMagentoId', null);
  if (last && !validIds.includes(last)) entries.lastMagentoId = null;

  if (Object.keys(entries).length) await writeAll(entries);
}
