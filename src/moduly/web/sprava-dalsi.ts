// Správa dalšího obsahu webu: fotogalerie, dokumenty ke stažení, dotace, vzhled webu, kategorie aktualit
// a přesměrování. Každá část je v sprava-dalsi/*.ts; tady se jen registrují (videa jsou v sprava-videa.ts).
import type { FastifyInstance } from 'fastify';
import type { WebSluzby } from './index.js';
import webSpravaDokumenty from './sprava-dalsi/dokumenty.js';
import webSpravaDotace from './sprava-dalsi/dotace.js';
import webSpravaGalerie from './sprava-dalsi/galerie.js';
import webSpravaKategorie from './sprava-dalsi/kategorie.js';
import webSpravaPresmerovani from './sprava-dalsi/presmerovani.js';
import webSpravaVzhled from './sprava-dalsi/vzhled.js';

export default async function webSpravaDalsi(app: FastifyInstance, s: WebSluzby) {
  await webSpravaGalerie(app, s);
  await webSpravaDokumenty(app, s);
  await webSpravaDotace(app, s);
  await webSpravaVzhled(app, s);
  await webSpravaKategorie(app, s);
  await webSpravaPresmerovani(app, s);
}
