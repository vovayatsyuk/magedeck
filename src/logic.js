// No Vue or Tauri imports, so `node --test` can run this directly.

export const BUILTIN_FILTERS = ['All modules', 'Enabled', 'Disabled', 'Selected', 'Locked'];

// Locked draws a lock instead of a dot.
export const BUILTIN_DOTS = {
  'All modules': '#ffffff',
  Enabled: '#3f9a54',
  Disabled: '#cf5540',
  Selected: '#2f6bd8',
  Locked: null,
};

// `-term` still excludes: filters saved before `!` was adopted hold
// `-Magento_`. The trailing `.` keeps a lone `!` or `-` an ordinary term.
const NEGATED = /^[!-]./;

/** `!term` excludes; the remaining terms are OR'd. Folds case on both sides
 *  rather than trusting callers to pass a lowercased query. */
export function matches(module, query) {
  if (!query) return true;
  const hay = `${module.name} ${module.vendor}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const negative = terms.filter((t) => NEGATED.test(t)).map((t) => t.slice(1));
  const positive = terms.filter((t) => !NEGATED.test(t));
  if (negative.some((t) => hay.includes(t))) return false;
  return positive.length ? positive.some((t) => hay.includes(t)) : true;
}

export function inFilter(module, filter) {
  if (filter.members?.includes(module.name)) return true;
  const query = (filter.query || '').trim();
  return query ? matches(module, query) : false;
}

/** `key` is a built-in's name or a saved filter's **id**: names are display
 *  text, and two saved filters may share one. `locked` lists module names. */
export function filterMembers(modules, key, checked, filters, locked = []) {
  switch (key) {
    case 'All modules': return modules;
    case 'Enabled': return modules.filter((m) => m.on);
    case 'Disabled': return modules.filter((m) => !m.on);
    case 'Selected': return modules.filter((m) => checked[m.name]);
    case 'Locked': return modules.filter((m) => locked.includes(m.name));
    default: {
      const filter = filters.find((f) => f.id === key);
      return filter ? modules.filter((m) => inFilter(m, filter)) : modules;
    }
  }
}

export function visibleModules(modules, key, query, checked, filters, locked = []) {
  const q = query.trim().toLowerCase();
  return filterMembers(modules, key, checked, filters, locked)
    .filter((m) => matches(m, q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Enabled modules first, each half keeping `list`'s order. `wasOn` pins a
 *  module to the half it was in when the order was taken; one it does not
 *  know goes by its state now. */
export function enabledFirst(list, wasOn = new Map()) {
  const on = (m) => wasOn.get(m.name) ?? m.on;
  return [...list.filter(on), ...list.filter((m) => !on(m))];
}

export function inferVerb(targets) {
  return targets.length && targets.every((m) => m.on) ? 'disable' : 'enable';
}

export function pickTargets(verb, pool) {
  return pool.filter((m) => (verb === 'enable' ? !m.on : m.on));
}

/** Returns a new `checked` map. The values are sequence numbers, not flags:
 *  they preserve the order chips appear in. */
export function rangeSelect(checked, names, from, to, on, nextSeq) {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const next = { ...checked };
  for (const name of names.slice(lo, hi + 1)) {
    if (on) {
      if (!next[name]) next[name] = nextSeq();
    } else {
      delete next[name];
    }
  }
  return next;
}

export function selectedNames(modules, checked) {
  return modules
    .filter((m) => checked[m.name])
    .map((m) => m.name)
    .sort((a, b) => checked[a] - checked[b]);
}

/**
 * Dependents named in a constraint error, minus the ones already asked for.
 *
 * Any `Vendor_Module` token counts: the wording differs between enable
 * ("depends on disabled modules"), disable ("modules depend on it") and
 * Magento versions, so matching the sentence would be brittle.
 */
export function dependentsIn(message, asked = []) {
  const seen = new Set(asked);
  const out = [];
  for (const [name] of String(message ?? '').matchAll(/\b[A-Z][A-Za-z0-9]*_[A-Za-z][A-Za-z0-9]*\b/g)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Migrates history rows written before verb and names were stored as
 *  fields. Nothing else parses a command string; the backend owns those. */
export function legacyEntry(cmd) {
  const m = /module:(enable|disable)\s+(.+)$/.exec(cmd ?? '');
  return m ? { verb: m[1], names: m[2].split(/\s+/).filter(Boolean) } : null;
}

// ssh's single-letter options that swallow the next token. Anything else is
// a boolean flag, and skipping this list would read its value as the host.
const SSH_FLAGS_WITH_VALUE = 'bcDEeFIiJLlmOopQRSWw';

/**
 * Pulls the fields out of a pasted connection: `ssh root@1.2.3.4 -i ~/k`,
 * `root@1.2.3.4`, `ssh://root@1.2.3.4`, or a bare host. Returns only what it
 * found, and `null` when there was nothing to take apart — so a hostname
 * being typed one character at a time is left alone.
 */
export function parseSshTarget(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === 'ssh') tokens.shift();

  const out = {};
  let destination = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      // Both spellings: `-i path` and `-ipath`.
      const flag = token[1];
      const inline = token.slice(2);
      const value = inline || (SSH_FLAGS_WITH_VALUE.includes(flag) ? tokens[++i] : '');
      if (flag === 'i' && value) out.keyPath = value;
      if (flag === 'l' && value) out.user = value;
      if (flag === 'p' && value) out.port = Number(value);
      continue;
    }
    // The first bare token is the destination; a later one is the remote
    // command, which this app supplies itself. Flags keep being read either
    // side of it, the way ssh itself accepts `ssh host -i key`.
    if (!destination) destination = token;
  }

  // `host:2222`, as a URI spells it and as people write it. Only a numeric
  // tail counts, so an IPv6 address is left whole.
  const at = destination.replace(/^ssh:\/\//, '').replace(/:(\d+)$/, (_, port) => {
    out.port = Number(port);
    return '';
  });
  const cut = at.lastIndexOf('@');
  if (cut !== -1) {
    out.user = at.slice(0, cut);
    out.host = at.slice(cut + 1);
  } else if (at) {
    out.host = at;
  }
  // A lone hostname is what the field already holds.
  const parsed = Object.keys(out);
  return parsed.length && !(parsed.length === 1 && out.host === String(text).trim()) ? out : null;
}

