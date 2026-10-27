// Čtení access logů reverzní proxy (formát Nginx Proxy Manageru) a jejich agregace na denní počty po sekcích webu.
// Převzato z návštěvnosti MůjÚčtu: robot = User-Agent podle BOT_RE, vlastní server, víc než 200 stránek za den,
// nebo klient (IP + prohlížeč), který za den zobrazil stránku a nenačetl jediný CSS/JS/obrázek/písmo (prohlížeč je
// načte vždy — takhle se pozná scraper s podvrženým UA rozprostřený na tisíce adres). Cena: opakovaný návštěvník
// s plnou keší se ten den nepočítá. IP adresy a prohlížeče žijí jen v paměti během přepočtu, nikam se neukládají.
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

export const SEKCE = ['web', 'infokanal', 'ucet', 'rezervace', 'spolujizda', 'eknihy'] as const;
export type Sekce = (typeof SEKCE)[number];

// [26/Oct/2026:18:04:36 +0000] - 200 200 - GET https example.cz "/cesta" [Client 1.2.3.4] [Length 1] [Gzip -] [Sent-to x] "UA" "referer"
const RADEK_RE =
  /^\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] - (\S+) (\S+) - (\S+) (\S+) (\S+) "([^"]*)" \[Client ([^\]]+)\] \[Length [^\]]*\] \[Gzip [^\]]*\] \[Sent-to [^\]]*\] "([^"]*)"/;
const MESICE: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

export const BOT_RE =
  /bot|crawl|spider|slurp|fetch|facebookexternalhit|curl\/|wget|python|go-http|httpclient|headless|scan|monitor|preview|validator|lighthouse|semrush|ahrefs|mj12|dotbot|petal|bytespider|gptbot|claudebot|ccbot|amazonbot|applebot|yandex|bingpreview|duckduck|archive\.org|dataforseo|censys|zgrab|masscan|java\/|okhttp|libwww|node-fetch|axios|uptime|pingdom|statuscake|feed|rss|whatsapp|telegram|discord|slack|twitter|skype|linkedin|pinterest|embedly|quora|outbrain|vkshare|w3c_|nmap|nikto|sqlmap|wpscan|^-?$/i;
/** soubory, které načítá prohlížeč se stránkou (důkaz, že jde o člověka s prohlížečem) */
const ASSET_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|ico)$/i;
/** ostatní statické soubory (nejsou stránka ani dokument) */
const STATIKA_RE = /\.(map|bmp|otf|eot|json|xml|txt|mp3|mp4|webm|ogg|wav|zip|gz|csv|webmanifest|kml|gpx)$/i;
/** dokumenty — počítají se jako stažení, ne zobrazení stránky */
const DOKUMENT_RE = /\.(pdf|epub|mobi|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
/** cesty, které nejsou stránkou pro veřejnost: administrace, API, přihlašovací technika, starý WordPress */
const VYNECHAT_RE =
  /^\/(api|sprava|administrace|oidc|healthz|webhook|velikost|odhlaseni|prihlaseni\/callback|\.well-known|wp-[a-z-]+|xmlrpc\.php|favicon|robots\.txt|sitemap|manifest|apple-touch|ikona-)|^\/(rezervace|eknihy)\/(api|admin|_app|prihlaseni|odhlaseni)(\/|$)|^\/infokanal\/sprava(\/|$)/;
/** statika platformy a aplikací za proxy, obrázky z úložiště */
const STATIKA_CESTA_RE = /^\/(static|soubory)\/|^\/(rezervace|eknihy)\/static\//;
const FEED_RE = /(^|\/)(feed|rss|atom|rss\.xml)$/;

const PRIVATNI_IP_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;

const fmtDen = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** den v českém čase (YYYY-MM-DD) */
export function denPraha(d: Date): string {
  return fmtDen.format(d);
}

/** sekce webu podle cesty (aplikace za proxy platformy mají vlastní sekci) */
export function sekceCesty(cesta: string): Sekce {
  if (/^\/rezervace\/spolujizda(\/|$)/.test(cesta)) return 'spolujizda';
  if (/^\/rezervace(\/|$)/.test(cesta)) return 'rezervace';
  if (/^\/eknihy(\/|$)/.test(cesta)) return 'eknihy';
  if (/^\/infokanal(\/|$)/.test(cesta)) return 'infokanal';
  if (/^\/(ucet|prihlaseni)(\/|$)/.test(cesta)) return 'ucet';
  return 'web';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Cesta bez dotazu, kotvy a koncového lomítka, malými písmeny, s identifikátory a tokeny nahrazenými zástupci
 * (`:id`, `:token`) — ve statistice tak nezůstane token objednávky, platby ani číslo záznamu. Výjimky: dokument
 * úřední desky (veřejný, statistika ho ukáže s názvem) a archiv starého WordPressu `/rok/měsíc/článek`.
 */
export function normalizujCestu(puvodni: string): string {
  let c = puvodni.split('?')[0]!.split('#')[0]!;
  try {
    c = decodeURIComponent(c);
  } catch {
    /* ponechat */
  }
  c = c.toLowerCase().replace(/\/{2,}/g, '/');
  if (!c.startsWith('/')) c = '/' + c;
  if (c.length > 1) c = c.replace(/\/+$/, '');
  const casti = c.split('/').slice(1);
  const deska = casti[0] === 'uredni-deska' && casti.length === 2;
  const wpArchiv = /^(19|20)\d{2}$/.test(casti[0] ?? '') && /^\d{2}$/.test(casti[1] ?? '');
  const nove = casti.map((s, i) => {
    if (wpArchiv && i < 2) return s;
    if (/^\d+$/.test(s)) return ':id';
    if (UUID_RE.test(s)) return deska && i === 1 ? s : ':id';
    if (/^[0-9a-f]{16,}$/.test(s) || (s.length >= 24 && /\d/.test(s) && /^\w+$/.test(s))) return ':token';
    return s;
  });
  c = '/' + nove.join('/');
  return c.length > 200 ? c.slice(0, 199) + '…' : c;
}

/** jedno zařízení (IP + prohlížeč) za den — jen v paměti */
interface Klient {
  robotUa: boolean;
  pozadavky: Map<Sekce, number>;
  stranek: number;
  assetu: number;
  stranky: Map<string, number> | null; // `${sekce} ${cesta}` → počet
  stazeni: Map<Sekce, number> | null;
}

export interface StrankaDne {
  cesta: string;
  zobrazeni: number;
  navstevnici: number;
}
/** souhrnný řádek celého webu (návštěvník dvou sekcí se v něm počítá jednou) */
export const CELKEM = 'celkem';

export interface DenSekce {
  den: string;
  sekce: Sekce | typeof CELKEM;
  zobrazeni: number;
  navstevnici: number;
  stazeni: number;
  pozadavky: number;
  boti: number;
  stranky: StrankaDne[];
}

function predchoziDen(den: string): string {
  const [r, m, d] = den.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(r, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function jeRobot(k: { robotUa: boolean; stranek: number; assetu: number }): boolean {
  return k.robotUa || k.stranek > 200 || (k.stranek >= 1 && k.assetu === 0);
}

export class Agregator {
  /** den → klíč klienta → klient */
  private dny = new Map<string, Map<string, Klient>>();
  /** uzavřené dny (spočítané a uvolněné z paměti) */
  private hotove: DenSekce[] = [];
  private uzavrene = new Set<string>();
  private nejnovejsi = '';
  private vlastniIp: Set<string>;
  radku = 0;
  rozpoznanych = 0;
  /** řádky dne, který už byl uzavřený (log mimo chronologické pořadí) — zahazují se */
  pozdnich = 0;

  /**
   * Logy se čtou chronologicky (nejstarší archiv první), takže den, který je o víc než jeden den starší než
   * nejnovější viděný řádek, je kompletní: spočítá se a jeho klienti (IP + prohlížeč) se z paměti zahodí.
   * V paměti jsou tak nejvýš dva dny klientů, ne celé týdny.
   */
  constructor(
    vlastniIp: string[] = [],
    private top = 60,
  ) {
    this.vlastniIp = new Set(vlastniIp.map((s) => s.trim()).filter(Boolean));
  }

  pridej(radek: string): void {
    this.radku++;
    const m = RADEK_RE.exec(radek);
    if (!m) return;
    this.rozpoznanych++;
    const [, dd, mes, rrrr, hh, mi, ss, tz, , status, metoda, , , cestaRaw, ip, ua] =
      m as unknown as string[];
    const posun = (Number(tz!.slice(1, 3)) * 60 + Number(tz!.slice(3, 5))) * (tz![0] === '-' ? -1 : 1);
    const cas =
      Date.UTC(Number(rrrr), MESICE[mes!] ?? 0, Number(dd), Number(hh), Number(mi), Number(ss)) -
      posun * 60_000;
    const den = fmtDen.format(new Date(cas));
    if (this.uzavrene.has(den)) {
      this.pozdnich++;
      return;
    }
    let klienti = this.dny.get(den);
    if (!klienti) {
      this.dny.set(den, (klienti = new Map()));
      if (den > this.nejnovejsi) {
        this.nejnovejsi = den;
        for (const d of [...this.dny.keys()]) if (d < den && d !== predchoziDen(den)) this.uzavri(d);
      }
    }
    const klic = `${ip}|${ua}`;
    let k = klienti.get(klic);
    if (!k) {
      k = {
        robotUa: BOT_RE.test(ua!) || this.vlastniIp.has(ip!) || PRIVATNI_IP_RE.test(ip!),
        pozadavky: new Map(),
        stranek: 0,
        assetu: 0,
        stranky: null,
        stazeni: null,
      };
      klienti.set(klic, k);
    }
    const cesta = cestaRaw!.split('?')[0]!;
    const sekce = sekceCesty(cesta);
    k.pozadavky.set(sekce, (k.pozadavky.get(sekce) ?? 0) + 1);
    if (k.robotUa) return;
    if (ASSET_RE.test(cesta)) {
      k.assetu++;
      return;
    }
    const uspech = status === '304' || (/^2\d\d$/.test(status!) && status !== '206');
    if (metoda !== 'GET' || !uspech) return;
    if (DOKUMENT_RE.test(cesta)) {
      if (!k.stazeni) k.stazeni = new Map();
      k.stazeni.set(sekce, (k.stazeni.get(sekce) ?? 0) + 1);
      return;
    }
    if (STATIKA_CESTA_RE.test(cesta)) {
      k.assetu++;
      return;
    }
    if (
      STATIKA_RE.test(cesta) ||
      VYNECHAT_RE.test(cesta) ||
      FEED_RE.test(cesta) ||
      /[?&]feed=/.test(cestaRaw!)
    )
      return;
    k.stranek++;
    if (!k.stranky) k.stranky = new Map();
    const kl = `${sekce} ${normalizujCestu(cesta)}`;
    k.stranky.set(kl, (k.stranky.get(kl) ?? 0) + 1);
  }

  /** dny, které log obsahuje */
  get dnyVLogu(): string[] {
    return [...new Set([...this.uzavrene, ...this.dny.keys()])].sort();
  }

  /** souhrny po dnech a sekcích (uzavře i zbylé dny); u stránek jen `top` nejnavštěvovanějších na den a sekci */
  vysledek(): DenSekce[] {
    for (const d of [...this.dny.keys()]) this.uzavri(d);
    return [...this.hotove].sort((a, b) => a.den.localeCompare(b.den) || a.sekce.localeCompare(b.sekce));
  }

  private uzavri(den: string): void {
    const klienti = this.dny.get(den);
    if (!klienti) return;
    this.dny.delete(den);
    this.uzavrene.add(den);
    {
      const sekce = new Map<Sekce | typeof CELKEM, { r: DenSekce; mapa: Map<string, StrankaDne> }>();
      const radek = (s: Sekce | typeof CELKEM) => {
        let x = sekce.get(s);
        if (!x) {
          x = {
            r: {
              den,
              sekce: s,
              zobrazeni: 0,
              navstevnici: 0,
              stazeni: 0,
              pozadavky: 0,
              boti: 0,
              stranky: [],
            },
            mapa: new Map(),
          };
          sekce.set(s, x);
        }
        return x;
      };
      for (const k of klienti.values()) {
        const robot = jeRobot(k);
        const celkem = radek(CELKEM).r;
        for (const [s, n] of k.pozadavky) {
          const { r } = radek(s);
          r.pozadavky += n;
          celkem.pozadavky += n;
          if (robot) {
            r.boti += n;
            celkem.boti += n;
          }
        }
        if (robot) continue;
        const navstivil = new Set<Sekce>();
        for (const [kl, n] of k.stranky ?? []) {
          const mezera = kl.indexOf(' ');
          const s = kl.slice(0, mezera) as Sekce;
          const cesta = kl.slice(mezera + 1);
          const { r, mapa } = radek(s);
          r.zobrazeni += n;
          celkem.zobrazeni += n;
          navstivil.add(s);
          const st = mapa.get(cesta) ?? { cesta, zobrazeni: 0, navstevnici: 0 };
          st.zobrazeni += n;
          st.navstevnici++;
          mapa.set(cesta, st);
        }
        for (const [s, n] of k.stazeni ?? []) {
          radek(s).r.stazeni += n;
          celkem.stazeni += n;
          navstivil.add(s);
        }
        for (const s of navstivil) radek(s).r.navstevnici++;
        if (navstivil.size) celkem.navstevnici++;
      }
      for (const { r, mapa } of sekce.values()) {
        r.stranky = [...mapa.values()]
          .sort((a, b) => b.zobrazeni - a.zobrazeni || a.cesta.localeCompare(b.cesta))
          .slice(0, this.top);
        this.hotove.push(r);
      }
    }
  }
}

/** vzory s * a ? (oddělené čárkou) → regulární výraz pro název souboru */
export function vzoryNaRegex(vzory: string): RegExp {
  const casti = vzory
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) =>
      v
        .split('')
        .map((z) => (z === '*' ? '.*' : z === '?' ? '.' : z.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join(''),
    );
  return new RegExp(`^(?:${casti.length ? casti.join('|') : '(?!)'})$`);
}

/** soubory logů v adresáři podle vzorů, chronologicky (chybějící adresář = žádné) */
export async function souboryLogu(adresar: string, vzory: string): Promise<string[]> {
  const re = vzoryNaRegex(vzory);
  const nazvy = await fs.readdir(adresar).catch(() => [] as string[]);
  // chronologicky: nejstarší archiv (nejvyšší číslo rotace) první, aktuální log poslední
  const poradi = (n: string) => Number(/\.(\d+)(\.gz)?$/.exec(n)?.[1] ?? 0);
  return nazvy
    .filter((n) => re.test(n))
    .sort((a, b) => poradi(b) - poradi(a) || a.localeCompare(b))
    .map((n) => path.join(adresar, n));
}

/** přečte soubor (i .gz) po řádcích do agregátoru — proudově, celý soubor nikdy není v paměti */
export async function prectiSoubor(soubor: string, agregator: Agregator): Promise<void> {
  const surovy = createReadStream(soubor);
  const vstup = soubor.endsWith('.gz') ? surovy.pipe(createGunzip()) : surovy;
  if (vstup !== surovy) surovy.on('error', (e) => vstup.destroy(e));
  const rl = readline.createInterface({ input: vstup, crlfDelay: Infinity });
  for await (const radek of rl) agregator.pridej(radek);
}
