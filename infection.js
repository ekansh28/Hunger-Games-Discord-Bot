// ============================================================
// infection.js — "Virus" mini-game tracker
//
// =infect         : infects yourself; spreads via pings
// =cure           : (authorized) cure self / mentioned / "all"
// =infectioninfo  : detailed outbreak report embed
//   aliases: =virusinfo =outbreakstats =infected =infstats
//            =infstat =vstat =vs
//
// Infected users get VIRUS_ROLE_ID + " (HAS VIRUS)" nickname suffix.
// State persists to infected.json across restarts.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const { PermissionsBitField, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { isAuthorized } = require('./authorization');
const { generateBanner } = require('./infectionBanner');
const { generateTree }   = require('./infectionTree');

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────
const DATA_PATH    = path.join(__dirname, 'infected.json');
const VIRUS_ROLE_ID   = '1516529671855018004';
const IMMUNE_ROLE_IDS = ['1482031013738709277', '1482030917420712117'];
const SUFFIX          = ' (HAS VIRUS)';

const INFO_ALIASES = new Set([
    'infectioninfo', 'virusinfo', 'outbreakstats',
    'infected', 'infstats', 'infstat', 'vstat', 'vs',
]);

const TREE_ALIASES = new Set(['infectiontree', 'it']);

// ─────────────────────────────────────────────────────────────
//  Persistence
// ─────────────────────────────────────────────────────────────
// Shape: { "<guildId>": { "<userId>": { "originalNickname": string|null } } }
let data = {};

function load() {
    try { data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
    catch { data = {}; }
}

function save() {
    try { fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2)); }
    catch (err) { console.error('[Virus] Failed to save infected.json:', err); }
}

load();

// ─────────────────────────────────────────────────────────────
//  Core helpers
// ─────────────────────────────────────────────────────────────
function isImmune(member) {
    if (!member?.roles?.cache) return false;
    return IMMUNE_ROLE_IDS.some(id => member.roles.cache.has(id));
}

function isInfected(guildId, userId) {
    return !!(data[guildId]?.[userId]);
}

function getInfectedIds(guildId) {
    return data[guildId] ? Object.keys(data[guildId]) : [];
}

function markInfected(guildId, userId, originalNickname, infectedBy = null) {
    if (!data[guildId]) data[guildId] = {};
    data[guildId][userId] = {
        originalNickname: originalNickname ?? null,
        infectedBy:       infectedBy ?? null,
        timestamp:        Date.now(),
    };
    save();
}

function markCured(guildId, userId) {
    if (data[guildId]) {
        delete data[guildId][userId];
        if (!Object.keys(data[guildId]).length) delete data[guildId];
    }
    save();
}

// ─────────────────────────────────────────────────────────────
//  Infect / cure
// ─────────────────────────────────────────────────────────────
async function applyInfection(member, infectedBy = null) {
    const { id: guildId } = member.guild;
    const { id: userId }  = member.user;
    if (isInfected(guildId, userId)) return false;
    if (isImmune(member))            return false;

    const originalNickname = member.nickname ?? null;
    markInfected(guildId, userId, originalNickname, infectedBy);

    try {
        const base    = member.displayName || member.user.username;
        let   newNick = `${base}${SUFFIX}`;
        if (newNick.length > 32) newNick = `${base.slice(0, 32 - SUFFIX.length)}${SUFFIX}`;
        await member.setNickname(newNick, 'HAS VIRUS');
    } catch (err) {
        console.error(`[Virus] setNickname failed for ${userId}:`, err?.message || err);
    }

    try {
        const role = member.guild.roles.cache.get(VIRUS_ROLE_ID);
        if (role) {
            const bot = member.guild.members.me;
            if (bot.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
                role.comparePositionTo(bot.roles.highest) < 0) {
                await member.roles.add(role, 'GOT VIRUS');
            }
        }
    } catch (err) {
        console.error(`[Virus] add role failed for ${userId}:`, err?.message || err);
    }

    return true;
}

async function removeInfection(member) {
    const { id: guildId } = member.guild;
    const { id: userId }  = member.user;
    if (!isInfected(guildId, userId)) return false;

    const record = data[guildId][userId];

    try {
        await member.setNickname(record.originalNickname ?? null, 'Cured from VIRUS');
    } catch (err) {
        console.error(`[Virus] restore nickname failed for ${userId}:`, err?.message || err);
    }

    try {
        const role = member.guild.roles.cache.get(VIRUS_ROLE_ID);
        if (role && member.roles.cache.has(role.id)) {
            const bot = member.guild.members.me;
            if (bot.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
                role.comparePositionTo(bot.roles.highest) < 0) {
                await member.roles.remove(role, 'Cured from VIRUS');
            }
        }
    } catch (err) {
        console.error(`[Virus] remove role failed for ${userId}:`, err?.message || err);
    }

    markCured(guildId, userId);
    return true;
}

