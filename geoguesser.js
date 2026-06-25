const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const https = require('https');
const cities = require('./cities.json');
const Stats = require('./stats');
const GOOGLE_API_KEY = process.env.GOOGLE_STREETVIEW_API_KEY || 'AIzaSyBtRz5rZio6uqq2UEHT2l-HL-6JEq7r3Bg';

const SETTINGS_PATH = path.join(__dirname, 'ggSettings.json');
let ggSettings = {
    aspectRatio: '16:9', // '16:9' (640x360) or '1:1' (640x640)
    fov: 110,
    offset: 1.5,
    radius: 25000
};

if (fs.existsSync(SETTINGS_PATH)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        ggSettings = { ...ggSettings, ...loaded };
    } catch (e) {
        console.error('[GeoGuesser] Failed to load settings:', e);
    }
}

function saveGgSettings() {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(ggSettings, null, 4));
    } catch (e) {
        console.error('[GeoGuesser] Failed to save settings:', e);
    }
}

const countryAliases = {
    'usa': 'united states',
    'us': 'united states',
    'america': 'united states',
    'united states of america': 'united states',
    'uk': 'united kingdom',
    'england': 'united kingdom',
    'great britain': 'united kingdom',
    'britain': 'united kingdom',
    'uae': 'united arab emirates',
    'korea': 'south korea',
    'czech republic': 'czechia',
    'holland': 'netherlands'
};

const activeGames = new Set(); // Stores channel IDs

const locationCache = [];
let isFetchingCache = false;

async function populateCache() {
    if (isFetchingCache) return;
    isFetchingCache = true;
    try {
        const targetCacheSize = 5;
        const needed = targetCacheSize - locationCache.length;
        if (needed > 0) {
            const promises = Array.from({ length: needed }).map(() => getRandomGoogleLocation());
            const results = await Promise.all(promises);
            for (const loc of results) {
                if (loc) locationCache.push(loc);
            }
        }
    } catch (e) {
        console.error("Cache populate error:", e);
    }
    isFetchingCache = false;
}


async function getRandomGoogleLocation() {
    const uniqueCountries = [...new Set(cities.map(c => c.country))];

    for (let attempt = 0; attempt < 5; attempt++) {
        const randomCountry = uniqueCountries[Math.floor(Math.random() * uniqueCountries.length)];
        const countryCities = cities.filter(c => c.country === randomCountry);
        const city = countryCities[Math.floor(Math.random() * countryCities.length)];
        // Wider randomization to escape the capital city center based on settings
        const latOffset = (Math.random() - 0.5) * ggSettings.offset;
        const lonOffset = (Math.random() - 0.5) * ggSettings.offset;
        const lat = city.lat + latOffset;
        const lon = city.lon + lonOffset;
        
        const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=${ggSettings.radius}&source=outdoor&key=${GOOGLE_API_KEY}`;
        try {
            const metaRes = await fetch(metaUrl);
            const meta = await metaRes.json();
            if (meta.status === 'OK' && meta.location) {
                const heading = Math.floor(Math.random() * 360);
                const pitch = Math.floor(Math.random() * 20) - 10;
                const sizeStr = ggSettings.aspectRatio === '16:9' ? '640x360' : '640x640';
                const imageUrl = `https://maps.googleapis.com/maps/api/streetview?size=${sizeStr}&location=${meta.location.lat},${meta.location.lng}&heading=${heading}&pitch=${pitch}&fov=${ggSettings.fov}&key=${GOOGLE_API_KEY}`;
                return { country: city.country, image_url: imageUrl };
            }
        } catch (e) {
            console.error(`[GeoGuesser] Google metadata fetch error: ${e.message}`);
        }
    }
    return null;
}

