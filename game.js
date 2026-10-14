/* ============================================================
   Blackjack · game.js
   ------------------------------------------------------------
   SO FUNKTIONIERT DIESES SPIEL
   1. Ziel: Näher an 21 als der Dealer, ohne drüber zu gehen.
      Karten 2-10 zählen ihre Zahl, Bube/Dame/König 10, das Ass
      1 oder 11 (automatisch so, wie es am besten ist).
   2. Pro Runde wird ein frisch gemischtes 52er-Deck benutzt. Echte
      Casinos mischen 6-8 Decks in einen "Schuh" und spielen mehrere
      Runden daraus; ein Deck pro Runde ist einfacher und macht
      Kartenzählen sinnlos.
   3. Die Regeln stehen in kleinen REINEN Funktionen (handWert,
      dealerMussZiehen, darfDoppeln, rundeAuswerten). Sie kennen
      kein DOM und lassen sich deshalb in Node testen.
   4. Der Dealer hat keine Wahl: Er zieht bei 16 oder weniger und
      steht ab 17 - auch bei "weichem" 17 (Ass als 11 gezählt).
   5. Auszahlung: Sieg 1:1, Blackjack (21 mit genau 2 Karten) 3:2,
      Push = Einsatz zurück. KEIN Split, KEINE Versicherung - bewusst
      weggelassen, damit die Regeln kurz und lernbar bleiben.
   6. Geld läuft NUR über ../assets/wallet.js: Einsatz abbuchen,
      Runde spielen, am Ende rundeAbschliessen(gesamtEinsatz, auszahlung).
   7. Die Variable "phase" verhindert, dass man mitten in einer
      Animation noch einmal klickt (einsatz → austeilen → spieler →
      dealer → wieder einsatz).
   ============================================================ */

import { bewegungReduziert, toplisteAnzeigen, stillEintragen } from "./assets/ui.js";
import { spielZuruecksetzen, lade, speichere } from "./assets/storage.js";
import {
  STARTGELD, kontostand, einsatzAbbuchen, rundeAbschliessen,
  istPleite, pleiteNeustart, walletHud, walletHudAktualisieren,
} from "./assets/wallet.js";

const SPIEL = "blackjack";            // Schlüssel für storage.js (Topliste, gewählter Chip)
const CHIPS = [10, 25, 50, 100];      // erlaubte Einsätze
const MINDESTEINSATZ = CHIPS[0];      // darunter ist man pleite
const AUSTEIL_MS = 380;               // passt zu .karte-szene.fliegt in spiel.css
const FLIP_MS = 600;                  // passt zu transition in .karte-dreh
const DEALER_PAUSE_MS = 450;          // kurze Denkpause zwischen den Dealer-Karten

/* ============================================================
   TEIL 1: REINE SPIELLOGIK (ohne DOM)
   "export" steht nur da, damit Tests in Node die Funktionen
   importieren können. Im Browser wird es nicht gebraucht.
   ============================================================ */

/*
 * Die vier Farben. Das Symbol endet auf ︎ (Variation Selector-15): Er sagt
 * dem Browser "bitte als TEXT zeichnen, nicht als bunten Emoji". Sonst
 * ließen sich ♥ und ♦ nicht per CSS-"color" einfärben.
 */
export const FARBEN = [
  { name: "Pik",    symbol: "♠︎", rot: false },
  { name: "Herz",   symbol: "♥︎", rot: true },
  { name: "Karo",   symbol: "♦︎", rot: true },
  { name: "Kreuz",  symbol: "♣︎", rot: false },
];

/* Kartenwerte wie in Higher Lower: 2..10, Bube=11, Dame=12, König=13, Ass=14. */
const WERT_KURZ = { 11: "B", 12: "D", 13: "K", 14: "A" };
const WERT_LANG = { 11: "Bube", 12: "Dame", 13: "König", 14: "Ass" };

export function kartenWertText(wert) {
  return WERT_KURZ[wert] ?? String(wert);
}

export function kartenName(karte) {
  return `${FARBEN[karte.farbe].name} ${WERT_LANG[karte.wert] ?? karte.wert}`;
}

