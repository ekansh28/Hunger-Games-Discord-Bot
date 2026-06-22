const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMFY_URL = "https://47e1de4312911.notebooksn.jarvislabs.net";

async function handleEditCommand(message) {
    const args = message.content.trim().split(/\s+/);
    let prompt = args.slice(1).join(' ');

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

        // Indicate processing (non-blocking for speed)
        message.channel.sendTyping().catch(() => {});

        // 1. Download image from Discord and force conversion to a flat PNG
        // This ensures GIFs are converted to their first static frame
        // Also resizes the image to a maximum of 512px on the longest side to speed up generation
        const { createCanvas, loadImage } = require('canvas');
        const img = await loadImage(imageUrl);
        
        let width = img.width;
        let height = img.height;
        const MAX_SIZE = 512;
        
        if (width > MAX_SIZE || height > MAX_SIZE) {
            if (width > height) {
                height = Math.round((height * MAX_SIZE) / width);
                width = MAX_SIZE;
            } else {
                width = Math.round((width * MAX_SIZE) / height);
                height = MAX_SIZE;
            }
        }

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        const pngBuffer = canvas.toBuffer('image/png');
        const base64Image = pngBuffer.toString('base64');
        const b64DataUri = `data:image/png;base64,${base64Image}`;
        
        // 2. Prepare payload for BytePlus ARK API
        const arkApiKey = process.env.ARK_API_KEY;
        if (!arkApiKey) {
            throw new Error("ARK_API_KEY is not set in environment variables.");
        }

        const modelId = process.env.ARK_MODEL_ID || 'seededit-3.0-i2i';
        
        const payload = {
            model: modelId,
            prompt: prompt,
            image: [ b64DataUri ],
            response_format: "b64_json",
            watermark: false
        };

        // Inform the user that generation has started and start countdown
        const statusMsg = await message.channel.send(`<@${message.author.id}> Generation has started... (15s)`);
        
        let timeLeft = 15;
        const countdownInterval = setInterval(() => {
            timeLeft--;
            if (timeLeft > 0) {
                statusMsg.edit(`<@${message.author.id}> Generation has started... (${timeLeft}s)`).catch(() => {});
            } else {
                statusMsg.edit(`<@${message.author.id}> Almost done...`).catch(() => {});
                clearInterval(countdownInterval);
            }
        }, 1000);

        try {
            // 3. Send request to BytePlus
            const arkRes = await fetch("https://ark.ap-southeast.bytepluses.com/api/v3/images/generations", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${arkApiKey}`
                },
                body: JSON.stringify(payload)
            });

            const arkData = await arkRes.json();

            if (!arkRes.ok) {
                console.error('[ARK API] Error response:', arkData);
                throw new Error(arkData.error?.message || arkData.error?.code || JSON.stringify(arkData));
            }

            if (!arkData.data || !arkData.data[0] || !arkData.data[0].b64_json) {
                console.error('[ARK API] Invalid response structure:', arkData);
                throw new Error("No output image returned from the API.");
            }

            // 4. Decode base64 back to buffer
            const finalImgBuffer = Buffer.from(arkData.data[0].b64_json, 'base64');

            // 5. Resize final image to 512px max before sending to Discord
            const finalImg = await loadImage(finalImgBuffer);
            let finalWidth = finalImg.width;
            let finalHeight = finalImg.height;
            
            if (finalWidth > MAX_SIZE || finalHeight > MAX_SIZE) {
                if (finalWidth > finalHeight) {
                    finalHeight = Math.round((finalHeight * MAX_SIZE) / finalWidth);
                    finalWidth = MAX_SIZE;
                } else {
                    finalWidth = Math.round((finalWidth * MAX_SIZE) / finalHeight);
                    finalHeight = MAX_SIZE;
                }
            }

            const finalCanvas = createCanvas(finalWidth, finalHeight);
            const finalCtx = finalCanvas.getContext('2d');
            finalCtx.drawImage(finalImg, 0, 0, finalWidth, finalHeight);
            const finalResizedBuffer = finalCanvas.toBuffer('image/png');

            clearInterval(countdownInterval);
            await statusMsg.delete().catch(() => {});

            await message.channel.send({
                content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
                files: [{
                    attachment: finalResizedBuffer,
                    name: 'edited_image.png'
                }]
            });
        } catch (apiErr) {
            clearInterval(countdownInterval);
            await statusMsg.delete().catch(() => {});
            throw apiErr;
        }

    } catch (err) {
        console.error('[BytePlusEdit] Error editing image:', err);
        const errMsg = err.message || (err.title ? err.title : JSON.stringify(err));
        return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image via BytePlus API. Error: ${errMsg}`);
    }
}

module.exports = handleEditCommand;
