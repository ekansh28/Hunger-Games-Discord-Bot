// ============================================================
// banRoulette.js — Ban Roulette mini-game module for discord.js v14
//
// Changes from original:
//  • No fixed capacity — lobby is open-ended (2–20 players)
//  • Prefix command =br (text) AND slash command /br both work
//  • Lobby works like Hunger Games: Join + Start buttons
//    (only the host or an authorized user can press Start)
//  • Canvas layout is fully dynamic:
//      ≤ 8 players  → perfect polygon ring (same as before, computed)
//      9–20 players → viewport window: 8 slots rendered, always
//                     centred on the active player; inactive players
//                     outside the window are shown as faded edge
//                     "peek" avatars so users can see the ring wraps
// ============================================================

'use strict';

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    EmbedBuilder,
    PermissionsBitField,
} = require('discord.js');
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');
const { isAuthorized } = require('./authorization');
const Stats = require('./stats');

// ── Font ─────────────────────────────────────────────────────
const FONT_PATH = path.join(__dirname, '..', 'fonts', 'font.ttf');
const FONT_FAMILY = fs.existsSync(FONT_PATH) ? (() => {
    registerFont(FONT_PATH, { family: 'CustomFont' });
    return 'CustomFont';
})() : 'Georgia';

// ── Constants ─────────────────────────────────────────────────
const CANVAS_W = 1200;
const CANVAS_H = 1200;
const AVATAR_RADIUS = 100;         // base avatar circle radius
const BORDER_WIDTH = 12;
const CROSS_WIDTH = 24;

const TIMEOUT_MS = 5 * 1000;   // mute penalty on elimination
const TURN_TIMEOUT_MS = 10 * 1000;   // seconds before auto-elim for inactivity

const VIEWPORT_SIZE = 8;           // max players shown in one render frame
const PEEK_ALPHA = 0.35;        // opacity of "peek" avatars at window edges

// Role to assign on elimination
const ELIM_ROLE_ID = '1486781924671492266';
const BR_ADMIN_ID = '1198980443823947927';

// ── Session store ─────────────────────────────────────────────
const sessions = new Map();   // channelId → session
const joiningUsers = new Set();  // lock to prevent double-join

// ── Slash command definitions ─────────────────────────────────
const banRouletteCommand = new SlashCommandBuilder()
    .setName('br')
    .setDescription('Start a Ban Roulette lobby in this channel.')
    .addIntegerOption(opt =>
        opt.setName('probability')
            .setDescription('1-in-N chance of getting banned per trigger pull (default: 6)')
            .setMinValue(2).setMaxValue(20).setRequired(false));

const brCancelCommand = new SlashCommandBuilder()
    .setName('brcancel')
    .setDescription('Cancel the active Ban Roulette session in this channel.');

// ── Role helpers ──────────────────────────────────────────────
async function assignElimRole(guild, userId, logChannel = null) {
    try {
        const member = await guild.members.fetch(userId);
        if (!member) return false;
        const role = guild.roles.cache.get(ELIM_ROLE_ID);
        if (!role) { logChannel?.send?.(`⚠️ Elimination role not found.`).catch(() => { }); return false; }
        const bot = guild.members.me;
        if (!bot.permissions.has(PermissionsBitField.Flags.ManageRoles)) return false;
        if (role.comparePositionTo(bot.roles.highest) >= 0) return false;
        await member.roles.add(role, 'Ban Roulette elimination');
        return true;
    } catch { return false; }
}

