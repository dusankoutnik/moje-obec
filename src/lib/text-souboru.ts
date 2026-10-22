// Text nahraných dokumentů pro vyhledávání (docs/HLEDANI-DOKUMENTY.md): textová vrstva PDF (pdftotext), skeny přes
// OCR (pdftoppm + tesseract), obrázek nahraný jako dokument (tesseract), kancelářské formáty ZIP/XML (docx, xlsx,
// pptx, odt, ods, odp — čteno přímo v Node přes fflate), starý Word .doc (antiword) a RTF (vlastní jednoduchý
// převod). Vše běží lokálně na serveru obce, žádná cloudová služba.
//
// Čistá logika (rozhodnutí „má vrstvu“, parsování XML, sestavení příkazů) je oddělená od spouštění procesů, aby
// šla testovat bez binárek. Chybějící binárka = výsledek `nepodporovano` s důvodem, ne pád.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsKonstanty, promises as fs } from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { ZdrojTextu } from '../db/types.js';

/** průměr znaků (bez mezer) na stranu, od kterého PDF považujeme za PDF s textovou vrstvou */
export const PRAH_ZNAKU_NA_STRANU = 40;
/** výsledek OCR pod tolik znaků = prázdný sken (stav bez_textu) */
export const MIN_ZNAKU_TEXTU = 20;
/** nejdelší běh pdftotext / antiword na jeden soubor */
export const LIMIT_PDFTOTEXT_MS = 60_000;
/** nejdelší OCR jednoho souboru (všechny strany dohromady) */
export const LIMIT_OCR_MS = 20 * 60_000;
/** nejdelší OCR jedné strany */
export const LIMIT_OCR_STRANA_MS = 180_000;
/** rychlá kontrola při nahrání (první 3 strany) */
export const LIMIT_RYCHLA_KONTROLA_MS = 5_000;
const LIMIT_PDFINFO_MS = 30_000;
/** nejvíc výstupu, které od příkazu přijmeme (pdftotext s -layout vrací víc než čistý text) */
const MAX_VYSTUP_B = 24 * 1024 * 1024;
/** položka ZIPu kancelářského formátu, která se ještě rozbalí do paměti */
const MAX_POLOZKA_ZIP_B = 80 * 1024 * 1024;

export interface TextKonfigurace {
  ocrJazyky: string;
  ocrMaxStran: number;
  ocrDpi: number;
  maxZnaku: number;
  /** adresář pro dočasné soubory (stránky skenu) */
  tmpDir: string;
  /** kde hledat binárky (výchozí process.env.PATH); testy podstrčí prázdné = nic není k dispozici */
  path?: string;
  /** pouštět příkazy přes `nice -n 15` (výchozí ano) */
  nice?: boolean;
}

export type VysledekTextu =
  | {
      stav: 'hotovo' | 'bez_textu';
      zdroj: ZdrojTextu;
      text: string;
      stran: number | null;
      maVrstvu: boolean | null;
      poznamka: string | null;
    }
  | { stav: 'nepodporovano'; duvod: string }
  | { stav: 'chyba'; duvod: string };

export const MIME_PDF = 'application/pdf';
/** MIME typy dokumentů, které umíme (nebo aspoň zkusíme) převést na text; obrázky zvlášť (jen jako dokument) */
export const MIME_OFFICE: Record<
  string,
  'docx' | 'xlsx' | 'pptx' | 'odt' | 'antiword' | 'rtf' | 'nepodporovano'
> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odt',
  'application/msword': 'antiword',
  'application/rtf': 'rtf',
  'application/vnd.ms-excel': 'nepodporovano',
  'application/vnd.ms-powerpoint': 'nepodporovano',
};

/** soubor, jehož text má smysl indexovat: PDF, kancelářský dokument, nebo obrázek nahraný jako dokument */
export function jeIndexovatelny(mime: string, jakoDokument: boolean): boolean {
  if (mime === MIME_PDF || mime in MIME_OFFICE) return true;
  return jakoDokument && /^image\/(jpeg|png)$/.test(mime);
}

// ---------- čistá logika ----------

