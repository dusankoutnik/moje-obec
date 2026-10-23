// Modul „pocasi“: předpověď počasí MET Norway (yr.no) — dlaždice na titulce (umístění ve Správě → Vzhled) a stránka
// /pocasi (48 h po hodinách, 7 dní). Data stahuje server (nejvýš jednou za 30 min, podle Expires), prohlížeč
// návštěvníka nic od MET nenačítá; ikony metno/weathericons (MIT) jsou v public/img/pocasi/. Výstrahy ČHMÚ
// z infokanálu (tabulka ik_vystrahy).
import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import { PocasiSluzba, type StavPocasi, type VystrahaPocasi } from './sluzba.js';
import { MET_LICENCE, MET_WEB, mistniDen, mistniHodina, type Den, type Hodina } from './met.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** jen když je modul zapnutý v obec.yml a má souřadnice */
    pocasi?: PocasiSluzba;
  }
}

const PASMO = 'Europe/Prague';
const fmtDenTydne = new Intl.DateTimeFormat('cs-CZ', { timeZone: PASMO, weekday: 'long' });
const fmtDenMesic = new Intl.DateTimeFormat('cs-CZ', { timeZone: PASMO, day: 'numeric', month: 'numeric' });
const fmtCas = new Intl.DateTimeFormat('cs-CZ', { timeZone: PASMO, hour: 'numeric', minute: '2-digit' });

/** teplota s typografickým minusem: „−3 °C“ */
export const fmtTeplota = (x: number | null, jednotka = true) =>
  x === null ? '–' : `${Math.round(x) < 0 ? '−' : ''}${Math.abs(Math.round(x))}${jednotka ? ' °C' : '°'}`;
/** srážky „0,4 mm“ */
export const fmtSrazky = (x: number | null) =>
  x === null ? '–' : `${(Math.round(x * 10) / 10).toLocaleString('cs-CZ')} mm`;
export const fmtHodina = (d: Date) => fmtCas.format(d);

/** „dnes“, „zítra“, nebo „sobota 25. 10.“ */
export function nazevDne(den: Pick<Den, 'datum' | 'cas'>, ted: Date, t: (k: string) => string): string {
  if (den.datum === mistniDen(ted)) return t('pocasi.dnes');
  if (den.datum === mistniDen(new Date(ted.getTime() + 86_400_000))) return t('pocasi.zitra');
  return `${fmtDenTydne.format(den.cas)} ${fmtDenMesic.format(den.cas)}`;
}
export const kratkyDen = (d: Date) => `${fmtDenTydne.format(d)} ${fmtDenMesic.format(d)}`;

