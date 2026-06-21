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
        const workflowPath = path.join(__dirname, 'workflow_api2.json');
        const workflowRaw = fs.readFileSync(workflowPath, 'utf8');
        const workflow = JSON.parse(workflowRaw);
        
        // Inject the user's prompt into the positive text node (TextEncodeQwenImageEditPlus)
        workflow["24:19"].inputs.prompt = prompt;
        
        // Set the uploaded image filename
        workflow["10"].inputs.image = uploadData.name;
        
        // Randomize seed to avoid identical results
        workflow["24:21"].inputs.seed = Math.floor(Math.random() * 1000000000);

        // 4. Establish WebSocket connection and wait for execution
        const WebSocket = require('ws');
        const clientId = crypto.randomUUID();
        const wsUrl = COMFY_URL.replace("http", "ws").replace("https", "wss") + `/ws?clientId=${clientId}`;
        
        const outputImageName = await new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            let promptId = null;
            
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error("ComfyUI generation timed out"));
            }, 120000); // 120 seconds timeout

            ws.on('open', async () => {
                try {
                    // Submit workflow to ComfyUI once WS is open
                    const promptRes = await fetch(`${COMFY_URL}/prompt`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ prompt: workflow, client_id: clientId })
                    });
                    const promptData = await promptRes.json();
                    promptId = promptData.prompt_id;
                    
                    if (!promptId) {
                        throw new Error("Failed to queue ComfyUI workflow");
                    }
                    
                    // Inform the user that generation has started
                    message.channel.send(`<@${message.author.id}>  The job is queued and generation has started...`).catch(() => {});
                } catch (err) {
                    clearTimeout(timeout);
                    ws.close();
                    reject(err);
                }
            });

            ws.on('message', (data) => {
                const strData = data.toString();
                // Ignore binary messages (like image previews)
                if (!strData.startsWith('{')) return;
                
                let msg;
                try { msg = JSON.parse(strData); } catch(e) { return; }
                
                if (msg.type === 'executed' && promptId && msg.data.prompt_id === promptId) {
                    clearTimeout(timeout);
                    ws.close();
                    
                    const outputs = msg.data.output;
                    let outName = null;
                    if (outputs && outputs.images && outputs.images.length > 0) {
                        outName = outputs.images[0].filename;
                    }
                    
                    if (outName) resolve(outName);
                    else reject(new Error("No output image found in execution result"));
                } else if (msg.type === 'execution_error') {
                    clearTimeout(timeout);
                    ws.close();
                    reject(new Error("ComfyUI execution error: " + (msg.data.exception_message || "Unknown error")));
                }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        // 6. Fetch resulting image
        const finalImgRes = await fetch(`${COMFY_URL}/view?filename=${outputImageName}&type=output`);
        const finalImgArrayBuffer = await finalImgRes.arrayBuffer();
        const rawFinalImgBuffer = Buffer.from(finalImgArrayBuffer);

        // 7. Resize final image to 512px max before sending to Discord
        const finalImg = await loadImage(rawFinalImgBuffer);
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

        await message.channel.send({
            content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
            files: [{
                attachment: finalResizedBuffer,
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
