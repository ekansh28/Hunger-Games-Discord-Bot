// ============================================================
// infection.js — "Virus" mini-game tracker
//
// =infect  : infects yourself, announces it in chat, spreads
//            automatically whenever an infected user pings someone.
// =cure    : (authorized hosts only) cures yourself, a mentioned
//            user, or everyone ("=cure all").
//
// Infected users get role VIRUS_ROLE_ID and " (HAS VIRUS)" appended
// to their server nickname. State is persisted to infected.json so
// it survives bot restarts.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');

const DATA_PATH = path.join(__dirname, 'infected.json');

const VIRUS_ROLE_ID = '1516529671855018004';
const IMMUNE_ROLE_IDS = ['1482031013738709277', '1482030917420712117'];
const SUFFIX = ' (HAS AIDS)';

// Shape on disk: { "<guildId>": { "<userId>": { "originalNickname": string|null } } }
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
        console.error('[Virus] Failed to save infected.json:', err);
    }
}

load();

function isImmune(member) {
    if (!member || !member.roles || !member.roles.cache) return false;
    return IMMUNE_ROLE_IDS.some(id => member.roles.cache.has(id));
}

function isInfected(guildId, userId) {
    return !!(data[guildId] && data[guildId][userId]);
}

function getInfectedIds(guildId) {
    return data[guildId] ? Object.keys(data[guildId]) : [];
}

function markInfected(guildId, userId, originalNickname) {
    if (!data[guildId]) data[guildId] = {};
    data[guildId][userId] = { originalNickname: originalNickname ?? null };
    save();
}

function markCured(guildId, userId) {
    if (data[guildId]) {
        delete data[guildId][userId];
        if (Object.keys(data[guildId]).length === 0) delete data[guildId];
    }
    save();
}

// ── Infect a member: add role + append nickname suffix ───────
async function applyInfection(member) {
    const guildId = member.guild.id;
    const userId = member.user.id;
    if (isInfected(guildId, userId)) return false; // already infected
    if (isImmune(member)) return false;             // immune role

    const originalNickname = member.nickname ?? null;
    markInfected(guildId, userId, originalNickname);

    try {
        const base = member.displayName || member.user.username;
        let newNick = `${base}${SUFFIX}`;
        if (newNick.length > 32) newNick = `${base.slice(0, 32 - SUFFIX.length)}${SUFFIX}`;
        await member.setNickname(newNick, 'HAS AIDS');
    } catch (err) {
        console.error(`[Virus] Failed to set nickname for ${userId}:`, err?.message || err);
    }

    try {
        const guild = member.guild;
        const role = guild.roles.cache.get(VIRUS_ROLE_ID);
        if (role) {
            const botMember = guild.members.me;
            if (botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
                role.comparePositionTo(botMember.roles.highest) < 0) {
                await member.roles.add(role, 'GOT AIDS');
            }
        }
    } catch (err) {
        console.error(`[Virus] Failed to add role to ${userId}:`, err?.message || err);
    }

    return true;
}

// ── Cure a member: remove role + restore original nickname ───
async function removeInfection(member) {
    const guildId = member.guild.id;
    const userId = member.user.id;
    if (!isInfected(guildId, userId)) return false;

    const record = data[guildId][userId];

    try {
        await member.setNickname(record.originalNickname ?? null, 'Cured from AIDS');
    } catch (err) {
        console.error(`[Virus] Failed to restore nickname for ${userId}:`, err?.message || err);
    }

    try {
        const guild = member.guild;
        const role = guild.roles.cache.get(VIRUS_ROLE_ID);
        if (role && member.roles.cache.has(role.id)) {
            const botMember = guild.members.me;
            if (botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
                role.comparePositionTo(botMember.roles.highest) < 0) {
                await member.roles.remove(role, 'Cured from AIDS');
            }
        }
    } catch (err) {
        console.error(`[Virus] Failed to remove role from ${userId}:`, err?.message || err);
    }

    markCured(guildId, userId);
    return true;
}

module.exports = {
    VIRUS_ROLE_ID,
    IMMUNE_ROLE_IDS,
    isImmune,
    isInfected,
    getInfectedIds,
    markCured,
    applyInfection,
    removeInfection,
};
