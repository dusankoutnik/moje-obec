// Modul „návštěvnost“: veřejná statistika návštěvnosti stránek webu (/navstevnost, odkaz v patičce — obec chce být
// transparentní). Zdroj = access logy reverzní proxy (NAVSTEVNOST_LOGY), přepočet jednou denně v 5:10 a po startu,
// když ještě nejsou data. Žádné cookies, měřicí skript ani cizí služby; ukládají se jen denní počty.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import { NavstevnostSluzba, OBDOBI } from './sluzba.js';
import { SEKCE, type Sekce } from './logy.js';
import { grafNavstevniku, kratkeDatum } from './graf.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** jen když je modul zapnutý (NAVSTEVNOST_LOGY) */
    navstevnost?: NavstevnostSluzba;
  }
}

const cislo = new Intl.NumberFormat('cs-CZ');

/** 2026-10-27 → 27. 10. 2026 */
function datumDne(den: string): string {
  const [r, m, d] = den.split('-');
  return `${Number(d)}. ${Number(m)}. ${r}`;
}

async function navstevnostModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const adresar = app.env.NAVSTEVNOST_LOGY;
  if (!adresar) return;
  const sluzba = new NavstevnostSluzba(
    app.db,
    {
      adresar: path.resolve(adresar),
      vzory: app.env.NAVSTEVNOST_SOUBORY,
      vlastniIp: app.env.NAVSTEVNOST_VLASTNI_IP.split(','),
    },
    app.log,
  );
  app.decorate('navstevnost', sluzba);
  const t = app.t;

  app.get<{ Querystring: { dni?: string; sekce?: string } }>('/navstevnost', async (req, reply) => {
    const dniZadane = Number(req.query.dni);
    const dni = (OBDOBI as readonly number[]).includes(dniZadane) ? dniZadane : 30;
    const sekce = (SEKCE as readonly string[]).includes(req.query.sekce ?? '')
      ? (req.query.sekce as Sekce)
      : null;
    const p = await sluzba.prehled(dni, sekce, t);
    const graf = grafNavstevniku(p.serie, (d) =>
      t('navstevnost.graf_den', { den: datumDne(d.den), n: cislo.format(d.navstevnici) }),
    );
    const odkaz = (zmena: { dni?: number; sekce?: string | null }) => {
      const q = new URLSearchParams();
      const d = zmena.dni ?? dni;
      const s = zmena.sekce === undefined ? sekce : zmena.sekce;
      if (d !== 30) q.set('dni', String(d));
      if (s) q.set('sekce', s);
      const r = q.toString();
      return r ? `/navstevnost?${r}` : '/navstevnost';
    };
    return reply.view('navstevnost/index', {
      titulek: t('navstevnost.titulek'),
      popis: t('navstevnost.popis'),
      p,
      graf,
      obdobi: OBDOBI,
      odkaz,
      cislo: (n: number) => cislo.format(n),
      datumDne,
      kratkeDatum,
    });
  });

  if (volby.planovac) {
    const prepocti = async () => {
      await sluzba.prepocitej().catch((e) => app.log.warn({ err: e }, 'návštěvnost: přepočet selhal'));
    };
    // jednou denně ráno (logy za včerejšek jsou kompletní); první naplnění po startu, když tabulky ještě nic nemají
    const job = new Cron('10 5 * * *', { timezone: 'Europe/Prague', protect: true }, prepocti);
    const start = setTimeout(() => {
      sluzba
        .maData()
        .then((ma) => (ma ? undefined : prepocti()))
        .catch((e) => app.log.warn({ err: e }, 'návštěvnost: první naplnění selhalo'));
    }, 60_000);
    app.addHook('onClose', async () => {
      job.stop();
      clearTimeout(start);
    });
  }
}

export default fp(navstevnostModul, { name: 'navstevnostModul' });
