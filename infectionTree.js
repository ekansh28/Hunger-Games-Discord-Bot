// ============================================================
// infectionTree.js — Renders an infection lineage tree image
//
// generateTree(opts)  — returns a PNG Buffer of the full tree
// generateTreeViewport(opts) — returns a PNG Buffer of a
//   cropped viewport region (for paginated Discord navigation)
//
// Discord interactive navigation is handled in infection.js
// via handleTreeCommand, which sends buttons and re-renders
// the viewport on each press.
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
const BOX_NORMAL   = '#1e3a4a';
const BOX_ZERO     = '#3a1a1a';
const BOX_INVOKER  = '#3a1a5a';
const BOX_STROKE_N = '#5ab4d4';
const BOX_STROKE_Z = '#d45a5a';
const BOX_STROKE_I = '#a06adf';
const TEXT_COLOR   = '#ffffff';
const LINE_COLOR   = '#000000';

const BOX_H      = 36;
const BOX_PAD_X  = 14;
const BOX_MIN_W  = 70;
const BOX_RADIUS = 5;
const COL_GAP    = 22;
const ROW_GAP    = 56;
const CANVAS_PAD = 32;

// Viewport size sent to Discord (fits well as an embed image)
const VP_W = 900;
const VP_H = 500;

// ─────────────────────────────────────────────────────────────
//  Text measurement
// ─────────────────────────────────────────────────────────────
let _mc = null;
function measureText(text, font) {
    if (!_mc) _mc = createCanvas(10, 10).getContext('2d');
    _mc.font = font;
    return _mc.measureText(text).width;
}
function mainFont(sz) { return `bold ${sz}px "${FONT_FAMILY}"`; }

// ─────────────────────────────────────────────────────────────
//  Resolve parent links — uses infectedBy when present, otherwise
//  infers from infection timestamps for legacy records.
// ─────────────────────────────────────────────────────────────
function resolveParentLinks(infectedData, presentIds) {
    const present = new Set(presentIds);
    const entries = Object.entries(infectedData)
        .filter(([id]) => present.has(id))
        .map(([id, rec]) => ({
            id,
            ts: rec?.timestamp ?? null,
            infectedBy: rec && 'infectedBy' in rec ? rec.infectedBy : undefined,
        }));

    const sorted = [...entries].sort((a, b) => {
        if (a.ts == null && b.ts == null) return a.id.localeCompare(b.id);
        if (a.ts == null) return 1;
        if (b.ts == null) return -1;
        if (a.ts !== b.ts) return a.ts - b.ts;
        return a.id.localeCompare(b.id);
    });

    const parentOf = new Map();
    const alreadyInfected = [];

    for (const entry of sorted) {
        let parent = null;

        if (entry.infectedBy && present.has(entry.infectedBy) && infectedData[entry.infectedBy] && entry.infectedBy !== entry.id) {
            parent = entry.infectedBy;
        } else if (alreadyInfected.length) {
            // Missing/invalid infectedBy on older records — attach to the prior infection
            // so the tree keeps depth instead of flattening everyone into one row.
            parent = alreadyInfected[alreadyInfected.length - 1];
        }

        parentOf.set(entry.id, parent);
        alreadyInfected.push(entry.id);
    }

    return parentOf;
}

// ─────────────────────────────────────────────────────────────
//  Build tree structure
// ─────────────────────────────────────────────────────────────
function buildTree(infectedData, presentIds) {
    const parentOf = resolveParentLinks(infectedData, presentIds);
    const children = new Map();
    children.set(null, []);

    for (const id of parentOf.keys()) {
        if (!children.has(id)) children.set(id, []);
    }

    for (const [id, parent] of parentOf) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(id);
    }

    const ts = id => infectedData[id]?.timestamp ?? 0;
    for (const [, kids] of children) {
        kids.sort((a, b) => ts(a) - ts(b) || a.localeCompare(b));
    }
    if (children.get(null)) {
        children.get(null).sort((a, b) => ts(a) - ts(b) || a.localeCompare(b));
    }

    return { roots: children.get(null) || [], children, parentOf };
}

// ─────────────────────────────────────────────────────────────
//  Subtree width (bottom-up)
// ─────────────────────────────────────────────────────────────
function computeSubtreeWidth(id, children, boxWidths) {
    const cacheKey = '_sw' + id;
    if (boxWidths.has(cacheKey)) return boxWidths.get(cacheKey);
    const kids = children.get(id) || [];
    const self = boxWidths.get(id) || BOX_MIN_W;
    if (!kids.length) { boxWidths.set(cacheKey, self); return self; }
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
    positions.set(id, { ...(positions.get(id) || {}), x });
    const kids   = children.get(id) || [];
    let   cursor = leftEdge;
    for (const kid of kids) {
        assignX(kid, cursor, children, boxWidths, positions);
        cursor += computeSubtreeWidth(kid, children, boxWidths) + COL_GAP;
    }
}

