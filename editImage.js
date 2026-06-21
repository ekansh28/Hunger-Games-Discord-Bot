const Replicate = require('replicate');

// Initialize Replicate API
const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

async function handleEditCommand(message) {
    const args = message.content.trim().split(/\s+/);
    const prompt = args.slice(1).join(' ');

    if (!prompt) {
        return message.channel.send(`<@${message.author.id}> You need to provide a prompt! Usage: reply to an image with \`=edit <prompt>\``);
    }

    if (!message.reference || !message.reference.messageId) {
        return message.channel.send(`<@${message.author.id}> You need to reply to a message containing an image to edit it.`);
    }

    try {
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        let imageUrl = null;

        // Check for attachments
        if (repliedMessage.attachments.size > 0) {
            const attachment = repliedMessage.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
            if (attachment) imageUrl = attachment.url;
        }

        // Check for embeds if no attachment
        if (!imageUrl && repliedMessage.embeds.length > 0) {
            const embed = repliedMessage.embeds.find(e => e.image || e.thumbnail);
            if (embed && embed.image) imageUrl = embed.image.url;
            else if (embed && embed.thumbnail) imageUrl = embed.thumbnail.url;
        }

        if (!imageUrl) {
            return message.channel.send(`<@${message.author.id}> The message you replied to does not contain a valid image.`);
        }

        // Indicate processing
        await message.channel.sendTyping();

        const output = await replicate.run("black-forest-labs/flux-2-pro", {
            input: {
                prompt: prompt,
                input_images: [imageUrl]
            }
        });

        const finalUrl = output.url ? output.url() : String(output);

        await message.channel.send({
            content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
            files: [finalUrl]
        });

    } catch (err) {
        console.error('[FluxEdit] Error editing image:', err);
        return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image. Error: ${err.message}`);
    }
}

module.exports = handleEditCommand;
