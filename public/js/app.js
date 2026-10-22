// Moje obec 2.0 — drobná vylepšení stránek. Vše funguje i bez JavaScriptu; tady jen pohodlí navíc.
// Žádná uživatelská data se nevkládají do inline JS: potvrzení čte text z atributu data-confirm.
(function () {
  'use strict';
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    var otazka = f.getAttribute('data-confirm');
    if (otazka && !window.confirm(otazka)) e.preventDefault();
  });
  document.addEventListener('click', function (e) {
    var a = e.target instanceof Element ? e.target.closest('a[data-confirm], button[data-confirm]') : null;
    if (a && !window.confirm(a.getAttribute('data-confirm'))) e.preventDefault();
  });
})();

// Rozbalovací položky podmenu aplikací (.ma-rozbal > button[aria-expanded] + ul) i kdekoli jinde na webu:
// klik přepíná, Esc zavře a vrátí fokus na tlačítko, klik mimo zavře. Bez JS zůstává seznam skrytý — aplikace proto
// dávají do rozbalení jen zkratky, které jsou dostupné i jinde (kalendář, rozcestník).
(function () {
  'use strict';
  var otevrene = function () {
    return document.querySelectorAll('.ma-rozbal > button[aria-expanded="true"]');
  };
  var zavri = function (krome) {
    otevrene().forEach(function (b) {
      if (b !== krome) b.setAttribute('aria-expanded', 'false');
    });
  };
  document.addEventListener('click', function (e) {
    var cil = e.target instanceof Element ? e.target : null;
    var tlacitko = cil ? cil.closest('.ma-rozbal > button[aria-expanded]') : null;
    if (tlacitko) {
      var otevrit = tlacitko.getAttribute('aria-expanded') !== 'true';
      zavri(tlacitko);
      tlacitko.setAttribute('aria-expanded', otevrit ? 'true' : 'false');
      return;
    }
    if (!cil || !cil.closest('.ma-rozbal')) zavri(null);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    var cil = e.target instanceof Element ? e.target.closest('.ma-rozbal') : null;
    var byloOtevrene = otevrene().length > 0;
    zavri(null);
    if (cil && byloOtevrene) {
      var b = cil.querySelector('button[aria-expanded]');
      if (b) b.focus();
    }
  });
  // fokus odešel z rozbalené položky (Tab dál) → zavřít
  document.addEventListener('focusin', function (e) {
    var cil = e.target instanceof Element ? e.target.closest('.ma-rozbal') : null;
    otevrene().forEach(function (b) {
      if (!cil || b.parentNode !== cil) b.setAttribute('aria-expanded', 'false');
    });
  });
})();
