import { describe, expect, it } from 'vitest';
import { vyberPrijemce, type VyberVolby } from '../src/moduly/infokanal/sluzba.js';

const kat = {
  povinna: { id: 1, slug: 'hlaseni', nazev: 'Obecná', povinna: true, poradi: 1 },
  volna: { id: 2, slug: 'kultura', nazev: 'Kultura', povinna: false, poradi: 2 },
};
const ted = new Date();
const odberatele: VyberVolby['odberatele'] = [
  {
    id: 'a',
    telefon: '+420777000001',
    email: 'a@x.cz',
    cast_obce: 'Testov',
    kanal: 'smisene',
    overen_at: ted,
    odhlasen_at: null,
  },
  {
    id: 'b',
    telefon: '+420777000002',
    email: null,
    cast_obce: 'Testov',
    kanal: 'sms',
    overen_at: ted,
    odhlasen_at: null,
  },
  {
    id: 'c',
    telefon: '+420777000003',
    email: 'c@x.cz',
    cast_obce: 'Dolní Testov',
    kanal: 'email',
    overen_at: ted,
    odhlasen_at: null,
  },
  {
    id: 'd',
    telefon: '+420777000004',
    email: null,
    cast_obce: 'Testov',
    kanal: 'sms',
    overen_at: null,
    odhlasen_at: null,
  },
  {
    id: 'e',
    telefon: '+420777000005',
    email: 'e@x.cz',
    cast_obce: 'Testov',
    kanal: 'sms',
    overen_at: ted,
    odhlasen_at: ted,
  },
];
const zaklad = (p: Partial<VyberVolby>): VyberVolby => ({
  kategorie: kat.povinna,
  odberatele,
  optouty: [],
  cil: 'vse',
  cilDetail: [],
  maSms: true,
  maEmail: true,
  krizove: false,
  ...p,
});

describe('výběr příjemců', () => {
  it('neověřené a odhlášené vynechá, kanál dle preference', () => {
    const v = vyberPrijemce(zaklad({}));
    expect(v.map((p) => `${p.odberatelId}:${p.kanal}`)).toEqual(['a:sms', 'b:sms', 'c:email']);
  });
  it('smíšená preference: nedůležité e-mailem', () => {
    const v = vyberPrijemce(zaklad({ kategorie: kat.volna }));
    expect(v.find((p) => p.odberatelId === 'a')?.kanal).toBe('email');
  });
  it('krizové: oba kanály všem bez ohledu na preference', () => {
    const v = vyberPrijemce(zaklad({ krizove: true }));
    expect(v).toHaveLength(5);
    expect(
      v
        .filter((p) => p.odberatelId === 'c')
        .map((p) => p.kanal)
        .sort(),
    ).toEqual(['email', 'sms']);
  });
  it('opt-out platí jen u odhlásitelných kategorií', () => {
    const optouty = [{ odberatel_id: 'b', kategorie_id: 2 }];
    expect(vyberPrijemce(zaklad({ kategorie: kat.volna, optouty })).some((p) => p.odberatelId === 'b')).toBe(
      false,
    );
    expect(
      vyberPrijemce(
        zaklad({ kategorie: kat.povinna, optouty: [{ odberatel_id: 'b', kategorie_id: 1 }] }),
      ).some((p) => p.odberatelId === 'b'),
    ).toBe(true);
  });
  it('cílení na části obce', () => {
    const v = vyberPrijemce(zaklad({ cil: 'casti', cilDetail: ['Dolní Testov'] }));
    expect(v.map((p) => p.odberatelId)).toEqual(['c']);
  });
  it('jen SMS verze: e-mailový odběratel dostane SMS jako náhradu', () => {
    const v = vyberPrijemce(zaklad({ maEmail: false }));
    expect(v.find((p) => p.odberatelId === 'c')?.kanal).toBe('sms');
  });
  it('SMS jen bez e-mailu šetří SMS', () => {
    const v = vyberPrijemce(zaklad({ smsJenBezEmailu: true }));
    expect(v.find((p) => p.odberatelId === 'a')?.kanal).toBe('email');
    expect(v.find((p) => p.odberatelId === 'b')?.kanal).toBe('sms');
  });
  it('další kontakty bez duplicit', () => {
    const v = vyberPrijemce(zaklad({ dalsiKontakty: ['777000002', 'novy@x.cz', 'blbost'] }));
    expect(v.filter((p) => p.kontakt === '+420777000002')).toHaveLength(1);
    expect(v.some((p) => p.kontakt === 'novy@x.cz' && p.odberatelId === null)).toBe(true);
  });
});
