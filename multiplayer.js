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
  query, where, limit, getDocs, onSnapshot, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { SHIPS_PER_PLAYER } from "./ship-shapes.js";

const LOBBY = "lobby";
const GAMES = "games";

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
    pendingShot: null,
    hits: {},           // hits[defenderUid]["r,c"] = "miss" | "hit" | "head"
    destroyedCount: {}, // destroyedCount[uid] = number of that player's planes destroyed
    winner: null,
    password,
    createdAt: serverTimestamp(),
  });
}

/** Saves my ship placement privately and marks me ready. */
export async function submitShipPlacement(gameId, uid, ships) {
  await setDoc(doc(db, GAMES, gameId, "private", uid), { ships });
  const gameRef = doc(db, GAMES, gameId);
  await updateDoc(gameRef, { [`ready.${uid}`]: true });
}

/** Subscribes to the shared game document. Calls back on every change. */
export function listenToGame(gameId, callback) {
  return onSnapshot(doc(db, GAMES, gameId), (snap) => {
    if (snap.exists()) callback(snap.data());
  });
}

/** Fires a shot at the opponent (only valid on your turn). */
export async function fireShot(gameId, myUid, row, col) {
  await updateDoc(doc(db, GAMES, gameId), {
    pendingShot: { by: myUid, row, col },
  });
}

/**
 * Called on the DEFENDING player's client whenever the game doc shows a
 * pendingShot aimed at them. Resolves it (hit/miss/head), updates the shared
 * doc, checks for a win, and passes the turn back to the shooter.
 */
export async function resolvePendingShotIfMine(gameId, myUid, gameData) {
  const shot = gameData.pendingShot;
  if (!shot || shot.by === myUid) return; // not aimed at me, or nothing pending

  const privateSnap = await getDoc(doc(db, GAMES, gameId, "private", myUid));
  const myShips = privateSnap.data().ships; // array of { cells: [[r,c],...10], headCell:[r,c], destroyed:bool }

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

  await setDoc(doc(db, GAMES, gameId, "private", myUid), { ships: updatedShips });
  await updateDoc(doc(db, GAMES, gameId), {
    [`hits.${myUid}.${shot.row},${shot.col}`]: result,
    [`destroyedCount.${myUid}`]: destroyedCount,
    pendingShot: null,
    turn: shot.by,
    status: iLost ? "finished" : "playing",
    winner: iLost ? shot.by : null,
  });
}