// ─────────────────────────────────────────────────────────────
//  Outbreak report helpers
// ─────────────────────────────────────────────────────────────

/** Build a fixed-width ASCII progress bar using Unicode block chars. */
function buildBar(pct, width = 30) {
    const filled = Math.round((pct / 100) * width);
    const empty  = width - filled;
    return '\u2588'.repeat(Math.max(0, filled)) + '\u2591'.repeat(Math.max(0, empty));
}

/** Right-pad / left-pad a string to a fixed width. */
function pad(str, len, char = ' ') {
    str = String(str);
    return str.length >= len ? str.slice(0, len) : str + char.repeat(len - str.length);
}
function lpad(str, len, char = ' ') {
    str = String(str);
    return str.length >= len ? str.slice(0, len) : char.repeat(len - str.length) + str;
}

function getThreatLevel(pct) {
    if (pct < 10)  return 'LOW';
    if (pct < 25)  return 'MODERATE';
    if (pct < 50)  return 'HIGH';
    if (pct < 75)  return 'CRITICAL';
    return 'EXTINCTION EVENT';
}

function getOutbreakStatus(pct) {
    if (pct === 0)  return 'CONTAINED';
    if (pct < 10)  return 'ACTIVE';
    if (pct < 30)  return 'ACCELERATING';
    if (pct < 60)  return 'UNCONTROLLED';
    return 'COLLAPSE';
}

function getConcentration(pct) {
    if (pct < 5)   return 'MINIMAL';
    if (pct < 15)  return 'LIGHT';
    if (pct < 35)  return 'MODERATE';
    if (pct < 60)  return 'HEAVY';
    return 'SEVERE';
}

function getClassification(pct) {
    if (pct < 10)  return 'Isolated Cases';
    if (pct < 25)  return 'Local Outbreak';
    if (pct < 50)  return 'Regional Epidemic';
    if (pct < 75)  return 'Severe Pandemic';
    return 'Extinction Event';
}

function getEmbedColor(threatLevel) {
    switch (threatLevel) {
        case 'LOW':              return 0x333333;
        case 'MODERATE':        return 0xcc6600;
        case 'HIGH':            return 0x8b0000;
        case 'CRITICAL':        return 0xcc0000;
        case 'EXTINCTION EVENT':return 0x440000;
        default:                return 0x333333;
    }
}

/** Survival probability — inverse sigmoid-ish feel */
function survivalProbability(pct) {
    if (pct === 0) return '100.00%';
    const raw = Math.max(0, 100 - (pct * 1.15));
    return `${raw.toFixed(2)}%`;
}

/** Contamination score 0–100 */
function contaminationScore(pct) {
    return Math.min(100, Math.round(pct * 1.1));
}

// ─────────────────────────────────────────────────────────────
//  Temporal analysis helpers
// ─────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Given the raw guild data object and a set of present user IDs,
 * returns a temporal stats object.
 */
