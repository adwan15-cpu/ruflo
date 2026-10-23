import { MAX_FILE_BYTES, parseDesignFile } from './design-import.js';

/** pdf.js is loaded on demand, only when a PDF is uploaded. */
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
const MAX_PDF_PAGES = 60;
const ACCEPTED = ['json', 'csv', 'tsv', 'txt', 'pdf'];

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

async function pdfToText(buffer) {
  let pdfjs;
  try {
    pdfjs = await import(`${PDFJS_BASE}pdf.min.mjs`);
  } catch {
    throw new Error('Could not load the PDF reader (needs internet access). Export the design as CSV or text instead.');
  }
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
  const doc = await pdfjs.getDocument({ data: buffer, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  await doc.destroy();
  return pages.join('\n');
}

/** Read and parse an uploaded contractor design. Throws with a user-facing message. */
export async function importDesignFile(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (!ACCEPTED.includes(ext)) throw new Error(`Unsupported file type ".${ext}". Use PDF, CSV, TSV, TXT or JSON (save spreadsheets as CSV).`);
  if (file.size > MAX_FILE_BYTES) throw new Error('File is larger than 10 MB.');
  const text = ext === 'pdf' ? await pdfToText(await file.arrayBuffer()) : await file.text();
  if (!text.trim()) throw new Error('No text found in the file. Scanned PDFs (images) cannot be read — ask for a text PDF or CSV.');
  let imported;
  try {
    imported = parseDesignFile(file.name, text);
  } catch (err) {
    throw new Error(`Could not read ${file.name}: ${err.message}`);
  }
  if (!imported.found.length) throw new Error(`No design values recognised in ${file.name}. Try the CSV template.`);
  return imported;
}

/** Detailed per-field import report shown under the drop zone. */
export function renderImportReport(host, imported, onUndo) {
  const rows = imported.found.map((f) => el('tr', {},
    el('td', { textContent: f.label }),
    el('td', { className: 'num', textContent: String(f.value) + (f.note ? ` (${f.note})` : '') }),
    el('td', { className: 'raw', textContent: f.raw, title: f.raw })));
  const undo = el('button', { type: 'button', className: 'small', textContent: 'Undo import' });
  undo.onclick = onUndo;
  const parts = [
    el('div', { className: 'import-head' },
      el('strong', { textContent: imported.source }),
      el('span', { textContent: ` — ${imported.found.length} values recognised` }), ' ', undo),
  ];
  if (!imported.hasLayout) {
    parts.push(el('p', { className: 'warn-text', textContent:
      'No string layout (modules per string and number of strings) found — the app chose its own layout. ' +
      'Enter the contractor layout below to check theirs.' }));
  }
  if (imported.missing.length) {
    parts.push(el('p', { className: 'warn-text', textContent:
      `Not found in the file, so the current form values are used: ${imported.missing.join(', ')}. Check these before relying on the result.` }));
  }
  for (const note of imported.notes) parts.push(el('p', { className: 'muted', textContent: note }));
  parts.push(el('details', {}, el('summary', { textContent: 'Values read from the file' }),
    el('table', { className: 'import-table' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Field' }), el('th', { textContent: 'Value' }),
        el('th', { textContent: 'Found in' }))),
      el('tbody', {}, ...rows))));
  if (imported.unmatched.length) {
    parts.push(el('details', {}, el('summary', { textContent: `${imported.unmatched.length} entries not recognised` }),
      el('ul', { className: 'muted' }, ...imported.unmatched.slice(0, 50).map((u) => el('li', { textContent: u })))));
  }
  host.hidden = false;
  host.replaceChildren(...parts);
}

/** Wire the drop zone + file input; `onFile(file)` is called with the chosen file. */
export function bindDropZone(zone, input, onFile) {
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('drag'); });
  }
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

export function downloadText(filename, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
