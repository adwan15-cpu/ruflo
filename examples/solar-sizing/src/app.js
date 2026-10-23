import { DEFAULT_INPUT, PSH_PRESETS, checkDesign, loadFromAppliances } from './solar-calc.js';

const STORAGE_KEY = 'solar-sizing-check:v1';
const DAYS_PER_MONTH = 365 / 12;

/** Form schema: [key, label, unit, step]. */
const FIELDS = {
  site: [
    ['peakSunHours', 'Peak sun hours', 'h/day', 0.1],
    ['systemLossPct', 'System losses', '%', 1],
    ['minAmbientC', 'Record low temp', '°C', 1],
    ['maxAmbientC', 'Max ambient temp', '°C', 1],
  ],
  panel: [
    ['wp', 'Rated power', 'Wp', 5],
    ['voc', 'Voc', 'V', 0.1],
    ['vmp', 'Vmp', 'V', 0.1],
    ['isc', 'Isc', 'A', 0.01],
    ['imp', 'Imp', 'A', 0.01],
    ['tempCoeffVocPct', 'Temp. coeff. Voc', '%/°C', 0.01],
    ['tempCoeffPmaxPct', 'Temp. coeff. Pmax', '%/°C', 0.01],
    ['noctC', 'NOCT', '°C', 1],
  ],
  inverter: [
    ['acKw', 'Rated AC power', 'kW', 0.1],
    ['maxDcVoltage', 'Max DC input voltage', 'V', 10],
    ['mpptMinV', 'MPPT min voltage', 'V', 5],
    ['mpptMaxV', 'MPPT max voltage', 'V', 5],
    ['mpptCount', 'MPPT inputs', '', 1],
    ['maxStringsPerMppt', 'Strings per MPPT', 'max', 1],
    ['maxInputCurrentA', 'Max input current / MPPT', 'A', 0.5],
    ['maxShortCircuitA', 'Max short-circuit current / MPPT', 'A', 0.5],
  ],
  battery: [
    ['autonomyDays', 'Days of autonomy', 'days', 0.5],
    ['dodPct', 'Depth of discharge', '%', 1],
    ['systemVoltage', 'Battery bank voltage', 'V', 12],
    ['roundTripEffPct', 'Round-trip efficiency', '%', 1],
  ],
  cable: [
    ['lengthM', 'One-way length', 'm', 1],
    ['crossSectionMm2', 'Cross-section', 'mm²', 0.5],
    ['material', 'Conductor', '', null],
  ],
};

const DEFAULT_APPLIANCES = [
  { name: 'Refrigerator', watts: 150, hoursPerDay: 10, qty: 1 },
  { name: 'LED lighting', watts: 10, hoursPerDay: 6, qty: 8 },
  { name: 'Air conditioner', watts: 1200, hoursPerDay: 6, qty: 1 },
  { name: 'TV', watts: 100, hoursPerDay: 5, qty: 1 },
];

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let state = loadState();

function defaultState() {
  return {
    ...structuredClone(DEFAULT_INPUT),
    loadMode: 'daily',
    monthlyKwh: Math.round(DEFAULT_INPUT.load.dailyKwh * DAYS_PER_MONTH),
    appliances: structuredClone(DEFAULT_APPLIANCES),
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      const base = defaultState();
      for (const group of Object.keys(DEFAULT_INPUT)) base[group] = { ...base[group], ...saved[group] };
      return { ...saved, ...base, loadMode: saved.loadMode ?? base.loadMode,
        monthlyKwh: saved.monthlyKwh ?? base.monthlyKwh, appliances: saved.appliances ?? base.appliances };
    }
  } catch { /* storage unavailable or corrupt — fall back to defaults */ }
  return defaultState();
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function buildFields() {
  for (const [group, fields] of Object.entries(FIELDS)) {
    const host = document.querySelector(`[data-group="${group}"]`);
    host.replaceChildren();
    for (const [key, label, unit, step] of fields) {
      let control;
      if (key === 'material') {
        control = el('select', { id: `${group}.${key}` },
          el('option', { value: 'copper', textContent: 'Copper' }),
          el('option', { value: 'aluminium', textContent: 'Aluminium' }));
      } else {
        control = el('input', { type: 'number', id: `${group}.${key}`, step: String(step) });
      }
      control.dataset.group = group;
      control.dataset.key = key;
      host.append(el('label', {}, label, ' ', el('span', { className: 'unit', textContent: unit }), control));
    }
  }
  const preset = $('#psh-preset');
  for (const p of PSH_PRESETS) preset.append(el('option', { value: String(p.psh), textContent: `${p.name} — ${p.psh} h` }));
}

