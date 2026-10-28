// Obecní web od Voltu 2.0 — editor textu (Tiptap 3 / ProseMirror, MIT; balí se esbuildem do public/js/editor.js,
// žádné CDN: `npm run build:klient`).
// Vylepšuje <textarea data-editor="plny|zakladni">: bez JavaScriptu zůstává obyčejné pole (HTML se na serveru
// sanitizuje, src/lib/html.ts). Povolená je jen struktura (nadpisy, tučné, kurzíva, odkazy, seznamy, citace,
// obrázky s popisem a titulkem, video obce, tabulky) — barvy a velikosti písma nejdou nastavit, vzhled webu nejde
// rozbít. Obrázek bez popisu (alt) nejde vložit. Galerie z importu starých webů se zachová beze změny.
import { Editor, Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Placeholder } from '@tiptap/extensions';

(function () {
  'use strict';
  var texty = document.getElementById('alt-dialog-sablona');
  var T = function (k, vychozi) {
    return (texty && texty.getAttribute('data-' + k)) || vychozi;
  };
  var csrfPole = document.querySelector('input[name="_csrf"]');
  var csrf = csrfPole ? csrfPole.value : '';

  // ---------- uzly ----------

  // obrázek: <img> nebo <figure><img><figcaption>titulek</figcaption></figure>; přesouvá se tažením
  var Obrazek = Node.create({
    name: 'obrazek',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: function () {
      return {
        src: { default: null },
        alt: { default: '' },
        width: { default: null },
        soubor: { default: null },
        titulek: { default: '' },
        odkaz: { default: null },
      };
    },
    parseHTML: function () {
      var zImg = function (img) {
        return {
          src: img.getAttribute('src'),
          alt: img.getAttribute('alt') || '',
          width: img.getAttribute('width'),
          soubor: img.getAttribute('data-soubor'),
          // obrázek v odkazu (proklik na velkou fotku) — odkaz patří k obrázku, ne k textu
          odkaz:
            img.parentElement && img.parentElement.tagName === 'A'
              ? img.parentElement.getAttribute('href')
              : null,
        };
      };
      return [
        {
          // <a href><img></a> bez dalšího textu = obrázek s odkazem
          tag: 'a[href]',
          priority: 1000,
          getAttrs: function (el) {
            var obr = el.querySelectorAll('img');
            if (obr.length !== 1 || el.textContent.trim()) return false;
            return zImg(obr[0]);
          },
        },
        {
          tag: 'figure',
          priority: 60,
          getAttrs: function (el) {
            if (el.classList.contains('video') || el.classList.contains('galerie')) return false;
            var obr = el.querySelectorAll('img');
            if (obr.length !== 1) return false;
            var cap = el.querySelector('figcaption');
            var a = zImg(obr[0]);
            a.titulek = cap ? cap.textContent.trim() : '';
            return a;
          },
        },
        {
          tag: 'img[src]',
          getAttrs: zImg,
        },
      ];
    },
    renderHTML: function (p) {
      var a = p.node.attrs;
      var img = [
        'img',
        { src: a.src, alt: a.alt || '', width: a.width || null, 'data-soubor': a.soubor || null },
      ];
      var obr = a.odkaz ? ['a', { href: a.odkaz }, img] : img;
      return a.titulek ? ['figure', {}, obr, ['figcaption', {}, a.titulek]] : obr;
    },
  });

  // video z knihovny videí webu: <figure class="video" data-video="id"><a href>Název</a></figure>
  var VideoObce = Node.create({
    name: 'videoObce',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: function () {
      return { id: { default: null }, odkaz: { default: '/videa' }, nazev: { default: 'Video' } };
    },
    parseHTML: function () {
      return [
        {
          tag: 'figure.video',
          priority: 70,
          getAttrs: function (el) {
            var id = el.getAttribute('data-video');
            if (!/^[0-9a-f-]{36}$/.test(id || '')) return false;
            var a = el.querySelector('a');
            return {
              id: id,
              odkaz: a ? a.getAttribute('href') : '/videa',
              nazev: a ? a.textContent : 'Video',
            };
          },
        },
      ];
    },
    renderHTML: function (p) {
      var a = p.node.attrs;
      return [
        'figure',
        { class: 'video', 'data-video': a.id },
        ['a', { href: a.odkaz || '/videa' }, a.nazev || 'Video'],
      ];
    },
    addNodeView: function () {
      return function (p) {
        var dom = document.createElement('div');
        dom.className = 'editor-video';
        dom.textContent = '▶ ' + (p.node.attrs.nazev || 'Video');
        return { dom: dom };
      };
    },
  });

  // galerie z importu starých webů: zachová se celý obsah (v editoru jen náhled, needituje se)
  var Galerie = Node.create({
    name: 'galerie',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: function () {
      return {
        html: {
          default: '',
          parseHTML: function (el) {
            return el.innerHTML;
          },
          renderHTML: function () {
            return {};
          },
        },
      };
    },
    parseHTML: function () {
      return [{ tag: 'figure.galerie', priority: 70 }];
    },
    renderHTML: function (p) {
      var f = document.createElement('figure');
      f.className = 'galerie';
      f.innerHTML = p.node.attrs.html;
      return f;
    },
    addNodeView: function () {
      return function (p) {
        var dom = document.createElement('figure');
        dom.className = 'galerie editor-galerie';
        dom.innerHTML = p.node.attrs.html;
        dom.setAttribute('contenteditable', 'false');
        return { dom: dom };
      };
    },
  });

  // ---------- dialogy ----------

  function dialog(o) {
    // o: { nadpis, napoveda, pole: [{ klic, label, hodnota, povinne, typ }], ok }
    return new Promise(function (hotovo) {
      var d = document.createElement('dialog');
      d.className = 'alt-dialog';
      var f = document.createElement('form');
      f.method = 'dialog';
      var h = document.createElement('h2');
      h.textContent = o.nadpis;
      f.appendChild(h);
      if (o.napoveda) {
        var n = document.createElement('p');
        n.className = 'napoveda';
        n.textContent = o.napoveda;
        f.appendChild(n);
      }
      var vstupy = {};
      o.pole.forEach(function (p, i) {
        var id = 'ed-dialog-' + i;
        var l = document.createElement('label');
        l.setAttribute('for', id);
        l.textContent = p.label;
        var v;
        if (p.moznosti) {
          v = document.createElement('select');
          p.moznosti.forEach(function (m) {
            var op = document.createElement('option');
            op.value = m.hodnota;
            op.textContent = m.text;
            if (String(m.hodnota) === String(p.hodnota)) op.selected = true;
            v.appendChild(op);
          });
        } else {
          v = document.createElement('input');
          v.type = p.typ || 'text';
          v.value = p.hodnota || '';
          v.maxLength = 500;
        }
        v.id = id;
        if (p.povinne) v.required = true;
        f.appendChild(l);
        f.appendChild(v);
        vstupy[p.klic] = v;
      });
      var chyba = document.createElement('p');
      chyba.className = 'alt-chyba';
      chyba.setAttribute('role', 'alert');
      chyba.hidden = true;
      f.appendChild(chyba);
      var dole = document.createElement('div');
      dole.className = 'tlacitka-dole';
      var ok = document.createElement('button');
      ok.className = 'tlacitko';
      ok.value = 'ok';
      ok.textContent = o.ok || T('ok', 'Vložit');
      var zr = document.createElement('button');
      zr.className = 'tlacitko sekundarni';
      zr.value = 'zrusit';
      zr.formNoValidate = true;
      zr.textContent = T('zrusit', 'Zrušit');
      dole.appendChild(ok);
      dole.appendChild(document.createTextNode(' '));
      dole.appendChild(zr);
      f.appendChild(dole);
      d.appendChild(f);
      d.addEventListener('close', function () {
        var vysledek = null;
        if (d.returnValue === 'ok') {
          vysledek = {};
          Object.keys(vstupy).forEach(function (k) {
            vysledek[k] = vstupy[k].value.trim();
          });
        }
        d.remove();
        hotovo(vysledek);
      });
      document.body.appendChild(d);
      d.showModal();
      var prvni = o.pole.length ? vstupy[o.pole[0].klic] : ok;
      prvni.focus();
      if (prvni.select) prvni.select();
    });
  }

  function zeptejSeNaPopis(navrh) {
    return dialog({
      nadpis: T('nadpis', 'Popište obrázek'),
      napoveda: T('napoveda', ''),
      pole: [{ klic: 'alt', label: 'Popis obrázku', hodnota: navrh || '', povinne: true }],
    }).then(function (v) {
      return v ? v.alt : null;
    });
  }

  function vyberVideo() {
    return fetch('/sprava/web/videa.json', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (videa) {
        if (!videa.length) {
          window.alert(T('video-napoveda', 'Zatím tu není žádné video.'));
          return null;
        }
        return dialog({
          nadpis: T('video-nadpis', 'Vložit video'),
          napoveda: T('video-napoveda', ''),
          pole: [
            {
              klic: 'id',
              label: T('video-label', 'Video'),
              moznosti: videa.map(function (v) {
                return {
                  hodnota: v.id,
                  text: v.nazev + (v.stav === 'zverejneno' ? '' : ' — ' + T('video-koncept', 'koncept')),
                };
              }),
            },
          ],
        }).then(function (vyber) {
          if (!vyber) return null;
          return (
            videa.find(function (x) {
              return x.id === vyber.id;
            }) || null
          );
        });
      });
  }

  function jeBezpecnyOdkaz(u) {
    return /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(u);
  }

  // ---------- nahrávání obrázků ----------

  function nahrajObrazek(soubor) {
    var fd = new FormData();
    fd.append('obrazek', soubor, soubor.name);
    return fetch('/sprava/web/obrazek', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: fd,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.chyba || 'Nahrání se nepovedlo.');
        return j;
      });
    });
  }

  /** nahraje obrázky a vloží je od pozice `pozice` (zjištěné PŘED dialogy — ty editoru vezmou fokus) */
  function vlozObrazky(editor, soubory, pozice) {
    var stav = document.getElementById('autosave-stav');
    var pos = pozice;
    var postup = Promise.resolve();
    Array.prototype.forEach.call(soubory, function (soubor) {
      if (!/^image\//.test(soubor.type)) return;
      postup = postup.then(function () {
        if (stav) stav.textContent = T('nahravam', 'Nahrávám obrázek…');
        return nahrajObrazek(soubor)
          .then(function (j) {
            return zeptejSeNaPopis(j.navrhAlt).then(function (alt) {
              if (alt === null) return;
              var max = editor.state.doc.content.size;
              editor
                .chain()
                .focus()
                .insertContentAt(Math.min(pos, max), {
                  type: 'obrazek',
                  attrs: { src: j.url, alt: alt, soubor: j.id || null },
                })
                .run();
              pos = editor.state.selection.to;
            });
          })
          .catch(function (e) {
            window.alert(e.message);
          })
          .then(function () {
            if (stav) stav.textContent = '';
          });
      });
    });
    return postup;
  }

  function obrazkyZ(dataTransfer) {
    if (!dataTransfer || !dataTransfer.files || !dataTransfer.files.length) return [];
    return Array.prototype.filter.call(dataTransfer.files, function (f) {
      return /^image\//.test(f.type);
    });
  }

  // ---------- lišta ----------

  function tlacitko(text, popisek, akce, aktivni) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'editor-tl';
    b.textContent = text;
    b.title = popisek;
    b.setAttribute('aria-label', popisek);
    b.addEventListener('mousedown', function (e) {
      e.preventDefault(); // neztratit výběr v editoru
    });
    b.addEventListener('click', akce);
    b._aktivni = aktivni || null;
    return b;
  }

  function skupina(prvky) {
    var s = document.createElement('span');
    s.className = 'editor-skupina';
    s.setAttribute('role', 'group');
    prvky.forEach(function (p) {
      s.appendChild(p);
    });
    return s;
  }

  document.querySelectorAll('textarea[data-editor]').forEach(function (ta) {
    var plny = ta.getAttribute('data-editor') === 'plny';
    var obal = document.createElement('div');
    obal.className = 'editor-obal';
    var lista = document.createElement('div');
    lista.className = 'editor-lista';
    lista.setAttribute('role', 'toolbar');
    lista.setAttribute('aria-label', 'Formátování textu');
    var kontext = document.createElement('div');
    kontext.className = 'editor-lista editor-kontext';
    kontext.setAttribute('role', 'toolbar');
    kontext.hidden = true;
    var pole = document.createElement('div');
    pole.className = 'editor-pole';
    obal.appendChild(lista);
    obal.appendChild(kontext);
    obal.appendChild(pole);
    ta.parentNode.insertBefore(obal, ta);
    ta.hidden = true;

    var label = document.querySelector('label[for="' + ta.id + '"]');
    var editor = new Editor({
      element: pole,
      content: ta.value || '',
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3, 4] },
          code: false,
          codeBlock: false,
          link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } },
        }),
        Subscript,
        Superscript,
        TableKit.configure({ table: { resizable: false } }),
        Placeholder.configure({
          placeholder: 'Pište text… (obrázek vložíte tlačítkem, přetažením nebo ze schránky)',
        }),
        Obrazek,
        VideoObce,
        Galerie,
      ],
      editorProps: {
        attributes: {
          class: 'editor-obsah',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label ? label.textContent.trim() : 'Text',
        },
        handlePaste: function (view, event) {
          var obr = plny ? obrazkyZ(event.clipboardData) : [];
          if (!obr.length) return false;
          event.preventDefault();
          vlozObrazky(editor, obr, view.state.selection.from);
          return true;
        },
        handleDrop: function (view, event, slice, moved) {
          if (moved) return false; // přesun uvnitř textu (i obrázku) obsluhuje editor sám
          var obr = plny ? obrazkyZ(event.dataTransfer) : [];
          if (!obr.length) return false;
          event.preventDefault();
          var misto = view.posAtCoords({ left: event.clientX, top: event.clientY });
          vlozObrazky(editor, obr, misto ? misto.pos : view.state.selection.from);
          return true;
        },
        handleDoubleClickOn: function (view, pos, node) {
          if (node.type.name !== 'obrazek') return false;
          upravPopis(pos, node);
          return true;
        },
      },
    });
    if (ta.getAttribute('aria-describedby'))
      editor.view.dom.setAttribute('aria-describedby', ta.getAttribute('aria-describedby'));

    // ---- akce ----
    var c = function () {
      return editor.chain().focus();
    };
    function odkaz() {
      var puvodni = editor.getAttributes('link').href || '';
      dialog({
        nadpis: 'Odkaz',
        napoveda:
          'Adresa webu (https://…), stránky obce (/…), e-mail (mailto:…) nebo telefon (tel:…). Prázdné = zrušit odkaz.',
        pole: [{ klic: 'href', label: 'Adresa', hodnota: puvodni }],
        ok: 'Uložit',
      }).then(function (v) {
        if (!v) return;
        if (!v.href) return c().extendMarkRange('link').unsetLink().run();
        var href = /^www\./i.test(v.href) ? 'https://' + v.href : v.href;
        if (!jeBezpecnyOdkaz(href)) return window.alert('Odkaz musí začínat https://, /, mailto: nebo tel:.');
        if (editor.state.selection.empty && !puvodni)
          c()
            .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href: href } }] })
            .run();
        else c().extendMarkRange('link').setLink({ href: href }).run();
      });
    }
    function obrazekZDisku() {
      var pos = editor.state.selection.from;
      var v = document.createElement('input');
      v.type = 'file';
      v.accept = 'image/*';
      v.multiple = true;
      v.addEventListener('change', function () {
        vlozObrazky(editor, v.files, pos);
      });
      v.click();
    }
    function video() {
      var pos = editor.state.selection.from;
      vyberVideo().then(function (v) {
        if (!v) return;
        editor
          .chain()
          .focus()
          .insertContentAt(pos, {
            type: 'videoObce',
            attrs: { id: v.id, odkaz: v.odkaz || '/videa', nazev: v.nazev },
          })
          .run();
      });
    }
    function vybranyObrazek() {
      var s = editor.state.selection;
      return s instanceof NodeSelection && s.node.type.name === 'obrazek'
        ? { pos: s.from, node: s.node }
        : null;
    }
    function nastavObrazek(pos, attrs) {
      editor
        .chain()
        .focus()
        .command(function (p) {
          var node = p.tr.doc.nodeAt(pos);
          if (!node) return false;
          p.tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs, attrs));
          return true;
        })
        .setNodeSelection(pos)
        .run();
    }
    function upravPopis(pos, node) {
      zeptejSeNaPopis(node.attrs.alt).then(function (alt) {
        if (alt !== null) nastavObrazek(pos, { alt: alt });
      });
    }
    function upravTitulek(pos, node) {
      dialog({
        nadpis: 'Titulek pod obrázkem',
        napoveda: 'Zobrazí se pod obrázkem (např. autor fotky nebo popis akce). Prázdné = bez titulku.',
        pole: [{ klic: 't', label: 'Titulek', hodnota: node.attrs.titulek }],
        ok: 'Uložit',
      }).then(function (v) {
        if (v) nastavObrazek(pos, { titulek: v.t });
      });
    }

    // ---- hlavní lišta ----
    var styl = document.createElement('select');
    styl.className = 'editor-styl';
    styl.setAttribute('aria-label', 'Styl odstavce');
    [
      ['p', 'Běžný text'],
      ['2', 'Nadpis'],
      ['3', 'Podnadpis'],
      ['4', 'Menší nadpis'],
    ].forEach(function (x) {
      var o = document.createElement('option');
      o.value = x[0];
      o.textContent = x[1];
      styl.appendChild(o);
    });
    styl.addEventListener('change', function () {
      if (styl.value === 'p') c().setParagraph().run();
      else
        c()
          .setHeading({ level: Number(styl.value) })
          .run();
    });

    var aktivni = function (jmeno, attrs) {
      return function () {
        return editor.isActive(jmeno, attrs);
      };
    };
    var prvky = [
      skupina([styl]),
      skupina([
        tlacitko(
          'B',
          'Tučně (Ctrl+B)',
          function () {
            c().toggleBold().run();
          },
          aktivni('bold'),
        ),
        tlacitko(
          'I',
          'Kurzíva (Ctrl+I)',
          function () {
            c().toggleItalic().run();
          },
          aktivni('italic'),
        ),
        tlacitko('🔗', 'Odkaz (Ctrl+K)', odkaz, aktivni('link')),
      ]),
      skupina([
        tlacitko(
          '•',
          'Odrážky',
          function () {
            c().toggleBulletList().run();
          },
          aktivni('bulletList'),
        ),
        tlacitko(
          '1.',
          'Číslovaný seznam',
          function () {
            c().toggleOrderedList().run();
          },
          aktivni('orderedList'),
        ),
        tlacitko(
          '❝',
          'Citace',
          function () {
            c().toggleBlockquote().run();
          },
          aktivni('blockquote'),
        ),
        tlacitko('—', 'Vodorovná čára', function () {
          c().setHorizontalRule().run();
        }),
      ]),
    ];
    if (plny)
      prvky.push(
        skupina([
          tlacitko('🖼 Obrázek', 'Vložit obrázek na místo kurzoru', obrazekZDisku),
          tlacitko('▶ Video', 'Vložit video z knihovny videí', video),
        ]),
      );
    prvky.push(
      skupina([
        tlacitko('▦ Tabulka', 'Vložit tabulku 3 × 3 se záhlavím', function () {
          c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        }),
      ]),
    );
    prvky.push(
      skupina([
        tlacitko('↶', 'Zpět (Ctrl+Z)', function () {
          c().undo().run();
        }),
        tlacitko('↷', 'Znovu (Ctrl+Y)', function () {
          c().redo().run();
        }),
        tlacitko('⌫ Formát', 'Zrušit formátování výběru', function () {
          c().unsetAllMarks().clearNodes().run();
        }),
      ]),
    );
    prvky.forEach(function (p) {
      lista.appendChild(p);
    });

    // ---- kontextová lišta: tabulka / obrázek ----
    var tabulkaLista = skupina([
      document.createTextNode('Tabulka: '),
      tlacitko('+ řádek', 'Přidat řádek pod', function () {
        c().addRowAfter().run();
      }),
      tlacitko('+ sloupec', 'Přidat sloupec vpravo', function () {
        c().addColumnAfter().run();
      }),
      tlacitko('− řádek', 'Smazat řádek', function () {
        c().deleteRow().run();
      }),
      tlacitko('− sloupec', 'Smazat sloupec', function () {
        c().deleteColumn().run();
      }),
      tlacitko('Záhlaví', 'Přepnout první řádek jako záhlaví', function () {
        c().toggleHeaderRow().run();
      }),
      tlacitko('Sloučit', 'Sloučit / rozdělit vybrané buňky', function () {
        c().mergeOrSplit().run();
      }),
      tlacitko('✕ Tabulka', 'Smazat celou tabulku', function () {
        c().deleteTable().run();
      }),
    ]);
    var obrLista = skupina([
      document.createTextNode('Obrázek: '),
      tlacitko('Popis…', 'Popis obrázku pro nevidomé (povinný)', function () {
        var o = vybranyObrazek();
        if (o) upravPopis(o.pos, o.node);
      }),
      tlacitko('Titulek…', 'Titulek pod obrázkem', function () {
        var o = vybranyObrazek();
        if (o) upravTitulek(o.pos, o.node);
      }),
      tlacitko('Malý', 'Šířka 300 px', function () {
        var o = vybranyObrazek();
        if (o) nastavObrazek(o.pos, { width: '300' });
      }),
      tlacitko('Střední', 'Šířka 600 px', function () {
        var o = vybranyObrazek();
        if (o) nastavObrazek(o.pos, { width: '600' });
      }),
      tlacitko('Celá šířka', 'Přes celou šířku textu', function () {
        var o = vybranyObrazek();
        if (o) nastavObrazek(o.pos, { width: null });
      }),
      tlacitko('✕', 'Odstranit obrázek', function () {
        c().deleteSelection().run();
      }),
    ]);
    kontext.appendChild(tabulkaLista);
    kontext.appendChild(obrLista);

    function obnovListu() {
      lista.querySelectorAll('.editor-tl').forEach(function (b) {
        if (b._aktivni) b.setAttribute('aria-pressed', b._aktivni() ? 'true' : 'false');
      });
      var h = [2, 3, 4].find(function (l) {
        return editor.isActive('heading', { level: l });
      });
      styl.value = h ? String(h) : 'p';
      var vTabulce = editor.isActive('table');
      var obr = !!vybranyObrazek();
      tabulkaLista.hidden = !vTabulce;
      obrLista.hidden = !obr;
      kontext.hidden = !vTabulce && !obr;
    }

    // HTML pro uložení: bez pomocných šířek sloupců tabulky (style, colgroup) — server je stejně nepustí
    function cisteHtml() {
      if (editor.isEmpty) return '';
      return editor
        .getHTML()
        .replace(/<colgroup>[\s\S]*?<\/colgroup>/g, '')
        .replace(/ style="[^"]*"/g, '')
        .replace(/&nbsp;/g, ' ');
    }
    function synchronizuj() {
      ta.value = cisteHtml();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    editor.on('update', synchronizuj);
    editor.on('transaction', obnovListu);
    editor.view.dom.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        odkaz();
      }
    });
    if (ta.form) ta.form.addEventListener('submit', synchronizuj, true);
    synchronizuj();
    obnovListu();

    // rozhraní pro jiné skripty stránky (kopírování mezi poli hlášení, public/js/hlaseni.js)
    ta.editorApi = {
      text: function () {
        return editor.getText({ blockSeparator: '\n\n' });
      },
      html: cisteHtml,
      nastavHtml: function (html) {
        editor.commands.setContent(html || '', { emitUpdate: true });
      },
      nastavText: function (t) {
        var odstavce = String(t || '')
          .split(/\n{2,}/)
          .map(function (o) {
            return o.trim();
          })
          .filter(Boolean)
          .map(function (o) {
            return { type: 'paragraph', content: [{ type: 'text', text: o }] };
          });
        editor.commands.setContent(
          { type: 'doc', content: odstavce.length ? odstavce : [{ type: 'paragraph' }] },
          { emitUpdate: true },
        );
      },
    };
  });

  // ---------- automatické ukládání rozpracovaného obsahu ----------
  var form = document.getElementById('editor-formular');
  if (!form) return;
  var stav = document.getElementById('autosave-stav');
  var zmeneno = false;
  var odesilam = false;
  form.addEventListener('input', function () {
    zmeneno = true;
  });
  form.addEventListener('change', function () {
    zmeneno = true;
  });
  form.addEventListener('submit', function (e) {
    var cil = e.submitter && e.submitter.getAttribute('formtarget');
    if (!cil) odesilam = true;
  });
  window.addEventListener('beforeunload', function (e) {
    if (zmeneno && !odesilam) {
      e.preventDefault();
      e.returnValue = T('zmeny', '');
    }
  });
  function uloz() {
    if (!zmeneno || odesilam) return;
    var data = {};
    new FormData(form).forEach(function (v, k) {
      if (typeof v === 'string' && k !== '_csrf') data[k] = v;
    });
    zmeneno = false;
    fetch(form.getAttribute('data-autosave'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify(data),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) throw new Error();
        if (stav) stav.textContent = T('ulozeno', 'Automaticky uloženo') + ' ' + j.cas;
        if (form.getAttribute('action') === '/sprava/web/novy') {
          // první uložení nového obsahu: od teď upravujeme založený koncept
          form.setAttribute('action', '/sprava/web/obsah/' + j.id);
          form.setAttribute('data-autosave', '/sprava/web/obsah/' + j.id + '/autosave');
          var h = document.createElement('input');
          h.type = 'hidden';
          h.name = 'id';
          h.value = j.id;
          form.appendChild(h);
          history.replaceState(null, '', '/sprava/web/obsah/' + j.id);
        }
      })
      .catch(function () {
        zmeneno = true;
        if (stav)
          stav.textContent = T('neulozeno', 'Automatické uložení se nepovedlo — uložte prosím ručně.');
      });
  }
  setInterval(uloz, 20000);
})();