/** Baut ein frisches Deck: 13 Werte x 4 Farben = 52 Karten. */
export function neuesDeck() {
  const deck = [];
  for (let farbe = 0; farbe < FARBEN.length; farbe++) {
    for (let wert = 2; wert <= 14; wert++) deck.push({ wert, farbe });
  }
  return deck;
}

/**
 * Mischt nach Fisher-Yates und gibt eine gemischte KOPIE zurück: Von hinten
 * nach vorne wird jede Position mit einer zufälligen Position davor (oder
 * sich selbst) getauscht. So ist jede der 52! Reihenfolgen gleich wahrscheinlich.
 * `zufall` ist austauschbar (Standard Math.random) – für Tests.
 */
export function mischen(karten, zufall = Math.random) {
  const kopie = [...karten];
  for (let i = kopie.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));
    [kopie[i], kopie[j]] = [kopie[j], kopie[i]];
  }
  return kopie;
}

/** Zählwert EINER Karte beim Blackjack: Ass 11 (kann später zu 1 werden), Bilder 10. */
export function kartenPunkte(wert) {
  if (wert === 14) return 11;
  if (wert >= 11) return 10;
  return wert;
}

/**
 * Wert einer Hand. Rückgabe:
 *   summe       bestmögliche Summe (so hoch wie möglich, aber wenn es geht <= 21)
 *   weich       true, wenn noch ein Ass als 11 mitzählt ("weich 17")
 *   ueberkauft  true, wenn die Summe über 21 liegt (Bust)
 *   blackjack   true, wenn es genau 2 Karten sind und die Summe 21 ist
 *
 * DER ASS-TRICK: Erst zählt jedes Ass 11. Ist die Summe über 21, wird ein
 * Ass nach dem anderen zu 1 gemacht (Summe minus 10), bis die Hand passt
 * oder kein Ass mehr übrig ist. Beispiel Ass+Ass+9: 11+11+9 = 31 → ein Ass
 * wird 1 → 21. Ein Ass zählt noch 11, also ist die Hand weich.
 */
export function handWert(karten) {
  let summe = 0;
  let asse = 0;                 // Asse, die gerade noch als 11 zählen
  for (const karte of karten) {
    summe += kartenPunkte(karte.wert);
    if (karte.wert === 14) asse++;
  }
  while (summe > 21 && asse > 0) {
    summe -= 10;                // Ass von 11 auf 1 umstellen
    asse--;
  }
  return {
    summe,
    weich: asse > 0,
    ueberkauft: summe > 21,
    blackjack: karten.length === 2 && summe === 21,
  };
}

/** Anzeigetext einer Hand: "Blackjack", "weich 17", "17" oder "24 · Bust". */
export function handText(karten) {
  const h = handWert(karten);
  if (h.blackjack) return "Blackjack";
  if (h.ueberkauft) return `${h.summe} · Bust`;
  if (h.weich) return `weich ${h.summe}`;
  return String(h.summe);
}

/**
 * Dealer-Regel: Ziehen bei 16 oder weniger, stehen ab 17.
 * Es zählt nur die Summe - ein weiches 17 (Ass+6) ist ebenfalls "ab 17",
 * der Dealer steht also auch dort. (Manche Casinos lassen ihn bei weichem
 * 17 noch ziehen - das ist hier bewusst NICHT so.)
 */
export function dealerMussZiehen(karten) {
  return handWert(karten).summe < 17;
}

/** Double ist nur mit genau 2 Karten erlaubt und wenn das Guthaben für einen zweiten Einsatz reicht. */
export function darfDoppeln(karten, guthaben, einsatz) {
  return karten.length === 2 && guthaben >= einsatz;
}

/**
 * Wertet eine fertige Runde aus. `einsatz` ist der GESAMTEINSATZ (beim
 * Double also der verdoppelte). Rückgabe:
 *   ergebnis   "blackjack" | "sieg" | "push" | "niederlage"
 *   auszahlung BRUTTO-Betrag, der aufs Konto zurückgeht (0 bei Niederlage)
 *   grund      kurzer Schlüssel für die Meldung im Spiel
 *
 * Reihenfolge ist wichtig: Wer sich überkauft, verliert sofort - auch wenn
 * der Dealer sich danach ebenfalls überkaufen würde (er spielt dann gar nicht).
 */
