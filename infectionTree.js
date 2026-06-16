// ============================================================
// infectionTree.js — Renders an infection lineage tree image
//
// Builds a top-down generational tree:
//   Generation 0 = patient zeros (infectedBy: null / not present)
//   Generation 1 = infected by gen-0, etc.
//
// Features:
//   - Fully dynamic canvas: grows with the tree, never clips
//   - Auto-scales down when the tree is large (fits in ~2000px wide)
//   - Optional zoom scale (1.0 = auto, pass a multiplier to zoom in)
//   - Proper subtree-width layout: each parent is centred over its children
//   - Count badge on each box: "(3 infected)" below the name
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

// ── Visual constants ────────────────────────────────────────
const BG_COLOR     = '#0d0d0d';
const BOX_NORMAL   = '#1e3a4a';   // dark teal
const BOX_ZERO     = '#3a1a1a';   // dark red — patient zeros
const BOX_INVOKER  = '#3a1a5a';   // purple — the command caller
const BOX_STROKE_N = '#5ab4d4';   // teal outline
const BOX_STROKE_Z = '#d45a5a';   // red outline for patient zeros
const BOX_STROKE_I = '#a06adf';   // purple outline for invoker
const TEXT_MAIN    = '#e8e8e8';
const TEXT_SUB     = '#8ab8c8';
const LINE_COLOR   = '#3a5a6a';
const TITLE_COLOR  = '#c8e0ea';
const LEGEND_COLOR = '#888888';

const BOX_H        = 48;   // box height
const BOX_PAD_X    = 14;   // horizontal inner padding
const BOX_MIN_W    = 80;
const BOX_RADIUS   = 6;
const COL_GAP      = 20;   // gap between sibling boxes
const ROW_GAP      = 64;   // gap between generations
const CANVAS_PAD   = 48;
const TITLE_H      = 56;
const LEGEND_H     = 28;

// Max canvas width before auto-scale kicks in
const MAX_AUTO_WIDTH = 2000;

// ─────────────────────────────────────────────────────────────
//  Measure text (singleton context)
// ─────────────────────────────────────────────────────────────
let _mc = null;
function measureText(text, font) {
    if (!_mc) _mc = createCanvas(10, 10).getContext('2d');
    _mc.font = font;
    return _mc.measureText(text).width;
}

function mainFont(sz)  { return `bold ${sz}px "${FONT_FAMILY}"`; }
function subFont(sz)   { return `${sz}px "${FONT_FAMILY}"`; }

// ─────────────────────────────────────────────────────────────
//  Build tree structure
// ─────────────────────────────────────────────────────────────
function buildTree(infectedData, presentIds) {
    const present = new Set(presentIds);
    const entries = Object.entries(infectedData).filter(([id]) => present.has(id));

    // children map: parentId → [childId, ...]
    const children = new Map();
    children.set(null, []);
    for (const [id] of entries) {
        if (!children.has(id)) children.set(id, []);
    }
    for (const [id] of entries) {
        const parentRaw = infectedData[id]?.infectedBy ?? null;
        const parent = (parentRaw && present.has(parentRaw) && infectedData[parentRaw])
            ? parentRaw : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(id);
    }

    return { roots: children.get(null) || [], children };
}

// ─────────────────────────────────────────────────────────────
//  Compute subtree widths (bottom-up) for layout
// ─────────────────────────────────────────────────────────────
function computeSubtreeWidths(id, children, boxWidths) {
    const kids = children.get(id) || [];
    if (kids.length === 0) {
        return boxWidths.get(id) || BOX_MIN_W;
    }
    const kidsTotal = kids.reduce((sum, k) => {
        return sum + computeSubtreeWidths(k, children, boxWidths);
    }, 0) + (kids.length - 1) * COL_GAP;
    const self = boxWidths.get(id) || BOX_MIN_W;
    const result = Math.max(self, kidsTotal);
    // cache
    boxWidths.set('__subtree_' + id, result);
    return result;
}

// ─────────────────────────────────────────────────────────────
//  Assign x positions using subtree widths
// ─────────────────────────────────────────────────────────────
function assignX(id, leftEdge, children, boxWidths, positions) {
    const subtreeW = boxWidths.get('__subtree_' + id) ?? (boxWidths.get(id) || BOX_MIN_W);
    const self     = boxWidths.get(id) || BOX_MIN_W;
    // Centre self within the subtree
    const x = leftEdge + (subtreeW - self) / 2;
    positions.set(id, { ...( positions.get(id) || {}), x });

    const kids = children.get(id) || [];
    let cursor = leftEdge;
    for (const kid of kids) {
        const kidSubW = boxWidths.get('__subtree_' + kid) ?? (boxWidths.get(kid) || BOX_MIN_W);
        assignX(kid, cursor, children, boxWidths, positions);
        cursor += kidSubW + COL_GAP;
    }
}