function computeTemporalStats(guildData, presentIdSet, population) {
    const now     = Date.now();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    // Only entries for users still in the server
    const entries = Object.entries(guildData)
        .filter(([id]) => presentIdSet.has(id))
        .map(([id, rec]) => ({ id, ...rec }));

    if (entries.length === 0) {
        return {
            patientZeroId:    null,
            patientZeroTs:    null,
            mostRecentId:     null,
            mostRecentTs:     null,
            newToday:         0,
            outbreakAgeDays:  null,
            dailyGrowthRate:  null,
            timeToFiftyPct:   null,
        };
    }

    // Sort by timestamp ascending (nulls last)
    const sorted = [...entries].sort((a, b) => {
        if (a.timestamp == null && b.timestamp == null) return 0;
        if (a.timestamp == null) return 1;
        if (b.timestamp == null) return -1;
        return a.timestamp - b.timestamp;
    });

    const earliest = sorted[0];
    const latest   = sorted[sorted.length - 1];

    // Patient zero: earliest timestamp; prefer infectedBy===null as tiebreaker
    let patientZero = sorted[0];
    for (const e of sorted) {
        if (e.timestamp == null) break; // no ts = unknown, skip
        if (e.timestamp !== sorted[0].timestamp) break;
        if (e.infectedBy === null) { patientZero = e; break; }
    }

    // New infections today
    const newToday = entries.filter(e => e.timestamp != null && e.timestamp >= todayMs).length;

    // Outbreak age
    let outbreakAgeDays = null;
    if (earliest.timestamp != null) {
        outbreakAgeDays = Math.max(0, Math.floor((now - earliest.timestamp) / MS_PER_DAY));
    }

    // Daily growth rate — use 7-day rolling window if enough data, else lifetime average
    let dailyGrowthRate = null;
    if (outbreakAgeDays != null && outbreakAgeDays > 0) {
        const windowStart = now - 7 * MS_PER_DAY;
        const recentEntries = entries.filter(e => e.timestamp != null && e.timestamp >= windowStart);
        if (recentEntries.length >= 2) {
            // infections per day over last 7 days
            dailyGrowthRate = recentEntries.length / 7;
        } else {
            // lifetime average
            dailyGrowthRate = entries.filter(e => e.timestamp != null).length / outbreakAgeDays;
        }
    } else if (outbreakAgeDays === 0 && entries.length > 1) {
        // All infected today — use count as rate (single-day outbreak)
        dailyGrowthRate = entries.length;
    }

    // Estimated time to 50% infection
    let timeToFiftyPct = null;
    if (population > 0) {
        const target50 = Math.ceil(population * 0.5);
        const current  = entries.length;
        if (current >= target50) {
            timeToFiftyPct = 'ALREADY PAST 50%';
        } else if (dailyGrowthRate != null && dailyGrowthRate > 0) {
            const daysRemaining = Math.ceil((target50 - current) / dailyGrowthRate);
            if (daysRemaining > 3650) {
                timeToFiftyPct = 'RATE TOO SLOW TO ESTIMATE';
            } else if (daysRemaining === 0) {
                timeToFiftyPct = 'IMMINENT (< 1 DAY)';
            } else {
                timeToFiftyPct = `~${daysRemaining} DAY${daysRemaining === 1 ? '' : 'S'}`;
            }
        } else {
            timeToFiftyPct = 'INSUFFICIENT DATA';
        }
    }

    return {
        patientZeroId:   patientZero?.id ?? null,
        patientZeroTs:   patientZero?.timestamp ?? null,
        mostRecentId:    latest.id,
        mostRecentTs:    latest.timestamp ?? null,
        newToday,
        outbreakAgeDays,
        dailyGrowthRate,
        timeToFiftyPct,
    };
}

/** Format a Unix ms timestamp as a short UTC date string, or 'UNKNOWN' */
function fmtDate(ts) {
    if (ts == null) return 'UNKNOWN';
    const d = new Date(ts);
    const pad2 = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}  ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** "1 in N" infection ratio string */
function infectionRatio(infected, population) {
    if (infected === 0 || population === 0) return 'N/A';
    const n = Math.round(population / infected);
    return `1 in ${n}`;
}