/** počet znaků bez bílých znaků */
export function pocetZnaku(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** PDF má textovou vrstvu, když vychází aspoň PRAH_ZNAKU_NA_STRANU znaků na stranu */
export function maVrstvu(text: string, stran: number | null): boolean {
  return pocetZnaku(text) / Math.max(1, stran ?? 1) >= PRAH_ZNAKU_NA_STRANU;
}

/**
 * Vrstva plná nesmyslů (rozbité kódování starých skenů): mezi znaky bez mezer je méně než polovina písmen
 * a číslic (číslice kvůli tabulkám rozpočtu), nebo nápadně mnoho náhradních/soukromých znaků.
 */
export function jeNesmysl(text: string): boolean {
  const bezMezer = text.replace(/\s+/g, '');
  if (!bezMezer.length) return false;
  const alfanum = (bezMezer.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const divne = (bezMezer.match(/[�-\u0080-\u009F]/g) ?? []).length;
  return alfanum / bezMezer.length < 0.5 || divne / bezMezer.length > 0.05;
}

/** sjednocení textu: NFC, bez řídicích znaků (kromě tabulátoru a nového řádku), bez přebytečných mezer; ořez */
export function cistiText(text: string, maxZnaku: number): { text: string; zkraceno: boolean } {
  let t = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n\n')
    // eslint-disable-next-line no-control-regex -- řídicí znaky z OCR a pdftotext nepatří do indexu
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const zkraceno = t.length > maxZnaku;
  if (zkraceno) t = t.slice(0, maxZnaku);
  return { text: t, zkraceno };
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function dekodujEntity(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (cele, e: string) => {
    if (e[0] === '#') {
      const kod = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(kod) && kod > 0 && kod <= 0x10ffff ? String.fromCodePoint(kod) : '';
    }
    return ENTITY[e.toLowerCase()] ?? cele;
  });
}

/**
 * XML kancelářského formátu → prostý text: konce odstavců a řádků tabulek = nový řádek, buňky = tabulátor,
 * ostatní značky se zahodí (text rozdělený do více běhů `<w:t>` se tím správně spojí).
 */
export function xmlNaText(xml: string): string {
  return dekodujEntity(
    xml
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<(?:w:tab|text:tab)\b[^>]*\/>/g, '\t')
      .replace(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/>/g, (_m, n: string) =>
        ' '.repeat(Math.min(50, Number(n))),
      )
      .replace(/<text:s\b[^>]*\/>/g, ' ')
      .replace(/<(?:w:br|text:line-break|a:br|br)\b[^>]*\/>/g, '\n')
      .replace(/<\/(?:w:tc|table:table-cell|a:tc)>/g, '\t')
      .replace(/<\/(?:w:p|text:p|text:h|a:p|table:table-row|w:tr|text:list-item)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

type Zip = Record<string, Uint8Array>;

function rozbal(data: Uint8Array, chci: (nazev: string) => boolean): { zip: Zip; preskoceno: number } {
  let preskoceno = 0;
  const zip = unzipSync(data, {
    filter: (f) => {
      if (!chci(f.name)) return false;
      if (f.originalSize > MAX_POLOZKA_ZIP_B) {
        preskoceno++;
        return false;
      }
      return true;
    },
  });
  return { zip, preskoceno };
}

const text = (zip: Zip, nazev: string) => (zip[nazev] ? strFromU8(zip[nazev]) : '');
const seradPodleCisla = (a: string, b: string) =>
  Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

export function textZDocx(zip: Zip): string {
  const casti = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];
  const hlavicky = Object.keys(zip)
    .filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
    .sort();
  return [...casti, ...hlavicky]
    .map((n) => xmlNaText(text(zip, n)))
    .filter(Boolean)
    .join('\n\n');
}

export function textZXlsx(zip: Zip): string {
  const sdilene: string[] = [];
  for (const m of text(zip, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g))
    sdilene.push(xmlNaText(m[1]!).replace(/\s+/g, ' ').trim());
  const listy = Object.keys(zip)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort(seradPodleCisla);
  const vystup: string[] = [];
  for (const l of listy) {
    for (const radek of text(zip, l).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const bunky: string[] = [];
      for (const c of radek[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const atributy = c[1] ?? '';
        const telo = c[2] ?? '';
        const typ = /\bt="([^"]+)"/.exec(atributy)?.[1];
        let hodnota = '';
        if (typ === 's') hodnota = sdilene[Number(/<v>([^<]*)<\/v>/.exec(telo)?.[1] ?? -1)] ?? '';
        else if (typ === 'inlineStr') hodnota = xmlNaText(/<is>([\s\S]*?)<\/is>/.exec(telo)?.[1] ?? '');
        else hodnota = dekodujEntity(/<v>([^<]*)<\/v>/.exec(telo)?.[1] ?? '');
        if (hodnota) bunky.push(hodnota.trim());
      }
      if (bunky.length) vystup.push(bunky.join('\t'));
    }
    vystup.push('');
  }
  return vystup.join('\n');
}

export function textZPptx(zip: Zip): string {
  return Object.keys(zip)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(seradPodleCisla)
    .map((n) => xmlNaText(text(zip, n)))
    .join('\n\n');
}

export function textZOdf(zip: Zip): string {
  // meta a styly obsahují i názvy stylů — bereme jen content.xml
  return xmlNaText(text(zip, 'content.xml'));
}

/** docx / xlsx / pptx / odt / ods / odp (ZIP s XML) → text; vrací i počet přeskočených (příliš velkých) částí */
export function textZOffice(data: Uint8Array, zdroj: 'docx' | 'xlsx' | 'pptx' | 'odt') {
  const chci: Record<typeof zdroj, (n: string) => boolean> = {
    docx: (n) => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(n),
    xlsx: (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
    pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n),
    odt: (n) => n === 'content.xml',
  };
  const { zip, preskoceno } = rozbal(data, chci[zdroj]);
  const prevod = { docx: textZDocx, xlsx: textZXlsx, pptx: textZPptx, odt: textZOdf }[zdroj];
  return { text: prevod(zip), preskoceno };
}

/**
 * RTF → text (bez knihovny): skupiny s metadaty (fonty, barvy, obrázky, `\*`) se vynechají, `\'hh` je byte
 * v kódování dokumentu (čeština = windows-1250), `\uN` je znak Unicode, `\par`/`\line`/`\cell`/`\row` oddělují text.
 */
export function textZRtf(data: Uint8Array): string {
  const s = Buffer.from(data).toString('latin1');
  const dekoder = new TextDecoder('windows-1250');
  const out: string[] = [];
  let bajty: number[] = [];
  const vypust = () => {
    if (bajty.length) {
      out.push(dekoder.decode(Uint8Array.from(bajty)));
      bajty = [];
    }
  };
  const PRESKOCIT =
    /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|xmlnstbl|themedata|latentstyles|datastore|listtable|listoverridetable|rsidtbl|generator|mmathPr)$/;
  let hloubka = 0;
  let preskocDo = -1;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '{') {
      hloubka++;
      // {\*\…} a známé skupiny s metadaty přeskočit celé
      const m = /^\{\\(\*\\)?([a-zA-Z]+)/.exec(s.slice(i, i + 40));
      if (preskocDo < 0 && m && (m[1] || PRESKOCIT.test(m[2]!))) preskocDo = hloubka;
      i++;
      continue;
    }
    if (c === '}') {
      if (preskocDo === hloubka) preskocDo = -1;
      hloubka--;
      i++;
      continue;
    }
    if (c === '\\') {
      const hex = /^\\'([0-9a-fA-F]{2})/.exec(s.slice(i, i + 4));
      if (hex) {
        if (preskocDo < 0) bajty.push(parseInt(hex[1]!, 16));
        i += 4;
        continue;
      }
      const slovo = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i, i + 40));
      if (slovo) {
        i += slovo[0].length;
        if (preskocDo >= 0) continue;
        const nazev = slovo[1]!;
        if (nazev === 'u') {
          vypust();
          let kod = Number(slovo[2] ?? 0);
          if (kod < 0) kod += 65536;
          out.push(String.fromCodePoint(kod));
          // za \uN následuje náhradní znak pro staré čtečky (obvykle ?) — přeskočit
          if (s[i] === '\\' && s.slice(i, i + 2) === "\\'") i += 4;
          else if (s[i] && s[i] !== '\\' && s[i] !== '{' && s[i] !== '}') i++;
        } else if (nazev === 'par' || nazev === 'line' || nazev === 'row') {
          vypust();
          out.push('\n');
        } else if (nazev === 'tab' || nazev === 'cell') {
          vypust();
          out.push('\t');
        }
        continue;
      }
      // escapované {, }, \ a \~ (pevná mezera), \- (volitelné dělení)
      const dalsi = s[i + 1];
      if (preskocDo < 0 && dalsi) {
        if (dalsi === '~') bajty.push(0x20);
        else if (dalsi !== '-' && dalsi !== '*') bajty.push(dalsi.charCodeAt(0));
      }
      i += 2;
      continue;
    }
    if (preskocDo < 0 && c !== '\n' && c !== '\r') bajty.push(c.charCodeAt(0));
    i++;
  }
  vypust();
  return out.join('');
}

