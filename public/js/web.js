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
      var sekund = Number(pozadi.getAttribute('data-interval')) || 25;
      var casovac = setInterval(
        function () {
          if (!document.hidden) dalsi();
        },
        Math.max(5, sekund) * 1000,
      );
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

// Výška plovoucího hlavního menu → proměnná --vyska-menu na <html>: podmenu aplikací (.podmenu) se přilepí přesně
// pod ně i při jiném písmu, velikosti A+/A++ nebo zalomení do dvou řádků. Bez JS platí odhad z CSS.
(function () {
  'use strict';
  var pilulka = document.querySelector('.pilulka > ul');
  if (!pilulka) return;
  var zmer = function () {
    var v = pilulka.getBoundingClientRect().height;
    if (v > 0) document.documentElement.style.setProperty('--vyska-menu', Math.round(v) + 'px');
  };
  var cekani;
  window.addEventListener('resize', function () {
    clearTimeout(cekani);
    cekani = setTimeout(zmer, 100);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(zmer);
  zmer();
})();

// Prohlížeč fotek: galerie vložená do textu i stránka galerie ([data-prohlizec] s odkazy [data-foto] na velkou
// fotku). Šipky / přejetí prstem listují, Esc zavírá, fokus se vrátí na náhled. Bez JS odkaz otevře fotku.
(function () {
  'use strict';
  var skupiny = document.querySelectorAll('[data-prohlizec]');
  if (!skupiny.length || !window.HTMLDialogElement) return;
  var d = document.createElement('dialog');
  d.className = 'prohlizec';
  d.setAttribute('aria-label', 'Prohlížeč fotek');
  d.innerHTML =
    '<div class="prohlizec-plocha"><img alt=""><p></p></div><span class="pocitadlo" aria-live="polite"></span>' +
    '<button type="button" class="predchozi" aria-label="Předchozí fotka">‹</button>' +
    '<button type="button" class="dalsi" aria-label="Další fotka">›</button>' +
    '<button type="button" class="zavrit" aria-label="Zavřít">✕</button>';
  document.body.appendChild(d);
  var img = d.querySelector('img');
  var popis = d.querySelector('p');
  var pocitadlo = d.querySelector('.pocitadlo');
  var fotky = [];
  var i = 0;
  var zdroj = null;
  function ukaz(n) {
    i = (n + fotky.length) % fotky.length;
    var a = fotky[i];
    var nahled = a.querySelector('img');
    img.src = a.getAttribute('href');
    img.alt = nahled ? nahled.alt : '';
    popis.textContent = a.getAttribute('data-popisek') || (nahled ? nahled.alt : '');
    pocitadlo.textContent = i + 1 + ' / ' + fotky.length;
    // další fotku načíst dopředu
    var dalsi = fotky[(i + 1) % fotky.length];
    if (dalsi) new Image().src = dalsi.getAttribute('href');
  }
  d.querySelector('.predchozi').addEventListener('click', function () {
    ukaz(i - 1);
  });
  d.querySelector('.dalsi').addEventListener('click', function () {
    ukaz(i + 1);
  });
  d.querySelector('.zavrit').addEventListener('click', function () {
    d.close();
  });
  d.addEventListener('click', function (e) {
    if (e.target === d || e.target.classList.contains('prohlizec-plocha')) d.close();
  });
  d.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') ukaz(i - 1);
    else if (e.key === 'ArrowRight') ukaz(i + 1);
  });
  var x0 = null;
  d.addEventListener(
    'touchstart',
    function (e) {
      x0 = e.touches[0].clientX;
    },
    { passive: true },
  );
  d.addEventListener('touchend', function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) ukaz(dx > 0 ? i - 1 : i + 1);
    x0 = null;
  });
  d.addEventListener('close', function () {
    img.removeAttribute('src');
    if (zdroj) zdroj.focus();
  });
  skupiny.forEach(function (s) {
    var odkazy = Array.prototype.slice.call(s.querySelectorAll('a[data-foto]'));
    odkazy.forEach(function (a, n) {
      a.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        fotky = odkazy;
        zdroj = a;
        d.showModal();
        ukaz(n);
        d.querySelector('.zavrit').focus();
      });
    });
  });
})();
