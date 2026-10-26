// Můj účet → Přihlášená zařízení: vlastní aktivní sezení a odhlášení vybraného nebo všech ostatních zařízení.
// Odhlášení ruší i přihlášení u OIDC providera (aplikace obce se na odhlášeném zařízení musí přihlásit znovu).
import type { FastifyInstance } from 'fastify';
import { zapisAudit } from '../../lib/audit.js';
import { vyzadujPrihlaseni } from './opravneni.js';
import { otiskSezeni, type UctySluzba } from './sluzba.js';

export default async function ucetZarizeniRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const t = app.t;

  app.get('/ucet/zarizeni', { preHandler: vyzadujPrihlaseni }, async (req, reply) =>
    reply.view('ucty/zarizeni', {
      titulek: t('sprava.zarizeni_nadpis'),
      sezeni: await ucty.sezeniUctu(req.uzivatel!.id, req.session.sessionId),
    }),
  );

  app.post<{ Body: { sezeni?: string } }>(
    '/ucet/zarizeni',
    { preHandler: vyzadujPrihlaseni },
    async (req, reply) => {
      const u = req.uzivatel!;
      const aktualni = req.session.sessionId ?? '';
      const otisk =
        typeof req.body?.sezeni === 'string' && /^[0-9a-f]{16}$/.test(req.body.sezeni)
          ? req.body.sezeni
          : null;
      let n: number;
      if (otisk && otisk === otiskSezeni(aktualni)) {
        // odhlášení tohoto zařízení = běžné odhlášení
        await req.session.destroy();
        await zapisAudit(app.db, {
          uzivatelId: u.id,
          akce: 'odhlaseni',
          detail: { zpusob: 'zarizeni' },
          ip: req.ip,
        });
        return reply.redirect('/');
      }
      if (otisk) n = await ucty.odhlasSezeni(u.id, otisk);
      else n = await ucty.odhlasOstatni(u.id, aktualni || null);
      await zapisAudit(app.db, {
        uzivatelId: u.id,
        akce: 'ucet.odhlaseni_zarizeni',
        detail: { rozsah: otisk ? 'jedno' : 'ostatni', sezeni: n },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('sprava.zarizeni_odhlaseno', { n }) };
      return reply.redirect('/ucet/zarizeni');
    },
  );
}
