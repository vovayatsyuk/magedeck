<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { state, magento, displayPath, selectMagento, reloadModules, openDialog, confirmDelete, deleteMagento, moveMagento, persistMagentos } from '../store.js';
import Icon from './icons/Icon.vue';

const open = ref(false);
const root = ref(null);

/** A mode, not a per-row affordance: the rows are the switcher, and putting
 *  delete one pixel from "switch to production" invites the wrong click. */
const editing = ref(false);
const menuList = ref(null);

const current = computed(() => magento.value);

const empty = computed(() => !state.magentos.length);

const onPill = () => (empty.value ? add() : toggleMenu());

function toggleMenu() {
  if (state.running) return;
  open.value = !open.value;
  // Editing is a state of the open menu; reopening starts plain.
  if (!open.value) editing.value = false;
}

const kindOf = (m) => (m.kind === 'ssh' ? 'SSH' : 'Local');

/**
 * The last segment names the install, so it is pinned and the parent path
 * ellipsises to whatever width is left. An ssh install keeps its host.
 */
function parts(m) {
  const path = m.path.replace(/\/+$/, '');
  const cut = path.lastIndexOf('/') + 1;
  return { dir: `${m.kind === 'ssh' ? `${m.host}:` : ''}${path.slice(0, cut)}`, base: path.slice(cut) };
}

const sub = (m) => `${m.title} - ${kindOf(m)}`;

const slow = ref(false);
let slowTimer;
watch(
  () => state.switching,
  (switching) => {
    clearTimeout(slowTimer);
    if (!switching) {
      slow.value = false;
    } else if (current.value?.kind === 'ssh') {
      slow.value = true;
    } else {
      slowTimer = setTimeout(() => (slow.value = true), 200);
    }
  },
);

/**
 * The install the pill is actually connected to. `magentoId` flips at the
 * start of a switch, so the pill would otherwise take the new name before
 * the connection lands — and take it back for the 150ms of "Connecting…".
 * Outside a switch it just follows `current`, so a delete or a rename still
 * reaches the pill.
 */
const settled = ref(null);
watch(
  [current, () => state.switching],
  ([m, switching]) => {
    if (!switching) settled.value = m;
  },
  { immediate: true },
);

const pillText = computed(() => {
  if (empty.value) return 'Add Magento';
  if (slow.value) return 'Connecting…';
  return settled.value ? sub(settled.value) : 'Select Magento';
});

/**
 * Plain mouse events rather than HTML5 drag-and-drop, and arithmetic over
 * geometry captured at mousedown rather than a live DOM read: Vue patches
 * asynchronously, so a rect can still describe the previous order.
 */
const dragging = ref(null);
let dragged = false;
let bandTop = 0;
let bandStep = 0;

function indexAt(clientY) {
  if (!bandStep) return -1;
  const i = Math.floor((clientY - bandTop) / bandStep);
  return Math.min(Math.max(i, 0), state.magentos.length - 1);
}

function startDrag(m, event) {
  // Cleared on press, not release: a drag ending outside the menu fires no
  // click, and a flag left set would swallow the next one.
  dragged = false;
  if (!editing.value || event.button !== 0) return;
  const els = menuList.value?.$el?.querySelectorAll('.item') ?? [];
  if (els.length < 2) return;
  bandTop = els[0].getBoundingClientRect().top;
  bandStep = els[1].getBoundingClientRect().top - bandTop;
  event.preventDefault();
  dragging.value = state.magentos.findIndex((x) => x.id === m.id);
}

function onDrag(event) {
  if (dragging.value === null) return;
  const to = indexAt(event.clientY);
  if (to === -1 || to === dragging.value) return;
  dragged = true;
  moveMagento(dragging.value, to);
  dragging.value = to;
}

function endDrag() {
  if (dragging.value === null) return;
  dragging.value = null;
  if (dragged) persistMagentos();
}

/** The menu stays open until the switch lands, so the spinner has somewhere
 *  to be: a remote install can take a second to read its modules. Picking the
 *  install already open reloads it, for modules installed since. */
async function pick(m) {
  // A drag that ended on this row is not a click on it.
  if (dragged) {
    dragged = false;
    return;
  }
  // Editing manages the list; switching away mid-edit is not what the
  // click means there.
  if (editing.value || state.switching) return;
  try {
    await (m.id === state.magentoId ? reloadModules() : selectMagento(m.id));
  } finally {
    open.value = false;
  }
}

function add() {
  open.value = false;
  editing.value = false;
  // `auth` from the start: the select has no blank option to fall back on.
  openDialog('install', { type: 'local', auth: 'agent' }, { mode: 'create' });
}

function edit(m) {
  open.value = false;
  editing.value = false;
  const ssh = m.kind === 'ssh';
  openDialog(
    'install',
    ssh
      ? {
          type: 'ssh',
          host: m.host,
          user: m.user,
          port: m.port,
          remotePath: m.path,
          auth: m.auth || 'agent',
          keyPath: m.keyPath,
          password: m.password,
          title: m.title,
          php: m.php,
          version: m.version,
        }
      : { type: 'local', path: m.path, title: m.title, php: m.php, version: m.version },
    { mode: 'edit', id: m.id },
  );
}

function remove(m) {
  open.value = false;
  editing.value = false;
  confirmDelete({
    title: 'Remove this installation?',
    body: `${displayPath(m)}\n\nOnly the connection is removed from this app. Nothing on disk or on the server is touched.`,
    okLabel: 'Remove',
    onOk: () => deleteMagento(m.id),
  });
}

