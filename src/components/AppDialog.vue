<script setup>
// One dialog for every prompt, switched on `state.dialog.kind`: addModules,
// apply, alert, confirm, delete, filter, install, preset. The pieces are opt-in per kind.
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { state, closeDialog, dialogPrimary, dialogAction, dialogCommand, requiredFields, missingFields, browseFolder, browseKey, hostTyped, pathTyped, addCandidates, addAllTargets, toggleAddPick, openFormAddModules, lockedSet } from '../store.js';
import { enabledFirst, matches, plural } from '../logic.js';
import Icon from './icons/Icon.vue';

// Tailwind 500, one per hue. White and near-black have no 500 and stay as
// the two ends of the row.
const COLORS = [
  '#ffffff', '#64748b', '#2b3038', '#3b82f6', '#06b6d4',
  '#14b8a6', '#22c55e', '#84cc16', '#f59e0b', '#f97316',
  '#ef4444', '#ec4899', '#8b5cf6', '#6366f1', '#78716c',
];

/** The swatch a new filter starts on, and what an older one falls back to. */
const DEFAULT_COLOR = '#3b82f6';

const preEl = ref(null);

const d = computed(() => state.dialog);
const f = computed(() => state.form);

const field = (key, label, placeholder, extra = {}) => ({ key, label, placeholder, ...extra });

const AUTH = [
  { value: 'agent', label: 'SSH agent / default keys' },
  { value: 'key', label: 'Key file' },
  { value: 'password', label: 'Password' },
];

