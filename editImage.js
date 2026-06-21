const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMFY_URL = "https://47e1de4312911.notebooksn.jarvislabs.net";

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
        let repliedMessage = message.channel.messages.cache.get(message.reference.messageId);
        if (!repliedMessage) {
            repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
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
        const { createCanvas, loadImage } = require('canvas');
        const img = await loadImage(imageUrl);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        const pngBuffer = canvas.toBuffer('image/png');
        const imgBlob = new Blob([pngBuffer], { type: 'image/png' });
        
        // 2. Upload to ComfyUI Server
        const formData = new FormData();
        const uploadFilename = `discord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
        formData.append("image", imgBlob, uploadFilename);
        
        const uploadRes = await fetch(`${COMFY_URL}/upload/image`, {
            method: "POST",
            body: formData
        });
        const uploadData = await uploadRes.json();
        
        if (!uploadData.name) {
            throw new Error("Failed to upload image to ComfyUI");
        }

        // 3. Load workflow
        const workflowPath = path.join(__dirname, 'workflow_api.json');
        const workflowRaw = fs.readFileSync(workflowPath, 'utf8');
        const workflow = JSON.parse(workflowRaw);
        
        // Inject the user's prompt into the positive text node (TextEncodeQwenImageEditPlus)
        workflow["24:19"].inputs.prompt = prompt;
        
        // Set the uploaded image filename
        workflow["10"].inputs.image = uploadData.name;
        
        // Randomize seed to avoid identical results
        workflow["24:21"].inputs.seed = Math.floor(Math.random() * 1000000000);

        // 4. Submit workflow to ComfyUI
        const promptRes = await fetch(`${COMFY_URL}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: workflow })
        });
        const promptData = await promptRes.json();
        const promptId = promptData.prompt_id;
        
        if (!promptId) {
            throw new Error("Failed to queue ComfyUI workflow");
        }

        // 5. Poll history for completion
        let outputImageName = null;
        for (let i = 0; i < 120; i++) { // Poll for up to 120 seconds to be absolutely safe
            await new Promise(r => setTimeout(r, 1000));
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const historyData = await historyRes.json();
            
            if (historyData[promptId]) {
                const outputs = historyData[promptId].outputs;
                // Dynamically scan for ANY node that produced an image output
                if (outputs) {
                    for (const nodeId in outputs) {
                        if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
                            outputImageName = outputs[nodeId].images[0].filename;
                            break;
                        }
                    }
                }
                if (outputImageName) break;
            }
        }
        
        if (!outputImageName) {
            throw new Error("ComfyUI generation timed out or failed");
        }

        // 6. Fetch resulting image
        const finalImgRes = await fetch(`${COMFY_URL}/view?filename=${outputImageName}&type=output`);
        const finalImgBuffer = await finalImgRes.arrayBuffer();

        await message.channel.send({
            content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
            files: [{
                attachment: Buffer.from(finalImgBuffer),
                name: 'edited_image.png'
            }]
        });

    } catch (err) {
        console.error('[ComfyUIEdit] Error editing image:', err);
        const errMsg = err.message || (err.title ? err.title : JSON.stringify(err));
        return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image via ComfyUI. Error: ${errMsg}`);
    }
}

module.exports = handleEditCommand;
