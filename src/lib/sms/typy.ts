// Rozhraní poskytovatele SMS. Platforma musí jít nabídnout obcím s komerční bránou s API;
// konkrétní brána je jen konfigurace (SMS_PROVIDER v .env).

export type StavDoruceni = 'ceka' | 'odeslano' | 'doruceno' | 'selhalo' | 'nezjisteno';

export interface VysledekOdeslani {
  /** identifikátor zprávy u poskytovatele (pro doručenky); null, když ho brána nedává */
  branaId: string | null;
  /** počet započítaných SMS segmentů, pokud ho brána vrátí */
  segmentu?: number;
  /** cena, pokud ji brána vrátí (Kč) */
  cena?: number;
}

export interface SmsPoskytovatel {
  readonly nazev: string;
  /** Odešle jednu SMS. Text se posílá tak, jak je — o diakritice rozhoduje volající (bezDiakritiky). Při chybě vyhodí výjimku. */
  posli(telefonE164: string, text: string): Promise<VysledekOdeslani>;
  /** Dotaz na stav doručení (polling). Poskytovatel bez podpory vrací 'nezjisteno'. */
  stavDoruceni(branaId: string): Promise<StavDoruceni>;
  /**
   * Zpracování doručenky z webhooku (POST od brány). Vrací seznam změn stavů; poskytovatel bez webhooku vrací [].
   * Tělo je neověřená data z internetu — implementace musí ověřit podpis/tajemství, pokud ho brána nabízí.
   */
  zpracujWebhook?(
    telo: unknown,
    hlavicky: Record<string, string | string[] | undefined>,
  ): Promise<{ branaId: string; stav: StavDoruceni }[]>;
  /** Hromadné stažení doručenek (brány, které nemají dotaz na jednu zprávu, např. SMSbrána inbox). */
  stahniDorucenky?(): Promise<{ branaId: string; stav: StavDoruceni }[]>;
}

export class SmsChyba extends Error {
  constructor(
    message: string,
    public readonly docasna = false,
    /** brána řekla, za jak dlouho to zkusit znovu (Retry-After, ms) */
    public readonly zkusitZaMs?: number,
  ) {
    super(message);
    this.name = 'SmsChyba';
  }
}
