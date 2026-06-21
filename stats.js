// ============================================================
// stats.js — Persistent player statistics tracker
//
// Tracks per-user:
//   - Hunger Games wins
//   - Ban Roulette wins
//   - Number of people they have infected (AIDS)
//   - Count of a configurable tracked word
//
// Data is stored in stats.json alongside the other JSON files.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'stats.json');

// ── Configurable tracked word ────────────────────────────────
// Change this to whatever word you want to track (case-insensitive).
const TRACKED_WORD = 'nigga';

// ── Data shape ───────────────────────────────────────────────
// {
//   "<guildId>": {
//     "<userId>": {
//       hgWins:       number,
//       brWins:       number,
//       infectionsSpread: number,
//       wordCount:    number,
//     }
//   }
// }

let data = {};

function load() {
    try {
        data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    } catch {
        data = {};
    }
}

function save() {
    try {
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('[Stats] Failed to save stats.json:', err);
    }
}

load();

// ── Internal getter — creates record on demand ───────────────
function getRecord(guildId, userId) {
    if (!data[guildId]) data[guildId] = {};
    if (!data[guildId][userId]) {
        data[guildId][userId] = {
            hgWins: 0,
            brWins: 0,
            infectionsSpread: 0,
            wordCount: 0,
        };
    }
    // Backfill missing fields for older records
    const r = data[guildId][userId];
    if (r.hgWins           == null) r.hgWins = 0;
    if (r.brWins           == null) r.brWins = 0;
    if (r.infectionsSpread == null) r.infectionsSpread = 0;
    if (r.wordCount        == null) r.wordCount = 0;
    return r;
}

// ── Public increment helpers ─────────────────────────────────

function addHgWin(guildId, userId) {
    if (!guildId || !userId) return;
    getRecord(guildId, userId).hgWins++;
    save();
}

function addBrWin(guildId, userId) {
    if (!guildId || !userId) return;
    getRecord(guildId, userId).brWins++;
    save();
}

function addInfectionSpread(guildId, userId) {
    if (!guildId || !userId) return;
    getRecord(guildId, userId).infectionsSpread++;
    save();
}

function addWordCount(guildId, userId, count = 1) {
    if (!guildId || !userId) return;
    getRecord(guildId, userId).wordCount += count;
    save();
}

// ── Public read helper ───────────────────────────────────────

function getStats(guildId, userId) {
    return { ...getRecord(guildId, userId) };
}

// ── Word tracking: call this from messageCreate ──────────────
// Returns how many times the tracked word appeared in this message.
function trackMessage(guildId, userId, messageContent) {
    if (!guildId || !userId || !messageContent) return 0;
    const regex = new RegExp(`\\b${TRACKED_WORD}\\b`, 'gi');
    const matches = messageContent.match(regex);
    if (matches && matches.length > 0) {
        addWordCount(guildId, userId, matches.length);
        return matches.length;
    }
    return 0;
}

module.exports = {
    TRACKED_WORD,
    addHgWin,
    addBrWin,
    addInfectionSpread,
    addWordCount,
    getStats,
    trackMessage,
};
