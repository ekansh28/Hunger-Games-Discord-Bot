const { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');

async function handleHelpCommand(message) {
    const pages = {
        'home': new EmbedBuilder()
            .setTitle('📖 Bot Command Reference')
            .setColor('#FFD700')
            .setDescription('Welcome to the help menu! Please select a category from the dropdown below to view commands.\n\nAll prefix commands use `=`. Slash commands use `/`.'),
        'games': new EmbedBuilder()
            .setTitle('🎮 Games')
            .setColor('#FFD700')
            .addFields(
                { name: 'Hunger Games (`=play`)', value: '`=play` -- Open a game lobby *(authorized only)*\n`=cancel` -- Cancel the current game\n`=kill <@user>` -- Eliminate a player' },
                { name: 'Ban Roulette (`/br`)', value: '`/br` -- Start a Ban Roulette lobby\n`/brcancel` -- Cancel the lobby' },
                { name: 'GeoGuesser (`=gg`)', value: '`=gg` or `=geoguesser` -- Guess the country from a Google Street View image in 30 seconds!' }
            ),
        'fun': new EmbedBuilder()
            .setTitle('🎉 Fun & Extras')
            .setColor('#FFD700')
            .addFields(
                { name: 'Last.fm', value: '`=setlastfm <user>` -- Link your account\n`=nichemeter` -- How niche is your music taste?\n`=nb @user` -- Niche battle against someone\n`=pr @user` -- Roast their music taste' },
                { name: 'Other', value: '`=boob` -- Get your totally accurate boob size\n`=edit` -- Image editor tools\n`@Bot` -- Chat with the chaotic AI' }
            ),
        'virus': new EmbedBuilder()
            .setTitle('🦠 Custom Viruses')
            .setColor('#FFD700')
            .addFields(
                { name: 'Create & Manage', value: '`=virus create <Name> <Color>` -- Create a new virus\n`=virus rename <Name>`\n`=virus color <Color>`\n`=virus icon <Emoji>`\n`=virus delete` -- Eradicate your virus' },
                { name: 'Spread & Cure', value: '`=infect` -- Infect yourself\n`=cure [@user|all]` -- Cure a user\n`.bump` -- Cure yourself\n**Spreading:** Ping/Reply to others to infect them with your virus!' },
                { name: 'Stats', value: '`=virus top` -- Deadliest viruses leaderboard\n`=infectioninfo` -- Outbreak stats\n`=infectiontree` -- Lineage tree' }
            ),
        'stats': new EmbedBuilder()
            .setTitle('📊 Stats & Leaderboards')
            .setColor('#FFD700')
            .addFields(
                { name: 'User Stats', value: '`=stats [@user]` or `/stats` -- View word usage stats' },
                { name: 'Leaderboards', value: '`=leaderboard [word]` or `/leaderboard` -- Top users for a tracked word' }
            ),
        'music': new EmbedBuilder()
            .setTitle('🎵 Music')
            .setColor('#FFD700')
            .addFields(
                { name: 'Playback', value: '`/play` -- Play a song\n`/skip`, `/pause`, `/resume`, `/stop` -- Controls\n`/queue` -- View queue' }
            ),
        'admin': new EmbedBuilder()
            .setTitle('🔧 Admin & Other')
            .setColor('#FFD700')
            .addFields(
                { name: 'Permissions', value: '`=addp <@user|@role>` -- Authorize to host games\n`=removep <@user|@role>` -- Remove auth' },
                { name: 'Bot Restrictions (Admin Only)', value: '`=banuser <@user>` -- Ban a user from using the bot\n`=unbanuser <@user>` -- Unban a user\n`=disablechannel` -- Mute the bot in current channel\n`=enablechannel` -- Unmute bot in channel\n`=disablecmd <cmd>` -- Disable a specific command\n`=enablecmd <cmd>` -- Re-enable a command' },
                { name: 'Other', value: '`=test` -- Debug\n`=resetdb` -- Wipe the database *(admin only)*\n`=p` or `=pt` -- Pirate Translator API' }
            )
    };

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help_menu')
        .setPlaceholder('Select a category...')
        .addOptions([
            { label: 'Home', value: 'home', emoji: '🏠', description: 'Return to the main menu' },
            { label: 'Games', value: 'games', emoji: '🎮', description: 'Hunger Games, Ban Roulette, GeoGuesser' },
            { label: 'Fun & Extras', value: 'fun', emoji: '🎉', description: 'Last.fm roasting, image tools, AI chat' },
            { label: 'Custom Viruses', value: 'virus', emoji: '🦠', description: 'Create and spread your own virus' },
            { label: 'Stats & Leaderboards', value: 'stats', emoji: '📊', description: 'Word tracking stats' },
            { label: 'Music', value: 'music', emoji: '🎵', description: 'Music playback commands' },
            { label: 'Admin', value: 'admin', emoji: '🔧', description: 'Permissions and settings' }
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
