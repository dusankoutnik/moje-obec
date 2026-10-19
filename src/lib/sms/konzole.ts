// Poskytovatel „konzole“ — nic neposílá, jen loguje. Pro vývoj a testy.
import type { Logger } from '../logger.js';
import type { SmsPoskytovatel, StavDoruceni, VysledekOdeslani } from './typy.js';

export class KonzoleSms implements SmsPoskytovatel {
  readonly nazev = 'konzole';
  /** poslední odeslané zprávy (testy je čtou) */
  readonly odeslane: { telefon: string; text: string; id: string }[] = [];
  private citac = 0;

  constructor(private log?: Logger) {}

  async posli(telefon: string, text: string): Promise<VysledekOdeslani> {
    const id = `konzole-${++this.citac}`;
    this.odeslane.push({ telefon, text, id });
    if (this.odeslane.length > 200) this.odeslane.shift();
    this.log?.info({ sms: { telefon, text, id } }, 'SMS (konzole, neodesláno)');
    return { branaId: id, segmentu: 1 };
  }

  async stavDoruceni(): Promise<StavDoruceni> {
    return 'doruceno';
  }
}
