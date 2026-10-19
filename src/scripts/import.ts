// Import obsahu ze starého webu obce do platformy (stránky, aktuality, úřední deska, menu, dotace, přesměrování).
//
//   node dist/scripts/import.js wordpress https://www.obec.cz [volby]
//   (ve vývoji: npx tsx src/scripts/import.ts …)
//
// Volby:
//   --aktuality-od 2024-10-01   aktuality od data (výchozí: 2 roky zpět)
//   --deska-od 2020-01-01       úřední deska od data (výchozí: vše)
//   --limit-mb 1800             strop pro stažené soubory (výchozí 1800 MB)
//   --dotace soubor.json        dotace k založení (pole objektů {projekt, poskytovatel, text, odkaz, loga:[{url, alt}]})
//   --jen stranky,aktuality,deska,menu,dotace   jen vybrané části
//   --prepsat                   už importované stránky a aktuality přepsat obsahem ze zdroje (text, ne strukturu)
//   --kategorie-desky slug      kategorie WordPressu, která tvoří úřední desku (výchozí uredni-deska)
//
// Archiv starého webu (Wayback Machine), jen aktuality — viz docs/IMPORT.md:
//   node dist/scripts/import.js archiv http://www.obec.cz/ --do 2013 --vsechny-snimky \
//     --vytezovace topdesign-aktuality,topdesign-clanky --kategorie "Archiv starého webu" --nanecisto
//   --cdx soubor.txt            výpis CDX (timestamp original status mime) místo dotazu na archiv
//   --od / --do RRRR[MMDD]      časové okno snímků; --vsechny-snimky = každá změněná verze stránky (titulky)
//   --cache adresar             keš stažených snímků (opakovaný běh archiv nezatěžuje)
//   --zname soubor.tsv          známé články odjinud (titulek<TAB>RRRR-MM-DD) — přeskočí se jako duplicita
//   --vynechat soubor.txt       adresy článků k vynechání (po řádcích; ruční posouzení, osobní údaje)
//   --titulky soubor.tsv        ruční titulky (adresa článku<TAB>titulek) místo odvozených
//   --vynechat-text 'regex'     přeskočit články s textem odpovídajícím výrazu (zprávy o změnách starého webu)
//   --nanecisto                 jen vypíše, co by se importovalo (nic nezapíše); --s-html přidá i text článků
// Zdvořilé stahování: max. 2 požadavky/s, User-Agent s kontaktem (IMPORT_KONTAKT v prostředí).
import { readFileSync } from 'node:fs';
import { nactiEnv } from '../config/env.js';
import { vytvorDb, pockejNaDb } from '../db/index.js';
import { migruj } from '../db/migrate.js';
import { SouboroveUloziste } from '../lib/soubory.js';
import { DeskaSluzba } from '../moduly/deska/sluzba.js';
import { DotaceSluzba, PresmerovaniSluzba } from '../moduly/web/dalsi.js';
import { ObsahSluzba } from '../moduly/web/obsah.js';
import { Importer } from '../moduly/web/import/importer.js';
import { vytvorStahovac } from '../moduly/web/import/stahovac.js';
import type { ImportDotace, ImportniZdroj } from '../moduly/web/import/typy.js';
import { WordpressZdroj } from '../moduly/web/import/wordpress.js';
import { GalileoZdroj } from '../moduly/web/import/galileo.js';
import { ArchivZdroj, VYTEZOVACE } from '../moduly/web/import/archiv.js';
import {
  cdxDotaz,
  kesovanyStahovac,
  parsujCdx,
  waybackStahovac,
  type ZaznamCdx,
} from '../moduly/web/import/wayback.js';
import { slugify } from '../lib/slug.js';

// výchozí mapování kategorií aktualit zdroje → kategorie platformy (běžné názvy na obecních webech)
const KATEGORIE: Record<string, string> = {
  'ou-informuje': 'obecni-urad',
  'obecni-urad': 'obecni-urad',
  aktuality: 'obecni-urad',
  'obecni-zpravodaj': 'zpravodaj',
  zpravodaj: 'zpravodaj',
  'akce-udalosti': 'kultura',
  akce: 'kultura',
  kultura: 'kultura',
  sport: 'sport',
};

