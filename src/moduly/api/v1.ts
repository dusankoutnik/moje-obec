// REST API /api/v1 pro integrace (tokeny ze Správa → API a integrace). JSON, soubory multipart, chyby {chyba, pole?}.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { datumPraha, pridejDny } from '../../lib/datum.js';
import { sanitizuj } from '../../lib/html.js';
import { urlSouboru } from '../../web/soubory.js';
import { TYPY_ROZPOCTU, zkontrolujDobu, type TypRozpoctu } from '../deska/sluzba.js';
import { rozesliPrispevek } from '../infokanal/z-prispevku.js';
import {
  nactiPrispevek,
  podleExternihoId,
  TYPY_API,
  ulozSoubory,
  VYHRAZENE_ZDROJE,
  vystupPrispevku,
  ZDROJ_RE,
} from './prispevky.js';
import {
  bool,
  chyba,
  chybaDoOdpovedi,
  cislo,
  obsahSouboru,
  soubory,
  telo,
  text,
  type vytvorOvereni,
} from './spolecne.js';
import type { ApiTokenySluzba } from './tokeny.js';
import { akceZeZpravodaje, htmlZpravodaje, METADATA, poleZpravodaje } from './zpravodaj.js';

type Overeni = ReturnType<typeof vytvorOvereni>;