async function removeElimRole(guild, userId) {
    try {
        const member = await guild.members.fetch(userId);
        if (!member) return;
        const role = guild.roles.cache.get(ELIM_ROLE_ID);
        if (!role || !member.roles.cache.has(role.id)) return;
        const bot = guild.members.me;
        if (!bot.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
        if (role.comparePositionTo(bot.roles.highest) >= 0) return;
        await member.roles.remove(role, 'Ban Roulette victory');
    } catch { }
}

// ── Turn timeout helpers ──────────────────────────────────────
function clearTurnTimeout(session) {
    if (session.turnTimeout) { clearTimeout(session.turnTimeout); session.turnTimeout = null; }
}

function scheduleTurnTimeout(session, channel) {
    clearTurnTimeout(session);
    if (session.status !== 'playing') return;
    const currentPlayer = session.players[session.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated) return;

    session.turnTimeout = setTimeout(async () => {
        const s = sessions.get(session.channelId);
        if (!s || s.status !== 'playing' || s.turnIndex !== session.turnIndex) return;

        const expired = s.players[s.turnIndex];
        if (!expired || expired.eliminated) return;
        expired.eliminated = true;

        await assignElimRole(channel.guild, expired.userId, channel);

        let note = '';
        try {
            const member = await channel.guild.members.fetch(expired.userId);
            const bot = channel.guild.members.me;
            if (member && bot.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                if (bot.roles.highest.comparePositionTo(member.roles.highest) > 0) {
                    await member.timeout(TIMEOUT_MS, 'Ban Roulette — inactivity');
                } else { note = ' (timeout skipped — role too high)'; }
            } else { note = ' (missing Moderate Members)'; }
        } catch { note = ' (timeout failed)'; }

        const alive = s.players.filter(p => !p.eliminated);
        if (alive.length <= 1) {
            s.status = 'done';
            const winner = alive[0];
            await refreshMessage(s, `⏰ **TIME OUT!** <@${expired.userId}> took too long.${note}`);
            if (winner) {
                await removeElimRole(channel.guild, winner.userId);
                if (s.guildId) Stats.addBrWin(s.guildId, winner.userId);
                await channel.send(`🏆 <@${winner.userId}> is the last one standing — **you win!**`);
            } else {
                await channel.send('Everyone is eliminated. No survivors.');
            }
            sessions.delete(s.channelId);
            return;
        }

        advanceTurn(s);
        const next = s.players[s.turnIndex];
        await refreshMessage(s, `⏰ **TIME OUT!** <@${expired.userId}> was eliminated.${note} — <@${next.userId}>, you're next.`);
        scheduleTurnTimeout(s, channel);
    }, TURN_TIMEOUT_MS);
}

function advanceTurn(session) {
    let next = (session.turnIndex + 1) % session.players.length;
    let safety = 0;
    while (session.players[next].eliminated && safety < session.players.length) {
        next = (next + 1) % session.players.length;
        safety++;
    }
    session.turnIndex = next;
}

// ── Avatar fetch ──────────────────────────────────────────────
async function fetchAvatar(user) {
    const url = user.displayAvatarURL({ extension: 'png', size: 256 });
    try { return await loadImage(url); }
    catch {
        const tmp = createCanvas(256, 256);
        const ctx = tmp.getContext('2d');
        const hue = parseInt(user.id.slice(-4), 16) % 360;
        ctx.fillStyle = `hsl(${hue},60%,40%)`;
        ctx.beginPath(); ctx.arc(128, 128, 128, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `bold 96px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((user.username[0] || '?').toUpperCase(), 128, 128);
        return tmp;
    }
}

// ── Canvas layout ─────────────────────────────────────────────
//
// For N players we arrange them on a ring. When N > VIEWPORT_SIZE we
// render only a VIEWPORT_SIZE-wide window centred on the active player.
// Players just outside the window edges get drawn as translucent "peeks"
// to signal the ring continues.
//
// Ring geometry is computed fresh from the player count (or viewport size).

function ringPositions(count, cx, cy, ringR) {
    const pts = [];
    for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + (i / count) * 2 * Math.PI;
        pts.push({ x: cx + ringR * Math.cos(angle), y: cy + ringR * Math.sin(angle) });
    }
    return pts;
}

async function renderCanvas(session) {
    const canvas = createCanvas(CANVAS_W, CANVAS_H);
    const ctx = canvas.getContext('2d');
    const cx = CANVAS_W / 2;
    const cy = CANVAS_H / 2;

    // ── Background ────────────────────────────────────────────
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, CANVAS_W * 0.7);
    bg.addColorStop(0, '#2c1a1a');
    bg.addColorStop(1, '#0d0608');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Subtle ring glow
    ctx.strokeStyle = 'rgba(180,30,30,0.10)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 10]);
    ctx.beginPath(); ctx.arc(cx, cy, CANVAS_W * 0.42, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    const players = session.players;
    const n = players.length;

    if (n === 0) {
        // Empty lobby
        ctx.fillStyle = 'rgba(200,200,200,0.5)';
        ctx.font = `bold 40px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Waiting for players…', cx, cy);
        return canvas.toBuffer('image/png');
    }

    const useViewport = n > VIEWPORT_SIZE;

    if (!useViewport) {
        // ── Simple ring (all players fit) ────────────────────────
        const ringR = Math.max(180, Math.min(450, CANVAS_W * 0.38 - (n > 4 ? 0 : 60)));
        const positions = ringPositions(n, cx, cy, ringR);
        const r = avatarRadiusForCount(n);

        // Draw faint connector lines
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i < n; i++) {
            const a = positions[i], b = positions[(i + 1) % n];
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }

        for (let i = 0; i < n; i++) {
            const p = players[i];
            const pos = positions[i];
            const isActive = (session.status === 'playing' && i === session.turnIndex);
            await drawAvatar(ctx, p, pos.x, pos.y, r, isActive, p.eliminated, 1.0);
            await drawUsername(ctx, p, pos.x, pos.y, r);
        }

    } else {
        // ── Viewport ring (9–20 players) ──────────────────────────
        // We always show VIEWPORT_SIZE slots in a ring.
        // The active player sits at the top (index 0 in ring coords).
        // We compute which slice of `players` to show, with wrap-around.

        const half = Math.floor(VIEWPORT_SIZE / 2);
        const active = session.status === 'playing' ? session.turnIndex : 0;
        const ringR = CANVAS_W * 0.38;
        const r = avatarRadiusForCount(VIEWPORT_SIZE);

        // Slots: active player is placed at ring index `half` (vertically centred-ish)
        // so we can show `half` before and `half` after.
        const windowIndices = [];  // player array indices for each ring slot
        for (let slot = 0; slot < VIEWPORT_SIZE; slot++) {
            const offset = slot - half;
            let pidx = ((active + offset) % n + n) % n;
            windowIndices.push(pidx);
        }

        // One extra peek on each side (outside the window)
        const peekBefore = ((active - half - 1) % n + n) % n;
        const peekAfter = ((active + half + 1) % n + n) % n;

        const positions = ringPositions(VIEWPORT_SIZE, cx, cy, ringR);

        // Connector lines
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i < VIEWPORT_SIZE; i++) {
            const a = positions[i], b = positions[(i + 1) % VIEWPORT_SIZE];
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }

        for (let slot = 0; slot < VIEWPORT_SIZE; slot++) {
            const pidx = windowIndices[slot];
            const p = players[pidx];
            const pos = positions[slot];
            const isActive = (session.status === 'playing' && pidx === active);
            await drawAvatar(ctx, p, pos.x, pos.y, r, isActive, p.eliminated, 1.0);
            await drawUsername(ctx, p, pos.x, pos.y, r);
        }

        // Peek avatars (ghosted)
        const peekPosBefore = ringPositions(VIEWPORT_SIZE + 2, cx, cy, ringR)[0];  // just off first slot
        const peekPosAfter = ringPositions(VIEWPORT_SIZE + 2, cx, cy, ringR)[VIEWPORT_SIZE + 1];
        const smallR = r * 0.65;

        // We approximate peek positions as slightly beyond the ring edges
        const p0 = positions[0];
        const pV = positions[VIEWPORT_SIZE - 1];
        const edgeBefore = extrapolateEdge(cx, cy, p0, ringR, smallR);
        const edgeAfter = extrapolateEdge(cx, cy, pV, ringR, smallR);

        await drawAvatar(ctx, players[peekBefore], edgeBefore.x, edgeBefore.y, smallR, false, players[peekBefore].eliminated, PEEK_ALPHA);
        await drawAvatar(ctx, players[peekAfter], edgeAfter.x, edgeAfter.y, smallR, false, players[peekAfter].eliminated, PEEK_ALPHA);

        // Show total count and "frame" indicator
        const shownFrom = ((active - half) % n + n) % n + 1;
        ctx.fillStyle = 'rgba(200,200,200,0.55)';
        ctx.font = `22px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`Showing ${VIEWPORT_SIZE} of ${n} players`, cx, CANVAS_H - 18);
    }

    // Centre label (status / gun)
    drawCentreLabel(ctx, cx, cy, session);

    return canvas.toBuffer('image/png');
}

/** Push a point slightly further out along the ring to place peek avatars */
function extrapolateEdge(cx, cy, pos, ringR, avatarR) {
    const dx = pos.x - cx, dy = pos.y - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const r2 = ringR + avatarR * 1.4;
    return { x: cx + dx / len * r2, y: cy + dy / len * r2 };
}

function avatarRadiusForCount(n) {
    if (n <= 2) return 130;
    if (n <= 4) return 120;
    if (n <= 6) return 108;
    if (n <= 8) return 96;
    return 84;
}

async function drawAvatar(ctx, player, x, y, r, isActive, isEliminated, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;

    if (player.avatarBuffer) {
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
        if (isEliminated) {
            const tmp = createCanvas(r * 2, r * 2);
            const tc = tmp.getContext('2d');
            tc.drawImage(player.avatarBuffer, 0, 0, r * 2, r * 2);
            const id = tc.getImageData(0, 0, r * 2, r * 2);
            for (let i = 0; i < id.data.length; i += 4) {
                const g = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
                id.data[i] = id.data[i + 1] = id.data[i + 2] = g * 0.55;
            }
            tc.putImageData(id, 0, 0);
            ctx.drawImage(tmp, x - r, y - r, r * 2, r * 2);
        } else {
            ctx.drawImage(player.avatarBuffer, x - r, y - r, r * 2, r * 2);
        }
        ctx.restore();
    }

    // Border ring
    if (isActive) {
        ctx.shadowColor = '#ff2222';
        ctx.shadowBlur = 32;
        ctx.strokeStyle = '#E74C3C';
        ctx.lineWidth = BORDER_WIDTH;
        ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
        ctx.shadowBlur = 0;
    } else if (!isEliminated) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r + 1, 0, Math.PI * 2); ctx.stroke();
    }

    // Eliminated X
    if (isEliminated) {
        ctx.strokeStyle = '#cc1111cc';
        ctx.lineWidth = CROSS_WIDTH;
        ctx.lineCap = 'round';
        ctx.shadowColor = '#ff000088';
        ctx.shadowBlur = 14;
        const o = r * 0.65;
        ctx.beginPath(); ctx.moveTo(x - o, y - o); ctx.lineTo(x + o, y + o); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + o, y - o); ctx.lineTo(x - o, y + o); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r + 1, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.restore();
}

async function drawUsername(ctx, player, x, y, r) {
    const name = player.displayName || player.username;
    const isElim = player.eliminated;
    ctx.save();
    ctx.font = `bold ${Math.round(r * 0.28)}px "${FONT_FAMILY}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isElim ? 'rgba(160,160,160,0.7)' : 'rgba(255,255,255,0.9)';
    // Soft shadow for legibility
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 6;
    ctx.fillText(name.length > 14 ? name.slice(0, 13) + '…' : name, x, y + r + 8);
    ctx.restore();
}

function drawCentreLabel(ctx, cx, cy, session) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (session.status === 'lobby') {
        ctx.fillStyle = 'rgba(255,220,80,0.85)';
        ctx.font = `bold 34px "${FONT_FAMILY}"`;
        ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
        ctx.fillText('LOBBY', cx, cy - 20);
        ctx.font = `22px "${FONT_FAMILY}"`;
        ctx.fillStyle = 'rgba(200,200,200,0.7)';
        ctx.fillText(`${session.players.length} joined`, cx, cy + 18);
    } else if (session.status === 'playing') {
        // Revolver icon (text approximation)
        ctx.font = `bold 46px "${FONT_FAMILY}"`;
        ctx.fillStyle = 'rgba(220,30,30,0.9)';
        ctx.shadowColor = '#ff000066'; ctx.shadowBlur = 20;
        ctx.fillText('🔫', cx, cy);
    } else {
        ctx.font = `bold 36px "${FONT_FAMILY}"`;
        ctx.fillStyle = 'rgba(255,215,0,0.9)';
        ctx.fillText('GAME OVER', cx, cy);
    }
    ctx.restore();
}

