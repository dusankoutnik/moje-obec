import { describe, expect, it } from 'vitest';
import {
  bezDiakritiky,
  formatujTelefon,
  normalizujEmail,
  normalizujTelefon,
  rozpoznejKontakt,
  smsSegmenty,
} from '../src/lib/kontakty.js';

describe('normalizace telefonu', () => {
  it('převede české číslo na E.164', () => {
    expect(normalizujTelefon('777 123 456')).toBe('+420777123456');
    expect(normalizujTelefon('+420 777-123-456')).toBe('+420777123456');
    expect(normalizujTelefon('00420777123456')).toBe('+420777123456');
    expect(normalizujTelefon('+421905123456')).toBe('+421905123456');
  });
  it('odmítne nesmysl', () => {
    expect(normalizujTelefon('12345')).toBeNull();
    expect(normalizujTelefon('abc')).toBeNull();
    expect(normalizujTelefon('')).toBeNull();
    expect(normalizujTelefon(undefined)).toBeNull();
  });
  it('formátuje pro zobrazení', () => {
    expect(formatujTelefon('+420777123456')).toBe('+420 777 123 456');
    expect(formatujTelefon('+421905123456')).toBe('+421905123456');
  });
});

describe('e-mail a kontakt', () => {
  it('normalizuje e-mail na malá písmena', () => {
    expect(normalizujEmail(' Jana.Novakova@Example.CZ ')).toBe('jana.novakova@example.cz');
    expect(normalizujEmail('neni-email')).toBeNull();
  });
  it('rozpozná typ kontaktu', () => {
    expect(rozpoznejKontakt('777123456')).toEqual({ typ: 'telefon', hodnota: '+420777123456' });
    expect(rozpoznejKontakt('a@b.cz')).toEqual({ typ: 'email', hodnota: 'a@b.cz' });
    expect(rozpoznejKontakt('?')).toBeNull();
  });
});

describe('SMS text', () => {
  it('odstraní diakritiku i typografii', () => {
    expect(bezDiakritiky('Příliš žluťoučký kůň – „test“ … ')).toBe('Prilis zlutoucky kun - "test" ... ');
  });
  it('počítá segmenty', () => {
    expect(smsSegmenty('')).toBe(0);
    expect(smsSegmenty('a'.repeat(160))).toBe(1);
    expect(smsSegmenty('a'.repeat(161))).toBe(2);
    expect(smsSegmenty('a'.repeat(306))).toBe(2);
    expect(smsSegmenty('a'.repeat(307))).toBe(3);
  });
});
