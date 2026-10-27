// Návštěvnost webu: přepočet logů do denních agregátů (tabulky navstevnost_den / navstevnost_stranky) a data pro
// veřejnou stránku /navstevnost. Ukládají se jen počty — žádné IP adresy ani prohlížeče.
import { sql } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { T } from '../../i18n/index.js';
import { Agregator, CELKEM, SEKCE, denPraha, prectiSoubor, souboryLogu, type Sekce } from './logy.js';

export const KLIC_NASTAVENI = 'navstevnost';
export const OBDOBI = [7, 30, 90] as const;
/** kolik nejnavštěvovanějších stránek na den a sekci se ukládá */
const TOP_NA_DEN = 60;
/** kolik stránek ukáže tabulka */
const TOP_TABULKA = 30;

export interface NastaveniNavstevnosti {
  adresar: string;
  vzory: string;
  vlastniIp: string[];
}

export interface StavPrepoctu {
  posledni_prepocet: string;
  souboru: number;
  radku: number;
  dnu: number;
}

/** posun dne YYYY-MM-DD o n dní */
export function posunDen(den: string, n: number): string {
  const [r, m, d] = den.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(r, m - 1, d + n)).toISOString().slice(0, 10);
}

// stránky modulů a nativní stránky → klíč textu (nadpis stránky)
const NAZVY_MODULU: Record<string, string> = {
  '/': 'navstevnost.str.uvod',
  '/aktuality': 'navstevnost.str.aktuality',
  '/akce': 'navstevnost.str.akce',
  '/galerie': 'navstevnost.str.galerie',
  '/videa': 'videa.titulek',
  '/dokumenty': 'navstevnost.str.dokumenty',
  '/dotace': 'web.dotace',
  '/uredni-deska': 'deska.titulek',
  '/rozpocet': 'deska.rozpocet_titulek',
  '/povinne-informace': 'pi.titulek',
  '/kontakt': 'staticke.kontakt_titulek',
  '/ochrana-osobnich-udaju': 'staticke.gdpr_titulek',
  '/prohlaseni-o-pristupnosti': 'staticke.pristupnost_titulek',
  '/mapa-stranek': 'staticke.mapa_titulek',
  '/hledat': 'navstevnost.str.hledat',
  '/kviz': 'kviz.titulek',
  '/podatelna': 'podatelna.titulek',
  '/odstavky': 'odstavky.titulek',
  '/pocasi': 'navstevnost.str.pocasi',
  '/navstevnost': 'navstevnost.titulek',
  '/infokanal': 'navstevnost.sekce.infokanal',
  '/infokanal/vystrahy': 'vystrahy.titulek',
  '/infokanal/odber': 'navstevnost.str.odber',
  '/ucet': 'ucet.titulek',
  '/prihlaseni': 'prihlaseni.titulek',
  '/rezervace': 'navstevnost.sekce.rezervace',
  '/rezervace/spolujizda': 'navstevnost.sekce.spolujizda',
  '/eknihy': 'navstevnost.sekce.eknihy',
  '/eknihy/knihovna': 'navstevnost.str.katalog',
};

export interface RadekStranky {
  sekce: string;
  cesta: string;
  zobrazeni: number;
  navstevnici: number;
  titulek: string | null;
  odkaz: string | null;
}

export class NavstevnostSluzba {
  private bezi: Promise<StavPrepoctu> | null = null;

  constructor(
    private db: Db,
    private nastaveni: NastaveniNavstevnosti,
    private log: FastifyBaseLogger,
  ) {}

  /** přepočet všech dnů z logů (běží nejvýš jeden najednou) */
  prepocitej(ted = new Date()): Promise<StavPrepoctu> {
    if (!this.bezi) this.bezi = this.proved(ted).finally(() => (this.bezi = null));
    return this.bezi;
  }

  /** jsou už nějaká data? (první naplnění po startu) */
  async maData(): Promise<boolean> {
    const r = await this.db.selectFrom('navstevnost_den').select('den').limit(1).executeTakeFirst();
    return !!r;
  }

