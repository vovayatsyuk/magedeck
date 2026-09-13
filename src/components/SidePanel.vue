<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import MagentoPicker from './MagentoPicker.vue';
import { state, createSnapshot, deleteSnapshot, restoreSnapshot, snapshotPlan, clearHistory, confirmDelete, applyPlan } from '../store.js';
import { plural } from '../logic.js';
import Icon from './icons/Icon.vue';

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

/** Snapshots that would change something. Restoring the rest is a no-op, so
 *  they show no ▶ at all rather than a button that does nothing. */
const restorable = computed(
  () =>
    new Set(
      state.snapshots
        .filter((s) => {
          const { enable, disable } = snapshotPlan(s);
          return enable.length || disable.length;
        })
        .map((s) => s.id),
    ),
);

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

      <div class="panel-head">
        <span class="eyebrow grow">Snapshots</span>
        <span class="link" @click="createSnapshot"><Icon name="plus" />Create</span>
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
            <div class="meta">{{ s.on }} on · {{ s.off }} off · {{ s.time }}</div>
          </div>
          <div class="actions">
            <span v-if="restoring === s.id" class="spinslot"><span class="spinner"></span></span>
            <span
              v-else-if="restorable.has(s.id)"
              class="glyph act play"
              title="Restore this snapshot"
              @click="restore(s)"
              ><Icon name="play" /></span
            >
            <span class="glyph act del" title="Delete snapshot" @click="removeSnapshot(s)"><Icon name="cross" /></span>
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
          <div v-for="h in shownHistory" :key="h.id" class="card">
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
  background: #e2e5ea;
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
  background: linear-gradient(90deg, rgba(255, 255, 255, 0), var(--bg-white) 16px);
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

/* Not selectable: ⧉ copies it, and 200 of these as textareas cost ~338ms. */
.cmd {
  font-size: 11px;
  font-family: var(--mono);
  color: #6b727c;
  line-height: 1.45;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
