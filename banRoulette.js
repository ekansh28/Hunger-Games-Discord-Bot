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

// Register bundled font so text renders on Railway/Linux
try {
    registerFont(path.join(__dirname, 'fonts', 'Inter.ttf'), { family: 'Inter' });
} catch (e) {
    console.warn('[BanRoulette] Could not register font:', e.message);
}

// ── Constants ────────────────────────────────────────────────
const CANVAS_SIZE   = 1200;
const AVATAR_RADIUS = 110;         // px — radius of each avatar circle
const BORDER_WIDTH  = 12;           // px — active-turn highlight ring
const CROSS_WIDTH   = 28;          // px — elimination X stroke width

const TIMEOUT_MS = 5 * 1000; // 5-second ban penalty meaning


// ── Admin ─────────────────────────────────────────────────────
const BR_ADMIN_ID = '1198980443823947927';

// ── Session store  (channel.id → session) ───────────────────
const sessions = new Map();

// ── Lock to prevent duplicate joins ──────────────────────────
const joiningUsers = new Set();

// ── Avatar-position layouts  (cx, cy in 0-1 relative coords) ─
const LAYOUTS = {
    2: [
        { x: 0.50, y: 0.25 },
        { x: 0.50, y: 0.75 },
    ],
    3: [
        { x: 0.50, y: 0.18 },
        { x: 0.18, y: 0.73 },
        { x: 0.82, y: 0.73 },
    ],
    4: [
        { x: 0.50, y: 0.15 },
        { x: 0.85, y: 0.50 },
        { x: 0.50, y: 0.85 },
        { x: 0.15, y: 0.50 },
    ],
    5: [
        { x: 0.50, y: 0.12 },
        { x: 0.87, y: 0.38 },
        { x: 0.75, y: 0.80 },
        { x: 0.25, y: 0.80 },
        { x: 0.13, y: 0.38 },
    ],
    6: (function () {
        const pts = [];
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 2) + (i * (2 * Math.PI / 6));
            pts.push({
                x: 0.50 + 0.35 * Math.cos(angle),
                y: 0.50 - 0.35 * Math.sin(angle),
            });
        }
        return pts;
    }()),
    7: (function () {
        // 6 on a circle, 1 in the centre
        const pts = [];
        // 6 outer
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 2) + (i * (2 * Math.PI / 6));
            pts.push({
                x: 0.50 + 0.35 * Math.cos(angle),
                y: 0.50 - 0.35 * Math.sin(angle),
            });
        }
        // centre
        pts.push({ x: 0.50, y: 0.50 });
        return pts;
    }()),
    8: (function () {
        const pts = [];
        for (let i = 0; i < 8; i++) {
            const angle = (Math.PI / 2) + (i * (2 * Math.PI / 8));
            pts.push({
                x: 0.50 + 0.38 * Math.cos(angle),
                y: 0.50 - 0.38 * Math.sin(angle),
            });
        }
        return pts;
    }()),
};

// ── Slash command definitions ────────────────────────────────
const banRouletteCommand = new SlashCommandBuilder()
    .setName('br')
    .setDescription('Start a Ban Roulette session in this channel.')
    .addIntegerOption(opt =>
        opt.setName('capacity')
            .setDescription('Number of players (2–8). Default: 2')
            .setMinValue(2)
            .setMaxValue(8)
            .setRequired(false))
    .addIntegerOption(opt =>
        opt.setName('probability')
            .setDescription('1-in-N chance of getting banned per trigger pull. Default: 6')
            .setMinValue(2)
            .setMaxValue(20)
            .setRequired(false));

const brCancelCommand = new SlashCommandBuilder()
    .setName('brcancel')
    .setDescription('Cancel the active Ban Roulette session in this channel.');

// ── Timer helpers ────────────────────────────────────────────

// Clear the lobby expiry timer
function clearLobbyTimer(session) {
    if (session.lobbyTimer) { clearTimeout(session.lobbyTimer); session.lobbyTimer = null; }
}

// Clear the active-turn countdown timer
function clearTurnTimer(session) {
    if (session.turnTimer) { clearTimeout(session.turnTimer); session.turnTimer = null; }
}

// Tear down a session: clear timers, disable the message buttons, remove from map
async function closeSession(session, reason) {
    clearLobbyTimer(session);
    clearTurnTimer(session);
    sessions.delete(session.channelId);
    session.status = 'done';

    try {
        if (session.message) {
            const deadRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('br_noop')
                    .setLabel('Cancelled')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
            await session.message.edit({ content: reason, components: [deadRow], files: [] });
        }
    } catch { /* message may already be deleted */ }
}

