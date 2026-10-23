/**
 * Solar PV sizing & design-check engine.
 *
 * Pure functions, no DOM access — shared by the browser UI and the Node tests.
 * Units: kW / kWh / W, volts, amps, metres, mm², °C, temperature coefficients
 * in %/°C (negative for voltage and power).
 */

export const STC_TEMP_C = 25;

/** Resistivity at ~20 °C in Ω·mm²/m. */
export const RESISTIVITY = Object.freeze({ copper: 0.0175, aluminium: 0.0282 });

/** Approximate annual-average peak sun hours (kWh/m²/day, latitude tilt). Verify with PVGIS / PVWatts. */
export const PSH_PRESETS = Object.freeze([
  { name: 'Phoenix, US', psh: 6.5 },
  { name: 'Los Angeles, US', psh: 5.6 },
  { name: 'Denver, US', psh: 5.5 },
  { name: 'Miami, US', psh: 5.3 },
  { name: 'New York, US', psh: 4.5 },
  { name: 'Seattle, US', psh: 3.7 },
  { name: 'London, UK', psh: 2.7 },
  { name: 'Berlin, DE', psh: 2.9 },
  { name: 'Madrid, ES', psh: 5.0 },
  { name: 'Dubai, AE', psh: 6.0 },
  { name: 'Riyadh, SA', psh: 6.2 },
  { name: 'Cairo, EG', psh: 6.0 },
  { name: 'Lagos, NG', psh: 5.0 },
  { name: 'Nairobi, KE', psh: 5.8 },
  { name: 'Johannesburg, ZA', psh: 5.9 },
  { name: 'Mumbai, IN', psh: 5.2 },
  { name: 'Sydney, AU', psh: 5.0 },
  { name: 'Perth, AU', psh: 5.9 },
]);

export const DEFAULT_INPUT = Object.freeze({
  load: { dailyKwh: 20 },
  site: { peakSunHours: 5, systemLossPct: 14, minAmbientC: -10, maxAmbientC: 40 },
  panel: {
    wp: 450, voc: 49.5, vmp: 41.5, isc: 11.6, imp: 10.85,
    tempCoeffVocPct: -0.27, tempCoeffPmaxPct: -0.35, noctC: 45,
  },
  inverter: {
    acKw: 4.6, maxDcVoltage: 600, mpptMinV: 90, mpptMaxV: 550,
    mpptCount: 2, maxInputCurrentA: 14, maxShortCircuitA: 18, maxStringsPerMppt: 1,
  },
  battery: { enabled: false, autonomyDays: 1, dodPct: 90, systemVoltage: 48, roundTripEffPct: 95 },
  cable: { enabled: true, lengthM: 20, crossSectionMm2: 4, material: 'copper' },
  /** A contractor's proposed layout and claims; when enabled it replaces the auto layout. */
  contractor: {
    enabled: false, modulesPerString: 11, strings: 1, inverterCount: 1,
    claimedKwp: Number.NaN, claimedAnnualKwh: Number.NaN,
  },
});

const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Daily energy (kWh) from an appliance list of { watts, hoursPerDay, qty }. */
export function loadFromAppliances(appliances) {
  return appliances.reduce(
    (sum, a) => sum + (Number(a.watts) || 0) * (Number(a.hoursPerDay) || 0) * (Number(a.qty) || 0),
    0,
  ) / 1000;
}

/** Array size needed to cover the daily load, and the module count that achieves it. */
export function sizeArray({ dailyKwh, peakSunHours, systemLossPct, panelWp }) {
  const derate = 1 - systemLossPct / 100;
  const requiredKwp = dailyKwh / (peakSunHours * derate);
  const panelCount = Math.max(1, Math.ceil((requiredKwp * 1000) / panelWp));
  return arrayOutput({ requiredKwp, panelCount, panelWp, peakSunHours, derate });
}

