/* ============================================================
   wallet.js · Gemeinsames Spielgeld-Konto für alle Casino-Spiele
   ------------------------------------------------------------
   Slots, Blackjack und der Casino-Modus von Higher Lower teilen
   sich EIN Konto: Wer bei Slots gewinnt, kann den Gewinn am
   Blackjack-Tisch wieder verspielen. Deshalb liegt die Logik
   hier zentral und nicht in den einzelnen Spielen.

   WICHTIG: Alles ist reines SPIELGELD. Es gibt keinerlei Bezug
   zu echtem Geld und keine Kaufmöglichkeit – genau deshalb ist
   das rechtlich kein Glücksspiel (kein Einsatz eines Vermögens-
   werts im Sinne des Glücksspielstaatsvertrags).

   Gespeichert wird über storage.js unter dem Spiel-Namensraum
   "casino" (ba:casino:*), also getrennt von den Arcade-Toplisten:
     kontostand            aktueller Stand (Start: 1.000)
     hoechsterGewinn       größter NETTO-Gewinn einer einzelnen Runde
     hoechsterKontostand   bester Stand, der je erreicht wurde
     pleiten               wie oft das Konto neu gestartet wurde

   Typischer Ablauf in einem Spiel:
     1. einsatzAbbuchen(50)            → false, wenn zu wenig Geld
     2. … Runde spielen …
     3. rundeAbschliessen(50, 120)     → Auszahlung gutschreiben,
                                         Stats pflegen, Netto +70
     4. istPleite(10)? → pleiteNeustart() nach Hinweis-Dialog
   ============================================================ */

import { lade, speichere } from "./storage.js";

export const STARTGELD = 1000;
const SPIEL = "casino";   // gemeinsamer Namensraum für alle Casino-Spiele

/** Aktueller Kontostand (legt beim allerersten Aufruf das Startgeld an). */
export function kontostand() {
  return lade(SPIEL, "kontostand", STARTGELD);
}

/** Die drei Kennzahlen für die Casino-HUD-Leiste. */
export function statistik() {
  return {
    kontostand: kontostand(),
    hoechsterGewinn: lade(SPIEL, "hoechsterGewinn", 0),
    hoechsterKontostand: lade(SPIEL, "hoechsterKontostand", STARTGELD),
    pleiten: lade(SPIEL, "pleiten", 0),
  };
}

/**
 * Bucht den Einsatz ab, BEVOR die Runde läuft.
 * Gibt false zurück, wenn das Konto nicht reicht – das Spiel
 * darf die Runde dann nicht starten.
 */
export function einsatzAbbuchen(einsatz) {
  const stand = kontostand();
  if (!Number.isInteger(einsatz) || einsatz <= 0 || einsatz > stand) return false;
  speichere(SPIEL, "kontostand", stand - einsatz);
  return true;
}

/**
 * Schließt eine Runde ab: schreibt die Auszahlung gut und pflegt
 * die Statistiken. `auszahlung` ist der BRUTTO-Betrag, der zurück
 * aufs Konto geht (0 = Einsatz komplett verloren; bei "Einsatz
 * zurück" ist auszahlung === einsatz).
 * Gibt den neuen Kontostand zurück.
 */
export function rundeAbschliessen(einsatz, auszahlung) {
  const neuerStand = kontostand() + auszahlung;
  speichere(SPIEL, "kontostand", neuerStand);

  // Höchster NETTO-Gewinn einer Runde (Auszahlung minus Einsatz).
  const netto = auszahlung - einsatz;
  if (netto > lade(SPIEL, "hoechsterGewinn", 0)) {
    speichere(SPIEL, "hoechsterGewinn", netto);
  }
  if (neuerStand > lade(SPIEL, "hoechsterKontostand", STARTGELD)) {
    speichere(SPIEL, "hoechsterKontostand", neuerStand);
  }
  return neuerStand;
}

/** true, wenn nicht einmal mehr der Mindesteinsatz drin ist. */
export function istPleite(mindesteinsatz) {
  return kontostand() < mindesteinsatz;
}

/**
 * Pleite-Neustart: Konto zurück auf das Startgeld.
 * Die Rekorde (höchster Gewinn / Kontostand) bleiben bewusst
 * stehen – nur der Pleiten-Zähler geht hoch. Jeder startet mit
 * dem gleichen Startgeld, auch nach der Pleite.
 */
export function pleiteNeustart() {
  speichere(SPIEL, "kontostand", STARTGELD);
  speichere(SPIEL, "pleiten", lade(SPIEL, "pleiten", 0) + 1);
}

/* ------------------------------------------------------------
   HUD-Leiste: gleiche Optik auf allen Casino-Seiten.
   Die Spiele rufen walletHud(container) EINMAL beim Start auf
   und danach walletHudAktualisieren() nach jeder Runde. Die
   Zahlen ticken weich hoch/runter (zahlHochzaehlen aus ui.js
   wird hier nicht importiert, um einen Import-Kreis ui↔wallet
   zu vermeiden – der kleine Ticker steht deshalb lokal).
   ------------------------------------------------------------ */

function tick(element, zielWert) {
  const start = Number(element.textContent.replace(/\D/g, "")) || 0;
  const reduziert = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduziert || start === zielWert) {
    element.textContent = zielWert.toLocaleString("de-DE");
    return;
  }
  const startZeit = performance.now();
  (function schritt(jetzt) {
    const f = Math.min(((jetzt ?? performance.now()) - startZeit) / 450, 1);
    const eased = 1 - Math.pow(1 - f, 3);
    element.textContent = Math.round(start + (zielWert - start) * eased).toLocaleString("de-DE");
    if (f < 1) requestAnimationFrame(schritt);
  })();
}

let hudFelder = null;

/** Baut die Casino-HUD-Leiste (Kontostand · höchster Gewinn · bester Stand). */
export function walletHud(container) {
  container.innerHTML = `
    <div class="hud-feld"><div class="label">Kontostand</div><div class="wert" data-w="kontostand">0</div></div>
    <div class="hud-feld"><div class="label">Höchster Gewinn</div><div class="wert" data-w="hoechsterGewinn">0</div></div>
    <div class="hud-feld"><div class="label">Bester Stand</div><div class="wert" data-w="hoechsterKontostand">0</div></div>`;
  hudFelder = {
    kontostand: container.querySelector('[data-w="kontostand"]'),
    hoechsterGewinn: container.querySelector('[data-w="hoechsterGewinn"]'),
    hoechsterKontostand: container.querySelector('[data-w="hoechsterKontostand"]'),
  };
  walletHudAktualisieren(false);
}

/** Zahlen nachziehen; mitTicker=false setzt sie sofort (Seitenstart). */
export function walletHudAktualisieren(mitTicker = true) {
  if (!hudFelder) return;
  const s = statistik();
  for (const [name, el] of Object.entries(hudFelder)) {
    if (mitTicker) tick(el, s[name]);
    else el.textContent = s[name].toLocaleString("de-DE");
  }
}
