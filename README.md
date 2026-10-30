# Rechnungen & Angebote (PWA)

Offline-fähige Rechnungs- und Angebots-App für Android (und jeden Browser). Rechnungen und Angebote lassen sich per Freitext
beschreiben; eine KI liest den Text aus, die App prüft und berechnet alles selbst und speichert lokal auf dem Gerät.

## Was ist enthalten

- Freitext → KI → JSON (dein System-Prompt, unverändert bis auf das Datum, siehe `docs/system-prompt.txt`)
- Prüfung der KI-Antwort (Typen, Pflichtfelder), Hinweise sichtbar, Bestätigung nötig, Fertigstellen nur ohne Fehler
- Eigene Berechnung mit BigInt-Festkomma (`js/calc.js`), Steuer je Position gerundet; KI-Summen werden nur gegengeprüft
- Rechnung und Angebot, fortlaufende Nummern (beim Fertigstellen), Entwürfe, Duplizieren, Angebot → Rechnung
- Lokale Speicherung (localStorage), Datensicherung als JSON, Offline-Betrieb über Service Worker
- Druckansicht; PDF über „Drucken / als PDF speichern“ des Browsers
- Deutsch und Französisch (`js/i18n.js`, weitere Sprachen dort ergänzen), EUR/MAD/USD, Standardsteuersatz konfigurierbar (leer ab Werk)

## Schnellstart auf dem Handy (kostenlos)

1. **Hosting über GitHub Pages:** Dateien in ein öffentliches GitHub-Repo legen → Settings → Pages → „Deploy from a branch“ → `main` / `(root)`.
   Die Adresse `https://<name>.github.io/<repo>/` in Chrome am Handy öffnen → Menü → „App installieren“.
   (Das Repo enthält keine Geheimnisse; Schlüssel werden nur in der App auf dem Gerät eingegeben.)
2. **Gratis-KI:** Auf aistudio.google.com einen API-Schlüssel erstellen (ohne Zahlungsmethode, dann kann nichts berechnet werden).
   In der App: Einstellungen → KI-Dienst → Betriebsart „Direkt mit Gemini“ → Schlüssel eintragen → Speichern.
   Der Schlüssel bleibt nur in diesem Gerät, wird nicht gesichert und nicht an andere Server als Google gesendet.
   Bei Gratis-Tarifen kann Google Eingaben auswerten: keine sensiblen Kundendaten senden, wenn du das nicht möchtest.
3. **Einzeldatei ohne Hosting:** `node scripts/build-single.mjs` erzeugt `dist/rechnungs-app.html` (läuft auch per Doppelklick/`file://`).

## Lokal entwickeln

```bash
node server.js                      # http://127.0.0.1:8080
GEMINI_API_KEY=... APP_TOKEN=geheim node server.js   # zusätzlich KI-Proxy unter /api/extract
npm test                            # 39 Unit-/Integrationstests
node tests/e2e/ui.e2e.mjs           # Browsertest (benötigt Playwright)
```

## KI-Proxy (optional, für mehrere Nutzer oder wenn der Schlüssel nicht auf den Geräten liegen soll)

`worker/` ist ein kleiner Proxy (Cloudflare Worker, kostenloser Tarif):

```bash
cd worker
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put APP_TOKEN          # langer Zufallswert; derselbe in der App unter "Zugangscode"
# in wrangler.toml: ALLOWED_ORIGINS = "https://<name>.github.io"
npx wrangler deploy
```

In der App Betriebsart „Über eigenen Proxy“ wählen und die Worker-Adresse eintragen. Das Modell lässt sich in den Einstellungen
(Direkt-Modus) oder per `MODEL` im Worker ändern; Standard ist `gemini-2.5-flash`. Falls Google das Modell umbenennt,
dort den aktuellen Namen eintragen. Anderer Anbieter: `js/gemini.js` ersetzen. Prompt ändern: `docs/system-prompt.txt` bearbeiten,
dann `npm run build:prompt`.

## Wichtig zu wissen

- Die KI braucht Internet. Offline funktionieren Anzeigen, Bearbeiten und Speichern; die App sagt das ehrlich.
- Daten liegen nur im Browser dieses Geräts. Browserdaten löschen = Daten weg. Regelmäßig Sicherung herunterladen.
- `rabattNetto` der KI wird als Betrag je Position gelesen; in der App ist auch Prozent möglich.
- Preise werden als Nettopreise geführt. Ohne genannten Satz setzt die App nur den Standardsatz aus den Einstellungen ein und markiert das als Hinweis.
- Die Rechnungsvorlage ist allgemein gehalten. Pflichtangaben (z. B. Steuer-/ICE-Nummer, Rechnungsangaben nach deutschem oder marokkanischem Recht) bitte steuerlich prüfen lassen.
