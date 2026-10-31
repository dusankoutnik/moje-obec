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

// Prohlížeč fotek. Skupina = všechny obrázky jednoho příspěvku (.obsah-html — fotky v textu i fotky galerií,
// v pořadí dokumentu), jinde každá galerie [data-prohlizec] zvlášť (stránka galerie). Klik na fotku otevře celou
// obrazovku s pásem náhledů dole, šipkami a zoomem (tlačítka, dvojklik, kolečko, dva prsty; zvětšená fotka se
// posouvá tažením). Esc zavírá, fokus se vrátí na náhled. Bez JS odkaz otevře fotku, prostá fotka nic nedělá.
(function () {
  'use strict';
  if (!window.HTMLDialogElement) return;

  function jeObrazek(url) {
    return /^\/soubory\/|\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(url || '');
  }
  function nahledUrl(url) {
    return /^\/soubory\/[^?]+$/.test(url) ? url + '?v=nahled' : url;
  }
  function velkaUrl(url) {
    return url.replace(/\?v=nahled$/, '');
  }
  function popisekK(el, vychozi) {
    var fig = el.closest('figure');
    var cap = fig && fig.querySelector('figcaption');
    return (cap && cap.textContent.trim()) || el.getAttribute('data-popisek') || vychozi || '';
  }
  // položka: { velka, nahled, alt, popisek, prvek (kam vrátit fokus) }
  function zOdkazu(a) {
    var img = a.querySelector('img');
    var alt = img ? img.alt : '';
    return {
      velka: a.getAttribute('href'),
      nahled: nahledUrl(a.getAttribute('href')),
      alt: alt,
      popisek: popisekK(a, alt),
      prvek: a,
    };
  }
  function zObrazku(img) {
    var src = velkaUrl(img.getAttribute('src') || img.currentSrc || '');
    return { velka: src, nahled: nahledUrl(src), alt: img.alt, popisek: popisekK(img, img.alt), prvek: img };
  }

  var skupiny = []; // [{ polozky: [...], spoustece: [{ prvek, index }] }]
  function pridej(skupina, polozka, spoustec) {
    skupina.polozky.push(polozka);
    skupina.spoustece.push({ prvek: spoustec, index: skupina.polozky.length - 1 });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.obsah-html'), function (root) {
    var sk = { polozky: [], spoustece: [] };
    Array.prototype.forEach.call(root.querySelectorAll('a[data-foto], img'), function (el) {
      if (el.tagName === 'A') return pridej(sk, zOdkazu(el), el);
      if (el.closest('a[data-foto], .video-ram, .video-v-obsahu, .galerie-v-textu')) return;
      if (el.width && el.width < 64) return; // ikonka
      var a = el.closest('a');
      if (a) {
        if (!jeObrazek(a.getAttribute('href'))) return; // odkaz jinam — necháme být
        var pol = zOdkazu(a);
        pol.alt = el.alt;
        pol.popisek = popisekK(el, el.alt);
        return pridej(sk, pol, a);
      }
      el.classList.add('zvetsitelny');
      if (el.alt) {
        // prostý <img> není ovládací prvek — pro klávesnici z něj uděláme tlačítko (jen má-li jméno)
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'Zvětšit obrázek: ' + el.alt);
      }
      pridej(sk, zObrazku(el), el);
    });
    if (sk.polozky.length) skupiny.push(sk);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-prohlizec]'), function (g) {
    if (g.closest('.obsah-html')) return;
    var sk = { polozky: [], spoustece: [] };
    Array.prototype.forEach.call(g.querySelectorAll('a[data-foto]'), function (a) {
      pridej(sk, zOdkazu(a), a);
    });
    if (sk.polozky.length) skupiny.push(sk);
  });
  if (!skupiny.length) return;

  var d = document.createElement('dialog');
  d.className = 'prohlizec';
  d.setAttribute('aria-label', 'Prohlížeč fotek');
  d.innerHTML =
    '<div class="prohlizec-plocha"><div class="prohlizec-ram"><img alt="" draggable="false"></div><p></p></div>' +
    '<ul class="prohlizec-pas" aria-label="Všechny obrázky"></ul>' +
    '<span class="pocitadlo" aria-live="polite"></span>' +
    '<div class="prohlizec-zoom"><button type="button" class="oddalit" aria-label="Oddálit">−</button>' +
    '<button type="button" class="priblizit" aria-label="Přiblížit">+</button></div>' +
    '<button type="button" class="predchozi" aria-label="Předchozí fotka">‹</button>' +
    '<button type="button" class="dalsi" aria-label="Další fotka">›</button>' +
    '<button type="button" class="zavrit" aria-label="Zavřít">✕</button>';
  document.body.appendChild(d);
  var ram = d.querySelector('.prohlizec-ram');
  var img = d.querySelector('img');
  var popis = d.querySelector('p');
  var pas = d.querySelector('.prohlizec-pas');
  var pocitadlo = d.querySelector('.pocitadlo');
  var fotky = [];
  var i = 0;
  var zdroj = null;

  // --- zoom: 1 = fotka se vejde; víc = šířka fitW × z, rám se posouvá (scroll) ---
  var z = 1;
  var fitW = 0;
  var MAX_Z = 5;
  function nastavZoom(noveZ, ohniskoX, ohniskoY) {
    noveZ = Math.min(MAX_Z, Math.max(1, noveZ));
    if (!fitW) fitW = img.clientWidth;
    if (!fitW) return;
    var r = ram.getBoundingClientRect();
    var fx = ohniskoX == null ? r.width / 2 : ohniskoX - r.left;
    var fy = ohniskoY == null ? r.height / 2 : ohniskoY - r.top;
    // bod fotky pod ohniskem zůstane na místě
    var px = (ram.scrollLeft + fx) / z;
    var py = (ram.scrollTop + fy) / z;
    z = noveZ;
    if (z === 1) {
      ram.classList.remove('zoom');
      img.style.width = '';
    } else {
      ram.classList.add('zoom');
      img.style.width = Math.round(fitW * z) + 'px';
      ram.scrollLeft = px * z - fx;
      ram.scrollTop = py * z - fy;
    }
    d.querySelector('.oddalit').disabled = z === 1;
    d.querySelector('.priblizit').disabled = z >= MAX_Z;
  }

  function ukaz(n) {
    i = (n + fotky.length) % fotky.length;
    var f = fotky[i];
    z = 1;
    fitW = 0;
    ram.classList.remove('zoom');
    img.style.width = '';
    img.src = f.velka;
    img.alt = f.alt;
    popis.textContent = f.popisek;
    pocitadlo.textContent = i + 1 + ' / ' + fotky.length;
    d.querySelector('.oddalit').disabled = true;
    d.querySelector('.priblizit').disabled = false;
    Array.prototype.forEach.call(pas.children, function (li, k) {
      var b = li.firstChild;
      if (k === i) {
        b.setAttribute('aria-current', 'true');
        if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest', inline: 'center' });
      } else b.removeAttribute('aria-current');
    });
    var dalsi = fotky[(i + 1) % fotky.length];
    if (dalsi) new Image().src = dalsi.velka;
  }
  function postavPas() {
    pas.innerHTML = '';
    d.classList.toggle('prohlizec-sam', fotky.length < 2);
    if (fotky.length < 2) return;
    fotky.forEach(function (f, k) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Obrázek ' + (k + 1) + ' z ' + fotky.length + (f.alt ? ': ' + f.alt : ''));
      var m = document.createElement('img');
      m.alt = '';
      m.loading = 'lazy';
      m.src = f.nahled;
      b.appendChild(m);
      b.addEventListener('click', function () {
        ukaz(k);
      });
      li.appendChild(b);
      pas.appendChild(li);
    });
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
  d.querySelector('.priblizit').addEventListener('click', function () {
    nastavZoom(z * 1.5);
  });
  d.querySelector('.oddalit').addEventListener('click', function () {
    nastavZoom(z / 1.5);
  });
  d.addEventListener('click', function (e) {
    if (e.target === d || e.target.classList.contains('prohlizec-plocha') || e.target === ram) d.close();
  });
  img.addEventListener('dblclick', function (e) {
    nastavZoom(z > 1 ? 1 : 2.5, e.clientX, e.clientY);
  });
  ram.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      nastavZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
    },
    { passive: false },
  );
  d.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' && z === 1) ukaz(i - 1);
    else if (e.key === 'ArrowRight' && z === 1) ukaz(i + 1);
    else if (e.key === '+' || e.key === '=') nastavZoom(z * 1.5);
    else if (e.key === '-') nastavZoom(z / 1.5);
    else if (e.key === '0') nastavZoom(1);
    else return;
    if (e.key.length === 1) e.preventDefault();
  });

  // tažení myší posouvá zvětšenou fotku
  var tah = null;
  img.addEventListener('pointerdown', function (e) {
    if (z === 1 || e.pointerType === 'touch') return;
    tah = { x: e.clientX, y: e.clientY, sl: ram.scrollLeft, st: ram.scrollTop };
    img.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  img.addEventListener('pointermove', function (e) {
    if (!tah) return;
    ram.scrollLeft = tah.sl - (e.clientX - tah.x);
    ram.scrollTop = tah.st - (e.clientY - tah.y);
  });
  function konecTahu() {
    tah = null;
  }
  img.addEventListener('pointerup', konecTahu);
  img.addEventListener('pointercancel', konecTahu);

  // dotyk: přejetí jedním prstem listuje (jen nezvětšená), dva prsty = zoom
  var x0 = null;
  var spetka = null;
  function vzdalenost(t) {
    var dx = t[0].clientX - t[1].clientX;
    var dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  d.addEventListener(
    'touchstart',
    function (e) {
      if (e.touches.length === 2) {
        spetka = { d: vzdalenost(e.touches), z: z };
        x0 = null;
      } else if (e.touches.length === 1) x0 = e.touches[0].clientX;
    },
    { passive: true },
  );
  ram.addEventListener(
    'touchmove',
    function (e) {
      if (!spetka || e.touches.length !== 2) return;
      e.preventDefault();
      var sx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var sy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      nastavZoom((spetka.z * vzdalenost(e.touches)) / spetka.d, sx, sy);
    },
    { passive: false },
  );
  d.addEventListener('touchend', function (e) {
    if (e.touches.length < 2) spetka = null;
    if (x0 === null || z > 1 || e.changedTouches.length !== 1) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50 && !e.target.closest('.prohlizec-pas')) ukaz(dx > 0 ? i - 1 : i + 1);
    x0 = null;
  });

  d.addEventListener('close', function () {
    img.removeAttribute('src');
    img.style.width = '';
    ram.classList.remove('zoom');
    z = 1;
    if (zdroj) zdroj.focus();
  });

  function otevri(sk, index, prvek) {
    fotky = sk.polozky;
    zdroj = prvek;
    postavPas();
    d.showModal();
    ukaz(index);
    d.querySelector('.zavrit').focus();
  }
  skupiny.forEach(function (sk) {
    sk.spoustece.forEach(function (s) {
      s.prvek.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        otevri(sk, s.index, s.prvek);
      });
      if (s.prvek.tagName === 'IMG' && s.prvek.getAttribute('role') === 'button') {
        s.prvek.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            otevri(sk, s.index, s.prvek);
          }
        });
      }
    });
  });
})();
