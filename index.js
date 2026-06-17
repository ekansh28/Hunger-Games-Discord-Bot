require('dotenv').config();
const fs = require('fs'); 
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, PermissionsBitField, REST, Routes } = require('discord.js');
const EventLogic = require('./utils/eventLogic');
const ImageGenerator = require('./utils/imageGenerator');
const { commandData, handleInteraction: handleBrInteraction } = require('./banRoulette');
const setupMusic = require('./music');
const { authorizedUsers, authorizedRoles, isAuthorized } = require('./authorization');
const Infection = require('./infection');
const path = require('path');

// Role given to a user when they lose Ban Roulette (/br). Removed when that
// user wins either /br or the Hunger Games (=play).
const HG_ELIM_ROLE_ID = '1486781924671492266';

// Removes HG_ELIM_ROLE_ID from a winning user, if they have it.
async function removeElimRoleOnWin(guild, userId) {
    if (!guild || !userId) return;
    try {
        const role = guild.roles.cache.get(HG_ELIM_ROLE_ID);
        if (!role) return;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || !member.roles.cache.has(role.id)) return;
        const botMember = guild.members.me;
        if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
        if (role.comparePositionTo(botMember.roles.highest) >= 0) return;
        await member.roles.remove(role, 'Won Hunger Games');
    } catch (err) {
        console.error('Failed to remove elimination role after Hunger Games win:', err);
    }
}

// The participants map keeps every entrant (dead or alive) for the duration
// of the game, so the lone survivor is whoever still has alive === true.
function findAliveParticipantId(gameState) {
    for (const [id, p] of gameState.participants.entries()) {
        if (p.alive) return id;
    }
    return null;
}
function createBar(percent, length = 25) {
    const filled = Math.round((percent / 100) * length);

    return (
        '█'.repeat(filled) +
        '░'.repeat(length - filled)
    );
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,      // REQUIRED: privileged intent — enable in Discord Dev Portal too!
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,  // required for music playback (DisTube/@discordjs/voice)
    ]
});

const music = setupMusic(client);

const gameStates = new Map();

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [...commandData, ...music.commandData] }
        );
        console.log('Registered /br, /brcancel, and music slash commands.');
    } catch (err) {
        console.error('Failed to register slash commands:', err);
    }
});


