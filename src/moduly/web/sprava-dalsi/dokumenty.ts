// Správa webu — Dokumenty ke stažení.
import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import { chybaSouboruText } from '../../../lib/soubory.js';
import { souboryZPole } from '../../../web/nahravani.js';
import type { WebSluzby } from '../index.js';
import { kontextSpravy, type Telo, jeden } from './spolecne.js';
import { stitekTextu } from './text-dokumentu.js';

export default async function webSpravaDokumenty(app: FastifyInstance, s: WebSluzby) {
  const { t, redaktor, pomocnici } = kontextSpravy(app);

  // ---------- dokumenty ke stažení ----------
  app.get('/sprava/web/dokumenty', { preHandler: redaktor }, async (_req, reply) => {
    const dokumenty = await s.dokumenty.seznam();
    const stavy = await app.textSouboru.stavy(dokumenty.map((d) => d.soubor_id));
    return reply.view('web/sprava/dokumenty', {
      titulek: t('web.dokumenty'),
      dokumenty,
      skupiny: await s.dokumenty.skupiny(),
      stitekTextu: (id: string) => stitekTextu(t, stavy.get(id)),
      ...pomocnici,
    });
  });

  app.post<{ Body: Telo }>('/sprava/web/dokumenty', { preHandler: redaktor }, async (req, reply) => {
    const b = req.body ?? {};
    const akce = jeden(b.akce);
    if (akce === 'kos' || akce === 'obnovit') {
      await s.dokumenty.doKose(jeden(b.id), akce === 'kos', req.uzivatel!.id);
      req.session.flash = {
        typ: 'ok',
        text: akce === 'kos' ? t('web.v_kosi', { titulek: '' }) : t('web.obnoveno'),
      };
      return reply.redirect(akce === 'kos' ? '/sprava/web/dokumenty' : '/sprava/web/kos');
    }
    if (akce === 'upravit') {
      await s.dokumenty.uprav(jeden(b.id), {
        nazev: jeden(b.nazev).slice(0, 250),
        popis: jeden(b.popis).slice(0, 1000),
        skupina: jeden(b.skupina).slice(0, 100),
      });
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
      return reply.redirect('/sprava/web/dokumenty');
    }
    const f = souboryZPole(req, 'soubor')[0];
    if (!f) {
      req.session.flash = { typ: 'chyba', text: t('web.chyba_soubor') };
      return reply.redirect('/sprava/web/dokumenty');
    }
    const v = await app.soubory.uloz({
      data: await fs.readFile(f.cesta),
      nazev: f.nazev,
      druh: 'dokument',
      nahralId: req.uzivatel!.id,
    });
    if ('chyba' in v) {
      req.session.flash = { typ: 'chyba', text: chybaSouboruText(t, v.chyba) };
      return reply.redirect('/sprava/web/dokumenty');
    }
    const nazev = jeden(b.nazev).slice(0, 250) || f.nazev.replace(/\.[^.]+$/, '');
    await s.dokumenty.pridej(
      {
        nazev,
        popis: jeden(b.popis).slice(0, 1000),
        skupina: jeden(b.skupina).slice(0, 100),
        souborId: v.soubor.id,
      },
      req.uzivatel!.id,
    );
    // rychlá kontrola textové vrstvy PDF (do 5 s) — redaktor hned ví, zda bude dokument prohledávatelný
    const kontrola = await app.textSouboru.rychlaKontrola(v.soubor);
    req.session.flash = {
      typ: 'ok',
      text:
        t('web.dokument_pridan', { nazev }) +
        (kontrola ? ' ' + t(`text.kontrola_${kontrola}`, { nazev: v.soubor.puvodni_nazev }) : ''),
    };
    return reply.redirect('/sprava/web/dokumenty');
  });
}
