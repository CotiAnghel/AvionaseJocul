// multiplayer.js
// Handles matchmaking (quick match queue), private rooms (with optional
// password), and real-time move sync via Firestore.
//
// IMPORTANT ARCHITECTURE NOTE:
// Ship positions are written to a PRIVATE subcollection
// (games/{gameId}/private/{uid}) that Firestore security rules restrict to
// "only readable by request.auth.uid == uid" (see README.md for the rules).
// This is what stops the opponent's client from just reading your ship
// placement straight out of the database. Everything else (whose turn it is,
// hit/miss/head marks) lives on the shared game document, since that's
// exactly the information a human opponent would legitimately see anyway.
//
// Because there is no server function computing shot results, the DEFENDING
// player's own client is the one that resolves incoming shots (it reads its
// own private ship list, figures out hit/miss/head, and writes the result
// back). This means both players need to be online during a match.

import { db } from "./firebase-init.js";
import {
  collection, doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc,
  query, where, limit, orderBy, getDocs, onSnapshot, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { SHIPS_PER_PLAYER } from "./ship-shapes.js";

const LOBBY = "lobby";
const GAMES = "games";

// How long a player has to make a move before the turn auto-passes.
export const TURN_TIME_LIMIT_MS = 30000;

// Firestore rejects nested arrays (an array of [r,c] arrays), so ship data is
// converted to/from {r,c} objects right at the Firestore boundary. Every
// other module keeps using plain [r,c] tuples internally.
function serializeShips(ships) {
  return ships.map((s) => ({
    cells: s.cells.map(([r, c]) => ({ r, c })),
    headCell: { r: s.headCell[0], c: s.headCell[1] },
    destroyed: !!s.destroyed,
  }));
}

function deserializeShips(ships) {
  return ships.map((s) => ({
    cells: s.cells.map((p) => [p.r, p.c]),
    headCell: [s.headCell.r, s.headCell.c],
    destroyed: !!s.destroyed,
  }));
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/** Quick match: pair with any other waiting player, or wait to be matched. */
export async function quickMatch(uid, name, onMatched) {
  const q = query(collection(db, LOBBY), where("status", "==", "waiting"), limit(5));
  const snap = await getDocs(q);
  const candidate = snap.docs.find((d) => d.data().uid !== uid);

  if (candidate) {
    // Try to claim this waiting player inside a transaction (avoids two
    // players grabbing the same opponent at once).
    const gameId = roomCode();
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, LOBBY, candidate.id);
        const fresh = await tx.get(ref);
        if (fresh.data().status !== "waiting") throw new Error("already-taken");
        tx.update(ref, { status: "matched", gameId });
      });
      await createGameDoc(gameId, [
        { uid: candidate.data().uid, name: candidate.data().name },
        { uid, name },
      ]);
      onMatched(gameId);
      return;
    } catch (e) {
      // fall through to waiting below if the transaction lost the race
    }
  }

  // No one available (or lost the race) — post ourselves and wait.
  const myRef = doc(collection(db, LOBBY));
  await setDoc(myRef, { uid, name, status: "waiting", createdAt: serverTimestamp() });
  const unsub = onSnapshot(myRef, (snap) => {
    const data = snap.data();
    if (data && data.status === "matched" && data.gameId) {
      unsub();
      deleteDoc(myRef).catch(() => {});
      onMatched(data.gameId);
    }
  });
  return () => { unsub(); deleteDoc(myRef).catch(() => {}); }; // cancel handle
}

/** Creates a private room with a room code + optional password. Returns the code. */
export async function createPrivateRoom(uid, name, password) {
  const gameId = roomCode();
  await createGameDoc(gameId, [{ uid, name }], password || null);
  return gameId;
}