// ─────────────────────────────────────────────────────────────
//  Full layout — returns positions Map + canvas natural dims
// ─────────────────────────────────────────────────────────────
function layout(roots, children, nameMap) {
    // Depth-first generation assignment keeps siblings on the same row
    // while preserving parent/child hierarchy down the tree.
    const depthOf = new Map();
    const generations = [];
    const visit = (id, depth) => {
        if (!generations[depth]) generations[depth] = [];
        generations[depth].push(id);
        depthOf.set(id, depth);
        for (const kid of children.get(id) || []) visit(kid, depth + 1);
    };
    for (const root of roots) visit(root, 0);

    // Box widths
    const FSZMAIN  = 13;
    const boxWidths = new Map();
    for (const gen of generations) {
        for (const id of gen) {
            const label = nameMap.get(id) || id.slice(0, 8);
            const w = Math.max(BOX_MIN_W, Math.ceil(measureText(label, mainFont(FSZMAIN))) + BOX_PAD_X * 2);
            boxWidths.set(id, w);
        }
    }
    for (const root of roots) computeSubtreeWidth(root, children, boxWidths);

    // Assign X
    const positions = new Map();
    let cursor = 0;
    for (const root of roots) {
        assignX(root, cursor, children, boxWidths, positions);
        cursor += computeSubtreeWidth(root, children, boxWidths) + COL_GAP;
    }

    // Assign Y
    for (let g = 0; g < generations.length; g++) {
        const y = g * (BOX_H + ROW_GAP);
        for (const id of generations[g]) {
            const pos = positions.get(id) || { x: 0 };
            positions.set(id, { ...pos, y, w: boxWidths.get(id) || BOX_MIN_W, h: BOX_H });
        }
    }

    // Natural canvas size
    let maxX = 0, maxY = 0;
    for (const [, n] of positions) {
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
    }

    return {
        positions,
        naturalW: maxX + CANVAS_PAD * 2,
        naturalH: maxY + CANVAS_PAD * 2,
    };
}

// ─────────────────────────────────────────────────────────────
//  Rounded rect path helper
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
//  Core draw — renders full tree onto a given canvas context
//  at the given offset (ox, oy) and scale.
// ─────────────────────────────────────────────────────────────
function drawTree(ctx, positions, children, infectedData, presentIds, nameMap, invokerId, parentOf, ox, oy) {
    const FSZMAIN = 13;

    // ── Wires (under boxes) ───────────────────────────────────
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    for (const [parentId, node] of positions) {
        const kids = children.get(parentId) || [];
        if (!kids.length) continue;

        const pxC = ox + node.x + node.w / 2;
        const pyC = oy + node.y + node.h;

        if (kids.length === 1) {
            const kid = positions.get(kids[0]);
            if (!kid) continue;
            ctx.beginPath();
            ctx.moveTo(pxC, pyC);
            ctx.lineTo(ox + kid.x + kid.w / 2, oy + kid.y);
            ctx.stroke();
        } else {
            const midY = pyC + ROW_GAP / 2;
            const firstKid = positions.get(kids[0]);
            const lastKid  = positions.get(kids[kids.length - 1]);
            if (!firstKid || !lastKid) continue;

            const leftX  = ox + firstKid.x + firstKid.w / 2;
            const rightX = ox + lastKid.x  + lastKid.w  / 2;

            // Parent stem
            ctx.beginPath(); ctx.moveTo(pxC, pyC); ctx.lineTo(pxC, midY); ctx.stroke();
            // Horizontal rail
            ctx.beginPath(); ctx.moveTo(leftX, midY); ctx.lineTo(rightX, midY); ctx.stroke();
            // Drops to each child
            for (const kidId of kids) {
                const kid = positions.get(kidId);
                if (!kid) continue;
                ctx.beginPath();
                ctx.moveTo(ox + kid.x + kid.w / 2, midY);
                ctx.lineTo(ox + kid.x + kid.w / 2, oy + kid.y);
                ctx.stroke();
            }
        }
    }

    // ── Boxes ─────────────────────────────────────────────────
    for (const [id, node] of positions) {
        const bx = ox + node.x;
        const by = oy + node.y;
        const isInvoker  = id === invokerId;
        const isPatientZ = (parentOf.get(id) ?? null) === null;

        const fill   = isInvoker ? BOX_INVOKER : (isPatientZ ? BOX_ZERO   : BOX_NORMAL);
        const stroke = isInvoker ? BOX_STROKE_I : (isPatientZ ? BOX_STROKE_Z : BOX_STROKE_N);

        ctx.fillStyle = fill;
        roundRect(ctx, bx, by, node.w, node.h, BOX_RADIUS);
        ctx.fill();

        ctx.strokeStyle = stroke;
        ctx.lineWidth   = isInvoker ? 2 : 1.5;
        roundRect(ctx, bx, by, node.w, node.h, BOX_RADIUS);
        ctx.stroke();

        const label = nameMap.get(id) || id.slice(0, 8);
        ctx.fillStyle    = TEXT_COLOR;
        ctx.font         = mainFont(FSZMAIN);
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + node.w / 2, by + node.h / 2);
    }
}

