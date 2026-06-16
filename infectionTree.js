// ============================================================
// infectionTree.js — Renders an infection lineage tree image
//
// Builds a top-down generational tree:
//   Generation 0 = patient zeros (self-infected, infectedBy: null)
//   Generation 1 = infected by gen-0, etc.
//
// Styled like the reference screenshot: light-blue boxes,
// white text, black background, connecting lines between
// parent and children, "You :3" box highlighted in purple.
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

// ── Visual constants ─────────────────────────────────────────
const BG_COLOR        = '#000000';
const BOX_COLOR       = '#a8d8ea';   // light blue (healthy-ish node)
const BOX_INFECTED    = '#5b4fcf';   // purple highlight for the command invoker
const BOX_TEXT        = '#000000';
const LINE_COLOR      = '#ffffff';
const TITLE_COLOR     = '#ffffff';

const BOX_H           = 36;
const BOX_PADDING_X   = 16;         // internal horizontal text padding
const BOX_MIN_W       = 60;
const COL_GAP         = 18;         // horizontal gap between sibling boxes
const ROW_GAP         = 70;         // vertical gap between generations
const CANVAS_PADDING  = 40;
const TITLE_HEIGHT    = 50;

// ─────────────────────────────────────────────────────────────
//  Build tree data from infected.json data
//
//  infectedData shape: { userId: { infectedBy: string|null, ... } }
//  Returns: { roots: string[], children: Map<string|null, string[]> }
// ─────────────────────────────────────────────────────────────
function buildTree(infectedData, presentIds) {
    // presentIds = Set of userIds actually in the server
    const present = new Set(presentIds);

    // Only include entries whose userId is in the server
    const entries = Object.entries(infectedData).filter(([id]) => present.has(id));

    // children map: parentId → [childId, ...]
    const children = new Map();
    children.set(null, []); // null = roots (no infector, or infector not present)

    for (const [id] of entries) {
        const infectedBy = infectedData[id]?.infectedBy ?? null;
        // If infector is not in the infected+present set, treat as root
        const parentKey = (infectedBy && present.has(infectedBy) && infectedData[infectedBy])
            ? infectedBy
            : null;

        if (!children.has(parentKey)) children.set(parentKey, []);
        children.get(parentKey).push(id);
    }

    return { roots: children.get(null) || [], children };
}

// ─────────────────────────────────────────────────────────────
//  Measure text width with a temporary canvas context
// ─────────────────────────────────────────────────────────────
let _measureCtx = null;
function measureText(text, fontSize = 14) {
    if (!_measureCtx) {
        _measureCtx = createCanvas(100, 100).getContext('2d');
    }
    _measureCtx.font = `${fontSize}px "${FONT_FAMILY}"`;
    return _measureCtx.measureText(text).width;
}

function boxWidth(label) {
    return Math.max(BOX_MIN_W, Math.ceil(measureText(label, 14)) + BOX_PADDING_X * 2);
}

// ─────────────────────────────────────────────────────────────
//  Layout algorithm
//
//  Returns: Map<userId, { x, y, w, h, label }>
//  x/y = top-left corner of box (before adding CANVAS_PADDING)
// ─────────────────────────────────────────────────────────────
function layout(roots, children, nameMap, invokerId) {
    // BFS to get generations
    const generations = [];
    let current = roots.slice();

    while (current.length > 0) {
        generations.push(current);
        const next = [];
        for (const id of current) {
            const kids = children.get(id) || [];
            next.push(...kids);
        }
        current = next;
    }

    // Compute box widths per node
    const nodes = new Map(); // id → { label, w, h, gen, x, y }
    for (let g = 0; g < generations.length; g++) {
        for (const id of generations[g]) {
            const label = nameMap.get(id) || id.slice(0, 6);
            nodes.set(id, { label, w: boxWidth(label), h: BOX_H, gen: g, x: 0, y: 0 });
        }
    }

    // Bottom-up x positioning: each node centered over its children
    // We do a simple left-to-right pack per row then center parents

    // First pass: position each generation left-to-right
    for (let g = generations.length - 1; g >= 0; g--) {
        const gen = generations[g];
        let cursor = 0;
        for (const id of gen) {
            const node = nodes.get(id);
            const kids = children.get(id) || [];
            if (kids.length > 0 && g < generations.length - 1) {
                // Center over children
                const leftChild  = nodes.get(kids[0]);
                const rightChild = nodes.get(kids[kids.length - 1]);
                const childSpan  = (rightChild.x + rightChild.w) - leftChild.x;
                const cx = leftChild.x + childSpan / 2 - node.w / 2;
                node.x = Math.max(cursor, cx);
            } else {
                node.x = cursor;
            }
            cursor = node.x + node.w + COL_GAP;
        }

        // If this gen's nodes have shifted right of their children, nudge children right
        if (g < generations.length - 1) {
            // Check each parent/child alignment
            for (const id of gen) {
                const node = nodes.get(id);
                const kids = children.get(id) || [];
                if (!kids.length) continue;
                const leftChild = nodes.get(kids[0]);
                const parentCX  = node.x + node.w / 2;
                const childGroupW = kids.reduce((acc, k) => {
                    const kn = nodes.get(k); return acc + kn.w;
                }, 0) + (kids.length - 1) * COL_GAP;
                const desiredLeft = parentCX - childGroupW / 2;
                const shift = desiredLeft - leftChild.x;
                if (shift > 0) {
                    // Push all kids (and their subtrees) right
                    nudgeSubtree(kids, shift, nodes, children);
                }
            }
        }
    }

    // Assign y positions
    for (let g = 0; g < generations.length; g++) {
        const y = g * (BOX_H + ROW_GAP);
        for (const id of generations[g]) {
            nodes.get(id).y = y;
        }
    }

    return nodes;
}

