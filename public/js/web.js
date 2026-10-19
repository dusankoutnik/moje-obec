// Moje obec 2.0 — živé detaily veřejného webu (jen vylepšení; bez JS je vše vidět a funkční):
//  - pozadí: plynulé prolínání fotek obce (režim „střídání“), další fotka se načte dopředu
//  - statistiky v úvodu: čísla se při prvním zobrazení napočítají nahoru
// Obojí se vypne při prefers-reduced-motion.
(function () {
  'use strict';
  var klid = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- pozadí ---
  var pozadi = document.querySelector('.pozadi[data-fotky]');
  if (pozadi && !klid) {
    var fotky = [];
    try {
      fotky = JSON.parse(pozadi.getAttribute('data-fotky')) || [];
    } catch {
      fotky = [];
    }
    var vrstvy = pozadi.querySelectorAll('.pozadi-vrstva');
    var aktualni = vrstvy[0].style.backgroundImage || '';
    var index = Math.max(
      0,
      fotky.findIndex(function (f) {
        return aktualni.indexOf(f) >= 0;
      }),
    );
    var vidim = 0;
    var dalsi = function () {
      index = (index + 1) % fotky.length;
      var url = fotky[index];
      var img = new Image();
      img.onload = function () {
        var skryta = vrstvy[1 - vidim];
        skryta.style.backgroundImage = "url('" + url + "')";
        skryta.classList.add('viditelna');
        vrstvy[vidim].classList.remove('viditelna');
        vidim = 1 - vidim;
      };
      img.src = url;
    };
    if (fotky.length > 1 && vrstvy.length === 2) {
      // nestřídat, když je stránka na pozadí (šetří data i baterii)
      var casovac = setInterval(function () {
        if (!document.hidden) dalsi();
      }, 25000);
      window.addEventListener('pagehide', function () {
        clearInterval(casovac);
      });
    }
  }

  // --- počítadla ---
  var cisla = document.querySelectorAll('[data-cislo]');
  if (!cisla.length || klid || !('IntersectionObserver' in window)) return;
  var napocitej = function (el) {
    var cil = Number(el.getAttribute('data-cislo'));
    if (!isFinite(cil) || cil <= 0) return;
    var start = null;
    var krok = function (t) {
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / 1200);
      el.textContent = String(Math.round(cil * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(krok);
    };
    el.textContent = '0';
    requestAnimationFrame(krok);
  };
  var pozorovatel = new IntersectionObserver(function (zaznamy) {
    zaznamy.forEach(function (z) {
      if (z.isIntersecting) {
        pozorovatel.unobserve(z.target);
        napocitej(z.target);
      }
    });
  });
  cisla.forEach(function (el) {
    pozorovatel.observe(el);
  });
})();

// Velký název obce v úvodu: slovo se nikdy neláme uvnitř — když se nevejde, písmo se zmenší (CSS dává odhad,
// tady se doladí podle skutečné šířky po načtení písma a při změně velikosti okna).
(function () {
  var nazvy = document.querySelectorAll('.hero-nazev');
  if (!nazvy.length) return;
  function prizpusob() {
    nazvy.forEach(function (el) {
      el.style.fontSize = '';
      for (var i = 0; i < 4 && el.scrollWidth > el.clientWidth + 1; i++) {
        var px = parseFloat(window.getComputedStyle(el).fontSize);
        el.style.fontSize = Math.max(18, Math.floor((px * el.clientWidth) / el.scrollWidth) - 1) + 'px';
      }
    });
  }
  var cekani;
  window.addEventListener('resize', function () {
    clearTimeout(cekani);
    cekani = setTimeout(prizpusob, 150);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(prizpusob);
  prizpusob();
})();

// Videa z YouTube/Vimea „na dva kliky“: dokud návštěvník nestiskne Přehrát, web z cizí služby nic nenačítá
// (náhled je uložený u nás). Po kliknutí se místo náhledu vloží přehrávač (youtube-nocookie.com / Vimeo s dnt=1)
// a spustí se. Bez JS je náhled obyčejným odkazem na video u služby.
(function () {
  'use strict';
  document.querySelectorAll('.video-externi[data-prehravac]').forEach(function (ram) {
    var odkaz = ram.querySelector('.video-spust');
    if (!odkaz) return;
    odkaz.setAttribute('role', 'button');
    function spust(e) {
      e.preventDefault();
      var iframe = document.createElement('iframe');
      iframe.src = ram.getAttribute('data-prehravac');
      iframe.title = ram.getAttribute('data-ramec-titulek') || '';
      iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      ram.replaceChild(iframe, odkaz);
      ram.classList.add('prehrava');
      iframe.focus();
    }
    odkaz.addEventListener('click', spust);
    // role=button: mezerník spouští jako u tlačítka (Enter u odkazu funguje sám)
    odkaz.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Spacebar') spust(e);
    });
  });
})();
