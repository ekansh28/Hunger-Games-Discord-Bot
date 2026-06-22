require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder, StringSelectMenuBuilder } = require('discord.js');
const EventLogic = require('./utils/eventLogic');
const ImageGenerator = require('./utils/imageGenerator');
const { commandData, handleInteraction: handleBrInteraction, handleBrPrefixCommand } = require('./banRoulette');
const setupMusic = require('./music');
const { authorizedUsers, authorizedRoles, isAuthorized } = require('./authorization');
const Infection = require('./infection');
const Stats = require('./stats');
const LastFm = require('./utils/lastfm');
const path = require('path');
const { handleGeoGuesser, handleGgLeaderboard, populateCache } = require('./geoguesser');
const { handleAiChat } = require('./aiChat');

const HG_ELIM_ROLE_ID = '1486781924671492266';

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

function findAliveParticipantId(gameState) {
    for (const [id, p] of gameState.participants.entries()) {
        if (p.alive) return id;
    }
    return null;
}

async function resolveUser(guild, arg) {
    if (!arg) return null;
    const mentionMatch = arg.match(/^<@!?(\d+)>$/);
    const idMatch = arg.match(/^(\d{17,19})$/);
    const rawId = mentionMatch?.[1] || idMatch?.[1];

    if (rawId) {
        try {
            const member = await guild.members.fetch(rawId);
            return member.user;
        } catch {
            return null;
        }
    }
    
    try {
        const members = await guild.members.fetch({ query: arg, limit: 1 });
        if (members.size > 0) return members.first().user;
    } catch {}
    
    return null;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
    ],
    allowedMentions: { parse: [] }  // ← add this
});

const music = setupMusic(client);
const gameStates = new Map();

const statsSlashCommand = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View player statistics.')
    .addUserOption(opt =>
        opt.setName('user')
            .setDescription('The user to look up (defaults to yourself)')
            .setRequired(false)
    );

const leaderboardSlashCommand = new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the leaderboard for a tracked word.')
    .addStringOption(opt =>
        opt.setName('word')
            .setDescription('The word to check')
            .setRequired(true)
            .addChoices(...Stats.TRACKED_WORDS.map(w => ({ name: w, value: w })))
    );

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    populateCache();
    await Infection.load();
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [...commandData, ...music.commandData, statsSlashCommand.toJSON(), leaderboardSlashCommand.toJSON()] }
        );
        console.log('Registered slash commands.');
    } catch (err) {
        console.error('Failed to register slash commands:', err);
    }
});

function buildStatsEmbed(targetUser, targetMember, stats) {
    const displayName = targetMember?.displayName || targetUser.displayName || targetUser.username;
    const embed = new EmbedBuilder()
        .setColor('#e94560')
        .setTitle(`📊 ${displayName}'s Stats`)
        .setThumbnail(targetUser.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
            { name: 'Hunger Games Wins', value: stats.hgWins.toLocaleString(), inline: true },
            { name: 'Ban Roulette Wins', value: stats.brWins.toLocaleString(), inline: true },
            { name: 'People Infected', value: stats.infectionsSpread.toLocaleString(), inline: true },
            { name: 'GeoGuesser Wins', value: (stats.ggWins || 0).toLocaleString(), inline: true },
        )
        .setTimestamp();

    for (const word of Stats.TRACKED_WORDS) {
        const wStat = stats.words[word] || { count: 0, rank: '?' };
        embed.addFields({
            name: `Word: "${word}"`,
            value: `Count: **${wStat.count.toLocaleString()}**\nRank: **#${wStat.rank}**`,
            inline: true
        });
    }

    return embed;
}

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const BUMP_IMMUNE_ROLE_ID = '1482008255554125844';
    const AIDS_ROLE_ID = '1516529671855018004';
    
    // Check if they just received the bump role
    if (!oldMember.roles.cache.has(BUMP_IMMUNE_ROLE_ID) && newMember.roles.cache.has(BUMP_IMMUNE_ROLE_ID)) {
        // If they have the AIDS role, cure them instantly
        if (newMember.roles.cache.has(AIDS_ROLE_ID)) {
            try {
                await Infection.removeInfection(newMember);
            } catch (err) {
                console.error('[AIDS] Failed to automatically cure member on bump:', err);
            }
        }
    }
});

