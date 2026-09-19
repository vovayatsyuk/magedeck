import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matches,
  inFilter,
  filterMembers,
  visibleModules,
  inferVerb,
  pickTargets,
  legacyEntry,
  dependentsIn,
  rangeSelect,
  selectedNames,
  keepOnly,
  parseSshTarget,
  snapshotChanges,
  enabledFirst,
  entryTime,
  dayLabel,
  withDayDividers,
} from './logic.js';

const mod = (name, vendor, on) => ({ name, vendor, on });

const MODULES = [
  mod('Swissup_Breeze', 'Swissup', true),
  mod('Swissup_BreezeThemeEditor', 'Swissup', false),
  mod('Swissup_Amp', 'Swissup', true),
  mod('Magento_Catalog', 'Magento', true),
  mod('Amasty_Shopby', 'Amasty', false),
];

test('matches: empty query matches everything', () => {
  assert.equal(matches(MODULES[0], ''), true);
});

test('matches: positive terms are OR-ed, not AND-ed', () => {
  assert.equal(matches(mod('Swissup_Amp', 'Swissup', true), 'swissup magento'), true);
  assert.equal(matches(mod('Magento_Catalog', 'Magento', true), 'swissup magento'), true);
  assert.equal(matches(mod('Amasty_Shopby', 'Amasty', true), 'swissup magento'), false);
});

test('matches: -term excludes even when a positive term hits', () => {
  assert.equal(matches(mod('Swissup_Breeze', 'Swissup', true), 'swissup_ -breeze'), false);
  assert.equal(matches(mod('Swissup_Amp', 'Swissup', true), 'swissup_ -breeze'), true);
});

test('matches: a query of only exclusions keeps everything else', () => {
  assert.equal(matches(mod('Amasty_Shopby', 'Amasty', true), '-magento_ -swissup_'), true);
  assert.equal(matches(mod('Magento_Catalog', 'Magento', true), '-magento_ -swissup_'), false);
});

test('matches: vendor is searchable, not just the name', () => {
  assert.equal(matches(mod('GhostUnicorns_WebapiLogs', 'GhostUnicorns', true), 'ghostunicorns'), true);
});

test('filterMembers: query-mode saved filter, addressed by id', () => {
  const filters = [{ id: 'f1', name: 'third-party', query: '-Magento_ -Swissup_' }];
  assert.deepEqual(
    filterMembers(MODULES, 'f1', {}, filters).map((m) => m.name),
    ['Amasty_Shopby'],
  );
});

test('filterMembers: list-mode saved filter, ignoring the search box', () => {
  const filters = [{ id: 'f2', name: 'breeze', members: ['Swissup_Breeze', 'Swissup_BreezeThemeEditor'] }];
  assert.deepEqual(
    filterMembers(MODULES, 'f2', {}, filters).map((m) => m.name),
    ['Swissup_Breeze', 'Swissup_BreezeThemeEditor'],
  );
});

test('filterMembers: two filters sharing a name stay distinct, because id selects', () => {
  const filters = [
    { id: 'a', name: 'payments', query: 'PayPal_' },
    { id: 'b', name: 'payments', query: 'Amasty_' },
  ];
  assert.deepEqual(filterMembers(MODULES, 'b', {}, filters).map((m) => m.name), ['Amasty_Shopby']);
  assert.deepEqual(filterMembers(MODULES, 'a', {}, filters).map((m) => m.name), []);
});

test('filterMembers: Locked holds exactly the locked names that are installed', () => {
  const locked = ['Magento_Catalog', 'Amasty_Shopby', 'Gone_Module'];
  assert.deepEqual(
    filterMembers(MODULES, 'Locked', {}, [], locked).map((m) => m.name),
    ['Magento_Catalog', 'Amasty_Shopby'],
  );
  assert.deepEqual(filterMembers(MODULES, 'Locked', {}, []), []);
});

test('visibleModules: Locked composes with the search box', () => {
  const visible = visibleModules(MODULES, 'Locked', 'amasty', {}, [], ['Magento_Catalog', 'Amasty_Shopby']);
  assert.deepEqual(visible.map((m) => m.name), ['Amasty_Shopby']);
});

test('visibleModules: filter and query compose, result is name-sorted', () => {
  const visible = visibleModules(MODULES, 'Enabled', 'swissup_', {}, []);
  assert.deepEqual(visible.map((m) => m.name), ['Swissup_Amp', 'Swissup_Breeze']);
});