// ── Build button rows ──────────────────────────────────────────
function buildLobbyRow(session) {
    const canStart = session.players.length >= 2;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('br_join')
            .setLabel('Join Game')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('br_start')
            .setLabel('Start Game')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!canStart),
    );
}

function buildPlayRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('br_trigger')
            .setLabel('🔫  Pull Trigger')
            .setStyle(ButtonStyle.Danger),
    );
}

function buildDoneRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('br_noop')
            .setLabel('Game Over')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
    );
}

function buildRow(session) {
    if (session.status === 'lobby') return buildLobbyRow(session);
    if (session.status === 'playing') return buildPlayRow();
    return buildDoneRow();
}

// ── Refresh the pinned message ─────────────────────────────────
async function refreshMessage(session, content = '') {
    const buf = await renderCanvas(session);
    const attachment = new AttachmentBuilder(buf, { name: 'roulette.png' });
    const row = buildRow(session);
    if (session.message) {
        await session.message.edit({ content, embeds: [], components: [row], files: [attachment] });
    }
}

// ── Open a session (shared between =br and /br) ───────────────
async function openSession(channelId, hostUser, chamberSize, replyFn, guild) {
    if (sessions.has(channelId)) return replyFn('A Ban Roulette session is already active in this channel.');

    const session = {
        channelId,
        chamberSize,
        players: [],
        status: 'lobby',
        turnIndex: 0,
        message: null,
        turnTimeout: null,
        autoCloseTimeout: null,
        guildId: guild?.id ?? null,
        hostId: hostUser.id,
    };
    sessions.set(channelId, session);

    const buf = await renderCanvas(session);
    const attachment = new AttachmentBuilder(buf, { name: 'roulette.png' });
    const row = buildLobbyRow(session);

    const msg = await replyFn({ content: `🎰 **Ban Roulette** hosted by **${hostUser.displayName || hostUser.username}**\n1-in-${chamberSize} chance each pull. Press **Join Game**, then the host presses **Start Game**.`, embeds: [], components: [row], files: [attachment] });

    // replyFn may return the Message directly or we need to fetch it
    session.message = msg?.resource?.message ?? msg;

    // Auto-close after 30 s if fewer than 2 players have joined
    session.autoCloseTimeout = setTimeout(async () => {
        const s = sessions.get(channelId);
        if (!s || s.status !== 'lobby' || s.players.length >= 2) return;
        sessions.delete(channelId);
        const reason = s.players.length === 0
            ? '🎰 Ban Roulette lobby closed — no one joined in time.'
            : '🎰 Ban Roulette lobby closed — not enough players joined in time (need at least 2).';
        try {
            await s.message.edit({ content: reason, embeds: [], components: [], files: [] });
        } catch { }
    }, 30 * 1000);
}