/** Joins an existing private room by code (+ password if it has one). */
export async function joinPrivateRoom(gameId, uid, name, password) {
  const ref = doc(db, GAMES, gameId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Camera nu exista.");
  const data = snap.data();
  if (data.password && data.password !== password) throw new Error("Parola gresita.");
  if (data.order.length >= 2) throw new Error("Camera este deja plina.");

  await updateDoc(ref, {
    [`players.${uid}`]: { name },
    order: [...data.order, uid],
    status: "placing",
  });
  return gameId;
}

async function createGameDoc(gameId, players, password = null) {
  const ref = doc(db, GAMES, gameId);
  const playersMap = {};
  for (const p of players) playersMap[p.uid] = { name: p.name };

  await setDoc(ref, {
    players: playersMap,
    order: players.map((p) => p.uid),
    status: players.length === 2 ? "placing" : "waiting-for-opponent",
    ready: {},
    turn: players[0].uid,
    turnStartedAt: serverTimestamp(),
    pendingShot: null,
    hits: {},           // hits[defenderUid]["r,c"] = "miss" | "hit" | "head"
    destroyedCount: {}, // destroyedCount[uid] = number of that player's planes destroyed
    winner: null,
    endReason: null, // "destroyed" | "left" — set once the game finishes
    password,
    createdAt: serverTimestamp(),
  });
}

/** Saves my ship placement privately and marks me ready. */
export async function submitShipPlacement(gameId, uid, ships) {
  await setDoc(doc(db, GAMES, gameId, "private", uid), { ships: serializeShips(ships) });
  const gameRef = doc(db, GAMES, gameId);
  await updateDoc(gameRef, { [`ready.${uid}`]: true });

  // If everyone is now ready, flip the game from "placing" to "playing" and
  // pick a random starting player. A transaction keeps two clients racing to
  // do this at the same moment from double-flipping it.
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef);
    const data = snap.data();
    if (data.status === "playing" || data.status === "finished") return;
    if (data.order.length !== 2) return; // still waiting for a second player

    const allReady = data.order.every((playerUid) => playerUid === uid || data.ready?.[playerUid]);
    if (allReady) {
      const startingPlayer = data.order[Math.floor(Math.random() * data.order.length)];
      tx.update(gameRef, { status: "playing", turn: startingPlayer, turnStartedAt: serverTimestamp() });
    }
  });
}

/** Subscribes to the shared game document. Calls back on every change. */
export function listenToGame(gameId, callback) {
  return onSnapshot(
    doc(db, GAMES, gameId),
    (snap) => { if (snap.exists()) callback(snap.data()); },
    (error) => {
      // Surfaces connection issues (e.g. a browser extension blocking
      // Firestore's realtime channel) instead of failing silently.
      console.error("Game listener error (realtime sync may be blocked):", error);
    },
  );
}

/**
 * One-off manual fetch of the current game state — a fallback for when the
 * live listener's connection has been interrupted (e.g. by a browser
 * extension blocking Firestore's realtime channel) and isn't delivering
 * fresh updates.
 */
export async function fetchGameOnce(gameId) {
  const snap = await getDoc(doc(db, GAMES, gameId));
  return snap.exists() ? snap.data() : null;
}

/**
 * If the current player's time to move has run out, passes the turn to the
 * other player. Safe to call from either client — a transaction with a
 * freshness re-check keeps it from double-firing.
 */
export async function expireTurnIfNeeded(gameId, data) {
  if (data.status !== "playing" || !data.turn || !data.turnStartedAt?.toMillis) return;
  if (Date.now() - data.turnStartedAt.toMillis() < TURN_TIME_LIMIT_MS) return;

  const ref = doc(db, GAMES, gameId);
  const timedOutUid = data.turn;
  const nextUid = data.order.find((u) => u !== timedOutUid);
  if (!nextUid) return;

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const fresh = snap.data();
      if (!fresh || fresh.status !== "playing" || fresh.turn !== timedOutUid) return; // already changed
      if (!fresh.turnStartedAt?.toMillis) return;
      if (Date.now() - fresh.turnStartedAt.toMillis() < TURN_TIME_LIMIT_MS) return;
      tx.update(ref, { turn: nextUid, turnStartedAt: serverTimestamp(), pendingShot: null });
    });
  } catch (e) {
    // best effort — the other client (or the next tick) will catch it
  }
}