test('enabledFirst: enabled half first, order kept within each half', () => {
  const list = [mod('a', 'v', false), mod('b', 'v', true), mod('c', 'v', false), mod('d', 'v', true)];
  assert.deepEqual(enabledFirst(list).map((m) => m.name), ['b', 'd', 'a', 'c']);
});

test('enabledFirst: a module stays in the half it was sorted into', () => {
  // `b` was just disabled and `a` enabled; neither moves until the order is retaken.
  const list = [mod('a', 'v', true), mod('b', 'v', false), mod('c', 'v', true)];
  const wasOn = new Map([['a', false], ['b', true], ['c', true]]);
  assert.deepEqual(enabledFirst(list, wasOn).map((m) => m.name), ['b', 'c', 'a']);
});

test('enabledFirst: a module the order has not seen goes by its state now', () => {
  const list = [mod('a', 'v', false), mod('n', 'v', true)];
  assert.deepEqual(enabledFirst(list, new Map([['a', false]])).map((m) => m.name), ['n', 'a']);
});

test('inferVerb: all-on disables, anything off enables', () => {
  assert.equal(inferVerb([mod('a', 'v', true), mod('b', 'v', true)]), 'disable');
  assert.equal(inferVerb([mod('a', 'v', true), mod('b', 'v', false)]), 'enable');
  assert.equal(inferVerb([]), 'enable');
});

test('pickTargets: narrows to the modules the verb would actually change', () => {
  const pool = [mod('a', 'v', true), mod('b', 'v', false), mod('c', 'v', false)];
  assert.deepEqual(pickTargets('enable', pool).map((m) => m.name), ['b', 'c']);
  assert.deepEqual(pickTargets('disable', pool).map((m) => m.name), ['a']);
});

test('rangeSelect: covers the span inclusively, in either direction', () => {
  const names = ['a', 'b', 'c', 'd'];
  let seq = 0;
  const next = () => ++seq;
  assert.deepEqual(Object.keys(rangeSelect({}, names, 1, 3, true, next)), ['b', 'c', 'd']);
  assert.deepEqual(Object.keys(rangeSelect({}, names, 3, 1, true, next)), ['b', 'c', 'd']);
});

test('rangeSelect: deselecting a span leaves the rest alone', () => {
  const names = ['a', 'b', 'c'];
  const checked = { a: 1, b: 2, c: 3 };
  assert.deepEqual(rangeSelect(checked, names, 0, 1, false, () => 9), { c: 3 });
});

test('rangeSelect: re-selecting an already-checked row keeps its original seq', () => {
  const names = ['a', 'b'];
  const out = rangeSelect({ b: 1 }, names, 0, 1, true, () => 7);
  assert.deepEqual(out, { b: 1, a: 7 });
});

test('selectedNames: ordered by when each was picked, not alphabetically', () => {
  const checked = { Swissup_Amp: 2, Swissup_Breeze: 1 };
  assert.deepEqual(selectedNames(MODULES, checked), ['Swissup_Breeze', 'Swissup_Amp']);
});

test('keepOnly: returns null when every key still has a magento', () => {
  assert.equal(keepOnly({ a: [1], b: [2] }, ['a', 'b', 'c']), null);
});

test('keepOnly: drops orphaned magentos, keeps the rest', () => {
  assert.deepEqual(keepOnly({ a: [1], gone: [2], b: [3] }, ['a', 'b']), { a: [1], b: [3] });
});

test('keepOnly: does not mutate the input', () => {
  const input = { a: [1], gone: [2] };
  keepOnly(input, ['a']);
  assert.deepEqual(Object.keys(input), ['a', 'gone']);
});

test('keepOnly: no magentos left drops everything', () => {
  assert.deepEqual(keepOnly({ a: [1] }, []), {});
});

test('legacyEntry: recovers verb and modules from an old history row', () => {
  assert.deepEqual(legacyEntry('bin/magento module:disable Swissup_Breeze Amasty_Base'), {
    verb: 'disable',
    names: ['Swissup_Breeze', 'Amasty_Base'],
  });
});

test('legacyEntry: reads rows written with the php prefix too', () => {
  assert.deepEqual(legacyEntry('php bin/magento module:enable Magento_Csp'), {
    verb: 'enable',
    names: ['Magento_Csp'],
  });
});

