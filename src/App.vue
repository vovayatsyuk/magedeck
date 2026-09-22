<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { state, init, confirmFromKeyboard, dialogPrimary, closeDialog, reloadModules, mac } from './store.js';
import { initTray } from './tray.js';
import FilterPanel from './components/FilterPanel.vue';
import ModuleList from './components/ModuleList.vue';
import ChipsBar from './components/ChipsBar.vue';
import SidePanel from './components/SidePanel.vue';
import AppDialog from './components/AppDialog.vue';

const list = ref(null);

/** Text fields only: a checkbox has no selectionStart. */
const isTextField = (el) => !!el && typeof el.selectionStart === 'number' && !el.readOnly;

/** The modifier the shortcuts here are spelled with. */
const HINT_KEY = mac ? 'Meta' : 'Control';

function onKeydown(e) {
  const open = !!state.dialog;

  if (e.key === HINT_KEY) state.keyHint = true;

  // This WebView keeps an editor undo stack for form fields but binds no
  // keys to it. execCommand fires input events, so v-model keeps up.
  if ((e.metaKey || e.ctrlKey) && /^[zyZY]$/.test(e.key)) {
    if (!isTextField(document.activeElement)) return;
    e.preventDefault();
    document.execCommand(e.key.toLowerCase() === 'y' || e.shiftKey ? 'redo' : 'undo');
    return;
  }

  if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeDialog();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (open) dialogPrimary();
    // Shift forces the opposite verb, so a mixed set can still be disabled.
    else confirmFromKeyboard(e.shiftKey);
    return;
  }
  // Always swallowed: left to the WebView, ⌘R reloads the whole app.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    if (!open) reloadModules();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && /^[fkFK]$/.test(e.key)) {
    e.preventDefault();
    list.value?.focusSearch();
    return;
  }

  // Type-ahead: a printable key pressed outside a field goes to the search
  // box. Focus moves on keydown, so the character itself lands there, which
  // is why this must not preventDefault. Space is left alone, it toggles the
  // focused row.
  if (!open && e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTextField(document.activeElement)) {
    list.value?.focusSearch();
  }
}

// Also on blur: a shortcut that switches windows never delivers its keyup.
const dropHint = (e) => {
  if (e.type === 'blur' || e.key === HINT_KEY) state.keyHint = false;
};

onMounted(() => {
  init();
  initTray();
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('keyup', dropHint);
  window.addEventListener('blur', dropHint);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('keyup', dropHint);
  window.removeEventListener('blur', dropHint);
});
</script>

<template>
  <!-- Key badges belong to whatever has the keyboard: the dialog takes them
       over while it is open. -->
  <div class="window" :class="{ keyhint: state.keyHint && !state.dialog }">
    <div class="body">
      <FilterPanel />
      <div class="center">
        <ModuleList ref="list" />
        <ChipsBar />
      </div>
      <SidePanel />
    </div>

    <AppDialog />
  </div>
</template>

<style scoped>
.window {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-chrome);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
