// Text dokumentů — čistá logika (bez DB a bez binárek): rozpoznání vrstvy a nesmyslů, čištění textu, kancelářské
// formáty přes ZIP/XML, RTF, sestavení příkazů; chybějící nástroj = nepodporovano. Integrační část (pdftotext,
// OCR tesseractem, antiword) běží jen tam, kde binárky jsou (CI, obraz Dockeru) — jinak se přeskočí.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  cistiText,
  dekodujEntity,
  dostupneNastroje,
  extrahujText,
  jeIndexovatelny,
  jeNesmysl,
  maVrstvu,
  prikazy,
  rychlaKontrolaPdf,
  stranyZPdfinfo,
  textZOffice,
  textZRtf,
  xmlNaText,
  type TextKonfigurace,
} from '../src/lib/text-souboru.js';
import { docxSTextem } from './pomocnici.js';

const FIXTURES = new URL('./fixtures/text/', import.meta.url).pathname;
const nastroje = await dostupneNastroje();
const maPoppler = nastroje.pdftotext && nastroje.pdfinfo && nastroje.pdftoppm;
const maOcr = maPoppler && nastroje.tesseract;

function cfg(v: Partial<TextKonfigurace> = {}): TextKonfigurace {
  return {
    ocrJazyky: 'ces+eng',
    ocrMaxStran: 300,
    ocrDpi: 200,
    maxZnaku: 2_000_000,
    tmpDir: path.join(os.tmpdir(), 'platforma-test-text'),
    ...v,
  };
}
const BEZ_NASTROJU = cfg({ path: '/neexistujici-adresar' });

