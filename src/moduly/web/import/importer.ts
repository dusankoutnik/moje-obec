// Společný importér: z obsahu, který vrátí adaptér (WordPress, Galileo…), založí stránky, aktuality, úřední desku,
// dotace a menu; média stáhne a přeuloží (obrázky bez EXIF, kontrola typu), odkazy přepíše a pro staré adresy
// založí přesměrování 301. Je idempotentní: co už bylo importováno (podle původní URL), přeskočí.
import { sql } from 'kysely';
import type { Db } from '../../../db/index.js';
import { datumPraha, pridejDny } from '../../../lib/datum.js';
import { altZeZdroje, sanitizuj, srovnejNadpisy, textZHtml, zkrat } from '../../../lib/html.js';
import type { SouboroveUloziste } from '../../../lib/soubory.js';
import { urlSouboru } from '../../../web/soubory.js';
import type { DeskaSluzba, TypRozpoctu } from '../../deska/sluzba.js';
import type { DotaceSluzba, PresmerovaniSluzba } from '../dalsi.js';
import { PRAZDNA_POLE, type ObsahSluzba } from '../obsah.js';
import { odkazNaSluzbu, VideaSluzba, znackaVidea } from '../videa.js';
import { najdiVidea, ZNACKA_VIDEA } from './html-pomoc.js';
import type { ImportMenu, ImportniZdroj, ImportStranka, ImportVideo, Stahovac } from './typy.js';

export interface VolbyImportu {
  /** aktuality od tohoto data */
  aktualityOd: Date;
  /** úřední deska od tohoto data (výchozí: vše) */
  deskaOd?: Date;
  stranky?: boolean;
  aktuality?: boolean;
  deska?: boolean;
  menu?: boolean;
  dotace?: boolean;
  /** už importované stránky a aktuality znovu načíst a přepsat obsahem ze zdroje (po vylepšení adaptéru) */
  prepsat?: boolean;
  /** mapování kategorie zdroje → slug kategorie aktualit platformy */
  kategorieAktualit?: Record<string, string>;
  /**
   * Archiv starého webu (např. z Wayback Machine): staré adresy nepatří nové doméně → bez přesměrování,
   * odkazy na neimportované stránky a nedostupné soubory zůstanou jen jako text.
   */
  archiv?: boolean;
  /**
   * Přeskočit aktuality, které už na webu jsou (podobný titulek a datum ±3 dny) — při importu z dalšího zdroje
   * téhož obsahu. `znameClanky` = navíc články z jiného zdroje, které na webu (zatím) nejsou.
   */
  kontrolaDuplicit?: boolean;
  znameClanky?: { titulek: string; datum: Date; zdroj?: string; text?: string }[];
  log?: (zprava: string) => void;
}

export interface Sluzby {
  db: Db;
  /** knihovna videí (když chybí, importér si ji vytvoří) */
  videa?: VideaSluzba;
  obsah: ObsahSluzba;
  soubory: SouboroveUloziste;
  presmerovani: PresmerovaniSluzba;
  dotace: DotaceSluzba;
  deska?: DeskaSluzba;
}

export interface VysledekImportu {
  stranky: number;
  aktuality: number;
  deska: number;
  dotace: number;
  menu: number;
  souboru: number;
  presmerovani: number;
  preskoceno: number;
  /** nově založená videa (z YouTube/Vimea i vlastních souborů v obsahu) */
  videa: number;
  /** aktuality přeskočené jako duplicita: „titulek (datum) = existující“ */
  duplicity: string[];
  chyby: string[];
}