/** inline SVG graf: čára teploty + sloupce srážek; vrací geometrii pro šablonu (bez knihoven) */
export function grafTeploty(hodiny: Hodina[]) {
  const W = 960;
  const H = 240;
  const ml = 40;
  const mr = 12;
  const mt = 24;
  const mb = 34;
  const body = hodiny.filter((h) => h.teplota !== null);
  if (body.length < 2) return null;
  const tep = body.map((h) => h.teplota!);
  let min = Math.floor(Math.min(...tep)) - 1;
  let max = Math.ceil(Math.max(...tep)) + 1;
  if (max - min < 6) {
    const s = (max + min) / 2;
    min = Math.floor(s - 3);
    max = Math.ceil(s + 3);
  }
  const krok = hodiny.length > 1 ? (W - ml - mr) / (hodiny.length - 1) : 0;
  const x = (i: number) => ml + i * krok;
  const y = (v: number) => mt + ((max - v) / (max - min)) * (H - mt - mb);
  const body2 = hodiny
    .map((h, i) => (h.teplota === null ? null : `${x(i).toFixed(1)},${y(h.teplota).toFixed(1)}`))
    .filter((p): p is string => !!p);
  const maxSrazky = Math.max(2, ...hodiny.map((h) => h.srazky ?? 0));
  const vyskaSloupcu = (H - mt - mb) * 0.45;
  const sirka = Math.max(2, Math.min(14, krok - 2));
  const sloupce = hodiny
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => (h.srazky ?? 0) > 0)
    .map(({ h, i }) => {
      const v = Math.max(2, ((h.srazky ?? 0) / maxSrazky) * vyskaSloupcu);
      return {
        x: (x(i) - sirka / 2).toFixed(1),
        y: (H - mb - v).toFixed(1),
        w: sirka.toFixed(1),
        h: v.toFixed(1),
      };
    });
  // vodorovné linky po 2/5 °C
  const rozsah = max - min;
  const linKrok = rozsah > 16 ? 5 : rozsah > 8 ? 4 : 2;
  const linky: { y: string; popisek: string }[] = [];
  for (let v = Math.ceil(min / linKrok) * linKrok; v <= max; v += linKrok)
    linky.push({ y: y(v).toFixed(1), popisek: fmtTeplota(v, false) });
  // popisky času po 6 h (místní 0, 6, 12, 18), půlnoc tučně s názvem dne
  const casy = hodiny
    .map((h, i) => ({ h, i, hod: mistniHodina(h.cas) }))
    .filter(({ hod, i }) => hod % 6 === 0 && i > 0 && i < hodiny.length - 1)
    .map(({ h, i, hod }) => ({
      x: x(i).toFixed(1),
      text: hod === 0 ? kratkyDen(h.cas) : `${hod}:00`,
      pulnoc: hod === 0,
    }));
  // popisek u nejvyšší a nejnižší teploty
  const iMax = hodiny.findIndex((h) => h.teplota === Math.max(...tep));
  const iMin = hodiny.findIndex((h) => h.teplota === Math.min(...tep));
  const extremy = [
    { i: iMax, nad: true },
    { i: iMin, nad: false },
  ].map(({ i, nad }) => ({
    x: Math.min(W - mr - 16, Math.max(ml + 16, x(i))).toFixed(1),
    y: (y(hodiny[i]!.teplota!) + (nad ? -8 : 18)).toFixed(1),
    cx: x(i).toFixed(1),
    cy: y(hodiny[i]!.teplota!).toFixed(1),
    text: fmtTeplota(hodiny[i]!.teplota),
  }));
  return {
    W,
    H,
    ml,
    mr,
    dole: H - mb,
    cara: body2.join(' '),
    sloupce,
    linky,
    casy,
    extremy,
    maxSrazky: fmtSrazky(Math.max(...hodiny.map((h) => h.srazky ?? 0))),
  };
}

export const pomocniciPocasi = {
  fmtTeplota,
  fmtSrazky,
  fmtHodina,
  kratkyDen,
  nazevDne,
  metWeb: MET_WEB,
  metLicence: MET_LICENCE,
};

/** data pro šablonu dlaždice / stránky */
export interface DataPocasi {
  stav: StavPocasi;
  vystrahy: VystrahaPocasi[];
  ted: Date;
}

async function pocasiModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const p = app.obec.pocasi;
  if (p.lat === null || p.lon === null) {
    app.log.warn('modul pocasi: chybí souřadnice (pocasi.lat, pocasi.lon v obec.yml) — vypnuto');
    return;
  }
  const sluzba = new PocasiSluzba(
    app.db,
    {
      lat: p.lat,
      lon: p.lon,
      nazev: p.nazev || app.obec.obec.kratky_nazev,
      // podmínka MET Norway: identifikace aplikace a kontakt (adresa webu)
      userAgent: `ObecniWebOdVoltu/2.0 ${app.env.BASE_URL}`,
    },
    app.log,
  );
  app.decorate('pocasi', sluzba);

  app.get('/pocasi', async (_req, reply) => {
    const stav = await sluzba.stav();
    const ted = sluzba.hodiny();
    // tabulka po 3 hodinách (místní 0, 3, 6 …)
    const po3 = stav.hodiny.filter((h) => mistniHodina(h.cas) % 3 === 0);
    return reply.view('pocasi/index', {
      titulek: app.t('pocasi.titulek', { misto: stav.nazev }),
      pocasi: { stav, vystrahy: await sluzba.vystrahy(), ted } satisfies DataPocasi,
      po3,
      graf: grafTeploty(stav.hodiny),
      ...pomocniciPocasi,
    });
  });

  if (volby.planovac) {
    // à 30 min (MET: nejvýš tak často; skutečně se ptáme až po Expires) a po startu, když jsou data stará
    const obnov = () => sluzba.obnov().catch((e) => app.log.warn({ err: e }, 'počasí MET: obnova selhala'));
    const job = new Cron('4,34 * * * *', { timezone: 'Europe/Prague' }, obnov);
    const start = setTimeout(obnov, 15_000);
    app.addHook('onClose', async () => {
      job.stop();
      clearTimeout(start);
    });
  }
}

export default fp(pocasiModul, { name: 'pocasiModul' });
