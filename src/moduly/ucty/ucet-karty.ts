// Stránka Můj účet = jediné místo se všemi nastaveními účtu (náhrada aplikace MůjÚčet, 2026-10-22, pokyn Dušana).
// Karty podle zapnutých modulů obce: osobní údaje (profil, e-mail, heslo, telefon se schválením úřadem, GDPR),
// infokanál (kanál a kategorie odběru), rezervace (souhrn, platby, posilovna a přístupy, eKlíč), spolujízda,
// eKnihy (SMS o nových knihách). Vypnutý modul = karta zmizí; aplikace neodpoví = karta „teď nedostupné“.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { KanalPreference, Uzivatel } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { bezDiakritiky, formatujTelefon, normalizujEmail, normalizujTelefon } from '../../lib/kontakty.js';
import { hlidejLimit } from '../../lib/limit.js';
import type { StavModulu } from '../sluzby/sluzba.js';
import { vyzadujPrihlaseni, vyzadujRoli } from './opravneni.js';
import { smiUpravitUcet, type UctySluzba } from './sluzba.js';
import { AplikaceRezervaci, type SouhrnRezervaci } from './ucet-aplikace.js';

const KANALY_UCTU: KanalPreference[] = ['sms', 'smisene'];

function navic(u: Uzivatel): Record<string, unknown> {
  return (u.navic && typeof u.navic === 'object' ? u.navic : {}) as Record<string, unknown>;
}

const poleCisel = (v: unknown): number[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v])
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n));