/** titulek pro porovnání duplicit: bez diakritiky, interpunkce a velikosti písmen */
export function klicTitulku(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** stejný nebo podobný titulek (jeden obsahuje druhý, u krátkých jen shoda) */
export function podobnyTitulek(a: string, b: string): boolean {
  const x = klicTitulku(a);
  const y = klicTitulku(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [kratsi, delsi] = x.length < y.length ? [x, y] : [y, x];
  return kratsi.length >= 12 && delsi.includes(kratsi);
}

const DOKUMENTY = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
const OBRAZKY = /\.(jpe?g|png|gif|webp)$/i;

/** z textu titulku odhadne druh rozpočtového dokumentu a rok (pro kategorii „rozpočet“) */
export function odhadniRozpocet(nazev: string, datum: Date): { typ: TypRozpoctu; rok: number } | null {
  const n = nazev.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const rokZNazvu = /\b(20\d\d)\b/.exec(n)?.[1];
  const rok = rokZNazvu ? Number(rokZNazvu) : datum.getFullYear();
  const navrh = /navrh/.test(n);
  if (/rozpoctov\w* opatreni|\bro\s*c\.?\s*\d/.test(n)) return { typ: 'rozpoctove_opatreni', rok };
  if (/strednedob\w* vyhled|vyhled\w* rozpoct|\bsvr\b/.test(n))
    return { typ: navrh ? 'navrh_vyhledu' : 'vyhled', rok };
  if (/zaverecn\w* uc|\bzu\b/.test(n)) return { typ: navrh ? 'navrh_zu' : 'zaverecny_ucet', rok };
  if (/rozpoc/.test(n))
    return { typ: navrh ? 'navrh_rozpoctu' : 'rozpocet', rok: rokZNazvu ? rok : navrh ? rok + 1 : rok };
  return null;
}

/** text menu z VELKÝCH PÍSMEN na běžný („AKTUÁLNĚ“ → „Aktuálně“) */
export function hezkyTitulek(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t === t.toUpperCase() && /[A-ZÁ-Ž]{3}/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t;
}

export class Importer {
  private media = new Map<string, { url: string; id: string; obrazek: boolean } | null>();
  private mapa = new Map<string, string>(); // stará cesta (normalizovaná) → nová
  private host: string;
  readonly vysledek: VysledekImportu = {
    stranky: 0,
    aktuality: 0,
    deska: 0,
    dotace: 0,
    menu: 0,
    souboru: 0,
    presmerovani: 0,
    preskoceno: 0,
    videa: 0,
    duplicity: [],
    chyby: [],
  };
  private zname: { titulek: string; datum: Date; popis: string; text: string }[] | null = null;

  constructor(
    private zdroj: ImportniZdroj,
    private s: Sluzby,
    private stahovac: Stahovac,
    private v: VolbyImportu,
  ) {
    this.host = new URL(zdroj.zaklad).host.replace(/^www\./, '');
  }

  private log(z: string) {
    this.v.log?.(z);
  }

  private jeNas(u: URL) {
    return u.host.replace(/^www\./, '') === this.host;
  }

  private cesta(url: string) {
    try {
      const u = new URL(url, this.zdroj.zaklad);
      return (u.pathname.replace(/\/+$/, '') || '/') + u.search;
    } catch {
      return url;
    }
  }

  // ---------------- média a HTML ----------------

  /** stáhne soubor ze starého webu a uloží ho (jednou); vrací novou URL */
  async soubor(
    url: string,
    druh: 'dokument' | 'obrazek' | 'logo' | 'video',
    alt = '',
  ): Promise<{ url: string; id: string; obrazek: boolean } | null> {
    const klic = `${druh}:${url}`;
    if (this.media.has(klic)) return this.media.get(klic)!;
    const existujici = await this.s.soubory.podleZdroje(url);
    if (existujici) {
      const r = {
        url: urlSouboru(existujici),
        id: existujici.id,
        obrazek: existujici.mime.startsWith('image/'),
      };
      this.media.set(klic, r);
      return r;
    }
    const stazeny = await this.stahovac.soubor(url);
    if (!stazeny) {
      this.media.set(klic, null);
      return null;
    }
    const nazev = jmenoSouboru(url);
    const v = await this.s.soubory.uloz({ data: stazeny.data, nazev, druh, alt, zdrojUrl: url });
    if ('chyba' in v) {
      this.vysledek.chyby.push(`soubor ${url}: ${v.chyba}`);
      this.media.set(klic, null);
      return null;
    }
    this.vysledek.souboru++;
    const r = { url: urlSouboru(v.soubor), id: v.soubor.id, obrazek: v.soubor.mime.startsWith('image/') };
    this.media.set(klic, r);
    return r;
  }

  /** přepíše HTML ze starého webu: média stáhne, vlastní odkazy udělá relativní, vyčistí a sanitizuje */
  async prepisHtml(html: string, titulek: string): Promise<{ html: string; prilohy: string[] }> {
    const prilohy: string[] = [];
    // videa (YouTube/Vimeo, <video>, [video], [embed]) → zástupná značka, z níž se po sanitizaci stane video
    const { html: bezVidei, videa } = najdiVidea(html, this.zdroj.zaklad);
    let h = bezVidei
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<(script|style|noscript|iframe|form)[\s\S]*?<\/\1>/gi, '')
      .replace(/\[\/?(su_|cmplz|contact-form|gallery|embed|caption|vc_|et_pb)[^\]]*\]/gi, '');
    // obrázky
    const imgs = [...h.matchAll(/<img\b[^>]*>/gi)];
    for (const m of imgs) {
      const tag = m[0];
      const src = atribut(tag, 'src') ?? atribut(tag, 'data-src');
      const alt = (atribut(tag, 'alt') ?? '').trim();
      let nove = '';
      if (src) {
        const abs = absolutni(src, this.zdroj.zaklad);
        const u = abs ? new URL(abs) : null;
        if (u && this.jeNas(u)) {
          const nazev = decodeURIComponent(u.pathname.split('/').pop() ?? '');
          // popis jen ze zdroje, nic se nevymýšlí: prázdný alt = „chybí popis“ (redaktor doplní ve správě)
          const popis = altZeZdroje(alt, nazev);
          // WordPress vkládá zmenšeniny (-150x150.jpg) — zkusit nejdřív originál, zmenší se u nás
          const original = abs!.replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '$1');
          const r =
            (original !== abs ? await this.soubor(original, 'obrazek', popis) : null) ??
            (await this.soubor(abs!, 'obrazek', popis));
          if (r) nove = `<img src="${r.url}" alt="${esc(popis)}">`;
        } else if (u) {
          // cizí obrázky (widgety, bannery) — obecní web nesmí načítat obsah z cizích serverů
          nove = '';
        }
      }
      h = h.replace(tag, nove);
    }
    // odkazy
    const odkazy = [...h.matchAll(/<a\b[^>]*>/gi)];
    for (const m of odkazy) {
      const tag = m[0];
      const href = atribut(tag, 'href');
      if (!href || /^(mailto|tel):/i.test(href) || href.startsWith('#')) continue;
      const abs = absolutni(href, this.zdroj.zaklad);
      if (!abs) continue;
      const u = new URL(abs);
      if (!this.jeNas(u)) {
        h = h.replace(tag, `<a href="${esc(abs)}">`);
        continue;
      }
      const jmeno = jmenoSouboru(abs);
      let nova = this.cesta(abs);
      if (
        DOKUMENTY.test(jmeno) ||
        OBRAZKY.test(jmeno) ||
        /\/wp-content\/uploads\/|\/e_download\.php|\/data\/(editor|uredni_deska)\//.test(u.pathname)
      ) {
        const r = await this.soubor(abs, OBRAZKY.test(jmeno) ? 'obrazek' : 'dokument');
        if (r) {
          nova = r.url;
          prilohy.push(r.id);
        } else if (this.v.archiv) nova = '';
      } else if (this.v.archiv && !this.mapa.has(this.cesta(abs).toLowerCase())) nova = '';
      if (!nova) {
        // archiv: odkaz na stránku, která na novém webu není (nebo nedostupný soubor) → jen text
        h = h.replace(new RegExp(`${escRe(tag)}([\\s\\S]*?)</a>`, 'i'), '$1');
        continue;
      }
      h = h.replace(tag, `<a href="${esc(nova)}">`);
    }
    // odkaz kolem obrázku vedoucí na „stránku přílohy“ starého webu → rovnou na plnou fotku
    h = h.replace(/<a href="(?!\/soubory\/)[^"]*">(\s*<img src="(\/soubory\/[^"]+)")/g, '<a href="$2">$1');
    let cisty = srovnejNadpisy(sanitizuj(h));
    // WordPress vkládá k souboru ještě tlačítko „Stáhnout“ se stejným odkazem — duplicitu vynecháme
    cisty = cisty.replace(/<a href="([^"]+)">\s*Stáhnout\s*<\/a>/g, (cele, url: string, i: number) =>
      cisty.slice(0, i).includes(`href="${url}"`) ? '' : cele,
    );
    // galerie starého webu (řada obrázků s odkazem na plnou velikost) → mřížka náhledů v <figure class>
    cisty = cisty.replace(
      // (WordPress mezi řádky galerie vkládá <br>, ty k mřížce nepatří)
      /(?:\s*(?:<br \/>\s*)*<a href="(\/soubory\/[^"?]+)"><img src="\1"( alt="[^"]*")? \/><\/a>){2,}/g,
      (rada) =>
        '<figure class="galerie">' +
        rada
          .trim()
          .replace(/<br \/>/g, '')
          .replace(/<img src="(\/soubory\/[^"?]+)"/g, '<img src="$1?v=nahled"')
          .replace(/\s+(?=<a )/g, '') +
        '</figure>',
    );
    for (const [i, v] of videa.entries()) {
      const znacka = await this.video(v, titulek);
      cisty = cisty.replace(
        new RegExp(`(<p>)?\\s*${ZNACKA_VIDEA(i).replace(/[[\]]/g, '\\$&')}\\s*(</p>)?`),
        () => znacka,
      );
    }
    // značky videí se dosazují až po sanitizaci → výsledek ještě jednou projde sanitizací
    return { html: sanitizuj(cisty.replace(/<p>\s*<\/p>/g, '')), prilohy: [...new Set(prilohy)] };
  }

  /**
   * Video z obsahu starého webu → video v knihovně videí webu (zveřejněné, ne na titulce) a jeho značka do textu.
   * Stejné video (YouTube id, původní adresa souboru) se zakládá jen jednou. Video na cizím serveru nebo
   * nedostupný soubor zůstane jen odkazem.
   */
  async video(v: ImportVideo, titulek: string): Promise<string> {
    const videa = (this.s.videa ??= new VideaSluzba(this.s.db, this.s.soubory));
    const odkaz = (url: string, text: string) => `<p><a href="${esc(url)}">${esc(text)}</a></p>`;
    if (v.zdroj === 'youtube' || v.zdroj === 'vimeo') {
      let zaznam = await videa.podleExterniho(v.zdroj, v.id!);
      if (!zaznam) {
        const nahled = await videa.stahniNahled(v.zdroj, v.id!, v.nazev ?? '', null);
        const id = await videa.zaloz(
          {
            nazev: (v.nazev || nahled.nazev || titulek).slice(0, 200),
            popis: '',
            prepis: '',
            na_titulce: false,
            zdroj: v.zdroj,
            externi_id: v.id!,
            plakat_id: nahled.plakat?.id ?? null,
            stav: 'zverejneno',
          },
          null,
          odkazNaSluzbu(v.zdroj, v.id!),
        );
        zaznam = (await videa.podleId(id))!;
        this.vysledek.videa++;
        this.log(`video: ${zaznam.nazev}`);
      }
      return znackaVidea(zaznam, odkazNaSluzbu(v.zdroj, v.id!));
    }
    const url = v.url!;
    let u: URL;
    try {
      u = new URL(url, this.zdroj.zaklad);
    } catch {
      return '';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!this.jeNas(u)) return odkaz(u.href, v.nazev || `Video: ${titulek}`);
    const soubor = await this.soubor(u.href, 'video');
    if (!soubor) return odkaz(u.href, v.nazev || `Video: ${titulek}`);
    let zaznam = await videa.podleSouboru(soubor.id);
    if (!zaznam) {
      const plakat = v.plakatUrl ? await this.soubor(v.plakatUrl, 'obrazek', v.nazev || titulek) : null;
      const id = await videa.zaloz(
        {
          nazev: (v.nazev || titulek).slice(0, 200),
          popis: '',
          prepis: '',
          na_titulce: false,
          zdroj: 'soubor',
          soubor_id: soubor.id,
          plakat_id: plakat?.obrazek ? plakat.id : null,
          stav: 'zverejneno',
        },
        null,
        u.href,
      );
      zaznam = (await videa.podleId(id))!;
      this.vysledek.videa++;
      this.log(`video: ${zaznam.nazev}`);
    }
    return znackaVidea(zaznam, soubor.url);
  }

  private async uzImportovano(tabulka: 'web_obsah' | 'ud_dokumenty', url: string) {
    const r = await this.s.db
      .selectFrom(tabulka)
      .select('id')
      .where('puvodni_url', '=', url)
      .executeTakeFirst();
    return r?.id ?? null;
  }

  private async mapuj(stara: string, nova: string) {
    this.mapa.set(this.cesta(stara).toLowerCase(), nova);
    await this.s.presmerovani.pridej(this.cesta(stara), nova);
    this.vysledek.presmerovani++;
  }

  // ---------------- jednotlivé části ----------------

  async importujStranky() {
    const vse: ImportStranka[] = [];
    for await (const st of this.zdroj.stranky()) vse.push(st);
    const idPodleKlice = new Map<string, string>();
    for (const st of vse) {
      const existujici = await this.uzImportovano('web_obsah', st.url);
      if (existujici && !this.v.prepsat) {
        idPodleKlice.set(st.klic, existujici);
        this.vysledek.preskoceno++;
        continue;
      }
      const { html } = await this.prepisHtml(st.html, st.titulek);
      if (existujici) {
        await this.s.db
          .updateTable('web_obsah')
          .set({ obsah_html: html, upraveno_at: new Date() })
          .where('id', '=', existujici)
          .execute();
        idPodleKlice.set(st.klic, existujici);
        this.vysledek.stranky++;
        continue;
      }
      const id = await this.s.obsah.uloz(
        null,
        'stranka',
        {
          ...PRAZDNA_POLE,
          titulek: st.titulek.slice(0, 250),
          perex: (st.perex ?? '').slice(0, 600),
          obsah_html: html,
          v_menu: false,
        },
        'zverejnit',
        null,
        null,
        { zdroj: 'import', puvodniUrl: st.url, zverejnenoAt: st.datum ?? null },
      );
      idPodleKlice.set(st.klic, id);
      this.vysledek.stranky++;
      this.log(`stránka: ${st.titulek}`);
    }
    // strom podle zdroje (max. 2 úrovně: hlubší stránky se připojí pod nejvyššího předka)
    const podleKlice = new Map(vse.map((x) => [x.klic, x]));
    const koren = (st: ImportStranka): ImportStranka => {
      let a = st;
      for (let i = 0; i < 10 && a.rodic && podleKlice.has(a.rodic); i++) a = podleKlice.get(a.rodic)!;
      return a;
    };
    for (const st of vse) {
      const id = idPodleKlice.get(st.klic)!;
      const k = koren(st);
      const nadrazena = k.klic !== st.klic ? idPodleKlice.get(k.klic)! : null;
      await this.s.db
        .updateTable('web_obsah')
        .set({ nadrazena_id: nadrazena, poradi: st.poradi ?? 0 })
        .where('id', '=', id)
        .execute();
    }
    // přesměrování až po sestavení stromu (adresa podstránky obsahuje rodiče)
    for (const st of vse) {
      const o = await this.s.obsah.podleId(idPodleKlice.get(st.klic)!);
      if (o) await this.mapuj(st.url, await this.s.obsah.url(o));
    }
    this.s.obsah.zmena();
    return idPodleKlice;
  }

  /**
   * už je na webu (nebo ve známém seznamu) aktualita s podobným titulkem a datem ±3 dny? Stejný den a stejný
   * začátek textu se počítá taky (jiná verze téže zprávy s jinak odvozeným titulkem).
   */
  async duplicita(titulek: string, datum: Date, html = ''): Promise<string | null> {
    if (!this.zname) {
      const naWebu = await this.s.db
        .selectFrom('web_obsah')
        .select(['titulek', 'datum', 'puvodni_url', 'perex'])
        .where('typ', '=', 'aktualita')
        .where('smazano_at', 'is', null)
        .execute();
      this.zname = [
        ...naWebu
          .filter((o) => o.datum)
          .map((o) => ({
            titulek: o.titulek,
            datum: new Date(o.datum!),
            popis: o.puvodni_url ?? 'web',
            text: o.perex,
          })),
        ...(this.v.znameClanky ?? []).map((z) => ({
          ...z,
          popis: z.zdroj ?? 'známý seznam',
          text: z.text ?? '',
        })),
      ];
    }
    const t = datum.getTime();
    const zacatek = klicTitulku(textZHtml(html).slice(0, 60));
    const shoda = this.zname.find(
      (z) =>
        Math.abs(z.datum.getTime() - t) <= 3 * 86_400_000 &&
        (podobnyTitulek(z.titulek, titulek) ||
          (zacatek.length >= 30 &&
            datumPraha(z.datum) === datumPraha(datum) &&
            klicTitulku(z.text.slice(0, 60)) === zacatek)),
    );
    return shoda ? `${shoda.titulek} (${datumPraha(shoda.datum)}, ${shoda.popis})` : null;
  }

  async importujAktuality() {
    const kategorie = new Map(
      (await this.s.db.selectFrom('web_kategorie').select(['id', 'slug']).execute()).map((k) => [
        k.slug,
        k.id,
      ]),
    );
    for await (const a of this.zdroj.aktuality(this.v.aktualityOd)) {
      const existujici = await this.uzImportovano('web_obsah', a.url);
      if (existujici && !this.v.prepsat) {
        this.vysledek.preskoceno++;
        continue;
      }
      const dup =
        !existujici && this.v.kontrolaDuplicit ? await this.duplicita(a.titulek, a.datum, a.html) : null;
      if (dup) {
        this.vysledek.duplicity.push(`${a.titulek} (${datumPraha(a.datum)}) = ${dup}`);
        this.vysledek.preskoceno++;
        continue;
      }
      const { html } = await this.prepisHtml(a.html, a.titulek);
      if (existujici) {
        await this.s.db
          .updateTable('web_obsah')
          .set({ obsah_html: html, upraveno_at: new Date() })
          .where('id', '=', existujici)
          .execute();
        this.vysledek.aktuality++;
        continue;
      }
      let obrazekId: string | null = null;
      if (a.obrazekUrl) {
        const nazev = decodeURIComponent(new URL(a.obrazekUrl).pathname.split('/').pop() ?? '');
        const r = await this.soubor(a.obrazekUrl, 'obrazek', altZeZdroje(a.obrazekAlt, nazev));
        obrazekId = r?.id ?? null;
      }
      const slugKat = a.kategorie ? this.v.kategorieAktualit?.[a.kategorie] : undefined;
      const id = await this.s.obsah.uloz(
        null,
        'aktualita',
        {
          ...PRAZDNA_POLE,
          titulek: a.titulek.slice(0, 250),
          perex: zkrat(a.perex?.trim() || textZHtml(html), 300),
          obsah_html: html,
          obrazek_id: obrazekId,
          kategorie_id: slugKat ? (kategorie.get(slugKat) ?? null) : null,
          datum: a.datum.toISOString(),
        },
        'zverejnit',
        null,
        null,
        { zdroj: 'import', puvodniUrl: a.url, zverejnenoAt: a.datum },
      );
      const o = await this.s.obsah.podleId(id);
      if (o && !this.v.archiv) await this.mapuj(a.url, await this.s.obsah.url(o));
      this.zname?.push({ titulek: a.titulek, datum: a.datum, popis: a.url, text: textZHtml(html) });
      this.vysledek.aktuality++;
      if (this.vysledek.aktuality % 25 === 0) this.log(`aktuality: ${this.vysledek.aktuality}`);
    }
  }

  async importujDesku() {
    if (!this.s.deska || !this.zdroj.deska) return;
    const kategorie = await this.s.deska.kategorie(false);
    const dokumenty = [];
    for await (const d of this.zdroj.deska(this.v.deskaOd)) dokumenty.push(d);
    // od nejstaršího, aby nové rozpočtové dokumenty správně nahradily starší
    dokumenty.sort((a, b) => a.vyvesenoOd.getTime() - b.vyvesenoOd.getTime());
    const letos = new Date().getFullYear();
    for (const d of dokumenty) {
      const existujici = await this.uzImportovano('ud_dokumenty', d.url);
      if (existujici) {
        this.vysledek.preskoceno++;
        continue;
      }
      const kat =
        kategorie.find((k) => k.slug === d.kategorie) ?? kategorie.find((k) => k.slug === 'ostatni')!;
      const { html, prilohy } = await this.prepisHtml(d.html, d.nazev);
      for (const p of d.prilohy ?? []) {
        const r = await this.soubor(p.url, 'dokument', d.nazev);
        if (r) prilohy.push(r.id);
      }
      const od = datumPraha(d.vyvesenoOd);
      const rozpocet = kat.rozpocet ? odhadniRozpocet(d.nazev, d.vyvesenoOd) : null;
      let doo: string | null;
      if (d.sejmutoDo) doo = datumPraha(d.sejmutoDo);
      else if (rozpocet && rozpocet.typ !== 'rozpoctove_opatreni')
        doo = null; // do zveřejnění nového (nahradí ho sám)
      else if (rozpocet) doo = rozpocet.rok >= letos ? null : pridejDny(od, Math.max(kat.vychozi_dni, 15));
      else doo = kat.vychozi_dni > 0 ? pridejDny(od, Math.max(kat.vychozi_dni, kat.min_dni)) : null;
      const popis = zkrat(textZHtml(html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '')), 3000);
      const id = await this.s.deska.uloz(
        null,
        {
          nazev: d.nazev.slice(0, 300),
          kategorieId: kat.id,
          cisloJednaci: d.cisloJednaci ?? '',
          puvodce: '',
          popis,
          od,
          do: doo,
          typRozpoctu: rozpocet?.typ ?? null,
          rok: rozpocet?.rok ?? null,
        },
        null,
        null,
        d.url,
      );
      await this.s.deska.pridejPrilohy(id, [...new Set(prilohy)]);
      await this.mapuj(d.url, `/uredni-deska/${id}`);
      this.vysledek.deska++;
      if (this.vysledek.deska % 50 === 0) this.log(`úřední deska: ${this.vysledek.deska}`);
    }
  }

  /** menu starého webu → strom stránek a odkazů (stránky, které v menu nejsou, zůstanou mimo menu) */
  async importujMenu() {
    if (!this.zdroj.menu) return;
    const menu = await this.zdroj.menu();
    if (!menu.length) return;
    // dřívější import menu: odkazy ze zdroje „import“ smazat (koš) a postavit znovu
    await this.s.db
      .updateTable('web_obsah')
      .set({ smazano_at: new Date() })
      .where('typ', '=', 'odkaz')
      .where('zdroj', '=', 'import')
      .execute();
    // nová adresa pro starou URL — jen pro odkazy na vlastní web (cizí weby zůstávají, jak jsou)
    const adresa = async (url: string | null): Promise<string | null> => {
      if (!url || !this.jeNas(new URL(url, this.zdroj.zaklad))) return null;
      const klic = this.cesta(url).toLowerCase();
      return this.mapa.get(klic) ?? (await this.s.presmerovani.cil(klic));
    };
    const stranka = async (url: string | null) => {
      if (!url) return null;
      const r = await this.s.db
        .selectFrom('web_obsah')
        .select(['id', 'typ'])
        .where('puvodni_url', '=', url)
        .where('smazano_at', 'is', null)
        .executeTakeFirst();
      return r?.typ === 'stranka' ? r.id : null;
    };
    const odkaz = async (titulek: string, url: string, nadrazena: string | null, poradi: number) => {
      const id = await this.s.obsah.uloz(
        null,
        'odkaz',
        { ...PRAZDNA_POLE, titulek, odkaz_url: url, nadrazena_id: nadrazena, v_menu: true },
        'zverejnit',
        null,
        null,
        { zdroj: 'import' },
      );
      await this.s.db.updateTable('web_obsah').set({ poradi }).where('id', '=', id).execute();
      this.vysledek.menu++;
    };
    // výchozí menu nové instalace (Aktuality, Úřední deska, Kontakt) nahradí menu starého webu
    await this.s.db
      .updateTable('web_obsah')
      .set({ v_menu: false })
      .where('typ', '=', 'odkaz')
      .where('zdroj', '=', '')
      .execute();
    // vše, co dřív bylo v menu, z menu vyjmout — menu určí jen tento import
    await this.s.db
      .updateTable('web_obsah')
      .set({ v_menu: false })
      .where('zdroj', '=', 'import')
      .where('typ', '=', 'stranka')
      .execute();
    // podnabídka do jedné úrovně (hlubší položky se zařadí za svého předka, položky bez odkazu vypadnou)
    const zplosti = (polozky: ImportMenu[]): ImportMenu[] =>
      polozky.flatMap((p) => [
        ...(p.url ? [{ titulek: p.titulek, url: p.url, deti: [] as ImportMenu[] }] : []),
        ...zplosti(p.deti),
      ]);
    const preskocit = (p: ImportMenu) =>
      /^(více|vice|úvod|uvod|home|domů)\b/i.test(p.titulek.trim()) || p.titulek.includes('→');
    let poradi = 100;
    for (const m of menu) {
      if (preskocit(m)) continue;
      poradi += 10;
      const titulek = hezkyTitulek(m.titulek);
      const deti = zplosti(m.deti).filter((d) => !preskocit(d));
      const strankaMenu = await stranka(m.url);
      let rodic: string | null = deti.length ? null : strankaMenu;
      if (deti.length) {
        // položka s podnabídkou → rozcestník (stránka s dlaždicemi podstránek), titulek z menu
        const klic = `menu:${titulek}`;
        rodic =
          (
            await this.s.db
              .selectFrom('web_obsah')
              .select('id')
              .where('puvodni_url', '=', klic)
              .where('smazano_at', 'is', null)
              .executeTakeFirst()
          )?.id ??
          (await this.s.obsah.uloz(
            null,
            'stranka',
            { ...PRAZDNA_POLE, titulek, v_menu: true },
            'zverejnit',
            null,
            null,
            { zdroj: 'import', puvodniUrl: klic },
          ));
        // stará adresa položky (např. stránka kategorie) → rozcestník, jen když nemá lepší cíl
        if (m.url && !strankaMenu && !(await adresa(m.url)))
          await this.mapuj(m.url, await this.s.obsah.url((await this.s.obsah.podleId(rodic))!));
      }
      if (rodic) {
        await this.s.db
          .updateTable('web_obsah')
          .set({ nadrazena_id: null, v_menu: true, poradi })
          .where('id', '=', rodic)
          .execute();
      } else if (m.url) {
        await odkaz(
          titulek,
          (await adresa(m.url)) ?? (this.jeNas(new URL(m.url)) ? this.cesta(m.url) : m.url),
          null,
          poradi,
        );
        continue;
      }
      let p2 = 0;
      for (const d of deti) {
        p2 += 10;
        const s = await stranka(d.url);
        if (s && s !== rodic) {
          await this.s.db
            .updateTable('web_obsah')
            .set({ nadrazena_id: rodic, v_menu: true, poradi: p2 })
            .where('id', '=', s)
            .execute();
        } else if (d.url && !s) {
          const cil = (await adresa(d.url)) ?? (this.jeNas(new URL(d.url)) ? this.cesta(d.url) : d.url);
          await odkaz(hezkyTitulek(d.titulek), cil, rodic, p2);
        }
      }
    }
    // podstránky stránky, která se v menu ocitla jako podstránka, by byly 3. úroveň → povýšit pod nejvyššího předka
    await sql`UPDATE web_obsah c SET nadrazena_id = p.nadrazena_id FROM web_obsah p
      WHERE c.nadrazena_id = p.id AND p.nadrazena_id IS NOT NULL`.execute(this.s.db);
    // adresy podstránek se mohly změnit → přesměrování přepočítat
    const importovane = (
      await this.s.db
        .selectFrom('web_obsah')
        .selectAll()
        .where('typ', '=', 'stranka')
        .where('zdroj', '=', 'import')
        .where('puvodni_url', 'is not', null)
        .execute()
    ).filter((o) => !o.puvodni_url!.startsWith('menu:'));
    for (const o of importovane) await this.mapuj(o.puvodni_url!, await this.s.obsah.url(o));
    this.s.obsah.zmena();
  }

  async importujDotace() {
    if (!this.zdroj.dotace) return;
    for (const d of await this.zdroj.dotace()) {
      const existuje = await this.s.db
        .selectFrom('web_dotace')
        .select('id')
        .where('projekt', '=', d.projekt)
        .where('smazano_at', 'is', null)
        .executeTakeFirst();
      if (existuje) {
        this.vysledek.preskoceno++;
        continue;
      }
      const id = await this.s.dotace.uloz(
        null,
        { projekt: d.projekt, poskytovatel: d.poskytovatel ?? '', text: d.text ?? '', odkaz: d.odkaz ?? '' },
        null,
      );
      const loga: string[] = [];
      for (const l of d.loga) {
        const r = await this.soubor(l.url, 'logo', l.alt || d.poskytovatel || d.projekt);
        if (r) loga.push(r.id);
      }
      await this.s.dotace.pridejLoga(id, loga);
      await this.s.dotace.zobrazeni(
        id,
        { od: datumPraha(new Date()), do: null, vPaticce: false, poradi: 100 },
        null,
      );
      this.vysledek.dotace++;
    }
  }

  async spust(): Promise<VysledekImportu> {
    if (this.v.stranky !== false) await this.importujStranky();
    if (this.v.aktuality !== false) await this.importujAktuality();
    if (this.v.deska !== false) await this.importujDesku();
    if (this.zdroj.presmerovani)
      for (const [a, b] of Object.entries(await this.zdroj.presmerovani())) await this.mapuj(a, b);
    if (this.v.menu !== false) await this.importujMenu();
    if (this.v.dotace !== false) await this.importujDotace();
    return this.vysledek;
  }
}

/** jméno souboru z URL: parametr original= (Galileo e_download.php), jinak poslední část cesty */
export function jmenoSouboru(url: string): string {
  try {
    const u = new URL(url);
    const p = u.searchParams.get('original') ?? u.searchParams.get('filename') ?? u.searchParams.get('name');
    return decodeURIComponent(p || u.pathname.split('/').pop() || 'soubor');
  } catch {
    return 'soubor';
  }
}

function atribut(tag: string, nazev: string): string | null {
  const m = new RegExp(`\\s${nazev}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return dekoduj(m[2] ?? m[3] ?? m[4] ?? '');
}

function dekoduj(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function absolutni(url: string, zaklad: string): string | null {
  try {
    const u = new URL(url, zaklad);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
