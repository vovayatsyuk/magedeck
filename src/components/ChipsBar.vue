<script setup>
import { computed, ref, watchEffect, onMounted, onUnmounted } from 'vue';
import { selected, deselect, clearSelection, applyFromButton, keyboardVerb, KEYS } from '../store.js';
import Icon from './icons/Icon.vue';

/** ⌘↩ runs the inferred verb, shift flips it; label each button with its own. */
const keyFor = (verb) => (verb === keyboardVerb.value ? KEYS.confirmKey : KEYS.confirmAltKey);

const chipsEl = ref(null);
const hovered = ref(false);
const overflowing = ref(false);

/** Measured rather than guessed: chip widths depend on module name lengths. */
function measure() {
  const el = chipsEl.value;
  if (!el || hovered.value) return;
  overflowing.value = el.scrollWidth > el.clientWidth + 1;
}

const expanded = computed(() => hovered.value && overflowing.value);

watchEffect(measure, { flush: 'post' });

let observer;
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (chipsEl.value) observer.observe(chipsEl.value);
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div class="bar">
    <div class="label">{{ selected.length ? `${selected.length} selected` : 'All visible modules' }}</div>

    <div class="slot">
      <div
        ref="chipsEl"
        class="chips"
        :class="{ expanded }"
        @mouseenter="hovered = true"
        @mouseleave="hovered = false"
      >
        <span v-if="!selected.length" class="placeholder">Select modules to cusomize a command</span>
        <span v-for="name in selected" :key="name" class="chip">
          {{ name }}
          <span class="x" title="Remove" @click="deselect(name)"><Icon name="cross" /></span>
        </span>
      </div>
      <span
        v-if="selected.length"
        class="clear"
        title="Clear selection"
        @mouseenter="hovered = true"
        @mouseleave="hovered = false"
        @click="clearSelection"
        ><Icon name="cross" /></span
      >
    </div>

    <button type="button" class="btn" :data-key="keyFor('enable')" @click="applyFromButton('enable')">Enable</button>
    <button type="button" class="btn btn-primary" :data-key="keyFor('disable')" @click="applyFromButton('disable')">Disable</button>
  </div>
</template>

<style scoped>
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--divider);
  background: linear-gradient(180deg, var(--bg-bar-top), var(--bg-bar-bottom));
}

.label {
  font-size: 12.5px;
  color: var(--text-mid);
  white-space: nowrap;
}

.slot {
  flex: 1;
  min-width: 0;
  position: relative;
  height: 28px;
}

.chips {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-wrap: nowrap;
  align-content: flex-end;
  gap: 3px;
  max-height: 28px;
  overflow-x: hidden;
  overflow-y: hidden;
  background: var(--bg-list);
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 3px;
}

.chips:has(.chip).expanded {
  flex-wrap: wrap;
  align-content: flex-start;
  max-height: 340px;
  overflow-y: scroll;
  box-shadow: 0 -8px 24px rgba(var(--shadow-rgb), 0.14);
}

.placeholder {
  font-size: 11.5px;
  font-family: var(--mono);
  color: var(--text-hint);
  line-height: 18px;
  white-space: nowrap;
  padding-inline: 3px;
}

/* Over the right end of the chip strip, clear of its scrollbar. */
.clear {
  position: absolute;
  right: 6px;
  bottom: 6px;
}
</style>
