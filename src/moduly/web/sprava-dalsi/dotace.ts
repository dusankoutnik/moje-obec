// Správa webu — Dotace — průvodce: 1 údaje → 2 loga → 3 kdy zobrazovat, s náhledem pásu log.
import type { FastifyInstance } from 'fastify';
import { datumPraha } from '../../../lib/datum.js';
import { navrhAlt } from '../sprava.js';
import type { WebSluzby } from '../index.js';
import { kontextSpravy, type Telo, jeden, jeDatum } from './spolecne.js';

export default async function webSpravaDotace(app: FastifyInstance, s: WebSluzby) {
  const { t, redaktor, ulozObrazky, pomocnici } = kontextSpravy(app);

  // ---------- dotace (průvodce: 1 údaje → 2 loga → 3 kdy zobrazovat) ----------
  app.get('/sprava/web/dotace', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/dotace', {
      titulek: t('web.dotace'),
      dotace: await s.dotace.seznam(),
      dnes: datumPraha(new Date()),
      ...pomocnici,
    }),
  );

  const krok1 = async (id: string | null) => {
    const d = id ? await s.dotace.podleId(id) : undefined;
    return { titulek: t('web.dotace_krok1'), d, f: d ?? {}, krok: 1 };
  };
  app.get('/sprava/web/dotace/nova', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/dotace-krok', await krok1(null)),
  );
  app.get<{ Params: { id: string } }>(
    '/sprava/web/dotace/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const v = await krok1(req.params.id);
      if (!v.d) return reply.callNotFound();
      return reply.view('web/sprava/dotace-krok', v);
    },
  );

  app.post<{ Params: { id?: string }; Body: Telo }>(
    '/sprava/web/dotace/:id?',
    { preHandler: redaktor },
    async (req, reply) => {
      const b = req.body ?? {};
      const id = req.params.id && req.params.id !== 'nova' ? req.params.id : null;
      if (jeden(b.akce) === 'kos' || jeden(b.akce) === 'obnovit') {
        await s.dotace.doKose(id!, jeden(b.akce) === 'kos', req.uzivatel!.id);
        req.session.flash = {
          typ: 'ok',
          text: jeden(b.akce) === 'kos' ? t('web.v_kosi', { titulek: '' }) : t('web.obnoveno'),
        };
        return reply.redirect('/sprava/web/dotace');
      }
      const projekt = jeden(b.projekt).slice(0, 300);
      const odkaz = jeden(b.odkaz);
      const data = {
        projekt,
        poskytovatel: jeden(b.poskytovatel).slice(0, 300),
        text: jeden(b.text).slice(0, 2000),
        odkaz: /^https?:\/\//.test(odkaz) ? odkaz.slice(0, 500) : '',
      };
      if (!projekt)
        return reply
          .code(400)
          .view('web/sprava/dotace-krok', { ...(await krok1(id)), f: data, chyba: t('web.chyba_projekt') });
      const novyId = await s.dotace.uloz(id, data, req.uzivatel!.id);
      return reply.redirect(`/sprava/web/dotace/${novyId}/loga`);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/web/dotace/:id/loga',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      // náhled pásu: tato dotace mezi ostatními, které se už zobrazují
      const ostatni = (await s.dotace.aktivni()).filter((x) => x.id !== d.id);
      return reply.view('web/sprava/dotace-krok', {
        titulek: t('web.dotace_krok2'),
        d,
        loga: await s.dotace.loga(d.id),
        ostatni,
        krok: 2,
        ...pomocnici,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/dotace/:id/loga',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      const b = req.body ?? {};
      for (const l of await s.dotace.loga(d.id)) {
        const a = b[`alt_${l.id}`];
        if (a !== undefined) await app.soubory.nastavAlt(l.id, jeden(a).slice(0, 300));
      }
      s.dotace.zmena(); // popisy log jsou v keši pásu dárců
      if (jeden(b.odebrat)) await s.dotace.odeberLogo(d.id, jeden(b.odebrat));
      const { ids, chyby } = await ulozObrazky(
        req,
        'loga',
        'logo',
        (n) => navrhAlt(n) || `${t('web.logo')} ${d.poskytovatel || d.projekt}`,
      );
      await s.dotace.pridejLoga(d.id, ids);
      if (chyby.length) req.session.flash = { typ: 'chyba', text: chyby.join(' ') };
      const dal = jeden(b.akce) === 'dal';
      if (dal) {
        const loga = await s.dotace.loga(d.id);
        if (!loga.length) {
          req.session.flash = { typ: 'chyba', text: t('web.chyba_logo') };
          return reply.redirect(`/sprava/web/dotace/${d.id}/loga`);
        }
        if (loga.some((l) => !l.alt)) {
          req.session.flash = {
            typ: 'chyba',
            text: t('web.chyba_alt', { n: loga.filter((l) => !l.alt).length }),
          };
          return reply.redirect(`/sprava/web/dotace/${d.id}/loga`);
        }
        return reply.redirect(`/sprava/web/dotace/${d.id}/zobrazeni`);
      }
      return reply.redirect(`/sprava/web/dotace/${d.id}/loga`);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/web/dotace/:id/zobrazeni',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      return reply.view('web/sprava/dotace-krok', {
        titulek: t('web.dotace_krok3'),
        d,
        loga: await s.dotace.loga(d.id),
        krok: 3,
        f: d,
        ...pomocnici,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/dotace/:id/zobrazeni',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      const b = req.body ?? {};
      const od = jeden(b.zobrazit_od);
      const doo = jeden(b.zobrazit_do);
      const f = {
        ...d,
        zobrazit_od: od,
        zobrazit_do: doo || null,
        v_paticce: jeden(b.v_paticce) === 'ano',
        poradi: Number(jeden(b.poradi)) || 100,
      };
      const chyba = !jeDatum(od)
        ? t('web.chyba_datum')
        : doo && (!jeDatum(doo) || doo < od)
          ? t('web.chyba_datum_do')
          : null;
      if (chyba)
        return reply.code(400).view('web/sprava/dotace-krok', {
          titulek: t('web.dotace_krok3'),
          d,
          loga: await s.dotace.loga(d.id),
          krok: 3,
          f,
          chyba,
          ...pomocnici,
        });
      await s.dotace.zobrazeni(
        d.id,
        { od, do: doo || null, vPaticce: f.v_paticce, poradi: f.poradi },
        req.uzivatel!.id,
      );
      const dnes = datumPraha(new Date());
      req.session.flash = {
        typ: 'ok',
        text:
          od <= dnes
            ? t('web.dotace_hotovo')
            : t('web.dotace_hotovo_pozdeji', { datum: od.split('-').reverse().join('. ') }),
      };
      return reply.redirect('/sprava/web/dotace');
    },
  );
}
