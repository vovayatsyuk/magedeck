import { createApp } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles.css';
import App from './App.vue';

// Fullscreen hides the traffic lights, so the strip the sidebar keeps clear
// for them is dead space there. Nothing reports the mode itself: entering and
// leaving it both resize the window, and that does fire. Coming out, macOS
// keeps the window flagged fullscreen until its animation ends, so the strip
// returns a beat after the lights do.
if (window.__TAURI_INTERNALS__) {
  const win = getCurrentWindow();
  const sync = async () =>
    document.documentElement.classList.toggle('fullscreen', await win.isFullscreen());

  win.onResized(sync);
  sync();
}

createApp(App).mount('#app');