const arg = process.argv.slice(2);
const volba = (n: string) => {
  const i = arg.indexOf(`--${n}`);
  return i >= 0 ? arg[i + 1] : undefined;
};
const [typ, url] = arg;
if (!typ || !url || !/^https?:\/\//.test(url)) {
  console.error(
    'Použití: import.js <wordpress|galileo|archiv> <https://adresa-stareho-webu> [volby] — viz hlavička skriptu',
  );
  process.exit(2);
}

const env = nactiEnv();
const db = vytvorDb(env.DATABASE_URL, 2);
await pockejNaDb(db);
await migruj(db);

const kontakt = process.env.IMPORT_KONTAKT ?? 'kontakt neuveden';
const stahovac = vytvorStahovac({
  userAgent: `MojeObec-import (${kontakt})`,
  rozestupMs: Number(volba('rozestup-ms') ?? 500),
  limitBajtu: Number(volba('limit-mb') ?? 1800) * 1024 * 1024,
  log: (z) => console.log('  ·', z),
});
const dotace: ImportDotace[] = volba('dotace') ? JSON.parse(readFileSync(volba('dotace')!, 'utf8')) : [];

let zdroj: ImportniZdroj;
let stahovacMedii = stahovac;
let archiv: ArchivZdroj | null = null;
if (typ === 'archiv') {
  const kes = volba('cache') ? kesovanyStahovac(stahovac, volba('cache')!) : stahovac;
  let zaznamy: ZaznamCdx[];
  if (volba('cdx')) zaznamy = parsujCdx(readFileSync(volba('cdx')!, 'utf8'));
  else {
    const dotaz = new URL(
      cdxDotaz(url.replace(/^https?:\/\//, ''), { predpona: true, od: volba('od'), do: volba('do') }),
    );
    dotaz.searchParams.append('filter', 'mimetype:text/html');
    if (arg.includes('--vsechny-snimky')) dotaz.searchParams.set('collapse', 'digest');
    zaznamy = parsujCdx((await kes.soubor(dotaz.href))?.data.toString('utf8') ?? '');
  }
  zaznamy = zaznamy.filter((z) => !z.typ || z.typ.startsWith('text/html'));
  const host = new URL(url).host.replace(/^www\./, '');
  const maxCas =
    zaznamy
      .map((z) => z.cas)
      .sort()
      .pop() ?? '2010';
  stahovacMedii = waybackStahovac(kes, maxCas, (u) => {
    try {
      return new URL(u).host.replace(/^www\./, '') === host;
    } catch {
      return false;
    }
  });
  const nazvy = (volba('vytezovace') ?? Object.keys(VYTEZOVACE).join(',')).split(',');
  archiv = new ArchivZdroj({
    zaklad: url,
    stahovac: kes,
    stranky: zaznamy,
    vytezovace: nazvy.map((n) => {
      const v = VYTEZOVACE[n];
      if (!v) throw new Error(`Neznámý vytěžovač ${n} (známé: ${Object.keys(VYTEZOVACE).join(', ')})`);
      return v;
    }),
    kategorie: volba('kategorie') ? slugify(volba('kategorie')!) : undefined,
    vynechat: volba('vynechat')
      ? readFileSync(volba('vynechat')!, 'utf8')
          .split('\n')
          .map((r) => r.trim())
          .filter((r) => r && !r.startsWith('#'))
      : [],
    titulky: volba('titulky')
      ? Object.fromEntries(
          readFileSync(volba('titulky')!, 'utf8')
            .split('\n')
            .map((r) => r.split('\t'))
            .filter((r) => r.length >= 2 && r[1]!.trim())
            .map((r) => [r[0]!.trim(), r[1]!.trim()]),
        )
      : undefined,
    vynechatText: volba('vynechat-text') ? new RegExp(volba('vynechat-text')!, 'i') : undefined,
    log: (z) => console.log('  ·', z),
  });
  zdroj = archiv;
  console.log(`Archiv ${url}: ${zaznamy.length} snímků stránek`);
} else if (typ === 'wordpress')
  zdroj = new WordpressZdroj({ zaklad: url, stahovac, dotace, kategorieDesky: volba('kategorie-desky') });
else if (typ === 'galileo')
  zdroj = new GalileoZdroj({ zaklad: url, stahovac, maxStranek: Number(volba('max-stranek') ?? 300) });
else {
  console.error(`Neznámý typ zdroje: ${typ}`);
  process.exit(2);
}

const jen = volba('jen')?.split(',');
const zapnuto = (cast: string) => !jen || jen.includes(cast);
const aktualityOd = volba('aktuality-od')
  ? new Date(volba('aktuality-od')!)
  : archiv
    ? new Date('1990-01-01')
    : new Date(Date.now() - 2 * 365 * 86_400_000);
// kategorie pro archiv: založit, když chybí (např. „Archiv starého webu“)
const kategorie = { ...KATEGORIE };
if (archiv && volba('kategorie') && !arg.includes('--nanecisto')) {
  const slug = slugify(volba('kategorie')!);
  await db
    .insertInto('web_kategorie')
    .values({ slug, nazev: volba('kategorie')!, poradi: 900 })
    .onConflict((oc) => oc.column('slug').doNothing())
    .execute();
  kategorie[slug] = slug;
}
const zname = volba('zname')
  ? readFileSync(volba('zname')!, 'utf8')
      .split('\n')
      .map((r) => r.split('\t'))
      .filter((r) => r.length >= 2 && /^\d{4}-\d\d-\d\d/.test(r[1]!))
      .map((r) => ({
        titulek: r[0]!,
        datum: new Date(r[1]!.slice(0, 10) + 'T12:00:00Z'),
        zdroj: r[2] ?? 'známé',
      }))
  : [];
const importer = new Importer(
  zdroj,
  {
    db,
    obsah: new ObsahSluzba(db),
    soubory: new SouboroveUloziste(db, env.DATA_DIR),
    presmerovani: new PresmerovaniSluzba(db),
    dotace: new DotaceSluzba(db),
    deska: new DeskaSluzba(db),
  },
  stahovacMedii,
  {
    aktualityOd,
    deskaOd: volba('deska-od') ? new Date(volba('deska-od')!) : undefined,
    stranky: zapnuto('stranky'),
    aktuality: zapnuto('aktuality'),
    deska: zapnuto('deska'),
    menu: zapnuto('menu'),
    dotace: zapnuto('dotace'),
    kategorieAktualit: kategorie,
    prepsat: arg.includes('--prepsat'),
    archiv: !!archiv,
    kontrolaDuplicit: !!archiv || arg.includes('--kontrola-duplicit'),
    znameClanky: zname,
    log: (z) => console.log(z),
  },
);
if (archiv && arg.includes('--nanecisto')) {
  const clanky = await archiv.priprav();
  for (const c of clanky) {
    const dup = await importer.duplicita(c.titulek, c.datum, c.html);
    console.log(
      JSON.stringify({
        datum: c.datum.toISOString().slice(0, 10),
        titulek: c.titulek,
        url: c.url,
        znaku: c.html.replace(/<[^>]+>/g, '').length,
        duplicita: dup,
        vyskyty: c.vyskyty.length,
        odvozene: c.datumOdvozene ?? undefined,
        html: arg.includes('--s-html') ? c.html : undefined,
      }),
    );
  }
  for (const b of archiv.bezData) console.log('BEZ DATA:', JSON.stringify(b));
  console.log(`Nanečisto: ${clanky.length} článků s datem, ${archiv.bezData.length} bez data`);
  await db.destroy();
  process.exit(0);
}
console.log(`Import z ${url} (${zdroj.nazev}), aktuality od ${aktualityOd.toISOString().slice(0, 10)}`);
const v = await importer.spust();
if (archiv)
  for (const b of archiv.bezData) console.log('  bez data (neimportováno):', b.titulek, '←', b.vyskyty[0]);
for (const d of v.duplicity) console.log('  duplicita (přeskočeno):', d);
console.log(
  'Hotovo:',
  JSON.stringify({
    ...v,
    duplicity: v.duplicity.length,
    chyby: v.chyby.length,
    stazenoMB: Math.round(stahovac.stazeno / 1024 / 1024),
  }),
);
for (const c of v.chyby.slice(0, 50)) console.log('  chyba:', c);
await db.destroy();
