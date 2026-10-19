// Přepis HTML ze starého webu: obrázky a soubory stáhne, vlastní odkazy přepíše na nové adresy, vyčistí,
// sanitizuje a videa nahradí značkami z knihovny videí.
import { altZeZdroje, sanitizuj, srovnejNadpisy } from '../../../lib/html.js';
import { najdiVidea, ZNACKA_VIDEA } from './html-pomoc.js';
import type { ImportKontext } from './kontext.js';
import {
  absolutni,
  atribut,
  dekodujBezpecne,
  DOKUMENTY,
  esc,
  escRe,
  jmenoSouboru,
  OBRAZKY,
} from './pomucky.js';

/** přepíše HTML ze starého webu: média stáhne, vlastní odkazy udělá relativní, vyčistí a sanitizuje */
export async function prepisHtml(
  ctx: ImportKontext,
  html: string,
  titulek: string,
  adresaStranky?: string,
): Promise<{ html: string; prilohy: string[] }> {
  const prilohy: string[] = [];
  // relativní odkazy („foto.jpg“) se vztahují ke stránce, na které byly, ne ke kořeni webu
  const zaklad = adresaStranky && ctx.jeNasUrl(adresaStranky) ? adresaStranky : ctx.zdroj.zaklad;
  // videa (YouTube/Vimeo, <video>, [video], [embed]) → zástupná značka, z níž se po sanitizaci stane video
  const { html: bezVidei, videa } = najdiVidea(html, zaklad);
  let h = odstranNepotrebne(bezVidei);
  h = await prepisObrazky(ctx, h, zaklad);
  h = await prepisOdkazy(ctx, h, zaklad, prilohy);
  // odkaz kolem obrázku vedoucí na „stránku přílohy“ starého webu → rovnou na plnou fotku
  h = h.replace(/<a href="(?!\/soubory\/)[^"]*">(\s*<img src="(\/soubory\/[^"]+)")/g, '<a href="$2">$1');
  let cisty = galerie(bezDuplicitStahnout(srovnejNadpisy(sanitizuj(h))));
  cisty = await dosadVidea(ctx, cisty, videa, titulek);
  // značky videí se dosazují až po sanitizaci → výsledek ještě jednou projde sanitizací
  return { html: sanitizuj(cisty.replace(/<p>\s*<\/p>/g, '')), prilohy: [...new Set(prilohy)] };
}

/** skripty, styly, vložené objekty a shortcody starého redakčního systému pryč */
function odstranNepotrebne(h: string): string {
  return h
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<(script|style|noscript|iframe|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/\[\/?(su_|cmplz|contact-form|gallery|embed|caption|vc_|et_pb)[^\]]*\]/gi, '');
}

/** obrázky ze starého webu stáhnout a přeuložit; cizí obrázky vynechat */
async function prepisObrazky(ctx: ImportKontext, h: string, zaklad: string): Promise<string> {
  for (const m of [...h.matchAll(/<img\b[^>]*>/gi)]) {
    const tag = m[0];
    const nove = await novyObrazek(ctx, tag, zaklad);
    // náhrada funkcí: v textu nesmí ožít vzory $&, $1 (alt ze starého webu je cizí text)
    h = h.replace(tag, () => nove);
  }
  return h;
}

async function novyObrazek(ctx: ImportKontext, tag: string, zaklad: string): Promise<string> {
  // líně načítané obrázky mají skutečnou adresu v data-src (src je zástupný data: obrázek)
  const src = ['data-src', 'data-lazy-src', 'data-original', 'src']
    .map((a) => atribut(tag, a)?.trim())
    .find((x) => x && !/^data:/i.test(x));
  if (!src) return '';
  const abs = absolutni(src, zaklad);
  const u = abs ? new URL(abs) : null;
  // cizí obrázky (widgety, bannery) — obecní web nesmí načítat obsah z cizích serverů
  if (!u || !ctx.jeNas(u)) return '';
  const alt = (atribut(tag, 'alt') ?? '').trim();
  const nazev = dekodujBezpecne(u.pathname.split('/').pop() ?? '');
  // popis jen ze zdroje, nic se nevymýšlí: prázdný alt = „chybí popis“ (redaktor doplní ve správě)
  const popis = altZeZdroje(alt, nazev);
  // WordPress vkládá zmenšeniny (-150x150.jpg) — zkusit nejdřív originál, zmenší se u nás
  const original = abs!.replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '$1');
  const r =
    (original !== abs ? await ctx.soubor(original, 'obrazek', popis) : null) ??
    (await ctx.soubor(abs!, 'obrazek', popis));
  return r ? `<img src="${r.url}" alt="${esc(popis)}">` : '';
}