// ─────────────────────────────────────────────────────────────
//  Main handler — =infectioninfo and aliases
// ─────────────────────────────────────────────────────────────
async function handleInfoCommand(message) {
    const guild = message.guild;
    if (!guild) return;

    // Fetch all members (uses cache; only hits API if cache is cold)
    try {
        await guild.members.fetch();
    } catch (err) {
        console.error('[Virus] members.fetch failed:', err?.message || err);
    }

    // ── Build member sets ────────────────────────────────────
    const allMembers  = guild.members.cache.filter(m => !m.user.bot);
    const population  = allMembers.size;

    // Infected IDs from disk, filtered to members still in the server
    let rawIds = [];
    try {
        rawIds = getInfectedIds(guild.id);
    } catch {
        rawIds = [];
    }

    const infectedMembers = rawIds
        .filter(id => allMembers.has(id))
        .map(id => allMembers.get(id))
        .filter(Boolean)
        .sort((a, b) => {
            const na = (a.displayName || a.user.username).toLowerCase();
            const nb = (b.displayName || b.user.username).toLowerCase();
            return na.localeCompare(nb);
        });

    const infectedCount = infectedMembers.length;
    const healthyCount  = Math.max(0, population - infectedCount);

    // Safe division
    const infPct     = population > 0 ? (infectedCount / population) * 100 : 0;
    const healthyPct = population > 0 ? (healthyCount  / population) * 100 : 100;

    // ── Derived stats ────────────────────────────────────────
    const threatLevel    = getThreatLevel(infPct);
    const outbreakStatus = getOutbreakStatus(infPct);
    const concentration  = getConcentration(infPct);
    const classification = getClassification(infPct);
    const color          = getEmbedColor(threatLevel);

    // ── Temporal stats ────────────────────────────────────────
    let guildData = {};
    try { guildData = data[guild.id] ? { ...data[guild.id] } : {}; } catch { guildData = {}; }
    const presentIdSet = new Set(allMembers.keys());
    const temporal = computeTemporalStats(guildData, presentIdSet, population);

    // Resolve display names for patient zero and most recent
    const patientZeroName = temporal.patientZeroId
        ? (allMembers.get(temporal.patientZeroId)?.displayName
            || allMembers.get(temporal.patientZeroId)?.user?.username
            || 'UNKNOWN')
        : 'NONE';
    const mostRecentName = temporal.mostRecentId
        ? (allMembers.get(temporal.mostRecentId)?.displayName
            || allMembers.get(temporal.mostRecentId)?.user?.username
            || 'UNKNOWN')
        : 'NONE';

    // ── Banner image ─────────────────────────────────────────
    let bannerAttachment = null;
    try {
        const bannerBuf = await generateBanner({
            serverName:      guild.name,
            population,
            infected:        infectedCount,
            healthy:         healthyCount,
            infectionPct:    infPct,
            threatLevel,
            outbreakStatus,
            classification,
            outbreakAgeDays: temporal.outbreakAgeDays,
        });
        bannerAttachment = new AttachmentBuilder(bannerBuf, { name: 'outbreak_banner.png' });
    } catch (err) {
        console.error('[Virus] Banner generation failed:', err?.message || err);
    }

    // ── ASCII dashboard block ─────────────────────────────────
    const barWidth = 28;

    const infBar     = buildBar(infPct,     barWidth);
    const healthyBar = buildBar(healthyPct, barWidth);

    const dashLines = [
        `INFECTION  [${infBar}] ${infPct.toFixed(1).padStart(5)}%`,
        `HEALTHY    [${healthyBar}] ${healthyPct.toFixed(1).padStart(5)}%`,
    ];
    const dashboard = '```\n' + dashLines.join('\n') + '\n```';

    // ── Infected subjects list ────────────────────────────────
    const DISPLAY_LIMIT = 15;
    let subjectsStr;
    if (infectedCount === 0) {
        subjectsStr = 'None. Population is currently clean.';
    } else {
        const shown   = infectedMembers.slice(0, DISPLAY_LIMIT).map(m => `<@${m.id}>`);
        const remaining = infectedCount - shown.length;
        subjectsStr  = shown.join('  ');
        if (remaining > 0) subjectsStr += `  +${remaining} more`;
    }

    // ── Risk assessment ───────────────────────────────────────
    let riskAssessment;
    if (infPct === 0)       riskAssessment = 'No active threat detected. Monitor for new cases.';
    else if (infPct < 5)    riskAssessment = 'Low-level presence. Standard monitoring protocol.';
    else if (infPct < 15)   riskAssessment = 'Elevated risk. Isolation of confirmed subjects advised.';
    else if (infPct < 35)   riskAssessment = 'High risk. Interaction with infected subjects strongly discouraged.';
    else if (infPct < 60)   riskAssessment = 'Severe threat. Population integrity compromised.';
    else if (infPct < 80)   riskAssessment = 'Critical. Expect rapid escalation. Containment likely failed.';
    else                    riskAssessment = 'TERMINAL. The healthy population is a minority. All hope of containment is lost.';

    // ── Healthy/infected ratio string ─────────────────────────
    let ratioStr;
    if (infectedCount === 0) {
        ratioStr = 'No infected subjects — ratio undefined.';
    } else if (healthyCount === 0) {
        ratioStr = 'No healthy subjects remain.';
    } else {
        const hPerI = (healthyCount / infectedCount).toFixed(2);
        ratioStr    = `${hPerI} healthy subjects per infected subject`;
    }

    // ── Encounter probability ─────────────────────────────────
    const encounterPct = infPct.toFixed(2);

    // ── Build embed ───────────────────────────────────────────
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('VIRUS OUTBREAK REPORT')
        .setFooter({ text: `SURVEILLANCE SYSTEM  |  ${guild.name.toUpperCase()}  |  Data reflects current server cache` })
        .setTimestamp();

    if (bannerAttachment) {
        embed.setImage('attachment://outbreak_banner.png');
    }

    // Field: Core statistics
    embed.addFields({
        name: 'CORE STATISTICS',
        value: [
            '```',
            `${'Total Population'.padEnd(28)}: ${lpad(population.toLocaleString(), 8)}`,
            `${'Total Infected'.padEnd(28)}: ${lpad(infectedCount.toLocaleString(), 8)}`,
            `${'Total Healthy'.padEnd(28)}: ${lpad(healthyCount.toLocaleString(), 8)}`,
            `${'Infection Rate'.padEnd(28)}: ${lpad(infPct.toFixed(2) + '%', 8)}`,
            `${'Healthy Rate'.padEnd(28)}: ${lpad(healthyPct.toFixed(2) + '%', 8)}`,
            `${'Infection Ratio'.padEnd(28)}: ${lpad(infectionRatio(infectedCount, population), 8)}`,
            '```',
        ].join('\n'),
        inline: false,
    });

    // Field: Dashboard
    embed.addFields({
        name: 'POPULATION DISTRIBUTION',
        value: dashboard,
        inline: false,
    });

    // Field: Threat assessment (two columns)
    embed.addFields(
        {
            name: 'THREAT ASSESSMENT',
            value: [
                '```',
                `Threat Level   : ${threatLevel}`,
                `Concentration  : ${concentration}`,
                `Status         : ${outbreakStatus}`,
                `Classification : ${classification}`,
                '```',
            ].join('\n'),
            inline: true,
        },
        {
            name: 'OUTBREAK ANALYSIS',
            value: [
                '```',
                `Survival Prob  : ${survivalProbability(infPct)}`,
                `Contam. Score  : ${contaminationScore(infPct)} / 100`,
                `Encounter Prob : ${encounterPct}%`,
                `H:I Ratio      : ${ratioStr.length < 22 ? ratioStr : ratioStr.slice(0, 21)}`,
                '```',
            ].join('\n'),
            inline: true,
        }
    );

    // Field: Risk
    embed.addFields({
        name: 'RISK ASSESSMENT',
        value: `\`\`\`${riskAssessment}\`\`\``,
        inline: false,
    });

    // Field: Temporal analysis
    {
        const dayRate    = temporal.dailyGrowthRate != null
            ? temporal.dailyGrowthRate.toFixed(2) + ' / day'
            : 'INSUFFICIENT DATA';
        const ageLine    = temporal.outbreakAgeDays != null
            ? `DAY ${temporal.outbreakAgeDays}${temporal.outbreakAgeDays === 0 ? '  (OUTBREAK BEGAN TODAY)' : ''}`
            : 'UNKNOWN';

        embed.addFields({
            name: 'TEMPORAL ANALYSIS',
            value: [
                '```',
                `${'Outbreak Age'.padEnd(26)}: ${ageLine}`,
                `${'Patient Zero'.padEnd(26)}: ${patientZeroName}`,
                `${'First Infection'.padEnd(26)}: ${fmtDate(temporal.patientZeroTs)}`,
                `${'Most Recently Infected'.padEnd(26)}: ${mostRecentName}`,
                `${'Last Infection'.padEnd(26)}: ${fmtDate(temporal.mostRecentTs)}`,
                `${'New Infections Today'.padEnd(26)}: ${temporal.newToday}`,
                `${'Growth Rate'.padEnd(26)}: ${dayRate}`,
                `${'Est. Time to 50% Pop.'.padEnd(26)}: ${temporal.timeToFiftyPct ?? 'INSUFFICIENT DATA'}`,
                '```',
            ].join('\n'),
            inline: false,
        });
    }

    // Field: Infected subjects
    embed.addFields({
        name: `CONFIRMED INFECTED SUBJECTS  [${infectedCount}]`,
        value: subjectsStr || 'None.',
        inline: false,
    });

    // Send
    const sendOpts = { embeds: [embed] };
    if (bannerAttachment) sendOpts.files = [bannerAttachment];

    await message.channel.send(sendOpts);
}

