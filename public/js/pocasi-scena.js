// Počasí: jemná animace za textem dlaždice podle počasí teď a ročního období. Počasí: plující mraky, déšť, sníh,
// blesky, mlha, za jasného dne pomalu kroužící sluneční paprsky, v noci hvězdy. Období (jen když neprší ani
// nesněží): jaro = okvětní lístky, léto = chmýří pampelišek (den) a světlušky (noc), podzim = listí,
// zima = třpyt jinovatky za jasna. Jen dekorace (aria-hidden), žádná knihovna. Barvy jsou ve skle ztlumené
// na jas ≤ #6a6a6a (tmavší než nejsvětlejší sklo, které ještě splňuje kontrast 4,5 : 1), takže bílý text
// nezhorší; výjimkou jsou jen drobné tečky (vločky, třpyt, světlušky) a okamžik blesku. V bílé kartě jsou
// efekty tmavé a slabé. Bez pohybu (prefers-reduced-motion) se nakreslí jen jeden klidný snímek; animace stojí,
// když dlaždice není vidět nebo je karta prohlížeče na pozadí. Obloha podle skutečného času: Slunce a Měsíc
// (v aktuální fázi) putují po oblouku od východu k západu (časy počítá server, data-slunce / data-mesic),
// v noci se dlaždice ztmaví (kontrast se tím jen zlepší), za soumraku a svítání je u obzoru teplá záře.
// Náhled: ?obdobi=jaro|leto|podzim|zima, ?cas=HH:MM (jiná denní doba).
(function () {
  'use strict';
  if (window.__pocasiScena) return;
  window.__pocasiScena = true;

  var KLID = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rnd = function (a, b) {
    return a + Math.random() * (b - a);
  };

  function scena(sekce) {
    var vrstva = sekce.querySelector('.poc-nebe-vrstva');
    if (!vrstva) return;
    var druh = sekce.getAttribute('data-scena') || '';
    var sklo = sekce.classList.contains('pocasi-sklo');
    var mesic = new Date().getMonth(); // 0 = leden
    var obdobi =
      mesic >= 2 && mesic <= 4
        ? 'jaro'
        : mesic >= 5 && mesic <= 7
          ? 'leto'
          : mesic >= 8 && mesic <= 10
            ? 'podzim'
            : 'zima';
    var vynuceno = new URLSearchParams(location.search).get('obdobi');
    if (vynuceno && /^(jaro|leto|podzim|zima)$/.test(vynuceno)) obdobi = vynuceno;
    var mokro = /dest|snih|bourka/.test(druh);
    var noc = /noc/.test(druh);
    var jasno = /jasno/.test(druh);
    var podzim = obdobi === 'podzim' && !mokro;
    // základní barva efektů: sklo = tlumená šedá, karta = tmavomodrošedá
    var B = sklo ? '106,106,106' : '40,60,90';
    var MRAK = sklo ? B : '150,165,185'; // v bílé kartě světlé mraky, ať nepřekryjí tmavý text
    var MRAK_A = sklo ? 1 : 0.45;
    var cas = function (s) {
      var d = s ? new Date(s) : null;
      return d && isFinite(d.getTime()) ? d.getTime() : null;
    };
    var sl = (sekce.getAttribute('data-slunce') || '').split(' ');
    var me = (sekce.getAttribute('data-mesic') || '').split(' ');
    var SV = cas(sl[0]),
      SZ = cas(sl[1]),
      MV = cas(me[0]),
      MZ = cas(me[1]);
    var FAZE = parseFloat(sekce.getAttribute('data-faze') || '0.5') || 0;
    var posunCasu = 0;
    var chciCas = new URLSearchParams(location.search).get('cas');
    if (chciCas && /^\d{1,2}:\d{2}$/.test(chciCas)) {
      var nyni = new Date(),
        cil = new Date(nyni);
      cil.setHours(+chciCas.split(':')[0], +chciCas.split(':')[1], 0, 0);
      posunCasu = cil.getTime() - nyni.getTime();
    }
    var MESIC_DRAHA = 12.4 * 3600e3; // přibližná doba Měsíce nad obzorem, když druhý čas padne na jiný den
    var LISTI = sklo
      ? ['138,75,20', '122,90,18', '110,47,18', '96,70,30']
      : ['196,106,31', '178,120,30', '170,70,30', '140,100,40'];

    var cv = document.createElement('canvas');
    cv.className = 'poc-scena';
    vrstva.appendChild(cv);
    var g = cv.getContext('2d');
    if (!g) return;
    var W = 0,
      H = 0,
      dpr = Math.min(window.devicePixelRatio || 1, 2);

    var mraky = [],
      kapky = [],
      vlocky = [],
      hvezdy = [],
      listy = [],
      sezona = [],
      paprsky = /jasno-den|polojasno-den/.test(druh),
      blesk = { dalsi: rnd(3, 7), trva: 0, cesta: null };

    var maMraky = /zatazeno|polojasno|dest|snih|bourka|mlha/.test(druh);
    var maDest = druh === 'dest' || druh === 'bourka';
    var maSnih = druh === 'snih';
    var maHvezdy = sklo && /noc/.test(druh);

    function rozmer() {
      var r = sekce.getBoundingClientRect();
      W = Math.max(1, r.width);
      H = Math.max(1, r.height);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function naplnit() {
      var plocha = (W * H) / 100000; // počet částic podle velikosti dlaždice
      mraky = [];
      var nM = druh === 'mlha' ? 6 : druh === 'polojasno-den' || druh === 'polojasno-noc' ? 3 : 5;
      for (var i = 0; i < (maMraky ? nM : 0); i++)
        mraky.push({
          x: rnd(-0.2, 1.1) * W,
          y: druh === 'mlha' ? rnd(0.1, 0.95) * H : rnd(0.05, 0.75) * H,
          s: druh === 'mlha' ? rnd(1.6, 2.6) : rnd(0.7, 1.3),
          v: rnd(5, 12) * (Math.random() < 0.5 ? 1 : 0.8),
          a: druh === 'mlha' ? rnd(0.25, 0.4) : rnd(0.35, 0.55),
        });
      kapky = [];
      for (i = 0; i < (maDest ? Math.round(55 * plocha) + 20 : 0); i++)
        kapky.push({ x: rnd(0, W), y: rnd(-H, H), d: rnd(9, 16), v: rnd(380, 520), a: rnd(0.4, 0.7) });
      vlocky = [];
      for (i = 0; i < (maSnih ? Math.round(45 * plocha) + 20 : 0); i++)
        vlocky.push({
          x: rnd(0, W),
          y: rnd(-H, H),
          r: rnd(1, 2.6),
          v: rnd(18, 45),
          f: rnd(0, 6.3),
          k: rnd(0.6, 1.4),
        });
      hvezdy = [];
      for (i = 0; i < (maHvezdy ? Math.round(30 * plocha) + 12 : 0); i++)
        hvezdy.push({ x: rnd(0, W), y: rnd(0, H * 0.8), r: rnd(0.5, 1.2), f: rnd(0, 6.3), k: rnd(0.6, 1.8) });
      listy = [];
      for (i = 0; i < (podzim ? Math.round(5 * plocha) + 5 : 0); i++) listy.push(novyList(true));
      sezona = [];
      if (!mokro) {
        var typ =
          obdobi === 'jaro'
            ? 'lupen'
            : obdobi === 'leto'
              ? noc
                ? 'svetluska'
                : 'chmyri'
              : obdobi === 'zima' && jasno
                ? 'trpyt'
                : null;
        var n = typ === 'trpyt' ? 14 : typ === 'svetluska' ? 10 : 9;
        for (i = 0; typ && i < Math.round(n * plocha) + 4; i++) sezona.push(novaCastice(typ, true));
      }
    }

    function novyList(kdekoli) {
      return {
        x: rnd(0, W),
        y: kdekoli ? rnd(-H, H) : rnd(-60, -15),
        s: rnd(7, 12),
        v: rnd(22, 42),
        f: rnd(0, 6.3),
        k: rnd(0.5, 1.2),
        rot: rnd(0, 6.3),
        vr: rnd(-1.6, 1.6),
        c: LISTI[Math.floor(Math.random() * LISTI.length)],
      };
    }

    function novaCastice(typ, kdekoli) {
      var c = {
        typ: typ,
        x: rnd(0, W),
        f: rnd(0, 6.3),
        k: rnd(0.5, 1.3),
        rot: rnd(0, 6.3),
        vr: rnd(-1.2, 1.2),
      };
      if (typ === 'lupen') {
        c.y = kdekoli ? rnd(-H, H) : rnd(-30, -8);
        c.v = rnd(14, 28);
        c.s = rnd(3.5, 6);
      } else if (typ === 'chmyri') {
        c.y = kdekoli ? rnd(0, H * 1.5) : H + rnd(8, 30); // chmýří stoupá
        c.v = -rnd(8, 18);
        c.s = rnd(4, 6.5);
      } else if (typ === 'svetluska') {
        c.y = rnd(H * 0.3, H);
        c.vx = rnd(-14, 14);
        c.vy = rnd(-8, 8);
      } else {
        // třpyt: objeví se, zajiskří a zmizí, pak jinde
        c.y = rnd(0, H);
        c.zivot = kdekoli ? rnd(0, 3) : 0;
        c.trva = rnd(1.8, 3.2);
        c.s = rnd(2.5, 4.5);
      }
      return c;
    }

    function castice(c, dt, t, idx) {
      var a;
      if (c.typ === 'lupen') {
        c.y += c.v * dt;
        c.x += Math.sin(t * c.k + c.f) * 20 * dt + 4 * dt;
        c.rot += c.vr * dt;
        if (c.y > H + 10) return (sezona[idx] = novaCastice('lupen', false));
        g.save();
        g.translate(c.x, c.y);
        g.rotate(c.rot);
        g.fillStyle = sklo ? 'rgba(128,82,98,0.9)' : 'rgba(214,130,160,0.5)';
        g.beginPath();
        g.ellipse(0, 0, c.s, c.s * 0.6, 0, 0, 6.2832);
        g.fill();
        g.restore();
      } else if (c.typ === 'chmyri') {
        c.y += c.v * dt;
        c.x += Math.sin(t * c.k + c.f) * 16 * dt + 5 * dt;
        c.rot += c.vr * 0.3 * dt;
        if (c.y < -15) return (sezona[idx] = novaCastice('chmyri', false));
        g.strokeStyle = 'rgba(' + B + ',' + (sklo ? 0.9 : 0.4) + ')';
        g.fillStyle = g.strokeStyle;
        g.lineWidth = 0.8;
        g.beginPath();
        for (var r = 0; r < 8; r++) {
          var u = c.rot + (r * 6.2832) / 8;
          g.moveTo(c.x, c.y);
          g.lineTo(c.x + Math.cos(u) * c.s, c.y + Math.sin(u) * c.s);
        }
        g.stroke();
        g.beginPath();
        g.arc(c.x, c.y, 1.1, 0, 6.2832);
        g.fill();
      } else if (c.typ === 'svetluska') {
        c.vx += rnd(-20, 20) * dt;
        c.vy += rnd(-20, 20) * dt;
        c.vx = Math.max(-16, Math.min(16, c.vx));
        c.vy = Math.max(-10, Math.min(10, c.vy));
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        if (c.x < -10 || c.x > W + 10 || c.y < 0 || c.y > H + 10)
          return (sezona[idx] = novaCastice('svetluska'));
        a = 0.5 + 0.5 * Math.sin(t * c.k * 2.2 + c.f);
        var gr = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, 7);
        var barva = sklo ? '150,140,60' : '150,120,10';
        gr.addColorStop(0, 'rgba(' + barva + ',' + a * (sklo ? 0.95 : 0.6) + ')');
        gr.addColorStop(1, 'rgba(' + barva + ',0)');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(c.x, c.y, 7, 0, 6.2832);
        g.fill();
      } else {
        c.zivot += dt;
        if (c.zivot > c.trva) return (sezona[idx] = novaCastice('trpyt', false));
        a = Math.sin((c.zivot / c.trva) * 3.1416);
        var s = c.s * a;
        g.strokeStyle = sklo ? 'rgba(150,150,150,' + a + ')' : 'rgba(' + B + ',' + 0.45 * a + ')';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(c.x - s, c.y);
        g.lineTo(c.x + s, c.y);
        g.moveTo(c.x, c.y - s);
        g.lineTo(c.x, c.y + s);
        g.stroke();
      }
    }

    function paprskySlunce(t) {
      // vějíř paprsků z pravého horního rohu, otočka za ~3 min
      var cx = W * 0.9,
        cy = -H * 0.2,
        R = Math.max(W, H) * 0.9,
        n = 12;
      g.fillStyle = sklo ? 'rgba(120,100,50,0.22)' : 'rgba(210,160,40,0.1)';
      for (var i = 0; i < n; i++) {
        var u = t * 0.035 + (i * 6.2832) / n;
        g.beginPath();
        g.moveTo(cx, cy);
        g.arc(cx, cy, R, u, u + 0.11);
        g.closePath();
        g.fill();
      }
    }

    // ---- obloha: kde je Slunce a Měsíc (0 = východ, 1 = západ; null = pod obzorem) ----
    function drahaSlunce(ted) {
      if (SV === null || SZ === null) return null;
      var f = (ted - SV) / (SZ - SV);
      return f >= 0 && f <= 1 ? f : null;
    }
    function drahaMesice(ted) {
      if (MV !== null && MZ !== null && MV < MZ) {
        var f = (ted - MV) / (MZ - MV);
        return f >= 0 && f <= 1 ? f : null;
      }
      if (MZ !== null && ted <= MZ) return Math.max(0, 1 - (MZ - ted) / MESIC_DRAHA); // vyšel včera
      if (MV !== null && ted >= MV) return Math.min(1, (ted - MV) / MESIC_DRAHA); // zapadne zítra
      return null;
    }
    function bodNaDraze(f, r) {
      return { x: r + (W - 2 * r) * (0.04 + 0.92 * f), y: H * 0.92 - Math.sin(Math.PI * f) * H * 0.72 };
    }
    function obloha(ted) {
      var fS = drahaSlunce(ted);
      var soumrak = 45 * 60e3;
      var kSoumraku = 0; // 1 = přesně východ/západ, 0 = daleko
      if (SV !== null) kSoumraku = Math.max(kSoumraku, 1 - Math.abs(ted - SV) / soumrak);
      if (SZ !== null) kSoumraku = Math.max(kSoumraku, 1 - Math.abs(ted - SZ) / soumrak);
      var noc = fS === null ? 1 - kSoumraku * 0.6 : 0;
      // tma: ztmavení (bílý text na skle tím jen získá kontrast; v kartě jen náznak)
      if (noc > 0) {
        g.fillStyle = sklo ? 'rgba(8,14,40,' + 0.38 * noc + ')' : 'rgba(30,40,80,' + 0.05 * noc + ')';
        g.fillRect(0, 0, W, H);
      }
      // soumrak / svítání: teplá záře u obzoru na straně Slunce
      if (kSoumraku > 0) {
        var vychod = SV !== null && Math.abs(ted - SV) < soumrak;
        var gx = vychod ? W * 0.08 : W * 0.92;
        var gr = g.createRadialGradient(gx, H, 0, gx, H, W * 0.55);
        var c = sklo ? '140,80,40' : '245,160,90';
        gr.addColorStop(0, 'rgba(' + c + ',' + (sklo ? 0.55 : 0.22) * kSoumraku + ')');
        gr.addColorStop(1, 'rgba(' + c + ',0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, W, H);
      }
      // Slunce
      if (fS !== null) {
        var r = Math.min(30, H * 0.11),
          s = bodNaDraze(fS, r * 2);
        var gs = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3);
        var cs = sklo ? '130,105,45' : '240,180,40';
        gs.addColorStop(0, 'rgba(' + cs + ',' + (sklo ? 0.9 : 0.45) + ')');
        gs.addColorStop(0.33, 'rgba(' + cs + ',' + (sklo ? 0.75 : 0.3) + ')');
        gs.addColorStop(1, 'rgba(' + cs + ',0)');
        g.fillStyle = gs;
        g.beginPath();
        g.arc(s.x, s.y, r * 3, 0, 6.2832);
        g.fill();
      }
      // Měsíc ve skutečné fázi
      var fM = drahaMesice(ted);
      if (fM !== null) {
        var rm = Math.min(26, H * 0.09),
          m = bodNaDraze(fM, rm * 2);
        kresliMesic(m.x, m.y, rm);
      }
    }
    function kresliMesic(x, y, r) {
      var svetla = sklo ? 'rgba(106,106,106,0.95)' : 'rgba(120,140,170,0.35)';
      var tmava = sklo ? 'rgba(30,34,48,0.55)' : 'rgba(120,140,170,0.1)';
      var halo = g.createRadialGradient(x, y, r * 0.8, x, y, r * 2.6);
      halo.addColorStop(0, sklo ? 'rgba(106,106,106,0.4)' : 'rgba(120,140,170,0.18)');
      halo.addColorStop(1, 'rgba(106,106,106,0)');
      g.fillStyle = halo;
      g.beginPath();
      g.arc(x, y, r * 2.6, 0, 6.2832);
      g.fill();
      g.save();
      g.beginPath();
      g.arc(x, y, r, 0, 6.2832);
      g.clip();
      g.fillStyle = tmava;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
      // osvětlená část: půlkruh na osvětlené straně + elipsa terminátoru
      var dorusta = FAZE < 0.5; // u nás (severní polokoule) dorůstající svítí vpravo
      var k = Math.cos(FAZE * 2 * Math.PI); // 1 nov, -1 úplněk
      g.fillStyle = svetla;
      g.beginPath();
      g.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !dorusta);
      g.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, k > 0 === dorusta);
      g.fill();
      g.restore();
    }

    function mrak(m) {
      // chuchvalec ze čtyř měkkých koulí
      var r = 70 * m.s;
      var koule = [
        [0, 0, 1],
        [0.8, 0.15, 0.8],
        [-0.75, 0.2, 0.75],
        [0.2, -0.35, 0.7],
      ];
      for (var i = 0; i < koule.length; i++) {
        var cx = m.x + koule[i][0] * r,
          cy = m.y + koule[i][1] * r,
          rr = koule[i][2] * r;
        var gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
        gr.addColorStop(0, 'rgba(' + MRAK + ',' + m.a * MRAK_A + ')');
        gr.addColorStop(1, 'rgba(' + MRAK + ',0)');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(cx, cy, rr, 0, 6.2832);
        g.fill();
      }
    }

    function list(l) {
      g.save();
      g.translate(l.x, l.y);
      g.rotate(l.rot);
      g.fillStyle = 'rgba(' + l.c + ',' + (sklo ? 0.9 : 0.55) + ')';
      g.beginPath();
      g.moveTo(0, -l.s);
      g.quadraticCurveTo(l.s * 0.75, -l.s * 0.2, 0, l.s);
      g.quadraticCurveTo(-l.s * 0.75, -l.s * 0.2, 0, -l.s);
      g.fill();
      g.strokeStyle = 'rgba(' + l.c + ',' + (sklo ? 0.9 : 0.55) + ')';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, l.s);
      g.lineTo(0, l.s * 1.35);
      g.stroke();
      g.restore();
    }

    function cestaBlesku() {
      var x = rnd(0.45, 0.9) * W,
        y = 0,
        body = [[x, y]];
      while (y < H * rnd(0.55, 0.85)) {
        x += rnd(-18, 18);
        y += rnd(10, 22);
        body.push([x, y]);
      }
      return body;
    }

    function snimek(dt, t) {
      g.clearRect(0, 0, W, H);
      var i;
      obloha(Date.now() + posunCasu);
      if (paprsky) paprskySlunce(t);
      // hvězdy (jen noc ve skle)
      for (i = 0; i < hvezdy.length; i++) {
        var h = hvezdy[i];
        g.fillStyle = 'rgba(' + B + ',' + (0.55 + 0.4 * Math.sin(t * h.k + h.f)) + ')';
        g.beginPath();
        g.arc(h.x, h.y, h.r, 0, 6.2832);
        g.fill();
      }
      // bouřka: krátký záblesk (dvakrát rychle za sebou) jednou za 6–12 s — daleko pod limitem 3 záblesků/s
      if (druh === 'bourka') {
        blesk.dalsi -= dt;
        if (blesk.dalsi <= 0) {
          blesk.trva = 0.45;
          blesk.cesta = cestaBlesku();
          blesk.dalsi = rnd(6, 12);
        }
        if (blesk.trva > 0) {
          blesk.trva -= dt;
          var zap = blesk.trva > 0.3 || (blesk.trva < 0.18 && blesk.trva > 0.05);
          if (zap) {
            g.fillStyle = 'rgba(' + B + ',0.35)';
            g.fillRect(0, 0, W, H);
            g.strokeStyle = sklo ? 'rgba(150,150,150,0.9)' : 'rgba(40,60,90,0.5)';
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(blesk.cesta[0][0], blesk.cesta[0][1]);
            for (i = 1; i < blesk.cesta.length; i++) g.lineTo(blesk.cesta[i][0], blesk.cesta[i][1]);
            g.stroke();
          }
        }
      }
      // mraky plují doprava, za okrajem se vrátí zleva
      for (i = 0; i < mraky.length; i++) {
        var m = mraky[i];
        m.x += m.v * dt;
        if (m.x - 140 * m.s > W) m.x = -140 * m.s;
        mrak(m);
      }
      // déšť
      g.lineWidth = 1;
      for (i = 0; i < kapky.length; i++) {
        var k = kapky[i];
        k.y += k.v * dt;
        k.x -= k.v * 0.18 * dt;
        if (k.y > H) {
          k.y = rnd(-40, -5);
          k.x = rnd(0, W + 60);
        }
        g.strokeStyle = 'rgba(' + B + ',' + k.a + ')';
        g.beginPath();
        g.moveTo(k.x, k.y);
        g.lineTo(k.x + k.d * 0.18, k.y - k.d);
        g.stroke();
      }
      // sníh se houpe
      for (i = 0; i < vlocky.length; i++) {
        var v = vlocky[i];
        v.y += v.v * dt;
        v.x += Math.sin(t * v.k + v.f) * 12 * dt;
        if (v.y > H + 4) {
          v.y = -4;
          v.x = rnd(0, W);
        }
        g.fillStyle = sklo ? 'rgba(150,150,150,0.8)' : 'rgba(' + B + ',0.35)';
        g.beginPath();
        g.arc(v.x, v.y, v.r, 0, 6.2832);
        g.fill();
      }
      for (i = 0; i < sezona.length; i++) castice(sezona[i], dt, t, i);
      // listí padá, kymácí se a točí
      for (i = 0; i < listy.length; i++) {
        var l = listy[i];
        l.y += l.v * dt;
        l.x += Math.sin(t * l.k + l.f) * 28 * dt + 6 * dt;
        l.rot += l.vr * dt;
        if (l.y > H + 20) listy[i] = novyList(false);
        list(listy[i]);
      }
    }

    rozmer();
    naplnit();
    if (KLID) {
      snimek(0, 0); // jeden klidný snímek, bez pohybu
      return;
    }

    var bezi = false,
      vidi = true,
      posl = 0,
      t = 0;
    function smycka(ted) {
      if (!bezi) return;
      var dt = Math.min(0.05, (ted - (posl || ted)) / 1000);
      posl = ted;
      t += dt;
      snimek(dt, t);
      requestAnimationFrame(smycka);
    }
    function prepni() {
      var ma = vidi && !document.hidden;
      if (ma && !bezi) {
        bezi = true;
        posl = 0;
        requestAnimationFrame(smycka);
      } else if (!ma) bezi = false;
    }
    if ('IntersectionObserver' in window)
      new IntersectionObserver(function (e) {
        vidi = e[0].isIntersecting;
        prepni();
      }).observe(sekce);
    document.addEventListener('visibilitychange', prepni);
    if ('ResizeObserver' in window)
      new window.ResizeObserver(function () {
        var w0 = W;
        rozmer();
        if (Math.abs(W - w0) > 40) naplnit();
      }).observe(sekce);
    prepni();
  }

  function start() {
    var s = document.querySelectorAll('.pocasi-dlazdice[data-scena]');
    for (var i = 0; i < s.length; i++) if (s[i].offsetParent !== null) scena(s[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
