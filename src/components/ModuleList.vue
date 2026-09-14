<script setup>
import { computed, ref, nextTick, onMounted, onUnmounted, watch, watchEffect } from 'vue';
import { state, visible, toggleModule, toggleAll, setCheckedRange, setQuery, selected, openDialog, apply, addToFilter, removeFromFilter, addToPreset, removeFromPreset, confirmPresetAdd, confirmLock, lockedSet, unlockModules, isEditableFilter, openAddModules, setFilter } from '../store.js';
import { plural } from '../logic.js';
import Icon from './icons/Icon.vue';

const searchEl = ref(null);
const allEl = ref(null);
const scrollEl = ref(null);
const rowsEl = ref(null);

// Windowed rendering: rows are a fixed height, so the visible slice is
// arithmetic. Without it, rebuilding all 544 rows blocks for ~350ms.
const ROW_H = 34;
const OVERSCAN = 12;
// Re-window per block, so scrolling rebuilds every BLOCK rows, not every 34px.
const BLOCK = 16;

const scrollTop = ref(0);
const viewportH = ref(800);
// Offset of the rows box within the scroll content. Must be measured against
// the scroll container: offsetTop resolves against the nearest positioned
// ancestor instead, which folds in the search bar's height.
const rowsTop = ref(0);
const measureRowsTop = () => {
  const sc = scrollEl.value;
  const rows = rowsEl.value;
  if (!sc || !rows) return;
  rowsTop.value = rows.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
};

const first = computed(() => {
  const row = Math.floor((scrollTop.value - rowsTop.value) / ROW_H) - OVERSCAN;
  return Math.max(0, Math.floor(row / BLOCK) * BLOCK);
});
const last = computed(() => {
  const row = Math.ceil((scrollTop.value - rowsTop.value + viewportH.value) / ROW_H) + OVERSCAN;
  return Math.min(visible.value.length, Math.ceil(row / BLOCK) * BLOCK);
});
const windowed = computed(() => visible.value.slice(first.value, last.value));
const padTop = computed(() => first.value * ROW_H);
const padBottom = computed(() => Math.max(0, (visible.value.length - last.value) * ROW_H));

const onScroll = () => {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0;
};

watch(() => [state.query, state.filter, state.magentoId], async () => {
  if (scrollEl.value) scrollEl.value.scrollTop = 0;
  scrollTop.value = 0;
  await nextTick();
  measureRowsTop();
});

let ro;
onMounted(() => {
  window.addEventListener('mouseup', endPaint);
  window.addEventListener('blur', endPaint);
  ro = new ResizeObserver(() => {
    viewportH.value = scrollEl.value?.clientHeight ?? 800;
    measureRowsTop();
  });
  if (scrollEl.value) ro.observe(scrollEl.value);
});
onUnmounted(() => {
  window.removeEventListener('mouseup', endPaint);
  window.removeEventListener('blur', endPaint);
  ro?.disconnect();
});

const allChecked = computed(() => visible.value.length > 0 && visible.value.every((m) => state.checked[m.name]));
const someChecked = computed(() => visible.value.some((m) => state.checked[m.name]));

// `indeterminate` is a DOM property with no attribute, so it cannot be bound.
watchEffect(() => {
  if (allEl.value) allEl.value.indeterminate = someChecked.value && !allChecked.value;
});

// Drag-painting: the pressed row decides the target state and every row
// dragged across takes it. Shift-click still means range select.
let paintTo = null;
let paintedTo = -1;

/** Geometry, not per-row mouseenter: a fast drag jumps clean over rows and
 *  those never fire an enter. */
function rowIndexAt(clientY) {
  const el = scrollEl.value;
  if (!el) return -1;
  const y = clientY - el.getBoundingClientRect().top + el.scrollTop - rowsTop.value;
  const i = Math.floor(y / ROW_H);
  return Math.min(Math.max(i, 0), visible.value.length - 1);
}