async function handleGeoGuesser(message) {
    const channelId = message.channel.id;

    if (activeGames.has(channelId)) {
        return message.reply('A GeoGuesser game is already active in this channel.');
    }

    activeGames.add(channelId);
    
    // Pop from cache if available
    let location = locationCache.shift();
    let loadingMsg = null;
    
    // Kick off background task to refill cache
    populateCache();

    if (!location) {
        // Cache was empty, fetch dynamically
        loadingMsg = await message.channel.send('Loading a random location from the world...');
        location = await getRandomGoogleLocation();
    }
    
    if (!location) {
        activeGames.delete(channelId);
        if (loadingMsg) {
            return loadingMsg.edit('Failed to find a location. Please try again!');
        } else {
            return message.channel.send('Failed to find a location. Please try again!');
        }
    }

    const targetCountry = location.country.toLowerCase();

    const attachment = new AttachmentBuilder(location.image_url, { name: 'geoguesser.jpg' });

    if (loadingMsg) {
        await loadingMsg.delete().catch(() => null);
    }
    const gameMsg = await message.channel.send({ 
        content: "Guess the country\n-# Time remaining : 30s", 
        files: [attachment] 
    });

    const hintStr = location.country.split('').map(char => {
        if (char === ' ') return '   ';
        if (char.match(/[a-zA-Z]/)) return '**\\_**';
        return char;
    }).join(' ');

    let timeLeft = 30;
    const timerInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            let contentText = `Guess the country`;
            if (timeLeft <= 15) {
                contentText += `\n**Hint:** ${hintStr}`;
            }
            contentText += `\n-# Time remaining : ${timeLeft}s`;
            
            gameMsg.edit({ content: contentText }).catch(() => clearInterval(timerInterval));
        } else {
            clearInterval(timerInterval);
        }
    }, 1000);

    // Set up message collector
    const filter = (m) => !m.author.bot;
    const collector = message.channel.createMessageCollector({ filter, time: 30000 });

    collector.on('collect', (m) => {
        const guess = m.content.trim().toLowerCase();
        
        let normalizedGuess = guess;
        if (countryAliases[guess]) {
            normalizedGuess = countryAliases[guess];
        }

        // Exact match
        if (normalizedGuess === targetCountry) {
            clearInterval(timerInterval);
            collector.stop('winner');
            activeGames.delete(channelId);

            // Track the win in the database
            if (m.guild) Stats.addGgWin(m.guild.id, m.author.id);
            
            const winEmbed = new EmbedBuilder()
                .setTitle('Winner')
                .setDescription(`Congratulations **${m.author.username}**! The correct answer was **${location.country}**!`)
                .setColor('#00ff00');
                
            m.channel.send({ embeds: [winEmbed] });
        } else {
            // Only cross-react if the guess is actually a valid country
            // uniqueCountries is computed in getRandomMapillaryLocation, but we can compute it here or use cities directly
            const isValidCountry = cities.some(c => c.country.toLowerCase() === normalizedGuess);
            if (isValidCountry) {
                m.react('❌').catch(() => null);
            }
        }
    });

    collector.on('end', (collected, reason) => {
        clearInterval(timerInterval);
        if (reason !== 'winner') {
            activeGames.delete(channelId);
            
            const timeoutEmbed = new EmbedBuilder()
                .setTitle('Time is up')
                .setDescription(`No one guessed the correct country. The answer was **${location.country}**!`)
                .setColor('#ff0000');
                
            message.channel.send({ embeds: [timeoutEmbed] }).catch(() => null);
        }
    });
}