test('legacyEntry: null for anything it cannot read, so ▶/↺ stay hidden', () => {
  assert.equal(legacyEntry('bin/magento setup:upgrade'), null);
  assert.equal(legacyEntry(undefined), null);
});

test('dependentsIn: picks the dependents out of a disable constraint error', () => {
  const msg = [
    'Unable to change status of modules because of the following constraints:',
    'Cannot disable Magento_Store because modules depend on it:',
    '\tMagento_Catalog',
    '\tMagento_Cms',
  ].join('\n');
  assert.deepEqual(dependentsIn(msg, ['Magento_Store']), ['Magento_Catalog', 'Magento_Cms']);
});

test('dependentsIn: handles the enable wording too', () => {
  const msg = 'Cannot enable Swissup_Breeze because it depends on disabled modules:\n\tSwissup_Core';
  assert.deepEqual(dependentsIn(msg, ['Swissup_Breeze']), ['Swissup_Core']);
});

test('dependentsIn: no duplicates, and nothing already asked for', () => {
  const msg = 'Magento_A depends on Magento_B, and Magento_B depends on Magento_A';
  assert.deepEqual(dependentsIn(msg, ['Magento_A']), ['Magento_B']);
});

test('dependentsIn: empty when the error names no modules', () => {
  assert.deepEqual(dependentsIn('php: command not found', ['Magento_A']), []);
});

test('matches: ! excludes', () => {
  const m = { name: 'Swissup_Breeze', vendor: 'Swissup' };
  assert.equal(matches(m, 'swissup_ !breeze'), false);
  assert.equal(matches(m, 'swissup_ !amasty'), true);
});

test('matches: - still excludes, for filters saved before the switch', () => {
  const m = { name: 'Magento_Store', vendor: 'Magento' };
  assert.equal(matches({ name: 'Swissup_Core', vendor: 'Swissup' }, '-Magento_ -Swissup_'), false);
  assert.equal(matches(m, '-Magento_ -Swissup_'), false);
  assert.equal(matches({ name: 'Amasty_Base', vendor: 'Amasty' }, '-Magento_ -Swissup_'), true);
});

test('matches: a bare ! or - is a term, not a negation', () => {
  const m = { name: 'Swissup_Breeze', vendor: 'Swissup' };
  assert.equal(matches(m, '!'), false);
  assert.equal(matches(m, '-'), false);
});

test('parseSshTarget: a pasted command fills user, host and key', () => {
  assert.deepEqual(parseSshTarget('ssh root@22.128.4.45 -i ~/.ssh/id_rsa'), {
    keyPath: '~/.ssh/id_rsa',
    user: 'root',
    host: '22.128.4.45',
  });
});

test('parseSshTarget: user@host, with or without a scheme', () => {
  assert.deepEqual(parseSshTarget('root@2.28.4.45'), { user: 'root', host: '2.28.4.45' });
  assert.deepEqual(parseSshTarget('ssh://deploy@acme-prod'), { user: 'deploy', host: 'acme-prod' });
});

test('parseSshTarget: a flag never swallows the destination', () => {
  // -p takes a value, -4 does not, and `ls` is a remote command.
  assert.deepEqual(parseSshTarget('ssh -4 -p 2222 -i ~/k deploy@host ls'), {
    keyPath: '~/k',
    port: 2222,
    user: 'deploy',
    host: 'host',
  });
});

test('parseSshTarget: a port on the destination, but not an IPv6 address', () => {
  assert.deepEqual(parseSshTarget('root@10.0.0.4:2222'), {
    port: 2222,
    user: 'root',
    host: '10.0.0.4',
  });
  assert.deepEqual(parseSshTarget('ssh://deploy@acme:2222'), {
    port: 2222,
    user: 'deploy',
    host: 'acme',
  });
  assert.deepEqual(parseSshTarget('root@[fe80::1]'), { user: 'root', host: '[fe80::1]' });
});

test('parseSshTarget: a plain hostname is left where it was typed', () => {
  assert.equal(parseSshTarget('acme-prod'), null);
  assert.equal(parseSshTarget(''), null);
});

test('snapshotChanges: only the modules that differ, by direction', () => {
  const snapshot = {
    state: { Swissup_Breeze: 0, Swissup_BreezeThemeEditor: 1, Swissup_Amp: 1 },
  };
  assert.deepEqual(snapshotChanges(MODULES, snapshot), {
    // Swissup_Amp is already on, so it is in neither list.
    enable: ['Swissup_BreezeThemeEditor'],
    disable: ['Swissup_Breeze'],
    missing: [],
  });
});

