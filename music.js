// ============================================================
// music.js — Music queue module (Spotify / YouTube / SoundCloud
// + 700 other sites) for discord.js v14, in the style of
// banRoulette.js. Powered by DisTube v5.
//
// Commands: /play /skip /stop /pause /resume /previous /queue
//           /nowplaying /volume /shuffle /loop
//
// Usage from index.js:
//   const setupMusic = require('./music');
//   const music = setupMusic(client);
//   // register music.commandData alongside your other slash commands
//   // route interactions: if (music.commandNames.has(interaction.commandName)) return music.handleInteraction(interaction);
// ============================================================

'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { DisTube } = require('distube');
const { YouTubePlugin } = require('@distube/youtube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { FilePlugin } = require('@distube/file');
const { isAuthorized } = require('./authorization');
const path = require('path');

// ── Theming ───────────────────────────────────────────────────
const MUSIC_COLOR = '#1DB954';
const ERROR_COLOR = '#FF4444';

// ── Small helpers ────────────────────────────────────────────
function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function capitalize(str) {
    if (!str) return 'Unknown';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function requesterMention(songOrPlaylist) {
    return songOrPlaylist?.member ? `${songOrPlaylist.member}` : 'Unknown';
}

// ── Embeds ───────────────────────────────────────────────────
function nowPlayingEmbed(queue, song) {
    const embed = new EmbedBuilder()
        .setColor(MUSIC_COLOR)
        .setAuthor({ name: 'Now Playing' })
        .setTitle(truncate(song.name || 'Unknown title', 250))
        .addFields(
            { name: 'Duration', value: song.isLive ? 'Live' : (song.formattedDuration || 'Unknown'), inline: true },
            { name: 'Source', value: capitalize(song.source), inline: true },
            { name: 'Requested by', value: requesterMention(song), inline: true },
        )
        .setTimestamp();

    if (song.url) embed.setURL(song.url);
    if (song.thumbnail) embed.setThumbnail(song.thumbnail);
    if (queue.songs.length > 1) {
        embed.setFooter({ text: `${queue.songs.length - 1} more song${queue.songs.length - 1 === 1 ? '' : 's'} in queue • Volume ${queue.volume}%` });
    } else {
        embed.setFooter({ text: `Volume ${queue.volume}%` });
    }
    return embed;
}

function addedSongEmbed(queue, song) {
    const position = Math.max(queue.songs.indexOf(song), 0) + 1;
    const embed = new EmbedBuilder()
        .setColor(MUSIC_COLOR)
        .setAuthor({ name: 'Added to Queue' })
        .setTitle(truncate(song.name || 'Unknown title', 250))
        .addFields(
            { name: 'Duration', value: song.isLive ? 'Live' : (song.formattedDuration || 'Unknown'), inline: true },
            { name: 'Source', value: capitalize(song.source), inline: true },
            { name: 'Position', value: `#${position}`, inline: true },
        );
    if (song.url) embed.setURL(song.url);
    if (song.thumbnail) embed.setThumbnail(song.thumbnail);
    return embed;
}

function addedPlaylistEmbed(playlist) {
    const embed = new EmbedBuilder()
        .setColor(MUSIC_COLOR)
        .setAuthor({ name: 'Added Playlist to Queue' })
        .setTitle(truncate(playlist.name || 'Playlist', 250))
        .addFields(
            { name: 'Songs', value: `${playlist.songs.length}`, inline: true },
            { name: 'Source', value: capitalize(playlist.source), inline: true },
            { name: 'Total Duration', value: playlist.formattedDuration || 'Unknown', inline: true },
        );
    if (playlist.url) embed.setURL(playlist.url);
    if (playlist.thumbnail) embed.setThumbnail(playlist.thumbnail);
    return embed;
}

function queueEmbed(queue) {
    const shown = queue.songs.slice(0, 11);
    const lines = shown.map((song, i) => {
        const marker = i === 0 ? '▶️' : `${i}.`;
        return `${marker} **${truncate(song.name || 'Unknown', 60)}** \`${song.isLive ? 'Live' : song.formattedDuration}\` — ${requesterMention(song)}`;
    });
    const remaining = queue.songs.length - shown.length;
    if (remaining > 0) lines.push(`*…and ${remaining} more*`);

    return new EmbedBuilder()
        .setColor(MUSIC_COLOR)
        .setTitle('🎶 Current Queue')
        .setDescription(lines.join('\n') || 'The queue is empty.')
        .setFooter({ text: `${queue.songs.length} song${queue.songs.length === 1 ? '' : 's'} • Total: ${queue.formattedDuration} • Volume ${queue.volume}%${queue.repeatMode ? ` • Loop: ${queue.repeatMode === 2 ? 'Queue' : 'Song'}` : ''}` });
}

function errorEmbed(title, description) {
    return new EmbedBuilder().setColor(ERROR_COLOR).setTitle(title).setDescription(description);
}

// ── Friendly error mapping for DisTubeError codes ──────────────
const ERROR_MESSAGES = {
    NOT_SUPPORTED_URL: "I don't recognize that link. Try a Spotify, YouTube, or SoundCloud link — or just type a song name.",
    NO_RESULT: "Couldn't find anything matching that search.",
    CANNOT_RESOLVE_SONG: "Couldn't resolve that into a playable song.",
    EMPTY_PLAYLIST: 'That playlist appears to be empty.',
    EMPTY_FILTERED_PLAYLIST: 'Every song in that playlist was filtered out (likely age-restricted).',
    NON_NSFW: "That track is age-restricted, and this isn't a channel marked NSFW.",
    NO_QUEUE: 'Nothing is playing right now.',
};

function describeError(err) {
    const code = err?.errorCode || err?.code;
    if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    return err?.message || 'Something went wrong.';
}

// ============================================================
// Module factory — call once with your discord.js Client
// ============================================================
function setupMusic(client) {
    const distube = new DisTube(client, {
        plugins: [
            // More specific plugins first; yt-dlp (700+ sites) last as a catch-all.
            new SpotifyPlugin(
                process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
                    ? { api: { clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET } }
                    : undefined,
            ),
            new SoundCloudPlugin(),
            new YtDlpPlugin({
                update: false,
                args: ['--enable-file-urls']
            }), // relies on a system-installed yt-dlp binary (see nixpacks.toml)
            new FilePlugin(),
        ],
        emitNewSongOnly: true,
        savePreviousSongs: true,
        nsfw: false,
    });

    // ── DisTube event → chat feedback ──────────────────────────
    distube
        .on('playSong', (queue, song) => {
            queue.textChannel?.send({ embeds: [nowPlayingEmbed(queue, song)] }).catch(() => {});
        })
        .on('addSong', (queue, song) => {
            // Skip the redundant "Added" message for the very first song (playSong covers it).
            if (queue.songs[0] === song && queue.songs.length === 1) return;
            queue.textChannel?.send({ embeds: [addedSongEmbed(queue, song)] }).catch(() => {});
        })
        .on('addList', (queue, playlist) => {
            queue.textChannel?.send({ embeds: [addedPlaylistEmbed(playlist)] }).catch(() => {});
        })
        .on('finish', queue => {
            console.log('[Music] Queue finished');
            if (queue.metadata?.leaveOnFinish) {
                queue.voice.leave();
                queue.textChannel?.send('🤠 Finished playing Alabama, leaving the voice channel.').catch(() => {});
            } else {
                queue.textChannel?.send(
                    `Queue finished. Songs remaining: ${queue.songs.length}`
                ).catch(() => {});
            }
        })
        .on('disconnect', queue => {
            queue.textChannel?.send('Disconnected from the voice channel.').catch(() => {});
        })
        .on('empty', queue => {
            queue.textChannel?.send('Everyone left the voice channel, leaving now.').catch(() => {});
        })
        .on('error', (error, queue, song) => {
            console.error('[Music] DisTube error:', error);
            const desc = song ? `Error playing **${song.name}**: ${error.message || error}` : `Playback error: ${error.message || error}`;
            queue?.textChannel?.send({ embeds: [errorEmbed('Playback Error', desc)] }).catch(() => {});
        });

    // ── Voice-channel / permission helpers ─────────────────────
    function getVoiceChannelOrReply(interaction) {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            interaction.reply({ content: 'Join a voice channel first.', flags: 64 });
            return null;
        }
        const perms = voiceChannel.permissionsFor(interaction.client.user);
        if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
            interaction.reply({ content: "I don't have permission to join and speak in that voice channel.", flags: 64 });
            return null;
        }
        return voiceChannel;
    }

    function requireQueue(interaction) {
        const queue = distube.getQueue(interaction);
        if (!queue) {
            interaction.reply({ content: '🔈 Nothing is playing right now.', flags: 64 });
            return null;
        }
        return queue;
    }

    // Like requireQueue, but also requires the user to share the bot's voice channel.
    function requireControlQueue(interaction) {
        const queue = requireQueue(interaction);
        if (!queue) return null;
        const memberChannelId = interaction.member?.voice?.channel?.id;
        if (queue.voiceChannel && memberChannelId !== queue.voiceChannel.id) {
            interaction.reply({ content: `🔈 You need to be in <#${queue.voiceChannel.id}> to control playback.`, flags: 64 });
            return null;
        }
        return queue;
    }

    // ── Command handlers ────────────────────────────────────────
    async function cmdPlay(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: '🔇 Music only works inside a server.', flags: 64 });
        }
        const query = interaction.options.getString('query', true).trim();
        const voiceChannel = getVoiceChannelOrReply(interaction);
        if (!voiceChannel) return;

        await interaction.deferReply();
        try {
            await distube.play(voiceChannel, query, {
                textChannel: interaction.channel,
                member: interaction.member,
            });
            await interaction.editReply(`🔎 Looking up **${truncate(query, 80)}**…`);
        } catch (err) {
            console.error('[Music] /play error:', err);
            await interaction.editReply({ embeds: [errorEmbed('❌ Could not play that', describeError(err))] });
        }
    }

    async function cmdSkip(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        const current = queue.songs[0];
        try {
            await queue.skip();
            await interaction.reply(`⏭️ Skipped **${truncate(current?.name || 'the current song', 80)}**.`);
        } catch (err) {
            await interaction.reply({ embeds: [errorEmbed('❌ Could not skip', describeError(err))] });
        }
    }

    async function cmdPrevious(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        try {
            await queue.previous();
            await interaction.reply('⏮️ Playing the previous song.');
        } catch (err) {
            await interaction.reply({ content: `❌ ${describeError(err)}`, flags: 64 });
        }
    }

    async function cmdStop(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        queue.stop();
        await interaction.reply('⏹️ Stopped playback and cleared the queue.');
    }

    async function cmdPause(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        if (queue.paused) return interaction.reply({ content: '⏸️ Already paused.', flags: 64 });
        queue.pause();
        await interaction.reply('⏸️ Paused.');
    }

    async function cmdResume(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        if (!queue.paused) return interaction.reply({ content: '▶️ Already playing.', flags: 64 });
        queue.resume();
        await interaction.reply('▶️ Resumed.');
    }

    async function cmdVolume(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        const amount = interaction.options.getInteger('amount', true);
        queue.setVolume(amount);
        await interaction.reply(`🔊 Volume set to **${amount}%**.`);
    }

    async function cmdShuffle(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        queue.shuffle();
        await interaction.reply('🔀 Queue shuffled.');
    }

    async function cmdLoop(interaction) {
        const queue = requireControlQueue(interaction);
        if (!queue) return;
        const mode = interaction.options.getString('mode', true); // 'off' | 'song' | 'queue'
        const modeMap = { off: 0, song: 1, queue: 2 };
        const labelMap = { off: 'disabled', song: 'repeat current song', queue: 'repeat whole queue' };
        queue.setRepeatMode(modeMap[mode]);
        await interaction.reply(`🔁 Loop mode: **${labelMap[mode]}**.`);
    }

    async function cmdQueue(interaction) {
        const queue = requireQueue(interaction);
        if (!queue) return;
        await interaction.reply({ embeds: [queueEmbed(queue)] });
    }

    async function cmdNowPlaying(interaction) {
        const queue = requireQueue(interaction);
        if (!queue) return;
        await interaction.reply({ embeds: [nowPlayingEmbed(queue, queue.songs[0])] });
    }

    async function cmdAlabama(interaction) {
        if (!isAuthorized(interaction.member || interaction.user)) {
            return interaction.reply({ content: '🚫 Only authorized users can play Alabama.', flags: 64 });
        }
        const voiceChannel = getVoiceChannelOrReply(interaction);
        if (!voiceChannel) return;

        await interaction.deferReply();
        try {
            await distube.play(voiceChannel, path.join(__dirname, 'alabama.mp3'), {
                textChannel: interaction.channel,
                member: interaction.member,
                skip: true,
                metadata: { leaveOnFinish: true },
            });
            await interaction.editReply('🤠 **Sweet Home Alabama!** (The bot will leave after the song finishes)');
        } catch (err) {
            console.error('[Music] /alabama error:', err);
            await interaction.editReply({ embeds: [errorEmbed('❌ Could not play Alabama', describeError(err))] });
        }
    }

    // ── Slash command definitions ──────────────────────────────
    const commandBuilders = [
        new SlashCommandBuilder().setName('alabama').setDescription('Plays alabama.mp3 and leaves when finished. (Authorized only)'),
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Play or queue a song from Spotify, YouTube, SoundCloud, or just a name.')
            .addStringOption(opt =>
                opt.setName('query').setDescription('A song name, or a Spotify/YouTube/SoundCloud link').setRequired(true),
            ),
        new SlashCommandBuilder().setName('skip').setDescription('Skip the current song.'),
        new SlashCommandBuilder().setName('previous').setDescription('Play the previous song.'),
        new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue.'),
        new SlashCommandBuilder().setName('pause').setDescription('Pause the current song.'),
        new SlashCommandBuilder().setName('resume').setDescription('Resume playback.'),
        new SlashCommandBuilder().setName('queue').setDescription('Show the current song queue.'),
        new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song.'),
        new SlashCommandBuilder()
            .setName('volume')
            .setDescription('Set the playback volume (0-100).')
            .addIntegerOption(opt =>
                opt.setName('amount').setDescription('Volume percentage').setMinValue(0).setMaxValue(100).setRequired(true),
            ),
        new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue.'),
        new SlashCommandBuilder()
            .setName('loop')
            .setDescription('Set the loop mode.')
            .addStringOption(opt =>
                opt
                    .setName('mode')
                    .setDescription('Loop mode')
                    .setRequired(true)
                    .addChoices({ name: 'Off', value: 'off' }, { name: 'Song', value: 'song' }, { name: 'Queue', value: 'queue' }),
            ),
    ];

    const handlers = {
        alabama: cmdAlabama,
        play: cmdPlay,
        skip: cmdSkip,
        previous: cmdPrevious,
        stop: cmdStop,
        pause: cmdPause,
        resume: cmdResume,
        queue: cmdQueue,
        nowplaying: cmdNowPlaying,
        volume: cmdVolume,
        shuffle: cmdShuffle,
        loop: cmdLoop,
    };

    const commandNames = new Set(Object.keys(handlers));

    async function handleInteraction(interaction) {
        if (!interaction.isChatInputCommand() || !commandNames.has(interaction.commandName)) return false;
        try {
            await handlers[interaction.commandName](interaction);
        } catch (err) {
            console.error(`[Music] Unhandled error in /${interaction.commandName}:`, err);
            const payload = { content: '⚠️ Something went wrong with that command.', flags: 64 };
            try {
                if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
                else await interaction.reply(payload);
            } catch { /* swallow */ }
        }
        return true;
    }

    return {
        distube,
        commandData: commandBuilders.map(c => c.toJSON()),
        commandNames,
        handleInteraction,
    };
}

module.exports = setupMusic;