// ============================================================
// banRoulette.js — Ban Roulette mini-game module for discord.js v14
// Supports 2–8 players.
// ============================================================

'use strict';

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionsBitField,
} = require('discord.js');
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');
const { isAuthorized } = require('./authorization');

// ── Load custom font from fonts/font.ttf (same as imageGenerator) ──
const FONT_PATH = path.join(__dirname, '..', 'fonts', 'font.ttf');
const FONT_FAMILY = fs.existsSync(FONT_PATH) ? (() => {
    registerFont(FONT_PATH, { family: 'CustomFont' });
    console.log('[BanRoulette] Loaded custom font from', FONT_PATH);
    return 'CustomFont';
})() : 'Georgia';

// ── Constants ────────────────────────────────────────────────
const CANVAS_SIZE   = 1200;
const AVATAR_RADIUS = 110;
const BORDER_WIDTH  = 12;
const CROSS_WIDTH   = 28;

const TIMEOUT_MS    = 5 * 1000;   // 5 seconds for elimination penalty
const TURN_TIMEOUT_MS = 10 * 1000;     // 10 seconds to act, then auto-eliminate

// Role to assign on elimination, remove on win
const ELIM_ROLE_ID = '1486781924671492266';

// ── Admin ─────────────────────────────────────────────────────
// BR_ADMIN_ID is always allowed to host, in addition to anyone added
// via =addp (checked through the shared isAuthorized() helper).
const BR_ADMIN_ID = '1198980443823947927';

// ── Session store  (channel.id → session) ───────────────────
const sessions = new Map();

// ── Lock to prevent duplicate joins ──────────────────────────
const joiningUsers = new Set();

// ── Avatar-position layouts (same as before) ─────────────────
const LAYOUTS = {
    2: [ { x: 0.50, y: 0.25 }, { x: 0.50, y: 0.75 } ],
    3: [ { x: 0.50, y: 0.18 }, { x: 0.18, y: 0.73 }, { x: 0.82, y: 0.73 } ],
    4: [ { x: 0.50, y: 0.15 }, { x: 0.85, y: 0.50 }, { x: 0.50, y: 0.85 }, { x: 0.15, y: 0.50 } ],
    5: [ { x: 0.50, y: 0.12 }, { x: 0.87, y: 0.38 }, { x: 0.75, y: 0.80 }, { x: 0.25, y: 0.80 }, { x: 0.13, y: 0.38 } ],
    6: (() => { const pts = []; for (let i=0; i<6; i++) { const a = Math.PI/2 + i*2*Math.PI/6; pts.push({x:0.5+0.35*Math.cos(a), y:0.5-0.35*Math.sin(a)}); } return pts; })(),
    7: (() => { const pts = []; for (let i=0; i<6; i++) { const a = Math.PI/2 + i*2*Math.PI/6; pts.push({x:0.5+0.35*Math.cos(a), y:0.5-0.35*Math.sin(a)}); } pts.push({x:0.5, y:0.5}); return pts; })(),
    8: (() => { const pts = []; for (let i=0; i<8; i++) { const a = Math.PI/2 + i*2*Math.PI/8; pts.push({x:0.5+0.38*Math.cos(a), y:0.5-0.38*Math.sin(a)}); } return pts; })(),
};

// ── Slash command definitions (unchanged) ────────────────────
const banRouletteCommand = new SlashCommandBuilder()
    .setName('br')
    .setDescription('Start a Ban Roulette session in this channel.')
    .addIntegerOption(opt => opt.setName('capacity').setDescription('Number of players (2–8). Default: 2').setMinValue(2).setMaxValue(8).setRequired(false))
    .addIntegerOption(opt => opt.setName('probability').setDescription('1-in-N chance of getting banned per trigger pull. Default: 6').setMinValue(2).setMaxValue(20).setRequired(false));

const brCancelCommand = new SlashCommandBuilder()
    .setName('brcancel')
    .setDescription('Cancel the active Ban Roulette session in this channel.');

// ── Helper: assign elimination role ──────────────────────────
async function assignElimRole(guild, userId, logChannel = null) {
    try {
        const member = await guild.members.fetch(userId);
        if (!member) return false;
        const role = guild.roles.cache.get(ELIM_ROLE_ID);
        if (!role) {
            if (logChannel) logChannel.send(`⚠️ Elimination role ${ELIM_ROLE_ID} not found.`).catch(()=>{});
            return false;
        }
        // Check bot permission and hierarchy
        const botMember = guild.members.me;
        if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            if (logChannel) logChannel.send(`⚠️ Missing Manage Roles permission.`).catch(()=>{});
            return false;
        }
        if (role.comparePositionTo(botMember.roles.highest) >= 0) {
            if (logChannel) logChannel.send(`⚠️ Elimination role is above my highest role.`).catch(()=>{});
            return false;
        }
        await member.roles.add(role, 'Ban Roulette elimination');
        return true;
    } catch (err) {
        console.error(`[BanRoulette] Failed to assign elimination role to ${userId}:`, err);
        return false;
    }
}