const view = computed(() => {
  const dialog = d.value;
  if (!dialog) return null;
  const form = f.value;

  if (dialog.kind === 'addModules') {
    const n = addAllTargets.value.length;
    const picked = form.picks?.length;
    return {
      width: '520px',
      title: dialog.name ? `Add modules to “${dialog.name}”` : `Add modules to the ${dialog.parent?.dialog.kind ?? 'filter'}`,
      picker: true,
      primary: !n ? 'Add modules' : picked ? `Add ${plural(n)}` : `Add all ${plural(n)} listed`,
      primaryOff: !n,
      hint: picked ? '⌘↩ adds the picked modules · esc to cancel' : 'Click to pick · ⌘↩ adds everything listed',
    };
  }

  if (dialog.kind === 'apply') {
    const on = dialog.verb === 'enable';
    const n = dialog.names.length;
    return {
      width: '520px',
      title: `Are you sure you want to ${dialog.verb} ${plural(n)}?`,
      subtitle:
        dialog.scope ||
        (dialog.fromSelection
          ? 'Applies to your current selection.'
          : 'Applies to everything currently visible in the list.'),
      pre: dialogCommand.value,
      primary: `${on ? 'Enable' : 'Disable'} ${plural(n)}`,
      danger: !on,
    };
  }

  if (dialog.kind === 'alert') {
    // The last retry becomes the primary, so it is what ⌘↩ runs.
    const actions = dialog.actions ?? [];
    return {
      width: '600px',
      title: dialog.title,
      pre: dialog.body,
      preMax: 240,
      primary: actions.at(-1)?.label || 'OK',
      extraActions: actions.slice(0, -1),
      danger: true,
      dismissOnly: !actions.length,
      hint: actions.length ? '⌘↩ retries' : '⌘↩ or esc to dismiss',
    };
  }

  // A choice between actions, the last one primary. Cancel backs out.
  if (dialog.kind === 'confirm') {
    return {
      width: dialog.width || '520px',
      title: dialog.title,
      subtitle: dialog.body,
      primary: dialog.actions.at(-1).label,
      extraActions: dialog.actions.slice(0, -1),
    };
  }

  if (dialog.kind === 'delete') {
    return {
      title: dialog.title || 'Delete?',
      subtitle: dialog.body || 'This cannot be undone.',
      primary: dialog.okLabel || 'Delete',
      danger: true,
    };
  }

  if (dialog.kind === 'filter') {
    const query = String(form.query ?? '').trim();
    return {
      width: '480px',
      title: dialog.mode === 'edit' ? 'Edit filter' : 'New filter',
      subtitle:
        'The modules you pick are always in. The expression adds anything else it matches.',
      fields: [
        field('name', 'Filter name', 'Third-party'),
        field('members', 'Modules', '', { modules: true }),
        field('query', 'Search expression', 'Swissup_ !Breeze', {
          count: query ? state.modules.filter((m) => matches(m, query)).length : null,
        }),
      ],
      colors: true,
      primary: dialog.mode === 'edit' ? 'Save filter' : 'Create filter',
    };
  }

  if (dialog.kind === 'preset') {
    return {
      width: '480px',
      title: dialog.mode === 'edit' ? 'Edit preset' : 'New preset',
      subtitle: 'Applying a preset switches each module below to the state shown. Modules not listed are left alone.',
      fields: [field('name', 'Preset name', 'Debugging off'), field('state', 'Modules', '', { modules: true })],
      primary: dialog.mode === 'edit' ? 'Save preset' : 'Create preset',
    };
  }

  // install
  const ssh = form.type === 'ssh';
  const auth = form.auth || 'agent';
  // The second half of the user row: whichever secret the auth mode needs.
  const credential = {
    key: field('keyPath', 'Key file', '~/.ssh/id_ed25519', { browse: browseKey }),
    password: field('password', 'Password', '', { type: 'password' }),
  }[auth];
  return {
    width: '480px',
    title: dialog.mode === 'edit' ? 'Edit Magento' : 'Add Magento',
    subtitle: 'Point at a local folder, or connect over SSH to a remote path.',
    toggle: { a: 'Local folder', b: 'SSH', key: 'type', valueA: 'local', valueB: 'ssh' },
    fields: ssh
      ? [
          [
            field('host', 'SSH host', 'acme-prod or root@10.0.0.4', { onInput: hostTyped }),
            field('port', 'Port', '22', { flex: '0 0 65px' }),
          ],
          field('title', 'Title', 'Production'),
          field('auth', 'Authentication', '', { options: AUTH }),
          [field('user', 'User', 'root'), ...(credential ? [credential] : [])],
          ...(auth === 'key'
            ? [
                field('password', 'Key passphrase', 'Blank if the key has none', {
                  type: 'password',
                }),
              ]
            : []),
          field('remotePath', 'Remote path', '/var/www/store'),
          field('php', 'PHP command', 'php, /opt/php8.0, docker compose exec -T phpfpm php'),
        ]
      : [
          field('path', 'Folder', '~/sites/acme-store', {
            browse: browseFolder,
            onInput: pathTyped,
          }),
          field('title', 'Title', 'Local store'),
          field('php', 'PHP command', 'php, /opt/php8.0, docker compose exec -T phpfpm php'),
        ],
    primary: dialog.mode === 'edit' ? 'Save' : 'Add',
  };
});

/** A row is one field or a list of them, laid out side by side. */
const rows = computed(() => (view.value?.fields ?? []).map((f) => (Array.isArray(f) ? f : [f])));

const badKeys = computed(() => {
  if (!state.formError) return [];
  return missingFields.value.length ? missingFields.value : ['path'];
});

/** The tooltip names the fields the way the form does, not by storage key. */
const missingLabels = computed(() =>
  rows.value
    .flat()
    .filter((fl) => missingFields.value.includes(fl.key))
    .map((fl) => fl.label)
    .join(', '),
);

/** Only when the press *started* on the backdrop: otherwise drag-selecting
 *  the command text and releasing outside would dismiss the dialog. */
let pressedBackdrop = false;
const onBackdropDown = (e) => (pressedBackdrop = e.target === e.currentTarget);
const onBackdropUp = (e) => {
  if (pressedBackdrop && e.target === e.currentTarget) closeDialog();
  pressedBackdrop = false;
};

/** Textareas do not size to content. */
const preMax = computed(() => view.value?.preMax ?? 96);

