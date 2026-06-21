const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

// Load custom font from fonts/Helvetica.ttf if present
const FONT_PATH = path.join(__dirname, '..', 'fonts', 'Helvetica.ttf');
const FONT_FAMILY = fs.existsSync(FONT_PATH) ? (() => {
    registerFont(FONT_PATH, { family: 'CustomFont' });
    console.log('[ImageGenerator] Loaded custom font from', FONT_PATH);
    return 'CustomFont';
})() : 'DejaVu Sans';

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
            return canvas.toBuffer('image/png');
        } catch (err) {
            console.error('Event image generation failed:', err);
            const errorCanvas = createCanvas(800, 200);
            const ctx = errorCanvas.getContext('2d');
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, 800, 200);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `20px "${FONT_FAMILY}"`;
            ctx.textAlign = 'center';
            ctx.fillText('⚠️ Failed to generate event image ⚠️', 400, 100);
            return errorCanvas.toBuffer('png');
        }
    }

    async drawTitle(ctx, title, width) {
        ctx.fillStyle = this.titleColor;
        ctx.font = `bold 36px "${FONT_FAMILY}"`;
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
        ctx.font = `20px "${FONT_FAMILY}"`;
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
                    ctx.arc(currentX + avatarSize / 2, startY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                    ctx.closePath();
                    ctx.clip();
                    ctx.drawImage(avatar, currentX, startY, avatarSize, avatarSize);
                    ctx.restore();

                    ctx.strokeStyle = '#FFFFFF';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(currentX + avatarSize / 2, startY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                    ctx.stroke();
                } catch {
                    ctx.fillStyle = '#666666';
                    ctx.fillRect(currentX, startY, avatarSize, avatarSize);
                    ctx.fillStyle = '#FFFFFF';
                    ctx.font = `12px "${FONT_FAMILY}"`;
                    ctx.textAlign = 'center';
                    const dn = participant.displayName || participant.username;
                    ctx.fillText(dn.substring(0, 2).toUpperCase(), currentX + avatarSize / 2, startY + avatarSize / 2 + 4);
                }
                currentX += avatarSpacing;
            }
        }

        ctx.font = `16px "${FONT_FAMILY}"`;
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

    // ─── BUG FIX ─────────────────────────────────────────────────────────────
    // The old version checked word.toLowerCase().includes(name.toLowerCase())
    // which meant a participant named "a" would highlight EVERY word containing
    // the letter "a". Single-character names (or short names that are substrings
    // of common words) broke all text.
    //
    // Fix: we build a Set of every exact token that belongs to any participant
    // name, using word-boundary splitting. We then compare each rendered word
    // (stripped of trailing punctuation) against that Set for an exact match.
    // ─────────────────────────────────────────────────────────────────────────
    drawColoredEventText(ctx, text, x, y, participants) {
        // Build a set of name tokens (lowercased) from all participants
        const nameTokens = new Set();
        if (participants) {
            for (const p of participants) {
                const fullName = (p.displayName || p.username || '').trim();
                if (!fullName) continue;
                for (const token of fullName.split(/\s+/)) {
                    if (token.length > 1) { // skip single-char tokens entirely
                        nameTokens.add(token.toLowerCase());
                    }
                }
            }
        }

        // We also need to match multi-word names. Build a list of full display
        // names (lowercased) for substring-of-sentence matching.
        const fullNames = participants
            ? participants
                .map(p => (p.displayName || p.username || '').trim().toLowerCase())
                .filter(n => n.length > 1)
            : [];

        const words = text.split(' ');
        const totalWidth = ctx.measureText(text).width;
        let currentX = x - totalWidth / 2;

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            // Strip trailing punctuation for the match check, but render the original
            const wordClean = word.replace(/[^a-zA-Z0-9'-]/g, '').toLowerCase();

            // Check 1: exact token match
            let isName = wordClean.length > 1 && nameTokens.has(wordClean);

            // Check 2: this word starts a multi-word name span
            if (!isName && fullNames.length > 0) {
                for (const fullName of fullNames) {
                    const nameParts = fullName.split(/\s+/);
                    if (nameParts.length > 1 && i + nameParts.length <= words.length) {
                        const span = words
                            .slice(i, i + nameParts.length)
                            .map(w => w.replace(/[^a-zA-Z0-9'-]/g, '').toLowerCase())
                            .join(' ');
                        if (span === fullName) {
                            isName = true;
                            break;
                        }
                    }
                }
            }

            ctx.fillStyle = isName ? this.nameColor : this.descriptionColor;
            ctx.textAlign = 'left';
            ctx.fillText(word, currentX, y);
            currentX += ctx.measureText(word).width;
            if (i < words.length - 1) currentX += ctx.measureText(' ').width;
        }
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
            if (ctx.measureText(testLine).width > maxWidth && currentLine) {
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
        const height = titleHeight + padding + (rows * (avatarSize + 30)) + padding;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = this.backgroundColor;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold 32px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('Fallen Tributes', width / 2, 30);

        const rowWidth = Math.min(fallenTributes.length, avatarsPerRow) * (avatarSize + 20) - 20;
        const startX = (width - rowWidth) / 2;
        let currentRow = 0, currentCol = 0;

        for (const tribute of fallenTributes) {
            const x = startX + (currentCol * (avatarSize + 20));
            const y = titleHeight + padding + (currentRow * (avatarSize + 30));

            try {
                const avatar = await this.loadAvatar(tribute.avatarURL);
                ctx.save();
                ctx.beginPath();
                ctx.arc(x + avatarSize / 2, y + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();
                ctx.filter = 'grayscale(100%) contrast(1.2) brightness(0.8)';
                ctx.drawImage(avatar, x, y, avatarSize, avatarSize);
                ctx.restore();

                ctx.strokeStyle = '#666666';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(x + avatarSize / 2, y + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                ctx.stroke();
            } catch {
                ctx.fillStyle = '#333333';
                ctx.fillRect(x, y, avatarSize, avatarSize);
                ctx.fillStyle = '#666666';
                ctx.font = `14px "${FONT_FAMILY}"`;
                ctx.textAlign = 'center';
                const dn = tribute.displayName || tribute.username;
                ctx.fillText(dn.substring(0, 2).toUpperCase(), x + avatarSize / 2, y + avatarSize / 2 + 4);
            }

            currentCol++;
            if (currentCol >= avatarsPerRow) { currentCol = 0; currentRow++; }
        }

        return canvas.toBuffer('image/png');
    }

    async generateNicheBattleImage(avatarUrl1, avatarUrl2, winnerIndex = 0) {
        const width = 600;
        const height = 350;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#2b2d31';
        ctx.fillRect(0, 0, width, height);

        // Draw VS Text in center
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold 60px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('VS', width / 2, height / 2 + 20);

        // Avatars
        const avatarSize = 200;
        const yPos = (height - avatarSize) / 2 + 20;
        const xPos1 = 50;
        const xPos2 = width - avatarSize - 50;

        try {
            const [avatar1, avatar2] = await Promise.all([
                this.loadAvatar(avatarUrl1),
                this.loadAvatar(avatarUrl2)
            ]);

            // Draw Avatar 1
            ctx.save();
            ctx.beginPath();
            ctx.arc(xPos1 + avatarSize / 2, yPos + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatar1, xPos1, yPos, avatarSize, avatarSize);
            ctx.restore();

            // Draw Avatar 2
            ctx.save();
            ctx.beginPath();
            ctx.arc(xPos2 + avatarSize / 2, yPos + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatar2, xPos2, yPos, avatarSize, avatarSize);
            ctx.restore();

            // Draw Crown for winner
            const drawCrown = (x, y) => {
                ctx.save();
                ctx.translate(x, y);
                ctx.fillStyle = '#FFD700'; // Gold
                ctx.strokeStyle = '#DAA520'; // Darker gold
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(-35, 20); // bottom left
                ctx.lineTo(35, 20);  // bottom right
                ctx.lineTo(45, -20); // right tip
                ctx.lineTo(15, -5);  // inner right
                ctx.lineTo(0, -35);  // middle tip
                ctx.lineTo(-15, -5); // inner left
                ctx.lineTo(-45, -20); // left tip
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                // Jewels
                ctx.fillStyle = '#FF0000';
                ctx.beginPath(); ctx.arc(0, -5, 5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#00FF00';
                ctx.beginPath(); ctx.arc(-22, 5, 4, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#0000FF';
                ctx.beginPath(); ctx.arc(22, 5, 4, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
            };

            if (winnerIndex === 1) {
                drawCrown(xPos1 + avatarSize / 2, yPos - 20);
            } else if (winnerIndex === 2) {
                drawCrown(xPos2 + avatarSize / 2, yPos - 20);
            }

        } catch (err) {
            console.error('[ImageGenerator] Error loading avatars for niche battle:', err);
        }

        return canvas.toBuffer('image/png');
    }
}

module.exports = ImageGenerator;