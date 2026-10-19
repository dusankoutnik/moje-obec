// Adaptér Galileo (GCM, dodavatel Galileo Corporation) — nejrozšířenější CMS obecních webů (~37–39 % obcí, viz
// docs/pruzkum/CMS-OBCI-2026-10.md). API nemá, čte se veřejné HTML (zdvořile, přes Stahovac):
//   menu:      <nav id="menu"> s vnořenými <ul class="nav"> (+ boční #submenu u každé sekce)
//   stránka:   <div class="gcm-main"><h1>…</h1><div class="editor_content …">obsah</div>
//   aktuality: seznam …/aktuality/?page=all, položky a.event-link s „Datum: d. m. rrrr“; detail = stránka
//   deska:     …/uredni-deska/?show=0 (aktuální) a ?show=1 (archiv), karty kategorií (h2) s položkami
//              „Vyvěšeno: …“ / „Datum sejmutí: …“; detail obsahuje přílohy a.file → /e_download.php?…&original=
// Vyzkoušeno read-only na webu jedné obce (10/2026); jiné šablony Galilea se mohou lišit v detailech.
import { casPraha, konecDne } from '../../../lib/datum.js';
import { slugify } from '../../../lib/slug.js';
import { dekodujEntity, parsujMenu, textTagu } from './html-pomoc.js';
import type {
  ImportClanek,
  ImportDokument,
  ImportMenu,
  ImportniZdroj,
  ImportStranka,
  Stahovac,
} from './typy.js';
import { kategorieDesky } from './wordpress.js';

export interface VolbyGalilea {
  zaklad: string;
  stahovac: Stahovac;
  /** nejvýš kolik stálých stránek projít (ochrana před nekonečným procházením) */
  maxStranek?: number;
}

/** vnitřek elementu <div …> začínajícího na indexu `od` (vyvážené div) */
export function vnitrekDivu(html: string, od: number): string {
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = od;
  let hloubka = 0;
  let zacatek = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!m[1]) {
      if (hloubka === 0) zacatek = m.index + m[0].length;
      hloubka++;
    } else if (--hloubka === 0) return html.slice(zacatek, m.index);
  }
  return zacatek >= 0 ? html.slice(zacatek) : '';
}