/** Fires a shot at the opponent (only valid on your turn, and only if no shot is already pending). */
export async function fireShot(gameId, myUid, row, col) {
  const gameRef = doc(db, GAMES, gameId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef);
    const data = snap.data();
    if (data.turn !== myUid) throw new Error("Nu e randul tau.");
    if (data.pendingShot) throw new Error("Lovitura anterioara nu a fost inca rezolvata.");
    tx.update(gameRef, { pendingShot: { by: myUid, row, col } });
  });
}

/**
 * Called on the DEFENDING player's client whenever the game doc shows a
 * pendingShot aimed at them. Resolves it (hit/miss/head), updates the shared
 * doc, checks for a win, and passes the turn back to the shooter.
 */
export async function resolvePendingShotIfMine(gameId, myUid, gameData) {
  const shot = gameData.pendingShot;
  if (!shot || shot.by === myUid) return null; // not aimed at me, or nothing pending — nothing changed

  const privateSnap = await getDoc(doc(db, GAMES, gameId, "private", myUid));
  const myShips = deserializeShips(privateSnap.data().ships); // {r,c} objects -> [r,c] tuples

  let result = "miss";
  let updatedShips = myShips;
  // Include already-destroyed planes: any of their remaining cells should
  // still register as a "hit", not a miss, if fired at again.
  const hitShip = myShips.find((s) => s.cells.some(([r, c]) => r === shot.row && c === shot.col));

  if (hitShip) {
    const isHead = hitShip.headCell[0] === shot.row && hitShip.headCell[1] === shot.col;
    result = isHead ? "head" : "hit";
    if (isHead) {
      updatedShips = myShips.map((s) => (s === hitShip ? { ...s, destroyed: true } : s));
    }
  }

  const destroyedCount = updatedShips.filter((s) => s.destroyed).length;
  const iLost = destroyedCount >= SHIPS_PER_PLAYER;

  const updates = {
    hits: { ...gameData.hits, [myUid]: { ...(gameData.hits?.[myUid] || {}), [`${shot.row},${shot.col}`]: result } },
    destroyedCount: { ...gameData.destroyedCount, [myUid]: destroyedCount },
    pendingShot: null,
    turn: myUid, // pass the turn to whoever just got shot at — they attack next
    status: iLost ? "finished" : "playing",
    winner: iLost ? shot.by : null,
    endReason: iLost ? "destroyed" : null,
  };

  await setDoc(doc(db, GAMES, gameId, "private", myUid), { ships: serializeShips(updatedShips) });
  await updateDoc(doc(db, GAMES, gameId), { ...updates, turnStartedAt: serverTimestamp() });

  // Return the up-to-date state (with an approximate turnStartedAt for
  // immediate local rendering) so the caller doesn't render the stale
  // pre-write data — that's what caused the losing player's screen to look
  // frozen on "waiting for opponent" right at the moment they actually lost.
  return { ...gameData, ...updates, turnStartedAt: { toMillis: () => Date.now() } };
}

/**
 * Called when a player deliberately quits/abandons a match that hasn't
 * finished yet — the opponent is declared the winner by forfeit.
 */
export async function forfeitGame(gameId, myUid, opponentUid) {
  await updateDoc(doc(db, GAMES, gameId), {
    status: "finished",
    winner: opponentUid,
    endReason: "left",
    pendingShot: null,
  });
}

/**
 * Called when a player backs out during ship placement (before the game has
 * actually started). Marks the game as abandoned so the other player (who
 * may still be placing ships, or waiting) finds out instead of being stuck
 * forever with an opponent who never shows up.
 */
export async function abandonDuringPlacement(gameId, uid) {
  const ref = doc(db, GAMES, gameId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data || data.status === "playing" || data.status === "finished" || data.status === "abandoned") return;
      tx.update(ref, { status: "abandoned", abandonedBy: uid });
    });
  } catch (e) {
    // best effort — if this fails, the other player can still leave manually
  }
}

