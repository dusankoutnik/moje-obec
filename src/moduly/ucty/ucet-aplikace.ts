// Stránka Můj účet: čtení a zápis do aplikace rezervací po vnitřní síti (APLIKACE_REZERVACE_URL, x-api-secret =
// INTERNI_API_SECRET). Tvar dat je stejný, jaký četl MůjÚčet (GET /api/sso/summary/:cislo, /api/sso/platby/:cislo,
// POST /api/sso/ekey/:cislo). Aplikace neodpoví → null (karta ukáže „teď nedostupné“, zbytek stránky funguje).

export interface SouhrnRezervaci {
  reservations: number;
  unpaidInvoices: number;
  trips: number;
  ridesGiven: number;
  accesses: string[];
  ekeyEmail: string | null;
  ekeyWait: { account: string; noAccount: boolean; message: string | null } | null;
  /** doplněno 2026-10-22 (starší rezervace je neposílají) */
  gymStatus?: 'none' | 'requested' | 'active';
  upcoming?: { datum: string; iso: string; cas: string; co: string; ucel: string; ceka: boolean }[];
}

export interface PlatbyRezervaci {
  mesic: {
    obdobi: string;
    polozky: {
      datum: string;
      cas: string;
      co: string;
      ucel: string;
      cena: number;
      ceka: boolean;
      probehla: boolean;
      vyzva?: string | null;
    }[];
    soucet: number;
    cekajici: number;
  };
  /** minulý měsíc: všechny rezervace a stav výzvy za něj (starší rezervace API nemusí posílat) */
  minulyMesic?: {
    obdobi: string;
    polozky: PlatbyRezervaci['mesic']['polozky'];
    soucet: number;
    vyzvaTermin: string;
    vyzva: PlatbyRezervaci['vyuctovani'][number] | null;
  };
  vyuctovani: {
    polozky?: { datum: string; popis: string; rozsah: string; cena: string }[];
    cislo: string;
    obdobi: string;
    castka: number;
    vystaveno: string;
    splatnost: string;
    zaplaceno: string | null;
    poSplatnosti: boolean;
    pdf: string;
    potvrzeni: string | null;
    platba: string | null;
  }[];
  predprodej: {
    akce: string;
    datum: string;
    pocet: number;
    castka: number;
    vs: string;
    stav: string;
    zaplatitDo: string | null;
    zaplaceno: string | null;
    odkaz: string;
  }[];
}

export interface VysledekEklice {
  ok: boolean;
  error?: string;
  unchanged?: boolean;
  ekey?: { status: string; noAccount: boolean; message: string };
}

export class AplikaceRezervaci {
  constructor(
    private url: string | undefined,
    private tajemstvi: string | undefined,
    private timeoutMs = 4000,
  ) {}

  get nastavena(): boolean {
    return !!this.url && !!this.tajemstvi;
  }

  private async volej<T>(cesta: string, init: { method?: string; body?: unknown } = {}): Promise<T | null> {
    if (!this.nastavena) return null;
    try {
      const r = await fetch(this.url!.replace(/\/$/, '') + cesta, {
        method: init.method ?? 'GET',
        headers: {
          'x-api-secret': this.tajemstvi!,
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // eKlíč vrací 400 s vysvětlením (neplatný e-mail) — to je odpověď, ne výpadek
      if (!r.ok && !(r.status === 400 && init.method === 'POST')) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  }

  souhrn(cislo: number) {
    return this.volej<SouhrnRezervaci>(`/api/sso/summary/${cislo}`);
  }

  platby(cislo: number) {
    return this.volej<PlatbyRezervaci>(`/api/sso/platby/${cislo}`);
  }

  eklic(cislo: number, email: string) {
    return this.volej<VysledekEklice>(`/api/sso/ekey/${cislo}`, { method: 'POST', body: { email } });
  }

  /** po změně profilu (telefon) srovnat zrcadlo účtu v rezervacích hned */
  propis(cislo: number) {
    return this.volej<{ ok: boolean }>(`/api/sso/mirror/${cislo}`, { method: 'POST', body: {} });
  }
}
