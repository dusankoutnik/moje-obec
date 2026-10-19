// Média z importu: stažení a přeuložení souborů ze starého webu (jednou na adresu) a videa do knihovny videí.
import { urlSouboru } from '../../../web/soubory.js';
import { odkazNaSluzbu, VideaSluzba, znackaVidea } from '../videa.js';
import type { ImportKontext } from './kontext.js';
import { esc, jmenoSouboru } from './pomucky.js';
import type { ImportVideo } from './typy.js';

/** stáhne soubor ze starého webu a uloží ho (jednou); vrací novou URL */
export async function stahniSoubor(
  ctx: ImportKontext,
  url: string,
  druh: 'dokument' | 'obrazek' | 'logo' | 'video',
  alt = '',
): Promise<{ url: string; id: string; obrazek: boolean } | null> {
  const klic = `${druh}:${url}`;
  if (ctx.media.has(klic)) return ctx.media.get(klic)!;
  // stahuje se jen ze starého webu obce (obrázky, plakáty, přílohy); loga dárců jsou z dotačního souboru
  // správce a smějí být odjinud — i ta ale projdou kontrolou neveřejných adres ve stahovači
  if (druh !== 'logo' && !ctx.jeNasUrl(url)) {
    ctx.log(`soubor mimo starý web se nestahuje: ${url}`);
    ctx.media.set(klic, null);
    return null;
  }
  const existujici = await ctx.s.soubory.podleZdroje(url);
  if (existujici) {
    const r = {
      url: urlSouboru(existujici),
      id: existujici.id,
      obrazek: existujici.mime.startsWith('image/'),
    };
    ctx.media.set(klic, r);
    return r;
  }
  const stazeny = await ctx.stahovac.soubor(url);
  if (!stazeny) {
    ctx.media.set(klic, null);
    return null;
  }
  const nazev = jmenoSouboru(url);
  const v = await ctx.s.soubory.uloz({ data: stazeny.data, nazev, druh, alt, zdrojUrl: url });
  if ('chyba' in v) {
    ctx.vysledek.chyby.push(`soubor ${url}: ${v.chyba}`);
    ctx.media.set(klic, null);
    return null;
  }
  ctx.vysledek.souboru++;
  const r = { url: urlSouboru(v.soubor), id: v.soubor.id, obrazek: v.soubor.mime.startsWith('image/') };
  ctx.media.set(klic, r);
  return r;
}

/**
 * Video z obsahu starého webu → video v knihovně videí webu (zveřejněné, ne na titulce) a jeho značka do textu.
 * Stejné video (YouTube id, původní adresa souboru) se zakládá jen jednou. Video na cizím serveru nebo
 * nedostupný soubor zůstane jen odkazem.
 */
export async function importujVideo(ctx: ImportKontext, v: ImportVideo, titulek: string): Promise<string> {
  const videa = (ctx.s.videa ??= new VideaSluzba(ctx.s.db, ctx.s.soubory));
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
      ctx.vysledek.videa++;
      ctx.log(`video: ${zaznam.nazev}`);
    }
    return znackaVidea(zaznam, odkazNaSluzbu(v.zdroj, v.id!));
  }
  const url = v.url!;
  let u: URL;
  try {
    u = new URL(url, ctx.zdroj.zaklad);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!ctx.jeNas(u)) return odkaz(u.href, v.nazev || `Video: ${titulek}`);
  const soubor = await ctx.soubor(u.href, 'video');
  if (!soubor) return odkaz(u.href, v.nazev || `Video: ${titulek}`);
  let zaznam = await videa.podleSouboru(soubor.id);
  if (!zaznam) {
    const plakat = v.plakatUrl ? await ctx.soubor(v.plakatUrl, 'obrazek', v.nazev || titulek) : null;
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
    ctx.vysledek.videa++;
    ctx.log(`video: ${zaznam.nazev}`);
  }
  return znackaVidea(zaznam, soubor.url);
}
