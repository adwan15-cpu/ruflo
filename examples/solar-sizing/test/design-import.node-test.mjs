// Run with `npm test` (node:test). Named *.node-test.mjs so the repo's vitest glob ignores it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INPUT, checkDesign } from '../src/solar-calc.js';
import {
  applyImport, csvTemplate, extractFromText, matchKey, normalizeValue, parseDesignFile, parseJson,
  parseKeyValue, parseNumber,
} from '../src/design-import.js';

const PROPOSAL = `SOLAR PV PROPOSAL — ACME Solar
System size: 9.9 kWp   Annual energy yield: 16,500 kWh
PV module: XYZ-450M  Rated power (Pmax) 450 Wp
Open circuit voltage (Voc) 49.5 V  Max power voltage (Vmp) 41.5 V
Short circuit current (Isc) 11.6 A  Max power current (Imp) 10.85 A
Temperature coefficient of Voc -0.27 %/°C  Temperature coefficient of Pmax -0.35 %/°C  NOCT 45 °C
Inverter: ABC 8K  Rated AC power 8000 W  Max. DC input voltage 600 V  MPPT voltage range 90 - 550 V
Number of MPPTs 2  Strings per MPPT 1  Max. input current per MPPT 14 A  Max. short-circuit current 18 A
String configuration: 2 strings, 11 modules per string. Number of inverters: 1
Minimum design temperature -10 °C`;

const statusOf = (r, id) => r.checks.find((c) => c.id === id)?.status;

test('parseNumber handles separators and unicode minus', () => {
  assert.equal(parseNumber('16,500'), 16500);
  assert.equal(parseNumber('49,5'), 49.5);
  assert.equal(parseNumber('−0.27'), -0.27);
  assert.equal(parseNumber('1,234.5'), 1234.5);
});

test('unit normalisation converts W/kW/MWh', () => {
  assert.equal(normalizeValue('kw', 8000, 'W').value, 8);
  assert.equal(normalizeValue('kwh', 16.5, 'MWh/yr').value, 16500);
  assert.equal(normalizeValue('wp', 0.45, 'kWp').value, 450);
  assert.equal(normalizeValue('kwp', 9900, 'Wp').value, 9.9);
});

test('matchKey resolves exact paths and common labels', () => {
  assert.equal(matchKey('panel.voc'), 'panel.voc');
  assert.equal(matchKey('Open-circuit voltage (Voc)'), 'panel.voc');
  assert.equal(matchKey('Strings per MPPT'), 'inverter.maxStringsPerMppt');
  assert.equal(matchKey('Number of strings'), 'contractor.strings');
  assert.equal(matchKey('Inverter max short-circuit current'), 'inverter.maxShortCircuitA');
  assert.equal(matchKey('Module short-circuit current'), 'panel.isc');
  assert.equal(matchKey('favourite colour'), null);
});

test('free-text proposal extraction finds every key value', () => {
  const r = extractFromText(PROPOSAL, 'proposal.pdf');
  assert.deepEqual(r.missing, []);
  assert.equal(r.hasLayout, true);
  const v = r.values;
  assert.equal(v['contractor.modulesPerString'], 11);
  assert.equal(v['contractor.strings'], 2);
  assert.equal(v['inverter.acKw'], 8);
  assert.equal(v['inverter.maxStringsPerMppt'], 1);
  assert.equal(v['inverter.maxInputCurrentA'], 14);
  assert.equal(v['inverter.maxShortCircuitA'], 18);
  assert.equal(v['panel.isc'], 11.6);
  assert.equal(v['inverter.mpptMinV'], 90);
  assert.equal(v['inverter.mpptMaxV'], 550);
  assert.equal(v['contractor.claimedAnnualKwh'], 16500);
  assert.equal(v['site.minAmbientC'], -10);
});

test('"N × M modules" grid notation sets strings and string length', () => {
  const v = extractFromText('Array: 3 x 12 modules on roof').values;
  assert.equal(v['contractor.strings'], 3);
  assert.equal(v['contractor.modulesPerString'], 12);
});

