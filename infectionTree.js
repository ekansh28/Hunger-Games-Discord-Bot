// ============================================================
// infectionTree.js — Renders an infection lineage tree image
//
// Transparent background, black wire connectors, no decorative
// text — only user name boxes and their hierarchy lines.
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
const BOX_NORMAL   = '#1e3a4a';   // dark teal
const BOX_ZERO     = '#3a1a1a';   // dark red  — patient zeros
const BOX_INVOKER  = '#3a1a5a';   // purple    — command caller
const BOX_STROKE_N = '#5ab4d4';   // teal outline
const BOX_STROKE_Z = '#d45a5a';   // red outline  — patient zeros
const BOX_STROKE_I = '#a06adf';   // purple outline — invoker
const TEXT_COLOR   = '#ffffff';
const LINE_COLOR   = '#000000';   // black wire

const BOX_H        = 36;
const BOX_PAD_X    = 14;
const BOX_MIN_W    = 70;
const BOX_RADIUS   = 5;
const COL_GAP      = 22;
const ROW_GAP      = 56;
const CANVAS_PAD   = 32;

const MAX_AUTO_WIDTH = 2000;

// ─────────────────────────────────────────────────────────────
//  Measure text
// ─────────────────────────────────────────────────────────────
let _mc = null;
function measureText(text, font) {
    if (!_mc) _mc = createCanvas(10, 10).getContext('2d');
    _mc.font = font;
    return _mc.measureText(text).width;
}

function mainFont(sz) { return `bold ${sz}px "${FONT_FAMILY}"`; }

// ─────────────────────────────────────────────────────────────
//  Build tree structure
// ─────────────────────────────────────────────────────────────
function buildTree(infectedData, presentIds) {
    const present = new Set(presentIds);
    const entries = Object.entries(infectedData).filter(([id]) => present.has(id));
    const children = new Map();
    children.set(null, []);
    
    for (const [id] of entries) {
        if (!children.has(id)) children.set(id, []);
    }
    for (const [id] of entries) {
        const raw    = infectedData[id]?.infectedBy ?? null;
        const parent = (raw && present.has(raw) && infectedData[raw]) ? raw : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(id);
    }

    return { roots: children.get(null) || [], children };
}

// ─────────────────────────────────────────────────────────────
//  Subtree widths (bottom-up, cached with prefix key)
// ─────────────────────────────────────────────────────────────
function computeSubtreeWidth(id, children, boxWidths) {
    const cacheKey = '_sw' + id;
    if (boxWidths.has(cacheKey)) return boxWidths.get(cacheKey);
    
    const kids = children.get(id) || [];
    const self = boxWidths.get(id) || BOX_MIN_W;
    if (kids.length === 0) {
        boxWidths.set(cacheKey, self);
        return self;
    }
    
    const kidsTotal = kids.reduce((s, k) => s + computeSubtreeWidth(k, children, boxWidths), 0) + (kids.length - 1) * COL_GAP;
    const result = Math.max(self, kidsTotal);
    boxWidths.set(cacheKey, result);
    return result;
}

// ─────────────────────────────────────────────────────────────
//  Assign X positions
// ─────────────────────────────────────────────────────────────
function assignX(id, leftEdge, children, boxWidths, positions) {
    const subtreeW = computeSubtreeWidth(id, children, boxWidths);
    const self     = boxWidths.get(id) || BOX_MIN_W;
    const x        = leftEdge + (subtreeW - self) / 2;
    const existing = positions.get(id) || {};
    positions.set(id, { ...existing, x });
    
    const kids = children.get(id) || [];
    let cursor = leftEdge;
    for (const kid of kids) {
        assignX(kid, cursor, children, boxWidths, positions);
        cursor += computeSubtreeWidth(kid, children, boxWidths) + COL_GAP;
    }
}

// ─────────────────────────────────────────────────────────────
//  Full layout
// ─────────────────────────────────────────────────────────────
function layout(roots, children, nameMap) {
    // BFS generations
    const generations = [];
    let current = roots.slice();
    while (current.length > 0) {
        generations.push(current);
        const next = [];
        for (const id of current) next.push(...(children.get(id) || []));
        current = next;
    }
    
    // Box widths from label text
    const boxWidths = new Map();
    const FSZMAIN = 13;
    for (const gen of generations) {
        for (const id of gen) {
            const label = nameMap.get(id) || id.slice(0, 8);
            const w = Math.max(BOX_MIN_W, Math.ceil(measureText(label, mainFont(FSZMAIN))) + BOX_PAD_X * 2);
            boxWidths.set(id, w);
        }
    }

    // Pre-compute all subtree widths bottom-up
    for (const root of roots) computeSubtreeWidth(root, children, boxWidths);

    // Assign X per root
    const positions = new Map();
    let cursor = 0;
    for (const root of roots) {
        assignX(root, cursor, children, boxWidths, positions);
        cursor += computeSubtreeWidth(root, children, boxWidths) + COL_GAP;
    }

    // Assign Y per generation
    for (let g = 0; g < generations.length; g++) {
        const y = g * (BOX_H + ROW_GAP);
        for (const id of generations[g]) {
            const pos = positions.get(id) || { x: 0 };
            positions.set(id, { ...pos, y, w: boxWidths.get(id) || BOX_MIN_W, h: BOX_H });
        }
    }

    return positions;
}