// ── /br slash command ─────────────────────────────────────────
async function handleBrCommand(interaction) {
    if (interaction.user.id !== BR_ADMIN_ID && !isAuthorized(interaction.member || interaction.user)) {
        return interaction.reply({ content: 'Only authorized users can host Ban Roulette.', flags: 64 });
    }
    const chamberSize = interaction.options.getInteger('probability') ?? 6;
    await openSession(
        interaction.channel.id,
        interaction.user,
        chamberSize,
        async (payload) => {
            if (typeof payload === 'string') {
                return interaction.reply({ content: payload, flags: 64 });
            }
            const res = await interaction.reply({ ...payload, withResponse: true });
            return res;
        },
        interaction.guild,
    );
}

// ── =br prefix command (called from index.js) ─────────────────
async function handleBrPrefixCommand(message) {
    if (message.author.id !== BR_ADMIN_ID && !isAuthorized(message.member || message.author)) {
        return message.reply('Only authorized users can host Ban Roulette.');
    }
    const args = message.content.slice(3).trim();
    const chamberSize = parseInt(args, 10) || 6;
    const safeSize = Math.max(2, Math.min(20, chamberSize));

    await openSession(
        message.channel.id,
        message.author,
        safeSize,
        async (payload) => {
            if (typeof payload === 'string') return message.reply(payload);
            return message.channel.send(payload);
        },
        message.guild,
    );
}

