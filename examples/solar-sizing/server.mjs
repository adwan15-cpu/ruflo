// Zero-dependency static server: `node server.mjs [port]` then open http://localhost:5173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) || !TYPES[extname(file)]) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': `${TYPES[extname(file)]}; charset=utf-8` }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Solar Sizing Check → http://localhost:${PORT}`));
