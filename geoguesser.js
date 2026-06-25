const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const https = require('https');
const cities = require('./cities.json');
const Stats = require('./stats');
const GOOGLE_API_KEY = process.env.GOOGLE_STREETVIEW_API_KEY || 'AIzaSyBtRz5rZio6uqq2UEHT2l-HL-6JEq7r3Bg';

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
        const latOffset = (Math.random() - 0.5) * 0.04;
        const lonOffset = (Math.random() - 0.5) * 0.04;
        const lat = city.lat + latOffset;
        const lon = city.lon + lonOffset;
        const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=5000&source=outdoor&key=${GOOGLE_API_KEY}`;
        try {
            const metaRes = await fetch(metaUrl);
            const meta = await metaRes.json();
            if (meta.status === 'OK' && meta.location) {
                const heading = Math.floor(Math.random() * 360);
                const pitch = Math.floor(Math.random() * 20) - 10;
                const imageUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${meta.location.lat},${meta.location.lng}&heading=${heading}&pitch=${pitch}&fov=90&key=${GOOGLE_API_KEY}`;
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

    let timeLeft = 30;
    const timerInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            gameMsg.edit({ content: `Guess the country\n-# Time remaining : ${timeLeft}s` }).catch(() => clearInterval(timerInterval));
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

module.exports = {
    handleGeoGuesser,
    handleGgLeaderboard,
    populateCache
};
