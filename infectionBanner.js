// ============================================================
// infectionBanner.js — Generates a banner image for =infectioninfo
// Renders a government-style outbreak report header card.
// ============================================================

'use strict';

const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const fs   = require('fs');

const FONT_PATH = path.join(__dirname, '..', 'fonts', 'Helvetica.ttf');
const FONT_FAMILY = fs.existsSync(FONT_PATH) ? (() => {
    registerFont(FONT_PATH, { family: 'CustomFont' });
    return 'CustomFont';
})() : 'DejaVu Sans';

// Threat level → palette
const PALETTES = {
    LOW:              { bg: '#1a1a1a', accent: '#555555', bar: '#444444', text: '#cccccc', dim: '#888888' },
    MODERATE:         { bg: '#1a1200', accent: '#cc6600', bar: '#994d00', text: '#ffcc88', dim: '#996633' },
    HIGH:             { bg: '#1a0000', accent: '#990000', bar: '#660000', text: '#ff9999', dim: '#883333' },
    CRITICAL:         { bg: '#110000', accent: '#cc0000', bar: '#880000', text: '#ffaaaa', dim: '#772222' },
    'EXTINCTION EVENT': { bg: '#0a0000', accent: '#660000', bar: '#440000', text: '#ff8888', dim: '#551111' },
};

/**
 * @param {object} stats
 * @param {string} stats.serverName
 * @param {number} stats.population
 * @param {number} stats.infected
 * @param {number} stats.healthy
 * @param {number} stats.infectionPct   0–100
 * @param {string} stats.threatLevel
 * @param {string} stats.outbreakStatus
 * @param {string} stats.classification
 * @returns {Buffer} PNG image buffer
 */
async function generateBanner(stats) {
    const W = 900, H = 260;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    const pal = PALETTES[stats.threatLevel] || PALETTES['LOW'];

    // ── Background ──────────────────────────────────────────
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle scanline texture
    ctx.fillStyle = 'rgba(255,255,255,0.015)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);

    // Left accent stripe
    ctx.fillStyle = pal.accent;
    ctx.fillRect(0, 0, 6, H);

    // ── Header label ────────────────────────────────────────
    ctx.fillStyle = pal.dim;
    ctx.font = `11px "${FONT_FAMILY}"`;
    ctx.textAlign = 'left';
    ctx.fillText('CLASSIFIED — OUTBREAK SURVEILLANCE DIVISION', 22, 22);

    // Divider
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(22, 30); ctx.lineTo(W - 22, 30); ctx.stroke();

    // ── Server name / title ─────────────────────────────────
    ctx.fillStyle = pal.text;
    ctx.font = `bold 28px "${FONT_FAMILY}"`;
    ctx.textAlign = 'left';
    const titleText = `AIDS OUTBREAK REPORT`;
    ctx.fillText(titleText, 22, 62);

    ctx.fillStyle = pal.dim;
    ctx.font = `14px "${FONT_FAMILY}"`;
    ctx.fillText(stats.serverName.toUpperCase(), 22, 84);

    // ── Threat badge (right side) ────────────────────────────
    const badgeX = W - 22;
    ctx.textAlign = 'right';
    ctx.fillStyle = pal.dim;
    ctx.font = `11px "${FONT_FAMILY}"`;
    ctx.fillText('THREAT LEVEL', badgeX, 50);
    ctx.fillStyle = pal.accent;
    ctx.font = `bold 22px "${FONT_FAMILY}"`;
    ctx.fillText(stats.threatLevel, badgeX, 76);

    ctx.fillStyle = pal.dim;
    ctx.font = `11px "${FONT_FAMILY}"`;
    ctx.fillText(stats.outbreakStatus, badgeX, 94);

    // ── Divider ──────────────────────────────────────────────
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(22, 102); ctx.lineTo(W - 22, 102); ctx.stroke();

    // ── Stat columns ─────────────────────────────────────────
    const statY = 140;
    const cols = [
        { label: 'TOTAL POPULATION', value: stats.population.toLocaleString() },
        { label: 'INFECTED',          value: stats.infected.toLocaleString() },
        { label: 'HEALTHY',           value: stats.healthy.toLocaleString() },
        { label: 'INFECTION RATE',    value: `${stats.infectionPct.toFixed(1)}%` },
        { label: 'CLASSIFICATION',    value: stats.classification },
    ];
    const colW = (W - 44) / cols.length;

    cols.forEach((col, i) => {
        const cx = 22 + colW * i + colW / 2;
        ctx.textAlign = 'center';
        ctx.fillStyle = pal.dim;
        ctx.font = `10px "${FONT_FAMILY}"`;
        ctx.fillText(col.label, cx, statY - 16);
        ctx.fillStyle = pal.text;
        ctx.font = `bold 18px "${FONT_FAMILY}"`;
        ctx.fillText(col.value, cx, statY + 4);
    });

    // ── Progress bar ─────────────────────────────────────────
    const barY = 185, barH = 14, barX = 22, barW = W - 44;
    // Track
    ctx.fillStyle = '#222222';
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();
    // Fill
    const fillW = Math.max(4, (stats.infectionPct / 100) * barW);
    ctx.fillStyle = pal.bar;
    roundRect(ctx, barX, barY, fillW, barH, 4);
    ctx.fill();
    // Label
    ctx.fillStyle = pal.dim;
    ctx.font = `10px "${FONT_FAMILY}"`;
    ctx.textAlign = 'left';
    ctx.fillText('INFECTION SATURATION', barX, barY - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${stats.infectionPct.toFixed(2)}%`, barX + barW, barY - 4);

    // ── Bottom border ────────────────────────────────────────
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(22, 212); ctx.lineTo(W - 22, 212); ctx.stroke();

    ctx.fillStyle = pal.dim;
    ctx.font = `10px "${FONT_FAMILY}"`;
    ctx.textAlign = 'left';
    ctx.fillText('REPORT AUTO-GENERATED BY SURVEILLANCE SYSTEM  |  DATA MAY BE INCOMPLETE', 22, 228);
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toUTCString().toUpperCase(), W - 22, 228);

    return canvas.toBuffer('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

module.exports = { generateBanner };