async function docasny(data: Buffer, pripona: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'platforma-test-text');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.${pripona}`);
  await fs.writeFile(p, data);
  return p;
}

describe('rozhodnutí o vrstvě a čištění', () => {
  it('vrstva = aspoň 40 znaků na stranu', () => {
    expect(maVrstvu('a'.repeat(80), 2)).toBe(true);
    expect(maVrstvu('a'.repeat(79) + '   \n', 2)).toBe(false);
    expect(maVrstvu('', 1)).toBe(false);
    expect(maVrstvu('x'.repeat(40), null)).toBe(true);
  });

  it('nesmysly = málo písmen a číslic, nebo náhradní znaky; tabulka s čísly nesmysl není', () => {
    expect(jeNesmysl('Vyhláška obce o místním poplatku ze psů 2026')).toBe(false);
    expect(jeNesmysl('1 234 567 Kč\t8 910 Kč\t11 121 314 Kč\tcelkem 1 000 000')).toBe(false);
    expect(jeNesmysl('§¤¶¨¸ )(*&^%$ §¤¶ ab')).toBe(true);
    expect(jeNesmysl('ab�cd�ef�gh�ij�kl�mn�')).toBe(true);
    expect(jeNesmysl('')).toBe(false);
  });

  it('čistí řídicí znaky, sjednocuje mezery a ořezává na limit', () => {
    const r = cistiText('  Vyhláška \u0007obce\r\n\r\n\r\n\r\nText\f dál   tady  ', 1000);
    expect(r.text).toBe('Vyhláška obce\n\nText\n\ndál tady');
    expect(r.zkraceno).toBe(false);
    const k = cistiText('abcdefghij'.repeat(10), 25);
    expect(k.text.length).toBe(25);
    expect(k.zkraceno).toBe(true);
  });

  it('indexovatelné: PDF, Office vždy; obrázek jen jako dokument', () => {
    expect(jeIndexovatelny('application/pdf', false)).toBe(true);
    expect(jeIndexovatelny('application/msword', false)).toBe(true);
    expect(jeIndexovatelny('image/jpeg', true)).toBe(true);
    expect(jeIndexovatelny('image/jpeg', false)).toBe(false);
    expect(jeIndexovatelny('video/mp4', true)).toBe(false);
  });
});

describe('kancelářské formáty (ZIP/XML)', () => {
  it('XML → text: odstavce, tabulátory, entity, spojené běhy textu', () => {
    const xml =
      '<w:p><w:r><w:t>Vyhl</w:t></w:r><w:r><w:t>áška</w:t></w:r><w:r><w:tab/><w:t>č. 1 &amp; 2 &lt;3&gt;</w:t></w:r></w:p><w:p><w:r><w:t>Druhý</w:t></w:r></w:p>';
    expect(xmlNaText(xml)).toBe('Vyhláška\tč. 1 & 2 <3>\nDruhý\n');
    expect(dekodujEntity('&#269;&#x161; &quot;x&quot; &neznama;')).toBe('čš "x" &neznama;');
  });

  it('docx: text dokumentu, poznámek pod čarou a záhlaví', async () => {
    const data = await docxSTextem(['Zápis ze zasedání zastupitelstva', 'Usnesení č. 12/2026 bylo přijato.']);
    const { text, preskoceno } = textZOffice(data, 'docx');
    expect(preskoceno).toBe(0);
    expect(text).toContain('Zápis ze zasedání zastupitelstva\nUsnesení č. 12/2026 bylo přijato.');
  });

  it('xlsx: sdílené řetězce, vložené řetězce a čísla, řádky a buňky', () => {
    const zip = zipSync({
      'xl/sharedStrings.xml': strToU8(
        '<sst><si><t>Položka</t></si><si><r><t>Částka</t></r><r><t xml:space="preserve"> Kč</t></r></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Silnice</t></is></c><c r="B2"><v>125000</v></c><c r="C2"/></row></sheetData></worksheet>',
      ),
    });
    const { text } = textZOffice(zip, 'xlsx');
    expect(text).toBe('Položka\tČástka Kč\nSilnice\t125000\n');
  });

  it('pptx: snímky v pořadí podle čísla', () => {
    const zip = zipSync({
      'ppt/slides/slide10.xml': strToU8('<p:sld><a:p><a:r><a:t>Desátý</a:t></a:r></a:p></p:sld>'),
      'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Druhý</a:t></a:r></a:p></p:sld>'),
    });
    expect(textZOffice(zip, 'pptx').text).toBe('Druhý\n\n\nDesátý\n');
  });

  it('odt: content.xml s mezerami a tabulkou', () => {
    const zip = zipSync({
      mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
      'content.xml': strToU8(
        '<office:document-content><office:body><office:text><text:h>Nadpis</text:h><text:p>Jedna<text:s text:c="3"/>dvě<text:tab/>tři</text:p><table:table><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>',
      ),
    });
    expect(textZOffice(zip, 'odt').text).toBe('Nadpis\nJedna   dvě\ttři\nA\n\tB\n\t\n');
  });

  it('rtf: text s češtinou (cp1250 i \\u), bez tabulek fontů a barev', () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1250\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Test}\\pard\\f0\\fs24 Vyhl\\'e1\\'9aka obce\\par Usnesen\\u237? \\u269?. 5 \\{x\\}\\tab konec\\par}";
    expect(textZRtf(strToU8(rtf))).toBe('Vyhláška obce\nUsnesení č. 5 {x}\tkonec\n');
  });
});

describe('příkazy a chybějící nástroje', () => {
  it('sestaví argumenty poppleru, tesseractu a antiwordu', () => {
    expect(prikazy.pdftotext('/a/b.pdf')).toEqual({
      prikaz: 'pdftotext',
      args: ['-layout', '-enc', 'UTF-8', '/a/b.pdf', '-'],
    });
    expect(prikazy.pdftotext('/a/b.pdf', { od: 1, do: 3 }).args.slice(0, 4)).toEqual(['-f', '1', '-l', '3']);
    expect(prikazy.pdftoppm('/a/b.pdf', 7, 200, '/tmp/x/strana').args).toEqual([
      '-r',
      '200',
      '-f',
      '7',
      '-l',
      '7',
      '-png',
      '/a/b.pdf',
      '/tmp/x/strana',
    ]);
    expect(prikazy.tesseract('/tmp/s.png', 'ces+eng', 1, 200).args).toEqual([
      '/tmp/s.png',
      'stdout',
      '-l',
      'ces+eng',
      '--psm',
      '1',
      '--dpi',
      '200',
    ]);
    expect(prikazy.antiword('/a/b.doc').args).toEqual(['-m', 'UTF-8.txt', '-t', '/a/b.doc']);
    expect(stranyZPdfinfo('Title: x\nPages:          12\nPage size: 595 x 842')).toBe(12);
    expect(stranyZPdfinfo('nic')).toBeNull();
  });

  it('bez binárek: PDF a .doc = nepodporováno s důvodem, docx a RTF fungují, .xls neumíme', async () => {
    const pdf = await docasny(await fs.readFile(path.join(FIXTURES, 'vrstva.pdf')), 'pdf');
    const r = await extrahujText(pdf, { mime: 'application/pdf', pripona: 'pdf' }, BEZ_NASTROJU);
    expect(r).toEqual({ stav: 'nepodporovano', duvod: 'chybí program pdfinfo' });
    const doc = await docasny(Buffer.from('x'), 'doc');
    expect(await extrahujText(doc, { mime: 'application/msword', pripona: 'doc' }, BEZ_NASTROJU)).toEqual({
      stav: 'nepodporovano',
      duvod: 'chybí program antiword',
    });
    const xls = await docasny(Buffer.from('x'), 'xls');
    const rx = await extrahujText(xls, { mime: 'application/vnd.ms-excel', pripona: 'xls' }, BEZ_NASTROJU);
    expect(rx.stav).toBe('nepodporovano');
    const docx = await docasny(await docxSTextem(['Rozpočet obce na rok 2027 je vyrovnaný.']), 'docx');
    const rd = await extrahujText(
      docx,
      { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pripona: 'docx' },
      BEZ_NASTROJU,
    );
    expect(rd).toMatchObject({
      stav: 'hotovo',
      zdroj: 'docx',
      text: 'Rozpočet obce na rok 2027 je vyrovnaný.',
    });
    const kratky = await docasny(await docxSTextem(['Ahoj']), 'docx');
    expect(
      (
        await extrahujText(
          kratky,
          {
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            pripona: 'docx',
          },
          BEZ_NASTROJU,
        )
      ).stav,
    ).toBe('bez_textu');
    const rtf = await docasny(
      Buffer.from('{\\rtf1\\ansi Zpravodaj obce, vydani 3/2026, uzaverka 15. zari.\\par}'),
      'rtf',
    );
    expect(await extrahujText(rtf, { mime: 'application/rtf', pripona: 'rtf' }, BEZ_NASTROJU)).toMatchObject({
      stav: 'hotovo',
      zdroj: 'rtf',
    });
    expect(await rychlaKontrolaPdf(pdf, BEZ_NASTROJU)).toBe('nejiste');
    // poškozený ZIP = chyba, ne pád
    const rozbity = await docasny(Buffer.from('PK\u0003\u0004nesmysl'), 'docx');
    const rr = await extrahujText(
      rozbity,
      { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pripona: 'docx' },
      BEZ_NASTROJU,
    );
    expect(rr.stav).toBe('chyba');
  });
});

describe.skipIf(!maPoppler)('integrace: poppler (pdftotext, pdfinfo)', () => {
  it('PDF s textovou vrstvou → hotovo, zdroj vrstva, počet stran', async () => {
    const r = await extrahujText(
      path.join(FIXTURES, 'vrstva.pdf'),
      { mime: 'application/pdf', pripona: 'pdf' },
      cfg(),
    );
    expect(r).toMatchObject({ stav: 'hotovo', zdroj: 'vrstva', stran: 1, maVrstvu: true });
    if (r.stav === 'hotovo') expect(r.text).toContain('mistnim poplatku ze psu');
  });

  it('rychlá kontrola: vrstva vs. sken', async () => {
    expect(await rychlaKontrolaPdf(path.join(FIXTURES, 'vrstva.pdf'), cfg())).toBe('vrstva');
    expect(await rychlaKontrolaPdf(path.join(FIXTURES, 'sken.pdf'), cfg())).toBe('bez_vrstvy');
  });
});

describe.skipIf(!maOcr)('integrace: OCR (tesseract)', () => {
  it('sken v PDF → OCR najde slova', async () => {
    const r = await extrahujText(
      path.join(FIXTURES, 'sken.pdf'),
      { mime: 'application/pdf', pripona: 'pdf' },
      cfg(),
    );
    expect(r).toMatchObject({ stav: 'hotovo', zdroj: 'ocr', stran: 1, maVrstvu: false });
    if (r.stav === 'hotovo') expect(r.text.toLowerCase()).toContain('vodovod v obci testov');
  }, 120_000);

  it('obrázek nahraný jako dokument → OCR', async () => {
    const r = await extrahujText(
      path.join(FIXTURES, 'sken.jpg'),
      { mime: 'image/jpeg', pripona: 'jpg' },
      cfg(),
    );
    expect(r).toMatchObject({ stav: 'hotovo', zdroj: 'obrazek' });
    if (r.stav === 'hotovo') expect(r.text).toContain('listopadu 2026');
  }, 120_000);

  it('prázdný sken → bez_textu; limit stran se zapíše do poznámky', async () => {
    const r = await extrahujText(
      path.join(FIXTURES, 'prazdne.pdf'),
      { mime: 'application/pdf', pripona: 'pdf' },
      cfg({ ocrMaxStran: 1 }),
    );
    expect(r).toMatchObject({ stav: 'bez_textu', zdroj: 'ocr', stran: 2 });
    if (r.stav === 'bez_textu') expect(r.poznamka).toContain('OCR jen prvních 1 z 2 stran');
  }, 120_000);
});

describe.skipIf(!nastroje.antiword)('integrace: antiword', () => {
  it('soubor, který není Word → nepodporováno s důvodem', async () => {
    const p = await docasny(Buffer.from('toto není word'), 'doc');
    const r = await extrahujText(p, { mime: 'application/msword', pripona: 'doc' }, cfg());
    expect(r.stav).toBe('nepodporovano');
    if (r.stav === 'nepodporovano') expect(r.duvod).toContain('antiword');
  });
});