// ─────────────────────────────────────────────────────────────
//  Infection tree command
// ─────────────────────────────────────────────────────────────
async function handleTreeCommand(message) {
    const guild = message.guild;
    if (!guild) return;

    // Fetch all members into cache
    try { await guild.members.fetch(); }
    catch (err) { console.error('[Virus] members.fetch failed:', err?.message || err); }

    const allMembers = guild.members.cache.filter(m => !m.user.bot);
    const presentIds = [...allMembers.keys()];

    // Guild infection data — safe copy
    let guildData = {};
    try { guildData = data[guild.id] ? { ...data[guild.id] } : {}; }
    catch { guildData = {}; }

    // Build name map: userId → display name
    const nameMap = new Map();
    for (const [id, member] of allMembers) {
        nameMap.set(id, member.displayName || member.user.username);
    }

    const infectedCount = Object.keys(guildData).filter(id => presentIds.includes(id)).length;

    const treeBuf = await generateTree({
        infectedData: guildData,
        presentIds,
        nameMap,
        invokerId: message.author.id,
        guildName: guild.name,
    });

    const attachment = new AttachmentBuilder(treeBuf, { name: 'infection_tree.png' });

    const embed = new EmbedBuilder()
        .setColor(0x5b4fcf)
        .setTitle('INFECTION LINEAGE TREE')
        .setDescription(
            infectedCount === 0
                ? 'No infected subjects. The population is currently clean.'
                : `Displaying lineage for **${infectedCount}** infected subject(s). Your node is highlighted in purple.`
        )
        .setImage('attachment://infection_tree.png')
        .setFooter({ text: `${guild.name}  |  Boxes without a parent line are patient zeros` })
        .setTimestamp();

    await message.channel.send({ embeds: [embed], files: [attachment] });
}

