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