// ── Helper: remove elimination role ──────────────────────────
async function removeElimRole(guild, userId, logChannel = null) {
    try {
        const member = await guild.members.fetch(userId);
        if (!member) return false;
        const role = guild.roles.cache.get(ELIM_ROLE_ID);
        if (!role) return false;
        if (!member.roles.cache.has(role.id)) return true; // already not present
        const botMember = guild.members.me;
        if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) return false;
        if (role.comparePositionTo(botMember.roles.highest) >= 0) return false;
        await member.roles.remove(role, 'Ban Roulette victory');
        return true;
    } catch (err) {
        console.error(`[BanRoulette] Failed to remove elimination role from ${userId}:`, err);
        return false;
    }
}

// ── Helper: clear turn timeout ───────────────────────────────
function clearTurnTimeout(session) {
    if (session.turnTimeout) {
        clearTimeout(session.turnTimeout);
        session.turnTimeout = null;
    }
}

// ── Helper: schedule timeout for current player ──────────────
function scheduleTurnTimeout(session, interactionChannel) {
    clearTurnTimeout(session);
    if (session.status !== 'playing') return;

    const currentPlayer = session.players[session.turnIndex];
    if (!currentPlayer || currentPlayer.eliminated) return;

    session.turnTimeout = setTimeout(async () => {
        const freshSession = sessions.get(session.channelId);
        if (!freshSession || freshSession.status !== 'playing') return;
        if (freshSession.turnIndex !== session.turnIndex) return;

        const expiredPlayer = freshSession.players[freshSession.turnIndex];
        if (!expiredPlayer || expiredPlayer.eliminated) return;

        // Auto‑eliminate the inactive player
        expiredPlayer.eliminated = true;

        // Assign elimination role
        await assignElimRole(interactionChannel.guild, expiredPlayer.userId, interactionChannel);

        // Apply timeout penalty (voice / server mute equivalent)
        let timeoutNote = '';
        try {
            const guild = interactionChannel.guild;
            const member = await guild.members.fetch(expiredPlayer.userId);
            if (member && guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                if (guild.members.me.roles.highest.comparePositionTo(member.roles.highest) > 0) {
                    await member.timeout(TIMEOUT_MS, 'Ban Roulette - inactivity timeout');
                } else {
                    timeoutNote = ' (could not apply timeout — role too high)';
                }
            } else {
                timeoutNote = ' (missing Moderate Members permission)';
            }
        } catch (err) {
            timeoutNote = ' (timeout failed)';
        }

        const alivePlayers = freshSession.players.filter(p => !p.eliminated);

        if (alivePlayers.length <= 1) {
            freshSession.status = 'done';
            await refreshMessage(freshSession, `**TIME OUT!** <@${expiredPlayer.userId}> took too long and was eliminated.${timeoutNote}`);
            const winner = alivePlayers[0];
            if (winner) {
                // Remove elimination role from winner
                await removeElimRole(interactionChannel.guild, winner.userId, interactionChannel);
                await interactionChannel.send(`<@${winner.userId}> is the last one standing — **you win!**`);
            } else {
                await interactionChannel.send('Everyone is eliminated. No survivors.');
            }
            sessions.delete(freshSession.channelId);
            return;
        }

        // Advance to next alive player
        let next = (freshSession.turnIndex + 1) % freshSession.players.length;
        let safety = 0;
        while (freshSession.players[next].eliminated && safety < freshSession.players.length) {
            next = (next + 1) % freshSession.players.length;
            safety++;
        }
        freshSession.turnIndex = next;

        const nextPlayer = freshSession.players[freshSession.turnIndex];
        await refreshMessage(freshSession,
            `**TIME OUT!** <@${expiredPlayer.userId}> took too long and was eliminated.${timeoutNote} — <@${nextPlayer.userId}>, you're next.`
        );
        scheduleTurnTimeout(freshSession, interactionChannel);
    }, TURN_TIMEOUT_MS);
}

