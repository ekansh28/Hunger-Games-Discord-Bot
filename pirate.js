async function handlePirateCommand(message) {
    let textToTranslate = '';

    // Check if the command was used as a reply
    if (message.reference && message.reference.messageId) {
        try {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            if (repliedMessage && repliedMessage.content) {
                textToTranslate = repliedMessage.content;
            }
        } catch (err) {
            console.error('[Pirate] Failed to fetch replied message:', err);
            return message.reply('Could not read the message you replied to.');
        }
    } else {
        // Not a reply, parse from the command itself
        const args = message.content.trim().split(/\s+/);
        // The first element is the command, e.g., '=p' or '=pt'
        textToTranslate = args.slice(1).join(' ');
    }

    if (!textToTranslate) {
        return message.reply('Ye need to provide some text to translate or reply to a message, ye scurvy dog! Usage: `=p <text>` or reply with `=p`');
    }

    try {
        const url = `https://pirate.monkeyness.com/api/translate?english=${encodeURIComponent(textToTranslate)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        
        const translatedText = await res.text();
        await message.reply(translatedText);
    } catch (err) {
        console.error('[Pirate] Translation error:', err);
        await message.reply('Arrr! The translation API be down or unreachable right now.');
    }
}

module.exports = handlePirateCommand;