/** odkazy: cizí ponechat, soubory stáhnout (→ přílohy), stránky přepsat na nové cesty */
async function prepisOdkazy(
  ctx: ImportKontext,
  h: string,
  zaklad: string,
  prilohy: string[],
): Promise<string> {
  for (const m of [...h.matchAll(/<a\b[^>]*>/gi)]) {
    const tag = m[0];
    const href = atribut(tag, 'href');
    if (!href || /^(mailto|tel):/i.test(href) || href.startsWith('#')) continue;
    const abs = absolutni(href, zaklad);
    if (!abs) continue;
    const nova = await novyOdkaz(ctx, abs, prilohy);
    if (!nova) {
      // archiv: odkaz na stránku, která na novém webu není (nebo nedostupný soubor) → jen text
      h = h.replace(new RegExp(`${escRe(tag)}([\\s\\S]*?)</a>`, 'i'), '$1');
      continue;
    }
    h = h.replace(tag, () => `<a href="${esc(nova)}">`);
  }
  return h;
}

/** nová adresa odkazu; prázdný řetězec = odkaz zrušit (zůstane jen text) */
async function novyOdkaz(ctx: ImportKontext, abs: string, prilohy: string[]): Promise<string> {
  const u = new URL(abs);
  if (!ctx.jeNas(u)) return abs;
  const jmeno = jmenoSouboru(abs);
  if (
    DOKUMENTY.test(jmeno) ||
    OBRAZKY.test(jmeno) ||
    /\/wp-content\/uploads\/|\/e_download\.php|\/data\/(editor|uredni_deska)\//.test(u.pathname)
  ) {
    const r = await ctx.soubor(abs, OBRAZKY.test(jmeno) ? 'obrazek' : 'dokument');
    if (r) {
      prilohy.push(r.id);
      return r.url;
    }
    return ctx.v.archiv ? '' : ctx.cesta(abs);
  }
  if (ctx.v.archiv && !ctx.mapa.has(ctx.cesta(abs).toLowerCase())) return '';
  // kotva na stránce (#sekce) se zachová
  return ctx.cesta(abs) + (u.hash || '');
}

/** WordPress vkládá k souboru ještě tlačítko „Stáhnout“ se stejným odkazem — duplicitu vynecháme */
function bezDuplicitStahnout(cisty: string): string {
  return cisty.replace(/<a href="([^"]+)">\s*Stáhnout\s*<\/a>/g, (cele, url: string, i: number) =>
    cisty.slice(0, i).includes(`href="${url}"`) ? '' : cele,
  );
}

/** galerie starého webu (řada obrázků s odkazem na plnou velikost) → mřížka náhledů v <figure class> */
function galerie(cisty: string): string {
  return cisty.replace(
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
}

/** zástupné značky videí → značky z knihovny videí */
async function dosadVidea(
  ctx: ImportKontext,
  cisty: string,
  videa: ReturnType<typeof najdiVidea>['videa'],
  titulek: string,
): Promise<string> {
  for (const [i, v] of videa.entries()) {
    const znacka = await ctx.video(v, titulek);
    cisty = cisty.replace(
      new RegExp(`(<p>)?\\s*${ZNACKA_VIDEA(i).replace(/[[\]]/g, '\\$&')}\\s*(</p>)?`),
      () => znacka,
    );
  }
  return cisty;
}
