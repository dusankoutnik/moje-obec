// Videa obecního webu: vlastní soubor (MP4/WebM, plakát, titulky) nebo YouTube/Vimeo.
//
// Soukromí návštěvníků: obecní web bez akce návštěvníka nic nenačítá z cizích serverů. U YouTube/Vimea se proto
// při uložení stáhne náhled do vlastního úložiště a na webu je jen obrázek s tlačítkem „Přehrát“ (bez JS odkaz na
// službu); přehrávač (youtube-nocookie.com / player.vimeo.com s dnt=1) se vloží až po kliknutí (public/js/web.js).
//
// Video v textu stránky = `<figure class="video" data-video="<id>"><a href="…">Název</a></figure>` (sanitizace ho
// pustí, editor ho zachová, šablona ho vykreslí stejným přehrávačem jako na titulce; odkaz je záloha).
import sharp from 'sharp';
import type { Db } from '../../db/index.js';
import type { Soubor, WebVideo } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { escapujHtml, popiskyOdkazuSObrazkem, textNaHtml } from '../../lib/html.js';
import { lidskaVelikost, type SouboroveUloziste } from '../../lib/soubory.js';
import { urlSouboru } from '../../web/soubory.js';

export type ZdrojVidea = 'soubor' | 'youtube' | 'vimeo';