function arrayOutput({ requiredKwp, panelCount, panelWp, peakSunHours, derate }) {
  const actualKwp = (panelCount * panelWp) / 1000;
  const estDailyKwh = actualKwp * peakSunHours * derate;
  return {
    requiredKwp: round(requiredKwp, 3),
    panelCount,
    actualKwp: round(actualKwp, 3),
    estDailyKwh: round(estDailyKwh),
    estAnnualKwh: Math.round(estDailyKwh * 365),
    specificYield: Math.round(peakSunHours * derate * 365),
  };
}

/** Cell temperature at 1000 W/m² from ambient, using the NOCT model. */
export function cellTempC(ambientC, noctC = 45, irradiance = 1000) {
  return ambientC + ((noctC - 20) / 800) * irradiance;
}

/**
 * Temperature-corrected module voltages.
 * Voc is maximised at the coldest ambient (cell ≈ ambient at sunrise);
 * Vmp is minimised at the hottest cell temperature. Vmp is scaled with the
 * Pmax coefficient when no dedicated Vmp coefficient is given (conservative).
 */
export function moduleVoltages(panel, site) {
  const vmpCoeff = panel.tempCoeffVmpPct ?? panel.tempCoeffPmaxPct;
  const hotCell = cellTempC(site.maxAmbientC, panel.noctC);
  const coldCell = site.minAmbientC;
  return {
    vocMax: round(panel.voc * (1 + (panel.tempCoeffVocPct / 100) * (coldCell - STC_TEMP_C))),
    vmpMax: round(panel.vmp * (1 + (vmpCoeff / 100) * (coldCell - STC_TEMP_C))),
    vmpMin: round(panel.vmp * (1 + (vmpCoeff / 100) * (hotCell - STC_TEMP_C))),
    hotCellC: round(hotCell, 1),
  };
}

/** Allowed series-module range for the inverter. */
export function stringLimits(panel, inverter, site) {
  const v = moduleVoltages(panel, site);
  return {
    ...v,
    maxModules: Math.floor(inverter.maxDcVoltage / v.vocMax),
    minModules: Math.ceil(inverter.mpptMinV / v.vmpMin),
  };
}

/**
 * Choose modules-per-string and string count for ~targetModules.
 * Prefers the layout whose total is closest to the target, then longer strings.
 */
export function chooseLayout(targetModules, limits, inverter) {
  const maxStrings = inverter.mpptCount * inverter.maxStringsPerMppt;
  let best = null;
  for (let m = limits.maxModules; m >= Math.max(1, limits.minModules); m--) {
    const strings = Math.min(maxStrings, Math.max(1, Math.round(targetModules / m)));
    const total = strings * m;
    const diff = Math.abs(total - targetModules);
    const better = !best || diff < best.diff || (diff === best.diff && total >= targetModules && best.totalModules < targetModules);
    if (better) best = { modulesPerString: m, strings, totalModules: total, diff };
  }
  if (!best) return null;
  const { diff, ...layout } = best;
  return { ...layout, stringsPerMppt: Math.ceil(layout.strings / inverter.mpptCount) };
}

export function sizeBattery({ dailyKwh, autonomyDays, dodPct, systemVoltage, roundTripEffPct }) {
  const usableKwh = dailyKwh * autonomyDays;
  const nominalKwh = usableKwh / (dodPct / 100) / (roundTripEffPct / 100);
  return {
    usableKwh: round(usableKwh),
    nominalKwh: round(nominalKwh),
    ampHours: Math.ceil((nominalKwh * 1000) / systemVoltage),
  };
}

/** Round-trip DC voltage drop for a cable run of lengthM (one-way). */
export function cableVoltageDrop({ currentA, lengthM, crossSectionMm2, voltage, material = 'copper' }) {
  const rho = RESISTIVITY[material] ?? RESISTIVITY.copper;
  const dropV = (2 * lengthM * currentA * rho) / crossSectionMm2;
  return { dropV: round(dropV), dropPct: round((dropV / voltage) * 100) };
}