function syncFormFromState() {
  for (const control of document.querySelectorAll('[data-group][data-key]')) {
    control.value = state[control.dataset.group][control.dataset.key] ?? '';
  }
  $('#dailyKwh').value = state.load.dailyKwh;
  $('#monthlyKwh').value = state.monthlyKwh;
  $('#battery-enabled').checked = state.battery.enabled;
  $('#cable-enabled').checked = state.cable.enabled;
  document.querySelector(`input[name="loadMode"][value="${state.loadMode}"]`).checked = true;
  renderAppliances();
  showLoadMode();
}

function renderAppliances() {
  const body = $('#appliance-rows');
  body.replaceChildren(...state.appliances.map((a, i) => {
    const cell = (field, type) => {
      const input = el('input', { type, value: a[field], step: 'any' });
      input.setAttribute('aria-label', field);
      input.oninput = () => { a[field] = type === 'number' ? Number(input.value) : input.value; update(); };
      return el('td', {}, input);
    };
    const remove = el('button', { type: 'button', className: 'small', textContent: '×', title: 'Remove' });
    remove.onclick = () => { state.appliances.splice(i, 1); renderAppliances(); update(); };
    return el('tr', {}, cell('name', 'text'), cell('watts', 'number'), cell('hoursPerDay', 'number'),
      cell('qty', 'number'), el('td', {}, remove));
  }));
}

function showLoadMode() {
  for (const block of document.querySelectorAll('[data-mode]')) block.hidden = block.dataset.mode !== state.loadMode;
}

function resolveDailyKwh() {
  if (state.loadMode === 'monthly') return state.monthlyKwh / DAYS_PER_MONTH;
  if (state.loadMode === 'appliances') return loadFromAppliances(state.appliances);
  return state.load.dailyKwh;
}

function designInput() {
  const { site, panel, inverter, battery, cable } = state;
  return { load: { dailyKwh: Math.round(resolveDailyKwh() * 100) / 100 }, site, panel, inverter, battery, cable };
}

function tile(label, value, unit = '') {
  return el('div', { className: 'tile' }, el('div', { className: 'k', textContent: label }),
    el('div', { className: 'v' }, String(value), unit ? el('small', { textContent: ` ${unit}` }) : ''));
}

