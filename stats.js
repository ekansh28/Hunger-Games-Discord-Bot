// ============================================================
// stats.js — Persistent player statistics tracker (Neon PostgreSQL)
// ============================================================

'use strict';

const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// Configure Neon to use WebSockets
neonConfig.webSocketConstructor = ws;

// ── Configurable tracked words ───────────────────────────────
// We support an array of words to track. (Case-insensitive)
const TRACKED_WORDS = ['nigga', 'fag', 'penis'];

// ── Database Setup ───────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

let dbInitialized = false;

async function initDB() {
    if (dbInitialized) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_stats (
                guild_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                hg_wins INTEGER DEFAULT 0,
                br_wins INTEGER DEFAULT 0,
                infections_spread INTEGER DEFAULT 0,
                PRIMARY KEY (guild_id, user_id)
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS word_stats (
                guild_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                word VARCHAR(64) NOT NULL,
                total_count INTEGER DEFAULT 0,
                first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id, word)
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_word_stats_word_count 
            ON word_stats(word, total_count DESC);
        `);
        await pool.query(`
            ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS lastfm_user VARCHAR(64);
        `);
        await pool.query(`
            ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS boob_size INTEGER;
        `);
        await pool.query(`
            ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS gg_wins INTEGER DEFAULT 0;
        `);
        dbInitialized = true;
        console.log('[Stats] Neon PostgreSQL initialized.');
    } catch (err) {
        console.error('[Stats] Database initialization error:', err);
    }
}

// Ensure DB is initialized on startup if URL exists
if (process.env.DATABASE_URL) {
    initDB();
} else {
    console.warn('[Stats] WARNING: DATABASE_URL not set in environment.');
}

// ── Memory Caches & Anti-Spam State ──────────────────────────

// pendingUserStats: Map of `${guildId}:${userId}` -> { hgWins, brWins, infectionsSpread }
const pendingUserStats = new Map();

// pendingWordStats: Map of `${guildId}:${userId}:${word}` -> { count, firstSeen, lastSeen }
const pendingWordStats = new Map();

// Cooldown state for tracked words: `${userId}:${word}` -> timestamp ms
const userWordCooldowns = new Map();
const COOLDOWN_MS = 15000; // 15 seconds

// Duplicate message state: userId -> { content, timestamp }
const lastMessageState = new Map();
const DUPLICATE_MS = 30000; // 30 seconds

// ── In-Memory Helpers ────────────────────────────────────────

function getPendingUser(guildId, userId) {
    const key = `${guildId}:${userId}`;
    if (!pendingUserStats.has(key)) {
        pendingUserStats.set(key, { hgWins: 0, brWins: 0, infectionsSpread: 0, ggWins: 0 });
    }
    return pendingUserStats.get(key);
}

function getPendingWord(guildId, userId, word) {
    const key = `${guildId}:${userId}:${word}`;
    if (!pendingWordStats.has(key)) {
        pendingWordStats.set(key, { count: 0, firstSeen: new Date(), lastSeen: new Date() });
    }
    return pendingWordStats.get(key);
}

// ── Last.fm & Fun Stats ────────────────────────────────────────

async function getOrGenerateBoobSize(userId) {
    if (!process.env.DATABASE_URL || !dbInitialized) return Math.floor(Math.random() * 51);
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT boob_size FROM user_stats 
            WHERE user_id = $1 AND boob_size IS NOT NULL 
            LIMIT 1;
        `, [userId]);
        
        if (res.rows.length > 0 && res.rows[0].boob_size !== null) {
            return res.rows[0].boob_size;
        }

        const newSize = Math.floor(Math.random() * 51); // 0 to 50
        await client.query(`
            INSERT INTO user_stats (guild_id, user_id, boob_size)
            VALUES ('GLOBAL', $1, $2)
            ON CONFLICT (guild_id, user_id) DO UPDATE SET boob_size = EXCLUDED.boob_size;
        `, [userId, newSize]);

        return newSize;
    } catch (err) {
        console.error('[Stats] Error getting/generating boob size:', err);
        return Math.floor(Math.random() * 51);
    } finally {
        client.release();
    }
}

async function setLastFmUser(userId, username) {
    if (!process.env.DATABASE_URL || !dbInitialized) return;
    const client = await pool.connect();
    try {
        await client.query(`
            INSERT INTO user_stats (guild_id, user_id, lastfm_user)
            VALUES ('GLOBAL', $1, $2)
            ON CONFLICT (guild_id, user_id) DO UPDATE SET lastfm_user = EXCLUDED.lastfm_user;
        `, [userId, username]);
    } catch (err) {
        console.error('[Stats] Error setting lastfm user:', err);
    } finally {
        client.release();
    }
}

