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
  let h = bezVidei
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<(script|style|noscript|iframe|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/\[\/?(su_|cmplz|contact-form|gallery|embed|caption|vc_|et_pb)[^\]]*\]/gi, '');
  // obrázky
  const imgs = [...h.matchAll(/<img\b[^>]*>/gi)];
  for (const m of imgs) {
    const tag = m[0];
    // líně načítané obrázky mají skutečnou adresu v data-src (src je zástupný data: obrázek)
    const src = ['data-src', 'data-lazy-src', 'data-original', 'src']
      .map((a) => atribut(tag, a)?.trim())
      .find((x) => x && !/^data:/i.test(x));
    const alt = (atribut(tag, 'alt') ?? '').trim();
    let nove = '';
    if (src) {
      const abs = absolutni(src, zaklad);
      const u = abs ? new URL(abs) : null;
      if (u && ctx.jeNas(u)) {
        const nazev = dekodujBezpecne(u.pathname.split('/').pop() ?? '');
        // popis jen ze zdroje, nic se nevymýšlí: prázdný alt = „chybí popis“ (redaktor doplní ve správě)
        const popis = altZeZdroje(alt, nazev);
        // WordPress vkládá zmenšeniny (-150x150.jpg) — zkusit nejdřív originál, zmenší se u nás
        const original = abs!.replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '$1');
        const r =
          (original !== abs ? await ctx.soubor(original, 'obrazek', popis) : null) ??
          (await ctx.soubor(abs!, 'obrazek', popis));
        if (r) nove = `<img src="${r.url}" alt="${esc(popis)}">`;
      } else if (u) {
        // cizí obrázky (widgety, bannery) — obecní web nesmí načítat obsah z cizích serverů
        nove = '';
      }
    }
    // náhrada funkcí: v textu nesmí ožít vzory $&, $1 (alt ze starého webu je cizí text)
    h = h.replace(tag, () => nove);
  }
  // odkazy
  const odkazy = [...h.matchAll(/<a\b[^>]*>/gi)];
  for (const m of odkazy) {
    const tag = m[0];
    const href = atribut(tag, 'href');
    if (!href || /^(mailto|tel):/i.test(href) || href.startsWith('#')) continue;
    const abs = absolutni(href, zaklad);
    if (!abs) continue;
    const u = new URL(abs);
    if (!ctx.jeNas(u)) {
      h = h.replace(tag, () => `<a href="${esc(abs)}">`);
      continue;
    }
    const jmeno = jmenoSouboru(abs);
    let nova = ctx.cesta(abs);
    if (
      DOKUMENTY.test(jmeno) ||
      OBRAZKY.test(jmeno) ||
      /\/wp-content\/uploads\/|\/e_download\.php|\/data\/(editor|uredni_deska)\//.test(u.pathname)
    ) {
      const r = await ctx.soubor(abs, OBRAZKY.test(jmeno) ? 'obrazek' : 'dokument');
      if (r) {
        nova = r.url;
        prilohy.push(r.id);
      } else if (ctx.v.archiv) nova = '';
    } else if (ctx.v.archiv && !ctx.mapa.has(ctx.cesta(abs).toLowerCase())) nova = '';
    else if (u.hash) nova += u.hash; // kotva na stránce (#sekce) se zachová
    if (!nova) {
      // archiv: odkaz na stránku, která na novém webu není (nebo nedostupný soubor) → jen text
      h = h.replace(new RegExp(`${escRe(tag)}([\\s\\S]*?)</a>`, 'i'), '$1');
      continue;
    }
    h = h.replace(tag, () => `<a href="${esc(nova)}">`);
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
    const znacka = await ctx.video(v, titulek);
    cisty = cisty.replace(
      new RegExp(`(<p>)?\\s*${ZNACKA_VIDEA(i).replace(/[[\]]/g, '\\$&')}\\s*(</p>)?`),
      () => znacka,
    );
  }
  // značky videí se dosazují až po sanitizaci → výsledek ještě jednou projde sanitizací
  return { html: sanitizuj(cisty.replace(/<p>\s*<\/p>/g, '')), prilohy: [...new Set(prilohy)] };
}