function onRowDown(m, event) {
  if (event.button !== 0) return;
  if (event.shiftKey) {
    toggleModule(m.name, event);
    return;
  }
  paintTo = !state.checked[m.name];
  paintedTo = rowIndexAt(event.clientY);
  setCheckedRange(paintedTo, paintedTo, paintTo);
}

function onPaintMove(event) {
  if (paintTo === null) return;
  const i = rowIndexAt(event.clientY);
  if (i === paintedTo || i < 0) return;
  setCheckedRange(paintedTo, i, paintTo);
  paintedTo = i;
}

// Released anywhere, including outside the window.
const endPaint = () => {
  paintTo = null;
  paintedTo = -1;
};

/** While a command runs its modules show the state they are moving to: the
 *  switch is what you clicked, so that is where the feedback belongs. */
const busy = (m) => !!state.pending && (state.pending.enable.has(m.name) || state.pending.disable.has(m.name));
const shownOn = (m) => (busy(m) ? state.pending.enable.has(m.name) : m.on);

/** Runs straight away: one named module needs no confirmation, same rule as
 *  the Enable/Disable button with a selection. */
function toggleOne(m) {
  const verb = m.on ? 'disable' : 'enable';
  apply(verb, [m.name], `${m.on ? 'Disabled' : 'Enabled'} ${m.name}`);
}

const editable = computed(() => isEditableFilter(state.filter));
const filterName = computed(() => state.filters.find((f) => f.id === state.filter)?.name ?? state.filter);

/** Which of the header's menus is open: 'filter', 'preset', or neither. */
const menu = ref(null);
const addRoot = ref(null);
const toggleMenu = (name) => (menu.value = menu.value === name ? null : name);

const grouped = (f) => selected.value.every((name) => f.members?.includes(name));

function addTo(f) {
  menu.value = null;
  if (grouped(f)) removeFromFilter(f.id, selected.value);
  else addToFilter(f.id, selected.value);
}

/** Locked is a built-in, but its members are the user's to pick, the same
 *  way as a saved filter's. */
const allLocked = computed(() => selected.value.every((name) => lockedSet.value.has(name)));

function toggleLocked() {
  menu.value = null;
  if (allLocked.value) unlockModules(selected.value);
  else confirmLock(selected.value);
}

const onOutsideAdd = (e) => {
  if (menu.value && !addRoot.value?.contains(e.target)) menu.value = null;
};
const onEscape = (e) => {
  if (e.key !== 'Escape' || !menu.value) return;
  e.preventDefault();
  menu.value = null;
};

function saveAsFilter() {
  menu.value = null;
  openDialog('filter', { members: [...selected.value], color: '#06b6d4' }, { mode: 'create' });
}

/** A preset holds a state per module, so the selection counts as already in
 *  it only when every module is there in the state it is in now. Otherwise a
 *  click brings the preset up to date instead of taking the modules out. */
const onNow = computed(() => new Map(state.modules.map((m) => [m.name, m.on ? 1 : 0])));
const inPreset = (p) => selected.value.every((name) => p.state?.[name] === onNow.value.get(name));

function presetTo(p) {
  menu.value = null;
  const names = selected.value;
  if (inPreset(p)) removeFromPreset(p.id, names);
  else confirmPresetAdd(names, (add) => add.length && addToPreset(p.id, add), { title: `Add ${plural(names.length)} to “${p.name}”?` });
}

/** With no presets the menu would hold only "New preset…", so that runs. */
function openPresetMenu() {
  if (state.presets.length) toggleMenu('preset');
  else saveAsPreset();
}

function saveAsPreset() {
  menu.value = null;
  const names = selected.value;
  const create = (add) =>
    openDialog('preset', { state: Object.fromEntries(add.map((n) => [n, onNow.value.get(n)])) }, { mode: 'create' });
  confirmPresetAdd(names, create, { title: `Create a preset with ${plural(names.length)}?` });
}

onMounted(() => {
  searchEl.value?.focus();
  document.addEventListener('click', onOutsideAdd, true);
  document.addEventListener('keydown', onEscape);
});
onUnmounted(() => {
  document.removeEventListener('click', onOutsideAdd, true);
  document.removeEventListener('keydown', onEscape);
});
defineExpose({ focusSearch: () => searchEl.value?.focus() });
</script>

