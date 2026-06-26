const ARK_API_KEY = process.env.ARK_API_KEY;
const { AttachmentBuilder } = require('discord.js');

const editCooldowns = new Map();
const COOLDOWN_MS = 20000; // 20 seconds to prevent abuse

async function handleEditCommand(message) {
    if (!ARK_API_KEY) {
        return message.reply("The ARK_API_KEY is not configured.");
    }

    const now = Date.now();
    const lastUsed = editCooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return message.reply(`Please wait ${wait}s before using =edit again.`);
    }

    // Extract prompt
    const prompt = message.content.replace(/^=edit/i, '').trim();
    if (!prompt) {
        return message.reply("Please provide a prompt. Example: `=edit make it cyberpunk`");
    }

    // Extract image URLs
    let imageUrls = [];
    
    // 1. Get from reference message (Image 1)
    if (message.reference && message.reference.messageId) {
        try {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId);
            if (refMsg.attachments.size > 0) {
                imageUrls.push(refMsg.attachments.first().url);
            } else if (refMsg.embeds.length > 0 && refMsg.embeds[0].image) {
                imageUrls.push(refMsg.embeds[0].image.url);
            }
        } catch (e) {
            console.error('[Edit] Failed to fetch reference message:', e);
        }
    }

    // 2. Get from current message attachments (Image 2)
    if (message.attachments.size > 0) {
        imageUrls.push(message.attachments.first().url);
    }

    if (imageUrls.length === 0) {
        return message.reply("Please attach an image or reply to a message with an image.");
    }

    editCooldowns.set(message.author.id, now);
    await message.channel.sendTyping();

    try {
        const payload = {
            model: "seedream-5-0-260128",
            prompt: prompt,
            image: imageUrls.length === 1 ? imageUrls[0] : imageUrls,
            size: "2K",
            output_format: "png",
            response_format: "url", // Tutorial says response_format: 'url' is safer
            watermark: false
        };

        if (imageUrls.length > 1) {
            payload.sequential_image_generation = "disabled";
        }

        const response = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ARK_API_KEY}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Edit] API Error:', errorText);
            return message.reply("Failed to edit the image. The AI provider might be experiencing issues or rejected the prompt.");
        }

        const data = await response.json();
        
        if (data && data.data && data.data.length > 0) {
            let finalImageBuffer;
            let extension = 'png';

            // Depending on response_format, we either get a URL or base64
            if (data.data[0].url) {
                const imgRes = await fetch(data.data[0].url);
                finalImageBuffer = await imgRes.arrayBuffer();
            } else if (data.data[0].b64_json) {
                finalImageBuffer = Buffer.from(data.data[0].b64_json, 'base64');
            } else {
                return message.reply("API returned an unknown format.");
            }

            const attachment = new AttachmentBuilder(Buffer.from(finalImageBuffer), { name: `edited_image.${extension}` });
            return message.reply({ content: `🎨 Edited: *"${prompt}"*`, files: [attachment] });
        } else {
            return message.reply("No image data returned from the API.");
        }

    } catch (e) {
        console.error('[Edit] Unexpected error:', e);
        return message.reply("An unexpected error occurred while editing the image.");
    }
}

module.exports = {
    handleEditCommand
};