const POSITIVE = {
  load: ['dailyKwh'],
  site: ['peakSunHours'],
  panel: ['wp', 'voc', 'vmp', 'isc', 'imp'],
  inverter: ['acKw', 'maxDcVoltage', 'mpptMinV', 'mpptMaxV', 'mpptCount', 'maxInputCurrentA', 'maxStringsPerMppt'],
  battery: ['autonomyDays', 'dodPct', 'systemVoltage', 'roundTripEffPct'],
  cable: ['lengthM', 'crossSectionMm2'],
  contractor: ['modulesPerString', 'strings', 'inverterCount'],
};
const OPTIONAL_GROUPS = new Set(['battery', 'cable', 'contractor']);

/** Boundary validation. Returns a list of human-readable errors (empty when valid). */
export function validateInput(input) {
  const errors = [];
  for (const [group, keys] of Object.entries(POSITIVE)) {
    if (OPTIONAL_GROUPS.has(group) && !input[group]?.enabled) continue;
    for (const key of keys) {
      const v = input[group]?.[key];
      if (!Number.isFinite(v) || v <= 0) errors.push(`${group}.${key} must be a positive number`);
    }
  }
  const { site = {}, panel = {}, inverter = {}, battery = {} } = input;
  if (!Number.isFinite(site.systemLossPct) || site.systemLossPct < 0 || site.systemLossPct >= 100) {
    errors.push('site.systemLossPct must be between 0 and 99');
  }
  if (!(site.minAmbientC < site.maxAmbientC)) errors.push('site.minAmbientC must be below site.maxAmbientC');
  if (panel.vmp >= panel.voc) errors.push('panel.vmp must be below panel.voc');
  if (panel.imp >= panel.isc) errors.push('panel.imp must be below panel.isc');
  if (!(panel.tempCoeffVocPct < 0)) errors.push('panel.tempCoeffVocPct must be negative');
  if (!(panel.tempCoeffPmaxPct < 0)) errors.push('panel.tempCoeffPmaxPct must be negative');
  if (inverter.mpptMinV >= inverter.mpptMaxV) errors.push('inverter.mpptMinV must be below inverter.mpptMaxV');
  if (inverter.mpptMaxV > inverter.maxDcVoltage) errors.push('inverter.mpptMaxV cannot exceed inverter.maxDcVoltage');
  const { contractor = {} } = input;
  if (contractor.enabled) {
    for (const key of POSITIVE.contractor) {
      if (Number.isFinite(contractor[key]) && !Number.isInteger(contractor[key])) {
        errors.push(`contractor.${key} must be a whole number`);
      }
    }
  }
  if (battery.enabled && (battery.dodPct > 100 || battery.roundTripEffPct > 100)) {
    errors.push('battery DoD and efficiency must be ≤ 100%');
  }
  return errors;
}

const check = (id, label, status, detail) => ({ id, label, status, detail });