<template>
  <div class="list">
    <div class="searchbar" data-tauri-drag-region>
      <div class="field field-row">
        <Icon name="search" class="mag" />
        <input
          ref="searchEl"
          class="bare-input"
          :value="state.query"
          placeholder="Search modules and groups"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          @input="setQuery($event.target.value)"
        />
        <span v-if="!state.query" class="hint">⌘F</span>
        <span v-else class="clear" title="Clear" @click="setQuery('')"><Icon name="cross" /></span>
      </div>
    </div>

    <div v-if="visible.length" class="panel-head header">
      <div class="box">
        <input
          id="select-all-modules"
          ref="allEl"
          type="checkbox"
          title="Select all"
          :checked="allChecked"
          @change="toggleAll"
        />
      </div>
      <label for="select-all-modules" class="eyebrow">Modules</label>
      <span class="count">{{ visible.length }}</span>
      <div class="grow"></div>
      <div v-if="selected.length" ref="addRoot" class="addto">
        <div class="link savefilter" @click="toggleMenu('filter')">
          <Icon name="plus" />Add to filter
          <div v-if="menu === 'filter'" class="addmenu" @click.stop>
            <div
              class="additem"
              :title="allLocked ? 'Unlock these modules' : 'Lock these modules'"
              @click="toggleLocked"
            >
              <Icon name="lock" class="lockmark" />
              <span class="fname">Locked</span>
              <Icon v-if="allLocked" name="check" class="ftick" />
            </div>
            <div v-if="state.filters.length" class="addsep"></div>
            <div
              v-for="f in state.filters"
              :key="f.id"
              class="additem"
              :title="grouped(f) ? 'Remove these from the filter' : 'Add these to the filter'"
              @click="addTo(f)"
            >
              <span class="filter-dot" :style="{ background: f.color }"></span>
              <span class="fname">{{ f.name }}</span>
              <Icon v-if="grouped(f)" name="check" class="ftick" />
            </div>
            <div class="addsep"></div>
            <div class="additem new" title="Save these as a new filter" @click="saveAsFilter">
              <Icon name="plus" class="plus" />
              <span class="fname">New filter…</span>
            </div>
          </div>
        </div>
        <div class="link savefilter" @click="openPresetMenu">
          <Icon name="plus" />Add to preset
          <div v-if="menu === 'preset'" class="addmenu" @click.stop>
            <div
              v-for="p in state.presets"
              :key="p.id"
              class="additem"
              :title="inPreset(p) ? 'Remove these from the preset' : 'Add these to the preset as they are now'"
              @click="presetTo(p)"
            >
              <span class="nomark"></span>
              <span class="fname">{{ p.name }}</span>
              <Icon v-if="inPreset(p)" name="check" class="ftick" />
            </div>
            <div v-if="state.presets.length" class="addsep"></div>
            <div class="additem new" title="Save these, as they are now, as a new preset" @click="saveAsPreset">
              <Icon name="plus" class="plus" />
              <span class="fname">New preset…</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div ref="scrollEl" class="scroll" @scroll.passive="onScroll" @mousemove="onPaintMove">
      <div ref="rowsEl" :style="{ paddingTop: `${padTop}px`, paddingBottom: `${padBottom}px` }">
        <div
          v-for="m in windowed"
          :key="m.name"
          class="modrow"
          :class="{ picked: state.checked[m.name] }"
          @mousedown.prevent="onRowDown(m, $event)"
        >
          <div>
            <input type="checkbox" tabindex="-1" :checked="!!state.checked[m.name]" />
          </div>
          <div class="modname" :class="{ off: !m.on }">
            <span class="text">{{ m.name }}</span>
            <span
              v-if="lockedSet.has(m.name)"
              class="lockwrap"
              title="Module status is locked from mass operations"
              ><Icon name="lock" class="sm"
            /></span>
          </div>
          <div class="statuswrap">
            <span
              class="toggle"
              :class="{ on: shownOn(m), busy: busy(m) }"
              role="switch"
              :aria-checked="shownOn(m)"
              :aria-busy="busy(m)"
              :title="busy(m) ? 'Running…' : m.on ? 'Disable this module' : 'Enable this module'"
              @mousedown.stop.prevent="toggleOne(m)"
            >
              <span class="knob"></span>
            </span>
          </div>
        </div>
      </div>

      <div v-if="state.modulesError" class="empty problem">
        <span class="warn">!</span>
        <span>{{ state.modulesError }}</span>
      </div>
      <div v-else-if="!visible.length && state.query && state.filter !== 'All modules'" class="empty">
        Nothing found for “{{ state.query }}” in “{{ filterName }}” filter. <button type="button" class="link" @click="setFilter('All modules')">Search everywhere</button>
      </div>
      <div v-else-if="!visible.length && state.query" class="empty">Nothing found for “{{ state.query }}”</div>
      <div v-else-if="!visible.length && editable && state.modules.length" class="empty">
        Nothing in this filter yet. Use <span class="link" @click="openAddModules"><Icon name="plus" />Add modules</span> to fill it.
      </div>
      <!-- After the last row, so it is found where the list runs out. -->
      <div v-else-if="editable" class="extend">
        Press <span class="link" @click="openAddModules"><Icon name="plus" />Add modules</span> to extend this list
      </div>
      <div v-else-if="!state.modules.length && !state.magentoId" class="empty">
        No Magento installation yet. Add one from the picker above.
      </div>
      <div style="height: 18px"></div>
    </div>
  </div>
