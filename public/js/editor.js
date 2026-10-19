// Moje obec 2.0 — editor textu (Quill 2, vendorovaný z npm, žádné CDN).
// Vylepšuje <textarea data-editor>: bez JavaScriptu zůstává obyčejné pole (HTML se na serveru sanitizuje).
// Povolené formáty jsou jen strukturální (nadpisy, tučné, odkazy, seznamy, citace, obrázky, tabulky) — barvy
// a velikosti písma nejdou nastavit, takže vzhled webu nejde rozbít. Obrázek bez popisu (alt) nejde vložit.
(function () {
  'use strict';
  if (typeof Quill === 'undefined') return;
  var texty = document.getElementById('alt-dialog-sablona');
  var T = function (k, vychozi) {
    return (texty && texty.getAttribute('data-' + k)) || vychozi;
  };
  var csrfPole = document.querySelector('input[name="_csrf"]');
  var csrf = csrfPole ? csrfPole.value : '';

  // Video z knihovny videí webu: v uloženém HTML <figure class="video" data-video="id"><a href>Název</a></figure>
  // (sanitizace ho pustí, web ho vykreslí jako přehrávač). V editoru je to nepřepisovatelný blok s názvem.
  var BlockEmbed = Quill.import('blots/block/embed');
  var Delta = Quill.import('delta');
  class VideoObce extends BlockEmbed {
    static create(v) {
      var node = super.create();
      node.setAttribute('data-video', v.id);
      node.setAttribute('contenteditable', 'false');
      var a = document.createElement('a');
      a.setAttribute('href', v.odkaz || '#');
      a.textContent = v.nazev || 'Video';
      node.appendChild(a);
      return node;
    }
    static value(node) {
      var a = node.querySelector('a');
      return {
        id: node.getAttribute('data-video'),
        odkaz: a ? a.getAttribute('href') : '',
        nazev: a ? a.textContent : '',
      };
    }
    html() {
      var v = VideoObce.value(this.domNode);
      var f = document.createElement('figure');
      f.className = 'video';
      f.setAttribute('data-video', v.id);
      var a = document.createElement('a');
      a.setAttribute('href', v.odkaz || '/videa');
      a.textContent = v.nazev;
      f.appendChild(a);
      return f.outerHTML;
    }
  }
  VideoObce.blotName = 'videoObce';
  VideoObce.tagName = 'MO-VIDEO'; // vlastní značka, aby blok nepřebíral jiné <figure> (galerie)
  Quill.register(VideoObce);

  function vyberVideo() {
    return fetch('/sprava/web/videa.json', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (videa) {
        return new Promise(function (hotovo) {
          var d = document.createElement('dialog');
          d.className = 'alt-dialog';
          d.innerHTML =
            '<form method="dialog"><h2></h2><p class="napoveda" id="video-vyber-n"></p><label for="video-vyber"></label>' +
            '<select id="video-vyber" aria-describedby="video-vyber-n"></select>' +
            '<div class="tlacitka-dole"><button class="tlacitko" value="ok"></button> <button class="tlacitko sekundarni" value="zrusit" formnovalidate></button></div></form>';
          d.querySelector('h2').textContent = T('video-nadpis', 'Vložit video');
          d.querySelector('.napoveda').textContent = T('video-napoveda', '');
          d.querySelector('label').textContent = T('video-label', 'Video');
          var sel = d.querySelector('select');
          videa.forEach(function (v) {
            var o = document.createElement('option');
            o.value = v.id;
            o.textContent = v.nazev + (v.stav === 'zverejneno' ? '' : ' — ' + T('video-koncept', 'koncept'));
            sel.appendChild(o);
          });
          var ok = d.querySelector('button[value="ok"]');
          ok.textContent = T('ok', 'Vložit');
          ok.disabled = !videa.length;
          d.querySelector('button[value="zrusit"]').textContent = T('zrusit', 'Zrušit');
          d.addEventListener('close', function () {
            var v =
              d.returnValue === 'ok'
                ? videa.find(function (x) {
                    return x.id === sel.value;
                  })
                : null;
            d.remove();
            hotovo(v || null);
          });
          document.body.appendChild(d);
          d.showModal();
          sel.focus();
        });
      });
  }

  var POPISKY = {
    'ql-bold': 'Tučně',
    'ql-italic': 'Kurzíva',
    'ql-link': 'Vložit odkaz',
    'ql-list': 'Seznam',
    'ql-blockquote': 'Citace',
    'ql-image': 'Vložit obrázek',
    'ql-clean': 'Zrušit formátování',
    'ql-tabulka': 'Tabulka: vložit novou',
    'ql-radek': 'Přidat řádek tabulky',
    'ql-sloupec': 'Přidat sloupec tabulky',
    'ql-smazat-tabulku': 'Smazat tabulku',
    'ql-video-obce': 'Vložit video',
  };

  // dialog pro alternativní text (povinný)
  function zeptejSeNaPopis(navrh) {
    return new Promise(function (hotovo) {
      var d = document.createElement('dialog');
      d.className = 'alt-dialog';
      d.innerHTML =
        '<form method="dialog"><h2></h2><p class="napoveda"></p><label for="alt-vstup">Popis obrázku</label>' +
        '<input id="alt-vstup" required maxlength="300"><p class="alt-chyba" role="alert" hidden></p>' +
        '<div class="tlacitka-dole"><button class="tlacitko" value="ok"></button> <button class="tlacitko sekundarni" value="zrusit" formnovalidate></button></div></form>';
      d.querySelector('h2').textContent = T('nadpis', 'Popište obrázek');
      d.querySelector('.napoveda').textContent = T('napoveda', '');
      var vstup = d.querySelector('input');
      vstup.value = navrh || '';
      d.querySelector('button[value="ok"]').textContent = T('ok', 'Vložit');
      d.querySelector('button[value="zrusit"]').textContent = T('zrusit', 'Zrušit');
      d.querySelector('form').addEventListener('submit', function (e) {
        var ok = e.submitter && e.submitter.value === 'ok';
        if (ok && !vstup.value.trim()) {
          e.preventDefault();
          var ch = d.querySelector('.alt-chyba');
          ch.textContent = T('chyba', 'Popis je povinný.');
          ch.hidden = false;
          vstup.focus();
          return;
        }
        d.returnValue = ok ? 'ok' : 'zrusit';
      });
      d.addEventListener('close', function () {
        var v = d.returnValue === 'ok' ? vstup.value.trim() : null;
        d.remove();
        hotovo(v);
      });
      document.body.appendChild(d);
      d.showModal();
      vstup.focus();
      vstup.select();
    });
  }

  function nahrajObrazek(soubor) {
    var fd = new FormData();
    fd.append('obrazek', soubor, soubor.name);
    return fetch('/sprava/web/obrazek', {
      method: 'POST',
      body: fd,
      headers: { 'x-csrf-token': csrf },
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.chyba || 'Nahrání se nepovedlo.');
        return j;
      });
    });
  }

  function vlozObrazky(quill, soubory, index) {
    var stav = document.getElementById('autosave-stav');
    var postup = Promise.resolve();
    Array.prototype.forEach.call(soubory, function (soubor) {
      if (!/^image\//.test(soubor.type)) return;
      postup = postup.then(function () {
        if (stav) stav.textContent = T('nahravam', 'Nahrávám obrázek…');
        return nahrajObrazek(soubor)
          .then(function (j) {
            return zeptejSeNaPopis(j.navrhAlt).then(function (alt) {
              if (alt === null) return;
              var i =
                typeof index === 'number'
                  ? index
                  : (quill.getSelection(true) || { index: quill.getLength() }).index;
              quill.insertEmbed(i, 'image', j.url, 'user');
              var leaf = quill.getLeaf(i + 1)[0];
              if (leaf && leaf.domNode && leaf.domNode.tagName === 'IMG')
                leaf.domNode.setAttribute('alt', alt);
              quill.setSelection(i + 1, 0, 'user');
              index = i + 1;
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

  document.querySelectorAll('textarea[data-editor]').forEach(function (ta) {
    var plny = ta.getAttribute('data-editor') === 'plny';
    var obal = document.createElement('div');
    obal.className = 'editor-obal';
    var pole = document.createElement('div');
    obal.appendChild(pole);
    ta.parentNode.insertBefore(obal, ta);
    ta.hidden = true;
    var toolbar = [
      [{ header: [2, 3, false] }],
      ['bold', 'italic', 'link'],
      [{ list: 'ordered' }, { list: 'bullet' }, 'blockquote'],
      plny
        ? ['image', 'video-obce', 'tabulka', 'radek', 'sloupec', 'smazat-tabulku']
        : ['tabulka', 'radek', 'smazat-tabulku'],
      ['clean'],
    ];
    var quill = new Quill(pole, {
      theme: 'snow',
      formats: ['header', 'bold', 'italic', 'link', 'list', 'blockquote', 'image', 'table', 'videoObce'],
      modules: {
        table: true,
        toolbar: {
          container: toolbar,
          handlers: {
            image: function () {
              var v = document.createElement('input');
              v.type = 'file';
              v.accept = 'image/*';
              v.multiple = true;
              v.addEventListener('change', function () {
                vlozObrazky(quill, v.files);
              });
              v.click();
            },
            'video-obce': function () {
              var i = (quill.getSelection(true) || { index: quill.getLength() }).index;
              vyberVideo().then(function (v) {
                if (!v) return;
                quill.insertEmbed(i, 'videoObce', v, 'user');
                quill.setSelection(i + 1, 0, 'user');
              });
            },
            tabulka: function () {
              quill.getModule('table').insertTable(3, 3);
            },
            radek: function () {
              quill.getModule('table').insertRowBelow();
            },
            sloupec: function () {
              quill.getModule('table').insertColumnRight();
            },
            'smazat-tabulku': function () {
              quill.getModule('table').deleteTable();
            },
          },
        },
        uploader: {
          // přetažené/vložené obrázky jdou na server (žádné base64 v textu) a vyžadují popis
          handler: function (range, soubory) {
            vlozObrazky(quill, soubory, range.index);
          },
        },
      },
    });
    // <figure class="video" data-video> z uloženého textu → blok videa (ostatní figure beze změny)
    quill.clipboard.addMatcher('FIGURE', function (node, delta) {
      var id = node.getAttribute('data-video');
      if (!node.classList.contains('video') || !/^[0-9a-f-]{36}$/.test(id || '')) return delta;
      var a = node.querySelector('a');
      return new Delta().insert({
        videoObce: { id: id, odkaz: a ? a.getAttribute('href') : '', nazev: a ? a.textContent : '' },
      });
    });
    quill.clipboard.dangerouslyPasteHTML(ta.value || '');
    // popisky tlačítek pro čtečky a klávesnici
    obal.querySelectorAll('.ql-toolbar button, .ql-toolbar .ql-picker-label').forEach(function (b) {
      var c = Array.prototype.find.call(b.classList, function (x) {
        return POPISKY[x];
      });
      var text = c ? POPISKY[c] : b.classList.contains('ql-picker-label') ? 'Styl odstavce' : '';
      if (b.value === 'ordered') text = 'Číslovaný seznam';
      if (b.value === 'bullet') text = 'Odrážky';
      if (text) {
        b.setAttribute('aria-label', text);
        b.setAttribute('title', text);
      }
      if (c === 'ql-video-obce') b.textContent = '▶ Video';
      if (c && /tabulka|radek|sloupec/.test(c))
        b.textContent = {
          'ql-tabulka': '▦ Tabulka',
          'ql-radek': '+ řádek',
          'ql-sloupec': '+ sloupec',
          'ql-smazat-tabulku': '✕ tabulka',
        }[c];
    });
    var label = document.querySelector('label[for="' + ta.id + '"]');
    quill.root.setAttribute('role', 'textbox');
    quill.root.setAttribute('aria-multiline', 'true');
    if (label) quill.root.setAttribute('aria-label', label.textContent.trim());
    if (ta.getAttribute('aria-describedby'))
      quill.root.setAttribute('aria-describedby', ta.getAttribute('aria-describedby'));
    // klik na obrázek = upravit popis
    quill.root.addEventListener('dblclick', function (e) {
      if (e.target && e.target.tagName === 'IMG') {
        var img = e.target;
        zeptejSeNaPopis(img.getAttribute('alt') || '').then(function (alt) {
          if (alt !== null) {
            img.setAttribute('alt', alt);
            synchronizuj();
          }
        });
      }
    });
    function synchronizuj() {
      ta.value = quill.getLength() > 1 ? quill.getSemanticHTML().replace(/&nbsp;/g, ' ') : '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    quill.on('text-change', synchronizuj);
    synchronizuj();
    if (ta.form) ta.form.addEventListener('submit', synchronizuj, true);
  });

  // ---- automatické ukládání rozpracovaného obsahu ----
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