function render(result, input) {
  const errors = $('#errors');
  const verdict = $('#verdict');
  for (const c of document.querySelectorAll('input.invalid')) c.classList.remove('invalid');

  if (!result.ok) {
    verdict.className = 'verdict fail';
    verdict.textContent = 'Fix the inputs below to run the check';
    errors.hidden = false;
    errors.replaceChildren(el('ul', {}, ...result.errors.map((e) => el('li', { textContent: e }))));
    for (const e of result.errors) document.getElementById(e.split(' ')[0])?.classList.add('invalid');
    for (const id of ['#tiles', '#checks', '#strings']) $(id).replaceChildren();
    return;
  }
  errors.hidden = true;

  const { summary } = result;
  const word = { pass: 'Design passes all checks', warn: 'Design works, with warnings', fail: 'Design fails' }[summary.verdict];
  verdict.className = `verdict ${summary.verdict}`;
  verdict.textContent = `${word} — ${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail`;

  const d = result.design ?? result.sizing;
  const tiles = [
    tile('Daily load', input.load.dailyKwh, 'kWh'),
    tile('Required array', result.sizing.requiredKwp, 'kWp'),
    tile('Designed array', d.actualKwp, 'kWp'),
    tile('Modules', d.panelCount, `× ${input.panel.wp} Wp`),
    tile('Est. production', d.estAnnualKwh.toLocaleString(), 'kWh/yr'),
    tile('Specific yield', d.specificYield, 'kWh/kWp'),
  ];
  if (result.dcAcRatio) tiles.push(tile('DC/AC ratio', result.dcAcRatio));
  if (result.battery) {
    tiles.push(tile('Battery (nominal)', result.battery.nominalKwh, 'kWh'));
    tiles.push(tile('Battery capacity', result.battery.ampHours, `Ah @ ${input.battery.systemVoltage} V`));
  }
  $('#tiles').replaceChildren(...tiles);

  $('#checks').replaceChildren(...result.checks.map((c) => el('li', {},
    el('span', { className: `badge ${c.status}`, textContent: c.status }),
    el('span', { textContent: c.label }),
    el('span', { className: 'detail', textContent: c.detail }))));

  const { layout, limits, strings } = result;
  const rows = [
    ['Module Voc at record low', `${limits.vocMax} V`],
    ['Module Vmp at hot cell (' + limits.hotCellC + ' °C)', `${limits.vmpMin} V`],
    ['Allowed modules per string', `${limits.minModules} – ${limits.maxModules}`],
  ];
  if (layout) {
    rows.push(
      ['Chosen layout', `${layout.strings} string(s) × ${layout.modulesPerString} modules`],
      ['Strings per MPPT', `${layout.stringsPerMppt} (of ${input.inverter.mpptCount} MPPT)`],
      ['String Voc max / Vmp STC / Vmp min', `${strings.stringVocMax} / ${strings.stringVmpStc} / ${strings.stringVmpMin} V`],
    );
  }
  if (result.cable) rows.push(['Cable voltage drop', `${result.cable.dropV} V (${result.cable.dropPct}%)`]);
  $('#strings').replaceChildren(el('table', {}, el('tbody', {},
    ...rows.map(([k, v]) => el('tr', {}, el('td', { textContent: k }), el('td', { textContent: v }))))));
}

function update() {
  const input = designInput();
  const result = checkDesign(input);
  render(result, input);
  saveState();
  return { input, result };
}

function bindEvents() {
  $('#form').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.group && t.dataset.key) {
      state[t.dataset.group][t.dataset.key] = t.tagName === 'SELECT' ? t.value : t.valueAsNumber;
      if (t.dataset.key === 'peakSunHours') $('#psh-preset').value = '';
    } else if (t.id === 'dailyKwh') state.load.dailyKwh = t.valueAsNumber;
    else if (t.id === 'monthlyKwh') state.monthlyKwh = t.valueAsNumber;
    else if (t.name === 'loadMode') { state.loadMode = t.value; showLoadMode(); }
    else if (t.id === 'battery-enabled') state.battery.enabled = t.checked;
    else if (t.id === 'cable-enabled') state.cable.enabled = t.checked;
    else if (t.id === 'psh-preset' && t.value) {
      state.site.peakSunHours = Number(t.value);
      $('#site\\.peakSunHours').value = t.value;
    } else return;
    toggleOptional();
    update();
  });
  $('#add-appliance').onclick = () => {
    state.appliances.push({ name: '', watts: 0, hoursPerDay: 0, qty: 1 });
    renderAppliances();
  };
  $('#reset').onclick = () => { state = defaultState(); syncFormFromState(); toggleOptional(); update(); };
  $('#print').onclick = () => window.print();
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(update(), null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'solar-design-check.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

function toggleOptional() {
  $('#battery-enabled').closest('fieldset').classList.toggle('off', !state.battery.enabled);
  $('#cable-enabled').closest('fieldset').classList.toggle('off', !state.cable.enabled);
}

buildFields();
syncFormFromState();
toggleOptional();
bindEvents();
update();