const onOutside = (e) => {
  if (open.value && !root.value?.contains(e.target)) {
    open.value = false;
    editing.value = false;
  }
};
const onEscape = (e) => {
  if (e.key !== 'Escape' || !open.value) return;
  e.preventDefault();
  open.value = false;
  editing.value = false;
};
onMounted(() => {
  document.addEventListener('click', onOutside, true);
  document.addEventListener('keydown', onEscape);
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', endDrag);
});
onUnmounted(() => {
  clearTimeout(slowTimer);
  document.removeEventListener('click', onOutside, true);
  document.removeEventListener('keydown', onEscape);
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', endDrag);
});
</script>

<template>
  <div ref="root" class="wrap">
    <div
      class="pill"
      :class="{ empty, busy: state.running }"
      :title="state.running ? 'Wait for the running command to finish' : empty ? '' : displayPath(settled)"
      @click="onPill"
    >
      <span v-if="!empty" class="dot"></span>
      <Icon v-else name="plus" class="sm" />
      <span class="label">{{ pillText }}</span>
      <span v-if="state.running" class="spinner"></span>
      <Icon v-if="!empty" name="chevron-down" class="caret sm" />
    </div>

    <div v-if="open" class="menu-anchor">
      <div class="menu">
        <TransitionGroup ref="menuList" tag="div" name="reorder">
          <div
            v-for="m in state.magentos"
            :key="m.id"
            class="item"
            :class="{ active: m.id === state.magentoId, manage: editing }"
            @click="pick(m)"
            @mousedown="startDrag(m, $event)"
          >
          <span
            class="dot"
            :class="{ off: m.id !== state.magentoId, spinning: m.id === state.magentoId && slow }"
          ></span>
          <div class="grow" :title="m.id === state.magentoId ? `${displayPath(m)}\nClick or ⌘R to reload its modules` : displayPath(m)">
            <div class="itemmeta">{{ m.title }}</div>
            <div class="itempath">
              <span class="dir">{{ parts(m).dir }}</span><span class="base">{{ parts(m).base }}</span>
            </div>
          </div>
            <div v-if="editing" class="actions">
              <span
                class="glyph edit"
                title="Edit this install"
                @click.stop="edit(m)"
                ><Icon name="pencil" /></span
              >
              <span
                class="glyph del"
                title="Remove this install"
                @click.stop="remove(m)"
                ><Icon name="cross" /></span
              >
            </div>
          </div>
        </TransitionGroup>

        <div class="sep"></div>
        <div class="foot">
          <span class="link add" @click="add"><Icon name="plus" />Add Magento…</span>
          <span
            class="glyph pencil"
            :class="{ on: editing }"
            :title="editing ? 'Done' : 'Reorder, edit or remove installs'"
            @click.stop="editing = !editing"
            ><Icon name="pencil" /></span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
}

.pill {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: 11.5px;
  color: var(--text-soft);
  background: var(--bg-list);
  border: 1px solid var(--border);
  border-radius: 6px;
  height: 30px;
  padding: 0 9px;
}
.pill.busy {
  cursor: wait;
}
.pill:hover {
  background: #eef0f3;
  border-color: #b8bec6;
}
.pill:hover .label,
.pill:hover .caret {
  color: var(--text-mid);
}
.pill.empty {
  justify-content: center;
  color: var(--blue);
}
.pill.empty .label {
  flex: none;
}
.pill.empty:hover {
  background: var(--blue-tint);
  border-color: #b6cbf0;
  color: var(--blue-dark);
}

/* `magentoId` is set before the load starts, so the clicked row is the one
   that spins — see the global `.spinning` ring. */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: #28c840;
}

.dot.off {
  background: #c3c7ce;
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  color: #b0b6be;
}

.menu-anchor {
  position: absolute;
  z-index: 20;
  top: 100%;
  right: 0;
  padding-top: 6px;
}

.menu {
  display: flex;
  width: 296px;
  flex-direction: column;
  gap: 1px;
  padding: 5px;
  background: #fdfdfe;
  border-radius: 9px;
  box-shadow:
    0 0 1px rgba(0, 0, 0, 0.3),
    0 14px 36px rgba(15, 20, 30, 0.24);
}

.item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  position: relative;
  margin-bottom: 1px;
}
.item:last-child {
  margin-bottom: 0;
}

.item:hover {
  background: var(--bg-tint);
}

.item.active {
  background: var(--blue-tint);
}

.itempath {
  font-size: 11px;
  color: var(--text-dim);
}

.dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.base {
  flex: none;
}

.itemmeta {
  display: flex;
  font-size: 11.5px;
  color: var(--text-strong);
  margin-bottom: 3px;
}

.actions {
  display: flex;
  gap: 1px;
  position: absolute;
  top: 3px;
  right: 3px;
  color: var(--text-dim);
}

.item.manage {
  cursor: grab;
}

.item.manage:active {
  cursor: grabbing;
  background: #e2e5ea;
}

.glyph {
  border-radius: 5px;
}

.edit:hover {
  background: #dee3ea;
  color: var(--blue);
}

.del:hover {
  background: #f2d9d4;
  color: var(--red);
}

.sep {
  height: 1px;
  background: #e6e9ed;
  margin: 5px 4px;
}

.foot {
  display: flex;
  align-items: center;
  gap: 4px;
}

.add {
  flex: 1;
  padding: 6px 8px;
  border-radius: 6px;
}

.add:hover {
  background: var(--bg-tint);
}

.pencil {
  flex: none;
  width: 22px;
  height: 22px;
  margin-right: 3px;
  color: var(--text-dim);
}

.pencil:hover {
  background: var(--bg-tint);
  color: var(--text-mid);
}

.pencil.on {
  background: var(--blue-tint);
  color: var(--blue);
}
</style>