function nudgeSubtree(ids, shift, nodes, children) {
    for (const id of ids) {
        const node = nodes.get(id);
        node.x += shift;
        const kids = children.get(id) || [];
        if (kids.length) nudgeSubtree(kids, shift, nodes, children);
    }
}

// ─────────────────────────────────────────────────────────────
//  Main render function
// ─────────────────────────────────────────────────────────────
/**
 * @param {object}            opts
 * @param {object}            opts.infectedData   guildId data slice from infected.json
 * @param {string[]}          opts.presentIds     userIds currently in the server (non-bot)
 * @param {Map<string,string>} opts.nameMap        userId → display name
 * @param {string}            opts.invokerId      userId of command caller (highlighted box)
 * @param {string}            opts.guildName
 * @returns {Buffer} PNG
 */
async function generateTree({ infectedData, presentIds, nameMap, invokerId, guildName }) {
    const { roots, children } = buildTree(infectedData, presentIds);

    if (roots.length === 0) {
        // No infected — render a minimal "clean" image
        const canvas = createCanvas(500, 160);
        const ctx    = canvas.getContext('2d');
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, 500, 160);
        ctx.fillStyle = TITLE_COLOR;
        ctx.font = `bold 20px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center';
        ctx.fillText('INFECTION LINEAGE TREE', 250, 50);
        ctx.font = `16px "${FONT_FAMILY}"`;
        ctx.fillStyle = '#888888';
        ctx.fillText('No infected subjects. Population is clean.', 250, 100);
        return canvas.toBuffer('image/png');
    }

    const nodes = layout(roots, children, nameMap, invokerId);

    // Canvas size
    let maxX = 0, maxY = 0;
    for (const [, n] of nodes) {
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
    }

    const W = maxX + CANVAS_PADDING * 2;
    const H = maxY + CANVAS_PADDING * 2 + TITLE_HEIGHT;

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    // Title
    ctx.fillStyle = TITLE_COLOR;
    ctx.font = `bold 18px "${FONT_FAMILY}"`;
    ctx.textAlign = 'center';
    ctx.fillText(`INFECTION LINEAGE TREE  —  ${guildName.toUpperCase()}`, W / 2, 28);

    const offsetX = CANVAS_PADDING;
    const offsetY = CANVAS_PADDING + TITLE_HEIGHT;

    // Draw connecting lines first (under boxes)
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth   = 1.5;

    for (const [parentId, node] of nodes) {
        const kids = children.get(parentId) || [];
        for (const kidId of kids) {
            const kid = nodes.get(kidId);
            if (!kid) continue;

            const px = offsetX + node.x + node.w / 2;
            const py = offsetY + node.y + node.h;
            const kx = offsetX + kid.x  + kid.w  / 2;
            const ky = offsetY + kid.y;

            const midY = py + (ky - py) / 2;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px, midY);
            ctx.lineTo(kx, midY);
            ctx.lineTo(kx, ky);
            ctx.stroke();
        }
    }

    // Draw boxes
    for (const [id, node] of nodes) {
        const bx = offsetX + node.x;
        const by = offsetY + node.y;

        const isInvoker = id === invokerId;
        ctx.fillStyle = isInvoker ? BOX_INFECTED : BOX_COLOR;

        // Rounded rect
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + node.w - r, by);
        ctx.quadraticCurveTo(bx + node.w, by, bx + node.w, by + r);
        ctx.lineTo(bx + node.w, by + node.h - r);
        ctx.quadraticCurveTo(bx + node.w, by + node.h, bx + node.w - r, by + node.h);
        ctx.lineTo(bx + r, by + node.h);
        ctx.quadraticCurveTo(bx, by + node.h, bx, by + node.h - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();

        // Label
        ctx.fillStyle = isInvoker ? '#ffffff' : BOX_TEXT;
        ctx.font = `14px "${FONT_FAMILY}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.label, bx + node.w / 2, by + node.h / 2);
    }

    return canvas.toBuffer('image/png');
}

module.exports = { generateTree };