async function handleGgLeaderboard(message) {
    const lb = await Stats.getGgLeaderboard(message.guild?.id, 10);
    const embed = new EmbedBuilder()
        .setTitle('🌍 GeoGuesser Leaderboard')
        .setColor('#0099ff')
        .setTimestamp();
    if (lb.length === 0) {
        embed.setDescription('No GeoGuesser wins recorded yet. Play with `=gg`!');
    } else {
        const desc = lb.map((entry, idx) => {
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**${idx + 1}.**`;
            return `${medal} <@${entry.userId}> — **${entry.count}** win${entry.count === 1 ? '' : 's'}`;
        }).join('\n');
        embed.setDescription(desc);
    }
    return message.reply({ embeds: [embed] });
}

// Helper to generate the preview URL based on current settings
function getPreviewUrl() {
    // We'll use Paris (Eiffel Tower) as the static preview location
    const previewLat = 48.8584;
    const previewLon = 2.2945;
    const sizeStr = ggSettings.aspectRatio === '16:9' ? '640x360' : '640x640';
    return `https://maps.googleapis.com/maps/api/streetview?size=${sizeStr}&location=${previewLat},${previewLon}&heading=165&pitch=0&fov=${ggSettings.fov}&key=${GOOGLE_API_KEY}`;
}

async function handleGgSettings(message) {
    if (message.author.id !== (process.env.AUTHORIZED_USER_ID || '1198980443823947927')) {
        return message.reply("You are not authorized to use this command.");
    }

    function buildEmbed() {
        return new EmbedBuilder()
            .setTitle('🌍 GeoGuesser Settings')
            .setDescription('Tweak the settings below. The preview image updates in real-time!\n**Preview Location:** Paris, France')
            .setColor('#2b2d31')
            .addFields(
                { name: 'Aspect Ratio', value: ggSettings.aspectRatio, inline: true },
                { name: 'Field of View (FOV)', value: `${ggSettings.fov}°`, inline: true },
                { name: 'Random Offset', value: `±${ggSettings.offset}°`, inline: true },
                { name: 'Search Radius', value: `${ggSettings.radius / 1000}km`, inline: true }
            )
            .setImage(getPreviewUrl() + `&_ts=${Date.now()}`); // Cache bust
    }

    function buildRows() {
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ggs_ratio').setLabel('Toggle Aspect Ratio').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ggs_fov_down').setLabel('FOV -10').setStyle(ButtonStyle.Secondary).setDisabled(ggSettings.fov <= 40),
            new ButtonBuilder().setCustomId('ggs_fov_up').setLabel('FOV +10').setStyle(ButtonStyle.Secondary).setDisabled(ggSettings.fov >= 120)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ggs_offset_down').setLabel('Offset -0.5').setStyle(ButtonStyle.Secondary).setDisabled(ggSettings.offset <= 0),
            new ButtonBuilder().setCustomId('ggs_offset_up').setLabel('Offset +0.5').setStyle(ButtonStyle.Secondary).setDisabled(ggSettings.offset >= 5.0),
            new ButtonBuilder().setCustomId('ggs_radius_down').setLabel('Radius -5km').setStyle(ButtonStyle.Secondary).setDisabled(ggSettings.radius <= 5000),
            new ButtonBuilder().setCustomId('ggs_radius_up').setLabel('Radius +5km').setStyle(ButtonStyle.Secondary).setDisabled(ggSettings.radius >= 50000)
        );
        return [row1, row2];
    }

    const msg = await message.channel.send({ embeds: [buildEmbed()], components: buildRows() });

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 }); // 5 mins

    collector.on('collect', async (i) => {
        if (i.user.id !== message.author.id) {
            return i.reply({ content: 'Only the command runner can use these buttons.', ephemeral: true });
        }

        switch (i.customId) {
            case 'ggs_ratio':
                ggSettings.aspectRatio = ggSettings.aspectRatio === '16:9' ? '1:1' : '16:9';
                break;
            case 'ggs_fov_down':
                ggSettings.fov = Math.max(40, ggSettings.fov - 10);
                break;
            case 'ggs_fov_up':
                ggSettings.fov = Math.min(120, ggSettings.fov + 10);
                break;
            case 'ggs_offset_down':
                ggSettings.offset = Math.max(0, ggSettings.offset - 0.5);
                break;
            case 'ggs_offset_up':
                ggSettings.offset = Math.min(5.0, ggSettings.offset + 0.5);
                break;
            case 'ggs_radius_down':
                ggSettings.radius = Math.max(5000, ggSettings.radius - 5000);
                break;
            case 'ggs_radius_up':
                ggSettings.radius = Math.min(50000, ggSettings.radius + 5000);
                break;
        }

        saveGgSettings();

        await i.update({ embeds: [buildEmbed()], components: buildRows() });
    });

    collector.on('end', () => {
        msg.edit({ components: [] }).catch(() => null);
    });
}

module.exports = {
    handleGeoGuesser,
    handleGgLeaderboard,
    handleGgSettings,
    populateCache
};
