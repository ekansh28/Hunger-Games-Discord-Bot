require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, REST, Routes } = require('discord.js');
const EventLogic = require('./utils/eventLogic');
const ImageGenerator = require('./utils/imageGenerator');
const { commandData, handleInteraction: handleBrInteraction } = require('./banRoulette');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const gameStates = new Map();
const authorizedUsers = new Set([process.env.AUTHORIZED_USER_ID]);
const authorizedRoles = new Set();

function isAuthorized(memberOrUser) {
    const userId = memberOrUser.id || memberOrUser.user?.id;

    if (authorizedUsers.has(userId)) {
        return true;
    }

    if (memberOrUser.roles && memberOrUser.roles.cache) {
        return memberOrUser.roles.cache.some(role => authorizedRoles.has(role.id));
    }

    return false;
}

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Register the /br slash command
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        // Registers to all guilds the bot is in; swap to per-guild if preferred
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [commandData] }
        );
        console.log('Registered /br slash command.');
    } catch (err) {
        console.error('Failed to register /br slash command:', err);
    }
});

client.on('messageCreate', async (message) => {
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

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('join_game')
                    .setLabel('Join Game')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('start_game')
                    .setLabel('Start Game')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

        await message.reply({ embeds: [embed], components: [row] });
    }

    if (message.content.startsWith('=addp ')) {
        if (message.author.id !== process.env.AUTHORIZED_USER_ID) {
            return message.reply('Only the main admin can authorize users or roles.');
        }

        const args = message.content.slice(6).trim();
        let targetUserId = null;
        let targetRoleId = null;

        if (args.startsWith('<@&') && args.endsWith('>')) {
            targetRoleId = args.slice(3, -1);
        } else if (/^\d{17,19}$/.test(args)) {
            const guild = message.guild;
            if (guild) {
                const role = guild.roles.cache.get(args);
                if (role) {
                    targetRoleId = args;
                } else {
                    targetUserId = args;
                }
            }
        } else if (args.startsWith('<@') && args.endsWith('>')) {
            targetUserId = args.slice(2, -1);
            if (targetUserId.startsWith('!')) {
                targetUserId = targetUserId.slice(1);
            }
        } else {
            const guild = message.guild;
            if (guild) {
                const role = guild.roles.cache.find(r => r.name.toLowerCase() === args.toLowerCase());
                if (role) {
                    targetRoleId = role.id;
                } else {
                    const member = guild.members.cache.find(m => m.user.username.toLowerCase() === args.toLowerCase());
                    if (member) {
                        targetUserId = member.user.id;
                    }
                }
            }
        }

        if (targetRoleId) {
            if (authorizedRoles.has(targetRoleId)) {
                return message.reply('Role is already authorized.');
            }
            authorizedRoles.add(targetRoleId);
            const guild = message.guild;
            const role = guild?.roles.cache.get(targetRoleId);
            message.reply(`Users with role **${role?.name || 'Unknown Role'}** can now host Hunger Games!`);
        } else if (targetUserId) {
            if (authorizedUsers.has(targetUserId)) {
                return message.reply('User is already authorized.');
            }
            authorizedUsers.add(targetUserId);
            message.reply(`<@${targetUserId}> can now host Hunger Games!`);
        } else {
            return message.reply('User or role not found. Use @mention, @role, ID, username, or role name.');
        }
    }

    if (message.content.startsWith('=removep ')) {
        if (message.author.id !== process.env.AUTHORIZED_USER_ID) {
            return message.reply('Only the main admin can remove authorization.');
        }

        const args = message.content.slice(9).trim();
        let targetUserId = null;
        let targetRoleId = null;

        if (args.startsWith('<@&') && args.endsWith('>')) {
            targetRoleId = args.slice(3, -1);
        } else if (/^\d{17,19}$/.test(args)) {
            if (authorizedRoles.has(args)) {
                targetRoleId = args;
            } else if (authorizedUsers.has(args)) {
                targetUserId = args;
            }
        } else if (args.startsWith('<@') && args.endsWith('>')) {
            targetUserId = args.slice(2, -1);
            if (targetUserId.startsWith('!')) {
                targetUserId = targetUserId.slice(1);
            }
        } else {
            const guild = message.guild;
            if (guild) {
                const role = guild.roles.cache.find(r => r.name.toLowerCase() === args.toLowerCase());
                if (role && authorizedRoles.has(role.id)) {
                    targetRoleId = role.id;
                } else {
                    const member = guild.members.cache.find(m => m.user.username.toLowerCase() === args.toLowerCase());
                    if (member && authorizedUsers.has(member.user.id)) {
                        targetUserId = member.user.id;
                    }
                }
            }
        }

        if (targetRoleId) {
            if (!authorizedRoles.has(targetRoleId)) {
                return message.reply('Role is not authorized.');
            }
            authorizedRoles.delete(targetRoleId);
            const guild = message.guild;
            const role = guild?.roles.cache.get(targetRoleId);
            message.reply(`Removed authorization from role **${role?.name || 'Unknown Role'}**.`);
        } else if (targetUserId) {
            if (targetUserId === config.authorizedUserId) {
                return message.reply('Cannot remove authorization from the main admin.');
            }
            if (!authorizedUsers.has(targetUserId)) {
                return message.reply('User is not authorized.');
            }
            authorizedUsers.delete(targetUserId);
            message.reply(`Removed authorization from <@${targetUserId}>.`);
        } else {
            return message.reply('User or role not found in authorized list.');
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
                    if (!gameState.deadParticipants) {
                        gameState.deadParticipants = new Map();
                    }
                    gameState.deadParticipants.set(userId, userData);
                    if (!gameState.gameLogic.stageDeaths) {
                        gameState.gameLogic.stageDeaths = [];
                    }
                    gameState.gameLogic.stageDeaths.push({
                        username: userData.username,
                        displayName: userData.displayName || userData.username,
                        avatarURL: userData.avatarURL
                    });
                    killCount++;
                }
            }

            if (killCount > 0) {
                message.reply(`Admin eliminated ${killCount} tributes! Only the admin survives.`);

                setTimeout(async () => {
                    const imageGenerator = new ImageGenerator();
                    try {
                        const fallenImageBuffer = await imageGenerator.generateFallenTributesImage(gameState.gameLogic.stageDeaths);
                        if (fallenImageBuffer) {
                            const fallenAttachment = new AttachmentBuilder(fallenImageBuffer, { name: 'admin-elimination.png' });
                            await message.channel.send({ files: [fallenAttachment] });
                        }
                    } catch (error) {
                        console.error('Error generating admin elimination image:', error);
                    }

                    setTimeout(async () => {
                        const adminUser = await client.users.fetch(message.author.id);
                        const winnerEmbed = new EmbedBuilder()
                            .setTitle('ADMIN VICTORY')
                            .setDescription(`**${adminUser.displayName || adminUser.username}** wins by admin override!\n\n*The odds were definitely in your favor.*`)
                            .setColor('#FFD700')
                            .setThumbnail(adminUser.displayAvatarURL())
                            .setTimestamp();

                        await message.channel.send({ embeds: [winnerEmbed] });
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
            targetUserId = args.slice(2, -1);
            if (targetUserId.startsWith('!')) {
                targetUserId = targetUserId.slice(1);
            }
        } else if (/^\d{17,19}$/.test(args)) {
            targetUserId = args;
        } else {
            for (const [userId, userData] of gameState.participants.entries()) {
                if (userData.username.toLowerCase() === args.toLowerCase() ||
                    (userData.displayName && userData.displayName.toLowerCase() === args.toLowerCase())) {
                    targetUserId = userId;
                    break;
                }
            }
        }

        if (!targetUserId || !gameState.participants.has(targetUserId)) {
            return message.reply('User not found in current game.');
        }

        const targetUser = gameState.participants.get(targetUserId);
        if (!targetUser.alive) {
            return message.reply('User is already dead.');
        }

        targetUser.alive = false;
        if (!gameState.deadParticipants) {
            gameState.deadParticipants = new Map();
        }
        gameState.deadParticipants.set(targetUserId, targetUser);
        if (!gameState.gameLogic.stageDeaths) {
            gameState.gameLogic.stageDeaths = [];
        }
        gameState.gameLogic.stageDeaths.push({
            username: targetUser.username,
            displayName: targetUser.displayName || targetUser.username,
            avatarURL: targetUser.avatarURL
        });

        message.reply(`Admin eliminated **${targetUser.displayName || targetUser.username}** from the game!`);

        const aliveCount = gameState.gameLogic.getAliveCount();
        if (aliveCount <= 1) {
            setTimeout(async () => {
                const imageGenerator = new ImageGenerator();
                try {
                    const fallenImageBuffer = await imageGenerator.generateFallenTributesImage([{
                        username: targetUser.username,
                        displayName: targetUser.displayName || targetUser.username,
                        avatarURL: targetUser.avatarURL
                    }]);
                    if (fallenImageBuffer) {
                        const fallenAttachment = new AttachmentBuilder(fallenImageBuffer, { name: 'admin-kill.png' });
                        await message.channel.send({ files: [fallenAttachment] });
                    }
                } catch (error) {
                    console.error('Error generating admin kill image:', error);
                }

                if (aliveCount === 1) {
                    const winner = gameState.gameLogic.getWinner();
                    const winnerDisplayName = winner.displayName || winner.username;
                    const winnerEmbed = new EmbedBuilder()
                        .setTitle('VICTORY')
                        .setDescription(`**${winnerDisplayName}** has won the Hunger Games!\n\n*Congratulations, you have survived the arena!*`)
                        .setColor('#FFD700')
                        .setThumbnail(winner.avatarURL)
                        .setTimestamp();

                    await message.channel.send({ embeds: [winnerEmbed] });
                }
                gameStates.delete(message.channel.id);
            }, 6000);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
    // Route /br slash command and br_* buttons to the Ban Roulette module
    if (
        (interaction.isChatInputCommand() && interaction.commandName === 'br') ||
        (interaction.isButton() && interaction.customId.startsWith('br_'))
    ) {
        return handleBrInteraction(interaction);
    }

    // Hunger Games button handling
    if (!interaction.isButton()) return;

    const gameState = gameStates.get(interaction.channel.id);
    if (!gameState) return;

    if (interaction.customId === 'join_game') {
        if (gameState.status !== 'lobby') {
            return interaction.reply({ content: 'The game has already started!', flags: 64 });
        }

        if (gameState.participants.has(interaction.user.id)) {
            return interaction.reply({ content: 'You are already in the game!', flags: 64 });
        }

        if (gameState.participants.size >= 24) {
            return interaction.reply({ content: 'The game is full (24 participants maximum)!', flags: 64 });
        }

        gameState.participants.set(interaction.user.id, {
            username: interaction.user.username,
            displayName: interaction.user.displayName,
            avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
            alive: true
        });

        const participantList = Array.from(gameState.participants.keys())
            .map(id => `<@${id}>`)
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('Hunger Games Simulation Lobby')
            .setDescription(`**Welcome to the arena!**\n\nClick the button below to join the deadly competition.\n\n**Participants:** ${gameState.participants.size}/24\n${participantList}`)
            .setColor('#FFD700')
            .setTimestamp();

        const startDisabled = gameState.participants.size < 4;
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('join_game')
                    .setLabel('Join Game')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('start_game')
                    .setLabel('Start Game')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(startDisabled)
            );

        try {
            await interaction.update({ embeds: [embed], components: [row] });
        } catch (err) {
            if (err?.code !== 10062) console.error('join_game update error:', err);
        }
    }

    if (interaction.customId === 'start_game') {
        if (!isAuthorized(interaction.member || interaction.user)) {
            return interaction.reply({ content: 'Only authorized users can start the game!', flags: 64 });
        }

        if (gameState.participants.size < 4) {
            return interaction.reply({ content: 'At least 4 participants are needed to start the game!', flags: 64 });
        }

        gameState.status = 'running';
        gameState.gameLogic = new EventLogic(gameState.participants);

        const embed = new EmbedBuilder()
            .setTitle('Game Starting!')
            .setDescription('The Hunger Games simulation is about to begin...\n\n**May the odds be ever in your favor!**')
            .setColor('#FF4444')
            .setTimestamp();

        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('join_game')
                    .setLabel('Join Game')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('start_game')
                    .setLabel('Start Game')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

        try {
            await interaction.update({ embeds: [embed], components: [disabledRow] });
        } catch (err) {
            if (err?.code !== 10062) console.error('start_game update error:', err);
        }

        setTimeout(async () => {
            await startGameSimulation(interaction.channel, gameState);
        }, 3000);
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

            if (!isFirstImage) {
                await new Promise(resolve => setTimeout(resolve, 6000));
            }
            isFirstImage = false;

            try {
                const imageBuffer = await imageGenerator.generateEventImage(
                    currentStage.title,
                    currentStage.subtitle || '',
                    eventBatch
                );

                const attachment = new AttachmentBuilder(imageBuffer, { name: 'hunger-games-event.png' });
                await channel.send({ files: [attachment] });
            } catch (error) {
                console.error('Error generating image:', error);

                const eventText = eventBatch.map(event => event.text).join('\n');
                const fallbackEmbed = new EmbedBuilder()
                    .setDescription(eventText)
                    .setColor('#FF6B35');
                await channel.send({ embeds: [fallbackEmbed] });
            }
        }

        const fallenTributes = gameLogic.getStageDeaths();
        if (fallenTributes.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 6000));

            try {
                const fallenImageBuffer = await imageGenerator.generateFallenTributesImage(fallenTributes);
                if (fallenImageBuffer) {
                    const fallenAttachment = new AttachmentBuilder(fallenImageBuffer, { name: 'fallen-tributes.png' });
                    await channel.send({ files: [fallenAttachment] });
                }
            } catch (error) {
                console.error('Error generating fallen tributes image:', error);
            }
        }

        gameLogic.nextStage();

        if (gameLogic.getAliveCount() > 1) {
            await new Promise(resolve => setTimeout(resolve, 6000));
        }
    }

    await new Promise(resolve => setTimeout(resolve, 6000));

    const winner = gameLogic.getWinner();
    const winnerDisplayName = winner.displayName || winner.username;
    const winnerEmbed = new EmbedBuilder()
        .setTitle('VICTORY')
        .setDescription(`**${winnerDisplayName}** has won the Hunger Games!\n\n*Congratulations, you have survived the arena!*`)
        .setColor('#FFD700')
        .setThumbnail(winner.avatarURL)
        .setTimestamp();

    await channel.send({ embeds: [winnerEmbed] });
    gameStates.delete(channel.id);
}

// Prevent unhandled Discord API errors from crashing the process
client.on('error', (err) => {
    if (err?.code !== 10062) console.error('[Discord client error]', err);
});

client.login(process.env.DISCORD_TOKEN);