// ---------- PRESENCE (online player count) ----------
const PRESENCE = "presence";
const ONLINE_WINDOW_MS = 60000; // considered "online" if a heartbeat landed in the last 60s

/** Writes/refreshes this player's presence heartbeat, along with what they're currently doing. */
export async function heartbeatPresence(uid, name, status = "idle") {
  await setDoc(doc(db, PRESENCE, uid), { name, status, lastSeen: serverTimestamp() });
}

/** Live breakdown: how many players are online total, searching for a match, and in an active game. */
export function listenOnlineCount(callback) {
  return onSnapshot(collection(db, PRESENCE), (snap) => {
    const now = Date.now();
    let online = 0, searching = 0, inGame = 0;
    snap.docs.forEach((d) => {
      const data = d.data();
      const ts = data.lastSeen;
      if (!ts || typeof ts.toMillis !== "function") return;
      if (now - ts.toMillis() >= ONLINE_WINDOW_MS) return;
      online++;
      if (data.status === "searching") searching++;
      else if (data.status === "placing" || data.status === "playing") inGame++;
    });
    callback({ online, searching, inGame });
  });
}

// ---------- GLOBAL CHAT (mIRC-style) ----------
const CHAT = "chat";

/** Live feed of the last 50 chat messages, oldest first. */
export function listenChat(callback) {
  const q = query(collection(db, CHAT), orderBy("createdAt", "desc"), limit(50));
  return onSnapshot(q, (snap) => {
    const messages = snap.docs.map((d) => d.data()).reverse();
    callback(messages);
  });
}

export async function sendChatMessage(uid, name, text) {
  const trimmed = text.trim().slice(0, 200);
  if (!trimmed) return;
  await addDoc(collection(db, CHAT), { uid, name, text: trimmed, createdAt: serverTimestamp() });
}

// ---------- TOURNAMENTS ----------
const TOURNAMENTS = "tournaments";
const TOURNAMENT_QUEUE_META = "tournamentQueueMeta";
const TOURNAMENT_ASSIGNMENT = "tournamentAssignment";
export const TOURNAMENT_SIZES = [4, 8, 16];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildTournamentRound(playerList) {
  const matches = [];
  for (let i = 0; i < playerList.length; i += 2) {
    const p1 = playerList[i], p2 = playerList[i + 1];
    matches.push({
      player1: p1.uid, player1Name: p1.name,
      player2: p2.uid, player2Name: p2.name,
      winner: null,
      gameId: `T${roomCode()}`,
    });
  }
  return matches;
}

function buildTournamentMatchGameDoc(match, tournamentId, round, matchIndex) {
  return {
    players: { [match.player1]: { name: match.player1Name }, [match.player2]: { name: match.player2Name } },
    order: [match.player1, match.player2],
    status: "placing",
    ready: {},
    turn: match.player1,
    turnStartedAt: serverTimestamp(),
    pendingShot: null,
    hits: {},
    destroyedCount: {},
    winner: null,
    endReason: null,
    password: null,
    createdAt: serverTimestamp(),
    tournamentId,
    round,
    matchIndex,
  };
}

/**
 * Joins the queue for a tournament of the given size (4/8/16). Once enough
 * players have queued, whichever client's join happens to fill the queue
 * forms the tournament, seeds round 1, and notifies every selected player
 * via their own tournamentAssignment doc (so the OTHER players who were
 * already waiting find out too).
 */
