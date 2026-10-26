// Automatické výstrahy infokanálu — převod chování VlastiKanálu (vlastikanal/app/src/vystrahy.js):
//   ČHMÚ: žlutá → jen e-mail správcům (schválení ve správě: Rozeslat / Zahodit), oranžová → rozešle se sama
//         (v noci 22–6 h naplánovaně na 6:30), červená → krizové hlášení všem na všechny kontakty.
//         Klíč „jev|stupeň“; pokračování = stejný klíč s koncem ne starším než 1 h; nižší stupeň během vyššího se
//         neposílá (preskoceno).
//   ČEZ:  nová odstávka → oznámení, den předem 17:00 připomínka, zrušení / změna termínu → další zpráva.
//         Data bere z modulu odstavky (žádné dotazy navíc — API při rychlých dotazech vrací 429).
//   SčVK: plánované odstávky a havárie z HTML seznamů; zrušení/ukončení = zmizení ze seznamu A 404 detailu.
// Cílení ČEZ/SčVK: odběratelé z dotčených částí obce + ti, kdo část nevyplnili. O každém automatickém rozeslání
// jde správcům e-mail; zdroj nefunkční > 24 h → jedno upozornění (do dalšího úspěchu).
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../../db/index.js';
import type { Vystraha, ZdrojVystrahy } from '../../../db/types.js';
import { zapisAudit } from '../../../lib/audit.js';
import type { MailPoskytovatel } from '../../../lib/mail.js';
import type { Odstavka } from '../../odstavky/cez.js';
import type { OdstavkySluzba } from '../../odstavky/sluzba.js';
import type { InfokanalSluzba } from '../sluzba.js';
import { castiPraha, konecNocnihoKlidu, rozsah, zitra } from './cas.js';
import {
  CHMU_ADRESAR,
  PORADI,
  nejnovejsiSoubor,
  parsujCap,
  type StupenChmu,
  type VystrahaChmu,
} from './chmu.js';
import { SCVK_SEZNAMY, SCVK_WEB, jeNaseObec, parsujDetail, parsujSeznam, type UdalostScvk } from './scvk.js';
import {
  mistaCez,
  textyCez,
  textyChmu,
  textyScvk,
  type DruhZpravy,
  type KontextTextu,
  type TextyHlaseni,
} from './texty.js';

export const NAZEV_ZDROJE: Record<ZdrojVystrahy, string> = {
  chmu: 'ČHMÚ',
  cez: 'ČEZ Distribuce',
  scvk: 'SčVK',
};
const KATEGORIE: Record<ZdrojVystrahy, string> = { chmu: 'pocasi', cez: 'elektrina', scvk: 'voda' };
const POPIS_ZDROJE: Record<ZdrojVystrahy, string> = {
  chmu: 'výstrah ČHMÚ',
  cez: 'odstávek ČEZ',
  scvk: 'výpadků vody SčVK',
};
/** zdroj bez úspěchu déle než tohle → jedno upozornění správcům */
export const VYPADEK_MS = 24 * 3600_000;
const HODINA = 3600_000;

export interface VystrahyNastaveni extends KontextTextu {
  /** kód ORP pro ČHMÚ; prázdné = ČHMÚ vypnuto */
  chmuOrp: string;
  /** název obce pro SčVK; prázdné = SčVK vypnuto */
  scvkObec: string;
  /** další adresy pro e-maily správcům (vedle rolí admin a spravce) */
  notify: string[];
  userAgent: string;
}

type Detail = Record<string, unknown>;

