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

  // obrázek: <img> nebo <figure class="obr-…"><img><figcaption>titulek</figcaption></figure>; přesouvá se tažením.
  // Velikost = podíl šířky textu (obr-s25…s75, bez třídy = celá šířka), zarovnání vlevo/vpravo = obtékání textem;
  // na mobilu je každá fotka přes celou šířku (styl webu). Starší obrázky s width v pixelech zůstávají, dokud se
  // velikost nezmění.
  var SIRKY = ['25', '33', '50', '66', '75'];
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
        sirka: { default: null },
        zarovnani: { default: null },
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
            if (el.classList.contains('galerie-obce')) return false;
            var obr = el.querySelectorAll('img');
            if (obr.length !== 1) return false;
            var cap = el.querySelector('figcaption');
            var a = zImg(obr[0]);
            a.titulek = cap ? cap.textContent.trim() : '';
            SIRKY.forEach(function (x) {
              if (el.classList.contains('obr-s' + x)) a.sirka = x;
            });
            if (el.classList.contains('obr-vlevo')) a.zarovnani = 'vlevo';
            if (el.classList.contains('obr-vpravo')) a.zarovnani = 'vpravo';
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
        {
          src: a.src,
          alt: a.alt || '',
          width: a.sirka ? null : a.width || null,
          'data-soubor': a.soubor || null,
        },
      ];
      var obr = a.odkaz ? ['a', { href: a.odkaz }, img] : img;
      var tridy = tridyObrazku(a);
      if (!a.titulek && !tridy) return obr;
      var f = ['figure', tridy ? { class: tridy } : {}, obr];
      if (a.titulek) f.push(['figcaption', {}, a.titulek]);
      return f;
    },
    addNodeView: function () {
      return function (p) {
        return new ObrazekView(p.node, p.view, p.getPos);
      };
    },
  });

  function tridyObrazku(a) {
    var t = [];
    if (a.zarovnani === 'vlevo' || a.zarovnani === 'vpravo') t.push('obr-' + a.zarovnani);
    if (a.sirka && SIRKY.indexOf(String(a.sirka)) >= 0) t.push('obr-s' + a.sirka);
    return t.join(' ');
  }

  // Zobrazení obrázku v editoru: stejné třídy jako na webu + úchyty v dolních rozích na změnu velikosti tažením.
  // Velikost se přichytává k podílům šířky textu (¼, ⅓, ½, ⅔, ¾, celá), aby výsledek vypadal dobře i „od oka“.
  var KROKY = [25, 33, 50, 66, 75, 100];
  function ObrazekView(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    var dom = (this.dom = document.createElement('figure'));
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.cap = document.createElement('figcaption');
    this.stitek = document.createElement('span');
    this.stitek.className = 'editor-obr-stitek';
    this.stitek.hidden = true;
    dom.appendChild(this.img);
    dom.appendChild(this.cap);
    dom.appendChild(this.stitek);
    var zacni = this.zacniTahnout.bind(this);
    ['vlevo', 'vpravo'].forEach(function (strana) {
      var u = document.createElement('span');
      u.className = 'editor-obr-uchyt ' + strana;
      u.title = 'Táhněte pro změnu velikosti';
      u.setAttribute('aria-hidden', 'true');
      u.addEventListener('pointerdown', function (e) {
        zacni(e, strana);
      });
      dom.appendChild(u);
    });
    this.vykresli();
  }
  ObrazekView.prototype.vykresli = function () {
    var a = this.node.attrs;
    this.dom.className = 'editor-obr ' + tridyObrazku(a) + (this.vybrany ? ' ProseMirror-selectednode' : '');
    this.dom.removeAttribute('style');
    this.img.src = a.src || '';
    this.img.alt = a.alt || '';
    if (!a.sirka && a.width) this.img.setAttribute('width', a.width);
    else this.img.removeAttribute('width');
    this.cap.textContent = a.titulek || '';
    this.cap.hidden = !a.titulek;
    this.dom.title = a.odkaz ? 'Odkaz: ' + a.odkaz : '';
  };
  ObrazekView.prototype.update = function (node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.vykresli();
    return true;
  };
  ObrazekView.prototype.selectNode = function () {
    this.vybrany = true;
    this.dom.classList.add('ProseMirror-selectednode');
  };
  ObrazekView.prototype.deselectNode = function () {
    this.vybrany = false;
    this.dom.classList.remove('ProseMirror-selectednode');
  };
  ObrazekView.prototype.stopEvent = function (e) {
    return !!(e.target && e.target.classList && e.target.classList.contains('editor-obr-uchyt'));
  };
  ObrazekView.prototype.ignoreMutation = function () {
    return true;
  };
  ObrazekView.prototype.zacniTahnout = function (e, strana) {
    e.preventDefault();
    e.stopPropagation();
    var obsah = this.view.dom;
    var cs = window.getComputedStyle(obsah);
    var sirkaTextu = obsah.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var start = this.img.getBoundingClientRect().width;
    var x0 = e.clientX;
    var vybrano = null;
    var uchyt = e.target;
    uchyt.setPointerCapture(e.pointerId);
    this.stitek.hidden = false;
    // obrázek na středu roste na obě strany → tah se počítá dvojnásobně
    var nasobek = this.node.attrs.zarovnani ? 1 : 2;
    var pohyb = function (ev) {
      var dx = (ev.clientX - x0) * (strana === 'vpravo' ? 1 : -1) * nasobek;
      var procent = ((start + dx) / sirkaTextu) * 100;
      vybrano = KROKY.reduce(function (nej, k) {
        return Math.abs(k - procent) < Math.abs(nej - procent) ? k : nej;
      }, 100);
      this.dom.style.width = vybrano + '%';
      this.stitek.textContent = vybrano === 100 ? 'celá šířka' : vybrano + ' %';
    }.bind(this);
    var konec = function () {
      uchyt.removeEventListener('pointermove', pohyb);
      uchyt.removeEventListener('pointerup', konec);
      uchyt.removeEventListener('pointercancel', konec);
      this.stitek.hidden = true;
      if (vybrano === null) return this.vykresli();
      var pos = this.getPos();
      var attrs = Object.assign({}, this.node.attrs, {
        sirka: vybrano === 100 ? null : String(vybrano),
        width: null,
      });
      // přes celou šířku nejde obtékat
      if (vybrano === 100) attrs.zarovnani = null;
      var tr = this.view.state.tr.setNodeMarkup(pos, undefined, attrs);
      tr.setSelection(NodeSelection.create(tr.doc, pos));
      this.view.dispatch(tr);
      this.vykresli();
    }.bind(this);
    uchyt.addEventListener('pointermove', pohyb);
    uchyt.addEventListener('pointerup', konec);
    uchyt.addEventListener('pointercancel', konec);
  };

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

  // ---------- vývoj počtu obyvatel (blok ze serverových dat MV ČR) ----------
  // <figure class="obyvatele-vyvoj" data-obyvatele="vyvoj"><p>Vývoj počtu obyvatel</p></figure> — web vykreslí
  // graf a tabulku sám (moduly/web/obyvatele-vyvoj.ts); v editoru jen zástupný rámeček.
  var ObyvateleVyvoj = Node.create({
    name: 'obyvateleVyvoj',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    parseHTML: function () {
      return [
        { tag: 'figure.obyvatele-vyvoj', priority: 80 },
        { tag: 'figure[data-obyvatele]', priority: 80 },
      ];
    },
    renderHTML: function () {
      return [
        'figure',
        { class: 'obyvatele-vyvoj', 'data-obyvatele': 'vyvoj' },
        ['p', {}, 'Vývoj počtu obyvatel'],
      ];
    },
    addNodeView: function () {
      return function () {
        var dom = document.createElement('div');
        dom.className = 'editor-obyvatele';
        dom.setAttribute('contenteditable', 'false');
        var p = document.createElement('p');
        p.textContent =
          '📈 Vývoj počtu obyvatel — graf a tabulka podle evidence Ministerstva vnitra se na webu doplní samy (aktualizace jednou ročně).';
        dom.appendChild(p);
        return { dom: dom };
      };
    },
  });

  // ---------- fotogalerie obce vložená do textu ----------
  // <figure class="galerie-obce" data-galerie="id" data-rozlozeni="mrizka|pas|velka" data-pocet="0|3|6|9|12">
  //   <a href="/galerie/slug">Název</a></figure> — web ji vykreslí živě z alba (nové fotky se objeví samy).

  var seznamGalerii = null;
  function nactiGalerie(znovu) {
    if (!seznamGalerii || znovu)
      seznamGalerii = fetch('/sprava/web/galerie.json', { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('Seznam galerií se nepodařilo načíst.');
          return r.json();
        })
        .catch(function (e) {
          seznamGalerii = null;
          throw e;
        });
    return seznamGalerii;
  }
  var ROZLOZENI = { mrizka: 'Mřížka', pas: 'Pás náhledů', velka: 'Velká + náhledy' };

  var GalerieObce = Node.create({
    name: 'galerieObce',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: function () {
      return {
        id: { default: null },
        nazev: { default: 'Fotogalerie' },
        slug: { default: '' },
        rozlozeni: { default: 'mrizka' },
        pocet: { default: '6' },
      };
    },
    parseHTML: function () {
      return [
        {
          tag: 'figure.galerie-obce',
          priority: 80,
          getAttrs: function (el) {
            var id = el.getAttribute('data-galerie');
            if (!/^[0-9a-f-]{36}$/.test(id || '')) return false;
            var a = el.querySelector('a');
            var href = a ? a.getAttribute('href') || '' : '';
            return {
              id: id,
              nazev: a ? a.textContent : 'Fotogalerie',
              slug: href.replace(/^\/galerie\//, ''),
              rozlozeni: el.getAttribute('data-rozlozeni') || 'mrizka',
              pocet: el.getAttribute('data-pocet') || '6',
            };
          },
        },
      ];
    },
    renderHTML: function (p) {
      var a = p.node.attrs;
      return [
        'figure',
        {
          class: 'galerie-obce',
          'data-galerie': a.id,
          'data-rozlozeni': a.rozlozeni,
          'data-pocet': a.pocet,
        },
        ['a', { href: '/galerie/' + (a.slug || '') }, a.nazev || 'Fotogalerie'],
      ];
    },
    addNodeView: function () {
      return function (p) {
        var dom = document.createElement('div');
        dom.className = 'editor-galerie-obce';
        dom.setAttribute('contenteditable', 'false');
        var hlava = document.createElement('p');
        var nahledy = document.createElement('div');
        nahledy.className = 'nahledy';
        var varovani = document.createElement('p');
        varovani.className = 'varovani';
        varovani.hidden = true;
        dom.appendChild(hlava);
        dom.appendChild(nahledy);
        dom.appendChild(varovani);
        var node = p.node;
        function vykresli() {
          var a = node.attrs;
          dom.setAttribute('data-rozlozeni', a.rozlozeni);
          hlava.textContent =
            '🖼 Fotogalerie: ' +
            a.nazev +
            ' · ' +
            (ROZLOZENI[a.rozlozeni] || '') +
            ' · ' +
            (a.pocet === '0' ? 'všechny fotky' : 'ukáže ' + a.pocet + ' fotek');
          nactiGalerie()
            .then(function (seznam) {
              var g = seznam.find(function (x) {
                return x.id === a.id;
              });
              nahledy.textContent = '';
              varovani.hidden = true;
              if (!g) {
                varovani.hidden = false;
                varovani.textContent = '⚠ Galerie neexistuje nebo je v koši — na webu se nezobrazí.';
                return;
              }
              g.nahledy.forEach(function (id) {
                var i = document.createElement('img');
                i.src = '/soubory/' + id + '/nahled?v=nahled';
                i.alt = '';
                i.loading = 'lazy';
                nahledy.appendChild(i);
              });
              var n = document.createElement('span');
              n.textContent = g.pocet + ' fotek';
              nahledy.appendChild(n);
              if (g.stav !== 'zverejneno') {
                varovani.hidden = false;
                varovani.textContent =
                  '⚠ Galerie je koncept — na webu se nezobrazí, dokud ji nezveřejníte (v Galeriích).';
              }
            })
            .catch(function () {});
        }
        vykresli();
        return {
          dom: dom,
          update: function (n) {
            if (n.type !== node.type) return false;
            node = n;
            vykresli();
            return true;
          },
          ignoreMutation: function () {
            return true;
          },
        };
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
  function vlozObrazky(editor, soubory, pozice, galerieOk) {
    var obrazky = Array.prototype.filter.call(soubory, function (f) {
      return /^image\//.test(f.type);
    });
    // víc fotek najednou = skoro vždy fotky z akce → nabídnout galerii místo „nudle“ fotek pod sebou
    if (galerieOk && obrazky.length >= 4) {
      var titulek = document.getElementById('titulek');
      return dialog({
        nadpis: 'Vkládáte ' + obrazky.length + ' fotek',
        napoveda:
          'Víc fotek vypadá na webu nejlépe jako fotogalerie: v textu se ukáže pár náhledů a návštěvník si klikne na další. Galerie bude „jen pro příspěvky“ (na stránce Fotogalerie se nezobrazí, můžete to změnit).',
        pole: [
          {
            klic: 'jak',
            label: 'Vložit jako',
            moznosti: [
              { hodnota: 'galerie', text: 'Fotogalerii (doporučeno)' },
              { hodnota: 'jednotlive', text: 'Jednotlivé fotky pod sebe' },
            ],
          },
          {
            klic: 'nazev',
            label: 'Název galerie',
            hodnota: titulek && titulek.value ? titulek.value : '',
          },
        ],
        ok: 'Pokračovat',
      }).then(function (v) {
        if (!v) return;
        if (v.jak !== 'galerie') return vlozJednotlive(editor, obrazky, pozice);
        return nahrajGalerii(v.nazev || 'Fotogalerie', obrazky)
          .then(function (g) {
            vlozGalerii(editor, g, pozice);
          })
          .catch(function (e) {
            window.alert(e.message);
          });
      });
    }
    return vlozJednotlive(editor, obrazky, pozice);
  }

  function vlozGalerii(editor, g, pozice) {
    var max = editor.state.doc.content.size;
    editor
      .chain()
      .focus()
      .insertContentAt(Math.min(pozice, max), {
        type: 'galerieObce',
        attrs: { id: g.id, nazev: g.nazev, slug: g.slug, rozlozeni: 'mrizka', pocet: '6' },
      })
      .run();
  }

  function vlozJednotlive(editor, soubory, pozice) {
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

  // ---------- fotogalerie: výběr a nahrání ----------

  function bezDiakritiky(t) {
    return String(t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  /** dialog s náhledy galerií; vrací vybranou galerii, {nova: true} nebo null */
  function vyberGalerii() {
    return nactiGalerie(true).then(function (seznam) {
      return new Promise(function (hotovo) {
        var d = document.createElement('dialog');
        d.className = 'alt-dialog editor-vyber-galerie';
        d.setAttribute('aria-labelledby', 'vg-h');
        var h = document.createElement('h2');
        h.id = 'vg-h';
        h.textContent = 'Vložit fotogalerii';
        var n = document.createElement('p');
        n.className = 'napoveda';
        n.textContent =
          'Galerie se do textu vloží živě — když do ní později přidáte fotky nebo opravíte popisky, změní se i tady.';
        var hl = document.createElement('input');
        hl.type = 'search';
        hl.placeholder = 'Hledat galerii…';
        hl.setAttribute('aria-label', 'Hledat galerii');
        var ul = document.createElement('ul');
        var nova = document.createElement('button');
        nova.type = 'button';
        nova.className = 'tlacitko';
        nova.textContent = '+ Nová galerie z fotek…';
        var zr = document.createElement('button');
        zr.type = 'button';
        zr.className = 'tlacitko sekundarni';
        zr.textContent = 'Zrušit';
        var dole = document.createElement('div');
        dole.className = 'tlacitka-dole';
        dole.appendChild(nova);
        dole.appendChild(document.createTextNode(' '));
        dole.appendChild(zr);
        [h, n, hl, ul, dole].forEach(function (x) {
          d.appendChild(x);
        });
        var vysledek = null;
        function zavri(v) {
          vysledek = v;
          d.close();
        }
        function vypis() {
          var q = bezDiakritiky(hl.value);
          ul.textContent = '';
          var nalezene = seznam.filter(function (g) {
            return !q || bezDiakritiky(g.nazev).indexOf(q) >= 0;
          });
          if (!nalezene.length) {
            var li0 = document.createElement('li');
            li0.className = 'napoveda';
            li0.textContent = seznam.length ? 'Nic nenalezeno.' : 'Zatím tu není žádná galerie.';
            ul.appendChild(li0);
          }
          nalezene.slice(0, 60).forEach(function (g) {
            var li = document.createElement('li');
            var b = document.createElement('button');
            b.type = 'button';
            if (g.nahledy[0]) {
              var i = document.createElement('img');
              i.src = '/soubory/' + g.nahledy[0] + '/nahled?v=nahled';
              i.alt = '';
              i.loading = 'lazy';
              b.appendChild(i);
            } else {
              var pr = document.createElement('span');
              pr.className = 'prazdny';
              b.appendChild(pr);
            }
            var st = document.createElement('strong');
            st.textContent = g.nazev;
            var po = document.createElement('small');
            po.textContent =
              (g.datum ? g.datum.split('-').reverse().join('. ') + ' · ' : '') +
              g.pocet +
              ' fotek' +
              (g.stav !== 'zverejneno' ? ' · koncept' : g.v_seznamu ? '' : ' · jen pro příspěvky');
            b.appendChild(st);
            b.appendChild(po);
            b.addEventListener('click', function () {
              zavri(g);
            });
            li.appendChild(b);
            ul.appendChild(li);
          });
        }
        hl.addEventListener('input', vypis);
        nova.addEventListener('click', function () {
          zavri({ nova: true });
        });
        zr.addEventListener('click', function () {
          zavri(null);
        });
        d.addEventListener('close', function () {
          d.remove();
          hotovo(vysledek);
        });
        vypis();
        document.body.appendChild(d);
        d.showModal();
        hl.focus();
      });
    });
  }

  function vyberSoubory(prijmout, vice) {
    return new Promise(function (hotovo) {
      var v = document.createElement('input');
      v.type = 'file';
      v.accept = prijmout;
      v.multiple = !!vice;
      v.addEventListener('change', function () {
        hotovo(Array.prototype.slice.call(v.files || []));
      });
      v.click();
    });
  }

  function postJson(url, fd) {
    return fetch(url, {
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

  /** založí galerii „jen pro příspěvky“ a nahraje fotky po dávkách; vrací galerii pro vložení */
  function nahrajGalerii(nazev, soubory) {
    var stav = document.getElementById('autosave-stav');
    var DAVKA = 10;
    var chyby = [];
    var hlas = function (i) {
      if (stav) stav.textContent = 'Nahrávám fotky do galerie: ' + i + ' z ' + soubory.length + '…';
    };
    var davka = function (od) {
      var fd = new FormData();
      soubory.slice(od, od + DAVKA).forEach(function (f) {
        fd.append('fotky', f, f.name);
      });
      return fd;
    };
    hlas(0);
    var prvni = davka(0);
    prvni.append('nazev', nazev);
    return postJson('/sprava/web/galerie/nova.json', prvni).then(function (g) {
      chyby = chyby.concat(g.chyby || []);
      var postup = Promise.resolve();
      for (var od = DAVKA; od < soubory.length; od += DAVKA)
        (function (od) {
          postup = postup.then(function () {
            hlas(od);
            return postJson('/sprava/web/galerie/' + g.id + '/fotky.json', davka(od)).then(function (j) {
              chyby = chyby.concat(j.chyby || []);
            });
          });
        })(od);
      return postup.then(function () {
        if (stav) stav.textContent = '';
        if (chyby.length) window.alert(chyby.join('\n'));
        nactiGalerie(true);
        return g;
      });
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

  var editory = [];
  document.querySelectorAll('textarea[data-editor]').forEach(function (ta) {
    var plny = ta.getAttribute('data-editor') === 'plny';
    var galerieOk = plny && ta.getAttribute('data-galerie') === '1';
    var htmlOk = plny && ta.getAttribute('data-html') === '1';
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
          placeholder: plny
            ? 'Pište text… Napište „/“ pro nabídku (fotka, galerie, tabulka…), fotky můžete i přetáhnout.'
            : 'Pište text…',
        }),
        Obrazek,
        VideoObce,
        Galerie,
        GalerieObce,
        ObyvateleVyvoj,
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
          vlozObrazky(editor, obr, view.state.selection.from, galerieOk);
          return true;
        },
        handleKeyDown: function (view, e) {
          return lomitko.klavesa(e);
        },
        handleDrop: function (view, event, slice, moved) {
          if (moved) return false; // přesun uvnitř textu (i obrázku) obsluhuje editor sám
          var obr = plny ? obrazkyZ(event.dataTransfer) : [];
          if (!obr.length) return false;
          event.preventDefault();
          var misto = view.posAtCoords({ left: event.clientX, top: event.clientY });
          vlozObrazky(editor, obr, misto ? misto.pos : view.state.selection.from, galerieOk);
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
        vlozObrazky(editor, v.files, pos, galerieOk);
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
    function galerie() {
      var pos = editor.state.selection.from;
      vyberGalerii()
        .then(function (g) {
          if (!g) return;
          if (!g.nova) return vlozGalerii(editor, g, pos);
          return vyberSoubory('image/*', true).then(function (soubory) {
            if (!soubory.length) return;
            var titulek = document.getElementById('titulek');
            return dialog({
              nadpis: 'Nová fotogalerie',
              napoveda:
                'Galerie bude „jen pro příspěvky“ — na stránce Fotogalerie se neukáže, dokud to v Galeriích nezměníte.',
              pole: [
                {
                  klic: 'nazev',
                  label: 'Název galerie',
                  hodnota: titulek && titulek.value ? titulek.value : '',
                  povinne: true,
                },
              ],
              ok: 'Nahrát ' + soubory.length + ' fotek',
            }).then(function (v) {
              if (!v) return;
              return nahrajGalerii(v.nazev, soubory).then(function (ng) {
                vlozGalerii(editor, ng, pos);
              });
            });
          });
        })
        .catch(function (e) {
          window.alert(e.message);
        });
    }
    function vybranyUzel(jmeno) {
      var s = editor.state.selection;
      return s instanceof NodeSelection && s.node.type.name === jmeno ? { pos: s.from, node: s.node } : null;
    }
    function vybranyObrazek() {
      return vybranyUzel('obrazek');
    }
    function odkazObrazku(pos, node) {
      dialog({
        nadpis: 'Odkaz z obrázku',
        napoveda: 'Kam vede kliknutí na obrázek (https://…, /stránka obce). Prázdné = bez odkazu.',
        pole: [{ klic: 'href', label: 'Adresa', hodnota: node.attrs.odkaz || '' }],
        ok: 'Uložit',
      }).then(function (v) {
        if (!v) return;
        var href = /^www\./i.test(v.href) ? 'https://' + v.href : v.href;
        if (href && !jeBezpecnyOdkaz(href)) return window.alert('Odkaz musí začínat https:// nebo /.');
        nastavObrazek(pos, { odkaz: href || null });
      });
    }
    function vymenObrazek(pos, node) {
      vyberSoubory('image/*', false).then(function (f) {
        if (!f.length) return;
        nahrajObrazek(f[0])
          .then(function (j) {
            return zeptejSeNaPopis(node.attrs.alt || j.navrhAlt).then(function (alt) {
              if (alt === null) return;
              nastavObrazek(pos, { src: j.url, soubor: j.id || null, alt: alt, width: null });
            });
          })
          .catch(function (e) {
            window.alert(e.message);
          });
      });
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
        skupina(
          [tlacitko('🖼 Fotka', 'Vložit fotku na místo kurzoru', obrazekZDisku)]
            .concat(galerieOk ? [tlacitko('▦ Galerie', 'Vložit fotogalerii', galerie)] : [])
            .concat([tlacitko('▶ Video', 'Vložit video z knihovny videí', video)]),
        ),
      );
    prvky.push(
      skupina([
        tlacitko('⊞ Tabulka', 'Vložit tabulku 3 × 3 se záhlavím', function () {
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
    kontext.appendChild(tabulkaLista);

    // ---- plovoucí lištička u vybrané fotky / galerie ----
    obal.classList.add('editor-obal-rel');
    var bublina = document.createElement('div');
    bublina.className = 'editor-bublina';
    bublina.setAttribute('role', 'toolbar');
    bublina.hidden = true;
    obal.appendChild(bublina);
    function volba(text, popisek, akce, aktivni) {
      var b = tlacitko(text, popisek, akce, aktivni);
      return b;
    }
    function sObrazkem(fn) {
      return function () {
        var o = vybranyObrazek();
        if (o) fn(o.pos, o.node);
      };
    }
    function jeObr(klic, hodnota) {
      return function () {
        var o = vybranyObrazek();
        return !!o && (o.node.attrs[klic] || null) === hodnota;
      };
    }
    var velikosti = [
      ['Malá', 'Třetina šířky textu', '33'],
      ['Střední', 'Polovina šířky textu', '50'],
      ['Velká', 'Tři čtvrtiny šířky textu', '75'],
      ['Celá', 'Přes celou šířku textu', null],
    ];
    var obrBublina = skupina(
      [document.createTextNode('Velikost: ')]
        .concat(
          velikosti.map(function (v) {
            return volba(
              v[0],
              v[1],
              sObrazkem(function (pos) {
                var attrs = { sirka: v[2], width: null };
                if (!v[2]) attrs.zarovnani = null; // přes celou šířku nejde obtékat
                nastavObrazek(pos, attrs);
              }),
              function () {
                var o = vybranyObrazek();
                return !!o && (o.node.attrs.sirka || null) === v[2] && !(v[2] === null && o.node.attrs.width);
              },
            );
          }),
        )
        .concat([document.createTextNode(' ')])
        .concat(
          [
            ['⇤ Vlevo', 'Vlevo, text obtéká zprava', 'vlevo'],
            ['Na střed', 'Na střed, bez obtékání', null],
            ['Vpravo ⇥', 'Vpravo, text obtéká zleva', 'vpravo'],
          ].map(function (z) {
            return volba(
              z[0],
              z[1],
              sObrazkem(function (pos, node) {
                var attrs = { zarovnani: z[2] };
                // obtékaná fotka přes celou šířku nedává smysl → rovnou polovina
                if (z[2] && !node.attrs.sirka) attrs.sirka = '50';
                attrs.width = null;
                nastavObrazek(pos, attrs);
              }),
              jeObr('zarovnani', z[2]),
            );
          }),
        )
        .concat([
          document.createTextNode(' '),
          volba('Popis…', 'Popis obrázku pro nevidomé (povinný)', sObrazkem(upravPopis)),
          volba('Titulek…', 'Titulek pod obrázkem', sObrazkem(upravTitulek)),
          volba('🔗', 'Odkaz z obrázku', sObrazkem(odkazObrazku)),
          volba('Vyměnit…', 'Nahradit jinou fotkou (velikost a umístění zůstanou)', sObrazkem(vymenObrazek)),
          volba('✕', 'Odstranit obrázek', function () {
            c().deleteSelection().run();
          }),
        ]),
    );
    function sGalerii(attrs) {
      return function () {
        var g = vybranyUzel('galerieObce');
        if (!g) return;
        editor
          .chain()
          .focus()
          .command(function (p) {
            p.tr.setNodeMarkup(g.pos, undefined, Object.assign({}, g.node.attrs, attrs));
            return true;
          })
          .setNodeSelection(g.pos)
          .run();
      };
    }
    function jeGal(klic, hodnota) {
      return function () {
        var g = vybranyUzel('galerieObce');
        return !!g && g.node.attrs[klic] === hodnota;
      };
    }
    var galBublina = skupina(
      [document.createTextNode('Vzhled: ')]
        .concat(
          Object.keys(ROZLOZENI).map(function (k) {
            return volba(
              ROZLOZENI[k],
              'Rozložení galerie: ' + ROZLOZENI[k],
              sGalerii({ rozlozeni: k }),
              jeGal('rozlozeni', k),
            );
          }),
        )
        .concat([document.createTextNode(' Ukázat: ')])
        .concat(
          [
            ['3', '3'],
            ['6', '6'],
            ['9', '9'],
            ['12', '12'],
            ['vše', '0'],
          ].map(function (x) {
            return volba(
              x[0],
              x[1] === '0' ? 'Ukázat všechny fotky' : 'Ukázat ' + x[0] + ' fotek, další po kliknutí',
              sGalerii({ pocet: x[1] }),
              jeGal('pocet', x[1]),
            );
          }),
        )
        .concat([
          document.createTextNode(' '),
          volba('Upravit galerii ↗', 'Otevřít galerii v nové kartě (fotky, popisy, zveřejnění)', function () {
            var g = vybranyUzel('galerieObce');
            if (g) window.open('/sprava/web/galerie/' + g.node.attrs.id, '_blank');
          }),
          volba('Jiná…', 'Vybrat jinou galerii', function () {
            var g = vybranyUzel('galerieObce');
            if (!g) return;
            vyberGalerii().then(function (ng) {
              if (ng && !ng.nova) sGalerii({ id: ng.id, nazev: ng.nazev, slug: ng.slug })();
            });
          }),
          volba('✕', 'Odstranit galerii z textu (galerie sama zůstane)', function () {
            c().deleteSelection().run();
          }),
        ]),
    );
    bublina.appendChild(obrBublina);
    bublina.appendChild(galBublina);
    function umistiBublinu() {
      var o = vybranyObrazek();
      var g = vybranyUzel('galerieObce');
      var vybrano = o || g;
      bublina.hidden = !vybrano || htmlRezim;
      if (bublina.hidden) return;
      obrBublina.hidden = !o;
      galBublina.hidden = !g;
      bublina.querySelectorAll('.editor-tl').forEach(function (b) {
        if (b._aktivni) b.setAttribute('aria-pressed', b._aktivni() ? 'true' : 'false');
      });
      var dom = editor.view.nodeDOM(vybrano.pos);
      if (!dom || !dom.getBoundingClientRect) return;
      var r = dom.getBoundingClientRect();
      var ro = obal.getBoundingClientRect();
      var vyska = bublina.offsetHeight;
      var nahore = r.top - ro.top - vyska - 8;
      // nad fotkou není místo (začátek textu / lišta) → pod ní
      if (
        r.top - vyska - 8 <
        (parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--vyska-menu')) ||
          0) +
          lista.offsetHeight
      )
        nahore = r.bottom - ro.top + 8;
      var vlevo = Math.max(0, Math.min(r.left - ro.left, obal.clientWidth - bublina.offsetWidth));
      bublina.style.top = nahore + 'px';
      bublina.style.left = vlevo + 'px';
    }
    window.addEventListener('scroll', umistiBublinu, { passive: true });
    window.addEventListener('resize', umistiBublinu);

    var htmlRezim = false;

    // ---- nabídka přes lomítko: „/“ na začátku prázdného odstavce ----
    var lomitko = (function () {
      var menu = document.createElement('div');
      menu.className = 'editor-lomitko';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', 'Vložit');
      menu.hidden = true;
      obal.appendChild(menu);
      var polozky = [
        [
          'Nadpis',
          'nadpis h2',
          function () {
            c().setHeading({ level: 2 }).run();
          },
        ],
        [
          'Podnadpis',
          'podnadpis h3',
          function () {
            c().setHeading({ level: 3 }).run();
          },
        ],
        [
          'Odrážky',
          'seznam odrazky',
          function () {
            c().toggleBulletList().run();
          },
        ],
        [
          'Číslovaný seznam',
          'cislovany seznam',
          function () {
            c().toggleOrderedList().run();
          },
        ],
        [
          'Citace',
          'citace',
          function () {
            c().toggleBlockquote().run();
          },
        ],
      ];
      if (plny) {
        polozky.push(['Fotka', 'fotka obrazek foto', obrazekZDisku]);
        if (galerieOk) polozky.push(['Fotogalerie', 'galerie fotogalerie fotky album', galerie]);
        polozky.push(['Video', 'video', video]);
        polozky.push([
          'Vývoj počtu obyvatel',
          'obyvatele obyvatel pocet graf statistika',
          function () {
            c().insertContent({ type: 'obyvateleVyvoj' }).run();
          },
        ]);
      }
      polozky.push(
        [
          'Tabulka',
          'tabulka',
          function () {
            c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          },
        ],
        [
          'Vodorovná čára',
          'cara oddelovac',
          function () {
            c().setHorizontalRule().run();
          },
        ],
        ['Odkaz', 'odkaz link', odkaz],
      );
      var stav = { otevreno: false, od: 0, vyber: 0, nalezene: [], zavrenoNa: null };
      function zavri() {
        stav.otevreno = false;
        menu.hidden = true;
      }
      function proved(i) {
        var p = stav.nalezene[i];
        if (!p) return;
        var od = stav.od;
        var doPos = editor.state.selection.from;
        zavri();
        editor.chain().focus().deleteRange({ from: od, to: doPos }).run();
        p[2]();
      }
      function vykresli() {
        menu.textContent = '';
        stav.nalezene.forEach(function (p, i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.setAttribute('aria-selected', i === stav.vyber ? 'true' : 'false');
          b.textContent = p[0];
          b.addEventListener('mousedown', function (e) {
            e.preventDefault();
            proved(i);
          });
          menu.appendChild(b);
        });
      }
      return {
        obnov: function () {
          var sel = editor.state.selection;
          var $f = sel.$from;
          if (htmlRezim || !sel.empty || $f.parent.type.name !== 'paragraph') return zavri();
          var pred = $f.parent.textBetween(0, $f.parentOffset, undefined, '￼');
          var m = /^\/([^\s/]{0,20})$/.exec(pred);
          var od = $f.pos - pred.length;
          if (!m || stav.zavrenoNa === od) {
            if (!m) stav.zavrenoNa = null;
            return zavri();
          }
          var q = bezDiakritiky(m[1]);
          stav.nalezene = polozky.filter(function (p) {
            return !q || bezDiakritiky(p[0] + ' ' + p[1]).indexOf(q) >= 0;
          });
          if (!stav.nalezene.length) return zavri();
          if (!stav.otevreno || stav.od !== od) stav.vyber = 0;
          stav.vyber = Math.min(stav.vyber, stav.nalezene.length - 1);
          stav.otevreno = true;
          stav.od = od;
          vykresli();
          menu.hidden = false;
          var k = editor.view.coordsAtPos($f.pos);
          var ro = obal.getBoundingClientRect();
          menu.style.top = k.bottom - ro.top + 4 + 'px';
          menu.style.left = Math.max(0, Math.min(k.left - ro.left, obal.clientWidth - 220)) + 'px';
        },
        klavesa: function (e) {
          if (!stav.otevreno) return false;
          var n = stav.nalezene.length;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            stav.vyber = (stav.vyber + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            vykresli();
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            proved(stav.vyber);
            return true;
          }
          if (e.key === 'Escape') {
            stav.zavrenoNa = stav.od;
            zavri();
            return true;
          }
          return false;
        },
      };
    })();

    // ---- úchyt bloku: ⠿ vlevo od odstavce / fotky / tabulky, tažením se blok přesune ----
    if (plny && window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
      var uchyt = document.createElement('div');
      uchyt.className = 'editor-uchyt-bloku';
      uchyt.textContent = '⠿';
      uchyt.title = 'Táhněte pro přesun bloku';
      uchyt.draggable = true;
      uchyt.hidden = true;
      uchyt.setAttribute('aria-hidden', 'true');
      obal.appendChild(uchyt);
      var blokPos = null;
      var blokDom = null;
      var najdiBlok = function (y) {
        var r = editor.view.dom.getBoundingClientRect();
        var el = document.elementFromPoint(r.left + r.width / 2, y);
        var nalez = null;
        editor.state.doc.forEach(function (node, offset) {
          if (nalez) return;
          var d = editor.view.nodeDOM(offset);
          if (d && el && (d === el || (d.contains && d.contains(el)))) nalez = { pos: offset, dom: d };
        });
        return nalez;
      };
      var cekam = false;
      editor.view.dom.addEventListener('mousemove', function (e) {
        if (cekam || htmlRezim) return;
        cekam = true;
        requestAnimationFrame(function () {
          cekam = false;
          var b = najdiBlok(e.clientY);
          if (!b || !b.dom.getBoundingClientRect) return;
          blokPos = b.pos;
          blokDom = b.dom;
          var r = b.dom.getBoundingClientRect();
          var ro = obal.getBoundingClientRect();
          uchyt.style.top = r.top - ro.top + 2 + 'px';
          uchyt.hidden = false;
        });
      });
      obal.addEventListener('mouseleave', function () {
        uchyt.hidden = true;
      });
      editor.view.dom.addEventListener('keydown', function () {
        uchyt.hidden = true;
      });
      uchyt.addEventListener('dragstart', function (e) {
        if (blokPos === null) return e.preventDefault();
        var view = editor.view;
        var tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, blokPos));
        view.dispatch(tr);
        var slice = view.state.selection.content();
        view.dragging = { slice: slice, move: true };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', slice.content.textBetween(0, slice.content.size, '\n\n'));
        if (blokDom && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(blokDom, 0, 0);
      });
      uchyt.addEventListener('dragend', function () {
        uchyt.hidden = true;
      });
    }

    function obnovListu() {
      lista.querySelectorAll('.editor-tl').forEach(function (b) {
        if (b._aktivni) b.setAttribute('aria-pressed', b._aktivni() ? 'true' : 'false');
      });
      var h = [2, 3, 4].find(function (l) {
        return editor.isActive('heading', { level: l });
      });
      styl.value = h ? String(h) : 'p';
      var vTabulce = editor.isActive('table');
      tabulkaLista.hidden = !vTabulce;
      kontext.hidden = !vTabulce || htmlRezim;
      umistiBublinu();
      lomitko.obnov();
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
      if (htmlRezim) prevezmiHtml(false);
      ta.value = cisteHtml();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ---- ruční úprava HTML (jen redaktor webu): editor i server pustí jen povolenou strukturu ----
    var htmlPole = null;
    var htmlZprava = null;
    var htmlTl = null;
    function formatujHtml(h) {
      return h
        .replace(/(<\/(p|h[2-4]|li|ul|ol|blockquote|figure|table|thead|tbody|tr)>|<hr>)/g, '$1\n')
        .replace(/(<(ul|ol|table|thead|tbody|tr)>)/g, '$1\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    }
    function spocitej(html) {
      var doc = new window.DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
      var n = {};
      doc.body.querySelectorAll('*').forEach(function (el) {
        var t = el.tagName.toLowerCase();
        n['<' + t + '>'] = (n['<' + t + '>'] || 0) + 1;
        Array.prototype.forEach.call(el.attributes, function (a) {
          var k = 'atribut ' + a.name + (a.name === 'class' ? '="' + a.value + '"' : '');
          n[k] = (n[k] || 0) + 1;
        });
      });
      return n;
    }
    var prebiram = false;
    function prevezmiHtml(hlasit) {
      if (prebiram) return;
      prebiram = true;
      var puvodni = htmlPole.value;
      editor.commands.setContent(puvodni, { emitUpdate: true });
      prebiram = false;
      if (!hlasit) return;
      var pred = spocitej(puvodni);
      var po = spocitej(cisteHtml());
      var chybi = Object.keys(pred)
        .filter(function (k) {
          return pred[k] > (po[k] || 0);
        })
        .map(function (k) {
          var x = pred[k] - (po[k] || 0);
          return k + (x > 1 ? ' (' + x + '×)' : '');
        });
      htmlZprava.hidden = !chybi.length;
      htmlZprava.textContent = chybi.length
        ? 'Editor z HTML vynechal, co web nepovoluje (styly, skripty, neznámé značky): ' +
          chybi.join(', ') +
          '.'
        : '';
    }
    function prepniHtml() {
      if (!htmlPole) {
        htmlPole = document.createElement('textarea');
        htmlPole.className = 'editor-html';
        htmlPole.spellcheck = false;
        htmlPole.setAttribute('aria-label', 'HTML textu');
        htmlPole.hidden = true;
        htmlZprava = document.createElement('p');
        htmlZprava.className = 'editor-html-zprava';
        htmlZprava.setAttribute('role', 'status');
        htmlZprava.hidden = true;
        obal.insertBefore(htmlZprava, pole);
        obal.insertBefore(htmlPole, pole.nextSibling);
        htmlPole.addEventListener('input', function () {
          // automatické ukládání bere textareu formuláře; HTML vyčistí server
          ta.value = htmlPole.value;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      htmlRezim = !htmlRezim;
      if (htmlRezim) {
        htmlPole.value = formatujHtml(cisteHtml());
        htmlZprava.hidden = true;
      } else {
        prevezmiHtml(true);
      }
      htmlPole.hidden = !htmlRezim;
      pole.hidden = htmlRezim;
      lista.classList.toggle('jen-html', htmlRezim);
      htmlTl.setAttribute('aria-pressed', htmlRezim ? 'true' : 'false');
      obnovListu();
      (htmlRezim ? htmlPole : editor.view.dom).focus();
    }
    if (htmlOk) {
      htmlTl = tlacitko('</> HTML', 'Upravit HTML ručně (pro pokročilé)', prepniHtml);
      htmlTl.classList.add('editor-tl-html');
      lista.appendChild(skupina([htmlTl]));
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

    if (plny)
      editory.push({
        editor: editor,
        ta: ta,
        galerieOk: galerieOk,
        prevezmi: function () {
          if (htmlRezim) prevezmiHtml(false);
        },
      });

    // rozhraní pro jiné skripty stránky (kopírování mezi poli hlášení, public/js/hlaseni.js)
    ta.editorApi = {
      text: function () {
        return editor.getText({ blockSeparator: '\n\n' });
      },
      html: function () {
        if (htmlRezim) prevezmiHtml(false);
        return cisteHtml();
      },
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

  // ---- kontrola před zveřejněním: upozorní, nebrání (kromě obrázku bez popisu to hlídá i server) ----
  var NIC_NERIKAJICI = [
    'zde',
    'klikněte zde',
    'klikni zde',
    'klikněte sem',
    'tady',
    'sem',
    'více',
    'odkaz',
    'link',
    'here',
  ];
  function kontrola() {
    var problemy = [];
    var galerieVTextu = [];
    editory.forEach(function (x) {
      x.prevezmi();
      var doc = x.editor.state.doc;
      var bezPopisu = 0;
      var prazdneNadpisy = 0;
      var verzalky = 0;
      var odkazy = [];
      var radaFotek = 0;
      var nejdelsiRada = 0;
      doc.forEach(function (n) {
        radaFotek = n.type.name === 'obrazek' ? radaFotek + 1 : 0;
        nejdelsiRada = Math.max(nejdelsiRada, radaFotek);
      });
      doc.descendants(function (n) {
        if (n.type.name === 'obrazek' && !String(n.attrs.alt || '').trim()) bezPopisu++;
        if (n.type.name === 'heading' && !n.textContent.trim()) prazdneNadpisy++;
        if (n.type.name === 'galerieObce') galerieVTextu.push(n.attrs);
        if (n.type.name === 'paragraph') {
          var pismena = n.textContent.replace(/[^\p{L}]/gu, '');
          if (pismena.length >= 30 && pismena === pismena.toUpperCase() && pismena !== pismena.toLowerCase())
            verzalky++;
        }
        if (n.isText) {
          var l = n.marks.find(function (m) {
            return m.type.name === 'link';
          });
          var t = n.text
            .trim()
            .toLowerCase()
            .replace(/[.!:…]+$/, '');
          if (l && NIC_NERIKAJICI.indexOf(t) >= 0) odkazy.push('„' + n.text.trim() + '“');
        }
      });
      if (bezPopisu)
        problemy.push(
          bezPopisu +
            '× obrázek bez popisu pro nevidomé (klikněte na obrázek → Popis…). Bez popisu web příspěvek nezveřejní.',
        );
      if (prazdneNadpisy) problemy.push(prazdneNadpisy + '× prázdný nadpis.');
      if (odkazy.length)
        problemy.push(
          'Odkaz s textem ' +
            odkazy.join(', ') +
            ' — nevidomí slyší jen „odkaz zde“. Napište, kam vede (např. „Přihláška na tábor (PDF)“).',
        );
      if (verzalky)
        problemy.push(verzalky + '× odstavec psaný VELKÝMI PÍSMENY — čte se hůř; zvýraznit jde tučně.');
      if (x.galerieOk && nejdelsiRada >= 4)
        problemy.push(
          nejdelsiRada +
            ' fotek pod sebou — zkuste je dát do fotogalerie (tlačítko Galerie), bude to přehlednější.',
        );
    });
    if (!galerieVTextu.length) return Promise.resolve(problemy);
    return nactiGalerie(true)
      .then(function (seznam) {
        galerieVTextu.forEach(function (a) {
          var g = seznam.find(function (x) {
            return x.id === a.id;
          });
          if (!g)
            problemy.push('Galerie „' + a.nazev + '“ neexistuje nebo je v koši — na webu se nezobrazí.');
          else if (g.stav !== 'zverejneno')
            problemy.push(
              'Galerie „' + g.nazev + '“ je koncept — na webu se nezobrazí, dokud ji nezveřejníte.',
            );
        });
        return problemy;
      })
      .catch(function () {
        return problemy;
      });
  }
  var zkontrolovano = false;
  form.addEventListener(
    'submit',
    function (e) {
      var tl = e.submitter;
      if (zkontrolovano || !editory.length || !tl || tl.value !== 'zverejnit') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      kontrola().then(function (problemy) {
        if (!problemy.length) {
          zkontrolovano = true;
          // ne ve stejné úloze: během události submit prohlížeč nové odeslání tiše zahodí
          return setTimeout(function () {
            form.requestSubmit(tl);
          });
        }
        var d = document.createElement('dialog');
        d.className = 'alt-dialog editor-kontrola';
        var h = document.createElement('h2');
        h.textContent = 'Než to zveřejníte';
        var ul = document.createElement('ul');
        problemy.forEach(function (p) {
          var li = document.createElement('li');
          li.textContent = p;
          ul.appendChild(li);
        });
        var dole = document.createElement('div');
        dole.className = 'tlacitka-dole';
        var oprav = document.createElement('button');
        oprav.type = 'button';
        oprav.className = 'tlacitko';
        oprav.textContent = 'Opravím to';
        var presto = document.createElement('button');
        presto.type = 'button';
        presto.className = 'tlacitko sekundarni';
        presto.textContent = 'Přesto zveřejnit';
        dole.appendChild(oprav);
        dole.appendChild(document.createTextNode(' '));
        dole.appendChild(presto);
        [h, ul, dole].forEach(function (x) {
          d.appendChild(x);
        });
        oprav.addEventListener('click', function () {
          d.close();
        });
        presto.addEventListener('click', function () {
          d.close();
          zkontrolovano = true;
          form.requestSubmit(tl);
        });
        d.addEventListener('close', function () {
          d.remove();
        });
        document.body.appendChild(d);
        d.showModal();
        oprav.focus();
      });
    },
    true,
  );

  // ---- náhled na šířce mobilu: formulář se odešle do rámu v dialogu ----
  var mobilTl = form.querySelector('[data-nahled-mobil]');
  if (mobilTl) {
    mobilTl.hidden = false;
    var md = document.createElement('dialog');
    md.className = 'editor-nahled-mobil';
    md.setAttribute('aria-label', 'Náhled na mobilu');
    var ram = document.createElement('iframe');
    ram.name = 'nahled-mobil';
    ram.title = 'Náhled na mobilu';
    var zavrit = document.createElement('button');
    zavrit.type = 'button';
    zavrit.className = 'tlacitko sekundarni';
    zavrit.textContent = 'Zavřít náhled';
    zavrit.addEventListener('click', function () {
      md.close();
    });
    md.appendChild(ram);
    md.appendChild(zavrit);
    document.body.appendChild(md);
    mobilTl.addEventListener('click', function () {
      editory.forEach(function (x) {
        x.prevezmi();
      });
      md.showModal();
    });
  }

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
