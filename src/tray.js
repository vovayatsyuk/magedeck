import { computed, watch } from 'vue';
import { listen } from '@tauri-apps/api/event';
import * as api from './api.js';
import { state, magento, presetPlan, applyPreset, flushCache } from './store.js';

// Checked like the card's tick: holds modules, and applying changes nothing.
// While one is being applied it is the only one ticked, until the modules
// catch up — or a failure clears `pending` and they say so themselves.
const menu = computed(() => {
  const running = state.presets.find((p) => p.id === state.pending?.source)?.id ?? null;
  return {
    title: magento.value?.title ?? null,
    presets: state.presets.map((p) => {
      const { enable, disable } = presetPlan(p);
      const applied = running
        ? p.id === running
        : Object.keys(p.state || {}).length > 0 && !enable.length && !disable.length;
      return { id: p.id, name: p.name, applied, applying: p.id === running };
    }),
    flushing: state.pending?.source?.startsWith('flush:') ? state.pending.source.slice(6) : null,
  };
});

const send = () => api.trayMenu(menu.value).catch(console.error);

export function initTray() {
  watch(menu, send, { immediate: true });
  listen('tray-preset', async ({ payload: id }) => {
    const preset = state.presets.find((p) => p.id === id);
    if (preset) await applyPreset(preset);
    // The click flips the tick itself, even when nothing was applied.
    send();
    // A failure opens its alert in the window, which may be in the tray.
    if (state.dialog) api.trayShow().catch(console.error);
  });
  listen('tray-flush', async ({ payload: staticContent }) => {
    await flushCache(staticContent);
    if (state.dialog) api.trayShow().catch(console.error);
  });
}
