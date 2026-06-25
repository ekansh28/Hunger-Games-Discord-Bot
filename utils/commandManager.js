const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'botConfig.json');

let config = {
    bannedUsers: [], // Array of user IDs
    disabledChannels: [], // Array of channel IDs
    disabledCommands: {} // Map of channel ID -> Array of command names
};

// Load config from disk
function loadConfig() {
    if (fs.existsSync(configPath)) {
        try {
            const data = fs.readFileSync(configPath, 'utf8');
            const parsed = JSON.parse(data);
            config = { ...config, ...parsed };
        } catch (err) {
            console.error('[CommandManager] Error loading config:', err);
        }
    } else {
        saveConfig();
    }
}

// Save config to disk
function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    } catch (err) {
        console.error('[CommandManager] Error saving config:', err);
    }
}

// Checkers
function isUserBanned(userId) {
    return config.bannedUsers.includes(userId);
}

function isChannelDisabled(channelId) {
    return config.disabledChannels.includes(channelId);
}

function isCommandDisabled(channelId, commandName) {
    const cmdList = config.disabledCommands[channelId] || [];
    return cmdList.includes(commandName.toLowerCase());
}

// Modifiers
function banUser(userId) {
    if (!config.bannedUsers.includes(userId)) {
        config.bannedUsers.push(userId);
        saveConfig();
        return true;
    }
    return false;
}

function unbanUser(userId) {
    const idx = config.bannedUsers.indexOf(userId);
    if (idx !== -1) {
        config.bannedUsers.splice(idx, 1);
        saveConfig();
        return true;
    }
    return false;
}

function disableChannel(channelId) {
    if (!config.disabledChannels.includes(channelId)) {
        config.disabledChannels.push(channelId);
        saveConfig();
        return true;
    }
    return false;
}

function enableChannel(channelId) {
    const idx = config.disabledChannels.indexOf(channelId);
    if (idx !== -1) {
        config.disabledChannels.splice(idx, 1);
        saveConfig();
        return true;
    }
    return false;
}

function disableCommand(channelId, commandName) {
    const cmd = commandName.toLowerCase();
    if (!config.disabledCommands[channelId]) {
        config.disabledCommands[channelId] = [];
    }
    if (!config.disabledCommands[channelId].includes(cmd)) {
        config.disabledCommands[channelId].push(cmd);
        saveConfig();
        return true;
    }
    return false;
}

function enableCommand(channelId, commandName) {
    const cmd = commandName.toLowerCase();
    if (!config.disabledCommands[channelId]) return false;
    
    const idx = config.disabledCommands[channelId].indexOf(cmd);
    if (idx !== -1) {
        config.disabledCommands[channelId].splice(idx, 1);
        if (config.disabledCommands[channelId].length === 0) {
            delete config.disabledCommands[channelId];
        }
        saveConfig();
        return true;
    }
    return false;
}

// Initialize
loadConfig();

module.exports = {
    isUserBanned,
    isChannelDisabled,
    isCommandDisabled,
    banUser,
    unbanUser,
    disableChannel,
    enableChannel,
    disableCommand,
    enableCommand
};