export function rundeAuswerten(spielerKarten, dealerKarten, einsatz) {
  const s = handWert(spielerKarten);
  const d = handWert(dealerKarten);

  if (s.ueberkauft) return { ergebnis: "niederlage", auszahlung: 0, grund: "spieler-bust" };
  if (s.blackjack && d.blackjack) return { ergebnis: "push", auszahlung: einsatz, grund: "beide-blackjack" };
  if (s.blackjack) {
    // 3:2 → Gewinn = 1,5 x Einsatz. Bei ungeraden Einsätzen (25) gäbe das
    // ein halbes Spielgeld; wie im Casino wird zugunsten der Bank abgerundet.
    return { ergebnis: "blackjack", auszahlung: einsatz + Math.floor(einsatz * 3 / 2), grund: "blackjack" };
  }
  if (d.blackjack) return { ergebnis: "niederlage", auszahlung: 0, grund: "dealer-blackjack" };
  if (d.ueberkauft) return { ergebnis: "sieg", auszahlung: einsatz * 2, grund: "dealer-bust" };
  if (s.summe > d.summe) return { ergebnis: "sieg", auszahlung: einsatz * 2, grund: "hoeher" };
  if (s.summe === d.summe) return { ergebnis: "push", auszahlung: einsatz, grund: "gleich" };
  return { ergebnis: "niederlage", auszahlung: 0, grund: "niedriger" };
}

/* ============================================================
   TEIL 2: KARTEN-DOM (Bauen und Füllen)
   Kartenbau wie in Higher Lower (dort ausführlich erklärt).
   ============================================================ */

function neuesElement(tag, klassen, text = "") {
  const el = document.createElement(tag);
  el.className = klassen;
  if (text) el.textContent = text;
  return el;
}

function eckeBauen(lage) {
  const ecke = neuesElement("div", `ecke ${lage}`);
  const wert = neuesElement("span", "ecke-wert");
  const symbol = neuesElement("span", "ecke-symbol");
  ecke.append(wert, symbol);
  return { ecke, wert, symbol };
}

/**
 * Baut EINE Karte als DOM: .karte-szene (Perspektive) > .karte-dreh (wird
 * gedreht) > .flaeche.hinten (Rücken) + .flaeche.vorne (Wert + Symbol).
 * Die Vorderseite bleibt zunächst LEER – bei der verdeckten Dealer-Karte
 * steht der Wert also nirgends im HTML, bis sie aufgedeckt wird.
 */
function karteBauen(aufgedeckt) {
  const szene = neuesElement("div", "karte-szene");
  const dreh = neuesElement("div", "karte-dreh");
  const hinten = neuesElement("div", "flaeche hinten");
  const vorne = neuesElement("div", "flaeche vorne");
  const oben = eckeBauen("oben");
  const unten = eckeBauen("unten");
  const mitte = neuesElement("div", "mitte");
  vorne.append(oben.ecke, mitte, unten.ecke);
  dreh.append(hinten, vorne);
  szene.append(dreh);
  if (aufgedeckt) dreh.classList.add("aufgedeckt");
  return { szene, dreh, vorne, oben, unten, mitte };
}

/** Schreibt eine Karte auf die Vorderseite – alles per textContent, nie innerHTML. */
function karteFuellen(karte, daten) {
  const farbe = FARBEN[daten.farbe];
  const wertText = kartenWertText(daten.wert);
  karte.oben.wert.textContent = wertText;
  karte.oben.symbol.textContent = farbe.symbol;
  karte.unten.wert.textContent = wertText;
  karte.unten.symbol.textContent = farbe.symbol;
  karte.mitte.textContent = farbe.symbol;
  karte.vorne.classList.toggle("rot", farbe.rot);
}

function warte(ms) {
  return new Promise((fertig) => setTimeout(fertig, ms));
}

/** Pause, die bei "Bewegung reduzieren" entfällt. */
function pause(ms) {
  return warte(bewegungReduziert() ? 0 : ms);
}

const zahlText = (n) => n.toLocaleString("de-DE");

