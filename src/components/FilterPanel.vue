<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { state, filterMembers, movableIn, setFilter, applyFilter, openDialog, confirmDelete, deleteFilter, moveFilter, persistFilters, presetPlan, applyPreset, deletePreset, movePreset, persistPresets } from '../store.js';
import { plural, BUILTIN_DOTS } from '../logic.js';
import Icon from './icons/Icon.vue';

const editing = ref(false);

const NO_ACTIONS = ['All modules', 'Enabled', 'Locked'];

const PLAIN_COUNTS = ['Enabled', 'Disabled', 'Selected', 'Locked'];

// Count covers every member; ▶ and ■ only the ones this row may move.
const tally = (key, members, plain = false) => {
  const on = members.filter((m) => m.on).length;
  const movable = movableIn(key, members);
  const movableOn = movable.filter((m) => m.on).length;
  return {
    count: plain ? members.length : `${on} of ${members.length}`,
    anyOn: movableOn > 0,
    anyOff: movableOn < movable.length,
  };
};

const builtins = computed(() =>
  Object.keys(BUILTIN_DOTS).map((name) => ({
    name,
    key: name,
    dot: BUILTIN_DOTS[name],
    ...tally(name, filterMembers.value[name] || [], PLAIN_COUNTS.includes(name)),
    actionable: !NO_ACTIONS.includes(name),
  })),
);

const customs = computed(() =>
  state.filters.map((f) => ({
    name: f.name,
    key: f.id,
    dot: f.color,
    ...tally(f.id, filterMembers.value[f.id] || []),
    custom: f,
  })),
);

// Plain mouse events: HTML5 drag-and-drop misbehaves in this WebView.
function reorderable({ list, move, persist, editing, selector }) {
  const group = ref(null);
  const dragging = ref(null);
  let dragged = false;

  let bandTop = 0;
  let bandStep = 0;

  // Uses geometry captured at mousedown: live rects lag Vue patches and FLIP transforms.
  function indexAt(clientY) {
    if (!bandStep) return -1;
    const i = Math.floor((clientY - bandTop) / bandStep);
    return Math.min(Math.max(i, 0), list().length - 1);
  }

  function start(key, event) {
    // Cleared on press: a drag ending outside the rail fires no click.
    dragged = false;
    if (!editing.value || event.button !== 0) return;
    const els = group.value?.$el?.querySelectorAll(selector) ?? [];
    if (els.length < 2) return;
    bandTop = els[0].getBoundingClientRect().top;
    bandStep = els[1].getBoundingClientRect().top - bandTop;
    event.preventDefault();
    dragging.value = list().findIndex((x) => x.id === key);
  }

  function onDrag(event) {
    if (dragging.value === null) return;
    const to = indexAt(event.clientY);
    if (to === -1 || to === dragging.value) return;
    dragged = true;
    move(dragging.value, to);
    dragging.value = to;
  }

  function endDrag() {
    if (dragging.value === null) return;
    dragging.value = null;
    if (dragged) persist();
  }

  function clicked() {
    if (!dragged) return true;
    dragged = false;
    return false;
  }

  onMounted(() => {
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);
  });
  onUnmounted(() => {
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', endDrag);
  });

  return { group, start, clicked };
}

const {
  group: rowsGroup,
  start: startDrag,
  clicked: filterClicked,
} = reorderable({
  list: () => state.filters,
  move: moveFilter,
  persist: persistFilters,
  editing,
  selector: '.row',
});

const running = (key) => state.pending?.source === key;

function onRowClick(row) {
  if (filterClicked()) setFilter(row.key);
}

function newFilter() {
  openDialog('filter', { color: '#3b82f6', members: [] }, { mode: 'create' });
}

function editFilter(f) {
  openDialog(
    'filter',
    {
      name: f.name,
      color: f.color,
      query: f.query || '',
      members: [...(f.members || [])],
    },
    { mode: 'edit', id: f.id },
  );
}

const editingPresets = ref(false);

const presetRows = computed(() =>
  state.presets.map((p) => {
    const states = Object.values(p.state || {});
    const on = states.filter((v) => v === 1).length;
    const { enable, disable } = presetPlan(p);
    const changes = [enable.length && `enables ${plural(enable.length)}`, disable.length && `disables ${plural(disable.length)}`]
      .filter(Boolean)
      .join(', ');
    return { key: p.id, name: p.name, preset: p, on, off: states.length - on, changes };
  }),
);