// ─────────────────────────────────────────────────────────────
//  Rounded rect path
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
@param {object}             opts
@param {object}             opts.infectedData
@param {string[]}           opts.presentIds
@param {Map<string,string>} opts.nameMap
@param {string}             opts.invokerId
@param {string}             opts.guildName      (unused — no title rendered)
@param {number}             [opts.zoomScale=1]
@returns {Buffer} PNG with transparent background
*/
async function generateTree({ infectedData, presentIds, nameMap, invokerId, guildName, zoomScale = 1 }) {
    const { roots, children } = buildTree(infectedData, presentIds);
    
    // ── Empty state ────────────────────────────────────────
    if (roots.length === 0) {
        // Transparent 1×1 — caller should handle "no infected" messaging
        return createCanvas(1, 1).toBuffer('image/png');
    }
    
    // ── Layout ─────────────────────────────────────────────
    const positions = layout(roots, children, nameMap);
    let maxX = 0, maxY = 0;
    for (const [, n] of positions) {
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
    }
    
    const naturalW = maxX + CANVAS_PAD * 2;
    const naturalH = maxY + CANVAS_PAD * 2;
    
    const autoScale = naturalW > MAX_AUTO_WIDTH ? MAX_AUTO_WIDTH / naturalW : 1;
    const scale     = autoScale * Math.max(0.1, zoomScale);
    
    const W = Math.ceil(naturalW * scale);
    const H = Math.ceil(naturalH * scale);
    
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');
    
    // Transparent — do NOT fill background at all
    ctx.scale(scale, scale);
    const ox = CANVAS_PAD;
    const oy = CANVAS_PAD;
    
    // ── Wires (drawn under boxes) ──────────────────────────
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    
    for (const [parentId, node] of positions) {
        const kids = children.get(parentId) || [];
        if (kids.length === 0) continue;
        
        const pxC = ox + node.x + node.w / 2;
        const pyC = oy + node.y + node.h;
        
        if (kids.length === 1) {
            // Single child — straight vertical drop
            const kid = positions.get(kids[0]);
            if (!kid) continue;
            const kxC = ox + kid.x + kid.w / 2;
            const kyC = oy + kid.y;
            ctx.beginPath();
            ctx.moveTo(pxC, pyC);
            ctx.lineTo(kxC, kyC);
            ctx.stroke();
        } else {
            // Multiple children — T-junction wire style
            const midY = pyC + ROW_GAP / 2;
            
            // Leftmost and rightmost child centres
            const firstKid = positions.get(kids[0]);
            const lastKid  = positions.get(kids[kids.length - 1]);
            if (!firstKid || !lastKid) continue;
            
            const leftX  = ox + firstKid.x + firstKid.w / 2;
            const rightX = ox + lastKid.x  + lastKid.w  / 2;
            
            // Vertical from parent down to horizontal rail
            ctx.beginPath();
            ctx.moveTo(pxC, pyC);
            ctx.lineTo(pxC, midY);
            ctx.stroke();
            
            // Horizontal rail
            ctx.beginPath();
            ctx.moveTo(leftX, midY);
            ctx.lineTo(rightX, midY);
            ctx.stroke();
            
            // Vertical drop to each child
            for (const kidId of kids) {
                const kid = positions.get(kidId);
                if (!kid) continue;
                const kxC = ox + kid.x + kid.w / 2;
                const kyC = oy + kid.y;
                ctx.beginPath();
                ctx.moveTo(kxC, midY);
                ctx.lineTo(kxC, kyC);
                ctx.stroke();
            }
        }
    }
    
    // ── Boxes ──────────────────────────────────────────────
    const FSZMAIN = 13;
    for (const [id, node] of positions) {
        const bx = ox + node.x;
        const by = oy + node.y;
        const isInvoker  = id === invokerId;
        const rawParent  = infectedData[id]?.infectedBy ?? null;
        const isPatientZ = !rawParent || !presentIds.includes(rawParent) || !infectedData[rawParent];
        
        const fill   = isInvoker ? BOX_INVOKER : (isPatientZ ? BOX_ZERO   : BOX_NORMAL);
        const stroke = isInvoker ? BOX_STROKE_I : (isPatientZ ? BOX_STROKE_Z : BOX_STROKE_N);
        
        // Box fill
        ctx.fillStyle = fill;
        roundRect(ctx, bx, by, node.w, node.h, BOX_RADIUS);
        ctx.fill();
        
        // Box border
        ctx.strokeStyle = stroke;
        ctx.lineWidth   = isInvoker ? 2 : 1.5;
        roundRect(ctx, bx, by, node.w, node.h, BOX_RADIUS);
        ctx.stroke();
        
        // Username label only
        const label = nameMap.get(id) || id.slice(0, 8);
        ctx.fillStyle    = TEXT_COLOR;
        ctx.font         = mainFont(FSZMAIN);
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + node.w / 2, by + node.h / 2);
    }
    
    return canvas.toBuffer('image/png');
}

module.exports = { generateTree };