// ─────────────────────────────────────────────────────────────
//  Full layout
// ─────────────────────────────────────────────────────────────
function layout(roots, children, nameMap, invokerId) {
    // BFS for generations
    const generations = [];
    let current = roots.slice();
    while (current.length > 0) {
        generations.push(current);
        const next = [];
        for (const id of current) {
            next.push(...(children.get(id) || []));
        }
        current = next;
    }

    // Count direct children per node (for badge)
    const directCount = new Map();
    for (const gen of generations) {
        for (const id of gen) {
            directCount.set(id, (children.get(id) || []).length);
        }
    }

    // Box widths
    const boxWidths = new Map();
    const FONT_SZ_MAIN = 13;
    const FONT_SZ_SUB  = 11;
    for (const gen of generations) {
        for (const id of gen) {
            const label = nameMap.get(id) || id.slice(0, 8);
            const cnt   = directCount.get(id) || 0;
            const subLabel = cnt > 0 ? `spread to ${cnt}` : '';
            const mw = measureText(label, mainFont(FONT_SZ_MAIN));
            const sw = subLabel ? measureText(subLabel, subFont(FONT_SZ_SUB)) : 0;
            const w  = Math.max(BOX_MIN_W, Math.ceil(Math.max(mw, sw)) + BOX_PAD_X * 2);
            boxWidths.set(id, w);
        }
    }

    // Compute subtree widths bottom-up
    for (const root of roots) {
        computeSubtreeWidths(root, children, boxWidths);
    }

    // Total roots width
    const totalRootsW = roots.reduce((sum, r) => {
        return sum + (boxWidths.get('__subtree_' + r) ?? (boxWidths.get(r) || BOX_MIN_W));
    }, 0) + (roots.length - 1) * COL_GAP;

    // Assign x per root
    const positions = new Map();
    let cursor = 0;
    for (const root of roots) {
        const rootSubW = boxWidths.get('__subtree_' + root) ?? (boxWidths.get(root) || BOX_MIN_W);
        assignX(root, cursor, children, boxWidths, positions);
        cursor += rootSubW + COL_GAP;
    }

    // Assign y per generation
    for (let g = 0; g < generations.length; g++) {
        const y = g * (BOX_H + ROW_GAP);
        for (const id of generations[g]) {
            const pos = positions.get(id) || { x: 0 };
            positions.set(id, { ...pos, y, w: boxWidths.get(id) || BOX_MIN_W, h: BOX_H });
        }
    }

    return { positions, generations, directCount, totalRootsW };
}

// ─────────────────────────────────────────────────────────────
//  Draw rounded rect
// ─────────────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y,         x + r, y);
    ctx.closePath();
}

// ─────────────────────────────────────────────────────────────
//  Main render
// ─────────────────────────────────────────────────────────────
/**
 * @param {object}             opts
 * @param {object}             opts.infectedData    guildId data slice
 * @param {string[]}           opts.presentIds      non-bot member IDs
 * @param {Map<string,string>} opts.nameMap          userId → display name
 * @param {string}             opts.invokerId        command caller (highlighted)
 * @param {string}             opts.guildName
 * @param {number}             [opts.zoomScale=1]    multiplier applied AFTER auto-scale
 * @returns {Buffer} PNG
 */