// ---------- příkazy (čisté sestavení argumentů) ----------

export const prikazy = {
  pdfinfo: (cesta: string) => ({ prikaz: 'pdfinfo', args: [cesta] }),
  pdftotext: (cesta: string, strany?: { od: number; do: number }) => ({
    prikaz: 'pdftotext',
    args: [
      ...(strany ? ['-f', String(strany.od), '-l', String(strany.do)] : []),
      '-layout',
      '-enc',
      'UTF-8',
      cesta,
      '-',
    ],
  }),
  pdftoppm: (cesta: string, strana: number, dpi: number, prefix: string) => ({
    prikaz: 'pdftoppm',
    args: ['-r', String(dpi), '-f', String(strana), '-l', String(strana), '-png', cesta, prefix],
  }),
  tesseract: (obrazek: string, jazyky: string, psm: 1 | 3, dpi?: number) => ({
    prikaz: 'tesseract',
    args: [obrazek, 'stdout', '-l', jazyky, '--psm', String(psm), ...(dpi ? ['--dpi', String(dpi)] : [])],
  }),
  antiword: (cesta: string) => ({ prikaz: 'antiword', args: ['-m', 'UTF-8.txt', '-t', cesta] }),
};

/** počet stran z výstupu pdfinfo */
export function stranyZPdfinfo(vystup: string): number | null {
  const m = /^Pages:\s+(\d+)/m.exec(vystup);
  return m ? Number(m[1]) : null;
}