  private async proved(ted: Date): Promise<StavPrepoctu> {
    const zacatek = Date.now();
    const soubory = await souboryLogu(this.nastaveni.adresar, this.nastaveni.vzory);
    const ag = new Agregator(this.nastaveni.vlastniIp, TOP_NA_DEN);
    for (const f of soubory) {
      try {
        await prectiSoubor(f, ag);
      } catch (e) {
        this.log.warn({ err: e, soubor: f }, 'návštěvnost: soubor logu nejde přečíst');
      }
    }
    const vysledek = ag.vysledek();
    let dny = ag.dnyVLogu;
    await this.db.transaction().execute(async (trx) => {
      // nejstarší den v logu bývá useknutý rotací (archiv začíná uprostřed dne) — když ho už máme spočítaný
      // z dřívějška (z úplnějších dat), nepřepisujeme ho
      const prvni = dny[0];
      if (prvni) {
        const uz = await trx
          .selectFrom('navstevnost_den')
          .select('den')
          .where('den', '=', prvni)
          .executeTakeFirst();
        if (uz && dny.length > 1) dny = dny.slice(1);
      }
      if (!dny.length) return;
      const mnozina = new Set(dny);
      await trx.deleteFrom('navstevnost_stranky').where('den', 'in', dny).execute();
      await trx.deleteFrom('navstevnost_den').where('den', 'in', dny).execute();
      const radkyDnu = vysledek.filter((r) => mnozina.has(r.den)).map(({ stranky: _s, ...r }) => r);
      for (let i = 0; i < radkyDnu.length; i += 500)
        await trx
          .insertInto('navstevnost_den')
          .values(radkyDnu.slice(i, i + 500))
          .execute();
      const radkyStranek = vysledek
        .filter((r) => mnozina.has(r.den))
        .flatMap((r) => r.stranky.map((s) => ({ den: r.den, sekce: r.sekce, ...s })));
      for (let i = 0; i < radkyStranek.length; i += 500)
        await trx
          .insertInto('navstevnost_stranky')
          .values(radkyStranek.slice(i, i + 500))
          .execute();
    });
    const stav: StavPrepoctu = {
      posledni_prepocet: ted.toISOString(),
      souboru: soubory.length,
      radku: ag.radku,
      dnu: dny.length,
    };
    await this.db
      .insertInto('nastaveni')
      .values({ klic: KLIC_NASTAVENI, hodnota: JSON.stringify(stav) })
      .onConflict((oc) =>
        oc.column('klic').doUpdateSet({ hodnota: JSON.stringify(stav), upraven_at: new Date() }),
      )
      .execute();
    this.log.info({ ...stav, pozdnich: ag.pozdnich, ms: Date.now() - zacatek }, 'návštěvnost přepočítána');
    return stav;
  }

