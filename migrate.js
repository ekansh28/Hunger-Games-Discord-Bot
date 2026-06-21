require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./stats');

async function migrate() {
    console.log('Starting migration from stats.json to Neon PostgreSQL...');
    
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set. Cannot migrate.');
        process.exit(1);
    }
    
    const dataPath = path.join(__dirname, 'stats.json');
    if (!fs.existsSync(dataPath)) {
        console.log('stats.json not found. Nothing to migrate.');
        process.exit(0);
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    } catch (err) {
        console.error('Error reading stats.json:', err);
        process.exit(1);
    }

    let userCount = 0;
    
    const client = await pool.connect();
    try {
        // Ensure tables exist before migrating
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_stats (
                guild_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                hg_wins INTEGER DEFAULT 0,
                br_wins INTEGER DEFAULT 0,
                infections_spread INTEGER DEFAULT 0,
                PRIMARY KEY (guild_id, user_id)
            );
        `);
        await client.query(`
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
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_word_stats_word_count 
            ON word_stats(word, total_count DESC);
        `);

        await client.query('BEGIN');
        
        for (const guildId in data) {
            for (const userId in data[guildId]) {
                const record = data[guildId][userId];
                
                // Migrate user_stats
                await client.query(`
                    INSERT INTO user_stats (guild_id, user_id, hg_wins, br_wins, infections_spread)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (guild_id, user_id)
                    DO UPDATE SET 
                        hg_wins = EXCLUDED.hg_wins,
                        br_wins = EXCLUDED.br_wins,
                        infections_spread = EXCLUDED.infections_spread
                `, [guildId, userId, record.hgWins || 0, record.brWins || 0, record.infectionsSpread || 0]);
                
                // Migrate word_stats (the old system only tracked 'nigga')
                if (record.wordCount > 0) {
                    await client.query(`
                        INSERT INTO word_stats (guild_id, user_id, word, total_count)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (guild_id, user_id, word)
                        DO UPDATE SET 
                            total_count = EXCLUDED.total_count
                    `, [guildId, userId, 'nigga', record.wordCount]);
                }
                
                userCount++;
            }
        }
        
        await client.query('COMMIT');
        console.log(`Successfully migrated ${userCount} user records.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