client.on('messageCreate', async (message) => {
            if (message.guild && !message.author.bot && message.member && message.mentions.members.size > 0) {
                try {
                    if (Infection.isInfected(message.guild.id, message.member.id)) {
                        for (const [mentionedId, mentionedMember] of message.mentions.members) {
                            if (mentionedId === message.member.id) continue;
                            if (mentionedMember.user.bot) continue;
                            if (Infection.isInfected(message.guild.id, mentionedId)) continue;
                            if (Infection.isImmune(mentionedMember)) continue;
                            // Respect bump immunity
                            const immuneUntil = Infection.bumpImmunity.get(mentionedId);
                            if (immuneUntil && Date.now() < immuneUntil) continue;
                            await Infection.applyInfection(mentionedMember, message.member.id);
                        }
                    }
                } catch (err) {
                    console.error('[AIDS] spread error:', err);
                }
            }
            if (message.content === '=test') {
                const buffer = Buffer.from('Hello World');

                await message.reply({
                    files: [
                        {
                            attachment: buffer,
                            name: 'test.txt'
                        }
                    ]
                });

                return;
            }
    if (message.content === '=alabama') {
        if (!isAuthorized(message.member || message.author)) {
            return message.reply('Only authorized users can use this command.');
        }
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
            return message.reply('Join a voice channel first.');
        }

        try {
            const fileUrl = `file://${path.join(__dirname, 'alabama.mp3')}`;

            await music.distube.play(voiceChannel, fileUrl, {
                member: message.member,
                textChannel: message.channel,
                skip: true,
                metadata: { leaveOnFinish: true }
            });
            await message.reply('🤠 **Sweet Home Alabama!** (The bot will leave after the song finishes)');
        } catch (err) {
            console.error('[Alabama] error:', err);
            message.reply('❌ Failed to play alabama.mp3. Make sure the file exists and the bot has permissions.');
        }
        return;
    
    }

    if (message.content === '=play') {
        if (!isAuthorized(message.member || message.author)) {
            return message.reply('Only authorized users can start the game lobby.');
        }
        if (gameStates.has(message.channel.id)) {
            return message.reply('A game lobby is already open in this channel.');
        }

        const participants = new Map();
        gameStates.set(message.channel.id, {
            participants,
            deadParticipants: new Map(),
            status: 'lobby',
            gameLogic: null
        });

        const embed = new EmbedBuilder()
            .setTitle('Hunger Games Simulation Lobby')
            .setDescription('**Welcome to the arena!**\n\nClick the button below to join the deadly competition.\n\n**Participants:** 0/24')
            .setColor('#FFD700')
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('join_game').setLabel('Join Game').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('start_game').setLabel('Start Game').setStyle(ButtonStyle.Danger).setDisabled(true)
        );

        await message.reply({ embeds: [embed], components: [row] });
    }

    // Handle infection-related messages (info, tree, bump, infect, cure, etc.)
    await Infection.handleMessage(message);

    // ── =help ─────────────────────────────────────────────────────────────────
    if (message.content === '=help') {
        const embed = new EmbedBuilder()
            .setTitle('📖 Bot Command Reference')
            .setColor('#FFD700')
            .setDescription('All prefix commands use `=`. Slash commands use `/`.')
            .addFields(
                {
                    name: '🎮 Hunger Games  (`=play`)',
                    value: [
                        '`=play` — Open a game lobby *(authorized only)*',
                        '`=kill <@user|all>` — Eliminate a player mid-game *(admin only)*',
                        '`=addp <@user|@role>` — Authorize a user/role to host *(admin only)*',
                        '`=removep <@user|@role>` — Remove host authorization *(admin only)*',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '🎰 Ban Roulette  (`/br`)',
                    value: [
                        '`/br` — Start a Ban Roulette lobby *(authorized only)*',
                        '`/brcancel` — Cancel the current lobby *(authorized only)*',
                        'Players join via the button; last one standing wins.',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '🦠 AIDS / Infection',
                    value: [
                        '`=infect` — Infect yourself with the AIDS',
                        '`=cure [@user|all]` — Cure a user or everyone *(authorized only)*',
                        '`=infectioninfo` — Full outbreak report with banner image',
                        '  *Aliases:* `=AIDSinfo` `=outbreakstats` `=infected` `=infstats` `=infstat` `=vstat` `=vs`',
                        '`=infectiontree` / `=it` — Visual lineage tree of who infected whom',
                        '',
                        '**Spreading:** Infected users spread the AIDS by @mentioning healthy users.',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '🎵 Music',
                    value: [
                        '`/play` — Play a song',
                        '`=alabama` or `/alabama` — Play alabama.mp3 and leave *(authorized only)*',
                        '*(See slash command list for full music options)*',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '🔧 Other',
                    value: '`=test` — Test file attachment (debug)\n`=help` — Show this message',
                    inline: false,
                },
            )
            .setFooter({ text: 'Authorized = added via =addp, or the main server admin.' })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    }

    if (message.content.startsWith('=addp ')) {
        if (message.author.id !== process.env.AUTHORIZED_USER_ID) {
            return message.reply('Only the main admin can authorize users or roles.');
        }
        const args = message.content.slice(6).trim();
        let targetUserId = null, targetRoleId = null;

        if (args.startsWith('<@&') && args.endsWith('>')) {
            targetRoleId = args.slice(3, -1);
        } else if (/^\d{17,19}$/.test(args)) {
            const role = message.guild?.roles.cache.get(args);
            if (role) targetRoleId = args; else targetUserId = args;
        } else if (args.startsWith('<@') && args.endsWith('>')) {
            targetUserId = args.slice(2, -1).replace(/^!/, '');
        } else if (message.guild) {
            const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === args.toLowerCase());
            if (role) targetRoleId = role.id;
            else {
                const member = message.guild.members.cache.find(m => m.user.username.toLowerCase() === args.toLowerCase());
                if (member) targetUserId = member.user.id;
            }
        }

        if (targetRoleId) {
            if (authorizedRoles.has(targetRoleId)) return message.reply('Role is already authorized.');
            authorizedRoles.add(targetRoleId);
            const role = message.guild?.roles.cache.get(targetRoleId);
            message.reply(`Users with role **${role?.name || 'Unknown Role'}** can now host Hunger Games!`);
        } else if (targetUserId) {
            if (authorizedUsers.has(targetUserId)) return message.reply('User is already authorized.');
            authorizedUsers.add(targetUserId);
            message.reply(`<@${targetUserId}> can now host Hunger Games!`);
        } else {
            message.reply('User or role not found.');
        }
    }

    if (message.content.startsWith('=removep ')) {
        if (message.author.id !== process.env.AUTHORIZED_USER_ID) {
            return message.reply('Only the main admin can remove authorization.');
        }
        const args = message.content.slice(9).trim();
        let targetUserId = null, targetRoleId = null;

        if (args.startsWith('<@&') && args.endsWith('>')) {
            targetRoleId = args.slice(3, -1);
        } else if (/^\d{17,19}$/.test(args)) {
            if (authorizedRoles.has(args)) targetRoleId = args;
            else if (authorizedUsers.has(args)) targetUserId = args;
        } else if (args.startsWith('<@') && args.endsWith('>')) {
            targetUserId = args.slice(2, -1).replace(/^!/, '');
        } else if (message.guild) {
            const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === args.toLowerCase());
            if (role && authorizedRoles.has(role.id)) targetRoleId = role.id;
            else {
                const member = message.guild.members.cache.find(m => m.user.username.toLowerCase() === args.toLowerCase());
                if (member && authorizedUsers.has(member.user.id)) targetUserId = member.user.id;
            }
        }

        if (targetRoleId) {
            if (!authorizedRoles.has(targetRoleId)) return message.reply('Role is not authorized.');
            authorizedRoles.delete(targetRoleId);
            const role = message.guild?.roles.cache.get(targetRoleId);
            message.reply(`Removed authorization from role **${role?.name || 'Unknown Role'}**.`);
        } else if (targetUserId) {
            if (targetUserId === process.env.AUTHORIZED_USER_ID) return message.reply('Cannot remove authorization from the main admin.');
            if (!authorizedUsers.has(targetUserId)) return message.reply('User is not authorized.');
            authorizedUsers.delete(targetUserId);
            message.reply(`Removed authorization from <@${targetUserId}>.`);
        } else {
            message.reply('User or role not found in authorized list.');
        }
    }

    if (message.content.startsWith('=kill ')) {
        if (message.author.id !== process.env.AUTHORIZED_USER_ID) {
            return message.reply('Only the main admin can use this command.');
        }
        const gameState = gameStates.get(message.channel.id);
        if (!gameState || gameState.status !== 'running') {
            return message.reply('No active game in this channel.');
        }

        const args = message.content.slice(6).trim();

        if (args.toLowerCase() === 'all') {
            let killCount = 0;
            for (const [userId, userData] of gameState.participants.entries()) {
                if (userData.alive && userId !== message.author.id) {
                    userData.alive = false;
                    gameState.deadParticipants.set(userId, userData);
                    gameState.gameLogic.stageDeaths.push({ username: userData.username, displayName: userData.displayName || userData.username, avatarURL: userData.avatarURL });
                    killCount++;
                }
            }
            if (killCount > 0) {
                message.reply(`Admin eliminated ${killCount} tributes!`);
                setTimeout(async () => {
                    const ig = new ImageGenerator();
                    try {
                        const buf = await ig.generateFallenTributesImage(gameState.gameLogic.stageDeaths);
                        if (buf) await message.channel.send({ files: [new AttachmentBuilder(buf, { name: 'admin-elimination.png' })] });
                    } catch (e) { console.error(e); }
                    setTimeout(async () => {
                        const adminUser = await client.users.fetch(message.author.id);
                        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('ADMIN VICTORY').setDescription(`**${adminUser.displayName || adminUser.username}** wins by admin override!`).setColor('#FFD700').setThumbnail(adminUser.displayAvatarURL()).setTimestamp()] });
                        await removeElimRoleOnWin(message.guild, message.author.id);
                        gameStates.delete(message.channel.id);
                    }, 6000);
                }, 6000);
            } else {
                message.reply('No living tributes to eliminate.');
            }
            return;
        }

        let targetUserId = null;
        if (args.startsWith('<@') && args.endsWith('>')) {
            targetUserId = args.slice(2, -1).replace(/^!/, '');
        } else if (/^\d{17,19}$/.test(args)) {
            targetUserId = args;
        } else {
            for (const [userId, userData] of gameState.participants.entries()) {
                if (userData.username.toLowerCase() === args.toLowerCase() || (userData.displayName && userData.displayName.toLowerCase() === args.toLowerCase())) {
                    targetUserId = userId; break;
                }
            }
        }

        if (!targetUserId || !gameState.participants.has(targetUserId)) return message.reply('User not found in current game.');
        const targetUser = gameState.participants.get(targetUserId);
        if (!targetUser.alive) return message.reply('User is already dead.');

        targetUser.alive = false;
        gameState.deadParticipants.set(targetUserId, targetUser);
        gameState.gameLogic.stageDeaths.push({ username: targetUser.username, displayName: targetUser.displayName || targetUser.username, avatarURL: targetUser.avatarURL });
        message.reply(`Admin eliminated **${targetUser.displayName || targetUser.username}** from the game!`);

        if (gameState.gameLogic.getAliveCount() <= 1) {
            setTimeout(async () => {
                const ig = new ImageGenerator();
                try {
                    const buf = await ig.generateFallenTributesImage([{ username: targetUser.username, displayName: targetUser.displayName || targetUser.username, avatarURL: targetUser.avatarURL }]);
                    if (buf) await message.channel.send({ files: [new AttachmentBuilder(buf, { name: 'admin-kill.png' })] });
                } catch (e) { console.error(e); }
                const winner = gameState.gameLogic.getWinner();
                if (winner) {
                    await message.channel.send({ embeds: [new EmbedBuilder().setTitle('VICTORY').setDescription(`**${winner.displayName || winner.username}** has won the Hunger Games!`).setColor('#FFD700').setThumbnail(winner.avatarURL).setTimestamp()] });
                    await removeElimRoleOnWin(message.guild, findAliveParticipantId(gameState));
                }
                gameStates.delete(message.channel.id);
            }, 6000);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand() && music.commandNames.has(interaction.commandName)) {
            return music.handleInteraction(interaction);
        }

        if (
            (interaction.isChatInputCommand() && (interaction.commandName === 'br' || interaction.commandName === 'brcancel')) ||
            (interaction.isButton() && interaction.customId.startsWith('br_'))
        ) {
            return handleBrInteraction(interaction);
        }

        if (!interaction.isButton()) return;

        const gameState = gameStates.get(interaction.channel.id);
        if (!gameState) return;

        if (interaction.customId === 'join_game') {
            if (gameState.status !== 'lobby') return interaction.reply({ content: 'The game has already started!', flags: 64 });
            if (gameState.participants.has(interaction.user.id)) return interaction.reply({ content: 'You are already in the game!', flags: 64 });
            if (gameState.participants.size >= 24) return interaction.reply({ content: 'The game is full!', flags: 64 });

            gameState.participants.set(interaction.user.id, {
                username: interaction.user.username,
                displayName: interaction.user.displayName,
                avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
                alive: true
            });

            const participantList = Array.from(gameState.participants.keys()).map(id => `<@${id}>`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle('Hunger Games Simulation Lobby')
                .setDescription(`**Welcome to the arena!**\n\nClick the button below to join the deadly competition.\n\n**Participants:** ${gameState.participants.size}/24\n${participantList}`)
                .setColor('#FFD700').setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join_game').setLabel('Join Game').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('start_game').setLabel('Start Game').setStyle(ButtonStyle.Danger).setDisabled(gameState.participants.size < 4)
            );

            try {
                await interaction.update({ embeds: [embed], components: [row] });
            } catch (err) {
                if (err?.code !== 10062) console.error('join_game update error:', err);
            }
        }

        if (interaction.customId === 'start_game') {
            if (!isAuthorized(interaction.member || interaction.user)) return interaction.reply({ content: 'Only authorized users can start the game!', flags: 64 });
            if (gameState.participants.size < 4) return interaction.reply({ content: 'At least 4 participants are needed!', flags: 64 });

            gameState.status = 'running';
            gameState.gameLogic = new EventLogic(gameState.participants);

            const embed = new EmbedBuilder().setTitle('Game Starting!').setDescription('The Hunger Games simulation is about to begin...\n\n**May the odds be ever in your favor!**').setColor('#FF4444').setTimestamp();
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join_game').setLabel('Join Game').setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId('start_game').setLabel('Start Game').setStyle(ButtonStyle.Danger).setDisabled(true)
            );

            try {
                await interaction.update({ embeds: [embed], components: [disabledRow] });
            } catch (err) {
                if (err?.code !== 10062) console.error('start_game update error:', err);
            }

            setTimeout(async () => { await startGameSimulation(interaction.channel, gameState); }, 3000);
        }
    } catch (err) {
        if (err?.code !== 10062) console.error('[interactionCreate] error:', err);
    }
});