// Apply 5-min timeout, return a note string on failure
async function applyTimeout(guild, userId) {
    try {
        const member = await guild.members.fetch(userId);
        if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
            return ' (missing Moderate Members permission)';
        }
        if (guild.members.me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
            return ' (could not apply timeout — role too high)';
        }
        await member.timeout(TIMEOUT_MS, 'Ban Roulette elimination penalty');
        return '';
    } catch (err) {
        if (err.code === 50013) return ' (timeout forbidden)';
        console.error('[BanRoulette] Timeout error:', err);
        return '';
    }
}

// Start the 10-second turn countdown; auto-eliminate if it fires
function startTurnTimer(session, channel) {
    clearTurnTimer(session);
    session.turnTimer = setTimeout(async () => {
        // Confirm session still active and it's the same player's turn
        if (!sessions.has(session.channelId) || session.status !== 'playing') return;

        const activePlayer = session.players[session.turnIndex];
        activePlayer.eliminated = true;

        const timeoutNote = await applyTimeout(channel.guild, activePlayer.userId);

        const alivePlayers = session.players.filter(p => !p.eliminated);

        if (alivePlayers.length <= 1) {
            session.status = 'done';
            await refreshMessage(session,
                `**Time's up!** <@${activePlayer.userId}> took too long and has been eliminated.${timeoutNote}`
            );
            const winner = alivePlayers[0];
            if (winner) {
                await channel.send(`<@${winner.userId}> is the last one standing — **you win!**`);
            } else {
                await channel.send('Everyone is eliminated. No survivors.');
            }
            sessions.delete(session.channelId);
            return;
        }

        // Advance turn
        let next = (session.turnIndex + 1) % session.players.length;
        let safety = 0;
        while (session.players[next].eliminated && safety < session.players.length) {
            next = (next + 1) % session.players.length;
            safety++;
        }
        session.turnIndex = next;
        const firstAliveIndex = session.players.findIndex(p => !p.eliminated);
        if (session.turnIndex === firstAliveIndex) session.roundNumber++;

        const nextPlayer = session.players[session.turnIndex];
        await refreshMessage(session,
            `**Time's up!** <@${activePlayer.userId}> took too long and has been eliminated.${timeoutNote} — <@${nextPlayer.userId}>, you're next.`
        );
        // Restart timer for next player
        startTurnTimer(session, channel);
    }, 10_000);
}

// ── Utility: draw canvas and return PNG buffer ────────────────
async function renderCanvas(session) {
    const size = CANVAS_SIZE;
    const canvas = createCanvas(size, size);
    const ctx    = canvas.getContext('2d');

    // Transparent background — no fill

    // ── Player slots ────────────────────────────────────────
    const layout = LAYOUTS[session.capacity];

    for (let slotIndex = 0; slotIndex < session.capacity; slotIndex++) {
        const pos    = layout[slotIndex];
        const cx     = Math.round(pos.x * size);
        const cy     = Math.round(pos.y * size);
        const r      = AVATAR_RADIUS;
        const player = session.players[slotIndex] || null;

        const isActive     = session.status === 'playing' && slotIndex === session.turnIndex;
        const isEliminated = player && player.eliminated;

        // ── Empty slot placeholder ───────────────────────────
        if (!player) {
            ctx.strokeStyle = 'rgba(180,180,180,0.35)';
            ctx.lineWidth   = 4;
            ctx.setLineDash([10, 8]);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            continue;
        }

        // ── Draw avatar image ─────────────────────────────────
        if (player.avatarBuffer) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();

            if (isEliminated) {
                const tmpCanvas = createCanvas(r * 2, r * 2);
                const tmpCtx    = tmpCanvas.getContext('2d');
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

        // ── Active-turn highlight ring ────────────────────────
        if (isActive) {
            ctx.strokeStyle = '#E74C3C';
            ctx.lineWidth   = BORDER_WIDTH;
            ctx.shadowColor = '#ff000099';
            ctx.shadowBlur  = 20;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else if (!isEliminated) {
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth   = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
            ctx.stroke();
        }

        // ── Eliminated overlay: red X ─────────────────────────
        if (isEliminated) {
            ctx.strokeStyle = '#ff000088';
            ctx.lineWidth   = CROSS_WIDTH;
            ctx.lineCap     = 'round';
            ctx.shadowColor = '#ff000088';
            ctx.shadowBlur  = 12;

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
            ctx.lineWidth   = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    // ── Waiting text (lobby only) ────────────────────────────
    if (session.status === 'lobby') {
        const needed = session.capacity - session.players.length;
        if (needed > 0) {
            const footerText = `Waiting for ${needed} more player${needed !== 1 ? 's' : ''}...`;
            ctx.fillStyle    = 'rgba(200,200,200,0.85)';
            ctx.font         = 'bold 32px Inter';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(footerText, size / 2, size - 20);
        }
    }

    return canvas.toBuffer('image/png');
}

// ── Fetch user avatar as a canvas Image object ────────────────
async function fetchAvatar(user) {
    const url = user.displayAvatarURL({ extension: 'png', size: 256 });
    try {
        return await loadImage(url);
    } catch {
        // Fallback: coloured circle with initials
        const tmpCanvas = createCanvas(256, 256);
        const ctx       = tmpCanvas.getContext('2d');
        const hue       = parseInt(user.id.slice(-4), 16) % 360;
        ctx.fillStyle   = `hsl(${hue},60%,40%)`;
        ctx.beginPath(); ctx.arc(128, 128, 128, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle   = '#fff';
        ctx.font        = 'bold 96px Inter';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((user.username[0] || '?').toUpperCase(), 128, 128);
        return tmpCanvas;
    }
}

// ── Build action row ──────────────────────────────────────────
function buildRow(session) {
    if (session.status === 'lobby') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('br_join')
                .setLabel('Join Game')
                .setStyle(ButtonStyle.Success)
                .setDisabled(session.players.length >= session.capacity)
        );
    }
    if (session.status === 'playing') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('br_trigger')
                .setLabel('Pull Trigger')
                .setStyle(ButtonStyle.Danger)
        );
    }
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('br_noop')
            .setLabel('Game Over')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
    );
}