/** odkaz na YouTube / Vimeo → služba a id; jinak null */
export function parsujOdkazVidea(vstup: string): { zdroj: 'youtube' | 'vimeo'; id: string } | null {
  let u: URL;
  try {
    u = new URL(vstup.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const casti = u.pathname.split('/').filter(Boolean);
  const yt = (id: string | null | undefined) =>
    id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { zdroj: 'youtube' as const, id } : null;
  if (host === 'youtu.be') return yt(casti[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (casti[0] === 'watch') return yt(u.searchParams.get('v'));
    if (['embed', 'shorts', 'live', 'v', 'e'].includes(casti[0] ?? '')) return yt(casti[1]);
    return null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    // vimeo.com/123, vimeo.com/123/hash (neveřejné), vimeo.com/channels/x/123, player.vimeo.com/video/123?h=hash
    const i = casti.findIndex((c) => /^\d{5,12}$/.test(c));
    if (i < 0) return null;
    const hash = u.searchParams.get('h') ?? (/^[0-9a-f]{6,20}$/.test(casti[i + 1] ?? '') ? casti[i + 1] : '');
    return { zdroj: 'vimeo', id: hash ? `${casti[i]}:${hash}` : casti[i]! };
  }
  return null;
}

/** adresa videa u služby (odkaz pro návštěvníky bez JS a „otevřít na YouTube“) */
export function odkazNaSluzbu(zdroj: ZdrojVidea, id: string): string {
  if (zdroj === 'youtube') return `https://www.youtube.com/watch?v=${id}`;
  const [v, h] = id.split(':');
  return `https://vimeo.com/${v}${h ? '/' + h : ''}`;
}

/** adresa přehrávače, který se vloží až po kliknutí (bez sledovacích cookies, kde to služba umí) */
export function adresaPrehravace(zdroj: ZdrojVidea, id: string): string {
  if (zdroj === 'youtube') return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&hl=cs`;
  const [v, h] = id.split(':');
  return `https://player.vimeo.com/video/${v}?autoplay=1&dnt=1${h ? '&h=' + h : ''}`;
}

export const NAZEV_SLUZBY: Record<'youtube' | 'vimeo', string> = {
  youtube: 'YouTube (Google)',
  vimeo: 'Vimeo',
};

/** co šablona přehrávače potřebuje (views/web/_video.eta) */
export interface VideoProZobrazeni {
  id: string;
  nazev: string;
  popis: string;
  /** textový popis / přepis jako HTML odstavce (z prostého textu) */
  prepisHtml: string;
  zdroj: ZdrojVidea;
  /** jen u YouTube/Vimea */
  sluzba?: string;
  /** krátký název služby (YouTube, Vimeo) do odkazu „Otevřít na …“ */
  sluzbaKratce?: string;
  odkazSluzba?: string;
  prehravac?: string;
  plakat: { url: string; sirka: number | null; vyska: number | null } | null;
  soubor: { url: string; mime: string; popis: string } | null;
  titulky: { url: string } | null;
}

export interface DataVidea {
  nazev: string;
  popis: string;
  prepis: string;
  na_titulce: boolean;
}

const RE_VIDEO_V_TEXTU = /<figure\b[^>]*\bdata-video="([0-9a-f-]{36})"[^>]*>[\s\S]*?<\/figure>/g;

/** id videí vložených do HTML obsahu */
export function idVideiVTextu(html: string): string[] {
  return [...new Set([...html.matchAll(RE_VIDEO_V_TEXTU)].map((m) => m[1]!))];
}

/** HTML rozdělené na kusy textu a videa (šablona obsahu kusy vykreslí; nedostupné video zmizí) */
export function rozdelPodleVidei(
  html: string,
  videa: Map<string, VideoProZobrazeni>,
): ({ html: string } | { video: VideoProZobrazeni })[] {
  const out: ({ html: string } | { video: VideoProZobrazeni })[] = [];
  let posledni = 0;
  for (const m of html.matchAll(RE_VIDEO_V_TEXTU)) {
    out.push({ html: html.slice(posledni, m.index) });
    const v = videa.get(m[1]!);
    if (v) out.push({ video: v });
    posledni = m.index + m[0].length;
  }
  out.push({ html: html.slice(posledni) });
  return out
    .filter((k) => !('html' in k) || k.html.trim())
    .map((k) => ('html' in k ? { html: popiskyOdkazuSObrazkem(k.html) } : k));
}

/** značka videa do textu stránky (import, editor) */
export function znackaVidea(v: { id: string; nazev: string }, odkaz: string): string {
  return `<figure class="video" data-video="${v.id}"><a href="${escapujHtml(odkaz)}">${escapujHtml(v.nazev)}</a></figure>`;
}

type Stahni = (url: string, init?: RequestInit) => Promise<Response>;

export class VideaSluzba {
  /** stahování náhledů a názvů ze služeb (v testech se podstrčí) */
  fetch: Stahni = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

  constructor(
    private db: Db,
    private soubory: SouboroveUloziste,
  ) {}

  podleId(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(undefined);
    return this.db.selectFrom('web_videa').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** existující (nesmazané) video téže služby a id — import a opakované vložení ho nezakládají znovu */
  podleExterniho(zdroj: 'youtube' | 'vimeo', id: string) {
    return this.db
      .selectFrom('web_videa')
      .selectAll()
      .where('zdroj', '=', zdroj)
      .where('externi_id', '=', id)
      .where('smazano_at', 'is', null)
      .orderBy('vytvoreno_at')
      .executeTakeFirst();
  }

  podleSouboru(souborId: string) {
    return this.db
      .selectFrom('web_videa')
      .selectAll()
      .where('soubor_id', '=', souborId)
      .where('smazano_at', 'is', null)
      .orderBy('vytvoreno_at')
      .executeTakeFirst();
  }

  async seznam(v: { verejne: boolean; kos?: boolean; naTitulce?: boolean; limit?: number }) {
    let q = this.db
      .selectFrom('web_videa')
      .selectAll()
      .where('smazano_at', v.kos ? 'is not' : 'is', null);
    if (v.verejne) q = q.where('stav', '=', 'zverejneno');
    if (v.naTitulce) q = q.where('na_titulce', '=', true);
    return q
      .orderBy('poradi')
      .orderBy('vytvoreno_at', 'desc')
      .limit(v.limit ?? 500)
      .execute();
  }

  async pocetVerejnych() {
    const r = await this.db
      .selectFrom('web_videa')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('smazano_at', 'is', null)
      .where('stav', '=', 'zverejneno')
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** založí video (koncept, nebo rovnou zveřejněné) na konec pořadí */
  async zaloz(
    d: DataVidea & {
      zdroj: ZdrojVidea;
      externi_id?: string;
      soubor_id?: string | null;
      plakat_id?: string | null;
      titulky_id?: string | null;
      stav?: 'koncept' | 'zverejneno';
    },
    aktorId: string | null,
    puvodniUrl?: string | null,
  ): Promise<string> {
    const m = await this.db
      .selectFrom('web_videa')
      .select((eb) => eb.fn.max('poradi').as('m'))
      .where('smazano_at', 'is', null)
      .executeTakeFirst();
    const r = await this.db
      .insertInto('web_videa')
      .values({
        nazev: d.nazev,
        popis: d.popis,
        prepis: d.prepis,
        na_titulce: d.na_titulce,
        zdroj: d.zdroj,
        externi_id: d.externi_id ?? '',
        soubor_id: d.soubor_id ?? null,
        plakat_id: d.plakat_id ?? null,
        titulky_id: d.titulky_id ?? null,
        stav: d.stav ?? 'koncept',
        poradi: Number(m?.m ?? 90) + 10,
        autor_id: aktorId,
        puvodni_url: puvodniUrl ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.video',
      detail: { id: r.id, nazev: d.nazev, zdroj: d.zdroj },
    });
    return r.id;
  }

  async uprav(
    id: string,
    d: Partial<DataVidea> & {
      zdroj?: ZdrojVidea;
      externi_id?: string;
      soubor_id?: string | null;
      plakat_id?: string | null;
      titulky_id?: string | null;
    },
  ) {
    await this.db
      .updateTable('web_videa')
      .set({ ...d, upraveno_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async nastavStav(id: string, stav: 'koncept' | 'zverejneno', aktorId: string | null) {
    await this.db
      .updateTable('web_videa')
      .set({ stav, upraveno_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.video_stav', detail: { id, stav } });
  }

  async doKose(id: string, smazat: boolean, aktorId: string | null) {
    await this.db
      .updateTable('web_videa')
      .set({ smazano_at: smazat ? new Date() : null })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: smazat ? 'web.video_kos' : 'web.video_obnova',
      detail: { id },
    });
  }

  async posun(id: string, smer: 'nahoru' | 'dolu') {
    const vse = await this.seznam({ verejne: false });
    const i = vse.findIndex((x) => x.id === id);
    const j = smer === 'nahoru' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= vse.length) return;
    [vse[i], vse[j]] = [vse[j]!, vse[i]!];
    for (const [k, x] of vse.entries())
      await this.db
        .updateTable('web_videa')
        .set({ poradi: (k + 1) * 10 })
        .where('id', '=', x.id)
        .execute();
  }

  /**
   * Náhled (a název, je-li třeba) ze služby: uloží se jako obrázek obce, takže návštěvník nic z YouTube/Vimea
   * nenačítá. YouTube: maxresdefault (1280×720), jinak hqdefault (480×360 s černými pruhy → oříznout na 16:9).
   */
  async stahniNahled(
    zdroj: 'youtube' | 'vimeo',
    id: string,
    nazev: string,
    aktorId: string | null,
  ): Promise<{ plakat: Soubor | null; nazev: string | null }> {
    const kandidati: { url: string; orezat?: boolean }[] = [];
    const j = await this.oembed(zdroj, id);
    const titulek = typeof j?.title === 'string' ? j.title.slice(0, 200) : null;
    if (zdroj === 'youtube') {
      kandidati.push(
        { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` },
        { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, orezat: true },
      );
    } else if (
      typeof j?.thumbnail_url === 'string' &&
      /^https:\/\/i\.vimeocdn\.com\//.test(j.thumbnail_url)
    ) {
      kandidati.push({ url: j.thumbnail_url });
    }
    for (const k of kandidati) {
      const r = await this.fetch(k.url).catch(() => null);
      if (!r?.ok) continue;
      let data: Buffer = Buffer.from(await r.arrayBuffer());
      if (k.orezat) {
        const meta = await sharp(data)
          .metadata()
          .catch(() => null);
        if (meta?.width && meta.height && meta.height / meta.width > 0.7) {
          const vyska = Math.round((meta.width * 9) / 16);
          data = await sharp(data)
            .extract({
              left: 0,
              top: Math.round((meta.height - vyska) / 2),
              width: meta.width,
              height: vyska,
            })
            .toBuffer();
        }
      }
      const v = await this.soubory.uloz({
        data,
        nazev: `nahled-${zdroj}-${id.replace(/:.*/, '')}.jpg`,
        druh: 'obrazek',
        nahralId: aktorId,
        alt: nazev || titulek || '',
        zdrojUrl: k.url,
      });
      if ('soubor' in v) return { plakat: v.soubor, nazev: titulek };
    }
    return { plakat: null, nazev: titulek };
  }

  /** název videa ze služby (oEmbed); null, když služba neodpoví */
  async nazevZeSluzby(zdroj: 'youtube' | 'vimeo', id: string): Promise<string | null> {
    const j = await this.oembed(zdroj, id);
    return typeof j?.title === 'string' ? j.title.slice(0, 200) : null;
  }

  private async oembed(zdroj: 'youtube' | 'vimeo', id: string): Promise<Record<string, unknown> | null> {
    const odkaz = encodeURIComponent(odkazNaSluzbu(zdroj, id));
    const url =
      zdroj === 'youtube'
        ? `https://www.youtube.com/oembed?format=json&url=${odkaz}`
        : `https://vimeo.com/api/oembed.json?width=1280&url=${odkaz}`;
    try {
      const r = await this.fetch(url, { headers: { accept: 'application/json' } });
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** data pro šablonu přehrávače (s adresami souborů) */
  async proZobrazeni(videa: WebVideo[]): Promise<VideoProZobrazeni[]> {
    const ids = [
      ...new Set(
        videa.flatMap((v) => [v.soubor_id, v.plakat_id, v.titulky_id]).filter((x): x is string => !!x),
      ),
    ];
    const soubory = ids.length
      ? await this.db.selectFrom('soubory').selectAll().where('id', 'in', ids).execute()
      : [];
    const podleId = new Map(soubory.map((s) => [s.id, s]));
    const out: VideoProZobrazeni[] = [];
    for (const v of videa) {
      const soubor = v.soubor_id ? podleId.get(v.soubor_id) : undefined;
      if (v.zdroj === 'soubor' && !soubor) continue; // video bez souboru nejde přehrát
      const plakat = v.plakat_id ? podleId.get(v.plakat_id) : undefined;
      const titulky = v.titulky_id ? podleId.get(v.titulky_id) : undefined;
      const ext = v.zdroj === 'youtube' || v.zdroj === 'vimeo' ? v.zdroj : null;
      out.push({
        id: v.id,
        nazev: v.nazev,
        popis: v.popis,
        prepisHtml: textNaHtml(v.prepis),
        zdroj: v.zdroj,
        sluzba: ext ? NAZEV_SLUZBY[ext] : undefined,
        sluzbaKratce: ext === 'youtube' ? 'YouTube' : ext === 'vimeo' ? 'Vimeo' : undefined,
        odkazSluzba: ext ? odkazNaSluzbu(ext, v.externi_id) : undefined,
        prehravac: ext ? adresaPrehravace(ext, v.externi_id) : undefined,
        plakat: plakat ? { url: urlSouboru(plakat), sirka: plakat.sirka, vyska: plakat.vyska } : null,
        soubor: soubor
          ? {
              url: urlSouboru(soubor),
              mime: soubor.mime,
              popis: `${soubor.pripona.toUpperCase()}, ${lidskaVelikost(soubor.velikost)}`,
            }
          : null,
        titulky: titulky ? { url: urlSouboru(titulky) } : null,
      });
    }
    return out;
  }

  /** zveřejněná videa vložená do textu (pro šablonu obsahu); v náhledu i koncepty */
  async vTextu(html: string, iKoncepty = false): Promise<Map<string, VideoProZobrazeni>> {
    const ids = idVideiVTextu(html);
    if (!ids.length) return new Map();
    let q = this.db
      .selectFrom('web_videa')
      .selectAll()
      .where('id', 'in', ids)
      .where('smazano_at', 'is', null);
    if (!iKoncepty) q = q.where('stav', '=', 'zverejneno');
    return new Map((await this.proZobrazeni(await q.execute())).map((v) => [v.id, v]));
  }

  /** odkaz uvnitř značky v textu (záloha, kdyby se přehrávač nevykreslil) */
  async odkazZnacky(v: WebVideo): Promise<string> {
    if (v.zdroj !== 'soubor') return odkazNaSluzbu(v.zdroj, v.externi_id);
    const s = v.soubor_id ? await this.soubory.podleId(v.soubor_id) : undefined;
    return s ? urlSouboru(s) : '/videa';
  }
}
