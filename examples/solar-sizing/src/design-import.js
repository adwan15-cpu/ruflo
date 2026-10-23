/**
 * Contractor design import: turns JSON, CSV/TSV/TXT key-value sheets, or text
 * extracted from a PDF into design-input values the checker understands.
 *
 * Pure functions, no DOM access. PDF text extraction happens in the UI (pdf.js);
 * this module only sees the resulting text.
 */

import { DEFAULT_INPUT } from './solar-calc.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * [path, label, unit kind, alias patterns]. Order matters for free text: more
 * specific labels (inverter short-circuit current) come before generic ones
 * (module Isc), and matched spans are masked so a value is used once.
 */
export const FIELD_SPECS = [
  ['inverter.maxStringsPerMppt', 'Strings per MPPT', 'int', ['(?:max(?:imum)? )?(?:strings|inputs) per mppt']],
  ['contractor.modulesPerString', 'Modules per string', 'int',
    ['(?:modules?|panels?) per string', '(?:modules?|panels?) in series', 'series modules', 'string length']],
  ['contractor.strings', 'Number of strings', 'int',
    ['(?:number|no\\.?|qty) of strings', 'parallel strings', 'strings in parallel', 'total strings', 'strings']],
  ['contractor.inverterCount', 'Number of inverters', 'int',
    ['(?:number|no\\.?|qty) of inverters', 'inverter (?:qty|quantity|count)', 'inverters']],
  ['contractor.totalModules', 'Total modules', 'int',
    ['(?:number|no\\.?|qty|total) of (?:pv )?(?:modules|panels)', 'total (?:pv )?(?:modules|panels)', '(?:module|panel) (?:qty|quantity|count)']],
  ['contractor.claimedAnnualKwh', 'Stated annual production', 'kwh',
    ['(?:annual|yearly|first[- ]year) (?:energy|production|yield|generation)(?: \\(?\\w*\\)?)?', 'energy (?:production|yield|generation) per year', 'produced energy']],
  ['contractor.claimedKwp', 'Stated array size', 'kwp',
    ['(?:system|array|dc|pv|installed|plant) (?:size|capacity|power|peak power)', 'installed capacity', 'nominal dc power']],
  ['inverter.maxShortCircuitA', 'Inverter max short-circuit current / MPPT', 'a',
    ['max(?:imum)?\\.? (?:dc )?(?:input )?short[- ]circuit current(?: per mppt)?', 'max(?:imum)?\\.? isc']],
  ['inverter.maxInputCurrentA', 'Inverter max input current / MPPT', 'a',
    ['max(?:imum)?\\.? (?:dc )?input current(?: per mppt)?', 'max(?:imum)?\\.? (?:operating|mppt) current']],
  ['inverter.mpptCount', 'MPPT inputs', 'int',
    ['(?:number|no\\.?) of mppts?(?: trackers| inputs)?', 'mppt (?:inputs|trackers|count)', 'mppts']],
  ['inverter.mpptMinV', 'MPPT min voltage', 'v', ['mppt? (?:voltage )?min(?:imum)?(?: voltage)?', 'min(?:imum)? mppt voltage']],
  ['inverter.mpptMaxV', 'MPPT max voltage', 'v', ['mppt? (?:voltage )?max(?:imum)?(?: voltage)?', 'max(?:imum)? mppt voltage']],
  ['inverter.maxDcVoltage', 'Inverter max DC voltage', 'v',
    ['max(?:imum)?\\.? (?:dc )?input voltage', 'max(?:imum)?\\.? dc voltage', 'inverter max(?:imum)? voltage']],
  ['inverter.acKw', 'Inverter rated AC power', 'kw',
    ['(?:rated|nominal|max(?:imum)?) ac (?:output )?power', 'ac (?:output )?power', 'inverter (?:size|power|rating)']],
  ['panel.tempCoeffVocPct', 'Temp. coeff. Voc', 'pct',
    ['temp(?:erature)?\\.? coeff(?:icient)?\\.?(?: of)? \\(?voc\\)?', 'voc temp(?:erature)?\\.? coeff(?:icient)?', 'β ?voc']],
  ['panel.tempCoeffPmaxPct', 'Temp. coeff. Pmax', 'pct',
    ['temp(?:erature)?\\.? coeff(?:icient)?\\.?(?: of)? \\(?p ?max\\)?', 'p ?max temp(?:erature)?\\.? coeff(?:icient)?', 'γ ?p ?max']],
  ['panel.voc', 'Module Voc', 'v', ['open[- ]circuit voltage', 'voc']],
  ['panel.vmp', 'Module Vmp', 'v', ['(?:max(?:imum)? power|mpp) voltage', 'v ?mpp?']],
  ['panel.isc', 'Module Isc', 'a', ['short[- ]circuit current', 'isc']],
  ['panel.imp', 'Module Imp', 'a', ['(?:max(?:imum)? power|mpp) current', 'i ?mpp?']],
  ['panel.noctC', 'NOCT', 'c', ['noct', 'nmot']],
  ['panel.wp', 'Module rated power', 'wp',
    ['(?:module|panel) (?:power|wattage|rating)', '(?:rated|nominal|maximum) power(?: \\(?pmax\\)?)?', 'pmax']],
  ['site.peakSunHours', 'Peak sun hours', 'h', ['peak sun hours', 'psh', 'sun hours']],
  ['site.systemLossPct', 'System losses', 'pct', ['(?:total )?system losses', 'losses']],
  ['site.minAmbientC', 'Record low temp', 'c', ['record low', 'min(?:imum)? (?:ambient |design )?temp(?:erature)?']],
  ['site.maxAmbientC', 'Max ambient temp', 'c', ['max(?:imum)? (?:ambient |design )?temp(?:erature)?', 'design high']],
  ['load.dailyKwh', 'Daily load', 'kwh', ['daily (?:consumption|load|energy use)']],
  ['cable.lengthM', 'DC cable one-way length', 'm', ['(?:dc |string )?cable length', 'cable run']],
  ['cable.crossSectionMm2', 'DC cable cross-section', 'mm2', ['(?:dc |string )?cable (?:size|cross[- ]section)', 'conductor size']],
  ['battery.autonomyDays', 'Battery days of autonomy', 'num', ['(?:days of )?autonomy']],
  ['battery.dodPct', 'Battery depth of discharge', 'pct', ['depth of discharge', 'dod']],
  ['battery.systemVoltage', 'Battery bank voltage', 'v', ['battery (?:bank |system |nominal )?voltage']],
  ['battery.roundTripEffPct', 'Battery round-trip efficiency', 'pct', ['round[- ]trip efficiency']],
];