export default async function ucetKartyRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const t = app.t;
  const rez = new AplikaceRezervaci(app.env.APLIKACE_REZERVACE_URL, app.env.INTERNI_API_SECRET);
  const spravce = vyzadujRoli('spravce');
  const maInfokanal = () => app.obec.moduly.infokanal && app.hasDecorator('infokanal');

  async function stavModulu(): Promise<StavModulu | null> {
    try {
      return await app.moduly.stav();
    } catch {
      return null;
    }
  }

  // ---------- SMS přes frontu infokanálu (s opakováním); bez infokanálu přímo bránou ----------
  async function posliSms(telefon: string, text: string, zdroj: string) {
    try {
      if (app.hasDecorator('infokanalOdchozi')) {
        await app.infokanalOdchozi.zarad({ prijemci: [{ telefon }], sms: text, zdroj });
      } else {
        await app.sms.posli(telefon, bezDiakritiky(`${app.obec.texty.sms_prefix}${text}`));
      }
    } catch (e) {
      app.log.error({ err: e, zdroj }, 'SMS ze stránky účtu se nepodařilo zařadit');
    }
  }

  async function mailSpravcum(predmet: string, text: string) {
    const lide = await ucty.podleRole(['spravce', 'admin']);
    const adresy = new Set(lide.filter((x) => x.email && !x.blokovan_at).map((x) => x.email!.toLowerCase()));
    if (!adresy.size && app.obec.obec.kontakt.email) adresy.add(app.obec.obec.kontakt.email);
    for (const komu of adresy) {
      await app.mail.posli({ komu, predmet, text }).catch((e) => app.log.warn({ err: e }, 'avízo správcům'));
    }
  }

  const jmenoUctu = (u: Pick<Uzivatel, 'jmeno' | 'prijmeni' | 'prezdivka' | 'telefon'>) =>
    `${u.jmeno} ${u.prijmeni}`.trim() || u.prezdivka || formatujTelefon(u.telefon);

  // ---------- odběr infokanálu svázaný s účtem ----------
  async function odberUctu(u: Uzivatel) {
    if (!maInfokanal()) return null;
    const podleUctu = await app.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('uzivatel_id', '=', u.id)
      .orderBy('odhlasen_at', 'desc')
      .executeTakeFirst();
    return podleUctu ?? (await app.infokanal.odberatelPodleTelefonu(u.telefon)) ?? null;
  }

  // nabídka „použít e-mail účtu TTLock i pro zprávy obce“ — jen se souhlasem, jen když účet e-mail nemá,
  // adresu nepoužívá jiný účet a uživatel ji už jednou neodmítl (stejná pravidla jako MůjÚčet)
  async function nabidkaEmailuZEklice(u: Uzivatel, ekeyEmail: string | null | undefined) {
    const e = normalizujEmail(ekeyEmail);
    if (u.email || !e) return null;
    if (String(navic(u).ekey_email_odmitnut ?? '').toLowerCase() === e) return null;
    const jiny = await app.db
      .selectFrom('uzivatele')
      .select('id')
      .where(sql<boolean>`lower(email) = ${e}`)
      .where('id', '!=', u.id)
      .executeTakeFirst();
    return jiny ? null : e;
  }

  async function nastavNavic(id: string, hodnoty: Record<string, unknown>) {
    await app.db
      .updateTable('uzivatele')
      .set({ navic: sql`navic || ${JSON.stringify(hodnoty)}::jsonb` as never, upraven_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async function cekajiciZmenaTelefonu(uid: string) {
    return app.db
      .selectFrom('uzivatele_zmeny_telefonu')
      .selectAll()
      .where('uzivatel_id', '=', uid)
      .where('stav', '=', 'ceka')
      .executeTakeFirst();
  }

  // ---------- GET /ucet ----------
  app.get('/ucet', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    const u = req.uzivatel!;
    const stav = await stavModulu();
    const zap = (k: keyof StavModulu) => !!stav?.[k];

    let odber: Awaited<ReturnType<typeof odberUctu>> = null;
    let kategorie: Awaited<ReturnType<typeof app.infokanal.kategorie>> = [];
    let optouty = new Set<number>();
    const infokanal = maInfokanal() && zap('infokanal');
    if (infokanal) {
      odber = await odberUctu(u);
      kategorie = await app.infokanal.kategorie();
      if (odber) optouty = new Set(await app.infokanal.optoutyOdberatele(odber.id));
    }

    const rezervace = zap('rezervace');
    let souhrn: SouhrnRezervaci | null = null;
    if (rezervace || zap('spolujizda')) souhrn = await rez.souhrn(u.cislo);
    const nabidkaEmailu = souhrn ? await nabidkaEmailuZEklice(u, souhrn.ekeyEmail) : null;

    return reply.view('ucty/ucet', {
      titulek: t('ucet.titulek'),
      u,
      moduly: {
        infokanal,
        rezervace,
        spolujizda: zap('spolujizda'),
        eknihy: zap('eknihy'),
        predprodej: zap('predprodej'),
      },
      odber,
      odberAktivni: !!odber && !!odber.overen_at && !odber.odhlasen_at,
      kategorie,
      optouty,
      souhrn,
      nabidkaEmailu,
      eknihySms: !!navic(u).eknihy_sms,
      zmenaTelefonu: await cekajiciZmenaTelefonu(u.id),
    });
  });

  // ---------- infokanál ----------
  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/ucet/odber',
    { preHandler: vyzadujPrihlaseni },
    async (req, reply) => {
      if (!maInfokanal() || !(await app.moduly.zapnuto('infokanal'))) return reply.redirect('/ucet');
      const u = req.uzivatel!;
      const b = req.body;
      const kategorie = await app.infokanal.kategorie();
      const zvolene = new Set(poleCisel(b.kategorie));
      const optouty = kategorie.filter((k) => !k.povinna && !zvolene.has(k.id)).map((k) => k.id);
      const chtenyKanal = KANALY_UCTU.includes(b.kanal as KanalPreference)
        ? (b.kanal as KanalPreference)
        : 'sms';
      const odber = await odberUctu(u);

      if (b.akce === 'zrusit') {
        if (odber && !odber.odhlasen_at) await app.infokanal.odhlas(odber.id, 'ucet');
        req.session.flash = { typ: 'info', text: t('infokanal.odhlaseno') };
        return reply.redirect('/ucet#odber');
      }

      if (!odber || !odber.overen_at || odber.odhlasen_at || b.akce === 'prihlasit') {
        // přihlášení jedním klikem: telefon účtu je ověřený přihlášením, údaje z profilu
        const email = u.email ?? odber?.email ?? null;
        const { emailObsazeny } = await app.infokanal.zalozNeboObnov({
          jmeno: `${u.jmeno} ${u.prijmeni}`.trim(),
          telefon: u.telefon,
          email,
          castObce: u.cast_obce,
          kanal: email ? chtenyKanal : 'sms',
          optouty: b.akce === 'prihlasit' && b.kategorie === undefined ? [] : optouty,
          zdroj: 'ucet',
          overeno: true,
          souhlas: true,
          uzivatelId: u.id,
        });
        await zapisAudit(app.db, { uzivatelId: u.id, akce: 'ucet.odber_prihlasit', ip: req.ip });
        req.session.flash = {
          typ: emailObsazeny ? 'info' : 'ok',
          text: t(emailObsazeny ? 'infokanal.email_obsazeny' : 'muj_ucet.odber_prihlasen'),
        };
        return reply.redirect('/ucet#odber');
      }

      const email = odber.email ?? u.email ?? null;
      if (chtenyKanal === 'smisene' && !email) {
        req.session.flash = { typ: 'chyba', text: t('muj_ucet.odber_bez_emailu') };
        return reply.redirect('/ucet#odber');
      }
      await app.infokanal.uprav(
        odber.id,
        { kanal: chtenyKanal, ...(odber.email ? {} : email ? { email } : {}) },
        optouty,
      );
      if (!odber.uzivatel_id)
        await app.db
          .updateTable('ik_odberatele')
          .set({ uzivatel_id: u.id })
          .where('id', '=', odber.id)
          .execute();
      await zapisAudit(app.db, {
        uzivatelId: u.id,
        akce: 'ucet.odber_upravit',
        detail: { kanal: chtenyKanal, optouty },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('infokanal.kategorie_nastaveny') };
      return reply.redirect('/ucet#odber');
    },
  );

  // ---------- eKnihy: SMS o nových knihách (opt-in; čte avízo novinek z uzivatele.navic.eknihy_sms) ----------
  app.post<{ Body: { eknihy_sms?: string } }>(
    '/ucet/eknihy',
    { preHandler: vyzadujPrihlaseni },
    async (req, reply) => {
      const u = req.uzivatel!;
      const zap = req.body.eknihy_sms === 'ano';
      await nastavNavic(u.id, { eknihy_sms: zap });
      await zapisAudit(app.db, { uzivatelId: u.id, akce: 'ucet.eknihy_sms', detail: { zap }, ip: req.ip });
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
      return reply.redirect('/ucet#eknihy');
    },
  );

  // ---------- rezervace: platby ----------
  app.get('/ucet/platby', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    if (!(await app.moduly.zapnuto('rezervace').catch(() => false))) return reply.redirect('/ucet');
    const data = await rez.platby(req.uzivatel!.cislo);
    return reply.view('ucty/platby', {
      titulek: t('muj_ucet.platby_titulek'),
      data,
      predprodej: await app.moduly.zapnuto('predprodej').catch(() => false),
    });
  });

  // ---------- rezervace: eKlíč (e-mail účtu TTLock) ----------
  async function pouzijEmailZEklice(req: FastifyRequest, u: Uzivatel, ekey: string, zdroj: string) {
    const e = await nabidkaEmailuZEklice(u, ekey);
    if (!e) return false;
    await app.db
      .updateTable('uzivatele')
      .set({ email: e, upraven_at: new Date() })
      .where('id', '=', u.id)
      .where('email', 'is', null)
      .execute();
    await zapisAudit(app.db, {
      uzivatelId: u.id,
      akce: 'ucet.email_z_eklice',
      detail: { email: e, zdroj, souhlas: true },
      ip: req.ip,
    });
    await app.mail
      .posli({
        komu: e,
        predmet: t('muj_ucet.eklic_email_predmet', { obec: app.obec.obec.nazev }),
        text: t('muj_ucet.eklic_email_text', {
          jmeno: jmenoUctu(u),
          email: e,
          obec: app.obec.obec.nazev,
          url: `${app.env.BASE_URL}/ucet`,
          kontakt: [app.obec.obec.kontakt.telefon, app.obec.obec.kontakt.email].filter(Boolean).join(', '),
        }),
      })
      .catch((err) => req.log.warn({ err }, 'potvrzení e-mailu z eKlíče'));
    return true;
  }

  app.post<{ Body: { email?: string; pouzit_email?: string } }>(
    '/ucet/eklic',
    { preHandler: [vyzadujPrihlaseni, hlidejLimit(app.limity.poslat)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      if (!(await app.moduly.zapnuto('rezervace').catch(() => false))) return reply.redirect('/ucet');
      const email = normalizujEmail(req.body.email);
      if (!email) {
        req.session.flash = { typ: 'chyba', text: t('muj_ucet.eklic_neplatny') };
        return reply.redirect('/ucet#zamky');
      }
      const v = await rez.eklic(u.cislo, email);
      if (!v) {
        req.session.flash = { typ: 'chyba', text: t('muj_ucet.nedostupne') };
        return reply.redirect('/ucet#zamky');
      }
      if (!v.ok) {
        req.session.flash = { typ: 'chyba', text: v.error || t('muj_ucet.eklic_neplatny') };
        return reply.redirect('/ucet#zamky');
      }
      await zapisAudit(app.db, { uzivatelId: u.id, akce: 'ucet.eklic', detail: { email }, ip: req.ip });
      if (req.body.pouzit_email === 'ano') await pouzijEmailZEklice(req, u, email, 'formular');
      const hotovo = v.ekey && ['hotovo', 'trvaly'].includes(v.ekey.status);
      req.session.flash = {
        typ: hotovo ? 'ok' : 'info',
        text: v.ekey?.message || t('app.ulozeno'),
      };
      return reply.redirect('/ucet#zamky');
    },
  );

  app.post<{ Body: { akce?: string } }>(
    '/ucet/eklic-email',
    { preHandler: vyzadujPrihlaseni },
    async (req, reply) => {
      const u = req.uzivatel!;
      const souhrn = await rez.souhrn(u.cislo);
      const ekey = souhrn?.ekeyEmail;
      if (!ekey) return reply.redirect('/ucet');
      if (req.body.akce === 'ne') {
        await nastavNavic(u.id, { ekey_email_odmitnut: ekey.toLowerCase() });
        await zapisAudit(app.db, { uzivatelId: u.id, akce: 'ucet.email_z_eklice_odmitnut', ip: req.ip });
        req.session.flash = { typ: 'info', text: t('muj_ucet.eklic_email_ne') };
        return reply.redirect('/ucet');
      }
      const ok = await pouzijEmailZEklice(req, u, ekey, 'nabidka');
      req.session.flash = ok
        ? { typ: 'ok', text: t('muj_ucet.eklic_email_ano', { email: ekey }) }
        : { typ: 'chyba', text: t('muj_ucet.eklic_email_nejde') };
      return reply.redirect('/ucet');
    },
  );

  // ---------- změna telefonu (schvaluje úřad) ----------
  const jeCerstve = (req: FastifyRequest) => (req.session.overenoDo ?? 0) > Date.now();
  const vyzadujCerstve = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.uzivatel) return vyzadujPrihlaseni(req, reply);
    if (jeCerstve(req)) return;
    return reply.redirect(`/ucet/overeni?dalsi=${encodeURIComponent('/ucet/telefon')}`);
  };

  app.get('/ucet/telefon', { preHandler: vyzadujCerstve }, async (req, reply) =>
    reply.view('ucty/telefon', {
      titulek: t('muj_ucet.telefon_titulek'),
      u: req.uzivatel!,
      zmena: await cekajiciZmenaTelefonu(req.uzivatel!.id),
    }),
  );

  app.post<{ Body: { telefon?: string; duvod?: string } }>(
    '/ucet/telefon',
    { preHandler: [vyzadujCerstve, hlidejLimit(app.limity.poslat)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      const vykresli = (chyba: string) =>
        reply.view('ucty/telefon', {
          titulek: t('muj_ucet.telefon_titulek'),
          u,
          chyba,
          f: req.body,
        });
      if (await cekajiciZmenaTelefonu(u.id)) return reply.redirect('/ucet/telefon');
      const novy = normalizujTelefon(req.body.telefon);
      if (!novy) return vykresli(t('prihlaseni.telefon_neplatny'));
      if (novy === u.telefon) return vykresli(t('muj_ucet.telefon_stejny'));
      if (await ucty.podleTelefonu(novy)) return vykresli(t('muj_ucet.telefon_obsazeny'));
      const duvod = String(req.body.duvod ?? '')
        .trim()
        .slice(0, 300);
      await app.db
        .insertInto('uzivatele_zmeny_telefonu')
        .values({ uzivatel_id: u.id, telefon_stary: u.telefon, telefon_novy: novy, duvod })
        .execute();
      await zapisAudit(app.db, {
        uzivatelId: u.id,
        akce: 'ucet.telefon_zadost',
        detail: { novy },
        ip: req.ip,
      });
      await mailSpravcum(
        t('muj_ucet.telefon_avizo_predmet', { jmeno: jmenoUctu(u) }),
        t('muj_ucet.telefon_avizo_text', {
          jmeno: jmenoUctu(u),
          stary: formatujTelefon(u.telefon),
          novy: formatujTelefon(novy),
          duvod: duvod || '—',
          url: `${app.env.BASE_URL}/sprava/ucty/zmeny-telefonu`,
        }),
      );
      req.session.flash = { typ: 'ok', text: t('muj_ucet.telefon_odeslano') };
      return reply.redirect('/ucet');
    },
  );

  app.post('/ucet/telefon/zrusit', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    const u = req.uzivatel!;
    await app.db
      .updateTable('uzivatele_zmeny_telefonu')
      .set({ stav: 'zruseno', vyrizeno_at: new Date(), vyrizil_id: u.id })
      .where('uzivatel_id', '=', u.id)
      .where('stav', '=', 'ceka')
      .execute();
    await zapisAudit(app.db, { uzivatelId: u.id, akce: 'ucet.telefon_zadost_zrusena', ip: req.ip });
    return reply.redirect('/ucet');
  });

  // ---------- GDPR: stažení vlastních údajů, žádost o výmaz ----------
  app.get('/ucet/moje-udaje.json', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    const u = req.uzivatel!;
    const { heslo_hash: _h, ...profil } = u;
    const odber = await odberUctu(u);
    const audit = await app.db
      .selectFrom('audit_log')
      .select(['ts', 'akce', 'detail'])
      .where('uzivatel_id', '=', u.id)
      .orderBy('ts', 'desc')
      .limit(500)
      .execute();
    const zmeny = await app.db
      .selectFrom('uzivatele_zmeny_telefonu')
      .select(['telefon_stary', 'telefon_novy', 'stav', 'vytvoreno_at', 'vyrizeno_at'])
      .where('uzivatel_id', '=', u.id)
      .execute();
    const souhrn = (await app.moduly.zapnuto('rezervace').catch(() => false))
      ? await rez.souhrn(u.cislo)
      : null;
    await zapisAudit(app.db, { uzivatelId: u.id, akce: 'ucet.export_udaju', ip: req.ip });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', 'attachment; filename="moje-udaje.json"')
      .send(
        JSON.stringify(
          {
            vytvoreno: new Date().toISOString(),
            spravce_udaju: app.obec.obec.nazev,
            ucet: { ...profil, ma_heslo: !!u.heslo_hash },
            odber_hlaseni: odber
              ? {
                  ...odber,
                  token: undefined,
                  odhlasene_kategorie: await app.infokanal.optoutyOdberatele(odber.id),
                }
              : null,
            zmeny_telefonu: zmeny,
            rezervace_souhrn: souhrn,
            zaznamy_cinnosti: audit,
          },
          null,
          2,
        ),
      );
  });

  app.post<{ Body: { zprava?: string } }>(
    '/ucet/vymaz',
    { preHandler: [vyzadujPrihlaseni, hlidejLimit(app.limity.poslat)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      const zprava = String(req.body.zprava ?? '')
        .trim()
        .slice(0, 1000);
      await zapisAudit(app.db, {
        uzivatelId: u.id,
        akce: 'ucet.zadost_vymaz',
        detail: { zprava },
        ip: req.ip,
      });
      await mailSpravcum(
        t('muj_ucet.vymaz_predmet', { jmeno: jmenoUctu(u) }),
        t('muj_ucet.vymaz_mail', {
          jmeno: jmenoUctu(u),
          telefon: formatujTelefon(u.telefon),
          email: u.email || '—',
          zprava: zprava || '—',
          url: `${app.env.BASE_URL}/sprava/uzivatele/${u.id}`,
        }),
      );
      req.session.flash = { typ: 'ok', text: t('muj_ucet.vymaz_odeslano') };
      return reply.redirect('/ucet#soukromi');
    },
  );

  // ---------- Správa: žádosti o změnu telefonu ----------
  app.get('/sprava/ucty/zmeny-telefonu', { preHandler: spravce }, async (req, reply) => {
    const radky = await app.db
      .selectFrom('uzivatele_zmeny_telefonu as z')
      .innerJoin('uzivatele as u', 'u.id', 'z.uzivatel_id')
      .leftJoin('uzivatele as v', 'v.id', 'z.vyrizil_id')
      .select([
        'z.id',
        'z.uzivatel_id',
        'z.telefon_stary',
        'z.telefon_novy',
        'z.duvod',
        'z.stav',
        'z.vytvoreno_at',
        'z.vyrizeno_at',
        'u.jmeno',
        'u.prijmeni',
        'u.prezdivka',
        'u.telefon',
        'v.jmeno as vyrizil_jmeno',
        'v.prijmeni as vyrizil_prijmeni',
      ])
      .where((eb) =>
        eb.or([eb('z.stav', '=', 'ceka'), eb('z.vytvoreno_at', '>', sql<Date>`now() - interval '90 days'`)]),
      )
      .orderBy('z.vytvoreno_at', 'desc')
      .limit(200)
      .execute();
    return reply.view('ucty/sprava-zmeny-telefonu', {
      titulek: t('muj_ucet.sprava_zmeny_titulek'),
      ceka: radky.filter((r) => r.stav === 'ceka'),
      vyrizene: radky.filter((r) => r.stav !== 'ceka'),
    });
  });

  app.post<{ Params: { id: string }; Body: { akce?: string } }>(
    '/sprava/ucty/zmeny-telefonu/:id',
    { preHandler: spravce },
    async (req, reply) => {
      const aktor = req.uzivatel!;
      const id = Number(req.params.id);
      const z = Number.isInteger(id)
        ? await app.db
            .selectFrom('uzivatele_zmeny_telefonu')
            .selectAll()
            .where('id', '=', id)
            .where('stav', '=', 'ceka')
            .executeTakeFirst()
        : undefined;
      const zpet = '/sprava/ucty/zmeny-telefonu';
      if (!z) {
        req.session.flash = { typ: 'chyba', text: t('muj_ucet.sprava_zmena_vyrizena') };
        return reply.redirect(zpet);
      }
      const cil = await ucty.podleId(z.uzivatel_id);
      if (!cil) return reply.redirect(zpet);
      // chráněný účet (provozovatel): žádost o jeho telefon vyřizuje jen provozovatel
      if (!smiUpravitUcet(aktor, cil)) {
        req.session.flash = { typ: 'chyba', text: t('sprava.chraneny_nelze') };
        return reply.redirect(zpet);
      }
      const kontakt = app.obec.obec.kontakt.telefon || app.obec.obec.kontakt.email || '';

      if (req.body.akce === 'zamitnout') {
        await app.db
          .updateTable('uzivatele_zmeny_telefonu')
          .set({ stav: 'zamitnuto', vyrizeno_at: new Date(), vyrizil_id: aktor.id })
          .where('id', '=', z.id)
          .execute();
        await zapisAudit(app.db, {
          uzivatelId: aktor.id,
          akce: 'ucet.telefon_zamitnuto',
          detail: { cil: cil.id, novy: z.telefon_novy },
          ip: req.ip,
        });
        await posliSms(cil.telefon, t('muj_ucet.telefon_sms_zamitnuto', { kontakt }), 'ucet-telefon');
        req.session.flash = { typ: 'info', text: t('muj_ucet.sprava_zamitnuto') };
        return reply.redirect(zpet);
      }
      if (req.body.akce !== 'schvalit') return reply.redirect(zpet);

      // nový telefon mezitím mohl získat jiný účet → nepřepisovat (unikátní index by požadavek shodil)
      const obsazeny = await ucty.podleTelefonu(z.telefon_novy);
      if (obsazeny && obsazeny.id !== cil.id) {
        req.session.flash = { typ: 'chyba', text: t('muj_ucet.telefon_obsazeny') };
        return reply.redirect(zpet);
      }
      const stary = cil.telefon;
      await app.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('uzivatele')
          .set({ telefon: z.telefon_novy, telefon_overen_at: null, upraven_at: new Date() })
          .where('id', '=', cil.id)
          .execute();
        await trx
          .updateTable('uzivatele_zmeny_telefonu')
          .set({ stav: 'schvaleno', vyrizeno_at: new Date(), vyrizil_id: aktor.id })
          .where('id', '=', z.id)
          .execute();
      });
      // odběr hlášení: nové číslo i u odběratele svázaného s účtem (když ho nemá jiný odběratel)
      if (maInfokanal()) {
        const jiny = await app.infokanal.odberatelPodleTelefonu(z.telefon_novy);
        if (!jiny) {
          await app.db
            .updateTable('ik_odberatele')
            .set({ telefon: z.telefon_novy, uzivatel_id: cil.id })
            .where((eb) => eb.or([eb('uzivatel_id', '=', cil.id), eb('telefon', '=', stary)]))
            .execute();
        }
      }
      await zapisAudit(app.db, {
        uzivatelId: aktor.id,
        akce: 'ucet.telefon_schvaleno',
        detail: { cil: cil.id, stary, novy: z.telefon_novy },
        ip: req.ip,
      });
      await posliSms(z.telefon_novy, t('muj_ucet.telefon_sms_schvaleno'), 'ucet-telefon');
      void rez.propis(cil.cislo);
      req.session.flash = { typ: 'ok', text: t('muj_ucet.sprava_schvaleno') };
      return reply.redirect(zpet);
    },
  );
}