/* ============================================================
   TEIL 3: DAS SPIEL IM BROWSER
   ============================================================ */

function starteSpiel() {
  // ----- Elemente einmal suchen und merken -----
  const meldungElement = document.getElementById("meldung");
  const gewinnElement = document.getElementById("gewinn");
  const einsatzAnzeige = document.getElementById("einsatz-anzeige");
  const chipKnoepfe = [...document.querySelectorAll("#chips .chip")];
  const gebenKnopf = document.getElementById("geben");
  const hitKnopf = document.getElementById("hit");
  const standKnopf = document.getElementById("stand");
  const doppelnKnopf = document.getElementById("doppeln");
  const toplisteElement = document.getElementById("topliste");

  // Beide Seiten (Dealer/Spieler) haben denselben Aufbau → ein Objekt je Seite
  const seiten = {
    dealer:  { hand: document.getElementById("hand-dealer"),  reihe: document.getElementById("dealer-karten"),  punkte: document.getElementById("dealer-punkte"),  doms: [] },
    spieler: { hand: document.getElementById("hand-spieler"), reihe: document.getElementById("spieler-karten"), punkte: document.getElementById("spieler-punkte"), doms: [] },
  };

  walletHud(document.getElementById("wallet-hud"));

  // ----- Spielzustand -----
  let phase = "einsatz";      // "einsatz" | "austeilen" | "spieler" | "dealer" | "ende"
  let deck = [];              // oberste Karte = LETZTE im Array (pop)
  let spielerKarten = [];
  let dealerKarten = [];
  let dealerVerdeckt = false; // zweite Dealer-Karte noch zu?
  let einsatz = ladeEinsatz();       // gewählter Chip
  let gesamtEinsatz = 0;             // laufende Runde (beim Double doppelt)

  /** Gespeicherten Chip laden – nur erlaubte Werte, sonst 50. */
  function ladeEinsatz() {
    const gespeichert = lade(SPIEL, "einsatz", 50);
    return CHIPS.includes(gespeichert) ? gespeichert : 50;
  }

  /** Der größte Chip, den das Konto noch hergibt (mindestens der kleinste). */
  function groessterBezahlbarerChip() {
    const stand = kontostand();
    return [...CHIPS].reverse().find((c) => c <= stand) ?? MINDESTEINSATZ;
  }

  // ---------------------------------------------------------
  // Anzeigen
  // ---------------------------------------------------------

  function meldungSetzen(text, art = "neutral") {
    meldungElement.textContent = text;
    meldungElement.dataset.art = art;
  }

  /** "+75" / "Push" / "−50" über dem Spielerblatt. */
  function gewinnSetzen(netto) {
    gewinnElement.className = "gewinn-anzeige";
    if (netto === null) {
      gewinnElement.textContent = "";
    } else if (netto > 0) {
      gewinnElement.textContent = `+${zahlText(netto)}`;
      gewinnElement.classList.add("plus");
    } else if (netto === 0) {
      gewinnElement.textContent = "Push";
    } else {
      gewinnElement.textContent = `−${zahlText(-netto)}`;   // echtes Minuszeichen (U+2212)
      gewinnElement.classList.add("minus");
    }
  }

  /** Punktzahl-Pillen. Beim Dealer zeigt sie vor dem Aufdecken nur die offene Karte. */
  function punkteAnzeigen() {
    seiten.spieler.punkte.textContent = spielerKarten.length ? handText(spielerKarten) : "";
    if (!dealerKarten.length) {
      seiten.dealer.punkte.textContent = "";
    } else if (dealerVerdeckt) {
      seiten.dealer.punkte.textContent = `${kartenPunkte(dealerKarten[0].wert)} + ?`;
    } else {
      seiten.dealer.punkte.textContent = handText(dealerKarten);
    }
  }

  /** Schaltet alle Knöpfe passend zur Phase ein oder aus. */
  function steuerungEinstellen() {
    const imEinsatz = phase === "einsatz";
    const stand = kontostand();
    for (const knopf of chipKnoepfe) {
      const wert = Number(knopf.dataset.wert);
      knopf.disabled = !imEinsatz || wert > stand;
      knopf.setAttribute("aria-pressed", String(wert === einsatz));
    }
    gebenKnopf.disabled = !imEinsatz || einsatz > stand;
    const amZug = phase === "spieler";
    hitKnopf.disabled = !amZug;
    standKnopf.disabled = !amZug;
    doppelnKnopf.disabled = !(amZug && darfDoppeln(spielerKarten, kontostand(), einsatz));
  }

  /** Wählt einen Chip; ist er zu teuer, wird der größte bezahlbare genommen. */
  function einsatzWaehlen(wert) {
    einsatz = wert;
    if (einsatz > kontostand()) einsatz = groessterBezahlbarerChip();
    speichere(SPIEL, "einsatz", einsatz);
    steuerungEinstellen();
  }

  function seiteAktualisieren() {
    toplisteAnzeigen(toplisteElement, SPIEL, (p) => `+${zahlText(p)}`);
  }

  // ---------------------------------------------------------
  // Karten auf den Tisch legen
  // ---------------------------------------------------------

  /** Räumt beide Hände ab. */
  function tischLeeren() {
    for (const seite of Object.values(seiten)) {
      seite.reihe.replaceChildren();
      seite.reihe.style.setProperty("--n", "0");
      seite.doms = [];
      seite.hand.classList.remove("sieg", "push", "verloren");
    }
    spielerKarten = [];
    dealerKarten = [];
    dealerVerdeckt = false;
    punkteAnzeigen();
  }

  /**
   * Legt eine Karte auf die Hand `wer` ("spieler" | "dealer"). Verdeckt
   * heißt: Rückseite oben, Wert wird NICHT ins HTML geschrieben.
   * Die Karte fliegt per CSS-Animation ein (außer bei reduzierter Bewegung).
   */
  async function karteAusteilen(wer, daten, verdeckt = false) {
    const seite = seiten[wer];
    const dom = karteBauen(false);
    if (!verdeckt) {
      karteFuellen(dom, daten);
      dom.dreh.classList.add("aufgedeckt");
      dom.szene.setAttribute("role", "img");
      dom.szene.setAttribute("aria-label", kartenName(daten));
    } else {
      dom.szene.setAttribute("role", "img");
      dom.szene.setAttribute("aria-label", "Verdeckte Karte");
    }
    if (!bewegungReduziert()) dom.szene.classList.add("fliegt");
    seite.doms.push(dom);
    seite.reihe.append(dom.szene);
    seite.reihe.style.setProperty("--n", String(seite.reihe.children.length));
    (wer === "spieler" ? spielerKarten : dealerKarten).push(daten);
    punkteAnzeigen();
    await pause(AUSTEIL_MS);
  }

  /** Dealer deckt seine zweite Karte auf (3D-Flip). */
  async function dealerAufdecken() {
    if (!dealerVerdeckt) return;
    const dom = seiten.dealer.doms[1];
    karteFuellen(dom, dealerKarten[1]);                 // erst JETZT steht der Wert im HTML
    dom.szene.setAttribute("aria-label", kartenName(dealerKarten[1]));
    dom.dreh.classList.add("aufgedeckt");
    dealerVerdeckt = false;
    punkteAnzeigen();
    await pause(FLIP_MS);
  }

  /** Zieht die oberste Karte vom Deck. Ein frisches 52er-Deck reicht für jede Hand locker. */
  function ziehen() {
    return deck.pop();
  }

  // ---------------------------------------------------------
  // Spielablauf
  // ---------------------------------------------------------

  async function geben() {
    if (phase !== "einsatz") return;
    if (!einsatzAbbuchen(einsatz)) {
      meldungSetzen("Dafür reicht dein Spielgeld nicht. Wähle einen kleineren Einsatz.", "falsch");
      einsatzWaehlen(einsatz);
      return;
    }
    gesamtEinsatz = einsatz;
    walletHudAktualisieren();                            // der Einsatz verlässt sichtbar das Konto
    phase = "austeilen";
    steuerungEinstellen();

    tischLeeren();
    gewinnSetzen(null);
    einsatzAnzeige.textContent = `Einsatz ${zahlText(gesamtEinsatz)}`;
    meldungSetzen("Karten werden ausgeteilt …");
    deck = mischen(neuesDeck());                         // pro Runde ein frisches Deck

    // Reihenfolge wie am echten Tisch: Spieler, Dealer (offen), Spieler, Dealer (verdeckt)
    await karteAusteilen("spieler", ziehen());
    await karteAusteilen("dealer", ziehen());
    await karteAusteilen("spieler", ziehen());
    dealerVerdeckt = true;                               // VOR dem Austeilen: die Pille zeigt dann "x + ?"
    await karteAusteilen("dealer", ziehen(), true);

    // Blackjack auf einer Seite: Die Runde endet sofort (Dealer schaut nach)
    if (handWert(spielerKarten).blackjack || handWert(dealerKarten).blackjack) {
      await dealerAufdecken();
      await rundeBeenden();
      return;
    }

    phase = "spieler";
    meldungSetzen("Du bist dran: Hit, Stand oder Double?");
    steuerungEinstellen();
  }

  /** Hit: eine Karte ziehen. */
  async function hit() {
    if (phase !== "spieler") return;
    phase = "austeilen";
    steuerungEinstellen();
    await karteAusteilen("spieler", ziehen());
    const hand = handWert(spielerKarten);
    if (hand.ueberkauft) {
      await dealerAufdecken();                           // Dealer zeigt seine Karte, zieht aber nicht mehr
      await rundeBeenden();
    } else if (hand.summe === 21) {
      await dealerSpielt();                              // bei 21 gibt es nichts mehr zu entscheiden
    } else {
      phase = "spieler";
      meldungSetzen("Noch eine Karte oder bleiben?");
      steuerungEinstellen();
    }
  }

  /** Stand: Der Dealer ist dran. */
  async function stand() {
    if (phase !== "spieler") return;
    await dealerSpielt();
  }

  /** Double: Einsatz verdoppeln, genau eine Karte, dann automatisch Stand. */
  async function doppeln() {
    if (phase !== "spieler") return;
    if (!darfDoppeln(spielerKarten, kontostand(), einsatz)) return;
    if (!einsatzAbbuchen(einsatz)) return;               // zweiter Einsatz in gleicher Höhe
    gesamtEinsatz = einsatz * 2;
    walletHudAktualisieren();
    einsatzAnzeige.textContent = `Einsatz ${zahlText(gesamtEinsatz)}`;
    phase = "austeilen";
    steuerungEinstellen();
    await karteAusteilen("spieler", ziehen());
    if (handWert(spielerKarten).ueberkauft) {
      await dealerAufdecken();
      await rundeBeenden();
    } else {
      await dealerSpielt();
    }
  }

  /** Dealer deckt auf und zieht nach seiner festen Regel. */
  async function dealerSpielt() {
    phase = "dealer";
    steuerungEinstellen();
    meldungSetzen("Dealer ist dran …");
    await dealerAufdecken();
    while (dealerMussZiehen(dealerKarten)) {
      await pause(DEALER_PAUSE_MS);
      await karteAusteilen("dealer", ziehen());
    }
    await rundeBeenden();
  }

  /** Auswertung: Meldung, Geld, Topliste, Pleite-Check. */
  async function rundeBeenden() {
    const ergebnis = rundeAuswerten(spielerKarten, dealerKarten, gesamtEinsatz);
    rundeAbschliessen(gesamtEinsatz, ergebnis.auszahlung);
    walletHudAktualisieren();
    const netto = ergebnis.auszahlung - gesamtEinsatz;

    const texte = {
      "spieler-bust": ["Überkauft! Über 21, die Runde ist verloren.", "falsch"],
      "beide-blackjack": ["Beide haben Blackjack – Push, du bekommst den Einsatz zurück.", "gleich"],
      "blackjack": ["Blackjack! Das zahlt 3:2.", "richtig"],
      "dealer-blackjack": ["Der Dealer hat Blackjack.", "falsch"],
      "dealer-bust": ["Der Dealer überkauft sich – du gewinnst!", "richtig"],
      "hoeher": ["Du hast mehr als der Dealer – gewonnen!", "richtig"],
      "gleich": ["Gleichstand – Push, du bekommst den Einsatz zurück.", "gleich"],
      "niedriger": ["Der Dealer ist näher an 21 – verloren.", "falsch"],
    };
    const [text, art] = texte[ergebnis.grund];
    meldungSetzen(text, art);
    gewinnSetzen(netto);
    seiten.spieler.hand.classList.add(
      ergebnis.ergebnis === "push" ? "push" : netto > 0 ? "sieg" : "verloren"
    );
    if (!bewegungReduziert() && netto > 0) gewinnElement.classList.add("blitz");

    // Kurze Pause, damit man das Ergebnis sieht. In Phase "ende" sind alle Knöpfe
    // aus, sonst könnte man schon die nächste Runde starten, während gleich ein
    // Dialog aufgeht.
    phase = "ende";
    steuerungEinstellen();
    await pause(900);
    phase = "einsatz";
    einsatzWaehlen(einsatz);
    // Top-3-Gewinn? STILL eintragen (mit den zuletzt benutzten Initialen)
    // und nur die Topliste auf der Seite aktualisieren – kein Dialog,
    // keine Aufforderung. Die Gewinn-Anzeige sagt ja schon alles.
    if (netto > 0 && stillEintragen(SPIEL, netto) !== null) {
      seiteAktualisieren();
    }
    if (istPleite(MINDESTEINSATZ)) {
      pleiteDialogZeigen();
    }
  }

  /** "Pleite! Neues Startgeld." – lässt sich nur per Knopf schließen. */
  function pleiteDialogZeigen() {
    if (document.getElementById("pleite-dialog")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "spiel-dialog";
    dialog.id = "pleite-dialog";
    // Nur feste Texte im HTML; die Zahl kommt per textContent
    dialog.innerHTML = `
      <h2>Pleite!</h2>
      <p>Dein Spielgeld ist aufgebraucht. Du bekommst neues Startgeld:</p>
      <p class="gross"></p>
      <div class="aktionen">
        <button class="knopf primaer" data-rolle="neu">Neues Startgeld</button>
        
      </div>`;
    dialog.querySelector(".gross").textContent = zahlText(STARTGELD);
    dialog.querySelector('[data-rolle="neu"]').addEventListener("click", () => {
      pleiteNeustart();
      walletHudAktualisieren();
      dialog.close();
      dialog.remove();
      einsatzWaehlen(einsatz);
      meldungSetzen("Neues Startgeld ist da. Viel Glück!");
    });
    // Esc würde den Dialog ohne Neustart schließen → verhindern
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector("button")?.focus();
  }

  // ---------------------------------------------------------
  // Eingabe
  // ---------------------------------------------------------
  for (const knopf of chipKnoepfe) {
    knopf.addEventListener("click", () => einsatzWaehlen(Number(knopf.dataset.wert)));
  }
  gebenKnopf.addEventListener("click", geben);
  hitKnopf.addEventListener("click", hit);
  standKnopf.addEventListener("click", stand);
  doppelnKnopf.addEventListener("click", doppeln);

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;      // Browser-Kürzel nicht stören
    if (e.repeat) return;                                // gehaltene Taste nicht mehrfach auslösen
    if (document.querySelector("dialog[open]")) return;  // Dialog offen → Tasten gehören ihm
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const taste = e.key?.toLowerCase();
    if (taste === "g") geben();
    else if (taste === "h") hit();
    else if (taste === "s") stand();
    else if (taste === "d") doppeln();
  });

  document.getElementById("reset").addEventListener("click", () => {
    spielZuruecksetzen(SPIEL);                           // löscht Topliste + gespeicherten Chip (NICHT das Spielgeld)
    speichere(SPIEL, "einsatz", einsatz);                // der aktuell gewählte Chip bleibt gewählt
    seiteAktualisieren();
  });

  // ----- Start -----
  einsatzWaehlen(einsatz);
  meldungSetzen("Wähle deinen Einsatz und drücke „Geben“.");
  seiteAktualisieren();
  if (istPleite(MINDESTEINSATZ)) pleiteDialogZeigen();
}

// Nur im Browser starten. In Node (Tests) gibt es kein "document" –
// dort werden nur die reinen Funktionen oben importiert.
if (typeof document !== "undefined") {
  starteSpiel();
}