// ── /brcancel ─────────────────────────────────────────────────
async function handleBrCancel(interaction) {
    if (interaction.user.id !== BR_ADMIN_ID && !isAuthorized(interaction.member || interaction.user)) {
        return interaction.reply({ content: 'Only the BR admin or authorized hosts can cancel.', flags: 64 });
    }
    const session = sessions.get(interaction.channel.id);
    if (!session) return interaction.reply({ content: 'No active session.', flags: 64 });

    clearTurnTimeout(session);
    if (session.autoCloseTimeout) clearTimeout(session.autoCloseTimeout);
    sessions.delete(interaction.channel.id);
    if (session.message) await session.message.delete().catch(() => { });
    await interaction.reply('Ban Roulette session cancelled.');
}

// ── Button: br_join ───────────────────────────────────────────
async function handleJoin(interaction) {
    const session = sessions.get(interaction.channel.id);
    const userId = interaction.user.id;

    if (!session || session.status !== 'lobby')
        return interaction.reply({ content: 'No active lobby here.', flags: 64 });
    if (session.players.some(p => p.userId === userId))
        return interaction.reply({ content: 'You have already joined.', flags: 64 });
    if (session.players.length >= 20)
        return interaction.reply({ content: 'Lobby is full (20 players max).', flags: 64 });
    if (joiningUsers.has(userId))
        return interaction.reply({ content: 'Please wait…', flags: 64 });

    joiningUsers.add(userId);
    try {
        await interaction.deferUpdate();

        // Re-check after defer
        if (session.players.some(p => p.userId === userId)) {
            await interaction.followUp({ content: 'You have already joined.', flags: 64 }); return;
        }

        const avatarBuffer = await fetchAvatar(interaction.user);
        session.players.push({
            userId,
            username: interaction.user.username,
            displayName: interaction.member?.displayName || interaction.user.displayName || interaction.user.username,
            avatarBuffer,
            eliminated: false,
        });

        // Cancel the 30s auto-close only once 2+ players have joined
        if (session.players.length >= 2 && session.autoCloseTimeout) {
            clearTimeout(session.autoCloseTimeout);
            session.autoCloseTimeout = null;
        }

        await refreshMessage(session, `🎰 **Ban Roulette** hosted by <@${session.hostId}> — 1-in-${session.chamberSize} per pull\n**${session.players.length}** player${session.players.length !== 1 ? 's' : ''} joined. Press **Start Game** when ready.`);
    } finally {
        joiningUsers.delete(userId);
    }
}