// ── Utility: draw canvas (unchanged) ─────────────────────────
async function renderCanvas(session) {
    const size = CANVAS_SIZE;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const layout = LAYOUTS[session.capacity];

    for (let slotIndex = 0; slotIndex < session.capacity; slotIndex++) {
        const pos = layout[slotIndex];
        const cx = Math.round(pos.x * size);
        const cy = Math.round(pos.y * size);
        const r = AVATAR_RADIUS;
        const player = session.players[slotIndex] || null;
        const isActive = session.status === 'playing' && slotIndex === session.turnIndex;
        const isEliminated = player && player.eliminated;

        if (!player) {
            ctx.strokeStyle = 'rgba(180,180,180,0.35)';
            ctx.lineWidth = 4;
            ctx.setLineDash([10, 8]);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            continue;
        }

        if (player.avatarBuffer) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            if (isEliminated) {
                const tmpCanvas = createCanvas(r * 2, r * 2);
                const tmpCtx = tmpCanvas.getContext('2d');
                tmpCtx.drawImage(player.avatarBuffer, 0, 0, r * 2, r * 2);
                const imgData = tmpCtx.getImageData(0, 0, r * 2, r * 2);
                const d = imgData.data;
                for (let p = 0; p < d.length; p += 4) {
                    const grey = 0.299 * d[p] + 0.587 * d[p+1] + 0.114 * d[p+2];
                    d[p] = d[p+1] = d[p+2] = grey * 0.65;
                }
                tmpCtx.putImageData(imgData, 0, 0);
                ctx.drawImage(tmpCanvas, cx - r, cy - r, r * 2, r * 2);
            } else {
                ctx.drawImage(player.avatarBuffer, cx - r, cy - r, r * 2, r * 2);
            }
            ctx.restore();
        }

        if (isActive) {
            ctx.strokeStyle = '#E74C3C';
            ctx.lineWidth = BORDER_WIDTH;
            ctx.shadowColor = '#ff000099';
            ctx.shadowBlur = 20;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else if (!isEliminated) {
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
            ctx.stroke();
        }

        if (isEliminated) {
            ctx.strokeStyle = '#ff000088';
            ctx.lineWidth = CROSS_WIDTH;
            ctx.lineCap = 'round';
            ctx.shadowColor = '#ff000088';
            ctx.shadowBlur = 12;
            const offset = r * 0.68;
            ctx.beginPath();
            ctx.moveTo(cx - offset, cy - offset);
            ctx.lineTo(cx + offset, cy + offset);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(cx + offset, cy - offset);
            ctx.lineTo(cx - offset, cy + offset);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#555';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    if (session.status === 'lobby') {
        const needed = session.capacity - session.players.length;
        if (needed > 0) {
            const footerText = `Waiting for ${needed} more player${needed !== 1 ? 's' : ''}...`;
            ctx.fillStyle = 'rgba(200,200,200,0.85)';
            ctx.font = `bold 32px "${FONT_FAMILY}"`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(footerText, size / 2, size - 20);
        }
    }
    return canvas.toBuffer('image/png');
}

// ── Fetch avatar (unchanged) ─────────────────────────────────
async function fetchAvatar(user) {
    const url = user.displayAvatarURL({ extension: 'png', size: 256 });
    try {
        return await loadImage(url);
    } catch {
        const tmpCanvas = createCanvas(256, 256);
        const ctx = tmpCanvas.getContext('2d');
        const hue = parseInt(user.id.slice(-4), 16) % 360;
        ctx.fillStyle = `hsl(${hue},60%,40%)`;
        ctx.beginPath(); ctx.arc(128, 128, 128, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `bold 96px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((user.username[0] || '?').toUpperCase(), 128, 128);
        return tmpCanvas;
    }
}

// ── Build action row (unchanged) ──────────────────────────────
function buildRow(session) {
    if (session.status === 'lobby') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('br_join').setLabel('Join Game').setStyle(ButtonStyle.Success).setDisabled(session.players.length >= session.capacity)
        );
    }
    if (session.status === 'playing') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('br_trigger').setLabel('Pull Trigger').setStyle(ButtonStyle.Danger)
        );
    }
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('br_noop').setLabel('Game Over').setStyle(ButtonStyle.Secondary).setDisabled(true)
    );
}

// ── Edit / send message (unchanged) ──────────────────────────
async function refreshMessage(session, content = '') {
    const imageBuffer = await renderCanvas(session);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'roulette.png' });
    const row = buildRow(session);
    if (session.message) {
        await session.message.edit({ content, embeds: [], components: [row], files: [attachment] });
    }
}

// ── /br command handler ──────────────────────────────────────
async function handleBrCommand(interaction) {
    if (interaction.user.id !== BR_ADMIN_ID && !isAuthorized(interaction.member || interaction.user)) {
        return interaction.reply({ content: 'Only authorized users can host Ban Roulette.', flags: 64 });
    }
    const channelId = interaction.channel.id;
    if (sessions.has(channelId)) {
        return interaction.reply({ content: 'A Ban Roulette session is already active in this channel.', flags: 64 });
    }
    const rawCapacity = interaction.options.getInteger('capacity') ?? 2;
    const rawProbability = interaction.options.getInteger('probability') ?? 6;
    const capacity = Math.max(2, Math.min(8, rawCapacity));
    const chamberSize = Math.max(2, Math.min(20, rawProbability));

    const session = {
        channelId,
        capacity,
        chamberSize,
        players: [],
        status: 'lobby',
        turnIndex: 0,
        roundNumber: 1,
        message: null,
        turnTimeout: null,
        autoCloseTimeout: null,
    };
    sessions.set(channelId, session);

    const imageBuffer = await renderCanvas(session);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'roulette.png' });
    const row = buildRow(session);
    const reply = await interaction.reply({ embeds: [], components: [row], files: [attachment], withResponse: true });
    session.message = reply.resource.message;

    // Auto-close the lobby if nobody joins within 10 seconds.
    session.autoCloseTimeout = setTimeout(async () => {
        const freshSession = sessions.get(channelId);
        if (!freshSession || freshSession.status !== 'lobby') return;
        if (freshSession.players.length > 0) return;

        sessions.delete(channelId);
        if (freshSession.message) {
            try {
                await freshSession.message.edit({
                    content: 'Ban Roulette lobby closed automatically — no one joined in time.',
                    embeds: [],
                    components: [],
                    files: [],
                });
            } catch { /* message may already be gone */ }
        }
    }, 10 * 1000);
}

// ── /brcancel command handler ────────────────────────────────
async function handleBrCancel(interaction) {
    if (interaction.user.id !== BR_ADMIN_ID && !isAuthorized(interaction.member || interaction.user)) {
        return interaction.reply({ content: 'Only the BR admin or authorized hosts can cancel a session.', flags: 64 });
    }
    const channelId = interaction.channel.id;
    const session = sessions.get(channelId);
    if (!session) {
        return interaction.reply({ content: 'No active session in this channel.', flags: 64 });
    }
    clearTurnTimeout(session);
    if (session.autoCloseTimeout) clearTimeout(session.autoCloseTimeout);
    sessions.delete(channelId);
    if (session.message) await session.message.delete().catch(() => {});
    await interaction.reply('Ban Roulette session cancelled.');
}

// ── Button: br_join ──────────────────────────────────────────
async function handleJoin(interaction) {
    const channelId = interaction.channel.id;
    const session = sessions.get(channelId);
    const userId = interaction.user.id;

    if (!session || session.status !== 'lobby') {
        return interaction.reply({ content: 'No active lobby in this channel.', flags: 64 });
    }
    if (session.players.some(p => p.userId === userId)) {
        return interaction.reply({ content: 'You have already joined this session.', flags: 64 });
    }
    if (session.players.length >= session.capacity) {
        return interaction.reply({ content: 'This lobby is full.', flags: 64 });
    }
    if (joiningUsers.has(userId)) {
        return interaction.reply({ content: 'You are already joining. Please wait.', flags: 64 });
    }
    joiningUsers.add(userId);
    try {
        await interaction.deferUpdate();
        if (session.players.some(p => p.userId === userId)) {
            await interaction.followUp({ content: 'You have already joined.', flags: 64 });
            return;
        }
        if (session.players.length >= session.capacity) {
            await interaction.followUp({ content: 'Lobby became full. Try again later.', flags: 64 });
            return;
        }
        const avatarBuffer = await fetchAvatar(interaction.user);
        session.players.push({
            userId, username: interaction.user.username,
            displayName: interaction.member?.displayName || interaction.user.displayName || interaction.user.username,
            avatarBuffer, eliminated: false,
        });
        if (session.autoCloseTimeout) {
            clearTimeout(session.autoCloseTimeout);
            session.autoCloseTimeout = null;
        }
        if (session.players.length === session.capacity) {
            session.status = 'playing';
            session.turnIndex = 0;
        }
        if (session.status === 'playing') {
            const activePlayer = session.players[session.turnIndex];
            await refreshMessage(session, `**Ban Roulette begins!** <@${activePlayer.userId}> goes first.`);
            scheduleTurnTimeout(session, interaction.channel);
        } else {
            await refreshMessage(session);
        }
    } finally {
        joiningUsers.delete(userId);
    }
}

// ── Button: br_trigger ───────────────────────────────────────
async function handleTrigger(interaction) {
    const channelId = interaction.channel.id;
    const session = sessions.get(channelId);
    if (!session || session.status !== 'playing') {
        return interaction.reply({ content: 'No active game in this channel.', flags: 64 });
    }
    const activePlayer = session.players[session.turnIndex];
    if (interaction.user.id !== activePlayer.userId) {
        return interaction.reply({ content: `It's <@${activePlayer.userId}>'s turn, not yours!`, flags: 64 });
    }
    if (interaction.acknowledged) {
        console.warn('Interaction already acknowledged, cannot deferUpdate');
        return;
    }
    await interaction.deferUpdate();

    // Clear the turn timer – player acted in time
    clearTurnTimeout(session);

    const bang = Math.random() < (1 / session.chamberSize);

    if (!bang) {
        // Survived: advance turn
        let next = (session.turnIndex + 1) % session.players.length;
        let safety = 0;
        while (session.players[next].eliminated && safety < session.players.length) {
            next = (next + 1) % session.players.length;
            safety++;
        }
        session.turnIndex = next;
        const nextPlayer = session.players[session.turnIndex];
        await refreshMessage(session, `*Click.* <@${activePlayer.userId}> survived. — <@${nextPlayer.userId}>, you're next.`);
        scheduleTurnTimeout(session, interaction.channel);
    } else {
        // BANG: eliminate
        activePlayer.eliminated = true;

        // Assign elimination role
        await assignElimRole(interaction.guild, activePlayer.userId, interaction.channel);

        // Apply timeout penalty
        let timeoutNote = '';
        try {
            const member = interaction.member ?? await interaction.guild.members.fetch(activePlayer.userId);
            if (member && interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                const botMember = interaction.guild.members.me;
                if (botMember.roles.highest.comparePositionTo(member.roles.highest) > 0) {
                    await member.timeout(TIMEOUT_MS, 'Ban Roulette elimination penalty');
                } else {
                    timeoutNote = ' (could not apply timeout — role too high)';
                }
            } else {
                timeoutNote = ' (missing Moderate Members permission)';
            }
        } catch (err) {
            if (err.code === 50013) timeoutNote = ' (timeout forbidden)';
            else console.error('[BanRoulette] Timeout error:', err);
        }

        const alivePlayers = session.players.filter(p => !p.eliminated);
        if (alivePlayers.length <= 1) {
            session.status = 'done';
            await refreshMessage(session, `**BANG!** <@${activePlayer.userId}> has been eliminated.${timeoutNote}`);
            const winner = alivePlayers[0];
            if (winner) {
                // Remove elimination role from winner
                await removeElimRole(interaction.guild, winner.userId, interaction.channel);
                await interaction.channel.send(`<@${winner.userId}> is the last one standing — **you win!**`);
            } else {
                await interaction.channel.send('Everyone is eliminated. No survivors.');
            }
            sessions.delete(channelId);
            return;
        }

        // Advance to next alive player
        let next = (session.turnIndex + 1) % session.players.length;
        let safety = 0;
        while (session.players[next].eliminated && safety < session.players.length) {
            next = (next + 1) % session.players.length;
            safety++;
        }
        session.turnIndex = next;
        const nextPlayer = session.players[session.turnIndex];
        await refreshMessage(session, `**BANG!** <@${activePlayer.userId}> has been eliminated.${timeoutNote} — <@${nextPlayer.userId}>, you're next.`);
        scheduleTurnTimeout(session, interaction.channel);
    }
}

// ── Master interaction router ────────────────────────────────
async function handleInteraction(interaction) {
    try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'br') {
            return await handleBrCommand(interaction);
        }
        if (interaction.isChatInputCommand() && interaction.commandName === 'brcancel') {
            return await handleBrCancel(interaction);
        }
        if (interaction.isButton()) {
            if (interaction.customId === 'br_join') return await handleJoin(interaction);
            if (interaction.customId === 'br_trigger') return await handleTrigger(interaction);
        }
    } catch (err) {
        console.error('[BanRoulette] Unhandled error:', err);
        const msg = 'An internal error occurred. The session may have been corrupted.';
        try {
            if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: 64 });
            else await interaction.reply({ content: msg, flags: 64 });
        } catch { /* swallow */ }
    }
}

module.exports = {
    commandData: [banRouletteCommand.toJSON(), brCancelCommand.toJSON()],
    handleInteraction,
};