// ─────────────────────────────────────────────────────────────
//  generateTree — full tree at auto-scale (original behaviour)
// ─────────────────────────────────────────────────────────────
async function generateTree({ infectedData, presentIds, nameMap, invokerId, zoomScale = 1 }) {
    const { roots, children, parentOf } = buildTree(infectedData, presentIds);
    if (!roots.length) return createCanvas(1, 1).toBuffer('image/png');

    const { positions, naturalW, naturalH } = layout(roots, children, nameMap);

    const MAX_AUTO = 2000;
    const autoScale = naturalW > MAX_AUTO ? MAX_AUTO / naturalW : 1;
    const scale     = autoScale * Math.max(0.1, zoomScale);

    const W = Math.ceil(naturalW * scale);
    const H = Math.ceil(naturalH * scale);
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    ctx.scale(scale, scale);
    drawTree(ctx, positions, children, infectedData, presentIds, nameMap, invokerId, parentOf, CANVAS_PAD, CANVAS_PAD);

    return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────
//  generateTreeViewport — viewport crop for button navigation
//
//  panX / panY: top-left corner of the viewport in natural-space
//  zoom: scale multiplier (1 = 1:1, 2 = 2× magnified)
//
//  Returns { buf: Buffer<PNG>, naturalW, naturalH, clampedPanX, clampedPanY }
//  so the caller can update its stored pan state with clamped values.
// ─────────────────────────────────────────────────────────────
async function generateTreeViewport({ infectedData, presentIds, nameMap, invokerId, panX = 0, panY = 0, zoom = 1 }) {
    const { roots, children, parentOf } = buildTree(infectedData, presentIds);

    if (!roots.length) {
        // Empty tree — return a tiny transparent buffer
        return {
            buf: createCanvas(VP_W, VP_H).toBuffer('image/png'),
            naturalW: 0,
            naturalH: 0,
            clampedPanX: 0,
            clampedPanY: 0,
        };
    }

    const { positions, naturalW, naturalH } = layout(roots, children, nameMap);

    // Clamp pan so we don't scroll past the tree edges
    const scaledW = naturalW * zoom;
    const scaledH = naturalH * zoom;
    const clampedPanX = Math.max(0, Math.min(panX, Math.max(0, scaledW - VP_W)));
    const clampedPanY = Math.max(0, Math.min(panY, Math.max(0, scaledH - VP_H)));

    // Create the viewport canvas (transparent background)
    const canvas = createCanvas(VP_W, VP_H);
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, VP_W, VP_H);

    // Scale + translate so viewport shows the right region
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-clampedPanX / zoom, -clampedPanY / zoom);

    drawTree(ctx, positions, children, infectedData, presentIds, nameMap, invokerId, parentOf, CANVAS_PAD, CANVAS_PAD);

    ctx.restore();

    // ── HUD overlay ─────────────────────────────────────────
    // Mini-map rectangle indicator
    const mmW = 120, mmH = 70, mmX = VP_W - mmW - 10, mmY = VP_H - mmH - 10;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(mmX, mmY, mmW, mmH);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(mmX, mmY, mmW, mmH);

    // Mini-map viewport indicator
    if (scaledW > 0 && scaledH > 0) {
        const rx = mmX + (clampedPanX / scaledW) * mmW;
        const ry = mmY + (clampedPanY / scaledH) * mmH;
        const rw = Math.min(mmW, (VP_W  / scaledW) * mmW);
        const rh = Math.min(mmH, (VP_H  / scaledH) * mmH);
        ctx.fillStyle = 'rgba(90,180,212,0.35)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#5ab4d4';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx, ry, rw, rh);
    }

    // Zoom label
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, VP_H - 28, 90, 22);
    ctx.fillStyle = '#aaa';
    ctx.font = `12px "${FONT_FAMILY}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`zoom: ${zoom.toFixed(1)}×`, 14, VP_H - 17);

    return {
        buf: canvas.toBuffer('image/png'),
        naturalW,
        naturalH,
        clampedPanX,
        clampedPanY,
    };
}

module.exports = { generateTree, generateTreeViewport };