</template>

<style scoped>
.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-list);
}

.searchbar {
  flex: none;
  padding: 12px 16px;
  border-bottom: 1px solid #e2e5ea;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-chrome);
}

.field {
  flex: 1;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--mono);
}

.scroll {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  min-height: 0;
}

/* Outside the scroll container, so it holds position without `sticky`. */
.header {
  padding: 0 16px;
  background: var(--bg-list);
  border-bottom-color: #e6e9ed;
}

.box {
  width: 26px;
  display: flex;
  align-items: center;
}

.count {
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* A block link, so the menu below it hangs off the full row. */
.savefilter {
  position: relative;
  display: flex;
  margin: -4px 0;
  padding: 3px 4px;
}

.addto {
  position: relative;
  display: flex;
  gap: 10px;
}

.addmenu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 3px;
  z-index: 20;
  min-width: 160px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-white);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(15, 20, 30, 0.16);
}

.additem {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text-mid);
}

.additem:hover {
  background: var(--bg-tint);
}

.addsep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-soft);
}

/* Both take a dot's 7px in the layout, like the rail's Locked row, so the
   names line up: drawn wider, with the margins giving the difference back. */
.additem .lockmark,
.additem .plus {
  width: 11px;
  height: 11px;
  margin: 0 -2px;
}

/* A preset has no dot: its name still starts where the filters' do. */
.nomark {
  flex: none;
  width: 7px;
}

.additem .lockmark {
  color: var(--text-soft);
}

.additem.new {
  color: var(--blue);
}

.fname {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ftick {
  width: 13px;
  height: 13px;
  color: var(--blue);
}

/* What the click will do, on the row it will do it to. */
.additem:hover .ftick {
  color: var(--red);
}

/* The row handles every press, so the box is an indicator, not a target. */
.modrow input {
  pointer-events: none;
}

.modrow.picked {
  background: var(--blue-tint);
}

.problem {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 8px;
  padding: 48px 32px;
  text-align: left;
  color: #8c3520;
  word-break: break-word;
}

/* A size up, next to the 13px text of an empty list. */
.problem .warn {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  font-size: 11px;
}

.empty {
  padding: 64px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}

.extend {
  padding: 14px 16px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}

/* Mid-sentence, so it sits on the text's baseline and hugs its icon. */
.empty .link,
.extend .link {
  gap: 1px;
  vertical-align: bottom;
  font-size: inherit;
}
</style>
