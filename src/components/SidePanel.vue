<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import MagentoPicker from './MagentoPicker.vue';
import { state, openDialog, deleteSnapshot, restoreSnapshot, snapshotPlan, clearHistory, confirmDelete, applyPlan } from '../store.js';
import { plural, withDayDividers } from '../logic.js';
import Icon from './icons/Icon.vue';

const newSnapshot = () => openDialog('snapshot', { name: '' }, { mode: 'create' });
const renameSnapshot = (s) => openDialog('snapshot', { name: s.name }, { mode: 'edit', id: s.id });

// Like presets: the pencil in the header swaps each card's restore for its
// rename and delete.
const editingSnapshots = ref(false);
watch(() => state.snapshots.length, (n) => n || (editingSnapshots.value = false));
watch(() => state.magentoId, () => (editingSnapshots.value = false));

function removeSnapshot(s) {
  confirmDelete({
    title: `Delete “${s.name}”?`,
    body: 'The snapshot is removed. Module states stay as they are now.',
    okLabel: 'Delete snapshot',
    onOk: () => deleteSnapshot(s.id),
  });
}

function askClearHistory() {
  confirmDelete({
    title: 'Clear command history?',
    body: 'History for this Magento installation is removed.',
    okLabel: 'Clear history',
    onOk: clearHistory,
  });
}

/**
 * Animate only when exactly one entry appears or disappears.
 *
 * A wholesale change must not transition: leaving rows go `position:
 * absolute`, and once they all leave flow together their static positions
 * collapse to the top of the container and they fade out as one pile.
 *
 * Compares ids, not lengths — a delta of one can still be a wholesale swap.
 * Pre-flush, so the flag is set before Vue patches.
 */
function incrementalOnly(ids) {
  const on = ref(false);
  let prev = new Set(ids());
  watch(ids, (next) => {
    const now = new Set(next);
    let added = 0;
    let removed = 0;
    for (const id of now) if (!prev.has(id)) added += 1;
    for (const id of prev) if (!now.has(id)) removed += 1;
    // One in and one out is still incremental: adding at the cap pushes the
    // oldest off the end. Switching magento is excluded outright, since two
    // installs with one entry each look exactly like that.
    on.value = !state.switching && added <= 1 && removed <= 1 && added + removed > 0;
    prev = now;
  });
  return on;
}

/** TransitionGroup measures and transforms every child. Measured on this
 *  WebView: 33ms at 25 entries, 76ms at 60, 157ms at 100, 447ms at 200. */
const MOVE_LIMIT = 40;

const HISTORY_PREVIEW = 20;
const showAllHistory = ref(false);

const shownHistory = computed(() =>
  showAllHistory.value ? state.history : state.history.slice(0, HISTORY_PREVIEW),
);
const hiddenHistory = computed(() => state.history.length - shownHistory.value.length);

/** Midnight turns today's rows into yesterday's, with nothing else to prompt
 *  a render: re-arm a timer for each one. */
const today = ref(Date.now());
let midnightTimer;
function armMidnight() {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  midnightTimer = setTimeout(() => {
    today.value = Date.now();
    armMidnight();
  }, next - d.getTime() + 1000);
}
armMidnight();
onUnmounted(() => clearTimeout(midnightTimer));

const historyRows = computed(() => withDayDividers(shownHistory.value, today.value));

// A new command collapses the list back to the recent slice.
watch(() => state.history[0]?.id, () => (showAllHistory.value = false));

const animateSnapshots = incrementalOnly(() => state.snapshots.map((s) => s.id));
const animateHistory = incrementalOnly(() => shownHistory.value.map((h) => h.id));

/** The card whose command was just copied: its ⧉ shows a tick for a moment.
 *  Only once the write resolves, so a refused clipboard never claims success. */
const copied = ref(null);
let copiedTimer;

async function copy(h) {
  try {
    await navigator.clipboard.writeText(h.cmd);
  } catch {
    return;
  }
  copied.value = h.id;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = null), 800);
}

onUnmounted(() => clearTimeout(copiedTimer));

/** ▶ and ↺ replay the recorded modules, never the command text. Locked ones
 *  included: a row repeats or undoes a command already run, so it is exempt
 *  from the lock the way a module's own switch is. */
const replayable = (h) => !!(h.enable?.length || h.disable?.length);

/** The history button whose command is in flight, `{ id, action }`. It turns
 *  into a spinner, like a snapshot's ▶, and holds its toolbar up after the
 *  pointer leaves: the eye is on the card that was clicked. */