// ─────────────────────────────────────────────────────────────
//  Message event handler (to be called from index.js)
// ─────────────────────────────────────────────────────────────
async function handleMessage(message) {
    if (message.author.bot || !message.guild) return;

    const prefix = '=';
    if (!message.content.startsWith(prefix)) return;

    const args    = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = args[0]?.toLowerCase();

    // ── =infectiontree / =it ─────────────────────────────────
    if (TREE_ALIASES.has(command)) {
        try {
            await handleTreeCommand(message);
        } catch (err) {
            console.error('[Virus] handleTreeCommand error:', err);
            await message.channel.send('```Failed to generate infection tree. Data may be corrupted.```');
        }
        return;
    }

    // ── =infectioninfo and aliases ────────────────────────────
    if (INFO_ALIASES.has(command)) {
        try {
            await handleInfoCommand(message);
        } catch (err) {
            console.error('[Virus] handleInfoCommand error:', err);
            await message.channel.send('```Failed to generate outbreak report. Data may be corrupted.```');
        }
        return;
    }

    // ── =infect ───────────────────────────────────────────────
    if (command === 'infect') {
        const member = message.member;
        const result = await applyInfection(member);
        if (result) {
            await message.channel.send(`${member} HAS BEEN INFECTED. The virus spreads.`);
        } else if (isInfected(message.guild.id, member.id)) {
            await message.channel.send('You are already infected.');
        } else {
            await message.channel.send('You cannot be infected.');
        }
        return;
    }

    // ── =cure ─────────────────────────────────────────────────
    if (command === 'cure') {
        if (!isAuthorized(message.member)) {
            await message.channel.send('You are not authorized to administer cures.');
            return;
        }

        const sub = args[1]?.toLowerCase();

        if (sub === 'all') {
            const ids    = getInfectedIds(message.guild.id);
            let   cured  = 0;
            for (const id of ids) {
                const m = message.guild.members.cache.get(id);
                if (m && await removeInfection(m)) cured++;
                else if (!m) markCured(message.guild.id, id); // ghost cleanup
            }
            await message.channel.send(`${cured} subject(s) have been cured.`);
            return;
        }

        const target = message.mentions.members?.first() || message.member;
        const result = await removeInfection(target);
        if (result) {
            await message.channel.send(`${target} has been cured.`);
        } else {
            await message.channel.send(`${target} is not infected.`);
        }
        return;
    }

    // ── Spread: infected user pings someone ──────────────────
    if (isInfected(message.guild.id, message.author.id)) {
        const pingedMembers = message.mentions.members;
        if (pingedMembers?.size) {
            for (const [, target] of pingedMembers) {
                if (target.user.bot) continue;
                const result = await applyInfection(target, message.author.id);
                if (result) {
                    await message.channel.send(`${target} has been infected by contact with ${message.member}.`);
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
    VIRUS_ROLE_ID,
    IMMUNE_ROLE_IDS,
    INFO_ALIASES,
    TREE_ALIASES,
    isImmune,
    isInfected,
    getInfectedIds,
    markCured,
    applyInfection,
    removeInfection,
    handleMessage,
};