async function startGameSimulation(channel, gameState) {
    const { gameLogic } = gameState;
    const imageGenerator = new ImageGenerator();
    let isFirstImage = true;

    while (gameLogic.getAliveCount() > 1) {
        const currentStage = gameLogic.getCurrentStage();
        const events = gameLogic.getEventsForCurrentStage();
        const batchSize = Math.min(6, Math.max(3, Math.ceil(events.length / 3)));

        for (let i = 0; i < events.length; i += batchSize) {
            const eventBatch = events.slice(i, i + batchSize);
            if (!isFirstImage) await new Promise(r => setTimeout(r, 6000));
            isFirstImage = false;

            try {
                const imageBuffer = await imageGenerator.generateEventImage(currentStage.title, currentStage.subtitle || '', eventBatch);
                await channel.send({ files: [new AttachmentBuilder(imageBuffer, { name: 'hunger-games-event.png' })] });
            } catch (error) {
                console.error('Error generating image:', error);
                const fallbackEmbed = new EmbedBuilder().setDescription(eventBatch.map(e => e.text).join('\n')).setColor('#FF6B35');
                await channel.send({ embeds: [fallbackEmbed] });
            }
        }

        const fallenTributes = gameLogic.getStageDeaths();
        if (fallenTributes.length > 0) {
            await new Promise(r => setTimeout(r, 6000));
            try {
                const fallenImageBuffer = await imageGenerator.generateFallenTributesImage(fallenTributes);
                if (fallenImageBuffer) await channel.send({ files: [new AttachmentBuilder(fallenImageBuffer, { name: 'fallen-tributes.png' })] });
            } catch (error) { console.error('Error generating fallen tributes image:', error); }
        }

        gameLogic.nextStage();
        if (gameLogic.getAliveCount() > 1) await new Promise(r => setTimeout(r, 6000));
    }

    await new Promise(r => setTimeout(r, 6000));
    const winner = gameLogic.getWinner();
    const winnerEmbed = new EmbedBuilder()
        .setTitle('VICTORY')
        .setDescription(`**${winner.displayName || winner.username}** has won the Hunger Games!\n\n*Congratulations, you have survived the arena!*`)
        .setColor('#FFD700').setThumbnail(winner.avatarURL).setTimestamp();
    await channel.send({ embeds: [winnerEmbed] });
    await removeElimRoleOnWin(channel.guild, findAliveParticipantId(gameState));
    gameStates.delete(channel.id);
}

client.on('error', (err) => {
    if (err?.code !== 10062) console.error('[Discord client error]', err);
});

client.login(process.env.DISCORD_TOKEN);