test('snapshotChanges: a module it wants on, but which is not installed, is missing', () => {
  const snapshot = { state: { ...Object.fromEntries(MODULES.map((m) => [m.name, m.on ? 1 : 0])), Swissup_Gone: 1 } };
  const { enable, disable, missing } = snapshotChanges(MODULES, snapshot);
  // Nothing to run, yet the state it describes is not the one this install is in.
  assert.deepEqual({ enable, disable }, { enable: [], disable: [] });
  assert.deepEqual(missing, ['Swissup_Gone']);
});

test('snapshotChanges: a module it wants off and which is not installed is already off', () => {
  const snapshot = { state: { Swissup_Gone: 0 } };
  assert.deepEqual(snapshotChanges(MODULES, snapshot), { enable: [], disable: [], missing: [] });
});

test('snapshotChanges: nothing to do when the state already matches', () => {
  const snapshot = { state: Object.fromEntries(MODULES.map((m) => [m.name, m.on ? 1 : 0])) };
  assert.deepEqual(snapshotChanges(MODULES, snapshot), { enable: [], disable: [], missing: [] });
});

test('snapshotChanges: a module the snapshot never saw is left alone', () => {
  assert.deepEqual(snapshotChanges(MODULES, { state: {} }), { enable: [], disable: [], missing: [] });
});

test('inFilter: the listed modules are in whatever the expression says', () => {
  const filter = { members: ['Magento_Catalog'], query: 'Amasty_' };
  // Listed, and the expression would never have matched it.
  assert.equal(inFilter(MODULES[3], filter), true);
  // Matched by the expression, not listed.
  assert.equal(inFilter(MODULES[4], filter), true);
  assert.equal(inFilter(MODULES[0], filter), false);
});

test('inFilter: a listed module survives an expression that excludes it', () => {
  const filter = { members: ['Swissup_Breeze'], query: '!Swissup_' };
  assert.equal(inFilter(MODULES[0], filter), true);
});

test('inFilter: an empty expression adds nothing, unlike the search box', () => {
  assert.equal(inFilter(MODULES[0], { members: ['Swissup_Breeze'] }), true);
  assert.equal(inFilter(MODULES[1], { members: ['Swissup_Breeze'], query: '  ' }), false);
  assert.equal(inFilter(MODULES[1], {}), false);
});

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 9, 18, 10);

test('entryTime: prefers the stored time, else decodes the id', () => {
  assert.equal(entryTime({ at: 5, id: 'hzzz' }), 5);
  const ms = at(2026, 9, 16);
  assert.equal(entryTime({ id: `h${ms.toString(36)}a` }), ms);
  assert.equal(entryTime({ id: 'x1' }), null);
  assert.equal(entryTime({ at: null, id: `h${at(2026, 9, 16).toString(36)}a` }), null);
  assert.equal(entryTime({}), null);
});

test('dayLabel: today, yesterday, days ago, then the date', () => {
  assert.equal(dayLabel(at(2026, 9, 18, 1), NOW), null);
  assert.equal(dayLabel(at(2026, 9, 17, 23), NOW).label, 'yesterday');
  assert.equal(dayLabel(at(2026, 9, 15), NOW).label, '3 days ago');
  assert.match(dayLabel(at(2026, 9, 1), NOW).label, /September/);
  assert.doesNotMatch(dayLabel(at(2026, 9, 1), NOW).label, /2026/);
  assert.match(dayLabel(at(2025, 9, 1), NOW).label, /2025/);
  assert.match(dayLabel(at(2026, 9, 15), NOW).title, /2026/);
});

test('withDayDividers: one divider per earlier day, none for today', () => {
  const rows = [
    { id: 'a', at: at(2026, 9, 18, 9) },
    { id: 'b', at: at(2026, 9, 17, 20) },
    { id: 'c' },
    { id: 'd', at: at(2026, 9, 17, 8) },
    { id: 'e', at: at(2026, 9, 15) },
  ];
  const out = withDayDividers(rows, NOW);
  assert.deepEqual(
    out.map((r) => (r.divider ? r.label : r.id)),
    ['a', 'yesterday', 'b', 'c', 'd', '3 days ago', 'e'],
  );
});
