const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS custom_viruses (
            role_id VARCHAR(50) PRIMARY KEY,
            guild_id VARCHAR(50) NOT NULL,
            name VARCHAR(100) NOT NULL,
            color VARCHAR(20) NOT NULL,
            owner_id VARCHAR(50) NOT NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS infections (
            guild_id VARCHAR(50) NOT NULL,
            user_id VARCHAR(50) NOT NULL,
            virus_id VARCHAR(50),
            infected_by VARCHAR(50),
            timestamp BIGINT NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        )
    `);
}

module.exports = { pool, initDB };