const SPEC_BY_PATH = new Map(FIELD_SPECS.map((s) => [s[0], s]));

/** Fields without which a contractor check is mostly guesswork. */
export const KEY_FIELDS = [
  'panel.wp', 'panel.voc', 'panel.vmp', 'panel.isc', 'panel.imp', 'panel.tempCoeffVocPct',
  'inverter.acKw', 'inverter.maxDcVoltage', 'inverter.mpptMinV', 'inverter.mpptMaxV', 'inverter.mpptCount',
  'inverter.maxInputCurrentA', 'contractor.modulesPerString', 'contractor.strings', 'site.minAmbientC',
];

const NUMBER = '([+\\-\u2212]?\\d[\\d,]*(?:\\.\\d+)?)';
const UNIT = '[ \\t]*((?:[kM]?Wh|[kM]?Wp?|mV|V|mA|A|mm²|mm2|m|h|%|°C|°F|K)(?:\\/(?:°C|K|yr|year|a|day))?(?![a-z]))?';
/** Counts usually written number-first: "2 strings", "11 modules per string". */
const NUMBER_FIRST = new Set(['contractor.modulesPerString', 'contractor.strings', 'contractor.inverterCount', 'contractor.totalModules']);

/** "12,345.6" → 12345.6, "49,5" → 49.5, "−0.27" → -0.27. */
export function parseNumber(raw) {
  let s = String(raw).trim().replace(/\u2212/g, '-').replace(/\s+/g, '');
  if (/,\d{3}(?!\d)/.test(s) && !/,\d{1,2}$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Apply unit conversion for a field kind. Returns { value, note }. */
export function normalizeValue(kind, value, unit = '') {
  const u = unit.toLowerCase();
  if (kind === 'kw' && (u === 'w' || u === 'wac' || (!u && value > 200))) return { value: value / 1000, note: 'W → kW' };
  if (kind === 'kw' && u === 'mw') return { value: value * 1000, note: 'MW → kW' };
  if (kind === 'kwp' && (u === 'wp' || u === 'w')) return { value: value / 1000, note: 'Wp → kWp' };
  if (kind === 'kwp' && u === 'mwp') return { value: value * 1000, note: 'MWp → kWp' };
  if (kind === 'wp' && (u === 'kw' || u === 'kwp')) return { value: value * 1000, note: 'kWp → Wp' };
  if (kind === 'kwh' && u.startsWith('mwh')) return { value: value * 1000, note: 'MWh → kWh' };
  if (kind === 'kwh' && u.startsWith('wh')) return { value: value / 1000, note: 'Wh → kWh' };
  if (kind === 'int') return { value: Math.round(value) };
  if (kind === 'pct' && u.includes('mv')) return { value: Number.NaN, note: 'mV/°C coefficient not supported' };
  return { value };
}

const compile = (aliases) => aliases.map((a) => new RegExp(`(?:^|[^a-z])(?:${a})(?![a-z])`, 'i'));
const KEY_MATCHERS = FIELD_SPECS.map(([path, , , aliases]) => [path, compile(aliases)]);

/** Map a sheet/JSON key to a field path ("panel.voc" exactly, or by alias). */
export function matchKey(key) {
  const k = String(key).trim();
  if (SPEC_BY_PATH.has(k)) return k;
  const clean = k.toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/^(?:pv |the )/, '');
  for (const [path, regexes] of KEY_MATCHERS) if (regexes.some((r) => r.test(clean))) return path;
  return null;
}

function emptyResult(source) {
  return { source, values: {}, found: [], unmatched: [], notes: [] };
}

function record(result, path, rawValue, unit, raw) {
  if (path in result.values) return;
  const spec = SPEC_BY_PATH.get(path);
  let value = typeof rawValue === 'number' ? rawValue : parseNumber(rawValue);
  if (!Number.isFinite(value)) return;
  const norm = normalizeValue(spec[2], value, unit);
  value = norm.value;
  if (!Number.isFinite(value)) { result.notes.push(`${spec[1]}: ${norm.note}`); return; }
  if (spec[2] === 'pct' && path.startsWith('panel.tempCoeff') && value > 0) {
    value = -value;
    result.notes.push(`${spec[1]} given as positive; treated as −${Math.abs(value)} %/°C`);
  }
  result.values[path] = value;
  result.found.push({ path, label: spec[1], value, raw: String(raw).trim().slice(0, 120), note: norm.note });
}

/** Pull "MPPT voltage range 90–550 V" style ranges. */
function extractRanges(text, result) {
  const grid = /(\d{1,3})[ \t]*(?:strings?[ \t]*)?[x×][ \t]*(\d{1,3})[ \t]*(?:modules|panels)/i.exec(text);
  if (grid) {
    record(result, 'contractor.strings', grid[1], '', grid[0]);
    record(result, 'contractor.modulesPerString', grid[2], '', grid[0]);
  }
  const m = /mppt?[^\n\d]{0,40}?(\d{2,4})\s*(?:v\s*)?(?:-|–|—|to|~|\.\.\.)\s*(\d{2,4})\s*v/i.exec(text);
  if (m) {
    record(result, 'inverter.mpptMinV', m[1], 'V', m[0]);
    record(result, 'inverter.mpptMaxV', m[2], 'V', m[0]);
  }
}

/** Heuristic extraction from free text (PDF reports, datasheets, e-mails). */
export function extractFromText(text, source = 'text') {
  const result = emptyResult(source);
  let work = String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  extractRanges(work, result);
  for (const [path, , , aliases] of FIELD_SPECS) {
    if (path in result.values) continue;
    for (const alias of aliases) {
      if (NUMBER_FIRST.has(path)) {
        const pre = new RegExp(`(?:^|[^\\d.,])(\\d{1,4})[ \\t]*(?:no\\.?[ \\t]*|pcs\\.?[ \\t]*)?(${alias})(?![a-z])`, 'im').exec(work);
        if (pre) {
          record(result, path, pre[1], '', pre[0]);
          work = work.slice(0, pre.index) + ' '.repeat(pre[0].length) + work.slice(pre.index + pre[0].length);
          break;
        }
      }
      const re = new RegExp(`(?:^|[^a-z])(${alias})(?![a-z])\\s*(?:\\([^)\\n]{0,15}\\))?[^\\d\\n+\\-\u2212]{0,25}?${NUMBER}${UNIT}`, 'im');
      const m = re.exec(work);
      if (!m) continue;
      record(result, path, m[2], m[3] ?? '', m[0]);
      // Mask the consumed span so a generic alias cannot reuse the same number.
      work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
      break;
    }
  }
  return finish(result);
}

/** CSV/TSV/semicolon sheets and "key: value" text, vertical or single-row horizontal. */
export function parseKeyValue(text, source = 'sheet') {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const delim = ['\t', ';', ','].find((d) => lines[0]?.includes(d)) ?? null;
  const split = (line) => {
    if (!delim) {
      const m = /^([^:=]+)[:=](.*)$/.exec(line);
      return m ? [m[1], m[2]] : [line];
    }
    return line.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  };
  const rows = lines.map(split);
  const result = emptyResult(source);

  // Horizontal layout: header row of keys, then one row of values.
  if (rows.length >= 2 && rows[0].length >= 3 && rows[0].filter(matchKey).length >= 3) {
    rows[0].forEach((key, i) => takeCell(result, key, rows[1][i] ?? '', ''));
    return finish(result);
  }
  for (const row of rows) {
    if (row.length < 2) continue;
    const [key, ...rest] = row;
    const valueIdx = rest.findIndex((c) => /\d/.test(c));
    if (valueIdx < 0) continue;
    takeCell(result, key, rest[valueIdx], rest[valueIdx + 1] ?? '');
  }
  return finish(result);
}

function takeCell(result, key, cell, unitCell) {
  if (/range/i.test(key)) extractRanges(`${key} ${cell} ${unitCell || 'V'}`, result);
  const path = matchKey(key);
  if (!path) { if (/\d/.test(cell)) result.unmatched.push(`${key}: ${cell}`); return; }
  const m = new RegExp(`${NUMBER}${UNIT}`).exec(String(cell));
  if (!m) return;
  record(result, path, m[1], m[2] || String(unitCell).trim(), `${key}: ${cell} ${unitCell}`);
}

/** Our own export ({ input, result }), the input shape itself, or any flat/nested object. */
export function parseJson(text, source = 'json') {
  const data = JSON.parse(text);
  const root = data && typeof data === 'object' && data.input && typeof data.input === 'object' ? data.input : data;
  const result = emptyResult(source);
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else if (typeof v === 'number' || typeof v === 'string') {
        const path = matchKey(key) ?? matchKey(k);
        if (path) record(result, path, typeof v === 'number' ? v : String(v), typeof v === 'string' ? (/[a-z%°]+$/i.exec(v)?.[0] ?? '') : '', `${key}: ${v}`);
        else if (typeof v === 'number') result.unmatched.push(`${key}: ${v}`);
      }
    }
  };
  walk(root, '');
  if (typeof root?.cable?.material === 'string') result.material = root.cable.material;
  return finish(result);
}

