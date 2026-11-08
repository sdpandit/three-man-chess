// Posts a chat message under any name: npm run say -- <room> <name> <message> [w|g|b]
// The colour is optional. Talks to the server on PORT (default 3000), using the admin
// token the server keeps next to its saved games.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'games.json');
const PORT = Number(process.env.PORT) || 3000;

const [room, name, text, color] = process.argv.slice(2);
if (!room || !name || !text) {
  console.error('Usage: npm run say -- <room> <name> <message> [w|g|b]');
  process.exit(1);
}

const token = readFileSync(path.join(path.dirname(DATA_FILE), 'admin-token'), 'utf8').trim();
const res = await fetch(`http://localhost:${PORT}/admin/chat`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ room, name, text, color }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`Failed: ${body.error}`);
  process.exit(1);
}
console.log(`Sent as ${body.sent.name} to ${body.watching} connected browser(s)`);
