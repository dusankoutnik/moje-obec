// Kvíz — jen pohodlí navíc, bez JavaScriptu funguje vše stejně (formuláře).
// Otázka: klávesy A–D odešlou odpověď, fokus na text otázky (čtečka ji přečte).
// Výsledek: fokus na „Správně / Špatně“, Enter (mimo odkazy a tlačítka) = další otázka.
(function () {
  'use strict';
  var otazka = document.getElementById('kviz-otazka');
  var dalsi = document.getElementById('kviz-dalsi');
  var odeslano = false;
  var mimoPole = function (e) {
    var el = e.target;
    return !(el instanceof Element && el.matches('input, textarea, select'));
  };
  if (otazka) {
    var text = document.getElementById('kviz-text');
    if (text && !document.querySelector('.flash')) text.focus({ preventScroll: true });
    document.addEventListener('keydown', function (e) {
      if (odeslano || e.altKey || e.ctrlKey || e.metaKey || !mimoPole(e)) return;
      var tlacitko = otazka.querySelector('button[data-klavesa="' + String(e.key).toLowerCase() + '"]');
      if (!tlacitko) return;
      e.preventDefault();
      tlacitko.classList.add('je-zvolena');
      if (otazka.requestSubmit) otazka.requestSubmit(tlacitko);
      else tlacitko.click();
    });
    // dvojklik nepošle dvě odpovědi
    otazka.addEventListener('submit', function (e) {
      if (odeslano) e.preventDefault();
      odeslano = true;
    });
  }
  if (dalsi) {
    var nadpis = document.getElementById('kviz-vysledek-h');
    if (nadpis) nadpis.focus({ preventScroll: true });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || odeslano || !mimoPole(e)) return;
      var el = document.activeElement;
      if (el && el !== document.body && el !== nadpis && (el.tagName === 'A' || el.tagName === 'BUTTON'))
        return;
      e.preventDefault();
      odeslano = true;
      dalsi.submit();
    });
  }
})();
