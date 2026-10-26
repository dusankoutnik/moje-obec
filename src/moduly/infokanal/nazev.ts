// Jak se modul infokanálu jmenuje navenek (menu, nadpisy, Můj účet, e-maily, administrace). Jediné místo, odkud
// název berou šablony (přes it.obec.texty.nazev_infokanalu, který přepisuje vykreslování v src/web/sablony.ts)
// i texty fronty a výstrah.
// Pořadí: Správa → Obecní web → Vzhled (nastaveni.web_vzhled.nazev_infokanalu) → obec.yml texty.nazev_infokanalu
// → výchozí „Hlášení obce“. Předpona SMS (texty.sms_prefix) je samostatné nastavení a tímhle se nemění.
import type { FastifyInstance } from 'fastify';

export const VYCHOZI_NAZEV_INFOKANALU = 'Hlášení obce';

export function nazevInfokanalu(app: FastifyInstance): string {
  const zeVzhledu = app.hasDecorator('web') ? app.web.vzhled.nazevInfokanaluTed() : '';
  return zeVzhledu || app.obec.texty.nazev_infokanalu.trim() || VYCHOZI_NAZEV_INFOKANALU;
}