// ── Button: br_start ──────────────────────────────────────────
async function handleStart(interaction) {
    const session = sessions.get(interaction.channel.id);
    if (!session || session.status !== 'lobby')
        return interaction.reply({ content: 'No active lobby.', flags: 64 });

    const isHost = interaction.user.id === session.hostId;
    const isAuth = interaction.user.id === BR_ADMIN_ID || isAuthorized(interaction.member || interaction.user);
    if (!isHost && !isAuth)
        return interaction.reply({ content: 'Only the host or an authorized user can start the game.', flags: 64 });
    if (session.players.length < 2)
        return interaction.reply({ content: 'Need at least 2 players to start.', flags: 64 });

    await interaction.deferUpdate();

    if (session.autoCloseTimeout) { clearTimeout(session.autoCloseTimeout); session.autoCloseTimeout = null; }
    session.status = 'playing';
    session.turnIndex = 0;

    const first = session.players[0];
    await refreshMessage(session, `🔫 **Ban Roulette begins!** <@${first.userId}> goes first — 1-in-${session.chamberSize} chance per pull.`);
    scheduleTurnTimeout(session, interaction.channel);
}

// ── Button: br_trigger ────────────────────────────────────────
async function handleTrigger(interaction) {
    const session = sessions.get(interaction.channel.id);
    if (!session || session.status !== 'playing')
        return interaction.reply({ content: 'No active game.', flags: 64 });

    const active = session.players[session.turnIndex];
    if (interaction.user.id !== active.userId)
        return interaction.reply({ content: `It's <@${active.userId}>'s turn, not yours!`, flags: 64 });
    if (interaction.acknowledged) return;

    await interaction.deferUpdate();
    clearTurnTimeout(session);

    const bang = Math.random() < (1 / session.chamberSize);

    if (!bang) {
        advanceTurn(session);
        const next = session.players[session.turnIndex];
        await refreshMessage(session, `*Click.* <@${active.userId}> survived. — <@${next.userId}>, you're next.`);
        scheduleTurnTimeout(session, interaction.channel);
        return;
    }

    // BANG
    active.eliminated = true;
    await assignElimRole(interaction.guild, active.userId, interaction.channel);

    let note = '';
    try {
        const member = interaction.member ?? await interaction.guild.members.fetch(active.userId);
        const bot = interaction.guild.members.me;
        if (member && bot.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
            if (bot.roles.highest.comparePositionTo(member.roles.highest) > 0) {
                await member.timeout(TIMEOUT_MS, 'Ban Roulette elimination');
            } else { note = ' (timeout skipped — role too high)'; }
        } else { note = ' (missing Moderate Members)'; }
    } catch (err) {
        note = err.code === 50013 ? ' (timeout forbidden)' : ' (timeout failed)';
    }

    const alive = session.players.filter(p => !p.eliminated);
    if (alive.length <= 1) {
        session.status = 'done';
        await refreshMessage(session, `💥 **BANG!** <@${active.userId}> is eliminated.${note}`);
        const winner = alive[0];
        if (winner) {
            await removeElimRole(interaction.guild, winner.userId);
            if (session.guildId) Stats.addBrWin(session.guildId, winner.userId);
            await interaction.channel.send(`🏆 <@${winner.userId}> is the last one standing — **you win!**`);
        } else {
            await interaction.channel.send('Everyone is eliminated. No survivors.');
        }
        sessions.delete(session.channelId);
        return;
    }

    advanceTurn(session);
    const next = session.players[session.turnIndex];
    await refreshMessage(session, `💥 **BANG!** <@${active.userId}> is eliminated.${note} — <@${next.userId}>, you're next.`);
    scheduleTurnTimeout(session, interaction.channel);
}

// ── Master interaction router ─────────────────────────────────
async function handleInteraction(interaction) {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'br') return await handleBrCommand(interaction);
            if (interaction.commandName === 'brcancel') return await handleBrCancel(interaction);
        }
        if (interaction.isButton()) {
            if (interaction.customId === 'br_join') return await handleJoin(interaction);
            if (interaction.customId === 'br_start') return await handleStart(interaction);
            if (interaction.customId === 'br_trigger') return await handleTrigger(interaction);
        }
    } catch (err) {
        console.error('[BanRoulette] Error:', err);
        const msg = 'An internal error occurred.';
        try {
            if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: 64 });
            else await interaction.reply({ content: msg, flags: 64 });
        } catch { }
    }
}

module.exports = {
    commandData: [banRouletteCommand.toJSON(), brCancelCommand.toJSON()],
    handleInteraction,
    handleBrPrefixCommand,   // ← new export for =br prefix handling in index.js
};