client.on('messageCreate', async (message) => {
    // ── Monkeypatch message.reply for Safety ──────────────────────────────────
    // If a message is deleted by AutoMod or an Admin before the bot replies,
    // the standard reply() method throws 50035 Unknown Message and crashes.
    const originalReply = message.reply.bind(message);
    message.reply = async function (options) {
        try {
            return await originalReply(options);
        } catch (err) {
            if (err.code === 10008 || err.code === 50035) {
                const mention = `<@${message.author.id}> `;
                if (typeof options === 'string') {
                    return await message.channel.send(mention + options).catch(() => {});
                } else if (typeof options === 'object') {
                    options.content = options.content ? mention + options.content : mention;
                    delete options.reply; // Prevent referencing the deleted message
                    return await message.channel.send(options).catch(() => {});
                }
            }
            throw err;
        }
    };

    // ── Infection spreading ───────────────────────────────────────────────────
    if (message.guild && !message.author.bot && message.member && message.mentions.members.size > 0) {
        try {
            if (Infection.isInfected(message.guild.id, message.member.id)) {
                for (const [mentionedId, mentionedMember] of message.mentions.members) {
                    if (mentionedId === message.member.id) continue;
                    if (mentionedMember.user.bot) continue;
                    if (Infection.isInfected(message.guild.id, mentionedId)) continue;
                    if (Infection.isImmune(mentionedMember)) continue;
                    await Infection.applyInfection(mentionedMember, message.member.id);
                }
            }
        } catch (err) {
            console.error('[AIDS] spread error:', err);
        }
    }

    // ── Word tracking ─────────────────────────────────────────────────────────
    if (message.guild && !message.author.bot) {
        try {
            Stats.trackMessage(message.guild.id, message.author.id, message.content);
        } catch (err) {
            console.error('[Stats] trackMessage error:', err);
        }
    }

    // ── =test ─────────────────────────────────────────────────────────────────
    if (message.content === '=test') {
        const buffer = Buffer.from('Hello World');
        await message.reply({ files: [{ attachment: buffer, name: 'test.txt' }] });
        return;
    }

    const contentLower = message.content.toLowerCase();

    // ── =edit (Image Editor) ─────────────────────────────────────────────
    if (contentLower.startsWith('=edit ') || contentLower === '=edit') {
        const { handleEditCommand } = require('./editImage');
        await handleEditCommand(message);
        return;
    }

    // ── =disable-edit / =enable-edit (Admin) ─────────────────────────────
    if (contentLower.startsWith('=disable-edit') || contentLower.startsWith('=enable-edit')) {
        const { isAuthorized } = require('./authorization');
        if (!isAuthorized(message.member)) {
            return message.channel.send(`<@${message.author.id}> You are not authorized to use this command.`);
        }
        const { blockedEditUsers } = require('./editImage');
        const target = message.mentions.users.first();
        if (!target) {
            return message.channel.send(`<@${message.author.id}> Please mention a user. Usage: \`=disable-edit @user\``);
        }
        if (contentLower.startsWith('=disable-edit')) {
            blockedEditUsers.add(target.id);
            return message.channel.send(`✅ <@${target.id}> has been blocked from using \`=edit\`.`);
        } else {
            blockedEditUsers.delete(target.id);
            return message.channel.send(`✅ <@${target.id}> can now use \`=edit\` again.`);
        }
    }

    // ── =p / =pt (Pirate Translator) ──────────────────────────────────────────
    if (contentLower === '=p' || contentLower === '=pt' || contentLower.startsWith('=p ') || contentLower.startsWith('=pt ')) {
        const handlePirateCommand = require('./pirate');
        await handlePirateCommand(message);
        return;
    }

    // ── =stats ────────────────────────────────────────────────────────────────
    if (message.content.startsWith('=stats') || message.content.startsWith('=stat ') || message.content === '=stat' || message.content.startsWith('=s ') || message.content === '=s') {
        const cmdPrefix = message.content.split(' ')[0];
        const args = message.content.slice(cmdPrefix.length).trim();
        let targetUser = message.author;
        let targetMember = message.member;

        if (args) {
            const resolved = await resolveUser(message.guild, args);
            if (resolved) {
                targetUser = resolved;
                targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
            } else {
                return message.reply(`Could not find user: ${args}`);
            }
        }

        const stats = await Stats.getStats(message.guild?.id, targetUser.id);
        return message.reply({ embeds: [buildStatsEmbed(targetUser, targetMember, stats)] });
    }

    // ── =leaderboard ──────────────────────────────────────────────────────────
    if (message.content.startsWith('=leaderboard') || message.content.startsWith('=lb') || message.content.startsWith('=top') || message.content.startsWith('=board')) {
        const cmdPrefix = message.content.split(' ')[0];
        const args = message.content.slice(cmdPrefix.length).trim().toLowerCase();
        const word = args || Stats.TRACKED_WORDS[0];
        
        if (!Stats.TRACKED_WORDS.includes(word)) {
            return message.reply(`Word not tracked. Tracked words: ${Stats.TRACKED_WORDS.join(', ')}`);
        }

        const lb = await Stats.getLeaderboard(message.guild?.id, word, 10);
        
        const embed = new EmbedBuilder()
            .setTitle(`Leaderboard: "${word}"`)
            .setColor('#FFD700')
            .setTimestamp();
            
        if (lb.length === 0) {
            embed.setDescription('No stats recorded for this word yet.');
        } else {
            const desc = lb.map((entry, idx) => {
                const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**${idx + 1}.**`;
                return `${medal} <@${entry.userId}> — **${entry.count.toLocaleString()}**`;
            }).join('\n\n');
            embed.setDescription(desc);
        }
        
        return message.reply({ embeds: [embed] });
    }

    // ── =setlastfm ────────────────────────────────────────────────────────────
    if (contentLower.startsWith('=setlastfm')) {
        const username = message.content.slice(10).trim();
        if (!username) return message.reply('Please provide your Last.fm username. Usage: `=setlastfm <username>`');
        await Stats.setLastFmUser(message.author.id, username);
        return message.reply(`✅ Linked Last.fm account: **${username}**`);
    }

    // ── =nichemeter ───────────────────────────────────────────────────────────
    if (contentLower.startsWith('=nichemeter') || contentLower.startsWith('=nm ') || contentLower === '=nm') {
        const cmdPrefix = message.content.split(' ')[0];
        const args = message.content.slice(cmdPrefix.length).trim();
        let targetUser = message.author;
        
        if (args) {
            const resolved = await resolveUser(message.guild, args);
            if (resolved) {
                targetUser = resolved;
            } else {
                return message.reply(`Could not find user: ${args}`);
            }
        }

        const lastfmUser = await Stats.getLastFmUser(targetUser.id);
        if (!lastfmUser) {
            return message.reply(`${targetUser.username} has not linked their Last.fm account yet. Use \`=setlastfm <username>\`.`);
        }

        const loadingMsg = await message.reply('🎵 Analyzing listening history...');
        try {
            const score = await LastFm.getNicheScore(lastfmUser);
            const progressBar = LastFm.generateProgressBar(score);
            const embed = new EmbedBuilder()
                .setTitle(`${targetUser.username}'s Niche Meter`)
                .setDescription(`**Last.fm Username:** [${lastfmUser}](https://last.fm/user/${lastfmUser})\n\n${progressBar}`)
                .setColor('#d51007')
                .setThumbnail(targetUser.displayAvatarURL({ extension: 'png', size: 256 }));
            await loadingMsg.edit({ content: null, embeds: [embed] });
        } catch (err) {
            await loadingMsg.edit(`Error: ${err.message}`);
        }
        return;
    }

    // ── =br ───────────────────────────────────────────────────────────────────
    if (contentLower.startsWith('=br')) {
        await handleBrPrefixCommand(message);
        return;
    }

    // ── =gg ───────────────────────────────────────────────────────────────────
    if (contentLower === '=gg' || contentLower === '=geoguesser') {
        await handleGeoGuesser(message);
        return;
    }

    // ── =ggleaderboard ────────────────────────────────────────────────────────
    if (contentLower === '=ggleaderboard' || contentLower === '=gglb') {
        await handleGgLeaderboard(message);
        return;
    }

    // ── =boob ─────────────────────────────────────────────────────────────────
    if (contentLower.startsWith('=boob')) {
        const width = await Stats.getOrGenerateBoobSize(message.author.id);
        let name = '';
        if (width === 0) name = "Flat as a board (AA)";
        else if (width <= 2) name = "A Cup";
        else if (width <= 4) name = "B Cup";
        else if (width <= 6) name = "C Cup";
        else if (width <= 8) name = "D Cup";
        else if (width <= 10) name = "DD Cup";
        else if (width <= 15) name = "E Cup";
        else if (width <= 20) name = "DDDDDDDDDDDDD";
        else if (width <= 30) name = "Mega Ultra Z+";
        else if (width <= 40) name = "Galactic Milkers";
        else name = "Planet Destroyers 🌍";

        let visual = "";
        if (width === 0) {
            visual = "( )";
        } else {
            const spaces = ' '.repeat(width);
            visual = `(${spaces}Y${spaces})`;
        }

        return message.reply(`Your boob size is: **${name}**\n\`${visual}\``);
    }

    // ── =nichebattle ──────────────────────────────────────────────────────────
    if (contentLower.startsWith('=nichebattle') || contentLower.startsWith('=nb ') || contentLower === '=nb') {
        const cmdPrefix = message.content.split(' ')[0];
        const argsStr = message.content.slice(cmdPrefix.length).trim();
        const args = argsStr ? argsStr.split(/\s+/) : [];
        
        if (args.length === 0) return message.reply('Please mention 1 or 2 users to battle! (e.g. `=nb @user`)');
        
        let u1, u2;
        if (args.length === 1) {
            u1 = message.author;
            u2 = await resolveUser(message.guild, args[0]);
            if (!u2) return message.reply(`Could not find user: ${args[0]}`);
        } else {
            u1 = await resolveUser(message.guild, args[0]);
            u2 = await resolveUser(message.guild, args[1]);
            if (!u1) return message.reply(`Could not find user: ${args[0]}`);
            if (!u2) return message.reply(`Could not find user: ${args[1]}`);
        }

        if (u1.id === u2.id) return message.reply("You can't battle yourself!");

        const lfm1 = await Stats.getLastFmUser(u1.id);
        const lfm2 = await Stats.getLastFmUser(u2.id);

        if (!lfm1) return message.reply(`${u1.username} has not linked their Last.fm account yet. Please use \`=setlastfm <username>\` first.`);
        if (!lfm2) return message.reply(`${u2.username} has not linked their Last.fm account yet. Please use \`=setlastfm <username>\` first.`);

        const loadingMsg = await message.reply('⚔️ Analyzing both libraries and generating battle image...');
        
        try {
            const [score1, score2] = await Promise.all([
                LastFm.getNicheScore(lfm1),
                LastFm.getNicheScore(lfm2)
            ]);

            let winnerText = '';
            let winnerIndex = 0;
            if (score1 > score2) {
                winnerText = `🏆 **${u1.username}** is more niche!`;
                winnerIndex = 1;
            } else if (score2 > score1) {
                winnerText = `🏆 **${u2.username}** is more niche!`;
                winnerIndex = 2;
            } else {
                winnerText = "🤝 It's a tie!";
                winnerIndex = 0;
            }

            const imageGen = new ImageGenerator();
            const buffer = await imageGen.generateNicheBattleImage(
                u1.displayAvatarURL({ extension: 'png', size: 256 }),
                u2.displayAvatarURL({ extension: 'png', size: 256 }),
                winnerIndex
            );

            const attachment = new AttachmentBuilder(buffer, { name: 'nichebattle.png' });

            const embed = new EmbedBuilder()
                .setTitle(`Niche Battle: ${u1.username} vs ${u2.username}`)
                .setColor('#d51007')
                .setImage('attachment://nichebattle.png')
                .addFields(
                    { name: u1.username, value: LastFm.generateProgressBar(score1), inline: false },
                    { name: u2.username, value: LastFm.generateProgressBar(score2), inline: false }
                )
                .setDescription(winnerText);

            await loadingMsg.edit({ content: null, embeds: [embed], files: [attachment] });
        } catch (err) {
            await loadingMsg.edit(`Error: ${err.message}`);
        }
        return;
    }

    // ── =resetdb ──────────────────────────────────────────────────────────────
    if (message.content === '=resetdb') {
        if (message.author.id !== process.env.AUTHORIZED_USER_ID) {
            return message.reply('Only the main admin can reset the database.');
        }
        await Stats.resetDatabase();
        return message.reply('✅ **The database has been completely reset.** All stats are wiped.');
    }

    // ── =alabama ──────────────────────────────────────────────────────────────
    if (message.content === '=alabama') {
        if (!isAuthorized(message.member || message.author)) {
            return message.reply('Only authorized users can use this command.');
        }
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) return message.reply('Join a voice channel first.');
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

    // ── =play ─────────────────────────────────────────────────────────────────
    if (message.content === '=play') {
        if (gameStates.has(message.channel.id)) {
            return message.reply('A game is already active in this channel. Use `=cancel` to end it first.');
        }

        const openLobby = async (hostUser) => {
            const participants = new Map();
            gameStates.set(message.channel.id, {
                participants,
                deadParticipants: new Map(),
                status: 'lobby',
                gameLogic: null,
                cancelled: false,
                hostId: hostUser.id
            });

            const embed = new EmbedBuilder()
                .setTitle('Hunger Games Simulation Lobby')
                .setDescription(`**Welcome to the arena!**\nHosted by **${hostUser.username}**\n\nClick the button below to join the deadly competition.\n\n**Participants:** 0/24`)
                .setColor('#FFD700')
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join_game').setLabel('Join Game').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('start_game').setLabel('Start Game').setStyle(ButtonStyle.Danger).setDisabled(true)
            );

            await message.channel.send({ embeds: [embed], components: [row] });
        };

        if (!isAuthorized(message.member || message.author)) {
            await message.react('✅');
            
            const filter = (reaction) => reaction.emoji.name === '✅';
            const collector = message.createReactionCollector({ filter, time: 300000 }); // 5 minutes

            collector.on('collect', async (reaction) => {
                if (reaction.count >= 4) {
                    collector.stop('passed');
                    if (gameStates.has(message.channel.id)) {
                        await message.channel.send('A game was already started by someone else in this channel!');
                    } else {
                        await openLobby(message.author);
                    }
                }
            });

            return;
        }

        await openLobby(message.author);
        return;
    }

    // ── =cancel ───────────────────────────────────────────────────────────────
    if (message.content === '=cancel') {
        const gameState = gameStates.get(message.channel.id);
        if (!gameState) {
            return message.reply('No active game in this channel.');
        }

        if (!isAuthorized(message.member || message.author) && message.author.id !== gameState.hostId) {
            return message.reply('Only authorized users or the game host can cancel the game.');
        }

        gameState.cancelled = true;
        gameStates.delete(message.channel.id);

        const embed = new EmbedBuilder()
            .setTitle('Game Cancelled')
            .setDescription('The Hunger Games have been cancelled by an authorized user. The arena is empty.')
            .setColor('#888888')
            .setTimestamp();
        return message.reply({ embeds: [embed] });
    }

    // ── Handle infection messages ─────────────────────────────────────────────
    await Infection.handleMessage(message);

    // ── =help ─────────────────────────────────────────────────────────────────
    if (message.content === '=help') {
        const handleHelpCommand = require('./helpCommand');
        handleHelpCommand(message);
        return;
    }

    // ── =addp ─────────────────────────────────────────────────────────────────
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
        return;
    }

    // ── =removep ──────────────────────────────────────────────────────────────
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
        return;
    }

    // ── =kill ─────────────────────────────────────────────────────────────────
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
                        if (message.guild) Stats.addHgWin(message.guild.id, message.author.id);
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
                const winnerId = findAliveParticipantId(gameState);
                if (winner) {
                    await message.channel.send({ embeds: [new EmbedBuilder().setTitle('VICTORY').setDescription(`**${winner.displayName || winner.username}** has won the Hunger Games!`).setColor('#FFD700').setThumbnail(winner.avatarURL).setTimestamp()] });
                    if (message.guild && winnerId) Stats.addHgWin(message.guild.id, winnerId);
                    await removeElimRoleOnWin(message.guild, winnerId);
                }
                gameStates.delete(message.channel.id);
            }, 6000);
        }
        return;
    }

    // ── AI Chat (Ekansh Persona) ──────────────────────────────────────────────
    if (message.guild && !message.author.bot) {
        const botMention = `<@${client.user.id}>`;
        const botMentionOld = `<@!${client.user.id}>`;
        
        const isMentioned = message.content.includes(botMention) || message.content.includes(botMentionOld);
        const startsWithEkansh = contentLower.startsWith('ekansh');

        if (isMentioned || startsWithEkansh) {
            // Strip the mention/prefix for the prompt
            let promptText = message.content
                .replace(new RegExp(`${botMention}\\s*`), '')
                .replace(new RegExp(`${botMentionOld}\\s*`), '');
            
            if (startsWithEkansh) {
                // Remove the word 'ekansh' from the start, case insensitive
                promptText = promptText.replace(/^ekansh\s*/i, '');
            }
            
            promptText = promptText.trim();

            if (promptText.length > 0) {
                let repliedMessageContext = null;
                if (message.reference && message.reference.messageId) {
                    try {
                        const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
                        if (repliedMsg) {
                            repliedMessageContext = {
                                author: repliedMsg.author.username,
                                content: repliedMsg.content
                            };
                        }
                    } catch (e) {
                        console.error('[AiChat] Failed to fetch referenced message:', e);
                    }
                }

                await handleAiChat(message, promptText, repliedMessageContext);
                return; // Stop processing other stuff if it's an AI chat request
            }
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        // ── /stats slash command ──────────────────────────────────
        if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const targetMember = interaction.options.getMember('user') || interaction.member;
            const stats = await Stats.getStats(interaction.guild?.id, targetUser.id);
            return interaction.reply({ embeds: [buildStatsEmbed(targetUser, targetMember, stats)] });
        }

        // ── /leaderboard slash command ────────────────────────────
        if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
            const word = interaction.options.getString('word');
            const lb = await Stats.getLeaderboard(interaction.guild?.id, word, 10);
            
            const embed = new EmbedBuilder()
                .setTitle(`🏆 Leaderboard: "${word}"`)
                .setColor('#FFD700')
                .setTimestamp();
                
            if (lb.length === 0) {
                embed.setDescription('No stats recorded for this word yet.');
            } else {
                const desc = lb.map((entry, idx) => {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**${idx + 1}.**`;
                    return `${medal} <@${entry.userId}> — **${entry.count.toLocaleString()}**`;
                }).join('\n\n');
                embed.setDescription(desc);
            }
            
            return interaction.reply({ embeds: [embed] });
        }

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
            if (!isAuthorized(interaction.member || interaction.user) && interaction.user.id !== gameState.hostId) {
                return interaction.reply({ content: 'Only authorized users or the lobby host can start the game!', flags: 64 });
            }
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

            setTimeout(async () => { await startGameSimulation(interaction.channel, gameState, interaction.guild); }, 3000);
        }
    } catch (err) {
        if (err?.code !== 10062) console.error('[interactionCreate] error:', err);
    }
});

async function startGameSimulation(channel, gameState, guild) {
    const { gameLogic } = gameState;
    const imageGenerator = new ImageGenerator();
    let isFirstImage = true;

    try {
        while (gameLogic.getAliveCount() > 1) {
            if (gameState.cancelled || !gameStates.has(channel.id)) {
                console.log('[HG] Game was cancelled mid-simulation, stopping.');
                return;
            }

            const currentStage = gameLogic.getCurrentStage();
            const events = gameLogic.getEventsForCurrentStage();
            const batchSize = Math.min(6, Math.max(3, Math.ceil(events.length / 3)));

            for (let i = 0; i < events.length; i += batchSize) {
                if (gameState.cancelled || !gameStates.has(channel.id)) return;

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
                if (gameState.cancelled || !gameStates.has(channel.id)) return;
                try {
                    const fallenImageBuffer = await imageGenerator.generateFallenTributesImage(fallenTributes);
                    if (fallenImageBuffer) await channel.send({ files: [new AttachmentBuilder(fallenImageBuffer, { name: 'fallen-tributes.png' })] });
                } catch (error) {
                    console.error('Error generating fallen tributes image:', error);
                }
            }

            gameLogic.nextStage();
            if (gameLogic.getAliveCount() > 1) await new Promise(r => setTimeout(r, 6000));
        }
    } catch (err) {
        console.error('[HG] Fatal error during game simulation:', err);
        try {
            await channel.send({
                embeds: [new EmbedBuilder()
                    .setTitle('⚠️ Game Error')
                    .setDescription('An unexpected error occurred and the game has been ended. Use `=play` to start a new game.')
                    .setColor('#FF0000')
                    .setTimestamp()]
            });
        } catch (sendErr) {
            console.error('[HG] Could not send error message to channel:', sendErr);
        }
        gameStates.delete(channel.id);
        return;
    }

    if (gameState.cancelled || !gameStates.has(channel.id)) return;

    await new Promise(r => setTimeout(r, 6000));

    const winner = gameLogic.getWinner();
    const winnerId = findAliveParticipantId(gameState);

    if (!winner) {
        console.warn('[HG] Game ended with no survivors (mutual death on final players).');
        await channel.send({
            embeds: [new EmbedBuilder()
                .setTitle('NO ONE WON')
                .setDescription('The last tributes have fallen simultaneously. There is no winner.\n\n*The Capitol is displeased.*')
                .setColor('#FF4444')
                .setTimestamp()]
        });
        gameStates.delete(channel.id);
        return;
    }

    if (guild && winnerId) Stats.addHgWin(guild.id, winnerId);

    const winnerEmbed = new EmbedBuilder()
        .setTitle('🏆 VICTORY')
        .setDescription(`**${winner.displayName || winner.username}** has won the Hunger Games!\n\n*Congratulations, you have survived the arena!*`)
        .setColor('#FFD700')
        .setThumbnail(winner.avatarURL)
        .setTimestamp();
    await channel.send({ embeds: [winnerEmbed] });
    await removeElimRoleOnWin(channel.guild, winnerId);
    gameStates.delete(channel.id);
}

client.on('error', (err) => {
    if (err?.code !== 10062) console.error('[Discord client error]', err);
});

client.login(process.env.DISCORD_TOKEN);