// ---------- spouštění procesů ----------

export interface VysledekPrikazu {
  kod: number | null;
  stdout: Buffer;
  stderr: string;
  /** běh skončil časovým limitem (proces zabit) */
  timeout: boolean;
  /** výstup byl delší než limit a je oříznutý */
  oriznuto: boolean;
}

const kesBinarek = new Map<string, string | null>();

/** úplná cesta k binárce podle PATH (keš), nebo null */
export async function najdiBinarku(nazev: string, cesta = process.env.PATH ?? ''): Promise<string | null> {
  const klic = `${cesta}\u0000${nazev}`;
  if (kesBinarek.has(klic)) return kesBinarek.get(klic)!;
  let nalezeno: string | null = null;
  for (const dir of cesta.split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, nazev);
    try {
      await fs.access(p, fsKonstanty.X_OK);
      nalezeno = p;
      break;
    } catch {
      // v tomto adresáři není
    }
  }
  kesBinarek.set(klic, nalezeno);
  return nalezeno;
}

/** co je na serveru k dispozici (pro stránku správy a instalační kontrolu) */
export async function dostupneNastroje(cesta?: string) {
  const out: Record<'pdftotext' | 'pdfinfo' | 'pdftoppm' | 'tesseract' | 'antiword', boolean> = {
    pdftotext: false,
    pdfinfo: false,
    pdftoppm: false,
    tesseract: false,
    antiword: false,
  };
  for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = !!(await najdiBinarku(k, cesta));
  return out;
}

/**
 * Spustí příkaz s časovým limitem, přes `nice -n 15` (je-li k dispozici) a se stropem na velikost výstupu.
 * Nikdy nevyhazuje kvůli návratovému kódu — ten vrací volajícímu.
 */
