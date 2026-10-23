// Run with `npm test` (node:test). Named *.node-test.mjs so the repo's vitest glob ignores it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INPUT, cableVoltageDrop, cellTempC, checkDesign, chooseLayout, loadFromAppliances,
  moduleVoltages, sizeArray, sizeBattery, stringLimits, validateInput,
} from '../src/solar-calc.js';

const input = (patch = {}) => {
  const base = structuredClone(DEFAULT_INPUT);
  for (const [group, values] of Object.entries(patch)) base[group] = { ...base[group], ...values };
  return base;
};
const statusOf = (result, id) => result.checks.find((c) => c.id === id)?.status;

test('sizeArray derives kWp from load, sun hours and losses', () => {
  const r = sizeArray({ dailyKwh: 20, peakSunHours: 5, systemLossPct: 20, panelWp: 400 });
  assert.equal(r.requiredKwp, 5); // 20 / (5 × 0.8)
  assert.equal(r.panelCount, 13); // ceil(5000 / 400)
  assert.equal(r.actualKwp, 5.2);
  assert.ok(r.estDailyKwh >= 20);
});

test('appliance loads sum to daily kWh', () => {
  assert.equal(loadFromAppliances([{ watts: 100, hoursPerDay: 5, qty: 2 }, { watts: 1000, hoursPerDay: 1, qty: 1 }]), 2);
});

test('NOCT cell temperature model', () => {
  assert.equal(cellTempC(40, 45), 71.25);
});

test('Voc rises in the cold and Vmp falls in the heat', () => {
  const v = moduleVoltages(DEFAULT_INPUT.panel, DEFAULT_INPUT.site);
  assert.ok(v.vocMax > DEFAULT_INPUT.panel.voc);
  assert.ok(v.vmpMin < DEFAULT_INPUT.panel.vmp);
  assert.equal(v.vocMax, 54.18); // 49.5 × (1 + 0.0027 × 35)
});

test('string limits bracket the inverter voltage window', () => {
  const l = stringLimits(DEFAULT_INPUT.panel, DEFAULT_INPUT.inverter, DEFAULT_INPUT.site);
  assert.equal(l.maxModules, 11); // floor(600 / 54.18)
  assert.ok(l.minModules * l.vmpMin >= DEFAULT_INPUT.inverter.mpptMinV);
  assert.ok(l.maxModules * l.vocMax <= DEFAULT_INPUT.inverter.maxDcVoltage);
});

test('chooseLayout splits across MPPTs when one string is too long', () => {
  const layout = chooseLayout(20, { minModules: 3, maxModules: 11 }, { mpptCount: 2, maxStringsPerMppt: 1 });
  assert.deepEqual(layout, { modulesPerString: 10, strings: 2, totalModules: 20, stringsPerMppt: 1 });
});

test('default design passes every check', () => {
  const r = checkDesign(input());
  assert.equal(r.ok, true);
  assert.equal(r.summary.verdict, 'pass', JSON.stringify(r.checks.filter((c) => c.status !== 'pass')));
});

test('cold climate shortens strings to stay under the inverter Voc limit', () => {
  const r = checkDesign(input({ site: { minAmbientC: -40 }, inverter: { maxDcVoltage: 500, mpptMaxV: 480 } }));
  assert.equal(statusOf(r, 'voc-max'), 'pass'); // layout adapts to the shorter limit
  assert.ok(r.layout.modulesPerString * r.limits.vocMax <= 500);
});

test('impossible voltage window is reported as a failure', () => {
  const r = checkDesign(input({ inverter: { mpptMinV: 450, mpptMaxV: 480, maxDcVoltage: 500 } }));
  assert.equal(r.summary.verdict, 'fail');
  assert.equal(statusOf(r, 'string-window'), 'fail');
});

test('excess parallel strings fail the short-circuit current check', () => {
  const r = checkDesign(input({ load: { dailyKwh: 60 }, inverter: { maxStringsPerMppt: 2, maxShortCircuitA: 20 } }));
  assert.equal(r.layout.stringsPerMppt, 2);
  assert.equal(statusOf(r, 'mppt-isc'), 'fail');
});

test('undersized inverter produces a high DC/AC ratio', () => {
  assert.equal(statusOf(checkDesign(input({ inverter: { acKw: 2.5 } })), 'dc-ac'), 'fail');
});

test('battery sizing accounts for autonomy, DoD and efficiency', () => {
  const b = sizeBattery({ dailyKwh: 10, autonomyDays: 2, dodPct: 80, systemVoltage: 48, roundTripEffPct: 100 });
  assert.deepEqual(b, { usableKwh: 20, nominalKwh: 25, ampHours: 521 });
});

test('cable voltage drop uses the round-trip length', () => {
  const r = cableVoltageDrop({ currentA: 10, lengthM: 50, crossSectionMm2: 4, voltage: 400 });
  assert.equal(r.dropV, 4.38); // 2 × 50 × 10 × 0.0175 / 4
  assert.equal(r.dropPct, 1.09);
  const thin = checkDesign(input({ cable: { lengthM: 150, crossSectionMm2: 2.5 } }));
  assert.equal(statusOf(thin, 'cable-drop'), 'fail');
});

test('validateInput rejects bad values at the boundary', () => {
  const errors = validateInput(input({ load: { dailyKwh: -1 }, panel: { vmp: 60 }, site: { systemLossPct: 120 } }));
  assert.ok(errors.some((e) => e.startsWith('load.dailyKwh')));
  assert.ok(errors.some((e) => e.startsWith('panel.vmp')));
  assert.ok(errors.some((e) => e.startsWith('site.systemLossPct')));
  assert.equal(checkDesign(input({ panel: { wp: Number.NaN } })).ok, false);
});

test('disabled optional sections are not validated', () => {
  assert.deepEqual(validateInput(input({ battery: { enabled: false, dodPct: Number.NaN } })), []);
});
