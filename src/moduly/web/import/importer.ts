// Společný importér: z obsahu, který vrátí adaptér (WordPress, Galileo…), založí stránky, aktuality, úřední desku,
// dotace a menu; média stáhne a přeuloží (obrázky bez EXIF, kontrola typu), odkazy přepíše a pro staré adresy
// založí přesměrování 301. Je idempotentní: co už bylo importováno (podle původní URL), přeskočí.
// Stav běhu a sdílené operace jsou v kontext.ts, média v media.ts, přepis HTML v prepis-html.ts, jednotlivé
// části v sekce/*.ts.
import { ImportKontext, type VysledekImportu } from './kontext.js';
import { duplicita, importujAktuality } from './sekce/aktuality.js';
import { importujDesku } from './sekce/deska.js';
import { importujDotace } from './sekce/dotace.js';
import { importujMenu } from './sekce/menu.js';
import { importujStranky } from './sekce/stranky.js';

export type { Sluzby, VolbyImportu, VysledekImportu } from './kontext.js';
export { hezkyTitulek, jmenoSouboru, klicTitulku, odhadniRozpocet, podobnyTitulek } from './pomucky.js';

export class Importer extends ImportKontext {
  importujStranky() {
    return importujStranky(this);
  }

  /**
   * už je na webu (nebo ve známém seznamu) aktualita s podobným titulkem a datem ±3 dny? Stejný den a stejný
   * začátek textu se počítá taky (jiná verze téže zprávy s jinak odvozeným titulkem).
   */
  duplicita(titulek: string, datum: Date, html = ''): Promise<string | null> {
    return duplicita(this, titulek, datum, html);
  }

  importujAktuality() {
    return importujAktuality(this);
  }

  importujDesku() {
    return importujDesku(this);
  }

  /** menu starého webu → strom stránek a odkazů (viz sekce/menu.ts) */
  importujMenu() {
    return importujMenu(this);
  }

  importujDotace() {
    return importujDotace(this);
  }

  async spust(): Promise<VysledekImportu> {
    // každá část zvlášť: když selže zdroj (např. výpis aktualit), ostatní části se dokončí
    const cast = async (nazev: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        this.chyba(nazev, e);
      }
    };
    if (this.v.stranky !== false) await cast('stránky', () => this.importujStranky());
    if (this.v.aktuality !== false) await cast('aktuality', () => this.importujAktuality());
    if (this.v.deska !== false) await cast('úřední deska', () => this.importujDesku());
    if (this.zdroj.presmerovani)
      await cast('přesměrování', async () => {
        for (const [a, b] of Object.entries(await this.zdroj.presmerovani!()))
          await this.mapuj(a, b).catch((e) => this.chyba(`přesměrování ${a}`, e));
      });
    if (this.v.menu !== false) await cast('menu', () => this.importujMenu());
    if (this.v.dotace !== false) await cast('dotace', () => this.importujDotace());
    return this.vysledek;
  }
}
