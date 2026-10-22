// Devlog „Co je nového“: stránka /devlog vykresluje DEVLOG.md z kořene projektu. Odkaz v patičce jen při DEVLOG=1
// (testovací instalace). Při každém nasazení na dev doplnit záznam nahoru.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const SOUBOR = path.resolve(import.meta.dirname, '..', '..', 'DEVLOG.md');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** řádkový text: **tučně**, `kód`, [text](odkaz) — jen relativní nebo https odkazy */
function radek(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(((?:https:\/\/|\/)[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
/** malý převod Markdownu: nadpisy ##/###, odrážky, odstavce; první nadpis # vynechá (je v šabloně) */
export function devlogNaHtml(md: string): string {
  const ven: string[] = [];
  let seznam = false;
  let odst: string[] = [];
  const zavriOdst = () => {
    if (odst.length) ven.push(`<p>${odst.map(radek).join(' ')}</p>`);
    odst = [];
  };
  const zavriSeznam = () => {
    if (seznam) ven.push('</ul>');
    seznam = false;
  };
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (/^# /.test(l)) continue;
    const h = /^(#{2,3}) (.+)$/.exec(l);
    if (h) {
      zavriOdst();
      zavriSeznam();
      ven.push(`<h${h[1]!.length}>${radek(h[2]!)}</h${h[1]!.length}>`);
    } else if (/^- /.test(l)) {
      zavriOdst();
      if (!seznam) ven.push('<ul>');
      seznam = true;
      ven.push(`<li>${radek(l.slice(2))}</li>`);
    } else if (l === '') {
      zavriOdst();
      zavriSeznam();
    } else {
      zavriSeznam();
      odst.push(l);
    }
  }
  zavriOdst();
  zavriSeznam();
  return ven.join('\n');
}

async function devlog(app: FastifyInstance) {
  let kes: string | null = null;
  app.get('/devlog', async (_req, reply) => {
    if (!kes || app.env.NODE_ENV !== 'production') {
      kes = devlogNaHtml(await fs.readFile(SOUBOR, 'utf8').catch(() => '## Devlog zatím chybí\n'));
    }
    return reply.view('devlog', { titulek: 'Co je nového', html: kes });
  });
}
export default fp(devlog, { name: 'devlog' });
