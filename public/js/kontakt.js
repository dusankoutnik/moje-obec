// Kontaktní formulář: opíše podepsaný token ze `data-overeni` do skrytého pole „overeni“ (ochrana před roboty,
// kteří JavaScript nespouštějí). Bez JavaScriptu zpráva projde, jen může být označená jako možný spam.
(function () {
  'use strict';
  var f = document.querySelector('form[action="/kontakt/zprava"]');
  if (!f) return;
  var pole = f.querySelector('input[name="overeni"]');
  if (pole) pole.value = f.getAttribute('data-overeni') || '';
})();
