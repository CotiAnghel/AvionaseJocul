# Avionase — schelet de proiect

Joc de tip "Avionase" (variantă românească de Battleship, cu avioane în loc de
nave), 2 jucători sau om vs. calculator, jucabil direct din GitHub Pages.

## Ce e deja funcțional

- Ecran login (nume) → meniu → plasare avioane → joc
- Plasarea avioanelor: click pentru a plasa, `R` pentru a roti, validare formă/suprapuneri
- **Vs Calculator**: complet funcțional, 3 niveluri de dificultate (ușor / mediu / greu)
- **PvP**: matchmaking rapid ("quick match"), camere private cu cod + parolă
  opțională, sincronizare mutări în timp real prin Firestore

## Ce mai trebuie făcut înainte de a-l folosi cu adevărat

### 1. Activează Anonymous Authentication
În Firebase Console → **Build → Authentication → Sign-in method** → activează
**Anonymous**. Fără asta, `ensureSignedIn()` din `js/firebase-init.js` nu va
funcționa și nimeni nu se va putea loga.

### 2. Setează regulile Firestore (important pentru joc corect)
În Firebase Console → **Firestore Database → Rules**, înlocuiește regulile de
test cu ceva de genul:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /lobby/{docId} {
      allow read, write: if request.auth != null;
    }

    match /games/{gameId} {
      allow read, write: if request.auth != null;

      // Cheia securității: pozițiile avioanelor sunt private, doar
      // proprietarul (uid-ul lui) le poate citi sau scrie.
      match /private/{uid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }

    match /presence/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }

    match /chat/{messageId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
      allow update, delete: if false; // mesajele de chat sunt imuabile odata trimise
    }

    match /tournaments/{tournamentId} {
      allow read, write: if request.auth != null;
    }

    match /tournamentQueueMeta/{size} {
      allow read, write: if request.auth != null;
    }

    match /tournamentAssignment/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null; // scris de clientul care formeaza turneul, pentru fiecare jucator selectat
    }
  }
}
```

Fără regula de pe `private/{uid}`, oricine ar putea citi direct din Firestore
poziția avioanelor adversarului — regulile de mai sus sunt ce împiedică asta.

### 3. Testează local
Fiindcă folosim `type="module"`, majoritatea browserelor blochează
`import`-urile dacă deschizi `index.html` direct de pe disc (`file://`).
Rulează un server local simplu din folderul proiectului, de exemplu:

```
python3 -m http.server 8000
```

apoi deschide `http://localhost:8000`.

### 4. Publică pe GitHub Pages
1. Urcă folderul (`index.html`, `style.css`, `js/`) într-un repo GitHub
2. Settings → Pages → Source: branch-ul principal, root
3. Gata — link-ul va fi `https://<user>.github.io/<repo>/`

## Limitări cunoscute / de rafinat

- **Ambii jucători trebuie să fie online** în timpul unei partide PvP: nu
  există un server (Cloud Function) care să calculeze rezultatul unei
  lovituri — clientul jucătorului care apără face acest calcul local, din
  propriile date private, când primește o lovitură. Dacă adversarul închide
  tab-ul exact când tragi, lovitura rămâne "pending" până revine online.
- **Reconectare**: dacă cineva dă refresh la pagină în timpul unui joc PvP,
  `state.gameId` se pierde — ar merga bine să-l salvezi în `localStorage` și
  să reiei automat conexiunea la acel joc la reîncărcare.
- **Turneu**: bracket-ul e afișat ca listă text (fără schemă vizuală de tip
  arbore). Necesită ca toți jucătorii să rămână online pe tot parcursul
  turneului — nu există reconectare dacă cineva dă refresh în timpul unui
  meci de turneu. Dacă un jucător abandonează un meci de turneu (butonul
  "Închide jocul"), e eliminat automat prin abandon, iar adversarul avansează.
- **AI "greu"**: folosește o hartă de densitate/probabilitate (calculează
  toate plasările posibile rămase și lovește celula cea mai probabilă) — e un
  punct de plecare bun, dar poate fi rafinat (de ex. să excludă combinații
  care ar contrazice mai multe avioane deja distruse).
- **Fără reconectare la "quick match" dacă ieși din pagină** — dacă anulezi
  căutarea, `state.cancelQuickMatch()` există dar nu e apelat momentan
  nicăieri în UI (ar trebui legat de un buton "Anulează căutarea").
- Regulile Firestore de mai sus sunt permisive în rest (`request.auth !=
  null` e suficient) — bun pentru un proiect hobby cu prieteni, dar merită
  strânse dacă publici public link-ul (de ex. validarea că doar cei din
  `order` pot scrie în `games/{gameId}`).

## Structura fișierelor

```
index.html              - toate ecranele (login/menu/placement/game)
style.css               - tema vizuală (radar/aviație)
js/
  firebase-init.js      - config Firebase + autentificare anonimă
  ship-shapes.js        - forma avionului + rotații + validare plasare
  board.js              - randare grid 10x10 + etichete (3F etc.)
  ai.js                 - AI cu 3 dificultăți
  game-local.js          - joc complet vs. calculator (fără rețea)
  multiplayer.js         - matchmaking, camere private, sincronizare Firestore
  app.js                 - controller principal, leagă UI-ul de restul
```
