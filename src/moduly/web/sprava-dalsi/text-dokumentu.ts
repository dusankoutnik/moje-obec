// Správa → Obecní web → Text dokumentů: stav fronty (čekající, právě zpracovávaný, hotovo dnes), seznamy chyb
// a souborů bez textu, „Zpracovat znovu“ / „Zpracovat teď“ u jednoho souboru a hromadné zařazení (všechny
// dokumenty / jen chyby a bez textu) s potvrzením. Role web nebo deska (dokumenty nahrávají obě).
import type { FastifyInstance } from 'fastify';
import { zapisAudit } from '../../../lib/audit.js';
import { lidskaVelikost, popisTypu } from '../../../lib/soubory.js';
import { urlSouboru } from '../../../web/soubory.js';
import { vyzadujRoli } from '../../ucty/opravneni.js';
import { jeden, type Telo } from './spolecne.js';

export const CESTA_TEXT = '/sprava/web/text-dokumentu';

/** štítek stavu textu pro šablony (text + CSS třída) */
export function stitekTextu(
  t: (k: string, p?: Record<string, string | number>) => string,
  s: { stav: string; zdroj: string | null } | undefined,
): { text: string; trida: string } | null {
  if (!s) return null;
  switch (s.stav) {
    case 'hotovo':
      return {
        text: t(s.zdroj === 'vrstva' || s.zdroj === 'ocr' ? `text.stitek_${s.zdroj}` : 'text.stitek_hotovo'),
        trida: 'stav-ok',
      };
    case 'ceka':
    case 'zpracovava':
      return { text: t('text.stitek_ceka'), trida: 'stav-ceka' };
    case 'bez_textu':
      return { text: t('text.stitek_bez_textu'), trida: 'stav-vychozi' };
    case 'nepodporovano':
      return { text: t('text.stitek_nepodporovano'), trida: 'stav-vychozi' };
    default:
      return { text: t('text.stitek_chyba'), trida: 'stav-chybi' };
  }
}

/** lidský odhad doby fronty */
export function odhadDoby(t: (k: string, p?: Record<string, string | number>) => string, sekund: number) {
  if (sekund < 90) return t('text.odhad_minuta');
  if (sekund < 3600) return t('text.odhad_minut', { n: Math.ceil(sekund / 60) });
  return t('text.odhad_hodin', { n: Math.ceil(sekund / 3600) });
}

export default async function webSpravaTextDokumentu(app: FastifyInstance) {
  const t = app.t;
  const role = vyzadujRoli('web', 'deska');
  const fronta = app.textSouboru;

  app.get(CESTA_TEXT, { preHandler: role }, async (_req, reply) => {
    const prehled = await fronta.prehled();
    const [cekajici, chyby, bezTextu, nepodporovane] = await Promise.all([
      fronta.seznam(['zpracovava', 'ceka'], 100),
      fronta.seznam(['chyba'], 200),
      fronta.seznam(['bez_textu'], 200),
      fronta.seznam(['nepodporovano'], 200),
    ]);
    const [vsech, kOpakovani] = await Promise.all([
      fronta.pocetKZarazeni('vse'),
      fronta.pocetKZarazeni('znovu-chyby'),
    ]);
    return reply.view('web/sprava/text-dokumentu', {
      titulek: t('text.titulek'),
      prehled,
      odhad: odhadDoby(t, prehled.odhadS),
      odhadVsech: odhadDoby(t, (vsech * prehled.prumerMs) / 1000),
      odhadOpakovani: odhadDoby(t, (kOpakovani * prehled.prumerMs) / 1000),
      vsech,
      kOpakovani,
      cekajici,
      chyby,
      bezTextu,
      nepodporovane,
      stitek: (s: { stav: string; zdroj: string | null }) => stitekTextu(t, s),
      urlSouboru,
      lidskaVelikost,
      popisTypu,
    });
  });

  app.post<{ Body: Telo }>(CESTA_TEXT, { preHandler: role }, async (req, reply) => {
    const b = req.body ?? {};
    const akce = jeden(b.akce);
    const id = jeden(b.id);
    const uzivatelId = req.uzivatel!.id;
    if ((akce === 'znovu' || akce === 'ted') && /^[0-9a-f-]{36}$/.test(id)) {
      const n = await fronta.zarad([id], { prednostne: akce === 'ted' });
      await zapisAudit(app.db, {
        uzivatelId,
        akce: akce === 'ted' ? 'text.zpracovat_ted' : 'text.zpracovat_znovu',
        detail: { soubor: id },
        ip: req.ip,
      });
      req.session.flash = n
        ? { typ: 'ok', text: t(akce === 'ted' ? 'text.zarazeno_ted' : 'text.zarazeno_znovu') }
        : { typ: 'info', text: t('text.prave_se_zpracovava') };
    } else if (akce === 'vse' || akce === 'znovu-chyby') {
      if (jeden(b.potvrdit) !== 'ano') {
        req.session.flash = { typ: 'chyba', text: t('text.potvrdit_chybi') };
        return reply.redirect(CESTA_TEXT);
      }
      const n = await fronta.zaradHromadne(akce);
      await zapisAudit(app.db, {
        uzivatelId,
        akce: akce === 'vse' ? 'text.znovu_vse' : 'text.znovu_chyby',
        detail: { zarazeno: n },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('text.hromadne_zarazeno', { n }) };
    }
    return reply.redirect(CESTA_TEXT);
  });
}
