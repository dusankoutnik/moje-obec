import { describe, expect, it } from 'vitest';
import { overKontakt } from '../src/moduly/web/kontakt-obce.js';

describe('kontaktní údaje obce (administrace)', () => {
  const zaklad = {
    ulice: 'Vlastibořice 23',
    psc: '463 44',
    mesto: 'Sychrov',
    telefon: '+420 485 146 025',
    email: 'info@obec.cz',
    datova_schranka: 'de2bjp2',
    uredni_hodiny: '',
  };

  it('projde platný vstup a srovná úřední hodiny po řádcích', () => {
    const { k, chyby } = overKontakt({
      ...zaklad,
      uredni_hodiny: '  Pondělí 7:00 – 17:00 \r\n\r\nStředa 7:00 – 17:00 ',
    });
    expect(chyby).toEqual([]);
    expect(k.uredni_hodiny).toBe('Pondělí 7:00 – 17:00\nStředa 7:00 – 17:00');
  });

  it('odmítne chybějící adresu, špatné PSČ, e-mail a telefon', () => {
    const { chyby } = overKontakt({ ...zaklad, ulice: '', psc: '4634', email: 'neplatny', telefon: 'abc' });
    expect(chyby).toEqual(expect.arrayContaining(['adresa', 'psc', 'email', 'telefon']));
  });

  it('ořízne příliš dlouhé hodnoty a ohlásí je', () => {
    const { k, chyby } = overKontakt({ ...zaklad, mesto: 'x'.repeat(200) });
    expect(k.mesto.length).toBe(80);
    expect(chyby).toContain('mesto');
  });
});