// ── Edit (or send) the main game message ─────────────────────
async function refreshMessage(session, content = '') {
    const imageBuffer = await renderCanvas(session);
    const attachment  = new AttachmentBuilder(imageBuffer, { name: 'roulette.png' });
    const row         = buildRow(session);

    if (session.message) {
        await session.message.edit({ content, embeds: [], components: [row], files: [attachment] });
    }
}

// ── /br slash command handler ─────────────────────────────────
async function handleBrCommand(interaction) {
    // Non-admin: acknowledge silently so Discord doesn't show "did not respond"
    if (interaction.user.id !== BR_ADMIN_ID) {
        return interaction.reply({ content: '\u200b', flags: 64 });
    }

    const channelId = interaction.channel.id;

    if (sessions.has(channelId)) {
        return interaction.reply({ content: 'A Ban Roulette session is already active in this channel.', flags: 64 });
    }

    // Defer immediately — canvas render can take a moment and must not breach the 3s window
    try {
        await interaction.deferReply();
    } catch {
        // Interaction token already expired (e.g. bot restarted mid-session) — bail silently
        sessions.delete(channelId);
        return;
    }

    const rawCapacity    = interaction.options.getInteger('capacity')    ?? 2;
    const rawProbability = interaction.options.getInteger('probability') ?? 6;
    const capacity       = Math.max(2, Math.min(8, rawCapacity));
    const chamberSize    = Math.max(2, Math.min(20, rawProbability));

    const session = {
        channelId,
        capacity,
        chamberSize,
        players:     [],
        status:      'lobby',
        turnIndex:   0,
        roundNumber: 1,
        message:     null,
    };

    sessions.set(channelId, session);

    const imageBuffer = await renderCanvas(session);
    const attachment  = new AttachmentBuilder(imageBuffer, { name: 'roulette.png' });
    const row         = buildRow(session);

    const reply = await interaction.editReply({ content: '', embeds: [], components: [row], files: [attachment] });
    session.message = reply;

    // Auto-close lobby after 60 seconds if not enough players joined
    session.lobbyTimer = setTimeout(async () => {
        if (!sessions.has(channelId) || session.status !== 'lobby') return;
        await closeSession(session, 'Lobby closed — not enough players joined in time.');
    }, 60_000);
}

// ── Button: br_join ───────────────────────────────────────────
async function handleJoin(interaction) {
    const channelId = interaction.channel.id;
    const session   = sessions.get(channelId);
    const userId    = interaction.user.id;

    if (!session || session.status !== 'lobby') {
        return interaction.reply({ content: 'No active lobby in this channel.', flags: 64 });
    }

    // Quick check
    if (session.players.some(p => p.userId === userId)) {
        return interaction.reply({ content: 'You have already joined this session.', flags: 64 });
    }

    if (session.players.length >= session.capacity) {
        return interaction.reply({ content: 'This lobby is full.', flags: 64 });
    }

    // Prevent concurrent join attempts for the same user
    if (joiningUsers.has(userId)) {
        return interaction.reply({ content: 'You are already joining. Please wait.', flags: 64 });
    }
    joiningUsers.add(userId);

    try {
        try {
            await interaction.deferUpdate();
        } catch {
            return;
        }

        // Re-check after defer – race condition window is now closed
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
            userId:      userId,
            username:    interaction.user.username,
            displayName: interaction.member?.displayName || interaction.user.displayName || interaction.user.username,
            avatarBuffer,
            eliminated:  false,
        });

        // If lobby is now full, transition to playing
        if (session.players.length === session.capacity) {
            session.status = 'playing';
            session.turnIndex = 0;
        }

        if (session.status === 'playing') {
            clearLobbyTimer(session);
            const activePlayer = session.players[session.turnIndex];
            await refreshMessage(session, `**Ban Roulette begins!** <@${activePlayer.userId}> goes first.`);
            startTurnTimer(session, interaction.channel);
        } else {
            await refreshMessage(session);
        }
    } finally {
        joiningUsers.delete(userId);
    }
}

