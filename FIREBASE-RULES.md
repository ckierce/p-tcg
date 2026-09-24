# Firebase Realtime Database rules

`database.rules.json` is the source-controlled copy of the security rules for
the `p-tcg-a6b2c` database. The rules are **not** applied by deploying this
repo: GitHub Pages only serves files. Apply them in the Firebase console.

## Why this matters

The database URL and API key ship inside the client JavaScript (that is normal
for Firebase; they are identifiers, not secrets). What protects the data is the
rules. Before these rules, `games/` and `decks/` accepted writes from anyone on
the internet with no sign-in, so one HTTP request could delete every saved
deck.

## What the rules do

| Path | Read | Write |
|------|------|-------|
| `users/{uid}` | own account only | own account only |
| `leaderboard/{uid}` | public | own account only, signed-in trainers (not guests) |
| `games/{code}` | public (needed for resume / rejoin) | any signed-in identity, including anonymous guests |
| `decks/{folder}/{deck}` | public | any signed-in identity; a deck saved by a signed-in trainer can only be changed or deleted by that trainer |

Guests get a silent **anonymous** Firebase identity from the game page and the
deck builder, so the `auth != null` checks never get in their way.

## How to apply (one time, about two minutes)

1. Firebase console → **Authentication → Sign-in method** → enable
   **Anonymous**. (Email/Password stays enabled.)
2. Firebase console → **Realtime Database → Rules**.
3. Compare what is there with `database.rules.json`. The `users` and
   `leaderboard` sections were written to match the behaviour the database
   already showed (private users, public read-only leaderboard). If the console
   has something stricter for those, keep the console's version.
4. Paste the contents of `database.rules.json` and click **Publish**.
5. Load the game as a guest, create a room, and save a deck in the builder to
   confirm nothing is blocked.

Do step 1 before step 4. Without the Anonymous provider, guests have no
identity and every guest write would be refused once the rules are live.

## Known limitations (by design of a client-authoritative game)

- Game state, including both players' hands, is readable by anyone who knows
  the room code. A determined opponent could peek. Fixing this needs a server
  or Cloud Functions to deal cards.
- The resume list shows every game in the database, and any signed-in
  identity can push state into any room. Same root cause.
- Win/loss records are written by the client that finished the game, so the
  leaderboard is honour-system.