const replaying = ref(null);
const isReplaying = (h, action) => replaying.value?.id === h.id && replaying.value.action === action;

async function replay(h, action, run) {
  // Refused while another command runs anyway; a spinner would only flash.
  if (!replayable(h) || state.running) return;
  replaying.value = { id: h.id, action };
  try {
    await run();
  } finally {
    replaying.value = null;
  }
}

const rerun = (h) => replay(h, 'rerun', () => applyPlan(h.enable, h.disable, h.title));

/** The two lists swapped — which is also how a restore is undone. */
const revert = (h) =>
  replay(h, 'revert', () =>
    applyPlan(h.disable, h.enable, `Reverted ${plural(h.enable.length + h.disable.length)}`),
  );

/** Per snapshot: whether restoring it would change anything, and how many of
 *  the modules it had on are gone from this install. One that would change
 *  nothing shows a ✓, as a preset in effect does, rather than a ▶ — unless a
 *  module it had on is missing, since the modules then do not match it. It
 *  stays restorable even so: a restore may still have something to switch,
 *  and the missing ones may be installed again by the time it is clicked. */
const plans = computed(
  () =>
    new Map(
      state.snapshots.map((s) => {
        const { enable, disable, missing } = snapshotPlan(s);
        const changes = enable.length + disable.length;
        return [
          s.id,
          {
            changes,
            missing: missing.length,
            title: changes
              ? 'Restore this snapshot'
              : `Nothing to switch · ${plural(missing.length)} it had on ${missing.length === 1 ? 'is' : 'are'} not installed here`,
          },
        ];
      }),
    ),
);

const planOf = (s) => plans.value.get(s.id) ?? { changes: 0, missing: 0, title: '' };

/** A restore takes as long as any other command, and the eye is on the row
 *  that was clicked, not on the pill in the corner. */
const restoring = ref(null);
async function restore(s) {
  restoring.value = s.id;
  try {
    await restoreSnapshot(s);
  } finally {
    restoring.value = null;
  }
}
</script>

<template>
  <div class="panel">
    <div class="picker">
      <MagentoPicker />
    </div>

    <template v-if="state.magentoId">
      <div class="rule"></div>

      <div class="panel-head" :class="{ editing: editingSnapshots }">
        <span class="eyebrow grow">Snapshots</span>
        <span class="actions">
          <span
            v-if="state.snapshots.length"
            class="glyph pencil"
            :class="{ on: editingSnapshots }"
            :title="editingSnapshots ? 'Done editing snapshots' : 'Edit snapshots'"
            @click="editingSnapshots = !editingSnapshots"
            ><Icon name="pencil" /></span
          >
          <span
            class="glyph plus"
            title="New snapshot"
            @click="newSnapshot"
            ><Icon name="plus" /></span
          >
        </span>
      </div>

      <TransitionGroup
        tag="div"
        :name="animateSnapshots ? 'entry' : 'nofx'"
        :class="['cards', 'snapshots', { nomove: state.snapshots.length > MOVE_LIMIT }]"
      >
        <div v-if="!state.snapshots.length" key="empty" class="hint">
          No snapshots yet. Create one to remember which modules are on/off right now.
        </div>
        <div v-for="s in state.snapshots" :key="s.id" class="card card-row">
          <div class="grow">
            <div class="name">{{ s.name }}</div>
            <div class="meta">
              {{ s.on }} on · {{ s.off }} off<span v-if="planOf(s).missing" class="gone"> · {{ planOf(s).missing }} not installed</span> · {{ s.time }}
            </div>
          </div>
          <div class="actions">
            <template v-if="editingSnapshots">
              <span class="glyph act edit" title="Rename snapshot" @click="renameSnapshot(s)"><Icon name="pencil" /></span>
              <span class="glyph act del" title="Delete snapshot" @click="removeSnapshot(s)"><Icon name="cross" /></span>
            </template>
            <span v-else-if="restoring === s.id" class="spinslot"><span class="spinner"></span></span>
            <span
              v-else-if="planOf(s).changes || planOf(s).missing"
              class="glyph act play hover-only"
              :class="{ idle: !planOf(s).changes }"
              :title="planOf(s).title"
              @click="restore(s)"
              ><Icon name="play-filled" /></span
            >
            <span v-else class="spinslot applied" title="Modules match this snapshot"><Icon name="check" /></span>
          </div>
        </div>
      </TransitionGroup>

      <div class="rule"></div>

      <div class="panel-head" v-if="state.history.length">
        <span class="eyebrow grow">History</span>
        <span class="link" title="Clear history" @click="askClearHistory">Clear</span>
      </div>

      <div class="history">
        <TransitionGroup
          tag="div"
          :name="animateHistory ? 'entry' : 'nofx'"
          :class="['cards', { nomove: shownHistory.length > MOVE_LIMIT }]"
        >
          <template v-for="h in historyRows" :key="h.divider ? h.key : h.id">
          <div v-if="h.divider" class="day" :title="h.title">{{ h.label }}</div>
          <div v-else class="card">
            <div class="toolbar" :class="{ busy: replaying?.id === h.id }">
              <template v-if="replayable(h)">
                <span v-if="isReplaying(h, 'revert')" class="spinslot"><span class="spinner"></span></span>
                <span v-else class="glyph act revert" title="Revert" @click="revert(h)"><Icon name="reset" /></span>
                <span v-if="isReplaying(h, 'rerun')" class="spinslot"><span class="spinner"></span></span>
                <span v-else class="glyph act" title="Run again" @click="rerun(h)"><Icon name="play" /></span>
              </template>
              <span
                class="glyph act"
                :class="{ done: copied === h.id }"
                :title="copied === h.id ? 'Copied' : 'Copy command'"
                @click="copy(h)"
                ><Icon :name="copied === h.id ? 'check' : 'copy'"
              /></span>
            </div>
            <div class="cmd">{{ h.time }} {{ h.cmd }}</div>
          </div>
          </template>
        </TransitionGroup>

        <div
          v-if="hiddenHistory || showAllHistory"
          class="showall"
          @click="showAllHistory = !showAllHistory"
        >
          {{ showAllHistory ? 'Show recent only' : `Show all (${hiddenHistory} more)` }}
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.entry-enter-active,
.entry-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