/** What applying `snapshot` here would change, plus the modules it wants on
 *  that this install does not have. A module it wants off is off already when
 *  it is not installed, but one it wants on can never be, so a snapshot or
 *  preset missing any of those is not in effect however little there is to do. */
export function snapshotChanges(modules, snapshot) {
  const wanted = snapshot.state || {};
  const installed = new Set(modules.map((m) => m.name));
  return {
    enable: modules.filter((m) => !m.on && wanted[m.name] === 1).map((m) => m.name),
    disable: modules.filter((m) => m.on && wanted[m.name] === 0).map((m) => m.name),
    missing: Object.keys(wanted).filter((n) => wanted[n] === 1 && !installed.has(n)),
  };
}

export function plural(n) {
  return `${n} module${n === 1 ? '' : 's'}`;
}

/** Drops entries whose magento is gone. Returns null when there is nothing
 *  to drop, so callers can skip the write. */
export function keepOnly(byMagento, validIds) {
  const keep = new Set(validIds);
  const stale = Object.keys(byMagento).filter((id) => !keep.has(id));
  if (!stale.length) return null;
  const out = { ...byMagento };
  for (const id of stale) delete out[id];
  return out;
}

/** When a history row ran. Rows written before `at` was stored still carry
 *  it in their id: `h` + `Date.now()` in base 36 (8 digits until 2059) +
 *  a sequence number. An explicit `at: null` means the time is unknown, as
 *  for rows older than their ids. Anything that does not decode to a sane
 *  time is left undated rather than guessed. */
export function entryTime(h) {
  if ('at' in h) return Number.isFinite(h.at) ? h.at : null;
  const ms = /^h[0-9a-z]{9,}$/.test(h.id ?? '') ? parseInt(h.id.slice(1, 9), 36) : NaN;
  return ms > Date.UTC(2020, 0) && ms < Date.UTC(2100, 0) ? ms : null;
}

const dayStart = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Calendar days, not 24h spans: 23:59 to 00:01 is a day ago. Rounded, so a
 *  DST change's 23- or 25-hour day still counts as one. */
const daysBetween = (from, to) => Math.round((dayStart(to) - dayStart(from)) / 86400000);

/** The divider over a day's rows: nothing for today, then `yesterday`,
 *  `N days ago` for the rest of the week, then the date itself. `title` is
 *  always the full date, for hover. */
export function dayLabel(ms, now = Date.now()) {
  const date = new Date(ms);
  const days = daysBetween(ms, now);
  const title = date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (days <= 0) return null;
  if (days === 1) return { label: 'yesterday', title };
  if (days < 7) return { label: `${days} days ago`, title };
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const label = date.toLocaleDateString([], { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
  return { label, title };
}

/** History rows with a divider before each day's first one. Rows are newest
 *  first; an undated row stays with the rows above it. */
export function withDayDividers(history, now = Date.now()) {
  const out = [];
  let day = dayStart(now);
  for (const h of history) {
    const at = entryTime(h);
    if (at !== null && dayStart(at) !== day) {
      day = dayStart(at);
      const label = dayLabel(at, now);
      if (label) out.push({ divider: true, key: `d${day}`, ...label });
    }
    out.push(h);
  }
  return out;
}
