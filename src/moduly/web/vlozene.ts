// Text příspěvku rozdělený na kusy HTML a vložené prvky (video z knihovny videí, fotogalerie obce), které šablona
// obsahu vykreslí vlastním přehrávačem / galerií. Nedostupný prvek (smazaný, nezveřejněný) z webu tiše zmizí.
import { popiskyOdkazuSObrazkem } from '../../lib/html.js';
import {
  RE_GALERIE_V_TEXTU,
  volbyVlozeneGalerie,
  type GalerieProZobrazeni,
  type RozlozeniGalerie,
} from './dalsi.js';
import type { VideoProZobrazeni } from './videa.js';
import type { FastifyInstance } from 'fastify';
import type { DataObyvatel, ObyvateleVyvojSluzba, RokObyvatel } from './obyvatele-vyvoj.js';
import { aktualniObyvatele } from './obyvatele.js';

export interface VlozenaGalerie {
  g: GalerieProZobrazeni;
  rozlozeni: RozlozeniGalerie;
  /** fotky k zobrazení (podle `pocet`; 0 = všechny) */
  fotky: GalerieProZobrazeni['fotky'];
  /** kolik fotek se nevešlo (odkaz „všech N fotek“) */
  zbyva: number;
}

export type KusObsahu =
  { html: string } | { video: VideoProZobrazeni } | { galerie: VlozenaGalerie } | { obyvatele: DataObyvatel };

/** data mimo obsah, která šablona vkládá do textu (zástupka `{{pocet_obyvatel}}`, blok vývoje obyvatel) */
export interface DoplnkyObsahu {
  obyvatele?: DataObyvatel | null;
  /** aktuální počet obyvatel podle obce (administrace → Zpravodaj → profil); null = zástupka zůstane prázdná */
  pocetObyvatel?: number | null;
}

export const RE_OBYVATELE = /<figure\b[^>]*\bdata-obyvatele="vyvoj"[^>]*>[\s\S]*?<\/figure>/g;
export const ZASTUPKA_OBYVATEL = /\{\{\s*pocet_obyvatel\s*\}\}/g;

/** má obsah něco, k čemu jsou potřeba data o obyvatelích? (ušetří dotazy u ostatních stránek) */
export function potrebujeObyvatele(html: string): boolean {
  return html.includes('data-obyvatele=') || ZASTUPKA_OBYVATEL.test(html);
}

const RE_VIDEO = /<figure\b[^>]*\bdata-video="([0-9a-f-]{36})"[^>]*>[\s\S]*?<\/figure>/g;

export function rozdelObsah(
  html: string,
  videa: Map<string, VideoProZobrazeni>,
  galerie: Map<string, GalerieProZobrazeni> = new Map(),
  doplnky: DoplnkyObsahu = {},
): KusObsahu[] {
  const shody = [
    ...[...html.matchAll(RE_VIDEO)].map((m) => ({ m, druh: 'video' as const })),
    ...[...html.matchAll(RE_GALERIE_V_TEXTU)].map((m) => ({ m, druh: 'galerie' as const })),
    ...[...html.matchAll(RE_OBYVATELE)].map((m) => ({ m, druh: 'obyvatele' as const })),
  ].sort((a, b) => a.m.index - b.m.index);
  const pocet = doplnky.pocetObyvatel != null ? String(doplnky.pocetObyvatel) : '';
  const out: KusObsahu[] = [];
  let posledni = 0;
  for (const { m, druh } of shody) {
    if (m.index < posledni) continue; // vnořené (nemělo by nastat)
    out.push({ html: html.slice(posledni, m.index) });
    if (druh === 'video') {
      const v = videa.get(m[1]!);
      if (v) out.push({ video: v });
    } else if (druh === 'obyvatele') {
      if (doplnky.obyvatele?.roky.length) out.push({ obyvatele: doplnky.obyvatele });
    } else {
      const g = galerie.get(m[1]!);
      if (g && g.fotky.length) {
        const { rozlozeni, pocet } = volbyVlozeneGalerie(m[0]);
        const n = pocet > 0 ? pocet : g.fotky.length;
        out.push({
          galerie: { g, rozlozeni, fotky: g.fotky.slice(0, n), zbyva: Math.max(0, g.fotky.length - n) },
        });
      }
    }
    posledni = m.index + m[0].length;
  }
  out.push({ html: html.slice(posledni) });
  return out
    .filter((k) => !('html' in k) || k.html.trim())
    .map((k) =>
      'html' in k ? { html: popiskyOdkazuSObrazkem(k.html).replace(ZASTUPKA_OBYVATEL, pocet) } : k,
    );
}

/** data o obyvatelích pro šablonu — jen když je obsah potřebuje (blok vývoje nebo zástupka počtu) */
export async function doplnkyObyvatel(
  app: FastifyInstance,
  s: { obyvateleVyvoj: ObyvateleVyvojSluzba },
  html: string,
): Promise<DoplnkyObsahu> {
  if (!potrebujeObyvatele(html)) return {};
  const popis = (r: RokObyvatel) => app.t('web.obyvatele_sloupec', { rok: r.rok, celkem: r.celkem });
  return {
    obyvatele: await s.obyvateleVyvoj.stav(popis).catch(() => null),
    pocetObyvatel: await aktualniObyvatele(app).catch(() => null),
  };
}
