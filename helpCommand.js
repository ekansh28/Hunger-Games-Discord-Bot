const { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');

async function handleHelpCommand(message) {
    const pages = {
        'home': new EmbedBuilder()
            .setTitle('Bot Command Reference')
            .setColor('#2b2d31')
            .setDescription('Select a category from the dropdown below.\n\nAll prefix commands use `=`. Slash commands use `/`.'),

        'games': new EmbedBuilder()
            .setTitle('Games')
            .setColor('#2b2d31')
            .addFields(
                {
                    name: 'Hunger Games',
                    value: '`=play` — Open a game lobby *(authorized only)*\n`=cancel` — Cancel the current game\n`=kill <@user>` — Eliminate a player'
                },
                {
                    name: 'Ban Roulette',
                    value: '`/br` — Start a Ban Roulette lobby\n`/brcancel` — Cancel the lobby'
                },
                {
                    name: 'GeoGuesser',
                    value: '`=gg` / `=geoguesser` — Guess the country from a Street View image. 30 seconds, hints reveal over time, typos forgiven.\n`=gglb` / `=ggleaderboard` — GeoGuesser leaderboard\n`=gs` / `=ggsettings` — Tweak Street View settings *(admin only)*'
                }
            ),

        'fun': new EmbedBuilder()
            .setTitle('Fun & Extras')
            .setColor('#2b2d31')
            .addFields(
                {
                    name: 'AI',
                    value: '`@Bot <message>` — Chat with the bot\n`=impersonate <@user>` — Generate a message pretending to be someone, posted via webhook\n`=psychoanalyze [@user]` / `=psycho [@user]` — Get a brutal fake psychological profile based on their messages\n`=8ball <question>` — Ask the ball something'
                },
                {
                    name: 'Last.fm',
                    value: '`=setlastfm <user>` — Link your Last.fm account\n`=nichemeter` — How niche is your taste?\n`=nb @user` — Niche battle\n`=pr @user` — Roast their taste'
                },
                {
                    name: 'Other',
                    value: '`=boob` — Accurate boob size measurement\n`=pp` — Accurate pp size measurement\n`=edit` — Image editor tools\n`=p` / `=pt` — Pirate translator'
                }
            ),

        'virus': new EmbedBuilder()
            .setTitle('Custom Viruses')
            .setColor('#2b2d31')
            .addFields(
                {
                    name: 'Create & Manage',
                    value: '`=virus create <Name> <Color>` — Create your virus\n`=virus rename <Name>` — Rename it\n`=virus color <Color>` — Change color\n`=virus icon <Emoji>` — Set icon\n`=virus delete` / `=virus eradicate` — Destroy your virus and free up the role slot'
                },
                {
                    name: 'Spread & Cure',
                    value: '`=infect` — Infect yourself\n`=cure [@user|all]` — Cure someone\n`.bump` — Cure yourself\n**Spreading:** Ping or reply to others to spread your virus'
                },
                {
                    name: 'Stats',
                    value: '`=virus top` — Deadliest viruses leaderboard\n`=infectioninfo` — Server outbreak stats\n`=infectiontree` — Infection lineage tree'
                }
            ),

        'stats': new EmbedBuilder()
            .setTitle('Stats & Leaderboards')
            .setColor('#2b2d31')
            .addFields(
                {
                    name: 'User Stats',
                    value: '`=stats [@user]` / `/stats` — View word usage stats for a user'
                },
                {
                    name: 'Leaderboards',
                    value: '`=leaderboard [word]` / `/leaderboard` — Top users for a tracked word\n`=gglb` — GeoGuesser wins leaderboard'
                }
            ),

        'music': new EmbedBuilder()
            .setTitle('Music')
            .setColor('#2b2d31')
            .addFields(
                {
                    name: 'Playback',
                    value: '`/play` — Play a song\n`/skip` — Skip current track\n`/pause` / `/resume` — Pause or resume\n`/stop` — Stop playback\n`/queue` — View the queue'
                }
            ),

        'admin': new EmbedBuilder()
            .setTitle('Admin & Settings')
            .setColor('#2b2d31')
            .addFields(
                {
                    name: 'Game Permissions',
                    value: '`=addp <@user|@role>` — Authorize to host games\n`=removep <@user|@role>` — Remove auth'
                },
                {
                    name: 'Bot Restrictions',
                    value: '`=banuser <@user>` — Ban a user from the bot\n`=unbanuser <@user>` — Unban a user\n`=disablechannel` — Disable bot in current channel\n`=enablechannel` — Re-enable bot in channel\n`=disablecmd <cmd>` — Disable a specific command here\n`=enablecmd <cmd>` — Re-enable a command here'
                },
                {
                    name: 'GeoGuesser Settings',
                    value: '`=gs` / `=ggsettings` — Interactive Street View settings panel with live preview. Locks `=gg` until saved or cancelled.\n**Settings:** Aspect ratio, FOV (40–120), random offset, search radius'
                },
                {
                    name: 'Other',
                    value: '`=resetdb` — Wipe the stat database *(admin only)*\n`=test` — Debug ping'
                }
            )
    };

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help_menu')
        .setPlaceholder('Select a category...')
        .addOptions([
            { label: 'Home', value: 'home', description: 'Return to the main menu' },
            { label: 'Games', value: 'games', description: 'Hunger Games, Ban Roulette, GeoGuesser' },
            { label: 'Fun & Extras', value: 'fun', description: 'AI chat, impersonate, 8ball, Last.fm' },
            { label: 'Custom Viruses', value: 'virus', description: 'Create and spread your own virus' },
            { label: 'Stats & Leaderboards', value: 'stats', description: 'Word tracking and GeoGuesser stats' },
            { label: 'Music', value: 'music', description: 'Music playback commands' },
            { label: 'Admin & Settings', value: 'admin', description: 'Permissions, restrictions, and settings' }
        ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const reply = await message.reply({ embeds: [pages['home']], components: [row] });

    const collector = reply.createMessageComponentCollector({ time: 120000 });

    collector.on('collect', async (interaction) => {
        if (interaction.user.id !== message.author.id) {
            return interaction.reply({ content: 'Only the person who typed =help can use this menu.', flags: 64 });
        }
        const selected = interaction.values[0];
        await interaction.update({ embeds: [pages[selected]] });
    });

    collector.on('end', () => {
        selectMenu.setDisabled(true);
        reply.edit({ components: [new ActionRowBuilder().addComponents(selectMenu)] }).catch(() => {});
    });
}

module.exports = handleHelpCommand;