  /** data pro stránku: posledních `dni` dní (chybějící dny = 0), souhrny, sekce a nejnavštěvovanější stránky */
  async prehled(dni: number, sekce: Sekce | null, t: T, ted = new Date()) {
    const dnes = denPraha(ted);
    const od = posunDen(dnes, -(dni - 1));
    const radky = await this.db
      .selectFrom('navstevnost_den')
      .selectAll()
      .where('den', '>=', od)
      .where('den', '<=', dnes)
      .execute();
    const klic = sekce ?? CELKEM;
    const podleDne = new Map(radky.filter((r) => r.sekce === klic).map((r) => [r.den, r]));
    const serie: { den: string; navstevnici: number; zobrazeni: number }[] = [];
    for (let i = 0; i < dni; i++) {
      const den = posunDen(od, i);
      const r = podleDne.get(den);
      serie.push({ den, navstevnici: r?.navstevnici ?? 0, zobrazeni: r?.zobrazeni ?? 0 });
    }
    const soucet = (pole: 'navstevnici' | 'zobrazeni' | 'stazeni' | 'boti' | 'pozadavky') =>
      [...podleDne.values()].reduce((s, r) => s + r[pole], 0);
    const sekceSDaty = SEKCE.filter((s) => radky.some((r) => r.sekce === s && (r.zobrazeni || r.stazeni)));

    let dotaz = this.db
      .selectFrom('navstevnost_stranky')
      .select([
        'sekce',
        'cesta',
        sql<number>`sum(zobrazeni)::int`.as('zobrazeni'),
        sql<number>`sum(navstevnici)::int`.as('navstevnici'),
      ])
      .where('den', '>=', od)
      .where('den', '<=', dnes);
    if (sekce) dotaz = dotaz.where('sekce', '=', sekce);
    const top = await dotaz
      .groupBy(['sekce', 'cesta'])
      .orderBy('zobrazeni', 'desc')
      .orderBy('cesta')
      .limit(TOP_TABULKA)
      .execute();
    const nazvy = await this.nazvyStranek(
      top.map((r) => r.cesta),
      t,
      ted,
    );
    const stranky: RadekStranky[] = top.map((r) => ({
      ...r,
      ...(nazvy.get(r.cesta) ?? { titulek: null, odkaz: null }),
    }));

    const prvni = await this.db
      .selectFrom('navstevnost_den')
      .select(sql<string | null>`min(den)`.as('m'))
      .executeTakeFirst();
    const meta = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_NASTAVENI)
      .executeTakeFirst();
    return {
      dni,
      sekce,
      od,
      dnes,
      serie,
      navstevnici: soucet('navstevnici'),
      zobrazeni: soucet('zobrazeni'),
      stazeni: soucet('stazeni'),
      boti: soucet('boti'),
      pozadavky: soucet('pozadavky'),
      sekceSDaty,
      stranky,
      prvniDen: prvni?.m ?? null,
      stav: (meta?.hodnota as unknown as StavPrepoctu | undefined) ?? null,
    };
  }

  /**
   * Lidské názvy stránek: stránky modulů z textů, stránky/aktuality/akce/galerie z obsahu webu (jen zveřejněné),
   * dokumenty úřední desky, staré adresy přes tabulku přesměrování. Nenalezené = null (ukáže se cesta).
   */
  async nazvyStranek(
    cesty: string[],
    t: T,
    ted = new Date(),
  ): Promise<Map<string, { titulek: string | null; odkaz: string | null }>> {
    const vysledek = new Map<string, { titulek: string | null; odkaz: string | null }>();
    const odkazNa = (c: string) => (c.includes(':') ? null : c);

    // staré adresy (např. WordPress /rok/měsíc/článek) → nová cesta
    const zbyle = cesty.filter((c) => !NAZVY_MODULU[c]);
    const presmerovani = new Map<string, string>();
    if (zbyle.length) {
      const r = await this.db
        .selectFrom('web_presmerovani')
        .select(['stara_cesta', 'nova_cesta'])
        .where('stara_cesta', 'in', zbyle)
        .execute();
      for (const x of r)
        if (x.nova_cesta.startsWith('/')) presmerovani.set(x.stara_cesta, x.nova_cesta.split(/[?#]/)[0]!);
    }
    const cil = (c: string) => presmerovani.get(c) ?? c;
    const cile = [...new Set(cesty.map(cil))];

    const segmenty = (c: string) => c.split('/').slice(1);
    const podTypem = (prefix: string) =>
      cile
        .map(segmenty)
        .filter((s) => s.length === 2 && s[0] === prefix)
        .map((s) => s[1]!);
    const aktuality = podTypem('aktuality');
    const akce = podTypem('akce');
    const galerie = podTypem('galerie');
    const deska = podTypem('uredni-deska').filter((s) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s),
    );
    const strankySlugy = cile
      .map(segmenty)
      .filter((s) => s.length >= 1 && s.length <= 2 && s[0])
      .map((s) => s[s.length - 1]!);

    const obsah = new Map<string, string>(); // cesta → titulek
    const typy: [string, string[]][] = [
      ['aktualita', aktuality],
      ['akce', akce],
    ];
    for (const [typ, slugy] of typy) {
      if (!slugy.length) continue;
      const r = await this.db
        .selectFrom('web_obsah')
        .select(['slug', 'titulek'])
        .where('typ', '=', typ as 'aktualita')
        .where('slug', 'in', slugy)
        .where('stav', '=', 'zverejneno')
        .where('smazano_at', 'is', null)
        .execute();
      for (const x of r) obsah.set(`/${typ === 'aktualita' ? 'aktuality' : 'akce'}/${x.slug}`, x.titulek);
    }
    if (strankySlugy.length) {
      const r = await this.db
        .selectFrom('web_obsah as o')
        .leftJoin('web_obsah as p', 'p.id', 'o.nadrazena_id')
        .select(['o.slug', 'o.titulek', 'p.slug as rodic', 'p.typ as rodic_typ'])
        .where('o.typ', '=', 'stranka')
        .where('o.slug', 'in', strankySlugy)
        .where('o.stav', '=', 'zverejneno')
        .where('o.smazano_at', 'is', null)
        .execute();
      for (const x of r) {
        const cesta = x.rodic && x.rodic_typ === 'stranka' ? `/${x.rodic}/${x.slug}` : `/${x.slug}`;
        if (!obsah.has(cesta)) obsah.set(cesta, x.titulek);
      }
    }
    if (galerie.length) {
      const r = await this.db
        .selectFrom('web_galerie')
        .select(['slug', 'nazev'])
        .where('slug', 'in', galerie)
        .where('stav', '=', 'zverejneno')
        .where('smazano_at', 'is', null)
        .execute();
      for (const x of r) obsah.set(`/galerie/${x.slug}`, x.nazev);
    }
    if (deska.length) {
      const r = await this.db
        .selectFrom('ud_dokumenty as d')
        .innerJoin('ud_kategorie as k', 'k.id', 'd.kategorie_id')
        .select(['d.id', 'd.nazev'])
        .where('d.id', 'in', deska)
        .where('d.smazano_at', 'is', null)
        .where('d.vyveseno_od', '<=', ted)
        .where((eb) =>
          eb.or([
            eb('d.sejmuto_do', 'is', null),
            eb('d.sejmuto_do', '>', ted),
            eb('k.archiv_verejny', '=', true),
          ]),
        )
        .execute();
      for (const x of r) obsah.set(`/uredni-deska/${x.id}`, x.nazev);
    }

    for (const c of cesty) {
      const modul = NAZVY_MODULU[c];
      if (modul) {
        vysledek.set(c, { titulek: t(modul), odkaz: c });
        continue;
      }
      const nova = cil(c);
      const titulek = obsah.get(nova) ?? (NAZVY_MODULU[nova] ? t(NAZVY_MODULU[nova]) : null);
      vysledek.set(c, { titulek, odkaz: titulek ? odkazNa(nova) : odkazNa(c) });
    }
    return vysledek;
  }
}