watchEffect(
  () => {
    const el = preEl.value;
    if (!el) return;
    el.style.height = 'auto';
    // +2 for the borders: box-sizing is border-box but scrollHeight excludes
    // them, so the exact height overflows and raises a scrollbar for nothing.
    el.style.height = `${Math.min(el.scrollHeight + 2, preMax.value)}px`;
  },
  { flush: 'post' },
);

// ------------------------------------------------------------ focus trap
//
// While a dialog is up, focus stays in it: Tab and Shift+Tab wrap around its
// fields, and focus that lands anywhere behind it — a stray Tab, ⌘F on the
// module search — is pulled back. Closing returns focus to where it was.

const dialogEl = ref(null);
let returnFocus = null;

const FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** In DOM order, which is tab order here: nothing sets a positive tabindex. */
const focusables = () =>
  [...(dialogEl.value?.querySelectorAll(FOCUSABLE) ?? [])].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );

/** The first field that takes typing, so a dialog opens ready for it. Not a
 *  button — Return on a focused Cancel would dismiss what ⌘↩ was meant to
 *  confirm — and not the read-only command block, where a caret is noise.
 *  With neither, the dialog itself holds focus so keys still land inside. */
const typable = (el) => el.matches('input, select, textarea') && !el.readOnly;
const focusInitial = () => (focusables().find(typable) ?? dialogEl.value)?.focus();

// Keyed on the dialog object, not on open/closed: one dialog can replace
// another in the same tick, and the new one still needs its first field.
watch(d, async (now, before) => {
  if (now && !before) returnFocus = document.activeElement;
  if (!now) {
    const el = returnFocus;
    returnFocus = null;
    if (el?.isConnected) el.focus();
    return;
  }
  await nextTick();
  if (!dialogEl.value?.contains(document.activeElement)) focusInitial();
});

function trapTab(e) {
  if (!view.value || e.key !== 'Tab') return;
  const els = focusables();
  const inside = dialogEl.value?.contains(document.activeElement);
  if (!els.length) {
    e.preventDefault();
    dialogEl.value?.focus();
    return;
  }
  const edge = e.shiftKey ? els[0] : els.at(-1);
  if (!inside || document.activeElement === edge || document.activeElement === dialogEl.value) {
    e.preventDefault();
    (e.shiftKey ? els.at(-1) : els[0]).focus();
  }
}

function trapFocus(e) {
  if (view.value && dialogEl.value && !dialogEl.value.contains(e.target)) focusInitial();
}

// Capture phase, so the trap runs before anything behind the dialog reacts.
onMounted(() => {
  document.addEventListener('keydown', trapTab, true);
  document.addEventListener('focusin', trapFocus, true);
});
onUnmounted(() => {
  document.removeEventListener('keydown', trapTab, true);
  document.removeEventListener('focusin', trapFocus, true);
});

/** Rows are cheap but not free: past this, narrowing the search beats
 *  scrolling anyway. ⌘↩ still takes every match, shown or not. */
const PICK_LIMIT = 200;
const shownCandidates = computed(() => addCandidates.value.slice(0, PICK_LIMIT));
const moreCandidates = computed(() => addCandidates.value.length - shownCandidates.value.length);

const isPicked = (name) => (f.value.picks || []).includes(name);

// ----------------------------------------------------------- form modules
//
// What a filter or preset holds, laid out like the central list. A preset's
// switch is the state it will apply, not the one the module is in; a filter
// has no state of its own, so its rows just show the module's.

const isPreset = computed(() => d.value?.kind === 'preset');

const installed = computed(() => new Map(state.modules.map((m) => [m.name, m])));