watch(() => state.presets.length, (n) => n || (editingPresets.value = false));

const {
  group: presetGroup,
  start: startPresetDrag,
  clicked: presetClicked,
} = reorderable({
  list: () => state.presets,
  move: movePreset,
  persist: persistPresets,
  editing: editingPresets,
  selector: '.card',
});

function onPresetClick(row) {
  if (presetClicked() && !editingPresets.value) editPreset(row.preset);
}

function newPreset() {
  openDialog('preset', { state: {} }, { mode: 'create' });
}

function editPreset(p) {
  openDialog('preset', { name: p.name, state: { ...p.state } }, { mode: 'edit', id: p.id });
}

function removePreset(p) {
  confirmDelete({
    title: `Delete the “${p.name}” preset?`,
    body: 'Only the saved preset goes away. No module is touched.',
    okLabel: 'Delete preset',
    onOk: () => deletePreset(p.id),
  });
}

function removeFilter(f) {
  confirmDelete({
    title: `Delete the “${f.name}” filter?`,
    body: 'Only the saved filter goes away. No module is touched.',
    okLabel: 'Delete filter',
    onOk: () => deleteFilter(f.id),
  });
}
</script>

<template>
  <div class="rail">
    <div class="titlebar" data-tauri-drag-region></div>
    <div class="panel-head" :class="{ editing }">
      <span class="eyebrow grow">Filters</span>
      <span class="actions">
        <span
          class="glyph pencil"
          :class="{ on: editing }"
          :title="editing ? 'Done editing filters' : 'Edit filters'"
          @click="editing = !editing"
          ><Icon name="pencil" /></span
        >
        <span
          class="glyph plus"
          title="New custom filter"
          @click="newFilter"
          ><Icon name="plus" /></span
        >
      </span>
    </div>

    <div class="rows">
      <div
        v-for="row in builtins"
        :key="row.key"
        class="row"
        :class="{
          active: state.filter === row.key,
          swap: !editing && row.actionable && (row.anyOn || row.anyOff),
        }"
        @click="setFilter(row.key)"
      >
        <Icon v-if="row.key === 'Locked'" name="lock" class="lockmark" />
        <span v-else class="filter-dot" :class="{ spinning: running(row.key) }" :style="{ background: row.dot }"></span>
        <span class="label">{{ row.name }}</span>
        <span class="count">{{ row.count }}</span>
        <span v-if="!editing && row.actionable && (row.anyOn || row.anyOff)" class="actions">
          <span
            v-if="row.anyOn"
            class="glyph stop"
            title="Disable these modules"
            @click.stop="applyFilter(row.key, 'disable')"
            ><Icon name="stop" /></span
          >
          <span
            v-if="row.anyOff"
            class="glyph play"
            title="Enable these modules"
            @click.stop="applyFilter(row.key, 'enable')"
            ><Icon name="play" /></span
          >
        </span>
      </div>

      <div v-if="customs.length" class="sep"></div>

      <TransitionGroup ref="rowsGroup" tag="div" name="reorder" class="group">
        <div
          v-for="row in customs"
          :key="row.key"
          class="row custom"
          :class="{
            active: state.filter === row.key,
            editing: editing,
            swap: !editing && (row.anyOn || row.anyOff),
            grab: editing,
          }"
          @click="onRowClick(row)"
          @mousedown="startDrag(row.key, $event)"
        >
          <span class="filter-dot" :class="{ spinning: running(row.key) }" :style="{ background: row.dot }"></span>
          <span class="label">{{ row.name }}</span>
          <span class="count">{{ row.count }}</span>
          <span v-if="editing" class="actions">
            <span class="glyph edit" title="Edit filter" @click.stop="editFilter(row.custom)"><Icon name="pencil" /></span>
            <span class="glyph del" title="Delete filter" @click.stop="removeFilter(row.custom)"><Icon name="cross" /></span>
          </span>
          <span v-else-if="row.anyOn || row.anyOff" class="actions">
            <span
              v-if="row.anyOn"
              class="glyph stop"
              title="Disable these modules"
              @click.stop="applyFilter(row.key, 'disable')"
              ><Icon name="stop" /></span
            >
            <span
              v-if="row.anyOff"
              class="glyph play"
              title="Enable these modules"
              @click.stop="applyFilter(row.key, 'enable')"
              ><Icon name="play" /></span
            >
          </span>
        </div>
      </TransitionGroup>
    </div>

    <template v-if="state.presets.length">
      <div class="panel-head presets-head" :class="{ editing: editingPresets }">
        <span class="eyebrow grow">Presets</span>
        <span class="actions">
          <span
            class="glyph pencil"
            :class="{ on: editingPresets }"
            :title="editingPresets ? 'Done editing presets' : 'Edit presets'"
            @click="editingPresets = !editingPresets"
            ><Icon name="pencil" /></span
          >
          <span
            class="glyph plus"
            title="New preset"
            @click="newPreset"
            ><Icon name="plus" /></span
          >
        </span>
      </div>

      <TransitionGroup ref="presetGroup" tag="div" name="preset" class="cards">
        <div
          v-for="row in presetRows"
          :key="row.key"
          class="card card-row"
          :class="{ grab: editingPresets }"
          @click="onPresetClick(row)"
          @mousedown="startPresetDrag(row.key, $event)"
        >
          <div class="grow">
            <div class="name">{{ row.name }}</div>
            <div class="meta">{{ row.on }} on · {{ row.off }} off</div>
          </div>
          <div class="actions">
            <template v-if="editingPresets">
              <span class="glyph act edit" title="Edit preset" @click.stop="editPreset(row.preset)"><Icon name="pencil" /></span>
              <span class="glyph act del" title="Delete preset" @click.stop="removePreset(row.preset)"><Icon name="cross" /></span>
            </template>
            <span v-else-if="running(row.key)" class="spinslot"><span class="spinner"></span></span>
            <span
              v-else-if="row.changes"
              class="glyph act play hover-only"
              :title="`Apply preset: ${row.changes}`"
              @click.stop="applyPreset(row.preset)"
              ><Icon name="play" /></span
            >
            <span v-else-if="row.on + row.off" class="spinslot applied" title="Preset is in effect"><Icon name="check" /></span>
          </div>
        </div>
      </TransitionGroup>
    </template>
  </div>