/** Full sizing + design verification. */
export function checkDesign(input) {
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };

  const { load, site, panel, inverter, battery, cable, contractor } = input;
  const sizing = sizeArray({ ...site, dailyKwh: load.dailyKwh, panelWp: panel.wp });
  const limits = stringLimits(panel, inverter, site);
  const fromContractor = Boolean(contractor?.enabled);
  const layout = fromContractor
    ? contractorLayout(contractor, inverter)
    : limits.maxModules >= limits.minModules ? { ...chooseLayout(sizing.panelCount, limits, inverter), inverterCount: 1 } : null;
  const checks = [];

  if (!layout) {
    checks.push(check('string-window', 'String voltage window', 'fail',
      `No valid string length: max ${limits.maxModules} (Voc limit) < min ${limits.minModules} (MPPT min).`));
    return { ok: true, sizing, limits, layout, checks, summary: summarize(checks) };
  }

  const derate = 1 - site.systemLossPct / 100;
  const design = arrayOutput({
    requiredKwp: sizing.requiredKwp, panelCount: layout.totalModules,
    panelWp: panel.wp, peakSunHours: site.peakSunHours, derate,
  });
  const m = layout.modulesPerString;
  const stringVocMax = round(m * limits.vocMax);
  const stringVmpMin = round(m * limits.vmpMin);
  const stringVmpMax = round(m * limits.vmpMax);
  const stringVmpStc = round(m * panel.vmp);
  const mpptImp = round(layout.stringsPerMppt * panel.imp);
  const mpptIsc = round(layout.stringsPerMppt * panel.isc * 1.25);
  const totalAcKw = round(inverter.acKw * layout.inverterCount, 3);
  const dcAcRatio = round(design.actualKwp / totalAcKw);

  if (fromContractor) {
    const capacity = layout.inverterCount * inverter.mpptCount * inverter.maxStringsPerMppt;
    checks.push(check('string-count', 'Strings fit the inverter inputs',
      layout.strings <= capacity ? 'pass' : 'fail',
      `${layout.strings} strings vs ${capacity} inputs (${layout.inverterCount} inverter × ` +
      `${inverter.mpptCount} MPPT × ${inverter.maxStringsPerMppt})`));
  }

  checks.push(check('voc-max', 'Max string Voc (cold) vs inverter max DC',
    stringVocMax <= inverter.maxDcVoltage ? 'pass' : 'fail',
    `${stringVocMax} V at ${site.minAmbientC} °C vs ${inverter.maxDcVoltage} V limit`));

  checks.push(check('vmp-min', 'Min string Vmp (hot) vs MPPT minimum',
    stringVmpMin >= inverter.mpptMinV ? 'pass' : 'fail',
    `${stringVmpMin} V at ${limits.hotCellC} °C cell vs ${inverter.mpptMinV} V`));

  checks.push(check('vmp-max', 'Max string Vmp (cold) vs MPPT maximum',
    stringVmpMax <= inverter.mpptMaxV ? 'pass' : 'warn',
    `${stringVmpMax} V vs ${inverter.mpptMaxV} V MPPT max (above it the inverter loses tracking)`));

  checks.push(check('vmp-stc', 'String Vmp at STC within MPPT window',
    stringVmpStc >= inverter.mpptMinV && stringVmpStc <= inverter.mpptMaxV ? 'pass' : 'warn',
    `${stringVmpStc} V in ${inverter.mpptMinV}–${inverter.mpptMaxV} V`));

  checks.push(check('mppt-current', 'Operating current per MPPT',
    mpptImp <= inverter.maxInputCurrentA ? 'pass' : 'warn',
    `${mpptImp} A vs ${inverter.maxInputCurrentA} A max input (excess is clipped)`));

  if (Number.isFinite(inverter.maxShortCircuitA) && inverter.maxShortCircuitA > 0) {
    checks.push(check('mppt-isc', 'Short-circuit current per MPPT (×1.25)',
      mpptIsc <= inverter.maxShortCircuitA ? 'pass' : 'fail',
      `${mpptIsc} A vs ${inverter.maxShortCircuitA} A max Isc`));
  }

  checks.push(check('dc-ac', 'DC/AC ratio',
    dcAcRatio >= 1 && dcAcRatio <= 1.3 ? 'pass' : dcAcRatio >= 0.8 && dcAcRatio <= 1.5 ? 'warn' : 'fail',
    `${dcAcRatio} (${design.actualKwp} kWp / ${totalAcKw} kW); typical 1.0–1.3`));

  checks.push(check('energy', 'Array covers daily load',
    design.estDailyKwh >= load.dailyKwh ? 'pass' : 'warn',
    `${design.estDailyKwh} kWh/day estimated vs ${load.dailyKwh} kWh/day load`));

  if (fromContractor) checks.push(...claimChecks(contractor, design));
  else if (layout.totalModules !== sizing.panelCount) {
    checks.push(check('layout', 'Module count fits string layout', 'warn',
      `${sizing.panelCount} modules needed; nearest valid layout uses ${layout.totalModules} ` +
      `(${layout.strings} × ${m}).`));
  }

  let batteryResult = null;
  if (battery?.enabled) {
    batteryResult = sizeBattery({ ...battery, dailyKwh: load.dailyKwh });
    const surplus = design.estDailyKwh - load.dailyKwh;
    const rechargeDays = surplus > 0 ? round(batteryResult.usableKwh / surplus, 1) : Infinity;
    checks.push(check('battery-recharge', 'Battery recharge after autonomy period',
      rechargeDays <= 3 ? 'pass' : 'warn',
      surplus > 0
        ? `${round(surplus)} kWh/day PV surplus refills ${batteryResult.usableKwh} kWh in ~${rechargeDays} days`
        : 'No PV surplus over the daily load — the battery cannot recover after a cloudy spell'));
  }

  let cableResult = null;
  if (cable?.enabled) {
    cableResult = cableVoltageDrop({
      currentA: panel.imp, lengthM: cable.lengthM, crossSectionMm2: cable.crossSectionMm2,
      voltage: stringVmpStc, material: cable.material,
    });
    checks.push(check('cable-drop', 'DC string cable voltage drop',
      cableResult.dropPct <= 2 ? 'pass' : cableResult.dropPct <= 3 ? 'warn' : 'fail',
      `${cableResult.dropPct}% (${cableResult.dropV} V) over ${cable.lengthM} m of ${cable.crossSectionMm2} mm² ` +
      `${cable.material}; aim ≤ 2%`));
  }

  return {
    ok: true,
    sizing,
    design,
    limits,
    layout,
    strings: { stringVocMax, stringVmpMin, stringVmpMax, stringVmpStc, mpptImp, mpptIsc },
    dcAcRatio,
    battery: batteryResult,
    cable: cableResult,
    checks,
    summary: summarize(checks),
  };
}