// ── Button: br_trigger ────────────────────────────────────────
async function handleTrigger(interaction) {
    const channelId = interaction.channel.id;
    const session   = sessions.get(channelId);

    if (!session || session.status !== 'playing') {
        return interaction.reply({ content: 'No active game in this channel.', flags: 64 });
    }

    const activePlayer = session.players[session.turnIndex];

    if (interaction.user.id !== activePlayer.userId) {
        return interaction.reply({
            content: `It's <@${activePlayer.userId}>'s turn, not yours!`,
            flags: 64,
        });
    }

    try {
        await interaction.deferUpdate();
    } catch {
        return;
    }

    // Player acted — cancel the countdown
    clearTurnTimer(session);

    // ── Roll the chamber ─────────────────────────────────────
    const bang = Math.random() < (1 / session.chamberSize);

    if (!bang) {
        // ── Survived: advance turn and edit the message ──────
        let next = (session.turnIndex + 1) % session.players.length;
        let safety = 0;
        while (session.players[next].eliminated && safety < session.players.length) {
            next = (next + 1) % session.players.length;
            safety++;
        }
        session.turnIndex = next;

        const firstAliveIndex = session.players.findIndex(p => !p.eliminated);
        if (session.turnIndex === firstAliveIndex) session.roundNumber++;

        const nextPlayer = session.players[session.turnIndex];
        await refreshMessage(session,
            `*Click.* <@${activePlayer.userId}> survived. — <@${nextPlayer.userId}>, you're next.`
        );
        startTurnTimer(session, interaction.channel);

    } else {
        // ── BANG: eliminate ──────────────────────────────────
        activePlayer.eliminated = true;

        // Apply 5-minute timeout
        const timeoutNote = await applyTimeout(interaction.guild, activePlayer.userId);

        // ── Check win condition ──────────────────────────────
        const alivePlayers = session.players.filter(p => !p.eliminated);

        if (alivePlayers.length <= 1) {
            session.status = 'done';

            // Edit the game message one last time to show the eliminated state, no button
            await refreshMessage(session,
                `**BANG!** <@${activePlayer.userId}> has been eliminated.${timeoutNote}`
            );

            // Then send the winner as a fresh message
            const winner = alivePlayers[0];
            if (winner) {
                await interaction.channel.send(
                    `<@${winner.userId}> is the last one standing — **you win!**`
                );
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

        const firstAliveIndex = session.players.findIndex(p => !p.eliminated);
        if (session.turnIndex === firstAliveIndex) session.roundNumber++;

        const nextPlayer = session.players[session.turnIndex];
        await refreshMessage(session,
            `**BANG!** <@${activePlayer.userId}> has been eliminated.${timeoutNote} — <@${nextPlayer.userId}>, you're next.`
        );
        startTurnTimer(session, interaction.channel);
    }
}

// ── /brcancel command handler ────────────────────────────────
async function handleBrCancel(interaction) {
    if (interaction.user.id !== BR_ADMIN_ID) {
        return interaction.reply({ content: '​', flags: 64 });
    }

    const session = sessions.get(interaction.channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active Ban Roulette session in this channel.', flags: 64 });
    }

    await interaction.reply({ content: 'Session cancelled.', flags: 64 });
    await closeSession(session, 'Session was cancelled by the admin.');
}

// ── Master interaction router ─────────────────────────────────
async function handleInteraction(interaction) {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'br')       return await handleBrCommand(interaction);
            if (interaction.commandName === 'brcancel') return await handleBrCancel(interaction);
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'br_join')    return await handleJoin(interaction);
            if (interaction.customId === 'br_trigger') return await handleTrigger(interaction);
        }
    } catch (err) {
        // Ignore stale/expired interaction errors — they happen on bot restarts and are harmless
        if (err?.code === 10062) return;
        console.error('[BanRoulette] Unhandled error in interaction handler:', err);
    }
}

// ── Exports ───────────────────────────────────────────────────
module.exports = {
    /** Array of SlashCommandBuilder data — pass both to REST deployer */
    commandData: [banRouletteCommand.toJSON(), brCancelCommand.toJSON()],

    /** Wire this into your client.on('interactionCreate', …) handler */
    handleInteraction,
};

/* ================================================================
   INTEGRATION GUIDE (unchanged)
   ================================================================ */