async function generateTree({ infectedData, presentIds, nameMap, invokerId, guildName, zoomScale = 1 }) {
    const { roots, children } = buildTree(infectedData, presentIds);

    // ── Empty state ────────────────────────────────────────
    if (roots.length === 0) {
        const W = 560, H = 160;
        const canvas = createCanvas(W, H);
        const ctx    = canvas.getContext('2d');
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = TITLE_COLOR;
        ctx.font = mainFont(18);
        ctx.textAlign = 'center';
        ctx.fillText('INFECTION LINEAGE TREE', W / 2, 52);
        ctx.font = subFont(14);
        ctx.fillStyle = LEGEND_COLOR;
        ctx.fillText('No infected subjects — population is clean.', W / 2, 100);
        return canvas.toBuffer('image/png');
    }

    // ── Layout ─────────────────────────────────────────────
    const { positions, generations, directCount, totalRootsW } = layout(roots, children, nameMap, invokerId);

    // Canvas natural size
    let maxX = 0, maxY = 0;
    for (const [, n] of positions) {
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
    }

    const naturalW = maxX + CANVAS_PAD * 2;
    const naturalH = maxY + CANVAS_PAD * 2 + TITLE_H + LEGEND_H;

    // Auto-scale: shrink so canvas never exceeds MAX_AUTO_WIDTH
    const autoScale = naturalW > MAX_AUTO_WIDTH ? MAX_AUTO_WIDTH / naturalW : 1;
    const scale     = autoScale * zoomScale;

    const W = Math.ceil(naturalW * scale);
    const H = Math.ceil(naturalH * scale);

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // Apply uniform scale
    ctx.scale(scale, scale);

    // ── Background ─────────────────────────────────────────
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, naturalW, naturalH);

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < naturalW; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, naturalH); ctx.stroke();
    }
    for (let y = 0; y < naturalH; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(naturalW, y); ctx.stroke();
    }

    // ── Title ──────────────────────────────────────────────
    ctx.fillStyle = TITLE_COLOR;
    ctx.font = mainFont(18);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`INFECTION LINEAGE TREE  —  ${guildName.toUpperCase()}`, naturalW / 2, TITLE_H / 2);

    // Underline
    ctx.strokeStyle = '#2a4a5a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CANVAS_PAD, TITLE_H - 4);
    ctx.lineTo(naturalW - CANVAS_PAD, TITLE_H - 4);
    ctx.stroke();

    const offsetX = CANVAS_PAD;
    const offsetY = CANVAS_PAD + TITLE_H;

    // ── Connecting lines ───────────────────────────────────
    ctx.lineWidth = 1.5;

    for (const [parentId, node] of positions) {
        const kids = children.get(parentId) || [];
        for (const kidId of kids) {
            const kid = positions.get(kidId);
            if (!kid) continue;

            const px  = offsetX + node.x + node.w / 2;
            const py  = offsetY + node.y + node.h;
            const kx  = offsetX + kid.x  + kid.w  / 2;
            const ky  = offsetY + kid.y;
            const mid = py + (ky - py) * 0.45;

            ctx.strokeStyle = LINE_COLOR;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.bezierCurveTo(px, mid, kx, mid, kx, ky);
            ctx.stroke();

            // Small arrow tip
            ctx.fillStyle = LINE_COLOR;
            ctx.beginPath();
            ctx.moveTo(kx, ky);
            ctx.lineTo(kx - 4, ky - 7);
            ctx.lineTo(kx + 4, ky - 7);
            ctx.closePath();
            ctx.fill();
        }
    }

    // ── Boxes ──────────────────────────────────────────────
    const FONT_SZ_MAIN = 13;
    const FONT_SZ_SUB  = 11;

    for (const [id, node] of positions) {
        const bx = offsetX + node.x;
        const by = offsetY + node.y;
        const isInvoker   = id === invokerId;
        const isPatientZ  = !infectedData[id]?.infectedBy || !presentIds.includes(infectedData[id]?.infectedBy) || !infectedData[infectedData[id]?.infectedBy];

        const fill   = isInvoker ? BOX_INVOKER : (isPatientZ ? BOX_ZERO : BOX_NORMAL);
        const stroke = isInvoker ? BOX_STROKE_I : (isPatientZ ? BOX_STROKE_Z : BOX_STROKE_N);

        // Shadow
        ctx.shadowColor   = stroke + '55';
        ctx.shadowBlur    = 8;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;

        ctx.fillStyle = fill;
        roundRect(ctx, bx, by, node.w, node.h, BOX_RADIUS);
        ctx.fill();

        ctx.shadowBlur = 0;

        ctx.strokeStyle = stroke;
        ctx.lineWidth   = isInvoker ? 2 : 1.5;
        roundRect(ctx, bx, by, node.w, node.h, BOX_RADIUS);
        ctx.stroke();

        // Label
        const label    = nameMap.get(id) || id.slice(0, 8);
        const cnt      = directCount.get(id) || 0;
        const subLabel = cnt > 0 ? `spread to ${cnt}` : (isPatientZ ? 'patient zero' : '');

        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle   = TEXT_MAIN;
        ctx.font        = mainFont(FONT_SZ_MAIN);

        const cy = by + node.h / 2;
        if (subLabel) {
            ctx.fillText(label, bx + node.w / 2, cy - 7);
            ctx.fillStyle = TEXT_SUB;
            ctx.font      = subFont(FONT_SZ_SUB);
            ctx.fillText(subLabel, bx + node.w / 2, cy + 8);
        } else {
            ctx.fillText(label, bx + node.w / 2, cy);
        }
    }

    // ── Legend ─────────────────────────────────────────────
    ctx.shadowBlur = 0;
    const legendY = naturalH - LEGEND_H + 6;
    const items = [
        { color: BOX_STROKE_Z, label: 'Patient Zero' },
        { color: BOX_STROKE_I, label: 'You'          },
        { color: BOX_STROKE_N, label: 'Infected'     },
    ];
    let lx = CANVAS_PAD;
    ctx.font = subFont(10);
    ctx.textBaseline = 'middle';
    for (const item of items) {
        ctx.fillStyle = item.color;
        ctx.fillRect(lx, legendY + 2, 10, 10);
        ctx.fillStyle = LEGEND_COLOR;
        ctx.textAlign = 'left';
        ctx.fillText(item.label, lx + 14, legendY + 7);
        lx += 14 + ctx.measureText(item.label).width + 24;
    }

    // Scale hint if auto-scaled
    if (scale < 0.99) {
        ctx.fillStyle = LEGEND_COLOR;
        ctx.font = subFont(10);
        ctx.textAlign = 'right';
        ctx.fillText(`auto-scaled to ${Math.round(scale * 100)}%  |  use =it zoom <N> for bigger`, naturalW - CANVAS_PAD, legendY + 7);
    }

    return canvas.toBuffer('image/png');
}

module.exports = { generateTree };