/* FLIP. Requires the absolute leave rule below, so a removal leaves a gap
   for the survivors to close. */
.entry-move {
  transition: transform 0.22s ease;
}

/* Killing the transition also makes Vue skip the inverse transforms
   entirely, not just the animation. */
.nomove .entry-move {
  transition: none;
}

.entry-enter-from,
.entry-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.entry-leave-active {
  position: absolute;
  width: calc(100% - 28px);
}

@media (prefers-reduced-motion: reduce) {
  .entry-enter-active,
  .entry-leave-active,
  .entry-move {
    transition: none;
  }
}

.picker {
  flex: none;
  padding: 12px 14px;
}

.panel {
  width: 272px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--divider);
}

/* The module list's MODULES header has a visible rule under it; this one
   keeps the transparent one `.panel-head` gives it and borrows the pixel
   back, so both titles sit on the same baseline. */
.panel-head {
  margin-top: 1px;
  margin-bottom: -1px;
}

.snapshots {
  position: relative;
  flex: none;
  max-height: 200px;
  overflow: auto;
  scrollbar-width: thin;
  padding: 0 14px 14px;
}

.rule {
  height: 1px;
  background: var(--border-soft);
  margin: 0 14px;
}

.history {
  flex: 1;
  overflow: auto;
  scrollbar-width: thin;
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.showall {
  flex: none;
  padding: 6px;
  text-align: center;
  font-size: 11.5px;
  color: var(--blue);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--bg-white);
}

.showall:hover {
  background: var(--bg-tint);
  color: var(--blue-dark);
}

.toolbar {
  position: absolute;
  visibility: hidden;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  margin-bottom: 5px;
  /* It sits over the command text: a fade from the left masks what runs
     under it without a hard edge cutting a name in half. White with zero
     alpha, not `transparent`, which some engines blend through grey. */
  padding-left: 20px;
  background: linear-gradient(90deg, rgba(var(--bg-white-rgb), 0), var(--bg-white) 16px);
}
.card:hover .toolbar,
.toolbar.busy {
  visibility: visible;
}

.toolbar .act:hover {
  color: var(--blue);
}

/* Green, like an enable: the copy worked. */
.toolbar .act.done,
.toolbar .act.done:hover {
  color: var(--green-dark);
}

/* A day's first row: the label between two hairlines. */
.day {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 -1px;
  font-size: 10.5px;
  color: var(--text-hint);
  cursor: default;
}
.day::before,
.day::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--divider);
}

/* Not selectable: ⧉ copies it, and 200 of these as textareas cost ~338ms. */
.cmd {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-soft);
  line-height: 1.45;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
