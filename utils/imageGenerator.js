const { createCanvas, loadImage } = require('canvas');
const { execSync } = require('child_process');

try {
    console.log(
        'FC MATCH:',
        execSync('fc-match sans-serif').toString()
    );
} catch (e) {
    console.error(e);
}
class ImageGenerator {
    constructor() {
        this.backgroundColor = '#4b3f3f';
        this.titleColor = '#FFD700';
        this.subtitleColor = '#FFFFFF';
        this.nameColor = '#FF8C00';
        this.descriptionColor = '#FFFFFF';
        this.avatarCache = new Map();
    }

    calculateCanvasSize(eventCount) {
        const baseHeight = 150;
        const eventHeight = 130;
        const totalHeight = baseHeight + (eventCount * eventHeight) + 100;
        return {
            width: 800,
            height: Math.max(400, Math.min(1600, totalHeight))
        };
    }

    async generateEventImage(stageTitle, stageSubtitle, events) {
        try {
            const { width, height } = this.calculateCanvasSize(events.length);
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = this.backgroundColor;
            ctx.fillRect(0, 0, width, height);

            const titleHeight = await this.drawTitle(ctx, stageTitle, width);
            let currentY = titleHeight;

            if (stageSubtitle) {
                currentY = await this.drawSubtitle(ctx, stageSubtitle, width, currentY);
            }

            await this.drawEvents(ctx, events, width, currentY);
            console.log("Events:", events.map(e => e.text));
            const buffer = canvas.toBuffer('image/png');

            console.log('BUFFER:', buffer);
            console.log('IS BUFFER:', Buffer.isBuffer(buffer));
            console.log('BUFFER LENGTH:', buffer?.length);

            return buffer;
        } catch (err) {
            console.error('Canvas generation failed:', err);
            // Return a simple error image so AttachmentBuilder never gets undefined
            const errorCanvas = createCanvas(800, 200);
            const ctx = errorCanvas.getContext('2d');
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, 800, 200);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = '20px "sans-serif"';
            ctx.textAlign = 'center';
            ctx.fillText('⚠️ Failed to generate event image ⚠️', 400, 100);
            return errorCanvas.toBuffer('png');
        }
    }

    async drawTitle(ctx, title, width) {
        ctx.fillStyle = this.titleColor;
        ctx.font = 'bold 36px "sans-serif"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const titleLines = this.wrapText(ctx, title, width - 40);
        let y = 20;
        for (const line of titleLines) {
            ctx.fillText(line, width / 2, y);
            y += 42;
        }
        return y + 10;
    }

    async drawSubtitle(ctx, subtitle, width, startY) {
        ctx.fillStyle = this.subtitleColor;
        ctx.font = '20px "sans-serif"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const subtitleLines = this.wrapText(ctx, subtitle, width - 40);
        let y = startY;
        for (const line of subtitleLines) {
            ctx.fillText(line, width / 2, y);
            y += 26;
        }
        return y + 15;
    }

    async drawEvents(ctx, events, width, startY) {
        let currentY = startY;
        const eventSpacing = Math.max(40, 90 - events.length * 8);
        for (const event of events) {
            currentY = await this.drawSingleEvent(ctx, event, currentY, width);
            currentY += eventSpacing;
        }
    }

    async drawSingleEvent(ctx, event, startY, width) {
        const avatarSize = 64;
        const avatarSpacing = 80;

        if (event.participants && event.participants.length > 0) {
            const totalWidth = (event.participants.length - 1) * avatarSpacing;
            let currentX = (width - totalWidth) / 2;

            for (const participant of event.participants) {
                try {
                    const avatar = await this.loadAvatar(participant.avatarURL);
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(currentX + avatarSize/2, startY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
                    ctx.closePath();
                    ctx.clip();
                    ctx.drawImage(avatar, currentX, startY, avatarSize, avatarSize);
                    ctx.restore();

                    ctx.strokeStyle = '#FFFFFF';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(currentX + avatarSize/2, startY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
                    ctx.stroke();
                } catch (error) {
                    ctx.fillStyle = '#666666';
                    ctx.fillRect(currentX, startY, avatarSize, avatarSize);
                    ctx.fillStyle = '#FFFFFF';
                    ctx.font = '12px "sans-serif"';
                    ctx.textAlign = 'center';
                    const dn = participant.displayName || participant.username;
                    ctx.fillText(dn.substring(0, 2).toUpperCase(), currentX + avatarSize/2, startY + avatarSize/2 + 4);
                }
                currentX += avatarSpacing;
            }
        }

        ctx.font = '16px "sans-serif"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const eventLines = this.wrapText(ctx, event.text, width - 40);
        let lineY = startY + avatarSize + 15;

        for (const line of eventLines) {
            this.drawColoredEventText(ctx, line, width / 2, lineY, event.participants);
            lineY += 20;
        }
        return lineY + 5;
    }

    drawColoredEventText(ctx, text, x, y, participants) {
        const words = text.split(' ');
        const participantNames = participants ? participants.map(p => p.displayName || p.username) : [];
        const totalWidth = ctx.measureText(text).width;
        let startX = x - (totalWidth / 2);

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const isName = participantNames.some(name =>
                word.toLowerCase().includes(name.toLowerCase()) ||
                name.toLowerCase().includes(word.toLowerCase()) ||
                this.isPartOfName(word, name, words, i)
            );

            ctx.fillStyle = isName ? this.nameColor : this.descriptionColor;
            ctx.textAlign = 'left';
            ctx.fillText(word, startX, y);
            startX += ctx.measureText(word).width;
            if (i < words.length - 1) startX += ctx.measureText(' ').width;
        }
    }

    isPartOfName(word, fullName, allWords, currentIndex) {
        const nameParts = fullName.toLowerCase().split(' ');
        const wordLower = word.toLowerCase();
        if (nameParts.includes(wordLower)) return true;
        for (let i = 0; i < nameParts.length; i++) {
            if (nameParts[i] === wordLower) {
                let matches = true;
                for (let j = 1; j < nameParts.length - i; j++) {
                    if (currentIndex + j >= allWords.length || allWords[currentIndex + j].toLowerCase() !== nameParts[i + j]) {
                        matches = false; break;
                    }
                }
                if (matches) return true;
            }
        }
        return false;
    }

    async loadAvatar(avatarURL) {
        if (this.avatarCache.has(avatarURL)) return this.avatarCache.get(avatarURL);
        const avatar = await loadImage(avatarURL);
        this.avatarCache.set(avatarURL, avatar);
        return avatar;
    }

    wrapText(ctx, text, maxWidth) {
        if (!text) return [];
        const words = text.split(' ');
        const lines = [];
        let currentLine = '';
        for (const word of words) {
            const testLine = currentLine + (currentLine ? ' ' : '') + word;
            const width = ctx.measureText(testLine).width;
            if (width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines.length ? lines : [text];
    }

    async generateFallenTributesImage(fallenTributes) {
        if (!fallenTributes || fallenTributes.length === 0) return null;

        const avatarSize = 80;
        const avatarsPerRow = 6;
        const rows = Math.ceil(fallenTributes.length / avatarsPerRow);
        const padding = 40;
        const titleHeight = 80;
        const width = 800;
        const height = titleHeight + padding + (rows * (avatarSize + 20)) + padding;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = this.backgroundColor;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 32px "sans-serif"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('Fallen Tributes', width / 2, 30);

        const startX = (width - (Math.min(fallenTributes.length, avatarsPerRow) * (avatarSize + 20) - 20)) / 2;
        let currentRow = 0, currentCol = 0;

        for (const tribute of fallenTributes) {
            const x = startX + (currentCol * (avatarSize + 20));
            const y = titleHeight + padding + (currentRow * (avatarSize + 30));

            try {
                const avatar = await this.loadAvatar(tribute.avatarURL);
                ctx.save();
                ctx.beginPath();
                ctx.arc(x + avatarSize/2, y + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();
                ctx.filter = 'grayscale(100%) contrast(1.2) brightness(0.8)';
                ctx.drawImage(avatar, x, y, avatarSize, avatarSize);
                ctx.restore();

                ctx.strokeStyle = '#666666';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(x + avatarSize/2, y + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
                ctx.stroke();
            } catch {
                ctx.fillStyle = '#333333';
                ctx.fillRect(x, y, avatarSize, avatarSize);
                ctx.fillStyle = '#666666';
                ctx.font = '14px "sans-serif"';
                ctx.textAlign = 'center';
                const dn = tribute.displayName || tribute.username;
                ctx.fillText(dn.substring(0, 2).toUpperCase(), x + avatarSize/2, y + avatarSize/2 + 4);
            }

            currentCol++;
            if (currentCol >= avatarsPerRow) { currentCol = 0; currentRow++; }
        }

        return canvas.toBuffer('image/png');

    }
}

module.exports = ImageGenerator;