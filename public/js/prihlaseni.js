// Přihlašovací dialog: tlačítka jsou aktivní, jen když dává smysl je stisknout (pokyn 2026-10-30).
//   Telefonem: Poslat kód až s platným číslem (9 číslic, nebo +420/+421 a 9 číslic; mezery se ignorují).
//   E-mailem: bez platné adresy nic; s adresou „Neznám heslo“; s adresou i heslem také Přihlásit.
// Bez JavaScriptu zůstávají tlačítka aktivní a vše ověří server.
(function () {
  'use strict';
  function cislo(v) {
    var s = String(v || '').replace(/[\s\-().]/g, '');
    return /^(\+?42[01]|00042[01])?\d{9}$/.test(s);
  }
  function email(v) {
    var s = String(v || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }
  function hlidej(vstupy, tlacitka, podminka) {
    function srovnej() {
      var ok = podminka();
      for (var i = 0; i < tlacitka.length; i++) {
        var t = tlacitka[i].tlacitko;
        var aktivni = ok && (!tlacitka[i].navic || tlacitka[i].navic());
        t.disabled = !aktivni;
        t.setAttribute('aria-disabled', aktivni ? 'false' : 'true');
      }
    }
    for (var j = 0; j < vstupy.length; j++) {
      vstupy[j].addEventListener('input', srovnej);
      vstupy[j].addEventListener('change', srovnej);
    }
    srovnej();
  }
  var tel = document.getElementById('telefon');
  var telForm = tel && tel.form;
  if (telForm) {
    var poslat = telForm.querySelector('button[type=submit]');
    if (poslat)
      hlidej([tel], [{ tlacitko: poslat }], function () {
        return cislo(tel.value);
      });
  }
  var em = document.getElementById('email');
  var heslo = document.getElementById('heslo');
  var emForm = em && em.form;
  if (emForm && heslo) {
    var kod = emForm.querySelector('button[formaction]');
    var prihlasit = null;
    var vsechna = emForm.querySelectorAll('button[type=submit]');
    for (var k = 0; k < vsechna.length; k++)
      if (!vsechna[k].hasAttribute('formaction')) prihlasit = vsechna[k];
    var tlacitka = [];
    if (kod) tlacitka.push({ tlacitko: kod });
    if (prihlasit)
      tlacitka.push({
        tlacitko: prihlasit,
        navic: function () {
          return heslo.value.length > 0;
        },
      });
    hlidej([em, heslo], tlacitka, function () {
      return email(em.value);
    });
  }
})();
