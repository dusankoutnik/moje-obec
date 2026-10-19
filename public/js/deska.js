// Formulář úřední desky: po změně kategorie dopočítá datum sejmutí a ukáže pole pro rozpočet. Bez JS vše funguje
// (prázdné datum sejmutí doplní server podle kategorie).
(function () {
  'use strict';
  var f = document.getElementById('deska-formular');
  if (!f) return;
  var kat = f.querySelector('#kategorie_id');
  var od = f.querySelector('#od');
  var doPole = f.querySelector('#do');
  var odvolani = f.querySelector('input[name="do_odvolani"]');
  var rozpocet = document.getElementById('rozpocet-pole');
  var rucne = !!doPole.value;
  doPole.addEventListener('input', function () {
    rucne = true;
  });
  function pridej(datum, dni) {
    var d = new Date(datum + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + dni);
    return d.toISOString().slice(0, 10);
  }
  function prepocti(zmenaKategorie) {
    var o = kat.options[kat.selectedIndex];
    var vychozi = Number(o.getAttribute('data-vychozi'));
    var jeRozpocet = o.getAttribute('data-rozpocet') === '1';
    rozpocet.hidden = !jeRozpocet;
    if (zmenaKategorie) {
      odvolani.checked = vychozi === 0;
      rucne = false;
    }
    if (!rucne && od.value) doPole.value = vychozi > 0 ? pridej(od.value, vychozi) : '';
    doPole.disabled = odvolani.checked;
  }
  kat.addEventListener('change', function () {
    prepocti(true);
  });
  od.addEventListener('change', function () {
    prepocti(false);
  });
  odvolani.addEventListener('change', function () {
    prepocti(false);
  });
  prepocti(false);
})();
