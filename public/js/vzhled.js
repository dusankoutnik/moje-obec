// Správa vzhledu: živá ukázka vlastní kombinace písem a zápisu názvu obce (bez JS se ukáže po uložení / v náhledu).
(function () {
  var form = document.querySelector('.vzhled-formular');
  if (!form) return;
  var vlastni = form.querySelector('input[name="pismo"][value="vlastni"]');
  function ukazka(cast) {
    return form.querySelector('[data-ukazka="' + cast + '"]');
  }
  form.querySelectorAll('select[data-cast]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var o = sel.options[sel.selectedIndex];
      var cil = ukazka(sel.getAttribute('data-cast'));
      if (cil) {
        cil.style.fontFamily = o.getAttribute('data-rodina');
        if (sel.getAttribute('data-cast') === 'titulek') {
          cil.style.fontWeight = o.getAttribute('data-vaha');
          form.querySelectorAll('.nazev-ukazka').forEach(function (n) {
            n.style.fontFamily = o.getAttribute('data-rodina');
          });
        }
      }
      if (vlastni) vlastni.checked = true;
    });
  });
  var nazev = form.querySelector('#nazev');
  if (nazev)
    nazev.addEventListener('input', function () {
      var t = nazev.value.trim() || nazev.defaultValue;
      form.querySelectorAll('.nazev-ukazka, [data-ukazka="titulek"]').forEach(function (n) {
        n.textContent = t;
      });
    });
})();
