// Formulář nového hlášení infokanálu: kopírování textu mezi kanály jedním tlačítkem (jako v původní aplikaci obce) —
// SMS → e-mail, předmět e-mailu → nadpis článku, e-mail (s formátováním) → článek, SMS → článek.
// Tlačítka jsou bez JavaScriptu skrytá (formulář funguje i bez nich). Editory vytváří klient/editor.js
// a rozhraní nechává v textarea.editorApi (text, html, nastavHtml, nastavText).
(function () {
  'use strict';
  var tlacitka = document.querySelectorAll('[data-kopirovat]');
  if (!tlacitka.length) return;
  var stav = document.getElementById('kopirovani-stav');
  document.querySelectorAll('.kopirovani').forEach(function (el) {
    el.hidden = false;
  });

  function pole(id) {
    return document.getElementById(id === 'sms' ? 'sms_text' : id);
  }
  function escapuj(t) {
    return t.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function textNaHtml(t) {
    return t
      .split(/\n{2,}/)
      .map(function (o) {
        return o.trim();
      })
      .filter(Boolean)
      .map(function (o) {
        return '<p>' + escapuj(o).replace(/\n/g, '<br>') + '</p>';
      })
      .join('');
  }
  function text(el) {
    if (el.editorApi) return el.editorApi.text().trim();
    return el.value.trim();
  }
  function html(el) {
    if (el.editorApi) return el.editorApi.html();
    return el.getAttribute('data-editor') ? el.value : textNaHtml(el.value);
  }
  function oznam(klic) {
    if (!stav) return;
    stav.textContent = '';
    // krátká prodleva, aby čtečka obrazovky ohlásila i opakovanou stejnou hlášku
    setTimeout(function () {
      stav.textContent = stav.getAttribute('data-' + klic) || '';
    }, 50);
  }

  tlacitka.forEach(function (b) {
    b.addEventListener('click', function () {
      var zdroj = pole(b.getAttribute('data-kopirovat'));
      var cil = pole(b.getAttribute('data-do'));
      if (!zdroj || !cil) return;
      if (!text(zdroj)) return oznam('prazdne');
      var formatovany = !!zdroj.editorApi || !!zdroj.getAttribute('data-editor');
      if (cil.tagName === 'INPUT') cil.value = text(zdroj);
      else if (cil.editorApi) {
        if (formatovany) cil.editorApi.nastavHtml(html(zdroj));
        else cil.editorApi.nastavText(text(zdroj));
      } else cil.value = formatovany ? html(zdroj) : text(zdroj);
      cil.dispatchEvent(new Event('input', { bubbles: true }));
      oznam('ok');
    });
  });
})();