const byName = computed(() => {
  const entries = isPreset.value
    ? Object.entries(f.value.state || {}).map(([name, v]) => [name, v === 1])
    : (f.value.members || []).map((name) => [name, installed.value.get(name)?.on ?? true]);
  return entries
    .map(([name, on]) => ({ name, on, installed: installed.value.has(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

// Enabled first, as in the central list, and taken the same way: when the
// form opens or its modules change, not when a preset's switch flips.
const sortedOn = shallowRef(new Map());
watch(
  [d, () => byName.value.map((r) => r.name).join('\n')],
  () => (sortedOn.value = new Map(byName.value.map((r) => [r.name, r.on]))),
  { immediate: true },
);

const formRows = computed(() => enabledFirst(byName.value, sortedOn.value));

const formCount = computed(() => {
  if (!isPreset.value) return formRows.value.length;
  const on = formRows.value.filter((r) => r.on).length;
  return `${on} on · ${formRows.value.length - on} off`;
});

/** ⌥-click sets every module to the state the clicked one flips to — the
 *  Mac's "do it to all of them" modifier, as on Finder's disclosure triangles. */
function flipPreset(name, event) {
  const to = state.form.state[name] === 1 ? 0 : 1;
  const names = event?.altKey ? Object.keys(state.form.state) : [name];
  state.form.state = { ...state.form.state, ...Object.fromEntries(names.map((n) => [n, to])) };
}

function dropFormModule(name) {
  if (!isPreset.value) {
    state.form.members = (state.form.members || []).filter((n) => n !== name);
    return;
  }
  const next = { ...state.form.state };
  delete next[name];
  state.form.state = next;
}

const toggleValue = computed(() => f.value[view.value?.toggle?.key] ?? view.value?.toggle?.valueA);
const setToggle = (v) => (state.form[view.value.toggle.key] = v);
</script>

<template>
  <div v-if="view" class="backdrop" @mousedown="onBackdropDown" @mouseup="onBackdropUp">
    <div ref="dialogEl" class="dialog" tabindex="-1" role="dialog" aria-modal="true" :style="{ width: view.width || '420px' }">
      <div class="head">
        <div class="title">{{ view.title }}</div>
        <div v-if="view.subtitle" class="subtitle">{{ view.subtitle }}</div>
      </div>

      <div v-if="view.toggle" class="tabs">
        <div class="tab" :class="{ on: toggleValue === view.toggle.valueA }" @click="setToggle(view.toggle.valueA)">
          {{ view.toggle.a }}
        </div>
        <div class="tab" :class="{ on: toggleValue === view.toggle.valueB }" @click="setToggle(view.toggle.valueB)">
          {{ view.toggle.b }}
        </div>
      </div>

      <div v-if="view.fields" class="fields">
        <div v-for="(row, i) in rows" :key="i" class="row">
          <template v-for="fl in row" :key="fl.key">
          <div v-if="fl.modules" class="form-label" :style="{ flex: 1 }">
            <div class="flabel-row">
              <span class="flabel">
                {{ fl.label }}<span v-if="formRows.length" class="flabel-count">{{ formCount }}</span>
              </span>
              <span class="link" @click="openFormAddModules"><Icon name="plus" />Add modules</span>
            </div>
            <div class="modlist" :class="{ switches: isPreset }">
              <div v-for="m in formRows" :key="m.name" class="modrow">
                <div
                  class="modname"
                  :class="{ off: !m.on, missing: !m.installed }"
                >
                  <span class="text">{{ m.name }}</span>
                  <span
                    v-if="lockedSet.has(m.name)"
                    class="lockwrap"
                    title="Module status is locked from mass operations"
                    ><Icon name="lock" class="sm"
                  /></span>
                </div>
                <span class="glyph drop" :title="`Remove from this ${d.kind}`" @click="dropFormModule(m.name)"><Icon name="cross" /></span>
                <div v-if="isPreset" class="statuswrap">
                  <span
                    class="toggle"
                    :class="{ on: m.on }"
                    role="switch"
                    :aria-checked="m.on"
                    title="⌥-click to toggle all"
                    @mousedown.prevent="flipPreset(m.name, $event)"
                  >
                    <span class="knob"></span>
                  </span>
                </div>
              </div>
              <div v-if="!formRows.length" class="empty">Nothing in this {{ d.kind }} yet.</div>
            </div>
          </div>
          <label v-else class="form-label" :style="{ flex: fl.flex || 1 }">
            <span class="flabel">
              {{ fl.label }}<em v-if="requiredFields.includes(fl.key)" class="req">*</em><span v-if="fl.count != null" class="flabel-count">{{ fl.count }}</span>
            </span>
            <span class="inputrow">
              <select v-if="fl.options" v-model="state.form[fl.key]" class="field select">
                <option v-for="o in fl.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <input
                v-else
                v-model="state.form[fl.key]"
                :type="fl.type || 'text'"
                :class="['field', { bad: badKeys.includes(fl.key) }]"
                :placeholder="fl.placeholder"
                spellcheck="false"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                @input="fl.onInput?.($event.target.value)"
              />
              <button v-if="fl.browse" type="button" class="btn browse" @click="fl.browse()">Choose…</button>
            </span>
          </label>
          </template>
        </div>
      </div>

      <div v-if="view.picker" class="picker">
        <div class="fields">
          <div class="field field-row">
            <Icon name="search" class="mag" />
            <input
              v-model="state.form.query"
              class="bare-input"
              placeholder="Search modules"
              spellcheck="false"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
            />
          </div>
          <div class="picklist">
            <div
              v-for="m in shownCandidates"
              :key="m.name"
              class="pickrow"
              :class="{ disabled: !m.on, on: isPicked(m.name) }"
              :title="isPicked(m.name) ? 'Unpick this module' : 'Pick this module'"
              @click="toggleAddPick(m.name)"
            >
              <Icon :name="isPicked(m.name) ? 'check' : 'plus'" class="pickadd sm" />
              <span class="pickname">{{ m.name }}</span>
              <span
                v-if="lockedSet.has(m.name)"
                class="lockwrap"
                title="Module status is locked from mass operations"
                ><Icon name="lock" class="sm"
              /></span>
            </div>
            <div v-if="moreCandidates" class="note">{{ moreCandidates }} more — narrow the search</div>
            <div v-if="!addCandidates.length" class="note">
              {{ state.form.query ? `Nothing found for “${state.form.query}”` : `Every module is already in this ${d.parent?.dialog.kind ?? 'filter'}.` }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="view.colors" class="colors">
        <span class="flabel">Color</span>
        <div class="swatches">
          <span
            v-for="c in COLORS"
            :key="c"
            class="swatch"
            :style="{
              background: c,
              outline: (state.form.color || DEFAULT_COLOR) === c ? '2px solid #16181c' : c === '#ffffff' ? '1px solid #c3c7ce' : '2px solid transparent',
            }"
            @click="state.form.color = c"
          ></span>
        </div>
      </div>

      <textarea
        v-if="view.pre"
        ref="preEl"
        class="pre"
        readonly
        spellcheck="false"
        :style="{ maxHeight: `${preMax}px` }"
        :value="view.pre"
      ></textarea>

      <div v-if="state.formError" class="formerror">
        <span class="warn">!</span>
        <span>{{ state.formError }}</span>
      </div>

      <div class="foot">
        <span class="foothint">{{ view.hint || '⌘↩ to confirm · esc to cancel' }}</span>
        <button v-if="!view.dismissOnly" type="button" class="btn" @click="closeDialog">Cancel</button>
        <button
          v-for="a in view.extraActions"
          :key="a.label"
          type="button"
          class="btn"
          @click="dialogAction(a)"
        >
          {{ a.label }}
        </button>
        <!-- aria-disabled, not disabled: a disabled button shows no tooltip,
             and the tooltip is what says why. The store refuses the click. -->
        <button
          type="button"
          class="btn"
          :class="[view.danger ? 'btn-danger' : 'btn-primary', { off: state.checking || view.primaryOff }]"
          :aria-disabled="state.checking || view.primaryOff"
          :title="missingFields.length ? `Required: ${missingLabels}` : view.primaryOff ? 'Pick modules, or search to add what it matches' : ''"
          @click="dialogPrimary"
        >
          {{ state.checking ? 'Checking…' : view.primary }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(18, 22, 30, 0.3);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 90;
}

.dialog {
  margin-top: 96px;
  max-width: calc(100% - 48px);
  background: #f4f5f7;
  border-radius: 12px;
  box-shadow: 0 26px 64px rgba(15, 20, 30, 0.38);
  overflow: hidden;
}

/* Focused only as the trap's fallback, never by the user's choice. */
.dialog:focus {
  outline: none;
}

.head {
  padding: 18px 20px 0;
}

.title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.35;
}

.subtitle {
  font-size: 12px;
  color: #6b727c;
  margin-top: 5px;
  line-height: 1.5;
  white-space: pre-line;
}

.tabs {
  margin: 16px 20px 0;
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 16px 20px 0;
}

.row {
  display: flex;
  gap: 10px;
}

.inputrow {
  display: flex;
  gap: 8px;
}

.browse {
  flex: none;
  padding: 0 12px;
  line-height: 28px;
  font-weight: 400;
}

/* A preset's modules: the central list's rows, without the checkbox column
   and with a remove button that shows on hover. */
.modlist {
  max-height: 280px;
  overflow-y: auto;
  scrollbar-width: thin;
  background: #fff;
  border: 1px solid #dfe2e7;
  border-radius: 8px;
}

.modlist .modrow {
  grid-template-columns: minmax(0, 1fr) 20px;
  padding: 0 12px;
}

/* A preset's rows end in the switch. */
.modlist.switches .modrow {
  grid-template-columns: minmax(0, 1fr) 20px 44px;
}

/* The list's own border closes it. */
.modlist .modrow:last-child {
  border-bottom: none;
}

/* Named by the preset but absent from this install: kept, and marked. */
.modname.missing .text {
  text-decoration: underline dashed var(--text-faint);
  text-underline-offset: 3px;
}

.drop {
  visibility: hidden;
  justify-self: end;
}

.modrow:hover .drop {
  visibility: visible;
}

.drop:hover {
  color: var(--red);
}

.flabel-count {
  margin-left: 6px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-hint);
}

/* The action rides the label's line, so the list below stays only rows. */
.flabel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modlist .empty {
  padding: 28px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}

.picklist {
  height: 280px;
  overflow-y: auto;
  scrollbar-width: thin;
  background: #fff;
  border: 1px solid #dfe2e7;
  border-radius: 8px;
}

.pickrow {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-faint);
}

.pickrow:hover {
  background: #f2f5fb;
}

/* A faint plus, and a blue check once the row is picked. */
.pickadd {
  color: var(--text-faint);
}

.pickrow.on .pickadd {
  color: var(--blue);
}

.colors {
  padding: 14px 20px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.swatches {
  display: grid;
  grid-template-columns: repeat(15, 16px);
  gap: 7px 8px;
  padding: 2px 0;
}

.swatch {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  outline-offset: 2px;
}

/* A read-only textarea, not a div, so Ctrl+A picks just this block.
   Selectability comes from the global input/textarea rule. */
.pre {
  display: block;
  width: calc(100% - 40px);
  box-sizing: border-box;
  resize: none;
  outline: 0;
  margin: 16px 20px 0;
  padding: 10px 11px;
  background: #fff;
  border: 1px solid #dfe2e7;
  border-radius: 8px;
  font-size: 11px;
  font-family: var(--mono);
  color: #6b727c;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  scrollbar-width: thin;
}

.formerror {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 16px 20px 0;
  padding: 9px 11px;
  border: 1px solid #efc8bd;
  border-radius: 8px;
  background: #fbeae6;
  font-size: 12px;
  line-height: 1.45;
  color: #8c3520;
  word-break: break-word;
}

.warn {
  margin-top: 1px;
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding: 12px 20px;
  border-top: 1px solid #e2e5ea;
  background: var(--bg-rail);
}

.foothint {
  flex: 1;
  font-size: 11px;
  color: var(--text-hint);
}
</style>