function contractorLayout({ modulesPerString, strings, inverterCount }, inverter) {
  return {
    modulesPerString, strings, inverterCount,
    totalModules: modulesPerString * strings,
    stringsPerMppt: Math.ceil(strings / (inverterCount * inverter.mpptCount)),
    source: 'contractor',
  };
}

/** Compare a contractor's stated size and yield with what the design actually supports. */
export function claimChecks({ claimedKwp, claimedAnnualKwh }, design) {
  const out = [];
  if (Number.isFinite(claimedKwp) && claimedKwp > 0) {
    const diffPct = round(((claimedKwp - design.actualKwp) / design.actualKwp) * 100, 1);
    out.push(check('claim-kwp', 'Stated array size matches modules × Wp',
      Math.abs(diffPct) <= 2 ? 'pass' : 'fail',
      `Stated ${claimedKwp} kWp vs ${design.actualKwp} kWp from the layout (${diffPct > 0 ? '+' : ''}${diffPct}%)`));
  }
  if (Number.isFinite(claimedAnnualKwh) && claimedAnnualKwh > 0) {
    const ratio = claimedAnnualKwh / design.estAnnualKwh;
    const overPct = round((ratio - 1) * 100, 1);
    out.push(check('claim-yield', 'Stated annual production is realistic',
      ratio <= 1.1 ? 'pass' : ratio <= 1.25 ? 'warn' : 'fail',
      `Stated ${claimedAnnualKwh.toLocaleString('en-US')} kWh/yr vs ` +
      `${design.estAnnualKwh.toLocaleString('en-US')} kWh/yr estimated ` +
      `(${overPct > 0 ? '+' : ''}${overPct}%; >10% above the estimate needs justification)`));
  }
  return out;
}

function summarize(checks) {
  const count = (s) => checks.filter((c) => c.status === s).length;
  const fail = count('fail');
  const warn = count('warn');
  return { pass: count('pass'), warn, fail, verdict: fail ? 'fail' : warn ? 'warn' : 'pass' };
}