function finish(result) {
  const v = result.values;
  if (!('contractor.strings' in v) && v['contractor.totalModules'] > 0 && v['contractor.modulesPerString'] > 0) {
    const strings = v['contractor.totalModules'] / v['contractor.modulesPerString'];
    if (Number.isInteger(strings)) record(result, 'contractor.strings', strings, '', 'total modules ÷ modules per string');
    else result.notes.push(`${v['contractor.totalModules']} modules do not divide into strings of ${v['contractor.modulesPerString']}`);
  }
  result.missing = KEY_FIELDS.filter((p) => !(p in v)).map((p) => SPEC_BY_PATH.get(p)[1]);
  result.hasLayout = 'contractor.modulesPerString' in v && 'contractor.strings' in v;
  return result;
}

/** Route by file name / content. `text` is file text, or extracted PDF text for PDFs. */
export function parseDesignFile(name, text) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'json') return parseJson(text, name);
  if (ext === 'pdf') return extractFromText(text, name);
  const sheet = parseKeyValue(text, name);
  if (sheet.found.length >= 3) return sheet;
  const loose = extractFromText(text, name);
  return loose.found.length > sheet.found.length ? loose : sheet;
}

/** Overlay imported values on a design input (returns a new object). */
export function applyImport(input, imported) {
  const next = structuredClone(input);
  for (const [path, value] of Object.entries(imported.values)) {
    const [group, key] = path.split('.');
    if (key === 'totalModules' || !next[group]) continue;
    next[group][key] = value;
  }
  if (imported.material === 'copper' || imported.material === 'aluminium') next.cable.material = imported.material;
  if (imported.hasLayout) next.contractor.enabled = true;
  if (Object.keys(imported.values).some((p) => p.startsWith('cable.'))) next.cable.enabled = true;
  if (!('contractor.inverterCount' in imported.values) && imported.hasLayout) next.contractor.inverterCount = 1;
  return next;
}

/** A fill-in CSV template for contractors, pre-filled with the given (or default) input. */
export function csvTemplate(input = DEFAULT_INPUT) {
  const rows = [['key', 'value', 'unit', 'description']];
  const units = { int: '', kwh: 'kWh', kwp: 'kWp', a: 'A', v: 'V', kw: 'kW', pct: '%', c: '°C', wp: 'Wp', h: 'h', m: 'm', mm2: 'mm²' };
  for (const [path, label, kind] of FIELD_SPECS) {
    if (path === 'contractor.totalModules') continue;
    const [g, k] = path.split('.');
    const v = input[g]?.[k];
    rows.push([path, Number.isFinite(v) ? String(v) : '', path.endsWith('Pct') && path.includes('tempCoeff') ? '%/°C' : units[kind], label]);
  }
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
}