async function getLastFmUser(userId) {
    if (!process.env.DATABASE_URL || !dbInitialized) return null;
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT lastfm_user FROM user_stats 
            WHERE user_id = $1 AND lastfm_user IS NOT NULL 
            LIMIT 1;
        `, [userId]);
        return res.rows[0]?.lastfm_user || null;
    } catch (err) {
        console.error('[Stats] Error getting lastfm user:', err);
        return null;
    } finally {
        client.release();
    }
}

// ── Background Sync ─────────────────────────────────────────────

async function flushStats() {
    if (!process.env.DATABASE_URL || !dbInitialized) return;
    if (pendingUserStats.size === 0 && pendingWordStats.size === 0) return;

    const userEntries = Array.from(pendingUserStats.entries());
    const wordEntries = Array.from(pendingWordStats.entries());

    pendingUserStats.clear();
    pendingWordStats.clear();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Upsert user_stats
        for (const [key, data] of userEntries) {
            const [guildId, userId] = key.split(':');
            await client.query(`
                INSERT INTO user_stats (guild_id, user_id, hg_wins, br_wins, infections_spread, gg_wins)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (guild_id, user_id)
                DO UPDATE SET 
                    hg_wins = user_stats.hg_wins + EXCLUDED.hg_wins,
                    br_wins = user_stats.br_wins + EXCLUDED.br_wins,
                    infections_spread = user_stats.infections_spread + EXCLUDED.infections_spread,
                    gg_wins = user_stats.gg_wins + EXCLUDED.gg_wins
            `, [guildId, userId, data.hgWins, data.brWins, data.infectionsSpread, data.ggWins ?? 0]);
        }

        // Upsert word_stats
        for (const [key, data] of wordEntries) {
            const [guildId, userId, word] = key.split(':');
            await client.query(`
                INSERT INTO word_stats (guild_id, user_id, word, total_count, first_seen, last_seen)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (guild_id, user_id, word)
                DO UPDATE SET 
                    total_count = word_stats.total_count + EXCLUDED.total_count,
                    last_seen = EXCLUDED.last_seen
            `, [guildId, userId, word, data.count, data.firstSeen, data.lastSeen]);
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Stats] Error flushing stats:', err);
        // Put back the data into pending (simple merge to avoid overwriting new pending data)
        for (const [key, data] of userEntries) {
            const p = getPendingUser(...key.split(':'));
            p.hgWins += data.hgWins;
            p.brWins += data.brWins;
            p.infectionsSpread += data.infectionsSpread;
            p.ggWins = (p.ggWins || 0) + (data.ggWins || 0);
        }
        for (const [key, data] of wordEntries) {
            const parts = key.split(':');
            const p = getPendingWord(parts[0], parts[1], parts[2]);
            p.count += data.count;
            if (data.firstSeen < p.firstSeen) p.firstSeen = data.firstSeen;
            if (data.lastSeen > p.lastSeen) p.lastSeen = data.lastSeen;
        }
    } finally {
        client.release();
    }
}

// Flush every 30 seconds
setInterval(flushStats, 30000);

// Flush on process exit (best effort synchronous, or clean async shutdown)
process.on('SIGINT', async () => {
    console.log('[Stats] Gracefully shutting down, flushing stats...');
    await flushStats();
    await pool.end();
    process.exit(0);
});

// ── Public Increment Helpers ─────────────────────────────────
// These just add to the memory cache.

function addHgWin(guildId, userId) {
    if (!guildId || !userId) return;
    getPendingUser(guildId, userId).hgWins++;
}

function addGgWin(guildId, userId) {
    if (!guildId || !userId) return;
    getPendingUser(guildId, userId).ggWins++;
}

function addBrWin(guildId, userId) {
    if (!guildId || !userId) return;
    getPendingUser(guildId, userId).brWins++;
}

function addInfectionSpread(guildId, userId) {
    if (!guildId || !userId) return;
    getPendingUser(guildId, userId).infectionsSpread++;
}

// Internal function to add word count bypasses cooldowns (used by legacy or direct calls)
function addWordCount(guildId, userId, word, count = 1) {
    if (!guildId || !userId || !word) return;
    const pending = getPendingWord(guildId, userId, word.toLowerCase());
    pending.count += count;
    pending.lastSeen = new Date();
}

// ── Public Read Helpers (Async) ──────────────────────────────

async function getStats(guildId, userId) {
    let result = {
        hgWins: 0,
        brWins: 0,
        infectionsSpread: 0,
        ggWins: 0,
        words: {}
    };

    if (process.env.DATABASE_URL && dbInitialized) {
        try {
            const userRes = await pool.query(
                'SELECT hg_wins, br_wins, infections_spread, COALESCE(gg_wins, 0) as gg_wins FROM user_stats WHERE guild_id = $1 AND user_id = $2',
                [guildId, userId]
            );
            if (userRes.rows.length > 0) {
                result.hgWins = userRes.rows[0].hg_wins;
                result.brWins = userRes.rows[0].br_wins;
                result.infectionsSpread = userRes.rows[0].infections_spread;
                result.ggWins = userRes.rows[0].gg_wins;
            }

            const wordRes = await pool.query(
                'SELECT word, total_count, first_seen, last_seen FROM word_stats WHERE guild_id = $1 AND user_id = $2',
                [guildId, userId]
            );
            for (const row of wordRes.rows) {
                // Also fetch rank
                const rankRes = await pool.query(
                    'SELECT COUNT(*) + 1 as rank FROM word_stats WHERE guild_id = $1 AND word = $2 AND total_count > $3',
                    [guildId, row.word, row.total_count]
                );
                result.words[row.word] = {
                    count: row.total_count,
                    firstSeen: row.first_seen,
                    lastSeen: row.last_seen,
                    rank: parseInt(rankRes.rows[0].rank, 10)
                };
            }
        } catch (err) {
            console.error('[Stats] Error fetching stats:', err);
        }
    }

    // Overlay pending stats
    const uKey = `${guildId}:${userId}`;
    if (pendingUserStats.has(uKey)) {
        const p = pendingUserStats.get(uKey);
        result.hgWins += p.hgWins;
        result.brWins += p.brWins;
        result.infectionsSpread += p.infectionsSpread;
        result.ggWins += (p.ggWins || 0);
    }

    for (const [key, p] of pendingWordStats.entries()) {
        const [gId, uId, w] = key.split(':');
        if (gId === guildId && uId === userId) {
            if (!result.words[w]) {
                result.words[w] = { count: 0, firstSeen: p.firstSeen, lastSeen: p.lastSeen, rank: '?' };
            }
            result.words[w].count += p.count;
            if (p.lastSeen > result.words[w].lastSeen) result.words[w].lastSeen = p.lastSeen;
        }
    }

    return result;
}

async function getGgLeaderboard(guildId, limit = 10) {
    if (!process.env.DATABASE_URL || !dbInitialized) return [];
    try {
        const res = await pool.query(
            'SELECT user_id, COALESCE(gg_wins, 0) as gg_wins FROM user_stats WHERE guild_id = $1 AND COALESCE(gg_wins, 0) > 0 ORDER BY gg_wins DESC LIMIT $2',
            [guildId, limit]
        );
        return res.rows.map((row, idx) => ({
            userId: row.user_id,
            count: parseInt(row.gg_wins, 10),
            rank: idx + 1
        }));
    } catch (err) {
        console.error('[Stats] Error fetching GeoGuesser leaderboard:', err);
        return [];
    }
}

async function getLeaderboard(guildId, word, limit = 10) {
    if (!process.env.DATABASE_URL || !dbInitialized) return [];
    try {
        const res = await pool.query(
            'SELECT user_id, total_count FROM word_stats WHERE guild_id = $1 AND word = $2 ORDER BY total_count DESC LIMIT $3',
            [guildId, word.toLowerCase(), limit]
        );
        return res.rows.map((row, idx) => ({
            userId: row.user_id,
            count: row.total_count,
            rank: idx + 1
        }));
    } catch (err) {
        console.error('[Stats] Error fetching leaderboard:', err);
        return [];
    }
}

// ── Word Tracking: Call from messageCreate ───────────────────
// Returns an array of tracked words found and processed.
function trackMessage(guildId, userId, messageContent) {
    if (!guildId || !userId || !messageContent) return [];

    // Quality check: < 10 chars
    if (messageContent.length < 10) return [];

    // Quality check: < 3 words
    const tokens = messageContent.trim().split(/\s+/);
    if (tokens.length < 3) return [];

    const now = Date.now();

    // Duplicate message check
    const lastMsg = lastMessageState.get(userId);
    if (lastMsg && lastMsg.content === messageContent && (now - lastMsg.timestamp) < DUPLICATE_MS) {
        return []; // Ignore duplicate
    }
    lastMessageState.set(userId, { content: messageContent, timestamp: now });

    const processedWords = [];

    // Check for our tracked words
    const lowerContent = messageContent.toLowerCase();

    // Find unique words to avoid counting "donut donut" as +2
    const foundWords = new Set();
    for (const word of TRACKED_WORDS) {
        // Use word boundary regex to find exact matches
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        if (regex.test(lowerContent)) {
            foundWords.add(word);
        }
    }

    // Process each unique word found
    for (const word of foundWords) {
        const cdKey = `${userId}:${word}`;
        const lastUsed = userWordCooldowns.get(cdKey) || 0;

        // Cooldown check
        if (now - lastUsed >= COOLDOWN_MS) {
            addWordCount(guildId, userId, word, 1);
            userWordCooldowns.set(cdKey, now);
            processedWords.push(word);
        }
    }

    return processedWords;
}

// ── Admin Utilities ──────────────────────────────────────────

async function resetDatabase() {
    if (!process.env.DATABASE_URL || !dbInitialized) return;
    pendingUserStats.clear();
    pendingWordStats.clear();
    userWordCooldowns.clear();
    lastMessageState.clear();

    const client = await pool.connect();
    try {
        await client.query('TRUNCATE TABLE user_stats, word_stats');
        console.log('[Stats] Database truncated by admin.');
    } catch (err) {
        console.error('[Stats] Error resetting database:', err);
    } finally {
        client.release();
    }
}

module.exports = {
    TRACKED_WORDS,
    addHgWin,
    addBrWin,
    addGgWin,
    addInfectionSpread,
    addWordCount,
    getStats,
    getLeaderboard,
    getGgLeaderboard,
    trackMessage,
    resetDatabase,
    setLastFmUser,
    getLastFmUser,
    getOrGenerateBoobSize,
    pool,
    flushStats
};