</template>

<style scoped>
.rail {
  width: 214px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-rail);
  border-right: 1px solid var(--divider);
}

.titlebar {
  flex: none;
  height: 0;
}
.mac:not(.fullscreen) .titlebar {
  height: 38px;
}
.fullscreen .panel-head {
  padding-top: 7px;
}

.pencil.on,
.pencil.on:hover {
  background: var(--blue);
  color: #fff;
}

.plus {
  margin-right: -4px;
}

.presets-head {
  margin-top: 8px;
}

.preset-enter-active,
.preset-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.preset-enter-from,
.preset-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Out of flow, so the others can move into its place. */
.preset-leave-active {
  position: absolute;
  width: calc(100% - 16px);
}

.preset-move {
  transition: transform 0.18s ease;
}

@media (prefers-reduced-motion: reduce) {
  .preset-enter-active,
  .preset-leave-active,
  .preset-move {
    transition: none;
  }
}

.cards {
  padding: 0 8px 8px;
}

.rows,
.group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.rows {
  padding: 0 8px;
}

.sep {
  height: 1px;
  margin: 7px 6px;
  background: #dcdfe4;
}

.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px 6px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: #2b3038;
}

.row:hover {
  background: var(--hover-rail);
}

.row.grab {
  cursor: grab;
}

.row.grab:active {
  cursor: grabbing;
  background: #d7dbe1;
}

.row.active {
  background: var(--hover-rail);
}

/* Negative margins keep the layout width of a 7px dot. */
.lockmark {
  width: 11px;
  height: 11px;
  margin: 0 -2px;
  color: var(--text-soft);
}

.label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: 11px;
  color: var(--text-hint);
  font-variant-numeric: tabular-nums;
  margin-inline-end: 3px;
  letter-spacing: -0.015em;
}

.row.swap:hover .count,
.row.editing .count {
  display: none;
}

.stop:hover {
  color: var(--red);
}

.play:hover {
  color: var(--green-dark);
}

.applied {
  color: var(--green-dark);
}

.applied .icon {
  width: 12px;
  height: 12px;
}

.edit:hover {
  color: var(--blue);
}

.del:hover {
  color: var(--red);
}
</style>
