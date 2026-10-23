// Strojový popis API (OpenAPI 3.1), psaný ručně podle v1.ts — při změně endpointu upravit i tady a na stránce /api.
const CHYBA = { $ref: '#/components/schemas/Chyba' };
const odp = (popis: string, schema: unknown = { type: 'object' }) => ({
  description: popis,
  content: { 'application/json': { schema } },
});
const CHYBY = {
  '400': odp('Neplatná data (pole `pole` říká které)', CHYBA),
  '401': odp('Chybí nebo neplatný token', CHYBA),
  '403': odp('Token nemá potřebné oprávnění', CHYBA),
  '413': odp('Soubor nebo požadavek je příliš velký', CHYBA),
  '429': odp('Překročen limit požadavků', CHYBA),
};

const PRISPEVEK_VSTUP = {
  type: 'object',
  properties: {
    typ: { type: 'string', enum: ['aktualita', 'akce', 'stranka'], default: 'aktualita' },
    titulek: { type: 'string', maxLength: 250 },
    perex: { type: 'string', maxLength: 600 },
    html: { type: 'string', description: 'HTML textu (sanitizuje se); nebo `markdown`' },
    markdown: { type: 'string' },
    kategorie: { type: 'string', description: 'slug nebo id kategorie webu (GET /api/v1/kategorie)' },
    datum: { type: 'string', description: 'aktualita: YYYY-MM-DD, YYYY-MM-DDTHH:MM (Praha) nebo ISO 8601' },
    akce_od: { type: 'string', description: 'akce: začátek (YYYY-MM-DD = celý den)' },
    akce_do: { type: 'string' },
    akce_cely_den: { type: 'boolean' },
    misto: { type: 'string', maxLength: 200 },
    v_aktualitach: { type: 'boolean', description: 'akce se ukáže i v Aktualitách jako pozvánka' },
    v_menu: { type: 'boolean', description: 'stránka v menu (výchozí ne)' },
    slug: { type: 'string' },
    obrazek_id: { type: 'string', format: 'uuid' },
    obrazek_alt: { type: 'string', description: 'popis úvodního obrázku — povinný před zveřejněním' },
    prilohy_id: { type: 'array', items: { type: 'string', format: 'uuid' } },
    zverejnit: { type: 'boolean', description: 'true = zveřejnit, false/vynecháno = koncept' },
    zdroj: { type: 'string', default: 'api', description: 'jméno vašeho systému (pro idempotenci)' },
    externi_id: { type: 'string', description: 'id záznamu u vás; stejný zdroj + externi_id = úprava' },
  },
};
const PRISPEVEK_MULTIPART = {
  allOf: [
    PRISPEVEK_VSTUP,
    {
      type: 'object',
      properties: {
        obrazek: { type: 'string', format: 'binary' },
        prilohy: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
    },
  ],
};
const PRISPEVEK = { $ref: '#/components/schemas/Prispevek' };

export function openapi(baseUrl: string, nazevObce: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: `API webu — ${nazevObce}`,
      version: '1.0.0',
      description:
        'Zápis příspěvků, úřední desky a zpravodaje na web obce (Obecní web od Voltu 2.0). Lidský popis: ' +
        baseUrl +
        '/api',
      license: { name: 'EUPL-1.2', identifier: 'EUPL-1.2' },
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ token: [] }],
    components: {
      securitySchemes: {
        token: { type: 'http', scheme: 'bearer', description: 'Token ze Správa → API a integrace' },
      },
      schemas: {
        Chyba: {
          type: 'object',
          required: ['chyba'],
          properties: { chyba: { type: 'string' }, pole: { type: 'string' } },
        },
        Prispevek: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            typ: { type: 'string' },
            titulek: { type: 'string' },
            slug: { type: 'string' },
            stav: { type: 'string', enum: ['koncept', 'zverejneno'] },
            rozpracovana_zmena: { type: 'boolean' },
            url: { type: 'string' },
            sprava_url: { type: 'string' },
            zdroj: { type: 'string' },
            externi_id: { type: ['string', 'null'] },
            kategorie: { type: ['string', 'null'] },
            datum: { type: ['string', 'null'] },
            akce_konec: { type: ['string', 'null'] },
            hlaseni_id: { type: ['string', 'null'] },
            aktualizovano: { type: 'boolean' },
          },
        },
        ZpravodajMetadata: {
          type: 'object',
          required: ['rocnik', 'cislo', 'vydano', 'perex', 'evidence'],
          description: 'viz docs/ZPRAVODAJ-API.md',
          properties: {
            rocnik: { type: 'integer' },
            cislo: { type: 'integer' },
            titulek: { type: 'string' },
            vydano: { type: 'string', format: 'date' },
            obdobi: { type: 'string' },
            perex: { type: 'string' },
            obsah: {
              type: 'array',
              items: {
                type: 'object',
                properties: { strana: { type: 'integer' }, nadpis: { type: 'string' } },
              },
            },
            evidence: {
              type: 'object',
              required: ['k', 'obyvatel'],
              properties: { k: { type: 'string', format: 'date' }, obyvatel: { type: 'integer' } },
            },
            hospodareni: { type: 'object' },
            akce: { type: 'array', items: { type: 'object' } },
            tiraz: { type: 'object', additionalProperties: { type: 'string' } },
            zverejnit: { type: 'boolean', default: true },
            rozeslat: { type: 'boolean', default: false },
          },
        },
      },
    },
    paths: {
      '/kategorie': {
        get: {
          summary: 'Kategorie webu, úřední desky a infokanálu',
          responses: { '200': odp('Seznamy kategorií'), ...CHYBY },
        },
      },
      '/prispevky': {
        get: {
          summary: 'Hledání příspěvků (např. podle zdroje a externího id)',
          parameters: ['zdroj', 'externi_id', 'typ', 'limit'].map((n) => ({
            name: n,
            in: 'query',
            schema: { type: 'string' },
          })),
          responses: {
            '200': odp('Seznam', {
              type: 'object',
              properties: { polozky: { type: 'array', items: PRISPEVEK } },
            }),
            ...CHYBY,
          },
        },
        post: {
          summary: 'Založení příspěvku (nebo úprava při stejném zdroji + externi_id)',
          requestBody: {
            content: {
              'application/json': { schema: PRISPEVEK_VSTUP },
              'multipart/form-data': { schema: PRISPEVEK_MULTIPART },
            },
          },
          responses: {
            '201': odp('Založeno', PRISPEVEK),
            '200': odp('Upraveno (idempotence)', PRISPEVEK),
            '409': odp('Konflikt typu', CHYBA),
            ...CHYBY,
          },
        },
      },
      '/prispevky/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        get: {
          summary: 'Detail příspěvku',
          responses: { '200': odp('Příspěvek', PRISPEVEK), '404': odp('Nenalezeno', CHYBA), ...CHYBY },
        },
        patch: {
          summary: 'Úprava příspěvku založeného přes API (jen poslaná pole)',
          requestBody: {
            content: {
              'application/json': { schema: PRISPEVEK_VSTUP },
              'multipart/form-data': { schema: PRISPEVEK_MULTIPART },
            },
          },
          responses: { '200': odp('Upraveno', PRISPEVEK), '404': odp('Nenalezeno', CHYBA), ...CHYBY },
        },
      },
      '/prispevky/{id}/rozeslat': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        post: {
          summary: 'Rozeslání zveřejněného příspěvku infokanálem (rozsah infokanal:rozeslat)',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { sms: { type: 'boolean', default: false }, kategorie: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '202': odp('Hlášení založeno', {
              type: 'object',
              properties: { hlaseni_id: { type: 'string' }, prijemcu: { type: 'integer' } },
            }),
            '409': odp('Příspěvek není zveřejněný', CHYBA),
            ...CHYBY,
          },
        },
      },
      '/soubory': {
        post: {
          summary: 'Nahrání dokumentu nebo obrázku (text a OCR pro vyhledávání se zpracují na pozadí)',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['soubor'],
                  properties: { soubor: { type: 'string', format: 'binary' }, alt: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '201': odp('Uloženo', {
              type: 'object',
              properties: { id: { type: 'string' }, url: { type: 'string' } },
            }),
            ...CHYBY,
          },
        },
      },
      '/deska': {
        post: {
          summary: 'Vyvěšení dokumentu na úřední desku (zákonné lhůty se kontrolují)',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['nazev', 'kategorie'],
                  properties: {
                    nazev: { type: 'string' },
                    kategorie: { type: 'string' },
                    vyveseno_od: { type: 'string', format: 'date' },
                    vyveseno_do: { type: 'string', format: 'date' },
                    do_odvolani: { type: 'boolean' },
                    popis: { type: 'string' },
                    cislo_jednaci: { type: 'string' },
                    puvodce: { type: 'string' },
                    typ_rozpoctu: { type: 'string' },
                    rok: { type: 'integer' },
                    potvrdit_nahrazeni: { type: 'boolean' },
                    prilohy: { type: 'array', items: { type: 'string', format: 'binary' } },
                  },
                },
              },
            },
          },
          responses: {
            '201': odp('Vyvěšeno'),
            '409': odp('Sejmul by starší rozpočtové dokumenty — potvrďte', CHYBA),
            ...CHYBY,
          },
        },
      },
      '/zpravodaj': {
        post: {
          summary: 'Nové číslo obecního zpravodaje (stejný ročník + číslo = úprava)',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['metadata', 'pdf'],
                  properties: {
                    metadata: { $ref: '#/components/schemas/ZpravodajMetadata' },
                    pdf: { type: 'string', format: 'binary' },
                    pdf_tisk: { type: 'string', format: 'binary' },
                    obalka: { type: 'string', format: 'binary' },
                  },
                },
                encoding: { metadata: { contentType: 'application/json' } },
              },
            },
          },
          responses: { '201': odp('Založeno'), '200': odp('Upraveno'), ...CHYBY },
        },
      },
    },
  };
}