test('vertical CSV with units in their own column', () => {
  const csv = 'Parameter,Value,Unit\nModule power,0.45,kWp\nVoc,49.5,V\nModules per string,10,\nTotal modules,20,\nMPPT voltage range,90-550,V\n';
  const r = parseKeyValue(csv, 'd.csv');
  assert.equal(r.values['panel.wp'], 450);
  assert.equal(r.values['contractor.strings'], 2); // derived from total ÷ per string
  assert.equal(r.values['inverter.mpptMaxV'], 550);
});

test('horizontal CSV (header row + value row) and semicolons', () => {
  const r = parseKeyValue('Voc;Vmp;Isc;Imp\n49,5;41,5;11,6;10,85\n', 'h.csv');
  assert.deepEqual([r.values['panel.voc'], r.values['panel.vmp'], r.values['panel.imp']], [49.5, 41.5, 10.85]);
});

test('CSV template round-trips through the parser', () => {
  const input = structuredClone(DEFAULT_INPUT);
  input.contractor = { ...input.contractor, modulesPerString: 9, strings: 2, claimedKwp: 8.1 };
  const r = parseDesignFile('template.csv', csvTemplate(input));
  assert.equal(r.values['contractor.modulesPerString'], 9);
  assert.equal(r.values['contractor.claimedKwp'], 8.1);
  assert.equal(r.values['panel.tempCoeffVocPct'], -0.27);
  assert.equal(r.values['battery.dodPct'], 90);
  assert.deepEqual(r.missing, []);
});

test('JSON: own export, nested input, and prototype keys ignored', () => {
  const exported = JSON.stringify({ input: { panel: { voc: 50 }, contractor: { strings: 3, modulesPerString: 8 } }, result: {} });
  const r = parseJson(exported);
  assert.equal(r.values['panel.voc'], 50);
  assert.equal(r.hasLayout, true);
  const evil = parseJson('{"__proto__": {"polluted": 1}, "Voc": "49 V"}');
  assert.equal(evil.values['panel.voc'], 49);
  assert.equal({}.polluted, undefined);
});

test('positive temperature coefficients are flipped with a note', () => {
  const r = extractFromText('Temperature coefficient of Voc 0.28 %/°C');
  assert.equal(r.values['panel.tempCoeffVocPct'], -0.28);
  assert.equal(r.notes.length, 1);
});

test('imported proposal is checked with the contractor layout and claims', () => {
  const imported = extractFromText(PROPOSAL, 'proposal.pdf');
  const input = applyImport(DEFAULT_INPUT, imported);
  assert.equal(input.contractor.enabled, true);
  const r = checkDesign(input);
  assert.equal(r.layout.source, 'contractor');
  assert.equal(r.layout.totalModules, 22);
  assert.equal(r.dcAcRatio, 1.24); // 9.9 kWp / 8 kW
  assert.equal(statusOf(r, 'claim-kwp'), 'pass');
  assert.equal(statusOf(r, 'claim-yield'), 'pass');
  assert.equal(statusOf(r, 'string-count'), 'pass');
});

test('contractor design faults are caught', () => {
  const base = structuredClone(DEFAULT_INPUT);
  base.contractor = { enabled: true, modulesPerString: 13, strings: 3, inverterCount: 1, claimedKwp: 20, claimedAnnualKwh: 40000 };
  const r = checkDesign(base);
  assert.equal(statusOf(r, 'voc-max'), 'fail'); // 13 × 54.18 V > 600 V
  assert.equal(statusOf(r, 'string-count'), 'fail'); // 3 strings, 2 inputs
  assert.equal(statusOf(r, 'claim-kwp'), 'fail'); // 17.55 kWp actual
  assert.equal(statusOf(r, 'claim-yield'), 'fail');
  assert.equal(r.summary.verdict, 'fail');
});

test('non-integer contractor counts are rejected', () => {
  const base = structuredClone(DEFAULT_INPUT);
  base.contractor = { ...base.contractor, enabled: true, strings: 1.5 };
  assert.equal(checkDesign(base).ok, false);
});
