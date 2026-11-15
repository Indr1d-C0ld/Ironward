# Novità

Tutte le versioni di Ironward, dalla più recente. Le date sono quelle del rilascio.

## 0.6.1 — 16 novembre 2026

### Corretto
- Menu iniziale: i collegamenti sotto GIOCA (Statistiche, Classifica, Opzioni, Amministrazione)
  uscivano dal riquadro; ora vanno a capo, anche su telefono.
- Testo più chiaro per la sensibilità del mouse nelle opzioni.

### Documentazione
- Schermate dell'interfaccia aggiornate nel README, con menu di pausa e pannello delle opzioni.
- Questo file e le note di rilascio su GitHub.

## 0.6.0 — 16 novembre 2026

### Aggiunto
- Spari registrati dal vero al posto di quelli sintetizzati: 9 campioni dalla *Free Firearm Sound
  Library* (CC0) — Colt 1911, Carl Gustav M45, AK-47 per il giocatore, le stesse armi sentite da
  lontano per gli altri giocatori, Mosin-Nagant per le sentinelle, raffica di PPSh per gli
  assaltatori, revolver S&W 642 per il Comandante.
- `tools/cut-gunshot.py`: isola un colpo con la sua coda, normalizza e salva in WAV mono.
- Leggera variazione d'intonazione a ogni colpo; ripiego sintetico se i file non si caricano.

## 0.5.0 — 15 novembre 2026

### Aggiunto
- Menu di pausa con Esc: riprendi, opzioni, esci al menu.
- Pannello opzioni (anche dal menu iniziale) con cinque schede: controlli, comandi riassegnabili
  (due tasti per azione, mouse e rotella compresi), video (risoluzione, campo visivo, oscillazione,
  lampi, FPS), interfaccia (HUD, mirino, minimappa) e audio (volumi separati).
- Impostazioni salvate nel browser e applicate al volo.

### Cambiato
- Sensibilità del mouse predefinita dimezzata.
- Nuovi tasti predefiniti: clic destro per la granata, X/Z per cambiare arma.

### Corretto
- Alone grigio o bianco attorno ad alcuni sprite animati e ai corpi a terra.

## 0.4.0 — 15 novembre 2026

### Aggiunto
- Musica chiptune procedurale: ogni livello compone il proprio brano dal seed della mappa, con un
  carattere per tema e intensità che sale durante gli scontri.
- Riverbero sintetico su spari, porte ed esplosioni; passi del giocatore.

## 0.3.0 — 15 novembre 2026

### Aggiunto
- Le 16 texture delle pareti disegnate con PixelLab, porta blindata compresa.
- Nuovo nemico: il Comandante, a 8 direzioni.
- Cooperativa: porte blindate attorno alla stanza dell'uscita e tessera custodita dal Comandante.
- Giubbotto antiproiettile (armatura che assorbe metà dei danni) e granate (tasto G).
- Compensazione della latenza: i colpi valgono dove il tiratore vedeva il bersaglio, fino a
  400 ms indietro.

### Corretto
- In alcune mappe l'interruttore d'uscita si poteva azionare da un corridoio esterno.

## 0.2.0 — 15 novembre 2026

### Cambiato
- Personaggi, nemici, oggetti, stendardi, valigette e armi in prima persona sono ora pixel art
  disegnata con PixelLab, a 8 direzioni con animazioni di passo, mira e fuoco, dolore e caduta.
- Divise, stendardi e valigette ricolorati dal client nel colore del giocatore o della squadra.
- La grafica procedurale resta come ripiego.

## 0.1.0 — 15 novembre 2026

Prima versione completa.

- Raycaster software nel browser con porte scorrevoli, pareti segrete e luce a scalini.
- Mappe procedurali da seed condivisibile; simmetriche nelle modalità a squadre.
- Server autoritativo via WebSocket, con predizione e interpolazione lato client.
- Modalità: cooperativa contro l'IA, deathmatch, deathmatch a squadre, cattura i documenti.
- Account, EXP e 50 livelli, sblocchi cosmetici, bonus in cooperativa, statistiche e classifiche.
- Clan con codice d'invito, sfide tra clan e classifica dei clan.
- Pannello di amministrazione con registro delle azioni.
- Grafica procedurale in stile VGA: palette a 256 colori, sprite 128×128 con 8 viste.
