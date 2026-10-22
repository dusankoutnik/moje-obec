// Klient admin API aplikací obce za proxy (rezervace, eKnihy) — náhrada `rez()`/`appGet()` z MujÚčtu.
// Volá se po vnitřní síti napřímo (APLIKACE_*_URL), hlavička x-api-secret (APLIKACE_API_SECRET, jinak
// INTERNI_API_SECRET). Krátký timeout: dashboard Správy nesmí čekat na spící aplikaci — nedostupná = null.

export interface SouhrnRezervaci {
  users: number;
  pending: number;
  gymRequested: number;
  unpaid: { c: number; s: number };
  future: number;
  trips: number;
  tickets: { paid: number; held: number; onsite: number };
}

export interface ZadostRezervace {
  id: number;
  series: boolean;
  heading: string;
  detail: string;
}
export interface ZadostPosilovna {
  id: number;
  heading: string;
  detail: string;
}
export interface Schvalovani {
  reservations: ZadostRezervace[];
  gym: ZadostPosilovna[];
}

export interface StatistikyEknih {
  knih?: number;
  knih_cs?: number;
  stazeni_celkem?: number;
  stazeni_30d?: number;
  stahujicich_30d?: number;
  ctenaru_online?: number;
  rozectenych?: number;
  oblibenych?: number;
  predcitani_min_30d?: number;
  predcitajicich_30d?: number;
  /** názvy nejstahovanějších knih (jediné konkrétní položky — žádná jména lidí) */
  top_30d?: { id: number; title: string; author?: string | null; n: number }[];
  police?: { slug: string; nazev: string; n: number }[];
}

export interface Odpoved<T> {
  status: number;
  data: T | null;
}

export class AplikaceKlient {
  constructor(
    private base: string | undefined,
    private tajemstvi: string | undefined,
    private timeoutMs = 4000,
  ) {}

  /** je aplikace na této instalaci nastavená (adresa + klíč)? */
  get nastavena(): boolean {
    return !!(this.base && this.tajemstvi);
  }

  private async volej<T>(cesta: string, init: RequestInit = {}): Promise<Odpoved<T> | null> {
    if (!this.nastavena) return null;
    try {
      const r = await fetch(this.base!.replace(/\/$/, '') + cesta, {
        ...init,
        headers: {
          accept: 'application/json',
          'x-api-secret': this.tajemstvi!,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await r.text();
      let data: T | null = null;
      try {
        data = text ? (JSON.parse(text) as T) : null;
      } catch {
        data = null;
      }
      return { status: r.status, data };
    } catch {
      return null;
    }
  }

  /** GET — vrátí data jen při 2xx, jinak null (nedostupná aplikace, špatný klíč) */
  async get<T>(cesta: string): Promise<T | null> {
    const o = await this.volej<T>(cesta);
    return o && o.status >= 200 && o.status < 300 ? o.data : null;
  }

  async post<T>(cesta: string, telo: unknown): Promise<Odpoved<T> | null> {
    return this.volej<T>(cesta, { method: 'POST', body: JSON.stringify(telo) });
  }
}

/** rezervace: souhrn pro dlaždice, čekající žádosti a jejich vyřízení */
export class RezervaceAdmin {
  constructor(readonly klient: AplikaceKlient) {}

  souhrn() {
    return this.klient.get<SouhrnRezervaci>('/api/admin/summary');
  }

  schvalovani() {
    return this.klient.get<Schvalovani>('/api/admin/approvals');
  }

  /** potvrdit/zamítnout žádost (série celá najednou); actorId = číslo účtu (= id uživatele v rezervacích) */
  async vyridRezervaci(
    id: number,
    v: { akce: 'potvrdit' | 'zamitnout'; pozn: string; celaSerie: boolean; cislo: number },
  ): Promise<{ ok: boolean; chyba?: string }> {
    const o = await this.klient.post<{ ok?: boolean; error?: string }>(
      `/api/admin/approvals/reservation/${id}`,
      {
        action: v.akce,
        pozn: v.pozn,
        celaSerie: v.celaSerie,
        actorId: v.cislo,
      },
    );
    if (!o) return { ok: false };
    return { ok: !!o.data?.ok, chyba: o.data?.error };
  }

  async aktivujPosilovnu(uid: number, cislo: number): Promise<{ ok: boolean; chyba?: string }> {
    const o = await this.klient.post<{ ok?: boolean; error?: string }>(`/api/admin/approvals/gym/${uid}`, {
      actorId: cislo,
    });
    if (!o) return { ok: false };
    return { ok: !!o.data?.ok, chyba: o.data?.error };
  }
}