// ---- (de)serializace zdrojových dat do sloupce detail ----
const naDatum = (v: unknown) => (typeof v === 'string' && v ? new Date(v) : null);
function odstavkaZDetailu(d: Detail): Odstavka {
  return {
    ...(d as unknown as Odstavka),
    od: naDatum(d.od)!,
    do: naDatum(d.do),
    zruseno: naDatum(d.zruseno),
  };
}
function udalostZDetailu(d: Detail): UdalostScvk {
  return { ...(d as unknown as UdalostScvk), od: naDatum(d.od), do: naDatum(d.do) };
}
function chmuZDetailu(d: Detail): VystrahaChmu {
  return { ...(d as unknown as VystrahaChmu), od: naDatum(d.od), do: naDatum(d.do) };
}
const stejnyCas = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export class VystrahySluzba {
  private kategorieId = new Map<string, number>();

  constructor(
    private db: Db,
    private infokanal: InfokanalSluzba,
    private mail: MailPoskytovatel,
    readonly nastaveni: VystrahyNastaveni,
    private log: FastifyBaseLogger,
    /** data odstávek ČEZ (modul odstavky); null = ČEZ vypnuto */
    private odstavky: OdstavkySluzba | null,
    /** po založení hlášení probudit rozesílací frontu */
    private kopni: () => void = () => {},
    /** kvůli testům: vlastní fetch a hodiny */
    public fetchFn: typeof fetch = fetch,
    public hodiny: () => Date = () => new Date(),
  ) {}

  get zapnuteZdroje(): ZdrojVystrahy[] {
    const z: ZdrojVystrahy[] = [];
    if (this.nastaveni.chmuOrp) z.push('chmu');
    if (this.odstavky) z.push('cez');
    if (this.nastaveni.scvkObec) z.push('scvk');
    return z;
  }

  // =====================================================================
  // společné: rozeslání, e-maily správcům, hlídání zdrojů
  // =====================================================================

  private async kategorie(slug: string): Promise<number | null> {
    if (!this.kategorieId.has(slug)) {
      const r = await this.db
        .selectFrom('ik_kategorie')
        .select('id')
        .where('slug', '=', slug)
        .executeTakeFirst();
      if (!r) return null;
      this.kategorieId.set(slug, r.id);
    }
    return this.kategorieId.get(slug)!;
  }

  /** založí hlášení infokanálu (kategorie zdroje, doručuje se jako důležité); vrací id hlášení nebo null */
  private async posli(
    zdroj: ZdrojVystrahy,
    t: Pick<TextyHlaseni, 'smsText' | 'emailPredmet' | 'emailText' | 'casti'>,
    volby: { krizove?: boolean; nocniKlid?: boolean } = {},
  ): Promise<string | null> {
    const kategorieId = volby.krizove
      ? ((await this.kategorie('krizove')) ?? (await this.kategorie(KATEGORIE[zdroj])))
      : await this.kategorie(KATEGORIE[zdroj]);
    if (!kategorieId) {
      this.log.error({ zdroj }, 'výstrahy: chybí kategorie infokanálu');
      return null;
    }
    const r = await this.infokanal.zalozHlaseni(null, {
      kategorieId,
      krizove: !!volby.krizove,
      // dotčené části + odběratelé bez vyplněné části obce
      cil: t.casti.length ? 'casti' : 'vse',
      cilDetail: t.casti.length ? [...t.casti, ''] : [],
      smsText: t.smsText,
      emailPredmet: t.emailPredmet,
      emailText: t.emailText,
      naplanovanoNa: volby.nocniKlid ? konecNocnihoKlidu(this.hodiny()) : null,
      dulezite: true, // „smíšení“ odběratelé dostanou výstrahy SMSkou jako obecná hlášení
      zdrojAutomatu: zdroj,
    });
    if ('chyba' in r) {
      this.log.warn({ zdroj, chyba: r.chyba }, 'výstrahy: hlášení nezaloženo');
      return null;
    }
    this.kopni();
    return r.id;
  }

  /** e-mail správcům (role admin a spravce s e-mailem, neblokovaní) + adresy z VYSTRAHY_NOTIFY */
  async upozorniSpravce(predmet: string, radky: (string | null)[]) {
    const spravci = await this.db
      .selectFrom('uzivatele')
      .select('email')
      .where('email', 'is not', null)
      .where('blokovan_at', 'is', null)
      .where(sql<boolean>`role && ARRAY['admin','spravce','provozovatel']::text[]`)
      .execute();
    const adresy = new Set(
      [...spravci.map((s) => s.email!), ...this.nastaveni.notify]
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    );
    const text = radky.filter((l) => l !== null).join('\n');
    for (const komu of adresy) {
      try {
        await this.mail.posli({ komu, predmet: `[${this.nastaveni.nazevKanalu}] ${predmet}`, text });
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'výstrahy: e-mail správci se nepodařilo odeslat');
      }
    }
  }

  private odkazHlaseni = (id: string | null) =>
    id
      ? `Průběh rozesílání: ${this.nastaveni.baseUrl}/infokanal/sprava/hlaseni/${id}`
      : 'Hlášení nevzniklo — žádný odběratel.';

  private async ohlasRozeslani(
    titulek: string,
    uvod: string | null,
    predmet: string,
    hlaseniId: string | null,
  ) {
    await this.upozorniSpravce(`Automaticky rozesláno: ${titulek}`, [
      uvod,
      uvod ? '' : null,
      predmet,
      '',
      this.odkazHlaseni(hlaseniId),
    ]);
  }

  /** obal pro plánovač: chyby jen zalogovat; zdroj bez úspěchu > 24 h → jedno upozornění správcům */
  async hlidej(zdroj: ZdrojVystrahy, fn: () => Promise<void>): Promise<boolean> {
    const ted = this.hodiny();
    const stav = await this.db
      .selectFrom('ik_vystrahy_zdroje')
      .selectAll()
      .where('zdroj', '=', zdroj)
      .executeTakeFirst();
    const uloz = (hodnoty: Record<string, unknown>) =>
      this.db
        .insertInto('ik_vystrahy_zdroje')
        .values({ zdroj, ...hodnoty })
        .onConflict((oc) => oc.column('zdroj').doUpdateSet(hodnoty))
        .execute();
    try {
      await fn();
      await uloz({
        posledni_ok: ted,
        posledni_pokus: ted,
        posledni_chyba: null,
        chyba_od: null,
        alarm_at: null,
      });
      return true;
    } catch (e) {
      const zprava = (e as Error).message;
      this.log.warn({ zdroj, err: zprava }, 'výstrahy: zdroj selhal');
      const od = stav?.chyba_od ?? ted;
      const alarm = !stav?.alarm_at && ted.getTime() - new Date(od).getTime() > VYPADEK_MS;
      await uloz({
        posledni_pokus: ted,
        posledni_chyba: zprava.slice(0, 500),
        chyba_od: od,
        ...(alarm ? { alarm_at: ted } : {}),
      });
      if (alarm)
        await this.upozorniSpravce(`Zdroj ${POPIS_ZDROJE[zdroj]} nefunguje`, [
          `${this.nastaveni.nazevKanalu} se už přes 24 hodin nedostal k datům (${NAZEV_ZDROJE[zdroj]}). Poslední chyba: ${zprava}`,
          'Automatické zprávy z tohoto zdroje do opravy nechodí.',
        ]);
      return false;
    }
  }

  private async stahni(url: string, accept = 'text/html'): Promise<Response> {
    return this.fetchFn(url, {
      headers: { 'user-agent': this.nastaveni.userAgent, accept },
      signal: AbortSignal.timeout(20_000),
    });
  }

  private async zaloz(r: {
    zdroj: ZdrojVystrahy;
    externiId: string;
    stupen?: string | null;
    titulek: string;
    od: Date | null;
    do: Date | null;
    t: Pick<TextyHlaseni, 'smsText' | 'emailPredmet' | 'emailText'>;
    detail: unknown;
    stav: Vystraha['stav'];
  }): Promise<Vystraha> {
    return this.db
      .insertInto('ik_vystrahy')
      .values({
        zdroj: r.zdroj,
        externi_id: r.externiId,
        stupen: r.stupen ?? null,
        titulek: r.titulek,
        plati_od: r.od,
        plati_do: r.do,
        sms_text: r.t.smsText,
        email_predmet: r.t.emailPredmet,
        email_text: r.t.emailText,
        detail: JSON.stringify(r.detail),
        stav: r.stav,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private nastavHlaseni(id: number, hlaseniId: string | null) {
    return this.db.updateTable('ik_vystrahy').set({ hlaseni_id: hlaseniId }).where('id', '=', id).execute();
  }

  // =====================================================================
  // ČHMÚ
  // =====================================================================

  zkontrolujChmu() {
    return this.hlidej('chmu', () => this.chmu());
  }

  private async chmu() {
    const r = await this.stahni(CHMU_ADRESAR);
    if (!r.ok) throw new Error(`ČHMÚ výpis HTTP ${r.status}`);
    const soubor = nejnovejsiSoubor(await r.text());
    if (!soubor) throw new Error('ve výpisu ČHMÚ není žádný soubor alert_cap_50');
    const stav = await this.db
      .selectFrom('ik_vystrahy_zdroje')
      .select('razitko')
      .where('zdroj', '=', 'chmu')
      .executeTakeFirst();
    if (stav?.razitko === soubor.razitko) return;
    const x = await this.stahni(CHMU_ADRESAR + soubor.nazev, 'application/xml');
    if (!x.ok) throw new Error(`ČHMÚ ${soubor.nazev} HTTP ${x.status}`);
    const xml = await x.text();
    if (!/<alert\b/.test(xml)) throw new Error(`ČHMÚ ${soubor.nazev}: není to CAP`);
    for (const w of parsujCap(xml, this.nastaveni.chmuOrp, this.hodiny())) await this.vystrahaChmu(w);
    await this.db
      .insertInto('ik_vystrahy_zdroje')
      .values({ zdroj: 'chmu', razitko: soubor.razitko })
      .onConflict((oc) => oc.column('zdroj').doUpdateSet({ razitko: soubor.razitko }))
      .execute();
  }

  /** jedna výstraha z CAP (veřejné kvůli testům) */
  async vystrahaChmu(w: VystrahaChmu) {
    const ted = this.hodiny();
    const klic = `${w.jev}|${w.stupen}`;
    // stejná výstraha (jev + stupeň), která ještě běží nebo skončila před méně než hodinou = pokračování
    const bezi = await this.db
      .selectFrom('ik_vystrahy')
      .selectAll()
      .where('zdroj', '=', 'chmu')
      .where('externi_id', '=', klic)
      .where((eb) =>
        eb.or([eb('plati_do', 'is', null), eb('plati_do', '>', new Date(ted.getTime() - HODINA))]),
      )
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (bezi) {
      if (!stejnyCas(bezi.plati_do, w.do))
        await this.db.updateTable('ik_vystrahy').set({ plati_do: w.do }).where('id', '=', bezi.id).execute();
      return;
    }
    // po vyšším stupni téhož jevu už nižší neposíláme (zmírnění není zpráva pro lidi)
    const aktivni = await this.db
      .selectFrom('ik_vystrahy')
      .select(['externi_id', 'stupen'])
      .where('zdroj', '=', 'chmu')
      .where('stav', '!=', 'zahozeno')
      .where((eb) => eb.or([eb('plati_do', 'is', null), eb('plati_do', '>', ted)]))
      .execute();
    const vyssi = aktivni.some(
      (r) => r.externi_id.startsWith(`${w.jev}|`) && (PORADI[r.stupen as StupenChmu] ?? 0) > PORADI[w.stupen],
    );
    const t = textyChmu(w, this.nastaveni);
    const v = await this.zaloz({
      zdroj: 'chmu',
      externiId: klic,
      stupen: w.stupen,
      titulek: t.titulek,
      od: w.od,
      do: w.do,
      t,
      detail: w,
      stav: vyssi ? 'preskoceno' : w.stupen === 'yellow' ? 'ceka' : 'odeslano',
    });
    if (vyssi) return;
    if (w.stupen === 'yellow') {
      await zapisAudit(this.db, { akce: 'vystraha.ceka', detail: { id: v.id, klic } });
      await this.upozorniSpravce(`Žlutá výstraha ČHMÚ ke schválení: ${w.jev}`, [
        `ČHMÚ vydal žlutou výstrahu pro oblast ${this.nastaveni.oblast}: ${w.jev}, ${rozsah(w.od, w.do)}.`,
        '',
        w.popis || null,
        w.popis ? '' : null,
        'Žluté výstrahy se nerozesílají samy. Rozeslat ji odběratelům, nebo zahodit?',
        `${this.nastaveni.baseUrl}/infokanal/sprava/vystrahy/${v.id}`,
      ]);
      return;
    }
    const cervena = w.stupen === 'red';
    const hlaseniId = await this.posli('chmu', t, { krizove: cervena, nocniKlid: !cervena });
    await this.nastavHlaseni(v.id, hlaseniId);
    await zapisAudit(this.db, { akce: 'vystraha.auto', detail: { id: v.id, klic, hlaseni: hlaseniId } });
    await this.ohlasRozeslani(
      t.titulek,
      `${this.nastaveni.nazevKanalu} právě rozeslal ${cervena ? 'KRIZOVOU zprávu (červená výstraha)' : 'oranžovou výstrahu'} ČHMÚ:`,
      t.emailPredmet,
      hlaseniId,
    );
  }

  /** ruční rozeslání žluté výstrahy správcem */
  async rozeslat(
    id: number,
    uzivatelId: string,
  ): Promise<{ ok: true; hlaseniId: string } | { chyba: 'vyrizeno' | 'skoncila' | 'nezalozeno' }> {
    const v = await this.db
      .selectFrom('ik_vystrahy')
      .selectAll()
      .where('id', '=', id)
      .where('stav', '=', 'ceka')
      .executeTakeFirst();
    if (!v) return { chyba: 'vyrizeno' };
    if (v.plati_do && v.plati_do < this.hodiny()) return { chyba: 'skoncila' };
    // zabrat atomicky, aby dva správci nerozeslali dvakrát
    const zabrano = await this.db
      .updateTable('ik_vystrahy')
      .set({ stav: 'odeslano', rozhodl_id: uzivatelId, rozhodnuto_at: this.hodiny() })
      .where('id', '=', id)
      .where('stav', '=', 'ceka')
      .executeTakeFirst();
    if (!Number(zabrano.numUpdatedRows)) return { chyba: 'vyrizeno' };
    const hlaseniId = await this.posli(v.zdroj, {
      smsText: v.sms_text,
      emailPredmet: v.email_predmet,
      emailText: v.email_text,
      casti: [],
    } as Pick<TextyHlaseni, 'smsText' | 'emailPredmet' | 'emailText' | 'casti'>);
    if (!hlaseniId) {
      await this.db
        .updateTable('ik_vystrahy')
        .set({ stav: 'ceka', rozhodl_id: null, rozhodnuto_at: null })
        .where('id', '=', id)
        .execute();
      return { chyba: 'nezalozeno' };
    }
    await this.nastavHlaseni(id, hlaseniId);
    await zapisAudit(this.db, { uzivatelId, akce: 'vystraha.rozeslano', detail: { id, hlaseni: hlaseniId } });
    return { ok: true, hlaseniId };
  }

  /** zahození žluté výstrahy — jen stav, nic se nemaže */
  async zahodit(id: number, uzivatelId: string): Promise<boolean> {
    const r = await this.db
      .updateTable('ik_vystrahy')
      .set({ stav: 'zahozeno', rozhodl_id: uzivatelId, rozhodnuto_at: this.hodiny() })
      .where('id', '=', id)
      .where('stav', '=', 'ceka')
      .executeTakeFirst();
    const ok = Number(r.numUpdatedRows) > 0;
    if (ok) await zapisAudit(this.db, { uzivatelId, akce: 'vystraha.zahozeno', detail: { id } });
    return ok;
  }

  // =====================================================================
  // ČEZ — plánované odstávky elektřiny (data z modulu odstavky)
  // =====================================================================

  zkontrolujCez() {
    return this.hlidej('cez', () => this.cez());
  }

  private async cez() {
    if (!this.odstavky) return;
    await this.odstavky.obnov(); // keš modulu odstavky: nejvýš jeden dotaz za hodinu
    const s = await this.odstavky.stav();
    if (s.chyba) throw new Error(s.chyba);
    if (!s.posledniUspech) throw new Error('data odstávek ČEZ zatím nejsou načtená');
    const ted = this.hodiny();
    for (const o of s.aktualni) {
      const v = await this.db
        .selectFrom('ik_vystrahy')
        .selectAll()
        .where('zdroj', '=', 'cez')
        .where('externi_id', '=', o.id)
        .executeTakeFirst();
      if (!v) {
        if (o.zruseno || o.od < ted) continue; // zrušenou nebo probíhající neoznamujeme
        const t = textyCez(o, 'nova', this.nastaveni);
        const row = await this.zaloz({
          zdroj: 'cez',
          externiId: o.id,
          titulek: t.titulek,
          od: o.od,
          do: o.do,
          t,
          detail: o,
          stav: 'odeslano',
        });
        const hlaseniId = await this.posli('cez', t);
        await this.nastavHlaseni(row.id, hlaseniId);
        await zapisAudit(this.db, {
          akce: 'odstavka.auto',
          detail: { id: row.id, odstavka: o.id, hlaseni: hlaseniId },
        });
        await this.ohlasRozeslani(t.titulek, null, t.emailPredmet, hlaseniId);
        continue;
      }
      if (v.zruseno_at || (v.plati_od && v.plati_od < ted)) continue;
      const druh: DruhZpravy | null = o.zruseno
        ? 'zruseni'
        : !stejnyCas(o.od, v.plati_od) || !stejnyCas(o.do, v.plati_do)
          ? 'zmena'
          : null;
      if (!druh) continue;
      const t = textyCez(o, druh, this.nastaveni);
      if (druh === 'zruseni')
        await this.db
          .updateTable('ik_vystrahy')
          .set({ zruseno_at: ted, detail: JSON.stringify(o) })
          .where('id', '=', v.id)
          .execute();
      else
        await this.db
          .updateTable('ik_vystrahy')
          .set({
            plati_od: o.od,
            plati_do: o.do,
            titulek: t.titulek,
            sms_text: t.smsText,
            email_predmet: t.emailPredmet,
            email_text: t.emailText,
            detail: JSON.stringify(o),
            pripomenuto_at: null,
          })
          .where('id', '=', v.id)
          .execute();
      const hlaseniId = await this.posli('cez', t);
      await zapisAudit(this.db, {
        akce: `odstavka.${druh}`,
        detail: { id: v.id, odstavka: o.id, hlaseni: hlaseniId },
      });
      await this.ohlasRozeslani(t.titulek, null, t.emailPredmet, hlaseniId);
    }
  }

  /** připomínky den předem (17:00 ČEZ, 17:02 SčVK) — jen u událostí, které začínají zítra */
  private async pripomen(zdroj: 'cez' | 'scvk') {
    const ted = this.hodiny();
    const zitrek = zitra(ted);
    const radky = await this.db
      .selectFrom('ik_vystrahy')
      .selectAll()
      .where('zdroj', '=', zdroj)
      .where('stav', '=', 'odeslano')
      .where('zruseno_at', 'is', null)
      .where('pripomenuto_at', 'is', null)
      .where('plati_od', '>', ted)
      .execute();
    for (const v of radky) {
      if (!v.plati_od || castiPraha(v.plati_od).ymd !== zitrek) continue;
      let t: TextyHlaseni;
      if (zdroj === 'cez') t = textyCez(odstavkaZDetailu(v.detail), 'pripominka', this.nastaveni);
      else {
        const e = udalostZDetailu(v.detail);
        if (e.typ === 'havarie') continue;
        t = textyScvk(e, 'pripominka', this.nastaveni);
      }
      const hlaseniId = await this.posli(zdroj, t);
      await this.db.updateTable('ik_vystrahy').set({ pripomenuto_at: ted }).where('id', '=', v.id).execute();
      await zapisAudit(this.db, {
        akce: zdroj === 'cez' ? 'odstavka.pripominka' : 'voda.pripominka',
        detail: { id: v.id, hlaseni: hlaseniId },
      });
    }
  }

  async pripomenCez() {
    await this.pripomen('cez').catch((e) => this.log.warn({ err: e }, 'výstrahy: připomínka ČEZ'));
  }

  // =====================================================================
  // SčVK — výpadky vody
  // =====================================================================

  zkontrolujScvk() {
    return this.hlidej('scvk', () => this.scvk());
  }

  async pripomenScvk() {
    await this.pripomen('scvk').catch((e) => this.log.warn({ err: e }, 'výstrahy: připomínka SčVK'));
  }

  private async scvkSeznamy(): Promise<UdalostScvk[]> {
    const vse: UdalostScvk[] = [];
    for (const cesta of SCVK_SEZNAMY) {
      const r = await this.stahni(SCVK_WEB + cesta);
      if (!r.ok) throw new Error(`scvk.cz HTTP ${r.status} (${cesta})`);
      const seznam = parsujSeznam(await r.text());
      if (!seznam.length)
        throw new Error(`scvk.cz: seznam ${cesta} neobsahuje žádné události — změnila se stránka?`);
      vse.push(...seznam);
    }
    return vse;
  }

  /** detail události; 404/410 = událost zmizela */
  private async scvkDetail(
    href: string,
  ): Promise<{ pryc: true } | { pryc: false; text: string; soubor: string | null }> {
    const r = await this.stahni(SCVK_WEB + href);
    if (r.status === 404 || r.status === 410) return { pryc: true };
    if (!r.ok) throw new Error(`scvk.cz detail HTTP ${r.status}`);
    return { pryc: false, ...parsujDetail(await r.text()) };
  }

  private async scvk() {
    const ted = this.hodiny();
    const nase = (await this.scvkSeznamy()).filter((e) => jeNaseObec(e.titulek, this.nastaveni.scvkObec));
    for (const e of nase) {
      const v = await this.db
        .selectFrom('ik_vystrahy')
        .selectAll()
        .where('zdroj', '=', 'scvk')
        .where('externi_id', '=', e.id)
        .executeTakeFirst();
      if (!v) {
        if (e.do && e.do < ted) continue; // už skončilo
        const d = await this.scvkDetail(e.href).catch(() => null);
        const plna: UdalostScvk = {
          ...e,
          text: (d && !d.pryc && d.text) || e.text,
          soubor: d && !d.pryc ? d.soubor : null,
        };
        const t = textyScvk(plna, 'nova', this.nastaveni);
        const row = await this.zaloz({
          zdroj: 'scvk',
          externiId: e.id,
          titulek: t.titulek,
          od: e.od,
          do: e.do,
          t,
          detail: plna,
          stav: 'odeslano',
        });
        const hlaseniId = await this.posli('scvk', t);
        await this.nastavHlaseni(row.id, hlaseniId);
        await zapisAudit(this.db, {
          akce: 'voda.auto',
          detail: { id: row.id, udalost: e.id, typ: e.typ, hlaseni: hlaseniId },
        });
        await this.ohlasRozeslani(t.titulek, null, t.emailPredmet, hlaseniId);
        continue;
      }
      if (v.zruseno_at || (v.plati_do && v.plati_do < ted)) continue;
      if (stejnyCas(e.od, v.plati_od) && stejnyCas(e.do, v.plati_do)) continue;
      const puvodni = udalostZDetailu(v.detail);
      const plna: UdalostScvk = {
        ...puvodni,
        ...e,
        text: e.text || puvodni.text,
        soubor: puvodni.soubor ?? null,
      };
      const t = textyScvk(plna, 'zmena', this.nastaveni);
      await this.db
        .updateTable('ik_vystrahy')
        .set({
          plati_od: e.od,
          plati_do: e.do,
          titulek: t.titulek,
          sms_text: t.smsText,
          email_predmet: t.emailPredmet,
          email_text: t.emailText,
          detail: JSON.stringify(plna),
          pripomenuto_at: null,
        })
        .where('id', '=', v.id)
        .execute();
      const hlaseniId = await this.posli('scvk', t);
      await zapisAudit(this.db, {
        akce: 'voda.zmena',
        detail: { id: v.id, udalost: e.id, hlaseni: hlaseniId },
      });
      await this.ohlasRozeslani(t.titulek, null, t.emailPredmet, hlaseniId);
    }
    // zmizelé: známé živé události, které už v seznamu nejsou — ověřit detailem (jen 404 = opravdu pryč)
    const videne = new Set(nase.map((e) => e.id));
    const zive = await this.db
      .selectFrom('ik_vystrahy')
      .selectAll()
      .where('zdroj', '=', 'scvk')
      .where('stav', '=', 'odeslano')
      .where('zruseno_at', 'is', null)
      .where((eb) => eb.or([eb('plati_do', 'is', null), eb('plati_do', '>', ted)]))
      .execute();
    for (const v of zive) {
      if (videne.has(v.externi_id)) continue;
      const puvodni = udalostZDetailu(v.detail);
      const det = await this.scvkDetail(puvodni.href).catch(() => null);
      if (!det || !det.pryc) continue;
      const druh: DruhZpravy = v.plati_od && v.plati_od > ted ? 'zruseni' : 'konec';
      const t = textyScvk(puvodni, druh, this.nastaveni);
      await this.db.updateTable('ik_vystrahy').set({ zruseno_at: ted }).where('id', '=', v.id).execute();
      const hlaseniId = await this.posli('scvk', t);
      await zapisAudit(this.db, {
        akce: `voda.${druh}`,
        detail: { id: v.id, udalost: v.externi_id, hlaseni: hlaseniId },
      });
      await this.ohlasRozeslani(t.titulek, null, t.emailPredmet, hlaseniId);
    }
  }

  // =====================================================================
  // přehledy
  // =====================================================================

  /** veřejný přehled: rozeslané výstrahy, které ještě platí, a nadcházející odstávky */
  async verejnySeznam() {
    const ted = this.hodiny();
    const radky = await this.db
      .selectFrom('ik_vystrahy')
      .selectAll()
      .where('stav', '=', 'odeslano')
      .where((eb) => eb.or([eb('plati_do', 'is', null), eb('plati_do', '>', ted)]))
      .orderBy('zdroj')
      .orderBy('plati_od')
      .execute();
    return radky.map((v) => this.popis(v));
  }

  /** popis pro šablony: termín a dotčená místa */
  popis(v: Vystraha) {
    let mista: string[] = [];
    let odkaz: string | null = null;
    let text = '';
    if (v.zdroj === 'cez') {
      const o = odstavkaZDetailu(v.detail);
      mista = mistaCez(o, this.nastaveni.casti).mista;
      odkaz = o.pdf ?? null;
    } else if (v.zdroj === 'scvk') {
      const e = udalostZDetailu(v.detail);
      text = e.text ?? '';
      odkaz = SCVK_WEB + e.href;
    } else {
      const w = chmuZDetailu(v.detail);
      text = [w.popis, w.pokyny ? `Doporučení: ${w.pokyny}` : ''].filter(Boolean).join('\n\n');
    }
    return {
      ...v,
      kdy: rozsah(v.plati_od, v.plati_do),
      mista,
      odkaz,
      text,
      zdrojNazev: NAZEV_ZDROJE[v.zdroj],
    };
  }

  async seznamSpravy(limit = 100) {
    const radky = await this.db
      .selectFrom('ik_vystrahy')
      .selectAll()
      .orderBy('vytvoreno_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return radky.map((v) => this.popis(v));
  }

  async detail(id: number) {
    const v = await this.db.selectFrom('ik_vystrahy').selectAll().where('id', '=', id).executeTakeFirst();
    return v ? this.popis(v) : null;
  }

  async stavZdroju() {
    return this.db.selectFrom('ik_vystrahy_zdroje').selectAll().orderBy('zdroj').execute();
  }
}