export async function joinTournamentQueue(uid, name, size) {
  const metaRef = doc(db, TOURNAMENT_QUEUE_META, String(size));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(metaRef);
    const data = snap.exists() ? snap.data() : { members: [] };
    let members = data.members || [];
    if (!members.find((m) => m.uid === uid)) members = [...members, { uid, name }];

    if (members.length >= size) {
      const selected = members.slice(0, size);
      const remaining = members.slice(size);
      const shuffled = shuffle(selected);
      const matches = buildTournamentRound(shuffled);
      const tournamentId = `T${roomCode()}`;

      tx.set(doc(db, TOURNAMENTS, tournamentId), {
        size,
        status: "active",
        players: shuffled,
        rounds: [{ matches }],
        champion: null,
        createdAt: serverTimestamp(),
      });
      matches.forEach((m, idx) => {
        tx.set(doc(db, GAMES, m.gameId), buildTournamentMatchGameDoc(m, tournamentId, 0, idx));
      });
      selected.forEach((p) => {
        tx.set(doc(db, TOURNAMENT_ASSIGNMENT, p.uid), { tournamentId, ts: serverTimestamp() });
      });
      tx.set(metaRef, { members: remaining });
    } else {
      tx.set(metaRef, { members });
    }
  });
}

export async function leaveTournamentQueue(uid, size) {
  const metaRef = doc(db, TOURNAMENT_QUEUE_META, String(size));
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(metaRef);
      if (!snap.exists()) return;
      const members = (snap.data().members || []).filter((m) => m.uid !== uid);
      tx.set(metaRef, { members });
    });
  } catch (e) { /* best effort */ }
}

/** Live queue sizes for all three tournament formats at once. */
export function listenTournamentQueueCounts(callback) {
  const counts = {};
  TOURNAMENT_SIZES.forEach((s) => { counts[s] = 0; });
  const unsubs = TOURNAMENT_SIZES.map((size) =>
    onSnapshot(doc(db, TOURNAMENT_QUEUE_META, String(size)), (snap) => {
      counts[size] = snap.exists() ? (snap.data().members || []).length : 0;
      callback({ ...counts });
    })
  );
  return () => unsubs.forEach((u) => u());
}

/** Notifies a queued (waiting) player once a tournament has formed around them. */
export function listenTournamentAssignment(uid, callback) {
  return onSnapshot(doc(db, TOURNAMENT_ASSIGNMENT, uid), (snap) => {
    if (snap.exists()) callback(snap.data());
  });
}

export function listenTournament(tournamentId, callback) {
  return onSnapshot(doc(db, TOURNAMENTS, tournamentId), (snap) => {
    if (snap.exists()) callback(snap.data());
  });
}

/**
 * Records a finished match's winner in the bracket, and — if that completes
 * the round — seeds the next round (or crowns the champion, if it was the
 * final). Safe to call from both players' clients: the transaction's
 * "already recorded" check keeps it from double-applying.
 */
export async function advanceTournamentIfNeeded(tournamentId, round, matchIndex, winnerUid) {
  const ref = doc(db, TOURNAMENTS, tournamentId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data || data.status === "finished") return;

      const rounds = data.rounds.map((r) => ({ matches: r.matches.map((m) => ({ ...m })) }));
      const match = rounds[round]?.matches?.[matchIndex];
      if (!match || match.winner) return; // already recorded, or bad reference

      match.winner = winnerUid;
      const roundComplete = rounds[round].matches.every((m) => m.winner);

      if (!roundComplete) {
        tx.update(ref, { rounds });
        return;
      }

      const totalRounds = Math.log2(data.size);
      if (round === totalRounds - 1) {
        tx.update(ref, { rounds, status: "finished", champion: winnerUid });
        return;
      }

      const winners = rounds[round].matches.map((m) => ({
        uid: m.winner,
        name: m.winner === m.player1 ? m.player1Name : m.player2Name,
      }));
      const nextMatches = buildTournamentRound(winners);
      nextMatches.forEach((m, idx) => {
        tx.set(doc(db, GAMES, m.gameId), buildTournamentMatchGameDoc(m, tournamentId, round + 1, idx));
      });
      rounds[round + 1] = { matches: nextMatches };
      tx.update(ref, { rounds });
    });
  } catch (e) {
    // best effort — the other finalist's client (or a later retry) will catch it
  }
}