/** „2. 1. 2026“ → 'YYYY-MM-DD' */
export function ceskeDatum(s: string): string | null {
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

export function obsahStranky(html: string): { titulek: string; html: string } {
  const main = html.indexOf('<div class="gcm-main">');
  const usek = main >= 0 ? html.slice(main) : html;
  const titulek = textTagu(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(usek)?.[1] ?? '');
  const ed = /<div class="[^"]*\beditor_content\b[^"]*"/i.exec(usek);
  const desk = /<div class="[^"]*\bofficial-desk-detail\b[^"]*"/i.exec(usek);
  const blok = desk ?? ed;
  let obsah = blok ? vnitrekDivu(usek, blok.index) : '';
  // stránky, kde je obsah v modulu (kontakty, seznamy dokumentů…), nemají editor_content — vezmeme celý hlavní blok
  if (!textTagu(obsah) && main >= 0) {
    obsah = vnitrekDivu(usek, 0)
      .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<div class="pagination[\s\S]*?<\/div>\s*<\/div>/gi, '');
  }
  // pryč s poznámkami Galilea „Typ: PDF dokument, Velikost …“ a pomocnými prvky
  obsah = obsah
    .replace(/<i>\s*Typ:[^<]*<\/i>/gi, '')
    .replace(/<div class="(cleaner|text-right info)"[\s\S]*?<\/div>/gi, '')
    .replace(/<h2 class="d-none"[\s\S]*?<\/h2>/gi, '');
  return { titulek, html: obsah };
}

export class GalileoZdroj implements ImportniZdroj {
  readonly nazev = 'Galileo';
  readonly zaklad: string;
  private menuCache: ImportMenu[] | null = null;
  private seznamy = { aktuality: [] as string[], deska: [] as string[] };

  constructor(private v: VolbyGalilea) {
    this.zaklad = v.zaklad.replace(/\/$/, '');
  }

  private abs(u: string) {
    return new URL(dekodujEntity(u), this.zaklad + '/').href;
  }
  private jeNas(u: string) {
    try {
      return new URL(u).host.replace(/^www\./, '') === new URL(this.zaklad).host.replace(/^www\./, '');
    } catch {
      return false;
    }
  }
  /** moduly, které nejsou stálou stránkou (seznamy, kalendáře, galerie, hledání) */
  private druh(url: string): 'aktuality' | 'deska' | 'modul' | 'stranka' | 'cizi' {
    if (!this.jeNas(url)) return 'cizi';
    const p = new URL(url).pathname;
    if (/\/uredni-deska\/?$/.test(p)) return 'deska';
    if (/\/(aktuality|zpravy|novinky)\/?$/.test(p)) return 'aktuality';
    if (
      /\.(html|php)$|\/(akce|kalendar|fotogalerie|galerie|mapa-webu|hledej|archiv)\b/i.test(p) ||
      new URL(url).search
    )
      return 'modul';
    return 'stranka';
  }

  async menu(): Promise<ImportMenu[]> {
    if (this.menuCache) return this.menuCache;
    const html = await this.v.stahovac.text(this.zaklad + '/');
    const i = html.search(/<nav id="menu"/i);
    this.menuCache = parsujMenu(i >= 0 ? html.slice(i) : html, /\bnav\b/, this.zaklad);
    return this.menuCache;
  }

  async *stranky(): AsyncIterable<ImportStranka> {
    const fronta: { url: string; rodic: string | null; poradi: number }[] = [];
    const videno = new Set<string>();
    let poradi = 0;
    const pridej = (url: string | null, rodic: string | null) => {
      if (!url) return;
      const u = url.split('#')[0]!;
      const d = this.druh(u);
      if (d === 'aktuality') this.seznamy.aktuality.push(u);
      if (d === 'deska') this.seznamy.deska.push(u);
      if (d !== 'stranka' || videno.has(u)) return;
      videno.add(u);
      fronta.push({ url: u, rodic, poradi: (poradi += 10) });
    };
    for (const m of await this.menu()) {
      pridej(m.url, null);
      for (const d of m.deti) pridej(d.url, m.url);
    }
    const max = this.v.maxStranek ?? 300;
    for (let i = 0; i < fronta.length && i < max; i++) {
      const { url, rodic, poradi: p } = fronta[i]!;
      let html: string;
      try {
        html = await this.v.stahovac.text(url);
      } catch {
        continue;
      }
      const { titulek, html: obsah } = obsahStranky(html);
      // boční podmenu sekce — další stránky (jen jedna úroveň pod nalezenou stránkou)
      const sub = html.search(/<nav id="submenu"/i);
      if (sub >= 0)
        for (const pm of parsujMenu(html.slice(sub), /./, this.zaklad)) pridej(pm.url, rodic ?? url);
      if (!titulek) continue;
      yield { klic: url, url, titulek, html: obsah, rodic: rodic && rodic !== url ? rodic : null, poradi: p };
    }
  }

  async *aktuality(od: Date): AsyncIterable<ImportClanek> {
    if (!this.menuCache) await this.menu();
    const seznamy = [
      ...new Set(
        this.seznamy.aktuality.length ? this.seznamy.aktuality : [`${this.zaklad}/zivot-v-obci/aktuality/`],
      ),
    ];
    for (const s of seznamy) {
      const html = await this.v.stahovac.text(`${s.replace(/\/?$/, '/')}?page=all`).catch(() => '');
      for (const m of html.matchAll(/<a href="([^"]+)" class="event-link">([\s\S]*?)<\/a>/gi)) {
        const datum = ceskeDatum(/event-date">\s*([\d. ]+)</.exec(m[2]!)?.[1] ?? '');
        const kdy = datum ? casPraha(datum, 12) : null;
        if (!kdy || kdy < od) continue;
        const url = this.abs(m[1]!);
        const detail = await this.v.stahovac.text(url).catch(() => '');
        if (!detail) continue;
        const { titulek, html: obsah } = obsahStranky(detail);
        const obrazek = /<img src="([^"]+)"[^>]*class="event-imgage/i.exec(m[2]!)?.[1];
        yield {
          url,
          titulek: titulek || textTagu(/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(m[2]!)?.[1] ?? ''),
          html: obsah,
          perex: textTagu(/<p class="event-perex">([\s\S]*?)<\/p>/i.exec(m[2]!)?.[1] ?? ''),
          datum: kdy,
          kategorie: 'aktuality',
          obrazekUrl: obrazek ? this.abs(obrazek) : null,
        };
      }
    }
  }

  async *deska(od?: Date): AsyncIterable<ImportDokument> {
    if (!this.menuCache) await this.menu();
    const seznamy = [
      ...new Set(this.seznamy.deska.length ? this.seznamy.deska : [`${this.zaklad}/urad/uredni-deska/`]),
    ];
    const videno = new Set<string>();
    for (const s of seznamy) {
      for (const show of [0, 1]) {
        const html = await this.v.stahovac.text(`${s.replace(/\/?$/, '/')}?show=${show}`).catch(() => '');
        // karty kategorií: <div class="category card …"><h2>název</h2> … položky
        const karty = html.split(/<div class="category card/i).slice(1);
        for (const karta of karty) {
          const kategorie = textTagu(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(karta)?.[1] ?? '');
          for (const m of karta.matchAll(/<div class="item">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
            const odkaz = /<a class="item-href" href="([^"]+)">([\s\S]*?)<\/a>/i.exec(m[1]!);
            if (!odkaz) continue;
            const url = this.abs(odkaz[1]!.replace(/\?kshow=\d+$/, '').replace(/&amp;kshow=\d+/, ''));
            if (videno.has(url)) continue;
            videno.add(url);
            const vyveseno = ceskeDatum(/item-date-from">[^<]*?([\d. ]+\d{4})/.exec(m[1]!)?.[1] ?? '');
            const sejmuti = ceskeDatum(/item-date-to">[^<]*?([\d. ]+\d{4})/.exec(m[1]!)?.[1] ?? '');
            const kdy = vyveseno ? casPraha(vyveseno, 0) : null;
            if (!kdy || (od && kdy < od)) continue;
            const nazev = textTagu(odkaz[2]!);
            const detail = await this.v.stahovac.text(url).catch(() => '');
            yield {
              url,
              nazev,
              html: detail ? obsahStranky(detail).html : '',
              vyvesenoOd: kdy,
              sejmutoDo: sejmuti ? konecDne(sejmuti) : null,
              kategorie: kategorieDesky(nazev, [slugify(kategorie)]),
            };
          }
        }
      }
    }
  }

  async presmerovani(): Promise<Record<string, string>> {
    if (!this.menuCache) await this.menu();
    const out: Record<string, string> = {};
    for (const s of this.seznamy.deska) out[s] = '/uredni-deska';
    for (const s of this.seznamy.aktuality) out[s] = '/aktuality';
    // moduly bez obdoby v importu: kalendář akcí a fotogalerie → odpovídající stránky platformy
    const vse = (await this.menu()).flatMap((m) => [m, ...m.deti]);
    for (const m of vse) {
      if (!m.url || !this.jeNas(m.url)) continue;
      const p = new URL(m.url).pathname;
      if (/\/(akce|kalendar)[^/]*\/?$/.test(p)) out[m.url] = '/akce';
      if (/\/(fotogalerie|galerie)[^/]*\/?$/.test(p)) out[m.url] = '/galerie';
    }
    return out;
  }
}