export default async function apiV1(app: FastifyInstance, z: { tokeny: ApiTokenySluzba; overeni: Overeni }) {
  const { vyzaduj } = z.overeni;
  app.setErrorHandler((e, req, reply) => chybaDoOdpovedi(e, req, reply));
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ chyba: 'Neznámý endpoint (dokumentace: /api).' }),
  );
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const aktor = (req: FastifyRequest) => req.apiToken?.zalozil_id ?? null;
  const audit = (req: FastifyRequest, akce: string, detail: Record<string, unknown>) =>
    zapisAudit(app.db, {
      uzivatelId: aktor(req),
      akce,
      detail: { ...detail, token: req.apiToken?.id, token_nazev: req.apiToken?.nazev },
      ip: req.ip,
    });

  // --- kategorie ---
  app.get(
    '/kategorie',
    { preHandler: vyzaduj('obsah:cteni', 'obsah:zapis', 'deska:zapis', 'zpravodaj') },
    async () => ({
      web: app.obec.moduly.web
        ? (await app.web.obsah.kategorie()).map((k) => ({ id: k.id, slug: k.slug, nazev: k.nazev }))
        : [],
      deska: app.obec.moduly.deska
        ? (await app.deska.kategorie()).map((k) => ({
            id: k.id,
            slug: k.slug,
            nazev: k.nazev,
            min_dni: k.min_dni,
            vychozi_dni: k.vychozi_dni,
            rozpocet: k.rozpocet,
          }))
        : [],
      infokanal: app.obec.moduly.infokanal
        ? (await app.infokanal.kategorie()).map((k) => ({ id: k.id, slug: k.slug, nazev: k.nazev }))
        : [],
    }),
  );

  // --- příspěvky ---
  const nacti = async (id: string): Promise<WebObsah> => {
    const o = /^[0-9a-f-]{36}$/i.test(id) ? await app.web.obsah.podleId(id) : undefined;
    if (!o || o.smazano_at || o.typ === 'odkaz') throw chyba(404, 'Příspěvek nenalezen.');
    return o;
  };

  app.get<{ Querystring: { zdroj?: string; externi_id?: string; typ?: string; limit?: string } }>(
    '/prispevky',
    { preHandler: vyzaduj('obsah:cteni', 'obsah:zapis') },
    async (req) => {
      let q = app.db
        .selectFrom('web_obsah')
        .selectAll()
        .where('smazano_at', 'is', null)
        .where('typ', '!=', 'odkaz');
      if (req.query.zdroj !== undefined) q = q.where('zdroj', '=', String(req.query.zdroj));
      if (req.query.externi_id) q = q.where('externi_id', '=', String(req.query.externi_id));
      if (req.query.typ) q = q.where('typ', '=', String(req.query.typ) as TypObsahu);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const radky = await q.orderBy('upraveno_at', 'desc').limit(limit).execute();
      return { polozky: await Promise.all(radky.map((o) => vystupPrispevku(app, o))) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/prispevky/:id',
    { preHandler: vyzaduj('obsah:cteni', 'obsah:zapis') },
    async (req) => {
      const o = await nacti(req.params.id);
      return { ...(await vystupPrispevku(app, o)), html: o.obsah_html, rozpracovano: o.koncept ?? null };
    },
  );

  const ulozeni = (zverejnit: boolean | undefined, o: WebObsah | null) =>
    zverejnit === true
      ? 'zverejnit'
      : zverejnit === false
        ? 'koncept'
        : o?.stav === 'zverejneno'
          ? 'zverejnit'
          : 'koncept';

  app.post(
    '/prispevky',
    { preHandler: vyzaduj('obsah:zapis'), bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      if (!app.obec.moduly.web) throw chyba(404, 'Modul web není v obci zapnutý.');
      const b = telo(req);
      const typ = (text(b, 'typ', 20) || 'aktualita') as TypObsahu;
      if (!TYPY_API.includes(typ)) throw chyba(400, 'Typ musí být aktualita, akce nebo stranka.', 'typ');
      const zdroj = text(b, 'zdroj', 40) ?? 'api';
      if (!ZDROJ_RE.test(zdroj) || VYHRAZENE_ZDROJE.has(zdroj))
        throw chyba(
          400,
          'Zdroj: malá písmena, číslice a - _ . : (do 40 znaků); import, rezervace, infokanal a zpravodaj jsou vyhrazené.',
          'zdroj',
        );
      const externiId = text(b, 'externi_id', 200) || null;
      const existujici = externiId ? await podleExternihoId(app, zdroj, externiId) : undefined;
      if (existujici && existujici.typ !== typ)
        throw chyba(409, `Záznam ${zdroj}/${externiId} už existuje jako ${existujici.typ}.`, 'typ');
      const { pole, zverejnit } = await nactiPrispevek(app, req, b, typ, existujici ?? null, aktor(req));
      const id = await app.web.obsah.uloz(
        existujici?.id ?? null,
        typ,
        pole,
        existujici ? ulozeni(zverejnit, existujici) : zverejnit ? 'zverejnit' : 'koncept',
        aktor(req),
        req.ip,
        { zdroj },
      );
      if (!existujici && externiId)
        await app.db.updateTable('web_obsah').set({ externi_id: externiId }).where('id', '=', id).execute();
      const o = (await app.web.obsah.podleId(id))!;
      await audit(req, existujici ? 'api.prispevek_upraven' : 'api.prispevek_zalozen', {
        id,
        typ,
        zdroj,
        externi_id: externiId,
      });
      return reply
        .code(existujici ? 200 : 201)
        .send({ ...(await vystupPrispevku(app, o)), aktualizovano: !!existujici });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/prispevky/:id',
    { preHandler: vyzaduj('obsah:zapis'), bodyLimit: 5 * 1024 * 1024 },
    async (req) => {
      const o = await nacti(req.params.id);
      // jen obsah založený přes API — stránky a články redakce token měnit nesmí
      if (VYHRAZENE_ZDROJE.has(o.zdroj) && o.zdroj !== 'zpravodaj')
        throw chyba(403, 'Přes API lze upravovat jen příspěvky založené přes API.');
      const b = telo(req);
      const { pole, zverejnit } = await nactiPrispevek(app, req, b, o.typ, o, aktor(req));
      await app.web.obsah.uloz(o.id, o.typ, pole, ulozeni(zverejnit, o), aktor(req), req.ip);
      await audit(req, 'api.prispevek_upraven', { id: o.id, typ: o.typ });
      return vystupPrispevku(app, (await app.web.obsah.podleId(o.id))!);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/prispevky/:id/rozeslat',
    { preHandler: vyzaduj('infokanal:rozeslat') },
    async (req, reply) => {
      if (!app.obec.moduly.infokanal) throw chyba(404, 'Infokanál není v obci zapnutý.');
      const o = await nacti(req.params.id);
      const b = telo(req);
      const v = await rozesliPrispevek(app, o, {
        aktorId: aktor(req),
        ip: req.ip,
        sms: bool(b, 'sms') ?? false,
        kategorieSlug: text(b, 'kategorie', 60) || undefined,
        zdroj: `api:${req.apiToken?.nazev ?? ''}`,
      });
      if ('chyba' in v)
        throw chyba(
          v.chyba === 'neni_zverejneno' ? 409 : 400,
          {
            neni_zverejneno: 'Rozeslat jde jen zveřejněná aktualita nebo akce.',
            zadny_kanal: 'Není co rozeslat.',
            zadny_prijemce: 'Infokanál nemá žádné příjemce.',
            kategorie: 'Neznámá kategorie infokanálu.',
            sms_dlouha: 'Text SMS je příliš dlouhý.',
          }[v.chyba],
          v.chyba === 'kategorie' ? 'kategorie' : undefined,
        );
      return reply.code(202).send({ hlaseni_id: v.id, prijemcu: v.prijemcu });
    },
  );

  // --- soubory ---
  app.post(
    '/soubory',
    { preHandler: vyzaduj('obsah:zapis', 'deska:zapis', 'zpravodaj') },
    async (req, reply) => {
      if (!req.isMultipart())
        throw chyba(415, 'Soubor pošlete jako multipart/form-data v poli „soubor“.', 'soubor');
      const b = telo(req);
      const ulozene = await ulozSoubory(
        app,
        req,
        'soubor',
        'dokument',
        aktor(req),
        text(b, 'alt', 300) ?? '',
      );
      if (!ulozene.length) throw chyba(400, 'Chybí soubor (pole „soubor“).', 'soubor');
      const out = ulozene.map((s) => ({
        id: s.id,
        url: `${app.env.BASE_URL}${urlSouboru(s)}`,
        nazev: s.puvodni_nazev,
        mime: s.mime,
        velikost: s.velikost,
      }));
      await audit(req, 'api.soubory', { ids: out.map((s) => s.id) });
      return reply.code(201).send(out.length === 1 ? out[0] : { soubory: out });
    },
  );

  // --- úřední deska ---
  app.post('/deska', { preHandler: vyzaduj('deska:zapis') }, async (req, reply) => {
    if (!app.obec.moduly.deska) throw chyba(404, 'Úřední deska není v obci zapnutá.');
    const b = telo(req);
    const nazev = text(b, 'nazev', 300);
    if (!nazev) throw chyba(400, 'Chybí název dokumentu.', 'nazev');
    const katVstup = text(b, 'kategorie', 100) ?? '';
    const kat = (await app.deska.kategorie()).find((k) => k.slug === katVstup || String(k.id) === katVstup);
    if (!kat)
      throw chyba(400, `Kategorie desky „${katVstup}“ neexistuje (GET /api/v1/kategorie).`, 'kategorie');
    const dnes = datumPraha(new Date());
    const od = text(b, 'vyveseno_od', 10) || dnes;
    // zpětné vyvěšení smí jen správce ve správě (s důvodem) — přes API nikdy
    if (od < dnes) throw chyba(400, 'Datum vyvěšení nesmí být v minulosti.', 'vyveseno_od');
    let do_: string | null = text(b, 'vyveseno_do', 10) || null;
    if (bool(b, 'do_odvolani')) do_ = null;
    else if (!do_ && kat.vychozi_dni > 0) do_ = pridejDny(od, kat.vychozi_dni);
    const k = zkontrolujDobu(kat, od, do_);
    if ('chyba' in k)
      throw chyba(
        400,
        k.chyba === 'kratke'
          ? `Kategorie „${kat.nazev}“ vyžaduje vyvěšení aspoň ${kat.min_dni} dní (nejdřív do ${k.minDo}).`
          : app.t(`deska.chyba_${k.chyba}`),
        k.chyba === 'od_neplatne' ? 'vyveseno_od' : 'vyveseno_do',
      );
    const typ = text(b, 'typ_rozpoctu', 40) ?? '';
    const typRozpoctu =
      kat.rozpocet && (TYPY_ROZPOCTU as readonly string[]).includes(typ) ? (typ as TypRozpoctu) : null;
    const rok = typRozpoctu ? (cislo(b, 'rok') ?? null) : null;
    if (typRozpoctu && (!rok || rok < 2000 || rok > 2100)) throw chyba(400, app.t('deska.chyba_rok'), 'rok');
    const data = {
      nazev,
      kategorieId: kat.id,
      cisloJednaci: text(b, 'cislo_jednaci', 100) ?? '',
      puvodce: text(b, 'puvodce', 200) ?? '',
      popis: text(b, 'popis', 3000) ?? '',
      od,
      do: do_,
      typRozpoctu,
      rok,
    };
    const sejme = await app.deska.coSeSejme(null, data);
    if (sejme.length && bool(b, 'potvrdit_nahrazeni') !== true)
      return reply.code(409).send({
        chyba: 'Dokument by sejmul starší rozpočtové dokumenty — pošlete znovu s potvrdit_nahrazeni=true.',
        pole: 'potvrdit_nahrazeni',
        sejme: sejme.map((s) => ({ id: s.id, nazev: s.nazev, rok: s.rok })),
      });
    const prilohy = await ulozSoubory(app, req, 'prilohy', 'dokument', aktor(req));
    const id = await app.deska.uloz(null, data, aktor(req), req.ip);
    await app.deska.pridejPrilohy(
      id,
      prilohy.map((s) => s.id),
    );
    await audit(req, 'api.deska', { id, nazev, priloh: prilohy.length });
    return reply.code(201).send({
      id,
      url: `${app.env.BASE_URL}/uredni-deska/${id}`,
      vyveseno_od: od,
      vyveseno_do: do_,
      prilohy: prilohy.map((s) => ({
        id: s.id,
        nazev: s.puvodni_nazev,
        url: `${app.env.BASE_URL}${urlSouboru(s)}`,
      })),
      sejmuto: sejme.map((s) => s.id),
    });
  });

  // --- zpravodaj ---
  app.post('/zpravodaj', { preHandler: vyzaduj('zpravodaj') }, async (req, reply) => {
    if (!app.obec.moduly.web) throw chyba(404, 'Modul web není v obci zapnutý.');
    if (!req.isMultipart()) throw chyba(415, 'Zpravodaj pošlete jako multipart/form-data (metadata + pdf).');
    const b = telo(req);
    let surova = text(b, 'metadata', 1_000_000);
    const metaSoubor = soubory(req, 'metadata')[0];
    if (!surova && metaSoubor) surova = (await obsahSouboru(metaSoubor)).toString('utf8');
    if (!surova) throw chyba(400, 'Chybí metadata (JSON).', 'metadata');
    let json: unknown;
    try {
      json = JSON.parse(surova);
    } catch {
      throw chyba(400, 'Metadata nejsou platný JSON.', 'metadata');
    }
    const p = METADATA.safeParse(json);
    if (!p.success) {
      const i = p.error.issues[0]!;
      const cesta = i.path.join('.');
      throw chyba(400, `Metadata: ${cesta || 'objekt'} — ${i.message}`, `metadata.${cesta}`);
    }
    const m = p.data;
    if (!soubory(req, 'pdf').length) throw chyba(400, 'Chybí PDF (pole „pdf“).', 'pdf');
    const nahral = aktor(req);
    const [pdf] = await ulozSoubory(app, req, 'pdf', 'dokument', nahral);
    if (!pdf || pdf.mime !== 'application/pdf') throw chyba(400, 'Pole „pdf“ musí být PDF.', 'pdf');
    const [tisk] = await ulozSoubory(app, req, 'pdf_tisk', 'dokument', nahral);
    if (tisk && tisk.mime !== 'application/pdf')
      throw chyba(400, 'Pole „pdf_tisk“ musí být PDF.', 'pdf_tisk');
    const [obalka] = await ulozSoubory(
      app,
      req,
      'obalka',
      'obrazek',
      nahral,
      `Obálka zpravodaje ${m.cislo}/${m.rocnik}`,
    );

    let kat = (await app.web.obsah.kategorie()).find((k) => k.slug === 'zpravodaj');
    if (!kat) {
      kat = await app.db
        .insertInto('web_kategorie')
        .values({ slug: 'zpravodaj', nazev: 'Zpravodaj' })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const puvodni = await app.db
      .selectFrom('web_zpravodaj')
      .selectAll()
      .where('rocnik', '=', m.rocnik)
      .where('cislo', '=', m.cislo)
      .executeTakeFirst();
    const obsahPuvodni = puvodni?.obsah_id ? await app.web.obsah.podleId(puvodni.obsah_id) : undefined;
    const obsahId0 = obsahPuvodni && !obsahPuvodni.smazano_at ? obsahPuvodni.id : null;
    const html = sanitizuj(htmlZpravodaje(m, pdf, tisk ?? null));
    const pole = poleZpravodaje(m, html, kat.id, obalka?.id ?? obsahPuvodni?.obrazek_id ?? null);
    if (obsahPuvodni && obsahId0) pole.slug = obsahPuvodni.slug;
    const zverejnit = m.zverejnit !== false;
    const id = await app.web.obsah.uloz(
      obsahId0,
      'aktualita',
      pole,
      zverejnit ? 'zverejnit' : 'koncept',
      nahral,
      req.ip,
      {
        zdroj: 'zpravodaj',
      },
    );
    const externi = `${m.rocnik}-${m.cislo}`;
    if (!obsahId0)
      await app.db.updateTable('web_obsah').set({ externi_id: externi }).where('id', '=', id).execute();
    const zaznam = {
      obsah_id: id,
      vydano: m.vydano,
      obyvatel: m.evidence.obyvatel,
      evidence_k: m.evidence.k,
      metadata: JSON.stringify(m),
      pdf_id: pdf.id,
      pdf_tisk_id: tisk?.id ?? null,
      obalka_id: obalka?.id ?? puvodni?.obalka_id ?? null,
      upraveno_at: new Date(),
    };
    if (puvodni) await app.db.updateTable('web_zpravodaj').set(zaznam).where('id', '=', puvodni.id).execute();
    else
      await app.db
        .insertInto('web_zpravodaj')
        .values({ rocnik: m.rocnik, cislo: m.cislo, ...zaznam })
        .execute();

    const akce = await akceZeZpravodaje(app, m, nahral);
    let o = (await app.web.obsah.podleId(id))!;
    // rozeslání jen jednou (opakované odeslání čísla nerozesílá znovu) a jen s oprávněním infokanálu
    let rozeslano: { hlaseni_id: string; prijemcu: number } | null = null;
    let poznamka: string | undefined;
    if (m.rozeslat && app.obec.moduly.infokanal) {
      if (!req.apiToken?.rozsahy.includes('infokanal:rozeslat'))
        poznamka = 'Nerozesláno: token nemá rozsah infokanal:rozeslat.';
      else if (o.stav !== 'zverejneno') poznamka = 'Nerozesláno: číslo je jen koncept.';
      else if (o.hlaseni_id) poznamka = 'Nerozesláno znovu: číslo už bylo rozesláno.';
      else {
        const v = await rozesliPrispevek(app, o, {
          aktorId: nahral,
          ip: req.ip,
          sms: false,
          zdroj: 'api:zpravodaj',
        });
        if ('chyba' in v) poznamka = `Nerozesláno: ${v.chyba}.`;
        else rozeslano = { hlaseni_id: v.id, prijemcu: v.prijemcu };
        o = (await app.web.obsah.podleId(id))!;
      }
    }
    await audit(req, puvodni ? 'api.zpravodaj_upraven' : 'api.zpravodaj', {
      id,
      rocnik: m.rocnik,
      cislo: m.cislo,
    });
    const out = await vystupPrispevku(app, o);
    return reply.code(puvodni ? 200 : 201).send({
      id,
      url: out.url,
      stav: o.stav === 'zverejneno' ? 'zverejneno' : 'koncept',
      aktualizovano: !!puvodni,
      soubory: {
        pdf: `${app.env.BASE_URL}${urlSouboru(pdf)}`,
        ...(tisk ? { pdf_tisk: `${app.env.BASE_URL}${urlSouboru(tisk)}` } : {}),
        ...(obalka ? { obalka: `${app.env.BASE_URL}${urlSouboru(obalka)}` } : {}),
      },
      akce,
      rozeslano,
      ...(poznamka ? { poznamka } : {}),
    });
  });
}