export async function spust(
  prikaz: string,
  args: string[],
  v: { timeoutMs: number; nice?: boolean; maxVystupB?: number; cwd?: string; path?: string },
): Promise<VysledekPrikazu> {
  const bin = await najdiBinarku(prikaz, v.path);
  if (!bin) throw new ChybaNastroje(prikaz);
  const nice = v.nice === false ? null : await najdiBinarku('nice', v.path);
  const max = v.maxVystupB ?? MAX_VYSTUP_B;
  return new Promise<VysledekPrikazu>((resolve, reject) => {
    // Tesseract s OpenMP bere 4 vlákna a je přitom POMALEJŠÍ (měření 22. 10. 2026, hustá strana A4 při 200 dpi:
    // 4 vlákna 15 s a 45 s CPU, jedno vlákno 6,7 s) — a navíc by vytížil celý malý server. Jedno vlákno pro vše.
    const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
    const dite = nice
      ? spawn(nice, ['-n', '15', bin, ...args], { cwd: v.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin, args, { cwd: v.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const kusy: Buffer[] = [];
    let delka = 0;
    let oriznuto = false;
    let timeout = false;
    let stderr = '';
    const casovac = setTimeout(() => {
      timeout = true;
      dite.kill('SIGKILL');
    }, v.timeoutMs);
    dite.stdout.on('data', (k: Buffer) => {
      if (oriznuto) return;
      if (delka + k.length > max) {
        kusy.push(k.subarray(0, max - delka));
        delka = max;
        oriznuto = true;
        dite.kill('SIGKILL');
        return;
      }
      kusy.push(k);
      delka += k.length;
    });
    dite.stderr.on('data', (k: Buffer) => {
      if (stderr.length < 4000) stderr += k.toString('utf8');
    });
    dite.on('error', (e) => {
      clearTimeout(casovac);
      reject(e);
    });
    dite.on('close', (kod) => {
      clearTimeout(casovac);
      resolve({ kod, stdout: Buffer.concat(kusy), stderr: stderr.trim(), timeout, oriznuto });
    });
  });
}

export class ChybaNastroje extends Error {
  constructor(readonly nastroj: string) {
    super(`chybí program ${nastroj}`);
  }
}

// ---------- převod jednoho souboru ----------

const kratce = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);

/** hlavní vstup workeru: soubor na disku + jeho typ → text (nebo důvod, proč ne) */
export async function extrahujText(
  cesta: string,
  soubor: { mime: string; pripona: string },
  cfg: TextKonfigurace,
): Promise<VysledekTextu> {
  try {
    if (soubor.mime === MIME_PDF) return await textZPdf(cesta, cfg);
    if (soubor.mime.startsWith('image/')) return await ocrObrazku(cesta, cfg);
    const zdroj = MIME_OFFICE[soubor.mime];
    if (!zdroj)
      return { stav: 'nepodporovano', duvod: `typ ${soubor.mime} (${soubor.pripona}) neumíme číst` };
    if (zdroj === 'nepodporovano')
      return { stav: 'nepodporovano', duvod: `starý formát ${soubor.pripona.toUpperCase()} neumíme číst` };
    if (zdroj === 'antiword') {
      const r = await spust(prikazy.antiword(cesta).prikaz, prikazy.antiword(cesta).args, {
        timeoutMs: LIMIT_PDFTOTEXT_MS,
        path: cfg.path,
        nice: cfg.nice,
      });
      if (r.timeout) return { stav: 'chyba', duvod: 'antiword: překročen časový limit' };
      if (r.kod !== 0)
        return { stav: 'nepodporovano', duvod: `antiword: ${kratce(r.stderr) || `kód ${r.kod}`}` };
      return hotovo(r.stdout.toString('utf8'), 'antiword', null, null, cfg);
    }
    const data = await fs.readFile(cesta);
    if (zdroj === 'rtf') return hotovo(textZRtf(data), 'rtf', null, null, cfg);
    const { text, preskoceno } = textZOffice(data, zdroj);
    return hotovo(
      text,
      zdroj,
      null,
      null,
      cfg,
      preskoceno ? 'část souboru je příliš velká — přeskočena' : null,
    );
  } catch (e) {
    if (e instanceof ChybaNastroje) return { stav: 'nepodporovano', duvod: e.message };
    return { stav: 'chyba', duvod: kratce((e as Error).message ?? String(e)) };
  }
}

function hotovo(
  surovy: string,
  zdroj: ZdrojTextu,
  stran: number | null,
  maVrstvu: boolean | null,
  cfg: TextKonfigurace,
  poznamka: string | null = null,
): VysledekTextu {
  const { text, zkraceno } = cistiText(surovy, cfg.maxZnaku);
  const pozn = [poznamka, zkraceno ? `text zkrácen na ${cfg.maxZnaku} znaků` : null]
    .filter(Boolean)
    .join('; ');
  return {
    stav: pocetZnaku(text) < MIN_ZNAKU_TEXTU ? 'bez_textu' : 'hotovo',
    zdroj,
    text,
    stran,
    maVrstvu,
    poznamka: pozn || null,
  };
}

async function textZPdf(cesta: string, cfg: TextKonfigurace): Promise<VysledekTextu> {
  const info = await spust(prikazy.pdfinfo(cesta).prikaz, prikazy.pdfinfo(cesta).args, {
    timeoutMs: LIMIT_PDFINFO_MS,
    path: cfg.path,
    nice: cfg.nice,
  });
  if (info.kod !== 0) return { stav: 'chyba', duvod: `pdfinfo: ${kratce(info.stderr) || `kód ${info.kod}`}` };
  const stran = stranyZPdfinfo(info.stdout.toString('utf8'));
  const p = prikazy.pdftotext(cesta);
  const vrstva = await spust(p.prikaz, p.args, {
    timeoutMs: LIMIT_PDFTOTEXT_MS,
    path: cfg.path,
    nice: cfg.nice,
  });
  if (vrstva.timeout) return { stav: 'chyba', duvod: 'pdftotext: překročen časový limit' };
  if (vrstva.kod !== 0 && !vrstva.stdout.length)
    return { stav: 'chyba', duvod: `pdftotext: ${kratce(vrstva.stderr) || `kód ${vrstva.kod}`}` };
  const textVrstvy = vrstva.stdout.toString('utf8');
  const vrstvaOk = maVrstvu(textVrstvy, stran) && !jeNesmysl(textVrstvy);
  if (vrstvaOk) return hotovo(textVrstvy, 'vrstva', stran, true, cfg);

  // bez vrstvy (nebo vrstva plná nesmyslů) → OCR
  const ocr = await ocrPdf(cesta, stran, cfg);
  if (ocr.stav === 'nepodporovano' && pocetZnaku(textVrstvy) >= MIN_ZNAKU_TEXTU && !jeNesmysl(textVrstvy))
    return hotovo(textVrstvy, 'vrstva', stran, false, cfg, `slabá textová vrstva; ${ocr.duvod}`);
  return ocr;
}

async function ocrPdf(cesta: string, stran: number | null, cfg: TextKonfigurace): Promise<VysledekTextu> {
  for (const n of ['pdftoppm', 'tesseract'])
    if (!(await najdiBinarku(n, cfg.path))) throw new ChybaNastroje(n);
  const celkem = stran ?? 1;
  const kolik = Math.min(celkem, cfg.ocrMaxStran);
  const adresar = path.join(cfg.tmpDir, `text-${randomUUID()}`);
  await fs.mkdir(adresar, { recursive: true });
  const konec = Date.now() + LIMIT_OCR_MS;
  const texty: string[] = [];
  let hotovoStran = 0;
  let preruseno: string | null = null;
  try {
    for (let i = 1; i <= kolik; i++) {
      if (Date.now() >= konec) {
        preruseno = `OCR přerušeno po ${hotovoStran} z ${kolik} stran (časový limit)`;
        break;
      }
      const prefix = path.join(adresar, 'strana');
      const pp = prikazy.pdftoppm(cesta, i, cfg.ocrDpi, prefix);
      const r = await spust(pp.prikaz, pp.args, {
        timeoutMs: Math.min(LIMIT_OCR_STRANA_MS, konec - Date.now()),
        path: cfg.path,
        nice: cfg.nice,
      });
      const obrazky = (await fs.readdir(adresar)).filter((f) => f.startsWith('strana') && f.endsWith('.png'));
      if (r.kod !== 0 || !obrazky.length) {
        preruseno = `pdftoppm (strana ${i}): ${kratce(r.stderr) || `kód ${r.kod}`}`;
        break;
      }
      const obrazek = path.join(adresar, obrazky[0]!);
      try {
        texty.push(await ocrSouboru(obrazek, cfg, konec, cfg.ocrDpi));
      } finally {
        await Promise.all(obrazky.map((o) => fs.rm(path.join(adresar, o), { force: true })));
      }
      hotovoStran++;
      // délka textu už stačí — další strany by se stejně ořízly
      if (texty.reduce((a, t) => a + t.length, 0) >= cfg.maxZnaku) {
        preruseno = `OCR ukončeno po ${hotovoStran} stranách (dosažen limit délky textu)`;
        break;
      }
    }
  } catch (e) {
    if (e instanceof ChybaNastroje) throw e;
    if (!hotovoStran) return { stav: 'chyba', duvod: kratce((e as Error).message) };
    preruseno = `OCR přerušeno po ${hotovoStran} stranách: ${kratce((e as Error).message)}`;
  } finally {
    await fs.rm(adresar, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!hotovoStran && preruseno) return { stav: 'chyba', duvod: preruseno };
  const poznamky = [
    celkem > cfg.ocrMaxStran ? `OCR jen prvních ${cfg.ocrMaxStran} z ${celkem} stran` : null,
    preruseno,
  ]
    .filter(Boolean)
    .join('; ');
  return hotovo(texty.join('\n\n'), 'ocr', stran, false, cfg, poznamky || null);
}

/** tesseract nad jedním obrázkem: nejdřív s rozpoznáním otočení strany (psm 1), prázdný výsledek zkusí psm 3 */
async function ocrSouboru(
  obrazek: string,
  cfg: TextKonfigurace,
  konec: number,
  dpi?: number,
): Promise<string> {
  const beh = async (psm: 1 | 3) => {
    const p = prikazy.tesseract(obrazek, cfg.ocrJazyky, psm, dpi);
    const r = await spust(p.prikaz, p.args, {
      timeoutMs: Math.max(1000, Math.min(LIMIT_OCR_STRANA_MS, konec - Date.now())),
      path: cfg.path,
      nice: cfg.nice,
    });
    if (r.timeout) throw new Error('tesseract: překročen časový limit');
    if (r.kod !== 0) throw new Error(`tesseract: ${kratce(r.stderr) || `kód ${r.kod}`}`);
    return r.stdout.toString('utf8');
  };
  const prvni = await beh(1);
  if (pocetZnaku(prvni) >= MIN_ZNAKU_TEXTU || Date.now() >= konec) return prvni;
  return beh(3);
}

async function ocrObrazku(cesta: string, cfg: TextKonfigurace): Promise<VysledekTextu> {
  if (!(await najdiBinarku('tesseract', cfg.path))) throw new ChybaNastroje('tesseract');
  const text = await ocrSouboru(cesta, cfg, Date.now() + LIMIT_OCR_MS);
  return hotovo(text, 'obrazek', 1, false, cfg);
}

/**
 * Rychlá kontrola při nahrání PDF (do 5 s, první 3 strany): má textovou vrstvu? `nejiste` = nestihlo se nebo
 * chybí nástroje — pak se jen řekne „zkontrolujeme na pozadí“.
 */
export async function rychlaKontrolaPdf(
  cesta: string,
  cfg: Pick<TextKonfigurace, 'path' | 'nice'>,
): Promise<'vrstva' | 'bez_vrstvy' | 'nejiste'> {
  const konec = Date.now() + LIMIT_RYCHLA_KONTROLA_MS;
  try {
    const info = await spust(prikazy.pdfinfo(cesta).prikaz, prikazy.pdfinfo(cesta).args, {
      timeoutMs: 2000,
      path: cfg.path,
      nice: false,
    });
    if (info.kod !== 0) return 'nejiste';
    const stran = Math.min(3, stranyZPdfinfo(info.stdout.toString('utf8')) ?? 1);
    const p = prikazy.pdftotext(cesta, { od: 1, do: stran });
    const r = await spust(p.prikaz, p.args, {
      timeoutMs: Math.max(500, konec - Date.now()),
      path: cfg.path,
      nice: false,
    });
    if (r.timeout || r.kod !== 0) return 'nejiste';
    const t = r.stdout.toString('utf8');
    return maVrstvu(t, stran) && !jeNesmysl(t) ? 'vrstva' : 'bez_vrstvy';
  } catch {
    return 'nejiste';
  }
}
