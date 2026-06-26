const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Users blocked from using =edit (populated via =disable-edit @user)
const blockedEditUsers = new Set();

const COMFY_URL = "https://47e1de4312911.notebooksn.jarvislabs.net";

async function handleEditCommand(message) {
    const args = message.content.trim().split(/\s+/);
    let prompt = args.slice(1).join(' ');

    if (blockedEditUsers.has(message.author.id)) {
        return message.channel.send(`<@${message.author.id}> You are not allowed to use \`=edit\`.`);
    }

    if (!prompt) {
        return message.channel.send(`<@${message.author.id}> You need to provide a prompt! Usage: reply to an image with \`=edit <prompt>\``);
    }

    if (!message.reference || !message.reference.messageId) {
        return message.channel.send(`<@${message.author.id}> You need to reply to a message containing an image to edit it.`);
    }

    try {
        let repliedMessage = message.channel.messages.cache.get(message.reference.messageId);
        if (!repliedMessage) {
            repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        }

        if (repliedMessage.author.id === message.client.user.id) {
            const match = repliedMessage.content.match(/> \*(.*?)\*/);
            if (match && match[1]) {
                const previousPrompt = match[1].trim();
                prompt = `previously: ${previousPrompt}, now: ${prompt}`;
            }
        }

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
        const statusMsg = await message.channel.send(`<@${message.author.id}> Generation has started via Pollinations... (ETA: 10-15s)`);

        try {
            const encodedPrompt = encodeURIComponent(prompt);
            const encodedImage = encodeURIComponent(imageUrl);
            
            let url = `https://gen.pollinations.ai/image/${encodedPrompt}?model=seedream-pro&image=${encodedImage}`;
            
            const polliKey = process.env.POLLINATIONS_API_KEY;
            
            const headers = {};
            if (polliKey) {
                headers['Authorization'] = `Bearer ${polliKey}`;
            }

            const res = await fetch(url, { headers });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Pollinations API Error: ${res.status} - ${text}`);
            }

            const arrayBuffer = await res.arrayBuffer();
            const finalBuffer = Buffer.from(arrayBuffer);

            await statusMsg.delete().catch(() => {});

            await message.channel.send({
                content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
                files: [{
                    attachment: finalBuffer,
                    name: 'edited_image.png'
                }]
            });
        } catch (apiErr) {
            await statusMsg.delete().catch(() => {});
            throw apiErr;
        }

    } catch (err) {
        console.error('[PollinationsEdit] Error editing image:', err);
        const errMsg = err.message || (err.title ? err.title : JSON.stringify(err));
        return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image via Pollinations API. Error: ${errMsg}`);
    }
}

module.exports = { handleEditCommand, blockedEditUsers };
