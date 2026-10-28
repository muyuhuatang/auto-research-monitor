/* Auto-Research Monitor - Cytoscape.js Frontend */

// Task detection: /t/{task_id} → task-scoped API base. The online demo
// (scripts/build_static.py) serves this page as view.html?task=<id> under a GitHub
// Pages path, so its loader, demo.js, names the task instead.
const TASK_MATCH = window.location.pathname.match(/^\/t\/([a-f0-9]+)\/?$/);
const TASK_ID = (window.AIVIS_STATIC && window.AIVIS_STATIC.task)
    || (TASK_MATCH ? TASK_MATCH[1] : null);
const API_BASE = TASK_ID ? `/api/tasks/${TASK_ID}` : '/api';

const NODE_TYPE_LABELS = {
    motivation: 'Motivation',
    rq: 'Question',
    hypothesis: 'Hypothesis',
    experiment_design: 'Experiment',
    artifact: 'Artifact',
    run: 'Run',
    result: 'Result',
    claim: 'Claim',
    conclusion: 'Conclusion',
    facts: 'Facts',
};

const NODE_TYPE_COLORS = {
    motivation: '#7C6F64',
    rq: '#458588',
    hypothesis: '#B16286',
    experiment_design: '#689D6A',
    artifact: '#D79921',
    run: '#98971A',
    result: '#076678',
    claim: '#4A6FE3',     // not a credibility colour: see server/schemas/nodes.py
    conclusion: '#9D7CD8',
    facts: '#83A598',
};

let cy;
let credibilityMode = false;
let nodeShapeMode = 'circle';
let edgeInferenceMode = 'heuristic';

let _layoutTimer = null;

// F1/F2 filtering state
let hiddenNodeTypes = new Set();
let hiddenEdgeTypes = new Set();

// F5 minimap
let minimapCanvas = null, minimapCtx = null;

// F7 collapsible branches
let collapsedNodes = new Map();     // nodeId → { removedJson, summaryNodeId }

// F8 interactive clusters
let collapsedClusters = new Set();

// F10 timeline mode / layout mode.
// layoutMode is the source of truth; timelineMode/organicMode are derived
// convenience flags so existing references keep working.
let layoutMode = 'organic';   // 'organic' | 'dagre' | 'timeline'
let timelineMode = false;     // derived: layoutMode === 'timeline'
let organicMode = true;       // derived: layoutMode === 'organic'

// Organic-mode fcose force layout (radial galaxy clustering).
// randomize:false + deterministic pre-seeding (see _seedOrganicPositions) keeps
// the arrangement STABLE across refreshes and lets new nodes settle in smoothly
// instead of re-randomizing the whole graph on every update. animate:true glides
// between positions rather than teleporting.
const ORGANIC_LAYOUT_OPTS = {
    name: 'fcose',
    quality: 'proof',
    randomize: false,
    animate: true,
    animationDuration: 900,
    animationEasing: 'ease-out',
    fit: false,                 // camera handled separately so it doesn't jump
    // Single unified force field (no component packing / tiling): disconnected
    // artifacts join the simulation and drift into an organic perimeter halo
    // around the connected galaxy, instead of being tiled into a side grid.
    packComponents: false,
    tile: false,
    // Spacing is set by the labels, not by the dots. Nodes carry up to 190px of
    // text under them, so an ideal edge length of 62 packed the core into a knot
    // where every label overlapped its neighbour's — and left the low-degree
    // outliers stranded far outside it, which stretched the bounding box and made
    // fit() zoom the whole graph down. Longer edges plus more separation spread
    // the core into the canvas and pull the outliers back toward it at once.
    nodeRepulsion: 11000,
    idealEdgeLength: 128,
    edgeElasticity: 0.55,
    nestingFactor: 0.1,
    gravity: 0.28,
    gravityRange: 4.2,
    numIter: 2500,
    nodeSeparation: 145,
};

// Deterministic seeding: nodes get a stable start position derived from their id,
// so the layout converges to the same arrangement every load. Only unseeded
// (newly arrived) nodes are placed; settled nodes keep their positions.
let _seededIds = new Set();
function _hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
}
// The galaxy has to be shaped like the window it lives in. A circular seed ring
// settles into a roughly circular blob, and on a 16:9 canvas fit() is then
// height-constrained — the graph shrinks to a third of the frame with dead space
// either side. Deriving the span from the live canvas aspect (and from the node
// count, so density stays constant as the graph grows) makes the layout fill the
// canvas in both directions instead.
function _organicSpan() {
    const n = Math.max((cy && cy.nodes().length) || 8, 8);
    // Deliberately NOT the live canvas size. The seed ran before the focus-mode width
    // transition had finished, so the same graph settled at a different scale on every
    // load depending on timing — which contradicts the determinism the seeding exists
    // to provide. Seed at a fixed 16:9 and let _orientToCanvas/_widenToCanvas adapt the
    // finished arrangement to whatever shape the canvas turned out to be; those run at
    // frame time, when the canvas has stopped moving.
    const aspect = 16 / 9;
    // ~14k model units of area per node ≈ nodeSeparation(78) + idealEdgeLength(62).
    const area = n * 14000;
    const ry = Math.sqrt(area / aspect) / 2;
    return { rx: ry * aspect, ry: ry };
}

// A force layout has no preferred orientation; the canvas emphatically does. An
// evidence chain (motivation -> question -> ... -> conclusion) settles into an
// elongated cloud, and when that cloud happens to land vertically, fit() becomes
// height-constrained and the graph renders at a third of the space available —
// which is exactly what a wide monitor showed. Rotating the whole arrangement so
// its principal axis matches the canvas's long axis is a rigid transform: every
// distance, every edge length and the entire shape are preserved, only the
// framing changes. Deterministic, so repeated loads still agree.
// Layout completion (in any of the three layout modes), a focus-mode switch and a
// window resize all want the same thing: re-measure the canvas, re-orient, re-frame. Firing them independently
// let a fit computed before a rotation survive it, which framed a sub-region of
// the graph. Funnelling all three through one debounced call means the last
// trigger wins and exactly one fit runs.
let _refitTimer = null;
function refitGraph({ orient = true, delay = 30 } = {}) {
    if (_refitTimer) window.clearTimeout(_refitTimer);
    _refitTimer = window.setTimeout(() => {
        _refitTimer = null;
        if (!cy) return;
        cy.stop();                       // drop any in-flight camera animation
        cy.resize();
        if (orient && organicMode) {
            _orientToCanvas();
            _placeFactsHalo();   // ring it around the FINAL arrangement, not the old one
        }
        const pad = organicMode ? 96 : 40;   // room for the captions the box no longer counts
        // Label footprints scale with 1/zoom, so solving collisions against the
        // outgoing zoom mis-sizes every box. Estimate the frame first, solve at that
        // zoom, then re-measure — the labels the solver moved are themselves inside
        // the bounding box the camera is fitting.
        const est = _computeFrame(pad);
        declutterLabels(est ? est.z : undefined);
        _frameGraph(pad);
        drawBackground();
        drawMinimap();
        scheduleGlow();
    }, delay);
}

function _orientToCanvas() {
    if (!cy) return;
    // Facts are not laid out by the force field — we ring them around everything
    // else afterwards. Including that ring here let a single facts node dominate the
    // covariance and drag both the rotation and the frame off the real graph.
    const ns = cy.nodes().filter(n =>
        !n.hasClass('cluster-label') && !n.hasClass('summary-node')
        && n.data('node_type') !== 'facts');
    if (ns.length < 3) return;

    let mx = 0, my = 0;
    ns.forEach(n => { const p = n.position(); mx += p.x; my += p.y; });
    mx /= ns.length; my /= ns.length;

    let sxx = 0, syy = 0, sxy = 0;
    ns.forEach(n => {
        const p = n.position(), dx = p.x - mx, dy = p.y - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    });
    if (sxx + syy < 1) return;

    // Principal axis of the position covariance matrix.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const target = (cy.height() > cy.width()) ? Math.PI / 2 : 0;
    let rot = target - theta;
    // Normalise to (-pi/2, pi/2]: the axis is undirected, so a half-turn is a no-op
    // and rotating by one would needlessly flip the whole graph upside down.
    while (rot > Math.PI / 2) rot -= Math.PI;
    while (rot <= -Math.PI / 2) rot += Math.PI;
    if (Math.abs(rot) < 0.12) return;          // close enough; don't jitter it

    const cs = Math.cos(rot), sn = Math.sin(rot);
    ns.forEach(n => {
        const p = n.position(), dx = p.x - mx, dy = p.y - my;
        n.position({ x: mx + dx * cs - dy * sn, y: my + dx * sn + dy * cs });
    });
    _widenToCanvas(ns, mx);
}

// Rotation alone only gets you so far: a 1.3:1 cloud on a 1.9:1 canvas still fits
// height-first and leaves a third of the width empty. Stretching along x closes
// that gap. This is the one non-rigid step here — it changes relative distances —
// so it is capped hard at 1.4x, which is below the point where an eye reads the
// arrangement as distorted, and it never squeezes (a cloud wider than the canvas
// is left alone rather than compressed).
const WIDEN_CAP = 1.4;
function _widenToCanvas(ns, mx) {
    if (!cy) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    ns.forEach(n => {
        const p = n.position();
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
    });
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 1 || ch < 1) return;
    const want = (cy.width() / cy.height()) / (cw / ch);
    const k = Math.min(WIDEN_CAP, want);
    if (k <= 1.02) return;
    ns.forEach(n => {
        const p = n.position();
        n.position({ x: mx + (p.x - mx) * k, y: p.y });
    });
}

function _seedOrganicPositions() {
    if (!cy) return;
    const span = _organicSpan();
    let firstSeed = _seededIds.size === 0;   // anchor the very first node at center
    cy.nodes().forEach(n => {
        if (n.hasClass('cluster-label')) return;
        if (_seededIds.has(n.id())) return;          // keep settled nodes in place
        if (firstSeed) {
            n.position({ x: 0, y: 0 });
            firstSeed = false;
        } else {
            const h = _hashStr(n.id());
            const ang = (h % 100000) / 100000 * Math.PI * 2;
            const rad = 0.18 + ((h >> 17) & 0x3ff) / 0x3ff * 0.82;
            n.position({ x: Math.cos(ang) * rad * span.rx, y: Math.sin(ang) * rad * span.ry });
        }
        _seededIds.add(n.id());
    });
}

// Center the camera on the graph origin (0,0). Used while the graph is empty /
// first nodes arrive so the live build appears in the middle of the panel
// instead of the top-left (where model 0,0 maps at the default pan).
function _centerOrigin() {
    if (!cy) return;
    cy.zoom(1);
    cy.pan({ x: cy.width() / 2, y: cy.height() / 2 });
}

// Organic-mode cosmic-effect state
let dust = [];                                  // perimeter dust ring (graph coords)
let glowCanvas = null, glowCtx = null, glowDirty = false, glowSprite = null;
const supernova = new Map();                    // nodeId → { t0, dur } SSE flashes

// Monochrome tint ramp: type colors are lerped toward this calm grey.
const GREY = { r: 0x9a, g: 0xa0, b: 0xa8 };     // #9aa0a8
function _hexToRgb(h) {
    h = (h || '#9aa0a8').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function _lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function _tintHex(baseHex, t) {
    const c = _hexToRgb(baseHex);
    return `rgb(${_lerp(c.r, GREY.r, t)},${_lerp(c.g, GREY.g, t)},${_lerp(c.b, GREY.b, t)})`;
}

// The canvas paints its own colours, so the CSS theme (theme.js + style.css) cannot
// reach it. Everything here is chrome: ground, labels, outlines, light. Node hues and
// the edge hue shown on hover stay data-driven (NODE_TYPE_COLORS / EDGE_TYPE_STYLES) in
// both themes; only how much they are greyed and how opaque they sit changes, because a
// muted dot that reads on near-black washes out to pastel on paper.
const CANVAS_THEMES = {
    dark: {
        ground: '#0a0a0c', groundAlt: '#1D2021',
        rim: '#06060a',                 // punch-out ring + label outline: the ground's colour
        lattice: '154,160,168', latticeAlpha: 0.13,
        vignette: ['rgba(10,10,12,0)', 'rgba(0,0,0,0.85)'],
        nodeTint: 0.32, edgeTint: 0.30,
        edgeRest: '#cfd3dc', edgeRestOpacity: 0.2,   // every edge at rest: a grey hairline
        label: '#d6dae2', hubLabel: '#e8eaf0', selectedLabel: '#ffffff',
        baseLabel: '#EBDBB2', baseOutline: '#1D2021', mutedLabel: '#A89984',
        baseRim: '#7C6F64', summaryFill: '#504945',
        focus: '#f8fafc', trace: '#e2e6ee', pick: '#a78bfa',
        // Additive light: overlaps sum toward white, which is what a glow is on black.
        glowBlend: 'lighter', glowScale: 1,
        glowCore: 'rgba(248,248,252,0.85)',
        glowPlain: [[0, 'rgba(248,248,252,0.85)'], [0.16, 'rgba(226,229,238,0.42)'],
                    [0.5, 'rgba(200,206,218,0.12)'], [1, 'rgba(200,206,218,0)']],
        ripple: { birth: '150,210,205', update: '250,189,47' },
        pulse: { lineage: '#f4f6fb', arrival: '#96d2cd', update: '#fabd2f' },
        dial: { groove: 'rgba(6,6,10,0.72)', track: 'rgba(226,230,238,0.30)', tick: 'rgba(232,234,240,0.55)' },
        bandBacking: 'rgba(8,8,12,0.85)',
    },
    light: {
        ground: '#f6f5f2', groundAlt: '#f1efea',   // = --bg / --surface2 in style.css
        rim: '#f6f5f2',
        lattice: '88,82,100', latticeAlpha: 0.16,
        vignette: ['rgba(246,245,242,0)', 'rgba(60,52,80,0.10)'],
        nodeTint: 0.18, edgeTint: 0.18,
        edgeRest: '#4a4458', edgeRestOpacity: 0.24,
        label: '#3b3745', hubLabel: '#26222e', selectedLabel: '#1f1d24',
        baseLabel: '#2b2733', baseOutline: '#f6f5f2', mutedLabel: '#67626f',
        baseRim: '#8c857a', summaryFill: '#e6e2da',
        focus: '#6d4fd1', trace: '#3b3745', pick: '#6d4fd1',
        // Additive white is invisible on paper and bleaches the node under it, so the
        // light theme lays a tinted halo over the ground instead, at about half strength.
        glowBlend: 'source-over', glowScale: 0.55,
        glowCore: null,
        glowPlain: [[0, 'rgba(109,79,209,0.30)'], [0.5, 'rgba(109,79,209,0.08)'],
                    [1, 'rgba(109,79,209,0)']],
        ripple: { birth: '38,140,130', update: '196,132,0' },
        pulse: { lineage: '#6d4fd1', arrival: '#268c82', update: '#c48400' },
        dial: { groove: 'rgba(255,255,255,0.9)', track: 'rgba(31,29,36,0.16)', tick: 'rgba(31,29,36,0.5)' },
        bandBacking: 'rgba(255,255,255,0.85)',
    },
};
function _themeName() {
    const t = window.AivisTheme && window.AivisTheme.get();
    return CANVAS_THEMES[t] ? t : 'light';
}
let PAL = CANVAS_THEMES[_themeName()];
// Throw-free probe: is the fcose layout registered against the global cytoscape?
function _fcoseAvailable() {
    try { return typeof window.cytoscape === 'function' && !!window.cytoscape('layout', 'fcose'); }
    catch (e) { return false; }
}

// F11 path highlighting
let pathSelectState = { firstNodeId: null };

// Every EdgeType in server/schemas/edges.py needs a row here: initEdgeLegend() iterates this
// map, so a type with a colour but no label draws on the canvas and appears nowhere in
// the legend. `converges` was missing, which left the twelve purple result-to-finding
// edges on the demo graph unexplained.
const EDGE_TYPE_LABELS = {
    motivates: 'Motivates', tests: 'Tests', implemented_by: 'Implemented By',
    produces: 'Produces', supports: 'Supports', derived_from: 'Derived From', cites: 'Cites',
    converges: 'Converges',
};
const EDGE_TYPE_STYLES = {
    motivates: { color: '#7C6F64', lineStyle: 'solid' },
    tests: { color: '#B16286', lineStyle: 'solid' },
    implemented_by: { color: '#689D6A', lineStyle: 'dashed' },
    produces: { color: '#98971A', lineStyle: 'solid' },
    supports: { color: '#076678', lineStyle: 'solid' },
    derived_from: { color: '#D79921', lineStyle: 'dashed' },
    cites: { color: '#A89984', lineStyle: 'dotted' },
    converges: { color: '#9D7CD8', lineStyle: 'solid' },
};
// Plain-language meaning of each relationship (shown in the edge detail panel + tooltip).
const EDGE_TYPE_MEANINGS = {
    motivates: 'Motivation drives this research question',
    tests: 'Hypothesis is tested against this question',
    implemented_by: 'Experiment design implements this hypothesis',
    produces: 'Run produces this result',
    supports: 'Result supports this claim',
    derived_from: 'Artifact / run is derived from its source',
    cites: 'Claim cites this source / result',
    converges: 'Result converges into this conclusion finding',
};
// How an edge came to exist (the builder's edge `policy`).
const EDGE_POLICY_LABELS = {
    manual: 'Manual (API / SDK)',
    temporal_proximity: 'Temporal-proximity heuristic',
    retroactive: 'Retroactive scan',
    cross_type: 'Cross-type inference',
    other: 'LLM-assisted inference',
    llm_assisted: 'LLM-proposed',
    convergence: 'Convergence (result → finding)',
    evolve: 'Evolve branch',
    unspecified: 'Origin not recorded',
};
function prettifyEdgeType(s) {
    return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---- Initialize ----
document.addEventListener('DOMContentLoaded', () => {
    initLegend();
    initEdgeLegend();
    initCytoscape();
    initGlow();
    initMinimap();
    initViewerExtras();   // help overlay, keyboard shortcuts, graph-health strip
    document.body.classList.toggle('organic', organicMode);
    // Pull the credibility thresholds from the server before the first paint, then
    // repaint so node colours match the scorer rather than the fallback literals.
    loadCredThresholds().then(() => {
        if (cy) applyStylesheet();
        scheduleGraphHealth();   // re-label the health chips with the server's bands
    });
    loadGraph();
    bindEvents();
    initSSE();
    loadEdgeInferenceMode();
    initFocusModes();
    initCanvasResize();
    initActivityPanel();
    initReplay();
    initFocusView();
    refreshJobs();   // a launch survives a page refresh; the strip should too

    // Keep Cytoscape in sync when container size changes.
    // Observe the flex-driven wrapper, not #cy (which is position:absolute).
    const graphArea = document.querySelector('.graph-area');
    let resizeTimer;
    new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            cy.resize();
            const liveNodes = cy.nodes().filter(n => !n.hasClass('cluster-label'));
            if (organicMode && liveNodes.length === 0) {
                _centerOrigin();   // keep an empty organic canvas centered on origin
            } else {
                cy.fit(undefined, organicMode ? 60 : 30);
            }
            drawBackground();   // resize cosmic bg backing store
            scheduleGlow();     // resize + redraw bloom overlay
        }, 150);
    }).observe(graphArea);
});

function initLegend() {
    const legend = document.getElementById('legend');
    legend.innerHTML = Object.entries(NODE_TYPE_LABELS)
        .map(([type, label]) => `
            <div class="legend-item" data-type="${type}">
                <div class="legend-swatch" style="background: ${NODE_TYPE_COLORS[type]}"></div>
                <span>${label}</span>
            </div>
        `).join('');

    // F1: Click a node-type to HIGHLIGHT all nodes of that type (dim the rest);
    // click again to clear. (Previously this hid the type.)
    legend.querySelectorAll('.legend-item[data-type]').forEach(el => {
        el.addEventListener('click', () => {
            if (el.dataset.credibility) return;
            toggleLegendHighlight('node', el.dataset.type, el);
        });
    });
}

// F2: Edge type legend
function initEdgeLegend() {
    const legend = document.getElementById('edge-legend');
    if (!legend) return;
    // In the galaxy view a dash does NOT mean "this kind of relationship" — it means
    // "nobody declared this edge, the tool inferred it", and the same dash appears on
    // the credibility dials. Drawing the legend with per-type dashes there would tell
    // the reader the canvas is saying something it is not. Hue is the type channel;
    // dash is the provenance channel; the legend has to agree with the render.
    const dashIsProvenance = organicMode;
    legend.innerHTML = Object.entries(EDGE_TYPE_LABELS)
        .map(([type, label]) => {
            const style = EDGE_TYPE_STYLES[type] || { color: '#A89984', lineStyle: 'solid' };
            const lineClass = dashIsProvenance ? ''
                : (style.lineStyle === 'dashed' ? 'line-dashed'
                   : style.lineStyle === 'dotted' ? 'line-dotted' : '');
            return `
                <div class="legend-item" data-edge-type="${type}">
                    <div class="edge-swatch ${lineClass}" style="color: ${style.color}; border-top-color: ${style.color};"></div>
                    <span>${label}</span>
                </div>
            `;
        }).join('');

    if (dashIsProvenance) {
        // Organic draws every edge grey at rest, so these colours are what an edge
        // turns when you hover it.
        legend.insertAdjacentHTML('afterbegin',
            '<div class="edge-legend-hint">Edges are grey at rest. Hover one for its colour and direction.</div>');
        const note = document.createElement('div');
        note.className = 'edge-legend-prov';
        note.innerHTML = '<div class="legend-item" data-edge-policy="declared">'
            + `<div class="edge-swatch" style="color:${PAL.label};border-top-color:${PAL.label};"></div>`
            + '<span>Solid &mdash; declared by the agent</span></div>'
            + '<div class="legend-item" data-edge-policy="inferred">'
            + `<div class="edge-swatch line-dashed" style="color:${PAL.label};border-top-color:${PAL.label};"></div>`
            + '<span>Dashed &mdash; inferred by this tool</span></div>';
        legend.appendChild(note);
        note.querySelectorAll('.legend-item[data-edge-policy]').forEach(el => {
            el.addEventListener('click', () => toggleEdgePolicyHighlight(el.dataset.edgePolicy, el));
        });
    }

    // Click an edge-type to HIGHLIGHT those edges + their endpoints (dim the rest);
    // click again to clear.
    legend.querySelectorAll('.legend-item[data-edge-type]').forEach(el => {
        el.addEventListener('click', () => {
            toggleLegendHighlight('edge', el.dataset.edgeType, el);
        });
    });
}

// Highlight all nodes/edges of a given type instead of hiding them.
let legendHighlight = null;   // `${kind}:${type}` currently active, or null

function toggleLegendHighlight(kind, type, el) {
    const key = `${kind}:${type}`;
    if (legendHighlight === key) { clearHighlight(); return; }   // toggle off
    clearHighlight();                                            // reset prior state
    legendHighlight = key;
    el.classList.add('active');
    cy.batch(() => {
        if (kind === 'node') {
            cy.nodes().forEach(n => {
                if (n.hasClass('cluster-label')) return;
                const m = n.data('node_type') === type;
                n.removeClass(m ? 'faded' : 'highlighted').addClass(m ? 'highlighted' : 'faded');
            });
            cy.edges().forEach(e => e.removeClass('highlighted').addClass('faded'));
        } else {
            const match = cy.edges().filter(e => (e.data('edge_type') || e.data('relation')) === type);
            const ends = match.connectedNodes();
            cy.edges().forEach(e => {
                const m = match.contains(e);
                e.removeClass(m ? 'faded' : 'highlighted').addClass(m ? 'highlighted' : 'faded');
            });
            cy.nodes().forEach(n => {
                if (n.hasClass('cluster-label')) return;
                const m = ends.contains(n);
                n.removeClass(m ? 'faded' : 'highlighted').addClass(m ? 'highlighted' : 'faded');
            });
        }
    });
}

// F1/F2: Apply visibility filters
function applyVisibilityFilters() {
    cy.batch(() => {
        cy.nodes().forEach(n => {
            if (n.hasClass('cluster-label')) return;
            const type = n.data('node_type');
            if (hiddenNodeTypes.has(type)) {
                n.style('display', 'none');
            } else {
                n.style('display', 'element');
            }
        });
        cy.edges().forEach(e => {
            const edgeType = e.data('edge_type') || e.data('relation');
            const srcType = cy.getElementById(e.data('source')).data('node_type');
            const tgtType = cy.getElementById(e.data('target')).data('node_type');
            if (hiddenEdgeTypes.has(edgeType) || hiddenNodeTypes.has(srcType) || hiddenNodeTypes.has(tgtType)) {
                e.style('display', 'none');
            } else {
                e.style('display', 'element');
            }
        });
    });
    drawMinimap();
}

function highlightLegend(nodeData) {
    document.querySelectorAll('.legend-item').forEach(el => {
        // Highlight matching node type
        if (el.dataset.type === nodeData.node_type) {
            el.classList.add('active');
        // Highlight matching credibility level for claim nodes
        } else if (el.dataset.credibility && nodeData.node_type === 'claim') {
            const score = nodeData.credibility_score;
            const rating = _credRating(score);
            if (el.dataset.credibility === rating) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        } else {
            el.classList.remove('active');
        }
    });
}

function clearLegendHighlight() {
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('active'));
}

// Default (Gruvbox hierarchy) stylesheet — used in dagre & timeline modes. Built per
// call so its chrome colours follow the theme (PAL).
// A node whose node_type we don't recognise is drawn dashed rather than dropped, so
// an agent typo is visible instead of silently missing. Appended to both sheets.
const UNKNOWN_TYPE_STYLE = {
    selector: 'node[?unknown_type]',
    style: {
        'border-style': 'dashed',
        'border-color': '#D79921',
        'border-width': 3,
    },
};

function baseStyle() { return [
    {
        selector: 'node',
        style: {
            'label': 'data(label)',
            'background-color': 'data(color)',
            'shape': 'ellipse',
            'color': PAL.baseLabel,
            'font-size': '10px',
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'text-wrap': 'ellipsis',
            'text-max-width': '100px',
            'width': 40,
            'height': 40,
            'border-width': 2,
            'border-color': PAL.baseRim,
            'border-opacity': 1,
            'text-outline-color': PAL.baseOutline,
            'text-outline-width': 2,
        },
    },
    {
        selector: 'node.highlighted',
        style: {
            'border-width': 4,
            'border-color': PAL.focus,
            'border-opacity': 1,
            'z-index': 10,
            'font-weight': 'bold',
        },
    },
    { selector: 'node.faded', style: { 'opacity': 0.15 } },
    {
        selector: 'node.cluster-label',
        style: {
            'background-opacity': 0,
            'border-width': 0,
            'width': 20,
            'height': 20,
            'font-size': '11px',
            'font-weight': 'bold',
            'color': PAL.mutedLabel,
            'text-valign': 'top',
            'text-margin-y': -8,
            'events': 'yes',
        },
    },
    {
        selector: 'node.selected-node',
        style: {
            'border-width': 5, 'border-color': '#FABD2F', 'border-opacity': 1,
            'overlay-color': '#FABD2F', 'overlay-opacity': 0.22, 'overlay-padding': 8,
            'z-index': 30,
        },
    },
    {
        selector: 'edge',
        style: {
            'width': 2,
            'line-color': 'data(color)',
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
            'line-style': 'data(line_style)',
            'opacity': 0.6,  // F9: Edge decluttering
            'label': '',
            'font-size': '8px',
            'color': PAL.mutedLabel,
            'text-outline-color': PAL.baseOutline,
            'text-outline-width': 1.5,
        },
    },
    {
        selector: 'node.summary-node',
        style: {
            'shape': 'round-rectangle',
            'background-color': PAL.summaryFill,
            'width': 60,
            'height': 30,
            'font-size': '9px',
            'text-valign': 'center',
            'text-margin-y': 0,
            'border-width': 1,
            'border-color': PAL.baseRim,
        },
    },
    { selector: 'edge.highlighted', style: { 'width': 3, 'z-index': 10, 'opacity': 1 } },
    { selector: 'edge.faded', style: { 'opacity': 0.08 } },
    {
        selector: 'edge.selected-edge',
        style: {
            'width': 4, 'line-color': PAL.pick, 'target-arrow-color': PAL.pick,
            'opacity': 1, 'z-index': 12,
        },
    },
]; }

// Organic (Obsidian "second brain") stylesheet — a complete, standalone sheet
// swapped in via applyStylesheet() in organic mode. Cytoscape selectors can't be
// scoped by a DOM class (e.g. `body.organic node` is invalid), so we swap the
// whole stylesheet instead. Node size/brightness/tint come from data keys written
// by applyDegreeScaling(); chrome colours come from the theme (PAL).
function organicStyle() { return [
    {
        // Scoped to [_sz] so the data-mappers only touch nodes seeded by
        // applyDegreeScaling() — cluster-label/summary nodes (no _sz) are styled
        // by their own rules below and don't trigger "no mapping" warnings.
        selector: 'node[_sz]',
        style: {
            'background-color': 'data(_tint)',
            'background-opacity': 'data(_bri)',   // 0.62 leaf … 1.0 hub
            'shape': 'ellipse',
            // A ring in the background colour, so a dot overlapping another dot is
            // punched out of it rather than merging into a blob. Same hex as the
            // label outline, so type and text cut the same hole. Scaled with the
            // node: a 2.5px ring would eat a 5px leaf entirely.
            'border-width': 'data(_rim)',
            'border-color': PAL.rim,
            'border-opacity': 1,
            'transition-property': 'background-opacity, border-width, border-color, width, height, opacity',
            'transition-duration': '140ms',
            'transition-timing-function': 'ease-out',
            'width': 'data(_sz)',
            'height': 'data(_sz)',
            'label': '',                          // hidden by default
            'text-opacity': 0,
            'color': PAL.label,
            'font-size': '9px',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            'text-outline-color': PAL.rim,
            'text-outline-width': 2,
            'min-zoomed-font-size': 9,
        },
    },
    {
        // Structural hubs (mostly files) label only once you zoom IN. At a glance a
        // dense graph showed dozens of overlapping filenames; tiering by zoom keeps the
        // overview legible and still gives you every name when you go looking.
        selector: 'node.hubcore',
        style: {
            'label': 'data(label)',
            'text-opacity': 0.85,
            'color': PAL.hubLabel,
            'min-zoomed-font-size': 13,
            'text-wrap': 'ellipsis',
            'text-max-width': '120px',
        },
    },
    {
        // Claims and conclusions are the point of the graph, so they stay readable at
        // every zoom level and carry a ring — in credibility mode that ring is the
        // score colour, otherwise the node's own type colour.
        selector: 'node.verdict-node',
        style: {
            'border-width': 2,
            'border-color': 'data(_tint)',
            'border-opacity': 0.9,
            'text-opacity': 0.95,
            'font-size': '10px',
            'min-zoomed-font-size': 4,
            'text-wrap': 'ellipsis',
            'text-max-width': '190px',
            'z-index': 12,
        },
    },
    {
        // Facts = the outside-knowledge halo: small faded-aqua circle dots, ringed
        // around everything else — the real-node replacement for the dust ring.
        selector: 'node[node_type="facts"]',
        style: {
            'background-color': '#83A598',
            'background-opacity': 0.5,
            'width': 6, 'height': 6,
            'shape': 'ellipse',           // ellipse w==h = circle
            'label': '', 'text-opacity': 0,
        },
    },
    {
        selector: 'edge',
        style: {
            // At rest an edge is a grey hairline. Colour belongs to the nodes, and
            // the type hues nearly repeat theirs anyway: painted on every line, with
            // a fade for direction and three cues for provenance, the mesh upstaged
            // the evidence it connects. The relationship's colour and its direction
            // come up on hover (edge.edge-hover, below); the dash stays at rest.
            'width': 1,
            'opacity': PAL.edgeRestOpacity,
            'line-color': PAL.edgeRest,
            'curve-style': 'straight',
            'line-cap': 'round',
            'target-arrow-shape': 'none',
            'source-arrow-shape': 'none',
            // A 1px line is a target nobody can hit. Overlay padding widens the pick
            // region to ~13px without drawing anything.
            'overlay-padding': 6,
            'overlay-opacity': 0,
            'overlay-color': PAL.trace,
            'transition-property': 'opacity, width',
            'transition-duration': '140ms',
            'transition-timing-function': 'ease-out',
            'events': 'yes',   // clickable so edge-detail works in the default galaxy view too
        },
    },
    {
        // Inferred edges are drawn as a broken line. This is the product's central
        // honesty: 178 of 178 edges on the demo graph were guessed by a heuristic,
        // and a reader should be able to see that without opening a panel.
        // `!_edeclared` rather than `?_einferred`: an edge applyEdgeChannels() has not
        // reached yet reads as a guess, never as an assertion.
        selector: 'edge[!_edeclared]',
        style: {
            'line-style': 'dashed',
            'line-dash-pattern': [4, 4],
        },
    },
    {
        // Direction and identity resolve on demand rather than cluttering the mesh.
        selector: 'edge.edge-hover',
        style: {
            'width': 2.4,
            'opacity': 0.95,
            'line-color': 'data(_etint)',
            'line-style': 'solid',
            'target-arrow-shape': 'triangle-backcurve',
            'target-arrow-color': 'data(_etint)',
            'arrow-scale': 0.6,
            'overlay-opacity': 0.1,
            'z-index': 8,
        },
    },
    {
        // Lineage nodes brighten on click but stay UNLABELED. Only the clicked
        // node (node.selected-node, below) reveals its title — so clicking a
        // high-degree node no longer floods the galaxy with hundreds of labels.
        // 'label': '' here also overrides the node.hubcore default-label rule.
        selector: 'node.highlighted',
        style: {
            'background-opacity': 1,
            'border-width': 2,
            'border-color': PAL.focus,
            'border-opacity': 1,
            'label': '',
            'text-opacity': 0,
            'z-index': 10,
        },
    },
    {
        // The single clicked node — the only title shown while a selection is active.
        selector: 'node.selected-node',
        style: {
            // Selection is a rim change, not a size change. The old 8px overlay
            // inflated the node by ~22px and drew it as a rounded square in the
            // middle of a field of circles, so the graph looked like it had jumped.
            // The energy that lost goes onto the glow layer, where it costs no
            // geometry (see the amber halo in drawGlow).
            'border-width': 3.5, 'border-color': '#FABD2F', 'border-opacity': 1,
            'overlay-color': '#FABD2F', 'overlay-opacity': 0.16, 'overlay-padding': 2,
            'label': 'data(label)', 'text-opacity': 1, 'color': PAL.selectedLabel,
            'font-size': '12px', 'font-weight': 'bold',
            'min-zoomed-font-size': 0, 'z-index': 31,
        },
    },
    { selector: 'node.faded', style: { 'opacity': 0.06 } },
    {
        selector: 'edge.highlighted',
        style: { 'line-color': PAL.trace, 'opacity': 0.85, 'width': 1.8, 'z-index': 9 },
    },
    { selector: 'edge.faded', style: { 'opacity': 0.02 } },
    {
        selector: 'edge.selected-edge',
        style: { 'line-color': PAL.pick, 'opacity': 1, 'width': 2.4, 'z-index': 12 },
    },
    {
        selector: 'node.cluster-label',
        style: {
            'label': 'data(label)', 'text-opacity': 1, 'background-opacity': 0,
            'border-width': 0, 'color': PAL.mutedLabel, 'font-size': '11px',
            'text-valign': 'top', 'text-margin-y': -8, 'events': 'yes',
        },
    },
    {
        selector: 'node.summary-node',
        style: {
            'background-color': PAL.summaryFill, 'background-opacity': 1, 'shape': 'round-rectangle',
            'border-width': 1, 'border-color': PAL.baseRim, 'label': 'data(label)',
            'text-opacity': 1, 'width': 60, 'height': 30, 'color': PAL.baseLabel,
            'text-valign': 'center', 'text-margin-y': 0, 'font-size': '9px',
        },
    },
]; }

function initCytoscape() {
    cy = cytoscape({
        container: document.getElementById('cy'),
        style: (organicMode ? organicStyle() : baseStyle()).concat(replayStyle()),
        layout: { name: 'preset' },
        minZoom: 0.2,
        maxZoom: 3,
    });
}

// Swap the whole stylesheet when the layout mode changes.
function applyStylesheet() {
    if (!cy) return;
    const sheet = (organicMode ? organicStyle() : baseStyle())
        .concat([UNKNOWN_TYPE_STYLE], replayStyle());
    cy.style().fromJson(sheet).update();
}

// theme.js fires this when the user switches theme. The page's CSS follows
// <html data-theme> by itself; the canvas has to re-read its palette and repaint
// everything it drew with the old one.
window.addEventListener('aivis-theme-change', () => {
    PAL = CANVAS_THEMES[_themeName()];
    _glowSprites.clear();
    if (glowCtx) _buildGlowSprite();
    if (!cy) return;
    applyDegreeScaling();          // node and edge tints are mixed for the ground
    applyStylesheet();
    applyNodeShapeMode();          // dagre/timeline borders are inline styles
    cy.nodes('.cluster-label').style('color', PAL.mutedLabel);
    initEdgeLegend();              // the provenance swatches are drawn in the label colour
    drawSwimlanes();
    drawMinimap();
    scheduleGlow();
    _fvRender();                   // the focus view draws in its own palette
});

async function loadGraph() {
    // A reload replaces the elements the player is revealing; leave replay first.
    if (_replay.active) { _replay.missedLive = false; stopReplay(); }
    _graphPhase('loading');   // no-op if a populated graph is already on screen
    try {
        const resp = await fetch(`${API_BASE}/graph`);
        if (!resp.ok) throw new Error(`server returned ${resp.status} ${resp.statusText}`);
        const data = await resp.json();
        setGraphError(null);
        cy.json({ elements: data.elements });
        _fvRender();
        const _hasNodes = (data.elements || []).some(el => el.group === 'nodes');
        setGraphEmpty(!_hasNodes);
        // Fetch is done; the force layout still has to settle. Say which is happening.
        _graphPhase(_hasNodes ? 'arranging' : null);
        runLayout();
        updateStats(data.stats);
        if (!_activitySeeded) { _seedActivityFromGraph(); _activitySeeded = true; }
        if (data.stats) {
            logActivity('system', `loaded <b>${data.stats.total_nodes}</b> nodes, `
                + `<b>${data.stats.total_edges}</b> edges`, '#458588');
        }
        // Empty graph (e.g. live demo opened before streaming): center the view on
        // the origin so incoming nodes build in the middle, not the top-left corner.
        if (organicMode && cy.nodes().filter(n => !n.hasClass('cluster-label')).length === 0) {
            _centerOrigin();
        }
    } catch (err) {
        console.error('Failed to load graph:', err);
        // "Nothing here yet" and "I cannot reach the server" used to look identical:
        // an empty canvas and a console line nobody has open. Say which it is.
        _graphPhase(null);
        setGraphEmpty(false);
        setGraphError(err && err.message ? err.message : String(err));
    }
}

// Distinguishing empty-but-healthy from unreachable is the whole point of these two.
function setGraphEmpty(isEmpty) {
    const el = document.getElementById('graph-empty');
    if (el) el.hidden = !isEmpty;
}

function setGraphError(message) {
    const box = document.getElementById('graph-error');
    if (!box) return;
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = `Could not load the graph — ${message}.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graph-error-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { setGraphError(null); loadGraph(); });
    box.append(msg, btn);
}

// Guard against a second click while a request is in flight. These handlers already
// print textual progress; what was missing was the lock.
async function withBusy(btn, fn) {
    const el = typeof btn === 'string' ? document.getElementById(btn) : btn;
    if (el) {
        if (el.disabled) return;      // already running
        el.disabled = true;
    }
    try {
        return await fn();
    } finally {
        if (el) el.disabled = false;
    }
}

const ARTIFACT_TYPE_LABELS = {
    code: 'Code',
    data: 'Doc',
    config: 'Config',
    model: 'Model',
};

function _hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

// Place `facts` nodes as a circle-dot halo encircling all the OTHER nodes — the
// real-node replacement for the old decorative dust ring. Deterministic per id.
function _placeFactsHalo() {
    if (!cy || !organicMode) return;
    const facts = cy.nodes().filter(n => n.data('node_type') === 'facts');
    if (facts.empty()) return;
    const others = cy.nodes().filter(n =>
        !n.hasClass('cluster-label') && n.data('node_type') !== 'facts');
    if (others.empty()) return;
    const bb = others.boundingBox();
    const cx = (bb.x1 + bb.x2) / 2, cyc = (bb.y1 + bb.y2) / 2;
    // An ellipse matched to the arrangement, not a circle on its longest side: a
    // circle around a 3:1 graph pushes the ring miles above and below it, and the
    // camera then frames all that empty space.
    const rx = (bb.w * 0.62) || 200;
    const ry = (bb.h * 0.62) || 200;
    const N = facts.length;
    facts.sort((a, b) => a.id() < b.id() ? -1 : 1).forEach((n, i) => {
        const h = _hashStr(n.id());
        const ang = (i / N) * Math.PI * 2 + (((h % 100) / 100) - 0.5) * (Math.PI / Math.max(N, 1));
        const j = 0.96 + ((h >> 7) % 100) / 100 * 0.13;
        n.position({ x: cx + Math.cos(ang) * rx * j, y: cyc + Math.sin(ang) * ry * j });
    });
    // fade the cite-edges to the halo so it reads as ambient decoration
    facts.connectedEdges().style({ 'opacity': 0.1, 'width': 0.6 });
}

function runLayout(incremental = false) {
    // Separate isolated artifacts (degree 0) from the rest
    const isolatedArtifacts = cy.nodes().filter(n =>
        n.degree() === 0 && n.data('node_type') === 'artifact'
    );

    // ---- Organic mode: feed EVERYTHING into one force layout so isolated
    // artifacts pack into the perimeter halo instead of a side grid. ----
    if (organicMode) {
        cy.nodes('.cluster-label').remove();   // grids are meaningless here
        drawSwimlanes();                       // clears any stale dagre/timeline bands
        // Full layout (load / mode switch / refresh): re-seed everything from the
        // deterministic base so the arrangement is identical each time. Incremental
        // (a new node arrived): keep settled nodes, only place the newcomers.
        if (!incremental) _seededIds.clear();
        applyDegreeScaling();                  // seed _sz/_bri/_tint before first paint
        _seedOrganicPositions();
        const base = _fcoseAvailable()
            ? ORGANIC_LAYOUT_OPTS
            : { ...ORGANIC_LAYOUT_OPTS, name: 'cose' };   // built-in fallback
        const _span = _organicSpan();
        const opts = {
            ...base,
            animationDuration: incremental ? 650 : 900,
            boundingBox: {
                x1: -_span.rx * 1.5, y1: -_span.ry * 1.5,
                w: _span.rx * 3, h: _span.ry * 3,
            },
        };
        cy.elements().layout({
            ...opts,
            stop: () => {
                applyDegreeScaling();
                // Orient before the halo, so the facts ring is drawn around the
                // final arrangement rather than around a shape about to rotate.
                _placeFactsHalo();        // ring the facts around everything else
                if (!incremental) {
                    // Only on a full layout do we re-orient and re-fit the camera —
                    // during live growth the view stays put so it doesn't jump
                    // around the user.
                    refitGraph({ delay: 30 });
                } else {
                    drawBackground();
                    drawMinimap();
                }
                scheduleGlow();
            },
        }).run();
        return;
    }

    const connected = cy.elements().difference(isolatedArtifacts);

    // Run layout on connected elements
    if (connected.nonempty()) {
        if (timelineMode) {
            runTimelineLayout(connected);
        } else {
            connected.layout({
                name: 'dagre',
                rankDir: 'LR',
                nodeSep: 46,
                rankSep: 150,   // wider columns → aspect closer to the panel → fit zooms larger
                padding: 20,
                animate: false,
                stop: function() {
                    applyDegreeScaling();   // F4 (size nodes before measuring fit)
                    // NOT cy.animate({fit, center}) — cytoscape derives pan from
                    // `center` after deriving zoom AND pan from `fit`, so the centre
                    // silently won and the zoom never changed. On an 83-node graph
                    // dagre lays out a 5206-unit-tall column and the camera stayed at
                    // the organic zoom, showing about a sixth of it. Route through the
                    // same analytic framing every other mode uses; the debounce also
                    // lets the isolated-artifact clusters below be placed first, which
                    // the old inline fit measured before they existed.
                    drawSwimlanes();        // F6
                    refitGraph({ delay: 60 });
                },
            }).run();
        }
    }

    // Cluster isolated artifacts by artifact_type below the main graph
    if (isolatedArtifacts.nonempty()) {
        _layoutArtifactClusters(isolatedArtifacts, connected);
    }
}

function _layoutArtifactClusters(isolatedArtifacts, connected) {
    // Find the bottom of the main graph.
    //
    // The cluster LABEL this function creates is itself a node, and it is not an
    // isolated artifact — so it lands in `connected` and got measured here on the
    // next run. Each layout therefore pushed the label 120 units further down than
    // the last one, and organic mode re-runs the layout on every node that arrives
    // over SSE. After a few dozen events the label had marched to y=4817 on a graph
    // whose real nodes span 683, and because fit() frames the whole bounding box,
    // one invisible decorative label shrank the entire graph to a seventh of its
    // size. Measure the real graph only.
    let maxY = -Infinity;
    connected.nodes().forEach(n => {
        if (n.hasClass('cluster-label')) return;
        const y = n.position('y');
        if (y > maxY) maxY = y;
    });
    if (!isFinite(maxY)) maxY = 0;
    const clusterStartY = maxY + 120;

    // Group by artifact_type
    const groups = {};
    isolatedArtifacts.forEach(n => {
        const atype = n.data('artifact_type') || 'other';
        if (!groups[atype]) groups[atype] = [];
        groups[atype].push(n);
    });

    // Remove old cluster labels
    cy.nodes('.cluster-label').remove();

    const colSpacing = 60;
    const rowSpacing = 60;
    const groupGap = 50;
    const subGroupGap = 30;
    const colsPerRow = 4;
    let xOffset = 30;

    const typeOrder = ['code', 'data', 'config', 'model', 'other'];
    const sortedTypes = typeOrder.filter(t => groups[t]);

    sortedTypes.forEach(atype => {
        const nodes = groups[atype];
        const label = ARTIFACT_TYPE_LABELS[atype] || atype;

        if (atype === 'code') {
            // Sub-cluster code artifacts by directory
            xOffset = _layoutCodeSubClusters(nodes, xOffset, clusterStartY, label,
                colSpacing, rowSpacing, colsPerRow, subGroupGap);
        } else {
            // Flat grid for other types
            xOffset = _layoutFlatCluster(nodes, xOffset, clusterStartY, label,
                colSpacing, rowSpacing, colsPerRow);
        }
        xOffset += groupGap;
    });
}

function _getRelativeDir(path) {
    // Normalize to forward slashes and extract directory portion
    const normalized = (path || '').replace(/\\/g, '/');
    const parts = normalized.split('/');
    parts.pop(); // remove filename
    return parts.filter(p => p).join('/') || './';
}

function _findCommonPrefix(dirs) {
    if (dirs.length === 0) return '';
    if (dirs.length === 1) return dirs[0];
    const sorted = [...dirs].sort();
    const first = sorted[0].split('/');
    const last = sorted[sorted.length - 1].split('/');
    let i = 0;
    while (i < first.length && i < last.length && first[i] === last[i]) i++;
    return first.slice(0, i).join('/');
}

function _layoutCodeSubClusters(nodes, xOffset, clusterStartY, typeLabel,
    colSpacing, rowSpacing, colsPerRow, subGroupGap) {
    // Group code nodes by directory
    const dirGroups = {};
    nodes.forEach(n => {
        const dir = _getRelativeDir(n.data('path'));
        if (!dirGroups[dir]) dirGroups[dir] = [];
        dirGroups[dir].push(n);
    });

    // Find common prefix to shorten directory labels
    const allDirs = Object.keys(dirGroups);
    const prefix = _findCommonPrefix(allDirs);
    const prefixLen = prefix ? prefix.length + 1 : 0; // +1 for trailing /

    // Sort directories alphabetically
    const sortedDirs = allDirs.sort();

    // Add type label
    const typeLabelId = '_cluster_code';
    _addClusterLabel(typeLabelId, typeLabel, xOffset, clusterStartY, '11px');

    let curY = clusterStartY + 35;

    sortedDirs.forEach(dir => {
        const dirNodes = dirGroups[dir];
        const shortDir = dir.slice(prefixLen) || './';

        // Add directory sub-label
        const subLabelId = `_cluster_code_${shortDir.replace(/[^a-zA-Z0-9]/g, '_')}`;
        _addClusterLabel(subLabelId, shortDir, xOffset + 5, curY, '9px');

        // Position nodes in grid below the sub-label
        const gridStartY = curY + 28;
        let maxCol = 0;
        dirNodes.forEach((n, i) => {
            const col = i % colsPerRow;
            const row = Math.floor(i / colsPerRow);
            if (col > maxCol) maxCol = col;
            n.animate({
                position: {
                    x: xOffset + col * colSpacing,
                    y: gridStartY + row * rowSpacing,
                },
            }, { duration: 400 });
        });

        const rows = Math.ceil(dirNodes.length / colsPerRow);
        curY = gridStartY + rows * rowSpacing + subGroupGap;
    });

    const maxCols = Math.max(...sortedDirs.map(d => Math.min(dirGroups[d].length, colsPerRow)));
    return xOffset + maxCols * colSpacing;
}

function _layoutFlatCluster(nodes, xOffset, clusterStartY, label,
    colSpacing, rowSpacing, colsPerRow) {
    const labelId = `_cluster_${label.toLowerCase()}`;
    _addClusterLabel(labelId, label, xOffset, clusterStartY, '11px');

    const gridStartY = clusterStartY + 40;
    nodes.forEach((n, i) => {
        const col = i % colsPerRow;
        const row = Math.floor(i / colsPerRow);
        n.animate({
            position: {
                x: xOffset + col * colSpacing,
                y: gridStartY + row * rowSpacing,
            },
        }, { duration: 400 });
    });

    const cols = Math.min(nodes.length, colsPerRow);
    return xOffset + cols * colSpacing;
}

function _addClusterLabel(id, label, x, y, fontSize) {
    const arrow = collapsedClusters.has(id) ? '▶ ' : '▼ ';
    // Avoid duplicates
    if (cy.getElementById(id).length > 0) {
        cy.getElementById(id).data('label', arrow + label);
        cy.getElementById(id).data('_clusterLabel', label);
        cy.getElementById(id).position({ x, y });
        return;
    }
    cy.add({
        group: 'nodes',
        data: {
            id: id,
            label: arrow + label,
            _clusterLabel: label,
            node_type: '_cluster_label',
            shape: 'round-rectangle',
            color: '#504945',
        },
        classes: 'cluster-label',
    });
    const node = cy.getElementById(id);
    node.style({
        'width': 20,
        'height': 20,
        'font-size': fontSize,
        'font-weight': 'bold',
        'color': PAL.mutedLabel,
        'text-valign': 'top',
        'text-margin-y': -8,
        'background-opacity': 0,
        'border-width': 0,
        'events': 'yes',
    });
    node.position({ x, y });
}

function updateStats(stats) {
    const el = document.getElementById('footer-stats');
    if (!stats) return;
    const counts = stats.node_counts || {};
    el.innerHTML = `
        <span>Nodes: ${stats.total_nodes}</span>
        <span>Edges: ${stats.total_edges}</span>
        ${Object.entries(counts).map(([t, c]) =>
            // `t` is an agent-supplied node_type for any type we don't know — escape it.
            `<span>${_esc(NODE_TYPE_LABELS[t] || t)}: ${_esc(c)}</span>`
        ).join('')}
    `;
    scheduleGraphHealth();   // keep the graph-health strip in step with the footer
}

// Recompute footer counts straight from the live graph (used during SSE growth,
// so the counter climbs in real time instead of only refreshing on full load).
function updateStatsFromGraph() {
    if (!cy) return;
    const counts = {};
    let nodes = 0;
    cy.nodes().forEach(n => {
        if (n.hasClass('cluster-label') || n.hasClass('summary-node')) return;
        const t = n.data('node_type');
        if (!t || t === '_cluster_label' || t === '_summary') return;
        counts[t] = (counts[t] || 0) + 1;
        nodes++;
    });
    updateStats({ total_nodes: nodes, total_edges: cy.edges().length, node_counts: counts });
}

// ---- Events ----
function bindEvents() {
    // Node click -> detail panel + lineage highlight
    cy.on('tap', 'node', async (evt) => {
        const node = evt.target;
        if (node.hasClass('cluster-label')) return;

        // F11: Shift+click for path highlighting
        if (evt.originalEvent && evt.originalEvent.shiftKey) {
            handlePathClick(node.data('id'));
            return;
        }

        showDetail(node.data());
        highlightLegend(node.data());
        await highlightLineage(node.data('id'));
    });

    // Edge click -> detail panel + highlight the relationship & its two endpoints
    cy.on('tap', 'edge', (evt) => {
        const edge = evt.target;
        showEdgeDetail(edge);
        highlightEdgeLegend(edge.data());
        highlightEdge(edge);
    });

    // Click background -> clear
    cy.on('tap', (evt) => {
        if (evt.target === cy) {
            clearHighlight();
            clearDetail();
            clearLegendHighlight();
        }
    });

    // F3: Hover tooltips
    const tooltip = document.getElementById('graph-tooltip');
    let tooltipTimer = null;
    cy.on('mouseover', 'node', (evt) => {
        const node = evt.target;
        if (node.hasClass('cluster-label') || node.hasClass('summary-node')) return;
        clearTimeout(tooltipTimer);
        const d = node.data();
        let html = `<div class="tt-label">${_esc(d.label || d.id)}</div>`;
        html += `<div class="tt-type">${_esc(NODE_TYPE_LABELS[d.node_type] || d.node_type)}</div>`;
        if (d.description) {
            const desc = d.description.length > 120 ? d.description.slice(0, 117) + '...' : d.description;
            html += `<div class="tt-desc">${_esc(desc)}</div>`;
        }
        if (d.path) html += `<div class="tt-desc">${_esc(d.path)}</div>`;
        if (d.artifact_type) html += `<div class="tt-desc">Artifact: ${_esc(d.artifact_type)}</div>`;
        if (d.methodology) html += `<div class="tt-desc">${_esc(d.methodology.length > 80 ? d.methodology.slice(0, 77) + '...' : d.methodology)}</div>`;
        if (d.status) html += `<div class="tt-desc">Status: ${_esc(d.status)}</div>`;
        if (d.duration_seconds != null) html += `<div class="tt-desc">Duration: ${d.duration_seconds >= 60 ? (d.duration_seconds / 60).toFixed(1) + ' min' : d.duration_seconds.toFixed(1) + 's'}</div>`;
        if (d.metrics && Object.keys(d.metrics).length) {
            const preview = Object.entries(d.metrics).slice(0, 3).map(([k, v]) => `${_esc(k)}: ${_esc(typeof v === 'number' ? v.toFixed(2) : v)}`).join(', ');
            html += `<div class="tt-desc">${preview}${Object.keys(d.metrics).length > 3 ? ' ...' : ''}</div>`;
        }
        if (d.credibility_score != null) {
            html += `<div class="tt-score">Credibility: ${(d.credibility_score * 100).toFixed(0)}%</div>`;
        }
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        const cyRect = document.getElementById('cy').getBoundingClientRect();
        const rp = evt.renderedPosition;
        let left = cyRect.left + rp.x + 15;
        let top = cyRect.top + rp.y - 10;
        // Keep on-screen
        if (left + 260 > window.innerWidth) left = window.innerWidth - 260;
        if (top + 120 > window.innerHeight) top = window.innerHeight - 120;
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
    });
    cy.on('mouseout', 'node', () => {
        tooltipTimer = setTimeout(() => { tooltip.style.display = 'none'; }, 100);
    });

    // Edge hover tooltip — relationship + the two nodes it connects
    cy.on('mouseover', 'edge', (evt) => {
        const d = evt.target.data();
        clearTimeout(tooltipTimer);
        // Light the edge itself, not just the tooltip: at 1px and 0.34 opacity you
        // otherwise cannot tell which of the lines under the cursor you are reading.
        cy.edges('.edge-hover').removeClass('edge-hover');
        evt.target.addClass('edge-hover');
        scheduleGlow();
        const et = d.edge_type || 'edge';
        const etLabel = EDGE_TYPE_LABELS[et] || prettifyEdgeType(et);
        const srcN = cy.getElementById(d.source);
        const tgtN = cy.getElementById(d.target);
        const srcL = srcN.nonempty() ? (srcN.data('label') || d.source) : d.source;
        const tgtL = tgtN.nonempty() ? (tgtN.data('label') || d.target) : d.target;
        let html = `<div class="tt-label">${_esc(etLabel)}</div>`;
        html += `<div class="tt-type">Relationship</div>`;
        html += `<div class="tt-desc">${_esc(srcL)} &rarr; ${_esc(tgtL)}</div>`;
        if (EDGE_TYPE_MEANINGS[et]) html += `<div class="tt-desc">${_esc(EDGE_TYPE_MEANINGS[et])}</div>`;
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        const cyRect = document.getElementById('cy').getBoundingClientRect();
        const rp = evt.renderedPosition;
        let left = cyRect.left + rp.x + 15;
        let top = cyRect.top + rp.y - 10;
        if (left + 260 > window.innerWidth) left = window.innerWidth - 260;
        if (top + 120 > window.innerHeight) top = window.innerHeight - 120;
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
    });
    cy.on('mouseout', 'edge', () => {
        cy.edges('.edge-hover').removeClass('edge-hover');
        scheduleGlow();
        tooltipTimer = setTimeout(() => { tooltip.style.display = 'none'; }, 100);
    });

    cy.on('tap pan zoom', () => { tooltip.style.display = 'none'; });

    // F7: Double-click to collapse/expand branches
    cy.on('dbltap', 'node', (evt) => {
        const node = evt.target;
        if (node.hasClass('cluster-label')) return;
        if (node.hasClass('summary-node')) {
            expandBranch(node.data('id'));
        } else {
            collapseBranch(node.data('id'));
        }
    });

    // F8: Click cluster labels to toggle
    cy.on('tap', 'node.cluster-label', (evt) => {
        const node = evt.target;
        const clusterId = node.data('id');
        toggleClusterCollapse(clusterId, node);
    });

    // F6: Redraw overlays on pan/zoom/render.
    // Organic mode drives the cosmic bg + bloom (via a rAF dirty flag);
    // dagre/timeline drive the swimlane bands.
    cy.on('pan zoom render', () => {
        if (organicMode) {
            // Paint the overlay NOW, in the same turn as the frame underneath it —
            // not on the next animation frame. Everything on this layer is positioned
            // from renderedPosition(), so deferring it by one frame draws the bloom,
            // the dials and the pulse where the nodes WERE. During a pan that reads as
            // a shimmer; after a camera jump the dial visibly detaches from its node
            // and sits beside it. Cheap enough to be synchronous: a few dozen cached
            // sprite blits and a couple of arcs per verdict.
            drawGlow();
            // The background is screen-fixed apart from the lattice, so it can stay on
            // the dirty flag and out of the per-frame path.
            scheduleGlow();
        } else {
            drawSwimlanes();
        }
        drawMinimap();
    });

    // Search
    document.getElementById('search-btn').addEventListener('click', doSearch);
    document.getElementById('search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    // Fit
    document.getElementById('btn-fit').addEventListener('click', () => {
        if (_fv.on) { _fvFit(); return; }
        cy.resize();
        cy.fit(undefined, 30);
    });

    // Credibility toggle
    document.getElementById('btn-credibility').addEventListener('click', toggleCredibility);
    // Hover help tooltip that follows the cursor (reuses the graph tooltip box).
    const credBtn = document.getElementById('btn-credibility');
    const credTip = document.getElementById('graph-tooltip');
    if (credBtn && credTip) {
        // Built from CRED_THRESHOLDS so the help text cannot drift from the scorer.
        const credHelp = () => 'Credibility view — colours <b>claim</b> ⭐ and <b>conclusion</b> findings by score: '
            + `<span style="color:${CRED_COLORS.green}">green ≥${CRED_THRESHOLDS.green.toFixed(2)}</span>, `
            + `<span style="color:${CRED_COLORS.yellow}">yellow ≥${CRED_THRESHOLDS.yellow.toFixed(2)}</span>, `
            + `<span style="color:${CRED_COLORS.red}">red &lt;${CRED_THRESHOLDS.yellow.toFixed(2)}</span>. `
            + 'A conclusion\'s score is the average credibility '
            + 'of the claims its results support. Click to toggle — the ratings pop out of the galaxy.';
        credBtn.addEventListener('mouseenter', () => { credTip.innerHTML = credHelp(); credTip.style.display = 'block'; });
        credBtn.addEventListener('mousemove', (e) => {
            credTip.style.left = (e.clientX + 14) + 'px';
            credTip.style.top = (e.clientY + 16) + 'px';
        });
        credBtn.addEventListener('mouseleave', () => { credTip.style.display = 'none'; });
    }

    // Settings dropdown
    document.getElementById('btn-settings').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('settings-dropdown').classList.toggle('open');
    });
    document.querySelectorAll('input[name="node-shape"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            nodeShapeMode = e.target.value;
            applyNodeShapeMode();
        });
    });
    // Edge inference mode
    document.querySelectorAll('input[name="edge-inference"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            edgeInferenceMode = e.target.value;
            syncEdgeInferenceMode();
        });
    });

    // F10: Layout mode toggle (organic | dagre | timeline)
    document.querySelectorAll('input[name="layout-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            layoutMode = e.target.value;
            timelineMode = layoutMode === 'timeline';
            organicMode = layoutMode === 'organic';
            document.body.classList.toggle('organic', organicMode);
            // Clear all inline styles so the swapped stylesheet has full control
            // (e.g. dagre's inline degree-sizing must not override organic data(_sz)).
            cy.elements().removeStyle();
            applyDegreeScaling();        // seed _sz/_bri/_tint before the swap
            applyStylesheet();           // swap baseStyle() ↔ organicStyle()
            initEdgeLegend();            // dash means provenance in organic, type elsewhere
            if (!organicMode) {
                clearBackground();       // remove cosmic overlays
                clearGlow();
                applyNodeShapeMode();    // restore typed/circle borders
            }
            runLayout();
        });
    });

    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('settings-dropdown');
        if (!e.target.closest('.settings-wrapper')) {
            dropdown.classList.remove('open');
        }
    });

    // Audit
    document.getElementById('btn-audit').addEventListener('click', showAudit);
    document.getElementById('audit-close').addEventListener('click', () => {
        document.getElementById('audit-modal').classList.remove('visible');
    });
    document.getElementById('audit-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            document.getElementById('audit-modal').classList.remove('visible');
        }
    });

    // Conclusion / Summarize
    document.getElementById('btn-summarize').addEventListener('click', (e) => withBusy(e.currentTarget, doSummarize));
    document.getElementById('btn-conclusion').addEventListener('click', showConclusion);
    const btnForce = document.getElementById('btn-force-conclude');
    if (btnForce) btnForce.addEventListener('click', doForceConclude);
    document.getElementById('conclusion-close').addEventListener('click', () => {
        document.getElementById('conclusion-modal').classList.remove('visible');
    });
    document.getElementById('conclusion-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            document.getElementById('conclusion-modal').classList.remove('visible');
        }
    });

    // API & Reasoning config modal
    const btnConfig = document.getElementById('btn-config');
    if (btnConfig) btnConfig.addEventListener('click', showConfigModal);
    const usageReadout = document.getElementById('usage-readout');
    if (usageReadout) usageReadout.addEventListener('click', showConfigModal);
    const configClose = document.getElementById('config-close');
    if (configClose) configClose.addEventListener('click', () => {
        document.getElementById('config-modal').classList.remove('visible');
    });
    const configModal = document.getElementById('config-modal');
    if (configModal) configModal.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) configModal.classList.remove('visible');
    });
    const cfgSave = document.getElementById('cfg-save');
    if (cfgSave) cfgSave.addEventListener('click', saveReasoningConfig);
    const cfgProvider = document.getElementById('cfg-provider');
    if (cfgProvider) cfgProvider.addEventListener('change', (e) => applyProviderToForm(e.target.value));
    const cfgClearKey = document.getElementById('cfg-clear-key');
    if (cfgClearKey) cfgClearKey.addEventListener('click', clearProviderKey);
    const cfgReset = document.getElementById('cfg-reset');
    if (cfgReset) cfgReset.addEventListener('click', resetReasoningConfig);
    const cliBtn = document.getElementById('btn-cli-prompt');
    if (cliBtn) cliBtn.addEventListener('click', showCliPrompt);
    const inferBtn = document.getElementById('btn-infer-edges');
    if (inferBtn) inferBtn.addEventListener('click', (e) => withBusy(e.currentTarget, runInferEdges));
    const actClear = document.getElementById('activity-clear');
    if (actClear) actClear.addEventListener('click', clearActivityLog);
    const fileOpen = document.getElementById('file-open');
    if (fileOpen) fileOpen.addEventListener('click', revealCurrentFile);
    loadReasoningConfig();
    setInterval(refreshUsage, 15000);   // keep the header token/cost readout live
}

// ---- Search ----
async function doSearch() {
    const q = document.getElementById('search-input').value.trim();
    if (!q) return;

    try {
        const resp = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
        const results = await resp.json();
        renderSearchResults(results);
    } catch (err) {
        console.error('Search failed:', err);
    }
}

function renderSearchResults(results) {
    const container = document.getElementById('search-results');
    if (results.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem; padding: 0.4rem;">No results found</p>';
        return;
    }

    container.innerHTML = results.map(r => {
        // `color` comes from our own constant table, never from node data; the rest is
        // agent-supplied and goes through _esc (which also covers the attribute below).
        const color = NODE_TYPE_COLORS[r.node_type] || '#6b7280';
        return `
            <div class="search-result-item" data-id="${_esc(r.id)}">
                <span class="type-badge" style="background: ${color}22; color: ${color};">${_esc(r.node_type)}</span>
                <span>${_esc(r.label)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.search-result-item').forEach(el => {
        el.addEventListener('click', async () => {
            const nodeId = el.dataset.id;
            const cyNode = cy.getElementById(nodeId);
            if (cyNode.length) {
                if (!_fvPin(nodeId)) cy.animate({ center: { eles: cyNode }, zoom: 1.5 }, { duration: 300 });
                showDetail(cyNode.data());
                await highlightLineage(nodeId);
            }
        });
    });
}

// ---- Lineage highlighting ----
async function highlightLineage(nodeId) {
    try {
        const resp = await fetch(`${API_BASE}/lineage/${encodeURIComponent(nodeId)}`);
        const lineage = await resp.json();

        const ids = new Set([nodeId, ...(lineage.upstream_ids || []), ...(lineage.downstream_ids || [])]);

        cy.edges().removeClass('selected-edge');   // drop any prior edge selection
        cy.elements().forEach(el => {
            if (el.isNode()) {
                if (ids.has(el.data('id'))) {
                    el.removeClass('faded').addClass('highlighted');
                    if (el.data('id') === nodeId) el.addClass('selected-node');
                    else el.removeClass('selected-node');
                } else {
                    el.removeClass('highlighted selected-node').addClass('faded');
                }
            } else {
                const src = el.data('source');
                const tgt = el.data('target');
                if (ids.has(src) && ids.has(tgt)) {
                    el.removeClass('faded').addClass('highlighted');
                } else {
                    el.removeClass('highlighted').addClass('faded');
                }
            }
        });
        // Fire the wave only once the lit set exists — it walks '.highlighted'.
        startLineagePulse(nodeId);
    } catch (err) {
        console.error('Lineage fetch failed:', err);
    }
}

function highlight2Hop(node) {
    // Collect 1-hop and 2-hop neighborhood
    const hop1 = node.neighborhood();
    const hop2 = hop1.nodes().neighborhood();
    const nearby = node.union(hop1).union(hop2);

    cy.elements().forEach(el => {
        if (nearby.contains(el)) {
            el.removeClass('faded').addClass('highlighted');
        } else {
            el.removeClass('highlighted selected-node').addClass('faded');
        }
    });
    node.addClass('selected-node');
}

function clearHighlight() {
    cy.elements().removeClass('highlighted faded selected-node selected-edge');
    legendHighlight = null;
    document.querySelectorAll('.legend-item[data-type], .legend-item[data-edge-type],'
        + ' .legend-item[data-credibility], .legend-item[data-edge-policy]')
        .forEach(el => el.classList.remove('active'));
    applyDegreeScaling();   // F4
    // F11: Clear path state
    pathSelectState.firstNodeId = null;
    const pathStatus = document.getElementById('path-status');
    if (pathStatus) pathStatus.style.display = 'none';
}

// ---- Detail panel ----
function showDetail(data) {
    showNodeFile(data);   // also populate the bottom File panel
    const panel = document.getElementById('detail-panel');
    const fields = [
        { label: 'ID', value: data.id },
        { label: 'Type', value: NODE_TYPE_LABELS[data.node_type] || data.node_type },
        { label: 'Label', value: data.label },
    ];

    if (data.description) fields.push({ label: 'Description', value: data.description });

    // Claim fields
    if (data.claim_text) fields.push({ label: 'Claim', value: data.claim_text });
    if (data.confidence != null) fields.push({ label: 'Confidence', value: (data.confidence * 100).toFixed(0) + '%' });
    if (data.evidence_ids && data.evidence_ids.length) {
        fields.push({ label: 'Evidence', value: data.evidence_ids.length + ' supporting node(s)' });
    }

    // Hypothesis fields
    if (data.null_hypothesis) fields.push({ label: 'Null Hypothesis', value: data.null_hypothesis });
    if (data.testable != null) fields.push({ label: 'Testable', value: data.testable ? 'Yes' : 'No' });

    // RQ fields
    if (data.scope) fields.push({ label: 'Scope', value: data.scope });

    // Motivation fields
    if (data.source) fields.push({ label: 'Source', value: data.source });

    // Experiment design fields
    if (data.methodology) fields.push({ label: 'Methodology', value: data.methodology });
    if (data.parameters && Object.keys(data.parameters).length) {
        const params = Object.entries(data.parameters).map(([k, v]) => `${k}: ${v}`).join(', ');
        fields.push({ label: 'Parameters', value: params });
    }

    // Artifact fields
    if (data.path) fields.push({ label: 'Path', value: data.path });
    if (data.artifact_type) fields.push({ label: 'Artifact Type', value: data.artifact_type });
    if (data.version) fields.push({ label: 'Version', value: data.version });

    // Run fields
    if (data.status) fields.push({ label: 'Status', value: data.status });
    if (data.git_commit) fields.push({ label: 'Git Commit', value: data.git_commit });
    if (data.duration_seconds != null) {
        const dur = data.duration_seconds;
        const display = dur >= 60 ? (dur / 60).toFixed(1) + ' min' : dur.toFixed(1) + 's';
        fields.push({ label: 'Duration', value: display });
    }
    if (data.environment && Object.keys(data.environment).length) {
        const env = Object.entries(data.environment).map(([k, v]) => `${k}: ${v}`).join(', ');
        fields.push({ label: 'Environment', value: env });
    }

    // Result fields
    if (data.result_file) fields.push({ label: 'Result File', value: data.result_file });

    // Metrics (sparklines)
    if (data.metrics && Object.keys(data.metrics).length) {
        fields.push({ label: 'Metrics', value: '__sparkline__', _metrics: data.metrics });
    }

    // Timestamps
    if (data.created_at) fields.push({ label: 'Created', value: new Date(data.created_at).toLocaleString() });

    // Generic metadata
    if (data.metadata && Object.keys(data.metadata).length) {
        const meta = Object.entries(data.metadata).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
        fields.push({ label: 'Metadata', value: meta });
    }

    let scoreHtml = '';
    if (data.credibility_score != null) {
        const score = data.credibility_score;
        const color = _credColor(score);
        const pct = (score * 100).toFixed(0);
        scoreHtml = `
            <div class="field">
                <div class="field-label">Credibility Score</div>
                <div class="field-value">${pct}%</div>
                <div class="score-bar"><div class="score-fill" style="width:${pct}%; background:${color};"></div></div>
            </div>
        `;
        if (data.score_details) {
            const details = Object.entries(data.score_details)
                .map(([k, v]) => `${_esc(k.replace(/_/g, ' '))}: ${(Number(v) * 100).toFixed(0)}%`)
                .join(', ');
            scoreHtml += `<div class="field"><div class="field-label">Score Breakdown</div><div class="field-value">${details}</div></div>`;
        }
    }

    // Values above are raw node data straight off the wire, so they are escaped here
    // at the single render site rather than at each of the ~15 push() calls. The
    // sparkline branch is the one case that is deliberately markup.
    panel.innerHTML = fields.map(f => {
        if (f.value === '__sparkline__' && f._metrics) {
            return `
                <div class="field">
                    <div class="field-label">${_esc(f.label)}</div>
                    <div class="field-value">${renderMetricSparklines(f._metrics)}</div>
                </div>
            `;
        }
        return `
            <div class="field">
                <div class="field-label">${_esc(f.label)}</div>
                <div class="field-value">${_esc(f.value)}</div>
            </div>
        `;
    }).join('') + scoreHtml;
}

function clearDetail() {
    document.getElementById('detail-panel').innerHTML =
        '<p style="color: var(--text-muted); font-size: 0.8rem;">Click a node or edge to see details</p>';
}

// ---- Edge detail panel (mirrors showDetail for relationships) ----
function showEdgeDetail(edge) {
    const data = edge.data();
    const et = data.edge_type || 'edge';
    const etLabel = EDGE_TYPE_LABELS[et] || prettifyEdgeType(et);

    const srcN = cy.getElementById(data.source);
    const tgtN = cy.getElementById(data.target);
    const srcLabel = srcN.nonempty() ? (srcN.data('label') || data.source) : data.source;
    const tgtLabel = tgtN.nonempty() ? (tgtN.data('label') || data.target) : data.target;
    const srcType = srcN.nonempty() ? (NODE_TYPE_LABELS[srcN.data('node_type')] || srcN.data('node_type')) : '';
    const tgtType = tgtN.nonempty() ? (NODE_TYPE_LABELS[tgtN.data('node_type')] || tgtN.data('node_type')) : '';
    const withType = (label, type) =>
        `${_esc(label)}${type ? ` <span class="edge-detail-type">(${_esc(type)})</span>` : ''}`;

    const fields = [
        { label: 'Relationship', value: _esc(etLabel) },
        { label: 'Source', value: withType(srcLabel, srcType) },
        { label: 'Target', value: withType(tgtLabel, tgtType) },
    ];
    if (EDGE_TYPE_MEANINGS[et]) fields.push({ label: 'Meaning', value: _esc(EDGE_TYPE_MEANINGS[et]) });
    if (data.label && data.label !== et) fields.push({ label: 'Label', value: _esc(data.label) });
    if (data.policy) fields.push({ label: 'Created by', value: _esc(EDGE_POLICY_LABELS[data.policy] || prettifyEdgeType(data.policy)) });
    if (data.weight != null && data.weight !== 1) fields.push({ label: 'Weight', value: _esc(String(data.weight)) });
    if (data.metadata && Object.keys(data.metadata).length) {
        const meta = Object.entries(data.metadata)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
        fields.push({ label: 'Metadata', value: _esc(meta) });
    }

    document.getElementById('detail-panel').innerHTML = fields.map(f => `
        <div class="field">
            <div class="field-label">${f.label}</div>
            <div class="field-value">${f.value}</div>
        </div>
    `).join('');

    showEdgeFile(data, srcLabel, srcType, tgtLabel, tgtType, etLabel);
}

// Bottom "File" panel shows the relationship as a source → target card for edges.
function showEdgeFile(data, srcLabel, srcType, tgtLabel, tgtType, etLabel) {
    const titleEl = document.getElementById('file-panel-title');
    const bodyEl = document.getElementById('file-panel-body');
    const openBtn = document.getElementById('file-open');
    if (!bodyEl || !titleEl) return;
    _currentFilePath = null;
    if (openBtn) openBtn.disabled = true;
    titleEl.textContent = `Edge · ${etLabel}`;
    const typeTag = (t) => t ? `<span class="edge-detail-type"> ${_esc(t)}</span>` : '';
    bodyEl.innerHTML =
        `<div class="edge-relation">`
        + `<div class="edge-relation-node"><b>${_esc(srcLabel)}</b>${typeTag(srcType)}</div>`
        + `<div class="edge-relation-arrow" style="color:${_esc(data.color || '#a78bfa')}">&darr; ${_esc(etLabel)}</div>`
        + `<div class="edge-relation-node"><b>${_esc(tgtLabel)}</b>${typeTag(tgtType)}</div>`
        + `</div>`;
}

// Highlight the clicked edge + its two endpoint nodes; fade everything else.
function highlightEdge(edge) {
    const keep = new Set([edge.data('source'), edge.data('target')]);
    const eid = edge.id();
    cy.batch(() => {
        cy.elements().forEach(el => {
            if (el.isNode()) {
                if (el.hasClass('cluster-label')) return;
                if (keep.has(el.data('id'))) {
                    el.removeClass('faded').addClass('highlighted selected-node');
                } else {
                    el.removeClass('highlighted selected-node').addClass('faded');
                }
            } else if (el.id() === eid) {
                el.removeClass('faded').addClass('highlighted selected-edge');
            } else {
                el.removeClass('highlighted selected-edge').addClass('faded');
            }
        });
    });
}

// Activate the matching edge-type item in the Edge Types legend.
function highlightEdgeLegend(edgeData) {
    document.querySelectorAll('.legend-item').forEach(el => {
        if (el.dataset.edgeType && el.dataset.edgeType === edgeData.edge_type) el.classList.add('active');
        else el.classList.remove('active');
    });
}

// ---- Node shape mode ----
function applyNodeShapeMode() {
    if (organicMode) return;   // organic mode owns node styling (borderless dots)
    if (nodeShapeMode === 'circle') {
        cy.nodes().not('.cluster-label').style({
            'shape': 'ellipse',
            'border-color': PAL.baseRim,
            'border-width': 2,
            'border-opacity': 1,
            'overlay-opacity': 0,
        });
    } else {
        cy.nodes().not('.cluster-label').forEach(n => {
            n.style({
                'shape': n.data('shape'),
                'border-color': n.data('color'),
                'border-width': 2,
                'border-opacity': 0.5,
                'overlay-opacity': 0,
            });
        });
    }
    // Re-apply highlighted/selected overrides
    cy.nodes('.highlighted').style({ 'border-width': 4, 'border-color': PAL.focus, 'border-opacity': 1 });
    cy.nodes('.selected-node').style({ 'border-width': 5, 'border-color': '#FABD2F', 'border-opacity': 1, 'overlay-color': '#FABD2F', 'overlay-opacity': 0.22, 'overlay-padding': 8 });
}

// ---- Edge inference mode ----
async function syncEdgeInferenceMode() {
    try {
        await fetch(`${API_BASE}/settings/edge-inference-mode`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: edgeInferenceMode }),
        });
    } catch (err) {
        console.error('Failed to sync edge inference mode:', err);
    }
}

async function loadEdgeInferenceMode() {
    try {
        const resp = await fetch(`${API_BASE}/settings/edge-inference-mode`);
        const data = await resp.json();
        edgeInferenceMode = data.mode || 'heuristic';
        const radio = document.querySelector(`input[name="edge-inference"][value="${edgeInferenceMode}"]`);
        if (radio) radio.checked = true;
    } catch (err) {
        // Default to heuristic on error
    }
}

// ---- Credibility toggle ----
// Scores are pre-baked into the graph data, so the button just toggles
// between score-colored and default type-colored claim nodes.
function toggleCredibility() {
    credibilityMode = !credibilityMode;
    const btn = document.getElementById('btn-credibility');
    btn.classList.toggle('active', credibilityMode);

    cy.nodes().forEach(n => {
        const nt = n.data('node_type');
        if (nt === 'claim' || nt === 'conclusion') {
            if (credibilityMode) {
                const score = n.data('credibility_score');
                if (score != null) {
                    const color = _credColor(score);
                    n.data('color', color);
                }
            } else {
                n.data('color', nt === 'conclusion' ? NODE_TYPE_COLORS.conclusion : NODE_TYPE_COLORS.claim);
            }
        }
    });

    // Organic mode binds _tint, not color — recompute so the recolor takes effect.
    if (organicMode) { applyDegreeScaling(); scheduleGlow(); }
}

// ---- Markdown is untrusted input -------------------------------------------
// The report, the conclusion and the evolve plan are markdown built from node labels
// and claim text — and both of those are supplied by whatever the tool is watching: an
// autonomous agent posting to /events, or a file in the folder the user pointed us at.
// marked has had no sanitizer since v5, so `innerHTML = marked.parse(md)` executes any
// HTML the markdown contains. A claim titled `<img src=x onerror=...>` therefore ran as
// script the moment someone clicked Report, same-origin against this API.
//
// So: render, then scrub against an allowlist before anything reaches the document.
// DOMParser is the safe place to do it — it builds an inert tree, so nothing executes
// and no image is fetched while we are inspecting it.
const _MD_TAGS = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'b', 'i', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'span', 'div',
]);
// Anything not on this list keeps its text and loses its markup, except the few that
// carry executable or navigational weight, which go entirely.
const _MD_DROP = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'img',
]);
const _MD_ATTRS = {
    a: ['href', 'title'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
    '*': [],
};
const _MD_SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

function _scrubMarkdownDom(root) {
    Array.from(root.querySelectorAll('*')).forEach(el => {
        const tag = el.tagName.toLowerCase();

        if (_MD_DROP.has(tag)) { el.remove(); return; }

        if (!_MD_TAGS.has(tag)) {
            // Unknown but not obviously dangerous: keep what it said, drop what it was.
            el.replaceWith(el.ownerDocument.createTextNode(el.textContent || ''));
            return;
        }

        const allowed = _MD_ATTRS[tag] || _MD_ATTRS['*'];
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            // Every on* handler goes, whatever the tag — that is the actual payload.
            if (!allowed.includes(name)) { el.removeAttribute(attr.name); return; }
            if (name === 'href' && !_MD_SAFE_URL.test(String(attr.value).trim())) {
                el.removeAttribute(attr.name);
            }
        });

        if (tag === 'a' && el.getAttribute('href')) {
            el.setAttribute('rel', 'noopener noreferrer');
        }
    });
}

function renderMarkdown(md) {
    // The single place markdown becomes HTML. Nothing else may call marked.parse.
    let dirty;
    try {
        dirty = marked.parse(md || '');
    } catch (e) {
        return '';
    }
    const doc = new DOMParser().parseFromString(String(dirty), 'text/html');
    _scrubMarkdownDom(doc.body);
    return doc.body.innerHTML;
}

// ---- Audit report ----
// One document: conclusion + findings + per-claim credibility + the methodology that
// explains all of it. Replaces the claims-only audit modal, which forced a reviewer to
// cross-reference it against conclusion.md by node id.
async function showAudit() {
    const modal = document.getElementById('audit-modal');
    const body = document.getElementById('audit-body');
    const dl = document.getElementById('report-download');
    modal.classList.add('visible');
    body.innerHTML = 'Loading…';
    if (dl) dl.hidden = true;

    try {
        const resp = await fetch(`${API_BASE}/report`);
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        const data = await resp.json();
        // Every settled state must contain at least one ELEMENT: the loading skeleton
        // in polish.css keys off "#audit-body has text but no element children", so a
        // text-only success or failure would leave the shimmer running forever.
        body.innerHTML = renderMarkdown(data.markdown)
            || '<p style="color: var(--text-muted);">The report came back empty.</p>';
        if (dl) {
            dl.hidden = false;
            dl.href = `${API_BASE}/report.md`;   // Content-Disposition makes it save
        }
    } catch (err) {
        body.textContent = '';
        const p = document.createElement('p');
        p.style.color = 'var(--text-muted)';
        p.textContent = `Could not build the report — ${err.message}.`;
        body.appendChild(p);
        console.error(err);
    }
}

// ---- Conclusion / Convergence ----
function _openConclusionModal(title) {
    const modal = document.getElementById('conclusion-modal');
    const body = document.getElementById('conclusion-body');
    const h = modal.querySelector('.modal-header h2');
    if (h && title) h.textContent = title;
    modal.classList.add('visible');
    return body;
}

function _renderConclusion(data) {
    const body = document.getElementById('conclusion-body');
    const md = (data && data.markdown) ? data.markdown : '';
    if (!md.trim()) {
        body.innerHTML = '<p style="color: var(--text-muted);">No results to converge yet — '
            + 'produce some result nodes, then summarize.</p>';
        return;
    }
    body.innerHTML = renderMarkdown(md);
    _linkifyNodeRefs(body);     // make CLM-/CONC-/RES-… ids in the text clickable
    _appendExploreList(body);   // interactive Focus / Evolve list of findings + claims
    const hint = document.getElementById('conclusion-hint');
    if (hint && typeof data.findings === 'number') {
        const via = data.reasoning === 'api' ? ' · via API' : '';
        hint.textContent = `${data.findings} finding(s) from ${data.result_count} result(s)${via}.`;
    }
    if (typeof data.findings === 'number') {
        logActivity('system', `converged <b>${data.result_count}</b> results → <b>${data.findings}</b> conclusion findings`
            + (data.reasoning === 'api' ? ' (API)' : ''), '#9D7CD8');
    }
    // API-mode runs spend tokens — refresh the usage readout.
    if (data.reasoning === 'api' && typeof loadReasoningConfig === 'function') loadReasoningConfig();
    // The graph just gained/refreshed conclusion nodes; SSE streams them in, but
    // a re-converge also deletes the old ones — reload to stay in sync.
    if (data.status === 'ok' && typeof loadGraph === 'function') loadGraph();
}

// "Summarize files" — (re)cluster results into <=5 findings + update conclusion.md
async function doSummarize() {
    const body = _openConclusionModal('Conclusion');
    body.innerHTML = 'Summarizing — clustering results into &le;5 findings&hellip;';
    try {
        const resp = await fetch(`${API_BASE}/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        _renderConclusion(await resp.json());
    } catch (err) {
        body.innerHTML = '<p style="color: var(--text-muted);">Summarize failed — is the server running?</p>';
        console.error(err);
    }
}

// Default instruction prefilled into the Force-generate box (user can edit it).
const DEFAULT_FORCE_QUESTION =
    'Write a calibrated executive conclusion of this investigation: the overall verdict, '
    + 'the strongest drivers for and against, and an explicit bottom-line probability or '
    + 'recommendation. Ground every point in the findings above; do not invent data.';

// "Force-generate (API)" — open a box to type the exact question, then call the model.
function doForceConclude() {
    const body = _openConclusionModal('Force-generate (API)');
    body.innerHTML =
        '<p style="color: var(--text-muted); font-size: 0.82rem;">Type the exact question / '
        + 'instruction to send to the model. It is appended to the conclusion prompt (which '
        + 'already includes the converged findings). Requires API mode in <b>API Config</b>.</p>'
        + `<textarea id="force-question" class="cfg-input" rows="5" style="resize:vertical;">${_esc(DEFAULT_FORCE_QUESTION)}</textarea>`
        + '<button id="force-go" class="sidebar-btn primary" style="margin-top:0.6rem;">&#9889; Generate</button>'
        + '<div class="cfg-note" id="force-note"></div>';
    const go = document.getElementById('force-go');
    if (go) go.addEventListener('click', (e) => withBusy(e.currentTarget, () => runForceGenerate(document.getElementById('force-question').value)));
    const ta = document.getElementById('force-question');
    if (ta) ta.focus();
}

async function runForceGenerate(question) {
    const note = document.getElementById('force-note');
    if (note) note.textContent = 'Generating via the model…';
    try {
        const resp = await fetch(`${API_BASE}/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ require_api: true, question: question || '' }),
        });
        const data = await resp.json();
        const body = document.getElementById('conclusion-body');
        if (data.status === 'error') {
            if (note) note.textContent = data.reason || 'API generation failed.';
            else body.innerHTML = `<p style="color: var(--text-muted);">${_esc(data.reason || 'API generation failed.')}</p>`;
            return;
        }
        _renderConclusion(data);
    } catch (err) {
        if (note) note.textContent = 'Force-generate failed — is the server running?';
        console.error(err);
    }
}

// "View conclusion file" — point to the file; create it on first use, then keep it updated
async function showConclusion() {
    const body = _openConclusionModal('Conclusion');
    body.innerHTML = 'Loading conclusion&hellip;';
    try {
        let resp = await fetch(`${API_BASE}/conclusion`);
        let data = await resp.json();
        if (!data.exists) {
            body.innerHTML = 'No conclusion file yet — generating one&hellip;';
            resp = await fetch(`${API_BASE}/summarize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            data = await resp.json();
        }
        _renderConclusion(data);
    } catch (err) {
        body.innerHTML = '<p style="color: var(--text-muted);">Could not load the conclusion file.</p>';
        console.error(err);
    }
}

// ---- Focus & Evolve (click a claim/finding in the summary to drill in) ----

const _NODE_REF_RE = /\b(CLM|CONC|RES|RUN|HYP|EXP|ART|MOT|RQ|FACT)(-EVO)?-\d{1,4}\b/g;

// Single source of truth for credibility colours. The thresholds come from the
// server (GET /api/config -> credibility_thresholds), which reads them from
// server/graph/scoring.py, so the legend, the node colours and the report cannot disagree.
// The literals here are only a pre-fetch fallback.
let CRED_THRESHOLDS = { green: 0.72, yellow: 0.40 };
const CRED_COLORS = { green: '#689D6A', yellow: '#D79921', red: '#CC241D' };

function _credRating(s) {
    if (s == null) return null;
    return s >= CRED_THRESHOLDS.green ? 'green' : (s >= CRED_THRESHOLDS.yellow ? 'yellow' : 'red');
}

function _credColor(s) {
    const r = _credRating(s);
    return r ? CRED_COLORS[r] : null;
}

async function loadCredThresholds() {
    try {
        const r = await fetch('/api/config');
        const d = await r.json();
        if (d && d.credibility_thresholds) CRED_THRESHOLDS = d.credibility_thresholds;
    } catch (e) { /* keep the fallback */ }
}

function _closeConclusionModal() {
    const m = document.getElementById('conclusion-modal');
    if (m) m.classList.remove('visible');
}

// Isolate a claim/finding + its evidence subtree (Obsidian-style local view):
// highlight the lineage, fade the rest, and fit the viewport to just that subtree.
async function focusSubtree(nodeId) {
    _closeConclusionModal();
    if (!cy) return;
    const n = cy.getElementById(nodeId);
    if (!n || n.empty()) return;
    showDetail(n.data());
    highlightLegend(n.data());
    await highlightLineage(nodeId);
    const focused = cy.elements('.highlighted');
    if (_fvPin(nodeId)) {
        // The focus view is up: the chain is lit there, so leave this camera alone.
    } else if (focused && focused.length) {
        cy.animate({ fit: { eles: focused, padding: 90 } }, { duration: 480, easing: 'ease-out' });
    } else {
        cy.animate({ center: { eles: n }, zoom: 1.4 }, { duration: 360 });
    }
    logActivity('system', `focused <b>${_esc(nodeId)}</b> + its evidence chain`, '#9D7CD8', nodeId);
}

// Turn node-id tokens inside rendered markdown into clickable chips.
function _linkifyNodeRefs(container) {
    if (!container) return;
    const skip = new Set(['CODE', 'PRE', 'A', 'BUTTON', 'TEXTAREA']);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let tn;
    while ((tn = walker.nextNode())) {
        if (tn.parentElement && skip.has(tn.parentElement.tagName)) continue;
        if (_NODE_REF_RE.test(tn.nodeValue)) targets.push(tn);
        _NODE_REF_RE.lastIndex = 0;
    }
    targets.forEach((node) => {
        const frag = document.createDocumentFragment();
        let last = 0;
        const text = node.nodeValue;
        let m;
        _NODE_REF_RE.lastIndex = 0;
        while ((m = _NODE_REF_RE.exec(text))) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const id = m[0];
            const chip = document.createElement('a');
            chip.className = 'node-ref';
            chip.textContent = id;
            chip.title = `Focus ${id} and its evidence chain`;
            chip.addEventListener('click', (e) => { e.preventDefault(); focusSubtree(id); });
            frag.appendChild(chip);
            last = m.index + id.length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    });
}

// Append an interactive "Explore & evolve" list of findings + claims to the modal.
async function _appendExploreList(body) {
    if (!body) return;
    let graph;
    try {
        graph = await (await fetch(`${API_BASE}/graph`)).json();
    } catch (e) { return; }
    const nodes = (graph.elements || []).filter((el) => el.group === 'nodes').map((el) => el.data);
    const findings = nodes.filter((n) => n.node_type === 'conclusion')
        .sort((a, b) => (a.finding_index || 0) - (b.finding_index || 0));
    const claims = nodes.filter((n) => n.node_type === 'claim');
    if (!findings.length && !claims.length) return;

    const wrap = document.createElement('div');
    wrap.className = 'explore-section';
    const h = document.createElement('h3');
    h.className = 'explore-title';
    h.textContent = 'Explore & evolve';
    const sub = document.createElement('p');
    sub.className = 'explore-sub';
    sub.textContent = 'Click any finding or claim to focus its evidence — or evolve it into a deeper investigation.';
    wrap.appendChild(h);
    wrap.appendChild(sub);

    const list = document.createElement('div');
    list.className = 'explore-list';

    const mkItem = (n, kind) => {
        const baseColor = kind === 'finding' ? NODE_TYPE_COLORS.conclusion : NODE_TYPE_COLORS.claim;
        const dotColor = _credColor(n.credibility_score) || baseColor;
        const row = document.createElement('div');
        row.className = 'explore-item';

        const main = document.createElement('button');
        main.className = 'explore-main';
        main.title = `Focus ${n.id}`;
        main.innerHTML = `<span class="explore-dot" style="background:${dotColor}"></span>`
            + `<span class="explore-id">${_esc(n.id)}</span>`
            + `<span class="explore-label">${_esc(n.label || '')}</span>`
            + (n.credibility_score != null
                ? `<span class="explore-cred" style="color:${dotColor}">${Math.round(n.credibility_score * 100)}%</span>`
                : '');
        main.addEventListener('click', () => focusSubtree(n.id));

        const evo = document.createElement('button');
        evo.className = 'explore-evolve';
        evo.textContent = '✦ Evolve';
        evo.title = `Branch a deeper investigation off ${n.id}`;
        evo.addEventListener('click', (e) => { e.stopPropagation(); openEvolve(n.id, n.label || n.id, kind); });

        row.appendChild(main);
        row.appendChild(evo);
        return row;
    };

    if (findings.length) {
        const lbl = document.createElement('div');
        lbl.className = 'explore-group-label';
        lbl.textContent = 'Findings';
        list.appendChild(lbl);
        findings.forEach((n) => list.appendChild(mkItem(n, 'finding')));
    }
    if (claims.length) {
        const lbl = document.createElement('div');
        lbl.className = 'explore-group-label';
        lbl.textContent = 'Claims';
        list.appendChild(lbl);
        claims.forEach((n) => list.appendChild(mkItem(n, 'claim')));
    }
    wrap.appendChild(list);
    body.appendChild(wrap);
}

// Open the Evolve form for one node inside the conclusion modal.
function openEvolve(nodeId, label, kind) {
    kind = kind || (String(nodeId).startsWith('CONC') ? 'finding' : 'claim');
    const modal = document.getElementById('conclusion-modal');
    const body = document.getElementById('conclusion-body');
    const head = modal.querySelector('.modal-header h2');
    if (head) head.textContent = 'Evolve';
    const dflt = `Deepen the investigation behind ${nodeId}: what additional evidence, `
        + `experiments, or data would most strengthen or challenge it?`;
    body.innerHTML =
        '<button class="evolve-back" id="evolve-back">&larr; Back to conclusion</button>'
        + `<div class="evolve-head">Evolve <span class="node-ref static">${_esc(nodeId)}</span> `
        + `<span class="evolve-headlabel">${_esc(label)}</span></div>`
        + `<p class="evolve-sub">Spin a deeper investigation off this ${_esc(kind)}. <b>Deepen</b> uses the `
        + 'configured API model (or returns a paste-prompt) to branch a sharper question, hypotheses, and '
        + 'experiments onto the galaxy. <b>Launch CC workflow</b> writes a scoped kick-start file and starts a '
        + 'headless Claude Code CLI that researches this finding <i>and its sibling channel</i> hands-free.</p>'
        + `<textarea id="evolve-q" class="cfg-input" rows="3">${_esc(dflt)}</textarea>`
        + '<div class="cfg-actions" style="margin-top:0.6rem;">'
        + `<button id="evolve-go" class="sidebar-btn primary">&#10022; Deepen this ${_esc(kind)}</button>`
        + '<button id="evolve-launch" class="sidebar-btn" title="Write a scoped kick-start file and launch a headless Claude Code CLI workflow that deepens this finding and its sibling channel">&#9889; Launch CC workflow</button>'
        + '</div>'
        + '<div class="evolve-result" id="evolve-result"></div>';
    const back = document.getElementById('evolve-back');
    if (back) back.addEventListener('click', showConclusion);
    const go = document.getElementById('evolve-go');
    if (go) go.addEventListener('click', (e) => withBusy(e.currentTarget, () => runEvolve(nodeId, document.getElementById('evolve-q').value)));
    const launch = document.getElementById('evolve-launch');
    if (launch) launch.addEventListener('click', (e) => withBusy(e.currentTarget, () => runEvolveLaunch(nodeId, document.getElementById('evolve-q').value)));
    const ta = document.getElementById('evolve-q');
    if (ta) ta.focus();
}

async function runEvolve(nodeId, question) {
    const res = document.getElementById('evolve-result');
    if (res) res.innerHTML = '<span style="color:var(--text-muted);">Evolving&hellip;</span>';
    try {
        const r = await fetch(`${API_BASE}/evolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_id: nodeId, question: question || '' }),
        });
        if (!r.ok) {
            let detail = '';
            try { detail = (await r.json()).detail || ''; } catch (e) { /* non-JSON body */ }
            if (r.status === 404 && (!detail || detail === 'Not Found')) {
                // A bare "Not Found" means the /evolve route itself is missing —
                // i.e. the server is running older code without this feature.
                res.innerHTML = '<p class="evolve-note"><b>Evolve endpoint not found (404).</b> '
                    + 'The server is running older code without this feature. Stop it and run '
                    + '<code>python run.py</code> again, then hard-refresh this page (Ctrl+Shift+R).</p>';
            } else {
                res.innerHTML = `<p class="evolve-note">${_esc(detail || ('Request failed (' + r.status + ').'))}</p>`;
            }
            return;
        }
        const data = await r.json();
        if (data.status === 'ok') {
            const n = (data.added_nodes || []).length;
            res.innerHTML =
                `<div class="evolve-ok">Branched <b>${n}</b> new node(s) off ${_esc(nodeId)}. `
                + '<button class="evolve-inline-btn" id="evolve-focus">Focus the new branch &rarr;</button></div>'
                + `<div class="evolve-plan">${renderMarkdown(data.plan_markdown)}</div>`;
            logActivity('system', `evolved <b>${_esc(nodeId)}</b> &rarr; +${n} nodes (API)`, '#9D7CD8', data.root_id);
            if (typeof loadReasoningConfig === 'function') loadReasoningConfig();
            if (typeof loadGraph === 'function') await loadGraph();
            const fb = document.getElementById('evolve-focus');
            if (fb) fb.addEventListener('click', () => focusSubtree(data.root_id || nodeId));
        } else if (data.status === 'prompt') {
            const sugs = (data.suggestions || []).length
                ? '<div class="evolve-sugs"><b>Quick wins to raise its credibility:</b><ul>'
                    + data.suggestions.map((s) => `<li>${_esc(s)}</li>`).join('') + '</ul></div>'
                : '';
            res.innerHTML =
                '<p class="evolve-note">API mode is off — here is a focused prompt to paste into an '
                + 'AI CLI (it will branch the new nodes onto this graph via the API):</p>'
                + `<pre class="evolve-prompt" id="evolve-prompt">${_esc(data.prompt || '')}</pre>`
                + '<button class="sidebar-btn" id="evolve-copy">Copy prompt</button>'
                + sugs;
            const cp = document.getElementById('evolve-copy');
            if (cp) cp.addEventListener('click', () => {
                navigator.clipboard.writeText(data.prompt || '').then(() => { cp.textContent = 'Copied ✓'; });
            });
        } else {
            res.innerHTML = `<p class="evolve-note">${_esc(data.reason || data.detail || 'Evolve failed.')}</p>`;
        }
    } catch (err) {
        if (res) res.innerHTML = '<p class="evolve-note">Evolve failed — is the server running?</p>';
        console.error(err);
    }
}

async function runEvolveLaunch(nodeId, question) {
    const res = document.getElementById('evolve-result');
    if (res) res.innerHTML = '<span style="color:var(--text-muted);">Launching Claude Code workflow&hellip;</span>';
    try {
        const r = await fetch(`${API_BASE}/evolve/launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_id: nodeId, question: question || '' }),
        });
        if (!r.ok) {
            let detail = '';
            try { detail = (await r.json()).detail || ''; } catch (e) { /* non-JSON body */ }
            if (r.status === 404 && (!detail || detail === 'Not Found')) {
                res.innerHTML = '<p class="evolve-note"><b>Launch endpoint not found (404).</b> The server is '
                    + 'running older code without this feature. Stop it, run <code>python run.py</code>, then '
                    + 'hard-refresh this page (Ctrl+Shift+R).</p>';
            } else if (r.status === 409) {
                const msg = (detail && detail.message) || 'A workflow is already running for this node.';
                res.innerHTML = `<p class="evolve-note"><b>${_esc(msg)}</b> `
                    + 'Cancel it from the Jobs strip before launching another.</p>';
                refreshJobs();
            } else {
                const text = (detail && detail.message) ? detail.message : detail;
                res.innerHTML = `<p class="evolve-note">${_esc(text || ('Request failed (' + r.status + ').'))}</p>`;
            }
            return;
        }
        const data = await r.json();
        const cmdBlock = `<pre class="evolve-prompt" id="evolve-cmd">${_esc(data.command || '')}</pre>`
            + '<button class="sidebar-btn" id="evolve-cmd-copy">Copy command</button>';
        if (data.launched) {
            res.innerHTML =
                `<div class="evolve-ok">&#9889; Launched a Claude Code workflow (pid <b>${_esc(String(data.pid))}</b>) `
                + `deepening <b>${_esc(nodeId)}</b> + ${data.sibling_count} sibling node(s). New nodes will stream `
                + 'into the galaxy as it works.</div>'
                + `<p class="evolve-note">Kick-start file: <code>${_esc(data.kickstart_path || '')}</code><br>`
                + `Log: <code>${_esc(data.log_path || '')}</code></p>`
                + '<details><summary style="cursor:pointer;color:var(--text-muted);font-size:0.78rem;">Show the launch command</summary>'
                + cmdBlock + '</details>';
            logActivity('system', `launched CC workflow off <b>${_esc(nodeId)}</b> (pid ${_esc(String(data.pid))})`, '#9D7CD8', nodeId);
            startJobPolling();
        } else {
            res.innerHTML =
                `<p class="evolve-note"><b>${_esc(data.reason || 'Could not auto-launch.')}</b> The scoped kick-start `
                + `file was written to <code>${_esc(data.kickstart_path || '')}</code>. Run this in a terminal to start it:</p>`
                + cmdBlock;
        }
        const cc = document.getElementById('evolve-cmd-copy');
        if (cc) cc.addEventListener('click', () => {
            navigator.clipboard.writeText(data.command || '').then(() => { cc.textContent = 'Copied ✓'; });
        });
    } catch (err) {
        if (res) res.innerHTML = '<p class="evolve-note">Launch failed — is the server running?</p>';
        console.error(err);
    }
}

// ---- Reasoning & API config (global, not task-scoped) ----
function _money(n) {
    n = Number(n || 0);
    return '~$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
}

let _lastCfg = {};   // cached public_config, for the provider-switch form logic

function _renderUsage(u) {
    if (!u || !u.since_server_start) return;
    const s = u.since_server_start;
    const t = u.today || {};
    const fmt = (n) => Number(n || 0).toLocaleString();
    // '*' marks an under-count: an unpriced model is in the mix (cost_complete=false).
    const star = (s.cost_complete === false || t.cost_complete === false) ? '*' : '';
    const head = document.getElementById('usage-readout');
    if (head) head.innerHTML = `&#9211; ${fmt(s.total_tokens)} tok &middot; ${_money(s.estimated_cost_usd)}${star}`;
    const el = document.getElementById('cfg-usage');
    if (el) {
        el.textContent = `since start: ${fmt(s.total_tokens)} tok (${s.calls} call${s.calls === 1 ? '' : 's'}), est. cost ${_money(s.estimated_cost_usd)}${star}`
            + ` · today: ${fmt(t.total_tokens)} tok, ${_money(t.estimated_cost_usd)}`
            + (star ? '   (*cost partial — an unpriced model is in the mix)' : '');
    }
}

function _baseHint(provider) {
    return provider === 'google'
        ? 'Gemini: a v1beta prefix; the model + :generateContent are appended.'
        : 'A full POST endpoint, used as-is.';
}

// Reflect a provider selection onto the form WITHOUT reloading server state (which would
// clobber the user's unsaved reasoning-mode radio / model / base). Clears the per-provider
// scoped boxes and shows that provider's defaults + key status.
function applyProviderToForm(provider) {
    const pd = (_lastCfg.provider_defaults || {})[provider] || {};
    const keySet = (_lastCfg.api_key_set_by_provider || {})[provider];
    const m = document.getElementById('cfg-model');
    const b = document.getElementById('cfg-base');
    const k = document.getElementById('cfg-key');
    const hint = document.getElementById('cfg-base-hint');
    if (m) { m.value = ''; m.placeholder = pd.model || 'provider default'; }
    if (b) { b.value = ''; b.placeholder = pd.base_url || 'provider default'; }
    if (k) { k.value = ''; k.placeholder = keySet ? 'key set ✓ — type to replace' : 'stored server-side, never echoed'; }
    if (hint) hint.textContent = _baseHint(provider);
}

async function refreshUsage() {
    try { _renderUsage(await (await fetch('/api/usage')).json()); } catch (e) { /* ignore */ }
}

async function loadReasoningConfig() {
    try {
        const [cfgR, useR] = await Promise.all([fetch('/api/config'), fetch('/api/usage')]);
        const cfg = await cfgR.json();
        _lastCfg = cfg;
        const radio = document.querySelector(`input[name="reasoning-mode"][value="${cfg.reasoning_mode}"]`);
        if (radio) radio.checked = true;
        const prov = document.getElementById('cfg-provider');
        if (prov && !prov.matches(':focus')) prov.value = cfg.provider || 'anthropic';
        const model = document.getElementById('cfg-model');
        if (model && !model.matches(':focus')) {
            model.value = cfg.model || '';
            model.placeholder = cfg.effective_model || 'provider default';
        }
        const base = document.getElementById('cfg-base');
        if (base && !base.matches(':focus')) {
            base.value = cfg.base_url || '';
            base.placeholder = cfg.effective_base_url || 'provider default';
        }
        const mx = document.getElementById('cfg-max');
        if (mx && !mx.matches(':focus')) {
            mx.value = cfg.max_tokens || '';
            mx.placeholder = String(cfg.max_tokens || 4000);
        }
        const key = document.getElementById('cfg-key');
        if (key) key.placeholder = cfg.api_key_set ? 'key set ✓ — type to replace' : 'stored server-side, never echoed';
        const hint = document.getElementById('cfg-base-hint');
        if (hint) hint.textContent = _baseHint(cfg.provider || 'anthropic');
        _renderUsage(await useR.json());
    } catch (e) {
        console.error('reasoning config load failed', e);
        const note = document.getElementById('cfg-note');
        if (note) note.textContent = 'Could not load config — is the server running?';
    }
}

async function saveReasoningConfig() {
    const mode = (document.querySelector('input[name="reasoning-mode"]:checked') || {}).value || 'heuristic';
    const provider = (document.getElementById('cfg-provider') || {}).value || 'anthropic';
    const model = document.getElementById('cfg-model').value.trim();
    const base = document.getElementById('cfg-base').value.trim();
    const key = document.getElementById('cfg-key').value;
    const maxRaw = (document.getElementById('cfg-max') || {}).value;
    const body = { reasoning_mode: mode, provider: provider, model: model, base_url: base };
    if (key) body.api_key = key;
    const maxNum = parseInt(maxRaw, 10);
    if (Number.isFinite(maxNum) && maxNum > 0) body.max_tokens = maxNum;
    const note = document.getElementById('cfg-note');
    try {
        const r = await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            let detail = `Save failed (${r.status}).`;
            try {
                const e = await r.json();
                if (e && e.detail) detail = `Save failed: ${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}`;
            } catch (_) { /* non-JSON error body */ }
            if (note) note.textContent = detail;
            return;
        }
        const cfg = await r.json();
        document.getElementById('cfg-key').value = '';
        if (note) {
            note.textContent = `Saved · ${cfg.provider} · ${cfg.effective_model} · mode ${cfg.reasoning_mode}`
                + (cfg.api_enabled ? ' · API enabled ✓' : (mode === 'api' ? ' · set a key to enable' : ''));
        }
        loadReasoningConfig();
    } catch (e) {
        if (note) note.textContent = 'Save failed — is the server running?';
        console.error('reasoning config save failed', e);
    }
}

async function clearProviderKey() {
    const provider = (document.getElementById('cfg-provider') || {}).value || 'anthropic';
    const note = document.getElementById('cfg-note');
    try {
        const r = await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: provider, api_key: '' }),
        });
        if (note) note.textContent = r.ok ? `Cleared the runtime key for ${provider}.` : `Clear failed (${r.status}).`;
        const k = document.getElementById('cfg-key'); if (k) k.value = '';
        loadReasoningConfig();
    } catch (e) {
        if (note) note.textContent = 'Clear failed — is the server running?';
    }
}

async function resetReasoningConfig() {
    const note = document.getElementById('cfg-note');
    try {
        const r = await fetch('/api/config/reset', { method: 'POST' });
        if (note) note.textContent = r.ok ? 'Runtime overrides reset to config.json / env.' : `Reset failed (${r.status}).`;
        loadReasoningConfig();
    } catch (e) {
        if (note) note.textContent = 'Reset failed — is the server running?';
    }
}

function showConfigModal() {
    document.getElementById('config-modal').classList.add('visible');
    loadReasoningConfig();
}

async function runInferEdges() {
    const note = document.getElementById('cfg-note');
    if (note) note.textContent = 'Running LLM edge inference…';
    try {
        const r = await fetch(`${API_BASE}/infer-edges`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const d = await r.json();
        if (note) note.textContent = (d.status === 'ok')
            ? `Added ${d.added} LLM-proposed edge(s).`
            : (d.reason || 'No edges added.');
        if (d.status === 'ok') logActivity('system', `LLM edge inference: +<b>${d.added}</b> edge(s)`, '#83A598');
        if (d.status === 'ok' && d.added > 0 && typeof loadGraph === 'function') loadGraph();
        refreshUsage();
    } catch (e) {
        if (note) note.textContent = 'Edge inference failed.';
        console.error(e);
    }
}

async function showCliPrompt() {
    const body = _openConclusionModal('CLI Trigger Prompt');
    body.innerHTML = 'Loading prompt&hellip;';
    try {
        const r = await fetch(`${API_BASE}/cli-prompt`);
        const data = await r.json();
        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.fontSize = '0.78rem';
        pre.textContent = data.prompt || '(no prompt)';
        body.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem;">Paste this into an AI CLI (Claude Code, etc.) to have it maintain &amp; conclude this task’s network:</p>';
        body.appendChild(pre);
    } catch (e) {
        body.innerHTML = '<p style="color: var(--text-muted);">Could not load the CLI prompt.</p>';
        console.error(e);
    }
}

// ---- Launched Claude Code workflows ----
// Without this the UI could not tell "still thinking" from "died on a bad key", and
// there was no way to stop an agent writing wrong nodes into a live graph.
let _jobTimer = null;

function startJobPolling() {
    if (_jobTimer) return;
    refreshJobs();
    _jobTimer = setInterval(refreshJobs, 4000);
}

function stopJobPolling() {
    if (_jobTimer) { clearInterval(_jobTimer); _jobTimer = null; }
}

async function cancelJob(nodeId) {
    try {
        await fetch(`${API_BASE}/evolve/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_id: nodeId }),
        });
        logActivity('system', `cancelled workflow on <b>${_esc(nodeId)}</b>`, '#CC241D', nodeId);
    } catch (e) {
        console.error(e);
    }
    refreshJobs();
}

function renderJobs(list) {
    const strip = document.getElementById('job-strip');
    if (!strip) return;
    if (!list.length) { strip.hidden = true; strip.textContent = ''; return; }
    strip.hidden = false;
    strip.textContent = '';
    for (const j of list) {
        const row = document.createElement('div');
        row.className = 'job-row' + (j.running ? ' running' : (j.exit_code ? ' failed' : ' done'));

        const dot = document.createElement('span');
        dot.className = 'job-dot';
        row.appendChild(dot);

        const label = document.createElement('span');
        label.className = 'job-label';
        const state = j.running ? `${j.elapsed_seconds}s`
            : (j.cancelled ? 'cancelled' : (j.exit_code ? `failed (exit ${j.exit_code})` : 'finished'));
        const produced = (j.nodes_created != null) ? ` · ${j.nodes_created} node(s)` : '';
        label.textContent = `${j.node_id} — ${state}${produced}`;
        label.title = j.log_tail ? j.log_tail.slice(-600) : (j.log_path || '');
        row.appendChild(label);

        if (j.running) {
            const btn = document.createElement('button');
            btn.className = 'job-cancel';
            btn.textContent = 'Cancel';
            btn.addEventListener('click', () => withBusy(btn, () => cancelJob(j.node_id)));
            row.appendChild(btn);
        }
        strip.appendChild(row);
    }
}

async function refreshJobs() {
    try {
        const r = await fetch(`${API_BASE}/evolve/status`);
        if (!r.ok) { stopJobPolling(); return; }
        const data = await r.json();
        renderJobs(data.jobs || []);
        if (!(data.jobs || []).some(j => j.running)) stopJobPolling();
    } catch (e) {
        stopJobPolling();
    }
}



// cy.fit() frames the graph in the whole canvas — but the canvas is not all
// usable: the graph-health card floats over its top-left corner, and anything
// fitted underneath it is simply unreadable. So compute the camera ourselves
// against the space that is actually free. Analytic rather than fit()-then-nudge,
// because a nudge after an animated fit reads as a second, unexplained movement.
function _healthGutter() {
    const el = document.getElementById('elg-health');
    if (!el || el.hidden || el.offsetParent === null) return 0;
    return el.getBoundingClientRect().width + 22;
}

function _computeFrame(pad) {
    if (!cy) return null;
    // Frame on the graph, not on the chrome. Cluster labels are captions we position
    // ourselves; letting one sit in the fit bounding box means a placement bug
    // anywhere else in the app silently becomes a camera bug here.
    const eles = cy.elements().filter(e => !e.hasClass('cluster-label'));
    if (eles.length === 0) return null;
    // Geometry only. Including labels here creates a feedback loop: min-zoomed-font-size
    // holds captions at a readable screen size, so their footprint in MODEL space grows
    // as you zoom out — a wider bounding box then makes the fit zoom out further, which
    // grows the labels again. It converges, but on a graph rendered at half the size it
    // should be, with the space eaten by text. Frame the nodes; give the captions a
    // padding allowance instead.
    const bb = eles.boundingBox({ includeLabels: false, includeOverlays: false });
    if (!(bb.w > 0) || !(bb.h > 0)) return null;

    // Reserve the overlay only while there is room to spare. In Panels focus the
    // canvas is barely wider than the card itself, and honouring the full gutter
    // there would squeeze the graph into a sliver — worse than letting a couple of
    // nodes sit behind a card the user has deliberately pushed to one side.
    const gl = Math.min(_healthGutter(), cy.width() * 0.3);
    const availW = Math.max(40, cy.width() - pad * 2 - gl);
    const availH = Math.max(40, cy.height() - pad * 2);
    let z = Math.min(availW / bb.w, availH / bb.h);
    // minZoom exists to stop a user scrolling the graph into a speck, but a fixed
    // floor also makes large graphs unfittable: dagre lays an 83-node graph out as a
    // 5200-unit column that needs zoom 0.157, and the 0.2 floor clamped the camera to
    // showing three quarters of it. Lower the floor to whatever this graph actually
    // needs, with headroom, rather than letting the guard rail defeat the fit.
    if (z < cy.minZoom()) cy.minZoom(Math.max(0.01, z * 0.6));
    z = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), z));

    // Excluding labels stops the zoom feedback loop, but it also lets a caption on an
    // edge-most node hang off the viewport. One bounded correction: measure WITH
    // labels and shrink if that overflows — capped at 25%, which is what keeps the
    // loop from re-forming (a shrink this small cannot grow the labels enough to
    // demand another one).
    const lb = eles.boundingBox();
    if (lb.w > 0 && lb.h > 0) {
        const fit = Math.min(availW / lb.w, availH / lb.h);
        if (fit < z) z = Math.max(z * 0.75, Math.max(cy.minZoom(), fit));
    }

    // Centre on the caption-inclusive box so the shrink actually buys margin on the
    // side that overflowed, rather than symmetric margin on both.
    const cbb = (lb.w > 0 && lb.h > 0) ? lb : bb;
    const pan = {
        x: gl + pad + (availW - cbb.w * z) / 2 - cbb.x1 * z,
        y: pad + (availH - cbb.h * z) / 2 - cbb.y1 * z,
    };
    return { z, pan };
}

function _frameGraph(pad) {
    const f = _computeFrame(pad);
    if (!f) return;

    // A big jump is applied instantly, for two reasons. Visually, easing a 5x zoom
    // change over 320ms reads as a lurch rather than as a transition. Mechanically,
    // a long-running camera animation is a window in which anything that calls
    // refitGraph again — a resize observer, a layout stop, a focus switch — cancels
    // it with cy.stop() and leaves the camera stranded partway. Switching layout mode
    // does exactly that, which is how dagre ended up showing a corner of itself.
    const ratio = f.z / (cy.zoom() || f.z);
    if (ratio < 0.7 || ratio > 1.45) {
        cy.zoom(f.z);
        cy.pan(f.pan);
        scheduleGlow();
        return;
    }

    cy.animate({ zoom: f.z, pan: f.pan }, {
        duration: 320,
        easing: 'ease-out',
        // The glow layer sizes itself from cy.width() and only repaints when it is
        // marked dirty. If nothing marks it after the camera settles, it keeps both a
        // stale size and stale content — bloom, dials and pulses drawn for where the
        // nodes USED to be, clipped to how wide the canvas USED to be. An ambient
        // animation used to hide this by repainting every frame; with the loop back to
        // pure dirty-flag scheduling, the repaint has to be asked for explicitly.
        complete: () => scheduleGlow(),
    });
    scheduleGlow();
}

// ---- Label de-collision -----------------------------------------------------
// Cytoscape draws every label at the same fixed offset under its node, so two
// nodes a few pixels apart print their captions straight through each other —
// which is exactly what a force layout produces in its dense core. Nothing in the
// spacing parameters fixes this: the dots have room, the *text* does not.
//
// So place the labels ourselves. Walk the labelled nodes in order of importance
// (a claim outranks a hub, a hub outranks a leaf), try a short ladder of offsets
// below then above the node, and take the first that lands clear of everything
// already placed. A label with nowhere to go is dropped rather than drawn over a
// more important one — hovering the node still shows it in the tooltip.
//
// All arithmetic is in model coordinates: cytoscape scales font size with zoom,
// so a layout that is collision-free at one zoom is collision-free at all of them.
// Ordered by how close the caption stays to its node. Sideways slots come before
// the far vertical ones: a label beside a dot still reads as belonging to it,
// whereas one pushed 30 units below looks like it belongs to nothing.
const LABEL_SLOTS = [
    { valign: 'bottom', halign: 'center', dy: 5, dx: 0 },
    { valign: 'top', halign: 'center', dy: -5, dx: 0 },
    { valign: 'center', halign: 'right', dy: 0, dx: 7 },
    { valign: 'center', halign: 'left', dy: 0, dx: -7 },
    { valign: 'bottom', halign: 'center', dy: 17, dx: 0 },
    { valign: 'top', halign: 'center', dy: -17, dx: 0 },
];

function _labelBox(n, slot, zoom) {
    const isVerdict = n.hasClass('verdict-node');
    const maxW = isVerdict ? 190 : 120;
    const text = String(n.data('label') || '');
    // The declared font-size is not what gets drawn. min-zoomed-font-size holds the
    // label at a readable *screen* size as you zoom out, which means its footprint in
    // model space grows as 1/zoom — at zoom 1.0 a .hubcore caption is 13px, not the 9
    // it is declared at, so boxes computed from the declared size under-reported by
    // 44% and collisions slipped straight through the solver.
    const declared = isVerdict ? 10 : 9;
    const floor = isVerdict ? 4 : 13;          // the min-zoomed-font-size in organicStyle()
    const z = zoom || (cy ? cy.zoom() : 1) || 1;
    const font = Math.max(declared, floor / z);
    // 0.55em average advance for the UI stack at these sizes; the ellipsis wrap
    // means we never need to model more than one line.
    const w = Math.min(maxW * (font / declared), Math.max(18, text.length * font * 0.55));
    const h = font * 1.25;
    const pos = n.position();
    const r = (n.data('_sz') || 12) / 2;
    let cx0 = pos.x, cy0 = pos.y;
    if (slot.valign === 'bottom') cy0 = pos.y + r + slot.dy + h / 2;
    else if (slot.valign === 'top') cy0 = pos.y - r + slot.dy - h / 2;
    if (slot.halign === 'right') cx0 = pos.x + r + slot.dx + w / 2;
    else if (slot.halign === 'left') cx0 = pos.x - r + slot.dx - w / 2;
    // A little slack so labels don't merely touch.
    return { x1: cx0 - w / 2 - 3, x2: cx0 + w / 2 + 3, y1: cy0 - h / 2 - 2, y2: cy0 + h / 2 + 2 };
}

function _boxesHit(a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function declutterLabels(targetZoom) {
    if (!cy || !organicMode) return;
    const z = targetZoom || cy.zoom() || 1;
    // Start from a clean slate: these three properties are the only ones this pass
    // sets inline, and a node that stops being a hub must not keep a stale offset
    // or an opacity of 0 from a previous run.
    cy.nodes().removeStyle('text-valign text-halign text-margin-y text-margin-x text-opacity');

    const labelled = cy.nodes('.hubcore, .verdict-node')
        .filter(n => !n.hasClass('cluster-label') && !n.hasClass('summary-node'));
    if (labelled.length === 0) return;

    // Importance: verdicts first (they are the answer), then by degree, then by a
    // stable id tiebreak so the same graph declutters the same way every load.
    const ranked = labelled.toArray().sort((a, b) => {
        const av = a.hasClass('verdict-node') ? 1 : 0;
        const bv = b.hasClass('verdict-node') ? 1 : 0;
        if (av !== bv) return bv - av;
        if (a.degree() !== b.degree()) return b.degree() - a.degree();
        return a.id() < b.id() ? -1 : 1;
    });

    // Node discs are obstacles too — a caption printed across a neighbouring dot is
    // just as unreadable as one printed across another caption.
    const placed = cy.nodes().map(n => {
        const p = n.position(), r = (n.data('_sz') || 12) / 2;
        return { x1: p.x - r, x2: p.x + r, y1: p.y - r, y2: p.y + r };
    });

    let dropped = 0;
    ranked.forEach(n => {
        let chosen = null;
        for (const slot of LABEL_SLOTS) {
            const box = _labelBox(n, slot, z);
            if (!placed.some(b => _boxesHit(box, b))) { chosen = { slot, box }; break; }
        }
        if (chosen) {
            n.style({
                'text-valign': chosen.slot.valign,
                'text-halign': chosen.slot.halign,
                'text-margin-y': chosen.slot.dy,
                'text-margin-x': chosen.slot.dx,
                'text-opacity': n.hasClass('verdict-node') ? 0.95 : 0.85,
            });
            placed.push(chosen.box);
        } else {
            // Nowhere clear. Verdicts are never dropped — they are the point of the
            // graph — so the last resort is to let one overlap rather than vanish.
            if (n.hasClass('verdict-node')) {
                const slot = LABEL_SLOTS[0];
                n.style({
                    'text-valign': slot.valign, 'text-halign': slot.halign,
                    'text-margin-y': slot.dy, 'text-margin-x': slot.dx, 'text-opacity': 0.95,
                });
                placed.push(_labelBox(n, slot, z));
            } else {
                n.style('text-opacity', 0);
                dropped++;
            }
        }
    });
    if (dropped) _setLabelDropNote(dropped);
    else _setLabelDropNote(0);
}

// Tell the user when captions were withheld, so a missing label reads as a
// deliberate decision rather than a bug. Zooming is the remedy, and the tooltip
// always has the full text.
function _setLabelDropNote(count) {
    const el = document.getElementById('label-drop-note');
    if (!el) return;
    if (!count) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = `${count} label${count === 1 ? '' : 's'} hidden to avoid overlap — hover a node to read it`;
}

// ---- Layout focus: Graph / Split / Panels ----
// Shown to the user as the window switch. Not to be confused with the Focus view
// (setFocusView, at the end of this file), which is a different drawing of the graph.
// Three-column is right for exploring, but a dense graph wants the whole window and a
// long report wants reading width. Collapsing by width (rather than opening a modal)
// keeps the transition continuous, and Split is always one click back so no mode is a
// trap. Persisted per browser because it is a workspace preference, not task state.
const FOCUS_MODES = ['graph', 'split', 'panels'];
let focusMode = 'split';

function setFocusMode(mode, { persist = true } = {}) {
    if (!FOCUS_MODES.includes(mode)) mode = 'split';
    focusMode = mode;
    document.body.classList.toggle('focus-graph', mode === 'graph');
    document.body.classList.toggle('focus-panels', mode === 'panels');
    FOCUS_MODES.forEach(m => {
        const b = document.getElementById('focus-' + m);
        if (b) b.setAttribute('aria-pressed', String(m === mode));
    });
    if (persist) {
        try { localStorage.setItem('aivis.focusMode', mode); } catch (e) { /* private mode */ }
    }
    // Cytoscape caches the canvas size, so it must be told after the width animation
    // finishes or the graph renders into stale bounds.
    // The canvas is about to change shape, so re-measure and re-frame once the
    // width transition has finished.
    refitGraph({ delay: 380 });
}

// Resizing the window has the same consequence as switching focus mode: the
// canvas changes shape and cytoscape is still holding the old dimensions.
function initCanvasResize() {
    window.addEventListener('resize', () => refitGraph({ delay: 240 }));

    // A focus-mode switch changes the canvas width without a window resize, so watch
    // the element rather than the window. Both overlay canvases size themselves from
    // cy.width(); if neither is asked to repaint, they stay the old width and clip.
    const area = document.querySelector('.graph-area');
    if (area && typeof ResizeObserver === 'function') {
        // Route through refitGraph rather than calling cy.resize() here. The observer
        // fires on every frame of the focus-mode width transition, and resizing the
        // viewport without re-framing leaves the camera pointing at empty space; the
        // debounce inside refitGraph collapses the whole transition into one correct
        // measure-and-frame at the end of it.
        new ResizeObserver(() => refitGraph({ delay: 260 })).observe(area);
    }
}

function initFocusModes() {
    FOCUS_MODES.forEach(m => {
        const b = document.getElementById('focus-' + m);
        if (b) b.addEventListener('click', () => setFocusMode(m));
    });
    // ?focus=graph pins the mode for a shared link or a screenshot without
    // clobbering whatever this browser normally prefers.
    let initial = null;
    try { initial = new URLSearchParams(location.search).get('focus'); } catch (e) { /* ignore */ }
    if (FOCUS_MODES.includes(initial)) {
        setFocusMode(initial, { persist: false });
        return;
    }
    let saved = 'split';
    try { saved = localStorage.getItem('aivis.focusMode') || 'split'; } catch (e) { /* ignore */ }
    setFocusMode(saved, { persist: false });
}

// ---- SSE live updates ----
// Byte offset of the last event we actually applied. The server stamps every frame
// with `id: <offset>`; handing it back on reconnect replays exactly what we missed
// while disconnected. Without it, a laptop sleep or proxy timeout silently dropped
// every event in the gap and the graph stayed wrong until someone hit F5.
let _lastEventId = null;
let _sseRetries = 0;

function setConnState(state, detail) {
    const el = document.getElementById('conn-status');
    if (!el) return;
    const label = { live: 'live', reconnecting: 'reconnecting…', offline: 'offline' }[state] || state;
    el.dataset.state = state;
    el.textContent = label;
    el.title = detail || `Event stream: ${label}`;
}

function initSSE() {
    // Resume from where we stopped; on a cold start tail from the current end (the
    // full graph arrives over HTTP via loadGraph, so there is nothing to replay).
    const url = _lastEventId === null
        ? `${API_BASE}/events-stream`
        : `${API_BASE}/events-stream?from_offset=${encodeURIComponent(_lastEventId)}`;
    let es = new EventSource(url);

    es.onopen = () => {
        _sseRetries = 0;
        setConnState('live');
    };

    es.onmessage = (event) => {
        try {
            if (_replay.active) {
                // The canvas is showing the past; apply the present when replay ends.
                _replay.missedLive = true;
                if (event.lastEventId) _lastEventId = Number(event.lastEventId);
                return;
            }
            const element = JSON.parse(event.data);
            handleSSEEvent(element);   // idempotent: skips ids already in the graph
            if (event.lastEventId) _lastEventId = Number(event.lastEventId);
            setConnState('live');
        } catch (e) {
            // Ignore parse errors (e.g. keepalive comments)
        }
    };

    es.onerror = () => {
        es.close();
        _sseRetries += 1;
        setConnState(_sseRetries >= 3 ? 'offline' : 'reconnecting',
            _sseRetries >= 3 ? 'Cannot reach the server — is it still running?' : null);
        // Back off 3s → 30s so a stopped server does not spin the tab.
        setTimeout(initSSE, Math.min(3000 * _sseRetries, 30000));
    };
}

// ---- Right panel: live activity log of how the network evolves ----
// Every string here can come from an agent POSTing to /events — treat it as hostile.
// Quotes are escaped too so the same helper is safe inside a quoted attribute.
function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function logActivity(kind, msg, color, nodeId) {
    const log = document.getElementById('activity-log');
    if (!log) return;
    const empty = log.querySelector('.activity-empty');
    if (empty) empty.remove();
    const t = new Date();
    const hms = [t.getHours(), t.getMinutes(), t.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
    const item = document.createElement('div');
    item.className = `activity-item act-${kind}`;
    item.innerHTML = `<span class="activity-dot" style="background:${color || '#A89984'}"></span>`
        + `<span class="activity-time">${hms}</span>`
        + `<span class="activity-msg">${msg}</span>`;
    if (nodeId) {
        item.dataset.nodeId = nodeId;
        item.classList.add('act-clickable');
        item.addEventListener('click', () => _focusNode(nodeId));
    }
    log.prepend(item);
    while (log.children.length > 220) log.removeChild(log.lastChild);
    _noteActivityWhileFolded(kind);
}

// Click an activity row → select + center its node, like clicking it in the graph.
function _focusNode(id) {
    if (!cy) return;
    const n = cy.getElementById(id);
    if (!n || n.empty()) return;
    if (typeof showDetail === 'function') showDetail(n.data());
    if (typeof highlightLineage === 'function') highlightLineage(id);
    if (_fvPin(id)) return;
    cy.animate({ center: { eles: n }, duration: 300, easing: 'ease-out' });
}

// A short, informative detail line per node type (pulled from the event payload).
function _nodeActivityDetail(d) {
    const clip = (s, n) => {
        s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    };
    const num = (v) => (typeof v === 'number' && Number.isInteger(v)) ? v
        : (typeof v === 'number' ? +v.toFixed(2) : v);
    const nt = d.node_type;
    if (nt === 'result' && d.metrics && typeof d.metrics === 'object') {
        return Object.entries(d.metrics).slice(0, 4).map(([k, v]) => `${k}=${num(v)}`).join(', ');
    }
    if (nt === 'claim') {
        const txt = clip(d.claim_text, 96);
        const conf = (d.credibility_score != null) ? ` · cred ${Math.round(d.credibility_score * 100)}%`
            : (d.confidence != null ? ` · conf ${Math.round(d.confidence * 100)}%` : '');
        return txt + conf;
    }
    if (nt === 'run') {
        const bits = [];
        if (d.duration_seconds != null) bits.push(`${num(d.duration_seconds)}s`);
        if (d.environment && typeof d.environment === 'object') bits.push(Object.values(d.environment).join(', '));
        else if (d.git_commit) bits.push(String(d.git_commit).slice(0, 7));
        return bits.join(' · ');
    }
    if (nt === 'artifact') return [d.artifact_type, clip(d.path, 44)].filter(Boolean).join(' · ');
    if (nt === 'conclusion') {
        const head = clip((d.conclusion_text || '').split('\n')[0], 80);
        const rc = Array.isArray(d.result_ids) ? ` · ${d.result_ids.length} results` : '';
        const cr = (d.credibility_score != null) ? ` · avg cred ${Math.round(d.credibility_score * 100)}%` : '';
        return head + rc + cr;
    }
    if (nt === 'facts') return clip(d.fact_text || d.source, 96);
    return clip(d.description || d.scope || d.methodology || d.null_hypothesis, 90);  // framing nodes
}

// Build one activity row from a node's data (shared by SSE + initial seeding).
function _logNodeActivity(d) {
    const nt = d.node_type;
    const detail = _nodeActivityDetail(d);
    let msg = `<b>${_esc(NODE_TYPE_LABELS[nt] || nt)}</b> · ${_esc(d.label || d.id)}`;
    if (detail) msg += `<span class="activity-detail">${_esc(detail)}</span>`;
    logActivity('node', msg, NODE_TYPE_COLORS[nt] || '#A89984', d.id);
}

// On first load, fill the panel with the existing nodes' info (newest on top).
let _activitySeeded = false;
function _seedActivityFromGraph() {
    if (!cy) return;
    const nodes = cy.nodes().filter(n => !n.hasClass('cluster-label')).toArray();
    nodes.sort((a, b) => {
        const ta = a.data('created_at') || '', tb = b.data('created_at') || '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;   // oldest first → newest ends on top
    });
    nodes.forEach(n => _logNodeActivity(n.data()));
}

// ---- Bottom File panel: a clicked node's file info + content + open-folder ----
let _currentFilePath = null;

function _nodeInlineContent(d) {
    if (d.fact_text) return d.fact_text;
    if (d.claim_text) return d.claim_text;
    if (d.conclusion_text) return d.conclusion_text;
    if (d.metrics && typeof d.metrics === 'object' && Object.keys(d.metrics).length) {
        return Object.entries(d.metrics).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
    return d.description || d.scope || d.methodology || d.source || '(no content)';
}

async function showNodeFile(d) {
    const titleEl = document.getElementById('file-panel-title');
    const bodyEl = document.getElementById('file-panel-body');
    const openBtn = document.getElementById('file-open');
    if (!bodyEl || !titleEl) return;
    _currentFilePath = null;
    if (openBtn) openBtn.disabled = true;

    const path = d.source || d.path || d.result_file || '';
    const looksLikePath = /[\/\\]/.test(path) && /\.[A-Za-z0-9]{1,8}$/.test(path);
    const inlineFallback = () => {
        titleEl.textContent = `${NODE_TYPE_LABELS[d.node_type] || d.node_type} · ${d.label || d.id}`;
        bodyEl.innerHTML = `<pre class="file-content">${_esc(_nodeInlineContent(d))}</pre>`;
    };

    if (!looksLikePath) { inlineFallback(); return; }

    titleEl.textContent = path.split(/[\/\\]/).pop();
    bodyEl.innerHTML = '<div class="file-meta">loading…</div>';
    try {
        const r = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
        const f = await r.json();
        if (f.exists) {
            _currentFilePath = f.path;
            if (openBtn) openBtn.disabled = false;
            const kb = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`;
            bodyEl.innerHTML =
                `<div class="file-meta">${_esc(f.dir)} · ${_esc(kb)}${f.truncated ? ' · truncated' : ''}</div>`
                + `<pre class="file-content">${_esc(f.content)}</pre>`;
            return;
        }
        // node references a path that isn't on disk → show its inline content + the path
        bodyEl.innerHTML = `<div class="file-meta">${_esc(path)} (not on disk)</div>`
            + `<pre class="file-content">${_esc(_nodeInlineContent(d))}</pre>`;
    } catch (e) {
        inlineFallback();
        console.error('file read failed', e);
    }
}

async function revealCurrentFile() {
    if (!_currentFilePath) return;
    const btn = document.getElementById('file-open');
    const orig = btn ? btn.textContent : '';
    const flash = (t) => { if (btn) { btn.textContent = t; setTimeout(() => { btn.textContent = orig; }, 1600); } };
    try {
        const r = await fetch('/api/fs/reveal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: _currentFilePath }),
        });
        const d = await r.json().catch(() => ({}));
        flash(r.ok ? 'Opened ✓' : 'Failed');
        if (r.ok && d.folder) {
            const meta = document.querySelector('#file-panel-body .file-meta');
            if (meta) meta.textContent = `opened: ${d.folder}`;
        }
    } catch (e) {
        flash('Failed');
        console.error('reveal failed', e);
    }
}

function clearActivityLog() {
    const log = document.getElementById('activity-log');
    if (log) log.innerHTML = '<div class="activity-empty">Waiting for network events…</div>';
}

function handleSSEEvent(element) {
    const id = element.data && element.data.id;
    if (!id) return;
    _fvRefresh();

    // Handle node update (file modified) — pulse flash node + edges
    if (element.group === 'updated') {
        logActivity('update', `updated <b>${_esc(element.data.label || id)}</b>`, '#FABD2F');
        const existing = cy.getElementById(id);
        if (existing.length > 0) {
            // Update data fields if provided
            const data = element.data;
            if (data.label) existing.data('label', data.label);
            if (data.metrics) existing.data('metrics', data.metrics);

            // Organic mode: a supernova bloom (expanding shockwave + core flash)
            // rendered on the glow overlay, instead of a border/size animation.
            if (organicMode) {
                supernova.set(id, { t0: performance.now(), dur: 1400 });
                scheduleGlow();
                existing.connectedEdges().addClass('highlighted');
                setTimeout(() => existing.connectedEdges().removeClass('highlighted'), 1400);
                // The bloom says something changed here; the wave says what it reaches.
                // A result whose metrics move is only interesting because of the claim
                // downstream of it, and that is the thing to watch.
                flowFromChange(id, 'update');
                return;
            }

            // Pulse node: bright flash with size burst, then fade back
            const origColor = existing.data('color');
            const origW = existing.numericStyle('width') || 40;
            const origH = existing.numericStyle('height') || 40;
            const burstW = Math.round(origW * 1.3);
            const burstH = Math.round(origH * 1.3);
            existing.stop(true);
            existing.style({
                'border-color': '#FABD2F',
                'border-width': 8,
                'border-opacity': 1,
                'background-color': '#FABD2F',
                'width': burstW,
                'height': burstH,
                'z-index': 20,
            });
            existing.animate(
                { style: {
                    'border-width': 8, 'border-color': '#FABD2F', 'border-opacity': 1,
                    'background-color': '#FABD2F', 'width': burstW, 'height': burstH,
                } },
                { duration: 800 }
            ).animate(
                { style: {
                    'border-width': 2, 'border-color': origColor, 'border-opacity': 0.5,
                    'background-color': existing.data('color'), 'width': origW, 'height': origH,
                    'z-index': 0,
                } },
                { duration: 1600 }
            );

            // Pulse connected edges: brighten then fade back
            existing.connectedEdges().forEach(edge => {
                const edgeOrigColor = edge.data('color');
                edge.stop(true);
                edge.style({
                    'line-color': '#FABD2F',
                    'target-arrow-color': '#FABD2F',
                    'width': 5,
                });
                edge.animate(
                    { style: { 'line-color': '#FABD2F', 'target-arrow-color': '#FABD2F', 'width': 5 } },
                    { duration: 800 }
                ).animate(
                    { style: { 'line-color': edgeOrigColor, 'target-arrow-color': edgeOrigColor, 'width': 2 } },
                    { duration: 1600 }
                );
            });
        }
        return;
    }

    // Handle node deletion — full graph refresh
    if (element.group === 'removed') {
        logActivity('system', `removed <b>${_esc(id)}</b>`, '#CC241D');
        loadGraph();
        return;
    }

    // Skip if element already exists
    if (cy.getElementById(id).length > 0) return;

    // Add element
    cy.add(element);
    setGraphEmpty(false);   // first node to arrive clears the "nothing here yet" panel
    const el = cy.getElementById(id);
    // log to the activity panel
    if (element.group === 'edges' || (element.data && element.data.source)) {
        const et = element.data.edge_type || 'edge';
        logActivity('edge', `${_esc(et)}: ${_esc(element.data.source)} → ${_esc(element.data.target)}`, '#665c54');
    } else {
        _logNodeActivity(element.data);
    }
    if (organicMode && el.nonempty()) {
        // Size/tint the newcomer immediately so it never flashes at the big
        // default fallback size before the (debounced) layout sizes it.
        applyDegreeScaling();
        // Place it at its seed position now, so the upcoming layout glides it
        // from there instead of teleporting it out of the center.
        _seedOrganicPositions();
        if (el.isNode()) {
            // Obsidian-style entrance: scale-pop with a slight overshoot, then settle,
            // plus a soft bloom ripple at the newcomer.
            const targetW = el.numericStyle('width') || 16;
            const seed = Math.max(2, targetW * 0.18);
            el.stop(true);
            el.style({ 'opacity': 0, 'width': seed, 'height': seed });
            el.animate(
                { style: { 'opacity': 1, 'width': targetW * 1.22, 'height': targetW * 1.22 } },
                { duration: 240, easing: 'ease-out-cubic' }
            ).animate(
                { style: { 'width': targetW, 'height': targetW } },
                { duration: 240, easing: 'ease-in-out-sine',
                  complete: () => { el.removeStyle('opacity'); el.removeStyle('width'); el.removeStyle('height'); } }
            );
            // soft expanding ripple bloom on birth
            supernova.set(id, { t0: performance.now(), dur: 1100, birth: true });
            scheduleGlow();
            // ...and then send it onward, so a graph being built reads as evidence
            // arriving and moving rather than as dots appearing in place.
            flowFromChange(id, 'arrival');
            // draw the newcomer's edges in (fade + a brief brighten)
            el.connectedEdges().forEach(edge => {
                edge.stop(true);
                edge.style('opacity', 0);
                edge.animate(
                    { style: { 'opacity': 0.6 } },
                    { duration: 520, easing: 'ease-out', complete: () => edge.removeStyle('opacity') }
                );
            });
        }
    }
    updateStatsFromGraph();   // climb the footer counts live

    _scheduleLayout();
}

function _scheduleLayout() {
    // Debounced layout re-run (800ms after last new element).
    // In organic mode this is an INCREMENTAL relayout: settled nodes stay put and
    // only new arrivals glide into place (no full re-randomize → no flipping).
    if (_layoutTimer) clearTimeout(_layoutTimer);
    _layoutTimer = setTimeout(() => {
        runLayout(organicMode);
        _layoutTimer = null;
    }, 800);
}

// ---- F4: Degree-scaled node size ----

// ---- Edge visual channels ---------------------------------------------------
// The server computes, per edge, a relationship colour and the *policy* that created
// it. In the organic view only one of them is drawn at rest:
//   dash       -> policy          (declared by an agent, or inferred by a heuristic)
//   hue        -> edge_type       (motivates / tests / ...), on hover, with the arrow
//
// Resting edges used to carry the hue too, plus a fade from the background for
// direction and weight + opacity + dash for provenance. Five cues on every line made
// the mesh louder than the nodes, so the rest state is a grey hairline (PAL.edgeRest)
// and the stylesheet reads only the two values seeded here.
// One owner for the declared/inferred question. Strict equality, no coalescing: an
// edge whose policy we cannot account for must read as a guess, never as an assertion.
function _edgeDeclared(e) {
    return e.data('policy') === 'manual';
}

function applyEdgeChannels() {
    if (!cy || !organicMode) return;
    cy.edges().forEach(e => {
        // The hover hue, also the colour of the particles and the lineage pulse.
        e.data('_etint', _tintHex(e.data('color') || '#9aa1ad', PAL.edgeTint));
        // An asserted edge is evidence; an inferred one is a guess the tool made,
        // and is dashed.
        e.data('_edeclared', _edgeDeclared(e));
    });
}

function applyDegreeScaling() {
    if (!cy) return;
    // How connected a node must be before it earns a permanent label. A fixed
    // threshold of 4 labelled roughly half an 83-node graph and the filenames piled
    // on top of each other; scaling it with graph size keeps small graphs fully
    // annotated and dense ones readable. Verdict nodes bypass this entirely.
    applyEdgeChannels();
    const _n = cy.nodes().length;
    const labelDegree = _n <= 25 ? 3 : (_n <= 60 ? 5 : 8);
    cy.nodes().forEach(n => {
        if (n.hasClass('cluster-label') || n.hasClass('summary-node')) return;
        const deg = n.degree();

        if (organicMode) {
            // Borderless cosmic dots: size + brightness scale with degree.
            const _ct0 = n.data('node_type');
            let _sz = Math.min(46, 5 + Math.sqrt(deg) * 7);         // 5px leaf … 46px hub
            // A claim or a conclusion is the answer, and most of them are leaves — the
            // pure degree ramp made the most important nodes the smallest ones, and
            // left no room on their faces for the credibility dial.
            if (_ct0 === 'claim' || _ct0 === 'conclusion') _sz = Math.max(_sz, 28);
            n.data('_sz', _sz);
            n.data('_rim', _sz >= 16 ? 2.5 : (_sz >= 9 ? 1.5 : 0));
            n.data('_bri', Math.min(1, 0.62 + deg * 0.06));         // 0.62 leaf … 1.0 hub
            // Tint: keep the calm register, but the hue has to actually survive. Two
            // effects compound here — greying the colour AND dropping opacity over a
            // near-black canvas — so a leaf at the old 0.55/0.35 pair kept about 15%
            // of its hue and the ten-colour legend described something you couldn't
            // see. 0.32 leaves the palette muted without erasing it.
            let tint = _tintHex(n.data('color') || '#9aa0a8', PAL.nodeTint);
            const _ct = n.data('node_type');
            const _isVerdict = (_ct === 'claim' || _ct === 'conclusion');
            if (credibilityMode && _isVerdict) {
                const s = n.data('credibility_score');
                if (s != null) {
                    // Credibility view exists to show colour. Desaturating it to 0.45
                    // made green and red indistinguishable, which defeated the mode.
                    tint = _tintHex(_credColor(s), 0.10);
                }
            }
            n.data('_tint', tint);
            // Reveal labels for hubs AND for anything that states a verdict — a claim
            // is the point of the graph, and most claims are leaves (degree 1-2), so a
            // pure degree rule left them anonymous.
            n.toggleClass('hubcore', deg >= labelDegree || _isVerdict);
            n.toggleClass('verdict-node', _isVerdict);
            if (_isVerdict) {
                // How the evidence UNDER this verdict got here: 0 all declared,
                // 1 mixed, 2 all inferred. Same _edgeDeclared as the edges use, so a
                // dial and the lines feeding it can never disagree about doubt.
                const inc = n.incomers('edge');
                let dec = 0, tot = 0;
                inc.forEach(e => { tot++; if (_edgeDeclared(e)) dec++; });
                n.data('_prov', tot === 0 ? 2 : (dec === tot ? 0 : (dec === 0 ? 2 : 1)));
            }
        } else {
            const size = Math.min(58, Math.max(36, 32 + deg * 3));
            n.style({ 'width': size, 'height': size });
        }
    });
}

// ---- F5: Minimap ----
function initMinimap() {
    minimapCanvas = document.getElementById('minimap');
    if (!minimapCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    minimapCanvas.width = 180 * dpr;
    minimapCanvas.height = 120 * dpr;
    minimapCanvas.style.width = '180px';
    minimapCanvas.style.height = '120px';
    minimapCtx = minimapCanvas.getContext('2d');
    minimapCtx.scale(dpr, dpr);

    minimapCanvas.addEventListener('click', (e) => {
        const rect = minimapCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        panToMinimapPoint(x, y);
    });
}

function drawMinimap() {
    if (!minimapCtx || !cy) return;
    const W = 180, H = 120;
    minimapCtx.clearRect(0, 0, W, H);

    // Draw background
    minimapCtx.fillStyle = organicMode ? PAL.ground : PAL.groundAlt;
    minimapCtx.fillRect(0, 0, W, H);

    const visibleNodes = cy.nodes().filter(n => n.style('display') !== 'none' && !n.hasClass('cluster-label'));
    if (visibleNodes.empty()) return;

    const bb = visibleNodes.boundingBox();
    const pad = 20;
    const bw = bb.w + pad * 2 || 1;
    const bh = bb.h + pad * 2 || 1;
    const scale = Math.min(W / bw, H / bh);
    const ox = (W - bw * scale) / 2 - (bb.x1 - pad) * scale;
    const oy = (H - bh * scale) / 2 - (bb.y1 - pad) * scale;

    // Draw node dots
    visibleNodes.forEach(n => {
        const pos = n.position();
        const color = (organicMode ? n.data('_tint') : n.data('color')) || '#A89984';
        const deg = n.degree();
        const r = Math.max(2, 1.5 + deg * 0.3);
        minimapCtx.fillStyle = color;
        minimapCtx.beginPath();
        minimapCtx.arc(pos.x * scale + ox, pos.y * scale + oy, r, 0, Math.PI * 2);
        minimapCtx.fill();
    });

    // Draw viewport rectangle
    const ext = cy.extent();
    const vx = ext.x1 * scale + ox;
    const vy = ext.y1 * scale + oy;
    const vw = ext.w * scale;
    const vh = ext.h * scale;
    minimapCtx.strokeStyle = '#458588';
    minimapCtx.lineWidth = 1.5;
    minimapCtx.strokeRect(vx, vy, vw, vh);

    // Store mapping for click handler
    minimapCanvas._mapScale = scale;
    minimapCanvas._mapOx = ox;
    minimapCanvas._mapOy = oy;
}

function panToMinimapPoint(mx, my) {
    if (!minimapCanvas._mapScale) return;
    const scale = minimapCanvas._mapScale;
    const ox = minimapCanvas._mapOx;
    const oy = minimapCanvas._mapOy;
    const graphX = (mx - ox) / scale;
    const graphY = (my - oy) / scale;
    cy.animate({ center: { eles: cy.nodes().first() }, duration: 0 });
    cy.pan({
        x: cy.width() / 2 - graphX * cy.zoom(),
        y: cy.height() / 2 - graphY * cy.zoom(),
    });
}

// ---- F6: Swimlane bands ----
function drawSwimlanes() {
    const canvas = document.getElementById('swimlanes');
    if (!canvas || !cy) return;
    // Swimlanes are a hierarchy/timeline affordance; hide them in organic mode.
    if (organicMode) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const visibleNodes = cy.nodes().filter(n =>
        n.style('display') !== 'none' && !n.hasClass('cluster-label') && !n.hasClass('summary-node')
    );
    if (visibleNodes.empty()) return;

    // Group by node_type
    const groups = {};
    visibleNodes.forEach(n => {
        const type = n.data('node_type');
        if (!type || type === '_cluster_label') return;
        if (!groups[type]) groups[type] = [];
        groups[type].push(n);
    });

    const pad = 25;
    ctx.font = '11px Inter, sans-serif';

    // Build band geometry per node type (rendered coords).
    const bands = Object.entries(groups).map(([type, nodes]) => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            const rp = n.renderedPosition();
            const w = n.renderedWidth ? n.renderedWidth() / 2 : 20;
            const h = n.renderedHeight ? n.renderedHeight() / 2 : 20;
            if (rp.x - w < minX) minX = rp.x - w;
            if (rp.x + w > maxX) maxX = rp.x + w;
            if (rp.y - h < minY) minY = rp.y - h;
            if (rp.y + h > maxY) maxY = rp.y + h;
        });
        return {
            type, color: NODE_TYPE_COLORS[type] || '#A89984',
            label: NODE_TYPE_LABELS[type] || type, minX, maxX, minY, maxY,
        };
    });

    // Pass 1 — band fills.
    bands.forEach(b => {
        ctx.fillStyle = b.color;
        ctx.globalAlpha = 0.05;
        if (timelineMode) {
            ctx.fillRect(0, b.minY - pad, canvas.width, (b.maxY - b.minY) + pad * 2);
        } else {
            ctx.fillRect(b.minX - pad, 0, (b.maxX - b.minX) + pad * 2, canvas.height);
        }
    });

    // Pass 2 — labels with collision dodging. In dagre LR (and occasionally
    // timeline) several node types land in the same column/lane, so their
    // labels would print on top of each other. Stack colliding labels into
    // successive rows/columns instead of overprinting.
    const rows = [];   // rows[i] = occupied [start,end] intervals along the primary axis
    const placeRow = (start, end) => {
        for (let r = 0; ; r++) {
            if (!rows[r]) rows[r] = [];
            if (!rows[r].some(([s, e]) => start < e && end > s)) { rows[r].push([start, end]); return r; }
        }
    };
    const lineH = 13;

    if (timelineMode) {
        // Labels anchored at the left, at each band's vertical position;
        // dodge horizontally only when two lanes share the same Y slot.
        bands.sort((a, b) => a.minY - b.minY);
        bands.forEach(b => {
            const y = (b.minY - pad) + 13;
            const tw = ctx.measureText(b.label).width;
            const row = placeRow(y - 11, y + 2);
            _drawBandLabel(ctx, b.label, b.color, 8 + row * (tw + 14), y);
        });
    } else {
        // Labels anchored at the top of each column; dodge vertically when
        // their X-ranges overlap (the dagre overlap the user reported).
        bands.sort((a, b) => a.minX - b.minX);
        bands.forEach(b => {
            const xs = (b.minX - pad) + 5;
            const xe = xs + ctx.measureText(b.label).width + 10;
            const row = placeRow(xs, xe);
            _drawBandLabel(ctx, b.label, b.color, xs, 13 + row * lineH);
        });
    }
    ctx.globalAlpha = 1.0;
}

// Draw a swimlane label with a subtle dark backing so stacked, type-colored
// labels stay legible over the bands and nodes.
function _drawBandLabel(ctx, text, color, x, y) {
    const tw = ctx.measureText(text).width;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = PAL.bandBacking;
    ctx.fillRect(x - 3, y - 10, tw + 6, 13);
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}

// ---- F7: Collapsible branches ----
function collapseBranch(nodeId) {
    const root = cy.getElementById(nodeId);
    if (root.empty()) return;
    const successors = root.successors().nodes().filter(n => !n.hasClass('cluster-label'));
    if (successors.empty()) return;

    // Store the JSON for removed elements (nodes + their edges)
    const removedEles = successors.union(successors.connectedEdges());
    const removedJson = removedEles.jsons();

    // Compute centroid
    let cx = 0, cy_ = 0;
    successors.forEach(n => { cx += n.position('x'); cy_ += n.position('y'); });
    cx /= successors.length;
    cy_ /= successors.length;

    // Remove successors and their edges
    removedEles.remove();

    // Add summary node
    const summaryId = `_summary_${nodeId}`;
    cy.add({
        group: 'nodes',
        data: {
            id: summaryId,
            label: `${successors.length} nodes`,
            node_type: '_summary',
            color: '#504945',
        },
        classes: 'summary-node',
        position: { x: cx, y: cy_ },
    });

    // Add dotted edge from root to summary
    cy.add({
        group: 'edges',
        data: {
            id: `_summary_edge_${nodeId}`,
            source: nodeId,
            target: summaryId,
            color: '#7C6F64',
            line_style: 'dotted',
        },
    });

    collapsedNodes.set(nodeId, { removedJson, summaryNodeId: summaryId });
    drawMinimap();
}

function expandBranch(summaryNodeId) {
    // Find which root this summary belongs to
    let rootId = null;
    for (const [rid, info] of collapsedNodes.entries()) {
        if (info.summaryNodeId === summaryNodeId) {
            rootId = rid;
            break;
        }
    }
    if (!rootId) return;
    const info = collapsedNodes.get(rootId);

    // Remove summary node + edge
    cy.getElementById(summaryNodeId).remove();
    cy.getElementById(`_summary_edge_${rootId}`).remove();

    // Re-add stored elements
    cy.add(info.removedJson);

    collapsedNodes.delete(rootId);
    applyDegreeScaling();
    drawMinimap();
}

// ---- F8: Interactive cluster toggle ----
function toggleClusterCollapse(clusterId, labelNode) {
    if (collapsedClusters.has(clusterId)) {
        collapsedClusters.delete(clusterId);
    } else {
        collapsedClusters.add(clusterId);
    }

    // Update label arrow
    const baseLabel = labelNode.data('_clusterLabel') || labelNode.data('label').replace(/^[▼▶]\s*/, '');
    const arrow = collapsedClusters.has(clusterId) ? '▶ ' : '▼ ';
    labelNode.data('label', arrow + baseLabel);

    applyClusterVisibility();
}

function applyClusterVisibility() {
    // Find all cluster label IDs and their positions
    const clusterLabels = cy.nodes('.cluster-label');
    const clusterBounds = {};

    clusterLabels.forEach(label => {
        const id = label.data('id');
        clusterBounds[id] = label.position();
    });

    // For collapsed clusters, hide isolated artifacts near that cluster
    cy.nodes().forEach(n => {
        if (n.hasClass('cluster-label') || n.hasClass('summary-node')) return;
        if (n.data('node_type') !== 'artifact' || n.degree() > 0) return;

        // Find nearest cluster label
        const pos = n.position();
        let nearestCluster = null;
        let nearestDist = Infinity;
        for (const [cid, cpos] of Object.entries(clusterBounds)) {
            const dist = Math.abs(pos.x - cpos.x) + Math.abs(pos.y - cpos.y);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestCluster = cid;
            }
        }

        if (nearestCluster && collapsedClusters.has(nearestCluster)) {
            n.style('display', 'none');
        } else if (!hiddenNodeTypes.has(n.data('node_type'))) {
            n.style('display', 'element');
        }
    });
    drawMinimap();
}

// ---- F10: Timeline layout ----
function runTimelineLayout(elements) {
    const nodes = elements.nodes().filter(n => !n.hasClass('cluster-label'));
    if (nodes.empty()) return;

    // Parse timestamps and assign X position
    const timestamps = [];
    nodes.forEach(n => {
        const ts = n.data('created_at');
        timestamps.push(ts ? new Date(ts).getTime() : 0);
    });

    const minT = Math.min(...timestamps.filter(t => t > 0)) || 0;
    const maxT = Math.max(...timestamps) || 1;
    const timeRange = maxT - minT || 1;

    // Assign Y lanes by node_type
    const typeOrder = Object.keys(NODE_TYPE_LABELS);
    const laneSpacing = 100;
    const minNodeGap = 60;  // minimum horizontal gap between nodes in same lane
    const xSpread = Math.max(800, nodes.length * 40);  // wider for more nodes

    // Group nodes by lane and sort by timestamp within each lane
    const laneNodes = new Map();  // lane index → [{node, ts, x}]
    nodes.forEach((n, i) => {
        const ts = timestamps[i];
        const t = ts > 0 ? ts : minT;
        const x = 50 + ((t - minT) / timeRange) * xSpread;
        const lane = typeOrder.indexOf(n.data('node_type'));
        const laneIdx = lane >= 0 ? lane : typeOrder.length;
        if (!laneNodes.has(laneIdx)) laneNodes.set(laneIdx, []);
        laneNodes.get(laneIdx).push({ node: n, ts: t, x });
    });

    // Within each lane, sort by timestamp and push apart overlapping nodes
    laneNodes.forEach((items, laneIdx) => {
        items.sort((a, b) => a.ts - b.ts);
        for (let j = 1; j < items.length; j++) {
            if (items[j].x - items[j - 1].x < minNodeGap) {
                items[j].x = items[j - 1].x + minNodeGap;
            }
        }
        const baseY = 50 + laneIdx * laneSpacing;
        items.forEach(item => {
            item.node.animate({ position: { x: item.x, y: baseY } }, { duration: 800, easing: 'ease-in-out-cubic' });
        });
    });

    // Call hooks after animation
    setTimeout(() => {
        refitGraph({ delay: 60 });
        applyDegreeScaling();
        drawSwimlanes();
        drawMinimap();
    }, 850);
}

// ---- F11: Path highlighting ----
function handlePathClick(nodeId) {
    const pathStatus = document.getElementById('path-status');

    if (!pathSelectState.firstNodeId) {
        // First shift-click
        pathSelectState.firstNodeId = nodeId;
        // The label is whatever the watched project or the posting agent called this
        // node, so it goes through _esc like every other agent-supplied string.
        const label = _esc(cy.getElementById(nodeId).data('label') || nodeId);
        pathStatus.innerHTML = `Path from: <strong>${label}</strong> — Shift+click target`;
        pathStatus.style.display = 'block';
    } else {
        // Second shift-click — find shortest path
        highlightShortestPath(pathSelectState.firstNodeId, nodeId);
        pathSelectState.firstNodeId = null;
        pathStatus.style.display = 'none';
    }
}

function highlightShortestPath(sourceId, targetId) {
    const result = cy.elements().aStar({
        root: cy.getElementById(sourceId),
        goal: cy.getElementById(targetId),
        directed: false,
    });

    if (!result.found) {
        console.warn('No path found between', sourceId, 'and', targetId);
        return;
    }

    const pathEles = result.path;
    cy.elements().forEach(el => {
        if (pathEles.contains(el)) {
            el.removeClass('faded').addClass('highlighted');
        } else {
            el.removeClass('highlighted').addClass('faded');
        }
    });
}

// ---- F12: Inline metric sparklines ----
function renderMetricSparklines(metrics) {
    const entries = Object.entries(metrics);
    if (entries.length === 0) return '';

    const values = entries.map(([, v]) => (typeof v === 'number' ? v : parseFloat(v) || 0));
    const maxVal = Math.max(...values) || 1;
    const barMaxH = 40;

    let svg = `<div class="sparkline-container">`;
    entries.forEach(([key, val], i) => {
        const numVal = values[i];
        const ratio = numVal / maxVal;
        const h = Math.max(3, ratio * barMaxH);
        let color;
        if (ratio >= 0.7) color = '#689D6A';
        else if (ratio >= 0.4) color = '#D79921';
        else color = '#A89984';

        svg += `<div class="sparkline-bar">
            <span class="bar-value" style="color:${color}">${typeof val === 'number' ? val.toFixed ? val.toFixed(2) : val : val}</span>
            <svg width="20" height="${barMaxH}" style="display:block;">
                <rect x="2" y="${barMaxH - h}" width="16" height="${h}" rx="2" fill="${color}" />
            </svg>
            <span class="bar-label">${key}</span>
        </div>`;
    });
    svg += '</div>';
    return svg;
}

// ============================================================================
// ORGANIC MODE COSMIC EFFECTS — near-black background, dust ring, hub bloom.
// All drawing is additive over a transparent #cy and no-ops outside organic
// mode. The glow overlay is driven by a single rAF dirty-flag loop so pan/zoom
// never paints synchronously inside an event handler.
// ============================================================================

// ---- Background: vignette only (the decorative dust ring was removed; the
// outside-knowledge halo is now made of real `facts` nodes, not painted dots) ----
function computeDust() {
    dust = [];   // no decorative background circles
}


// Pitch and dot radius are in MODEL units, so the lattice densifies on screen as you
// zoom out and opens up as you zoom in — which is what makes it read as ground
// rather than as wallpaper. It fades out entirely below zoom 0.3, where the dots
// would converge into a flat wash.
const LATTICE_PITCH = 96;
const LATTICE_DOT = 1.5;

function _drawLattice(ctx, W, H) {
    const z = cy.zoom();
    const alpha = PAL.latticeAlpha * Math.max(0, Math.min(1, (z - 0.30) / 0.30));
    if (alpha <= 0.002) return;

    const ext = cy.extent();                       // model-space viewport
    const x0 = Math.floor(ext.x1 / LATTICE_PITCH) * LATTICE_PITCH;
    const y0 = Math.floor(ext.y1 / LATTICE_PITCH) * LATTICE_PITCH;
    const cols = Math.ceil((ext.x2 - x0) / LATTICE_PITCH) + 1;
    const rows = Math.ceil((ext.y2 - y0) / LATTICE_PITCH) + 1;
    // Belt and braces: at an extreme zoom-out the clip above should already have
    // returned, but never let this loop run away.
    if (cols * rows > 4000) return;

    const p = cy.pan();
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(z, z);
    ctx.fillStyle = `rgba(${PAL.lattice},${alpha})`;
    ctx.beginPath();
    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
            const x = x0 + i * LATTICE_PITCH;
            const y = y0 + j * LATTICE_PITCH;
            ctx.moveTo(x + LATTICE_DOT, y);
            ctx.arc(x, y, LATTICE_DOT, 0, 6.283185307);
        }
    }
    ctx.fill();                                     // one fill for the whole lattice
    ctx.restore();
}

function drawBackground() {
    const cv = document.getElementById('bgfx');
    if (!cv || !cy) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cy.width(), H = cy.height();
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!organicMode) return;   // bgfx stays blank outside organic mode

    // 1. ground fill (near-black, or paper in the light theme)
    ctx.fillStyle = PAL.ground;
    ctx.fillRect(0, 0, W, H);

    // 2. world-space lattice. The point of a background grid is to be a scale
    // reference, which it can only be if it moves WITH the graph — a CSS background
    // slides underneath a panning canvas and tells you nothing. Drawing it in model
    // coordinates gives real parallax, and clipping the loop to cy.extent() keeps
    // the cost proportional to what is visible rather than to the world.
    _drawLattice(ctx, W, H);

    // 3. screen-fixed radial vignette (darkens viewport edges)
    const minDim = Math.min(W, H), maxDim = Math.max(W, H);
    const vg = ctx.createRadialGradient(W / 2, H * 0.46, minDim * 0.25, W / 2, H * 0.46, maxDim * 0.78);
    vg.addColorStop(0, PAL.vignette[0]);
    vg.addColorStop(1, PAL.vignette[1]);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    // (decorative dust ring removed — Facts nodes form the knowledge halo instead)
}

function clearBackground() {
    const cv = document.getElementById('bgfx');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
}

// ---- Glow overlay: additive hub bloom + SSE supernova ----
function initGlow() {
    glowCanvas = document.getElementById('glow');
    if (!glowCanvas) return;
    glowCtx = glowCanvas.getContext('2d');

    _buildGlowSprite();
    requestAnimationFrame(glowLoop);
}

// Cache a 128px radial-gradient sprite (white on dark, violet on light); drawImage-
// scale it per hub each frame (far cheaper than rebuilding a gradient per node).
function _buildGlowSprite() {
    glowSprite = document.createElement('canvas');
    glowSprite.width = glowSprite.height = 128;
    const sc = glowSprite.getContext('2d');
    const g = sc.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [at, colour] of PAL.glowPlain) g.addColorStop(at, colour);
    sc.fillStyle = g;
    sc.fillRect(0, 0, 128, 128);
}

// Marking the layer dirty repaints it on the NEXT frame — which is one frame behind
// whatever moved the camera, and if that was the last frame of an animation there is
// no next frame to catch up on. Everything on this layer is positioned from
// renderedPosition(), so a stale paint leaves the bloom, the credibility dials and the
// pulse drawn where the nodes used to be: at rest a dial sits forty pixels beside its
// own claim. So a dirty mark also opens a short window during which the layer repaints
// every frame regardless. Camera changes are bursty; the window closes on its own and
// the loop goes back to doing nothing at all.
const GLOW_TRAIL_MS = 700;
let _glowUntil = 0;

function scheduleGlow() {
    glowDirty = true;
    _glowUntil = performance.now() + GLOW_TRAIL_MS;
}

// The single motion gate for the canvas layers. Anything that moves on its own asks
// this first, and anyone who has told their OS they want less motion gets a graph
// that is completely still — not a slower one.
let _motionOK = true;
try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    _motionOK = !mq.matches;
    mq.addEventListener('change', (e) => { _motionOK = !e.matches; scheduleGlow(); });
} catch (e) { /* older browser: keep the default */ }

function glowLoop() {
    // Pure dirty-flag scheduling: at rest this does nothing at all. Only a real event
    // — a pan, a layout, an SSE arrival, a live pulse — makes the loop paint.
    const now = performance.now();
    const trailing = now < _glowUntil;
    if (glowDirty || trailing || supernova.size || _pulses.length
        || (_motionOK && organicMode && cy && cy.edges('.edge-hover').nonempty())) {
        if (glowDirty || supernova.size) drawBackground();
        drawGlow();
        glowDirty = false;
    }
    requestAnimationFrame(glowLoop);
}

function drawGlow() {
    if (!glowCtx || !cy) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cy.width(), H = cy.height();
    if (glowCanvas.width !== Math.round(W * dpr) || glowCanvas.height !== Math.round(H * dpr)) {
        glowCanvas.width = Math.round(W * dpr); glowCanvas.height = Math.round(H * dpr);
        glowCanvas.style.width = W + 'px'; glowCanvas.style.height = H + 'px';
    }
    glowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glowCtx.clearRect(0, 0, W, H);
    if (!organicMode) return;   // no bloom outside organic mode

    glowCtx.globalCompositeOperation = PAL.glowBlend;   // dark: additive, overlaps sum toward white

    const z = cy.zoom();
    // Only hub cores glow (degree >= 4 → typically 10–40 sprites/frame).
    // Bloom is tinted by node type, so hue survives in the dense core where the discs
    // themselves are mostly occluded. It does NOT breathe: an earlier version pulsed
    // each hub on a per-id phase, and it was removed because the period and phase
    // encoded nothing while denying the render loop any idle state. A still picture is
    // itself information in a tool whose output people screenshot.
    cy.nodes('.hubcore').forEach(n => {
        if (n.hasClass('faded') || n.style('display') === 'none') return;
        const rp = n.renderedPosition(), deg = n.degree();
        const R = (11 + deg * 2.6) * z;
        const a = Math.min(0.8, 0.26 + deg * 0.04) * PAL.glowScale;
        _drawGlowSprite(rp.x, rp.y, R, a, n.data('_tint'));
    });

    // SSE pulses: soft bloom + crisp expanding ripple rings (Obsidian-style).
    const now = performance.now();
    for (const [id, sn] of supernova) {
        const prog = (now - sn.t0) / sn.dur;
        if (prog >= 1) { supernova.delete(id); continue; }
        const n = cy.getElementById(id);
        if (n.empty()) { supernova.delete(id); continue; }
        const rp = n.renderedPosition(), deg = Math.max(n.degree(), 1);
        const baseR = (11 + deg * 2.6) * z;
        const ease = 1 - Math.pow(1 - prog, 3);                                 // ease-out cubic
        _drawGlowSprite(rp.x, rp.y, baseR * 1.25, (1 - prog) * 0.9 * PAL.glowScale);            // core glow
        _drawGlowSprite(rp.x, rp.y, baseR * (1 + ease * 4.5), (1 - prog) * 0.45 * PAL.glowScale); // soft wave
        // two thin ripple rings expanding out (aqua for births, amber for updates)
        const col = sn.birth ? PAL.ripple.birth : PAL.ripple.update;
        for (let k = 0; k < 2; k++) {
            const ra = Math.max(0, (1 - prog) - k * 0.18) * 0.55;
            if (ra <= 0) continue;
            glowCtx.beginPath();
            glowCtx.arc(rp.x, rp.y, baseR * (1.2 + (ease + k * 0.2) * 5.5), 0, 6.283185);
            glowCtx.strokeStyle = `rgba(${col},${ra})`;
            glowCtx.lineWidth = 1.6;
            glowCtx.stroke();
        }
    }

    _drawLineagePulse(now, z);
    _drawHoverFlow(now, z);

    // The selected node gets its presence from light rather than from inflating.
    cy.nodes('.selected-node').forEach(n => {
        const rp = n.renderedPosition();
        const R = (11 + Math.max(n.degree(), 1) * 2.6) * z * 1.7;
        glowCtx.globalAlpha = 0.42;
        glowCtx.beginPath();
        const g = glowCtx.createRadialGradient(rp.x, rp.y, 0, rp.x, rp.y, R);
        g.addColorStop(0, 'rgba(250,189,47,0.75)');
        g.addColorStop(0.45, 'rgba(250,189,47,0.22)');
        g.addColorStop(1, 'rgba(250,189,47,0)');
        glowCtx.fillStyle = g;
        glowCtx.arc(rp.x, rp.y, R, 0, 6.283185307);
        glowCtx.fill();
        glowCtx.globalAlpha = 1;
    });

    glowCtx.globalCompositeOperation = 'source-over';
    _drawCredibilityDials(z);
}

// A swept arc on the face of every claim and conclusion: how much of this do we
// believe, and was the evidence underneath it asserted or guessed. It puts the two
// questions the whole tool exists to answer onto the objects they apply to — at every
// zoom level, with no hover, no click and no legend lookup.
//
// The ghost ring matters: without it a low score reads as "no data" instead of
// "nearly empty". A node with no score gets the ghost ring ONLY — drawing an arc
// there would be inventing a number.
const DIAL_MIN_R = 5;
const DIAL_CAP = 120;

function _drawCredibilityDials(z) {
    if (!cy) return;
    const verdicts = cy.nodes('.verdict-node');
    if (verdicts.empty()) return;

    const n = Math.min(verdicts.length, DIAL_CAP);
    for (let i = 0; i < n; i++) {
        const nd = verdicts[i];
        if (nd.style('display') === 'none') continue;
        const R = ((nd.data('_sz') || 12) / 2) * z;
        if (R < DIAL_MIN_R) continue;                 // sub-pixel: nothing legible to draw

        const rp = nd.renderedPosition();
        const dialR = R * 0.72;
        const dim = nd.hasClass('faded') ? 0.25 : 1;
        // The dial sits ON the node's own colour, and a red arc for a low score on a
        // red claim body is invisible. Cut a dark groove first, so the arc contrasts
        // with the disc no matter what type colour is underneath it.
        glowCtx.lineWidth = Math.max(2, R * 0.30);
        glowCtx.lineCap = 'butt';

        glowCtx.setLineDash([]);
        glowCtx.beginPath();
        glowCtx.arc(rp.x, rp.y, dialR, 0, 6.283185307);
        glowCtx.globalAlpha = dim;
        glowCtx.strokeStyle = PAL.dial.groove;
        glowCtx.stroke();

        // A faint full ring inside the groove, so an empty dial still reads as "a dial
        // that is nearly empty" rather than "no data".
        glowCtx.lineWidth = Math.max(1.5, R * 0.22);
        glowCtx.beginPath();
        glowCtx.arc(rp.x, rp.y, dialR, 0, 6.283185307);
        glowCtx.strokeStyle = PAL.dial.track;
        glowCtx.stroke();

        // A tick at the dial's zero. Most of these claims score in single-digit
        // percent, which is an arc about one pixel long — without a visible track and
        // a start mark, an honest "almost nothing" is indistinguishable from "no data",
        // and the reader would conclude the wrong thing from a correct drawing.
        glowCtx.lineWidth = Math.max(1, R * 0.10);
        glowCtx.beginPath();
        glowCtx.moveTo(rp.x, rp.y - dialR - R * 0.13);
        glowCtx.lineTo(rp.x, rp.y - dialR + R * 0.13);
        glowCtx.strokeStyle = PAL.dial.tick;
        glowCtx.stroke();
        glowCtx.globalAlpha = 1;

        const score = nd.data('credibility_score');
        if (score == null) continue;

        const prov = nd.data('_prov');
        glowCtx.lineWidth = Math.max(1.5, R * 0.22);
        glowCtx.setLineDash(prov === 0 ? []
            : prov === 1 ? [R * 0.42, R * 0.16]
            : [R * 0.20, R * 0.16]);
        glowCtx.beginPath();
        glowCtx.arc(rp.x, rp.y, dialR, -Math.PI / 2,
                    -Math.PI / 2 + Math.max(0, Math.min(1, score)) * 6.283185307);
        glowCtx.strokeStyle = CRED_COLORS[_credRating(score)];
        glowCtx.globalAlpha = dim;
        glowCtx.lineCap = 'round';    // a sub-degree sweep still puts a dot on the track
        glowCtx.stroke();
        glowCtx.lineCap = 'butt';
        glowCtx.globalAlpha = 1;
    }
    glowCtx.setLineDash([]);
}

// Evidence has a direction and a depth, and a static line can only imply either. When
// a node is selected we fire ONE wave of light along its lineage in hop order: edges
// one step from the selection light first, then two, then three. What you see is not
// decoration — it is how deep the chain of reasoning under that claim actually goes,
// and how it branches. It runs once and stops, so the resting picture stays still.
//
// A hovered edge is the one place a continuous loop earns its keep, because there the
// question really is "which way does THIS one go" — see _drawHoverFlow.
const PULSE_STEP_MS = 190;      // delay between successive hops
const PULSE_EDGE_MS = 560;      // time one head takes to cross one edge
const PULSE_HEADS = 2;          // heads per edge, spaced half a crossing apart
const PULSE_TAIL_MS = 520;      // how long the last hop keeps running after it lands
const PULSE_MAX_EDGES = 400;
const PULSE_MAX_LIVE = 6;       // concurrent waves; beyond this the oldest is dropped

// Waves in flight. A single slot was enough while the only trigger was a click, but a
// live graph changes state in bursts — a run finishes, three results land, a claim is
// rescored — and one slot meant each arrival cancelled the last, so a busy graph showed
// less movement than a quiet one. Several concurrent waves is what makes the network
// read as flowing while it is being built.
let _pulses = [];

// Two kinds of wave, and they are answering different questions.
//
//   'lineage'    — the user clicked a node: walk the lit subgraph in both directions,
//                  because they asked what this claim rests on and what rests on it.
//   'downstream' — something changed on its own: walk the way evidence flows, because
//                  the question is what this change reaches. A result landing shows you
//                  the claim it is about to move.
// Tones live in the theme (PAL.pulse): lineage is the user's own selection (white on
// dark, violet on light), arrival is a node the graph gained (aqua), update is a node
// whose value changed (amber).

function startPulse(rootId, { follow = 'lineage', tone = 'lineage' } = {}) {
    if (!_motionOK || !cy || !organicMode) return;

    const root = cy.getElementById(rootId);
    if (root.empty()) return;

    const hops = new Map();
    const seen = new Set([rootId]);
    let frontier = [root];
    let hop = 0;
    while (frontier.length && hops.size < PULSE_MAX_EDGES && hop < 24) {
        const next = [];
        for (const n of frontier) {
            const edges = follow === 'downstream'
                ? n.outgoers('edge')
                : n.connectedEdges('.highlighted');
            edges.forEach(e => {
                if (hops.has(e.id())) return;
                hops.set(e.id(), hop);
                const other = e.source().id() === n.id() ? e.target() : e.source();
                if (!seen.has(other.id())) { seen.add(other.id()); next.push(other); }
            });
        }
        frontier = next;
        hop++;
    }
    if (!hops.size) return;

    _pulses.push({
        hops,
        t0: performance.now(),
        // One head crossing one edge is a blip, not a flow — a result-to-claim wave is a
        // single hop, and at 420ms it was over before the eye found it. Two heads and a
        // tail turn each change into something you can actually watch travel.
        span: hop * PULSE_STEP_MS + PULSE_EDGE_MS + PULSE_TAIL_MS,
        colour: PAL.pulse[tone] || PAL.pulse.lineage,
    });
    // Bounded: a flood of events must not turn into an unbounded draw list.
    if (_pulses.length > PULSE_MAX_LIVE) _pulses.splice(0, _pulses.length - PULSE_MAX_LIVE);
    scheduleGlow();
}

// Kept as the name the click path calls, so the selection behaviour reads unchanged.
function startLineagePulse(rootId) {
    startPulse(rootId, { follow: 'lineage', tone: 'lineage' });
}

// A node changed on its own — it arrived, its metrics moved, its run finished. Send the
// change the way the evidence flows, so what you watch is its consequence rather than
// the fact that something happened somewhere.
//
// Deferred by a frame or two on purpose: a node and its edges arrive as separate SSE
// elements, so a wave computed the instant the node lands finds no edges to travel.
function flowFromChange(nodeId, tone) {
    if (!_motionOK || !organicMode) return;
    window.setTimeout(() => startPulse(nodeId, { follow: 'downstream', tone }), 260);
}

function _drawLineagePulse(now, z) {
    if (!_pulses.length) return;

    const r = Math.max(2, Math.min(5, 2.8 * z));
    let expired = false;

    for (const pulse of _pulses) {
        const age = now - pulse.t0;
        if (age > pulse.span) { expired = true; continue; }

        pulse.hops.forEach((hop, id) => {
            const e = cy.getElementById(id);
            if (e.empty() || e.hasClass('faded')) return;

            const start = hop * PULSE_STEP_MS;
            const local = age - start;
            if (local < 0) return;

            const sp = e.source().renderedPosition();
            const tp = e.target().renderedPosition();
            const dx = tp.x - sp.x, dy = tp.y - sp.y;

            for (let k = 0; k < PULSE_HEADS; k++) {
                // Heads are spaced half a crossing apart, and the whole edge keeps
                // emitting until the wave's tail runs out, so the link reads as carrying
                // something rather than as blinking once.
                const t = (local - k * (PULSE_EDGE_MS / PULSE_HEADS)) / PULSE_EDGE_MS;
                if (t < 0 || t > 1) continue;

                // Fade in and out at the ends so a head never pops at a node, and let
                // the whole wave dim as its tail expires.
                const life = Math.max(0, 1 - Math.max(0, local - PULSE_EDGE_MS) / PULSE_TAIL_MS);
                const a = 0.9 * Math.min(1, Math.min(t, 1 - t) * 5) * life;
                if (a <= 0.01) continue;

                const x = sp.x + dx * t, y = sp.y + dy * t;
                _drawGlowSprite(x, y, r * 3.4, a * 0.55, e.data('_etint'));
                glowCtx.beginPath();
                glowCtx.arc(x, y, r, 0, 6.283185307);
                glowCtx.fillStyle = pulse.colour;
                glowCtx.globalAlpha = a;
                glowCtx.fill();
                glowCtx.globalAlpha = 1;
            }
        });
    }

    if (expired) {
        _pulses = _pulses.filter(p => now - p.t0 <= p.span);
        scheduleGlow();
    }
}

// The one continuous loop, and only on the single edge the cursor is on.
const HOVER_FLOW_MS = 1150;

function _drawHoverFlow(now, z) {
    if (!_motionOK) return;
    const lit = cy.edges('.edge-hover');
    if (lit.empty()) return;
    const e = lit[0];
    const sp = e.source().renderedPosition();
    const tp = e.target().renderedPosition();
    const dx = tp.x - sp.x, dy = tp.y - sp.y;
    if (dx * dx + dy * dy < 64) return;
    const r = Math.max(1.5, Math.min(4, 2.2 * z));
    const tint = e.data('_etint') || PAL.trace;
    for (let k = 0; k < 2; k++) {
        const t = ((now / HOVER_FLOW_MS) + k * 0.5) % 1;
        const x = sp.x + dx * t, y = sp.y + dy * t;
        const fade = Math.min(1, Math.min(t, 1 - t) * 6);
        glowCtx.beginPath();
        glowCtx.arc(x, y, r, 0, 6.283185307);
        glowCtx.fillStyle = tint;
        glowCtx.globalAlpha = 0.85 * fade;
        glowCtx.fill();
        glowCtx.globalAlpha = 1;
    }
}

// The bloom used to be one white sprite for every node, which meant that in the dense
// core — exactly where the discs are most occluded by each other — the only thing you
// could see was colourless light. Tinting the halo by node type puts the hue back
// where the geometry has given up. Bounded and cached: there are ten node types, so
// this map never holds more than ten sprites, and it falls back to the white one if
// anything unexpected shows up.
const _glowSprites = new Map();

function _rgbParts(color) {
    if (!color) return null;
    const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    if (color[0] === '#') { try { return _hexToRgb(color); } catch (e) { return null; } }
    return null;
}

function _spriteFor(color) {
    if (!color || !glowSprite) return glowSprite;
    const hit = _glowSprites.get(color);
    if (hit) return hit;
    const rgb = _rgbParts(color);
    if (!rgb || _glowSprites.size >= 24) return glowSprite;

    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    // On dark, a white-hot core so a hub still reads as light, falling to the type hue
    // outward. On light there is no core: white on paper only bleaches the node.
    g.addColorStop(0, PAL.glowCore || `rgba(${rgb.r},${rgb.g},${rgb.b},0.40)`);
    g.addColorStop(0.18, `rgba(${rgb.r},${rgb.g},${rgb.b},0.52)`);
    g.addColorStop(0.55, `rgba(${rgb.r},${rgb.g},${rgb.b},0.15)`);
    g.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    _glowSprites.set(color, cv);
    return cv;
}

function _drawGlowSprite(x, y, R, alpha, tint) {
    glowCtx.globalAlpha = alpha;
    glowCtx.drawImage(_spriteFor(tint), x - R, y - R, R * 2, R * 2);
    glowCtx.globalAlpha = 1;
}

function clearGlow() {
    supernova.clear();
    glowDirty = false;
    if (!glowCanvas || !glowCtx) return;
    glowCtx.setTransform(1, 0, 0, 1, 0, 0);
    glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
}

// ============================================================================
// VIEWER EXTRAS — discoverability, at-a-glance provenance, honest load states.
//
// Strictly additive: nothing below changes the graph model, the SSE contract or
// the scorer. It only *reads* what is already in `cy` and in /api responses.
//
//   1. Keyboard shortcuts + a "?" overlay that documents the features that were
//      already here (Fit, Credibility, Organic/Dagre/Timeline, shift-click path,
//      double-click collapse, minimap, legend spotlight) but were undiscoverable.
//   2. A graph-health strip: node counts by type, claim ratings, and how many
//      edges were DECLARED (policy `manual`) vs INFERRED (every other policy) —
//      our differentiator, previously buried in the report.
//   3. Distinct "loading" vs "arranging" feedback instead of a blank canvas.
//
// Chrome is built from JS so no other file has to change. Every value that can
// originate in agent-supplied node/edge data is written with textContent (or via
// _esc where it must be markup) — never interpolated raw into innerHTML.
// ============================================================================

// ---- Injected stylesheet ---------------------------------------------------
// Namespaced `elg-` so it cannot collide with style.css, and built only from the
// existing CSS variables (no new hex where a var exists).
const EXTRAS_CSS = `
/* z-index, in the terms of the budget documented in polish.css:
     .elg-loading 7  — over graph-empty (5) / graph-error (6), under the panels' overlays
     .elg-health / .elg-helpbtn 20 — the floating-chrome tier (#minimap, .path-status)
     .elg-help-backdrop 300 — over the tooltip (200) and the modals (100), because
       Esc closes it first and it must never open behind one of them. */
.elg-health {
  position: absolute; top: 12px; left: 12px; z-index: 20;
  width: 17.5rem; max-width: calc(100% - 24px);
  background: var(--surface);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-muted); font-size: 0.72rem; line-height: 1.35;
  /* --plx-float is what polish.css gives #minimap / .path-status / .graph-error;
     one lift for everything that floats over the canvas. */
  box-shadow: var(--plx-float, 0 6px 20px rgba(0, 0, 0, 0.35));
}
.elg-health-head {
  display: flex; align-items: center; gap: 0.4rem; width: 100%;
  padding: 0.4rem 0.55rem; background: none; border: 0; color: inherit;
  font: inherit; text-align: left; cursor: pointer; user-select: none;
}
.elg-health-head:hover { color: var(--text); }
.elg-micro {
  font-size: 0.62rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-muted);
}
.elg-health-count { margin-left: auto; color: var(--text); font-variant-numeric: tabular-nums; }
.elg-caret { display: inline-block; transition: transform 0.18s ease; }
.elg-health[data-collapsed="true"] .elg-caret { transform: rotate(-90deg); }
.elg-health[data-collapsed="true"] .elg-health-body { display: none; }
.elg-health-body { display: flex; flex-direction: column; gap: 0.55rem; padding: 0.1rem 0.55rem 0.55rem; }
.elg-health-sec { display: flex; flex-direction: column; gap: 0.28rem; }
.elg-stack { display: flex; flex-direction: column; gap: 0.28rem; }
.elg-chips { display: flex; flex-wrap: wrap; gap: 0.22rem 0.26rem; }
.elg-health .legend-item.elg-chip {
  font-size: 0.68rem; padding: 0.1rem 0.34rem; gap: 0.28rem;
  border: 1px solid transparent; background: none; color: inherit; font-family: inherit;
}
.elg-chip .legend-swatch { width: 8px; height: 8px; border-radius: 50%; }
/* Our compact chip rule out-specifies .legend-item.active, so restate the lit state.
   style.css's Obsidian layer lights a legend item with --accent-soft (the base
   palette has no such var, hence the --surface2 fallback); match it exactly rather
   than inventing a second "selected" look. The inset accent ring from
   .legend-item.active is not overridden here, so it still applies. */
.elg-health .legend-item.elg-chip.active { background: var(--accent-soft, var(--surface2)); }
/* Likewise for hover: this stylesheet is injected after polish.css, so our
   the 'background: none' above would otherwise cancel its .legend-item:hover tint and
   leave the strip's chips as the only unresponsive clickable things on the page. */
.elg-health .legend-item.elg-chip:hover:not(.active) { background: var(--plx-tint-2, var(--surface2)); }
.elg-chip-n { color: var(--text); font-variant-numeric: tabular-nums; }
/* Three-state vocabulary: solid = present, dashed = expected-but-absent. */
.elg-health .legend-item.elg-chip.elg-absent { border: 1px dashed var(--border); }
.elg-health .legend-item.elg-chip.elg-inferred { border: 1px dashed var(--yellow); }
.elg-health .legend-item.elg-chip.elg-declared { border: 1px solid var(--accent); }
.elg-bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: var(--surface2); }
.elg-bar i { display: block; height: 100%; }
.elg-note { font-size: 0.66rem; color: var(--text-muted); }
.elg-note em { font-style: normal; color: var(--text); }
.elg-empty-note { font-style: italic; }

.elg-loading {
  position: absolute; inset: 0; z-index: 7; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.8rem;
}
.elg-ripple { position: relative; width: 58px; height: 58px; }
.elg-ripple i {
  position: absolute; inset: 0; border: 1px solid var(--accent); border-radius: 50%;
  opacity: 0; animation: elg-ripple 1.9s cubic-bezier(0,0.2,0.8,1) infinite;
}
.elg-ripple i:nth-child(2) { animation-delay: 0.45s; }
.elg-ripple i:nth-child(3) { animation-delay: 0.9s; }
@keyframes elg-ripple { 0% { transform: scale(0.22); opacity: 0.7; } 100% { transform: scale(1); opacity: 0; } }
.elg-loading-text { font-size: 0.8rem; color: var(--text); letter-spacing: 0.02em; }
.elg-loading-sub { font-size: 0.7rem; color: var(--text-muted); max-width: 22rem; text-align: center; }
@media (prefers-reduced-motion: reduce) {
  .elg-ripple i { animation: none; opacity: 0.35; transform: scale(1); }
}

.elg-helpbtn {
  position: absolute; left: 12px; bottom: 12px; z-index: 20;
  width: 26px; height: 26px; padding: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text-muted); font-size: 0.8rem; line-height: 1; cursor: pointer;
  box-shadow: var(--plx-float, 0 6px 20px rgba(0, 0, 0, 0.35));
}
.elg-helpbtn:hover { color: var(--text); border-color: var(--accent); }
.elg-help-backdrop {
  position: fixed; inset: 0; z-index: 300; padding: 1.5rem;
  /* Same frosted treatment style.css gives .modal-overlay, so the help dialog
     reads as one of the app's dialogs rather than a second visual language. */
  background: rgba(6, 6, 11, 0.62); backdrop-filter: blur(7px);
  display: flex; align-items: center; justify-content: center;
}
.elg-help {
  width: min(50rem, 100%); max-height: 84vh; overflow: auto;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  color: var(--text); box-shadow: var(--elev-2, 0 18px 50px rgba(0, 0, 0, 0.55));
}
.elg-help:focus { outline: none; }
.elg-help-head {
  position: sticky; top: 0; display: flex; align-items: center; gap: 0.6rem;
  padding: 0.75rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border);
}
.elg-help-head h2 { font-size: 0.95rem; font-weight: 600; }
.elg-help-close {
  margin-left: auto; padding: 0.1rem 0.35rem; background: none; border: 0;
  color: var(--text-muted); font-size: 1.15rem; line-height: 1; cursor: pointer;
}
.elg-help-close:hover { color: var(--text); }
.elg-help-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 1rem 1.6rem; padding: 1rem;
}
.elg-help-sec h4 { margin-bottom: 0.4rem; }
.elg-help-row {
  display: grid; grid-template-columns: 7rem 1fr; gap: 0.55rem;
  align-items: baseline; padding: 0.16rem 0; font-size: 0.76rem; color: var(--text-muted);
}
.elg-help-keys { display: flex; flex-wrap: wrap; gap: 0.18rem; align-items: baseline; }
.elg-help-plus { color: var(--text-muted); font-size: 0.66rem; }
.elg-kbd {
  display: inline-block; min-width: 1.3rem; text-align: center;
  padding: 0.08rem 0.34rem; border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: 4px; background: var(--surface2); color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.68rem;
}
.elg-help-foot {
  padding: 0.75rem 1rem 0.95rem; border-top: 1px solid var(--border);
  font-size: 0.72rem; color: var(--text-muted); line-height: 1.5;
}
.elg-help-foot b { color: var(--text); font-weight: 600; }
`;

function _injectExtrasCss() {
    if (document.getElementById('elg-extras-css')) return;
    const s = document.createElement('style');
    s.id = 'elg-extras-css';
    s.textContent = EXTRAS_CSS;
    document.head.appendChild(s);
}

// ---- Entry point (called once from DOMContentLoaded, after initMinimap) -----
function initViewerExtras() {
    _injectExtrasCss();
    _healthEl();
    renderGraphHealth();   // show the empty state straight away, not a blank box
    _helpButtonEl();
    initKeyboardShortcuts();

    // The activity panel is a running log; say so for assistive tech.
    const log = document.getElementById('activity-log');
    if (log && !log.getAttribute('role')) log.setAttribute('role', 'log');

    if (cy) {
        // "Arranging" ends when the layout settles — Cytoscape tells us directly,
        // so no per-layout callback in runLayout() had to be touched.
        cy.on('layoutstop', () => {
            if (_graphPhaseState === 'arranging') _graphPhase(null);
            _initialLoadPending = false;
        });
        // A background tap already clears the graph highlight; clear our chips too.
        cy.on('tap', (evt) => { if (evt.target === cy) _clearHealthActive(); });
    }
}

// ============================================================================
// 1. Loading / arranging feedback
// ============================================================================

let _graphPhaseState = null;      // 'loading' | 'arranging' | null
let _graphPhaseTimer = null;
let _graphSlowTimer = null;
let _initialLoadPending = true;

function _liveNodeCount() {
    if (!cy) return 0;
    return cy.nodes().filter(n => !n.hasClass('cluster-label') && !n.hasClass('summary-node')).length;
}

function _graphPhaseEl() {
    let el = document.getElementById('elg-loading');
    if (el) return el;
    const area = document.querySelector('.graph-area');
    if (!area) return null;
    _injectExtrasCss();
    el = document.createElement('div');
    el.id = 'elg-loading';
    el.className = 'elg-loading';
    el.hidden = true;
    el.setAttribute('aria-live', 'polite');
    const rip = document.createElement('div');
    rip.className = 'elg-ripple';
    for (let i = 0; i < 3; i++) rip.appendChild(document.createElement('i'));
    const txt = document.createElement('div');
    txt.className = 'elg-loading-text';
    const sub = document.createElement('div');
    sub.className = 'elg-loading-sub';
    el.append(rip, txt, sub);
    area.appendChild(el);
    return el;
}

// Three kinds of waiting, three different messages:
//   'loading'   — the /graph request is open and there is nothing on screen yet
//   'arranging' — elements are in, the force layout is still settling
//   null        — hidden
// A refresh over an already-drawn graph shows nothing at all: covering a live
// graph with a spinner every time an event triggers a reload is worse than
// silence (the counts and the activity log already show it is working).
function _graphPhase(phase) {
    if (phase === 'loading' && _liveNodeCount() > 0) phase = null;
    if (phase === 'arranging' && !_initialLoadPending) phase = null;
    _graphPhaseState = phase;
    if (_graphSlowTimer) { clearTimeout(_graphSlowTimer); _graphSlowTimer = null; }
    if (_graphPhaseTimer) { clearTimeout(_graphPhaseTimer); _graphPhaseTimer = null; }
    const el = _graphPhaseEl();
    if (!el) return;
    if (!phase) { el.hidden = true; return; }
    // #graph-empty is centred at z-index 5 and this overlay is centred at z-index 7,
    // so on a reload of an empty task the two blocks of text sat on top of each
    // other. Whoever calls this re-evaluates setGraphEmpty() once the fetch lands.
    if (phase === 'loading') {
        const empty = document.getElementById('graph-empty');
        if (empty) empty.hidden = true;
    }
    const txt = el.querySelector('.elg-loading-text');
    const sub = el.querySelector('.elg-loading-sub');
    if (phase === 'loading') {
        txt.textContent = 'Loading the evidence graph…';
        sub.textContent = '';
        _graphSlowTimer = setTimeout(() => {
            if (_graphPhaseState === 'loading') {
                sub.textContent = 'Still waiting on the server — it may be replaying the event log.';
            }
        }, 5000);
    } else {
        const n = _liveNodeCount();
        txt.textContent = `Arranging ${n} node${n === 1 ? '' : 's'}…`;
        sub.textContent = 'The force layout is settling; the view will fit itself when it stops.';
        // Failsafe: if a layout never emits layoutstop we must not leave this up.
        _graphPhaseTimer = setTimeout(() => {
            if (_graphPhaseState === 'arranging') _graphPhase(null);
        }, 8000);
    }
    el.hidden = false;
}

// ============================================================================
// 2. Graph health strip
// ============================================================================

let _healthTimer = null;

function scheduleGraphHealth() {
    if (_healthTimer) return;
    _healthTimer = setTimeout(() => { _healthTimer = null; renderGraphHealth(); }, 180);
}

function _healthEl() {
    let el = document.getElementById('elg-health');
    if (el) return el;
    const area = document.querySelector('.graph-area');
    if (!area) return null;
    _injectExtrasCss();
    el = document.createElement('section');
    el.id = 'elg-health';
    el.className = 'elg-health';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Graph health');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'elg-health-head';
    head.title = 'Counts for what is currently drawn in the graph (H)';
    const caret = document.createElement('span');
    caret.className = 'elg-caret';
    caret.textContent = '▾';
    const title = document.createElement('span');
    title.className = 'elg-micro';
    title.textContent = 'Graph health';
    const count = document.createElement('span');
    count.className = 'elg-health-count';
    head.append(caret, title, count);
    head.addEventListener('click', () => toggleHealthStrip());

    const body = document.createElement('div');
    body.className = 'elg-health-body';

    el.append(head, body);
    area.appendChild(el);

    let collapsed = false;
    try { collapsed = localStorage.getItem('elg.health.collapsed') === '1'; } catch (e) { /* no storage */ }
    el.dataset.collapsed = collapsed ? 'true' : 'false';
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    return el;
}

function setHealthCollapsed(collapsed) {
    const el = _healthEl();
    if (!el) return;
    el.dataset.collapsed = collapsed ? 'true' : 'false';
    const head = el.querySelector('.elg-health-head');
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    try { localStorage.setItem('elg.health.collapsed', collapsed ? '1' : '0'); } catch (e) { /* no storage */ }
}

function toggleHealthStrip() {
    const el = _healthEl();
    if (el) setHealthCollapsed(el.dataset.collapsed !== 'true');
}

// Read the live graph. Cluster labels, summary markers and the dotted edges that
// join them are viewer scaffolding, not evidence — they are excluded.
function computeGraphHealth() {
    const h = {
        nodes: 0, edges: 0,
        types: new Map(),
        claims: 0, cred: { green: 0, yellow: 0, red: 0, unscored: 0 },
        policies: new Map(), declared: 0, inferred: 0,
    };
    if (!cy) return h;
    cy.nodes().forEach(n => {
        if (n.hasClass('cluster-label') || n.hasClass('summary-node')) return;
        const t = n.data('node_type');
        if (!t || t === '_cluster_label' || t === '_summary') return;
        h.nodes++;
        h.types.set(t, (h.types.get(t) || 0) + 1);
        if (t === 'claim') {
            h.claims++;
            const r = _credRating(n.data('credibility_score'));
            if (r) h.cred[r]++; else h.cred.unscored++;
        }
    });
    cy.edges().forEach(e => {
        if (String(e.id()).indexOf('_summary') === 0) return;
        h.edges++;
        const p = String(e.data('policy') || 'unspecified');
        h.policies.set(p, (h.policies.get(p) || 0) + 1);
        if (_edgeDeclared(e)) h.declared++; else h.inferred++;
    });
    return h;
}

function _healthSection(label, content) {
    const sec = document.createElement('div');
    sec.className = 'elg-health-sec';
    const l = document.createElement('div');
    l.className = 'elg-micro';
    l.textContent = label;
    sec.append(l, content);
    return sec;
}

function _healthChip(opts) {
    const chip = document.createElement(opts.onClick ? 'button' : 'div');
    if (opts.onClick) chip.type = 'button';
    chip.className = 'legend-item elg-chip' + (opts.extraClass ? ' ' + opts.extraClass : '');
    if (opts.title) chip.title = opts.title;
    if (opts.color) {
        const sw = document.createElement('div');
        sw.className = 'legend-swatch';
        sw.style.background = opts.color;
        chip.appendChild(sw);
    }
    const name = document.createElement('span');
    name.textContent = opts.label;          // may be agent-supplied → textContent
    chip.appendChild(name);
    if (opts.count != null) {
        const n = document.createElement('span');
        n.className = 'elg-chip-n';
        n.textContent = String(opts.count);
        chip.appendChild(n);
    }
    if (opts.onClick) chip.addEventListener('click', () => opts.onClick(chip));
    return chip;
}

// Clicking a count chip spotlights that type, exactly as the sidebar legend does —
// same function, same state, so the two can never disagree.
function _spotlightType(type, chip) {
    let twin = null;
    document.querySelectorAll('#legend .legend-item[data-type]').forEach(el => {
        if (el.dataset.type === type) twin = el;
    });
    toggleLegendHighlight('node', type, twin || chip);
    if (legendHighlight === `node:${type}`) chip.classList.add('active');
}

// Spotlight every inferred (or every declared) edge. This is the whole point of
// tracking edge policy: a reader can see which parts of the lineage were asserted
// and which were guessed by a heuristic.
function toggleEdgePolicyHighlight(kind, chip) {
    if (!cy) return;
    const key = `policy:${kind}`;
    if (legendHighlight === key) { clearHighlight(); return; }
    clearHighlight();
    legendHighlight = key;
    chip.classList.add('active');
    const wantDeclared = kind === 'declared';
    const match = cy.edges().filter(e =>
        String(e.id()).indexOf('_summary') !== 0
        && (_edgeDeclared(e) === wantDeclared));
    // Nothing to spotlight (e.g. "inferred 0"): bail rather than fade the entire
    // graph to show an empty set, which reads as a broken view.
    if (match.empty()) { clearHighlight(); return; }
    const ends = match.connectedNodes();
    cy.batch(() => {
        cy.edges().forEach(e => {
            const m = match.contains(e);
            e.removeClass(m ? 'faded' : 'highlighted').addClass(m ? 'highlighted' : 'faded');
        });
        cy.nodes().forEach(n => {
            if (n.hasClass('cluster-label')) return;
            const m = ends.contains(n);
            n.removeClass(m ? 'faded' : 'highlighted').addClass(m ? 'highlighted' : 'faded');
        });
    });
}

function _clearHealthActive() {
    document.querySelectorAll('#elg-health .legend-item.active')
        .forEach(el => el.classList.remove('active'));
}

// The strip is rebuilt whenever the counts change, which would otherwise drop the
// lit chip while the graph itself stays spotlighted. Re-derive it from the state.
function _restoreHealthActive() {
    if (!legendHighlight) return;
    const parts = String(legendHighlight).split(':');
    const kind = parts[0], val = parts.slice(1).join(':');
    const attr = { node: 'type', cred: 'credibility', policy: 'edgePolicy' }[kind];
    if (!attr) return;
    document.querySelectorAll('#elg-health .legend-item').forEach(el => {
        if (el.dataset[attr] === val) el.classList.add('active');
    });
}

// Claims that streamed in over SSE carry no score (the scorer runs server-side on
// the baked graph). Rather than hide that, count them as "unscored" and let the
// user pull the real numbers from /scores on demand — no polling timer.
async function fetchClaimScores(btn) {
    try {
        await withBusy(btn, async () => {
            const r = await fetch(`${API_BASE}/scores`);
            if (!r.ok) throw new Error(`server returned ${r.status}`);
            const rows = await r.json();
            let filled = 0;
            (Array.isArray(rows) ? rows : []).forEach(row => {
                if (!row || !row.node_id) return;
                const n = cy.getElementById(row.node_id);
                if (!n || n.empty()) return;
                if (n.data('credibility_score') == null) filled++;
                n.data('credibility_score', row.score);
                if (row.details) n.data('score_details', row.details);
                if (credibilityMode) {
                    const c = _credColor(row.score);
                    if (c) n.data('color', c);
                }
            });
            if (credibilityMode && organicMode) { applyDegreeScaling(); scheduleGlow(); }
            _fvRefresh();
            logActivity('system', `scored <b>${filled}</b> claim(s) from /scores`, '#458588');
            renderGraphHealth();
        });
    } catch (e) {
        console.error('score fetch failed', e);
        const body = document.querySelector('#elg-health .elg-health-body');
        if (body) {
            const d = document.createElement('div');
            d.className = 'elg-note';
            d.textContent = 'Could not fetch scores — is the server still running?';
            body.appendChild(d);
        }
    }
}

function renderGraphHealth() {
    const root = _healthEl();
    if (!root || !cy) return;
    const h = computeGraphHealth();

    const countEl = root.querySelector('.elg-health-count');
    countEl.textContent = `${h.nodes}n · ${h.edges}e`;
    const head = root.querySelector('.elg-health-head');
    if (head) {
        head.title = `${h.nodes} node(s), ${h.edges} edge(s) currently drawn`
            + (h.inferred ? ` · ${h.inferred} inferred edge(s)` : '')
            + ' — press H to hide';
    }

    const body = root.querySelector('.elg-health-body');
    body.textContent = '';

    if (!h.nodes) {
        const p = document.createElement('div');
        p.className = 'elg-note elg-empty-note';
        p.textContent = 'Nothing in the graph yet — these counts fill in as nodes arrive.';
        body.appendChild(p);
        return;
    }

    // --- nodes by type ------------------------------------------------------
    const typeWrap = document.createElement('div');
    typeWrap.className = 'elg-chips';
    const known = Object.keys(NODE_TYPE_LABELS).filter(t => h.types.has(t));
    const extra = Array.from(h.types.keys()).filter(t => !NODE_TYPE_LABELS[t]).sort();
    known.concat(extra).forEach(t => {
        const label = NODE_TYPE_LABELS[t] || t;
        const chip = _healthChip({
            label: label,
            count: h.types.get(t),
            color: NODE_TYPE_COLORS[t] || '#A89984',
            title: NODE_TYPE_LABELS[t]
                ? 'Spotlight every node of this type'
                : 'Unrecognised node type — drawn dashed here and in the graph. '
                    + 'Click to spotlight them.',
            // Dashed = unrecognised, matching UNKNOWN_TYPE_STYLE on the canvas.
            extraClass: NODE_TYPE_LABELS[t] ? '' : 'elg-absent',
            onClick: (chipEl) => _spotlightType(t, chipEl),
        });
        chip.dataset.type = t;   // lets the existing legend clear/highlight logic reach it
        typeWrap.appendChild(chip);
    });
    body.appendChild(_healthSection('Nodes by type', typeWrap));

    // --- claim credibility --------------------------------------------------
    if (h.claims) {
        const credWrap = document.createElement('div');
        credWrap.className = 'elg-chips';
        const gt = Number(CRED_THRESHOLDS.green), yt = Number(CRED_THRESHOLDS.yellow);
        // Colours come from _credColor() driven by the server-supplied thresholds,
        // so the strip cannot drift from the scorer.
        [
            { rating: 'green', label: `High ≥${gt.toFixed(2)}`, probe: gt },
            { rating: 'yellow', label: `Med ≥${yt.toFixed(2)}`, probe: yt },
            { rating: 'red', label: `Low <${yt.toFixed(2)}`, probe: 0 },
        ].forEach(r => {
            const chip = _healthChip({
                label: r.label,
                count: h.cred[r.rating],
                color: _credColor(r.probe),
                title: 'Spotlight the claims at this credibility level',
                onClick: (chipEl) => _spotlightCredibility(r.rating, chipEl),
            });
            chip.dataset.credibility = r.rating;
            credWrap.appendChild(chip);
        });
        if (h.cred.unscored) {
            credWrap.appendChild(_healthChip({
                label: 'unscored',
                count: h.cred.unscored,
                extraClass: 'elg-absent',
                title: 'These claims arrived over the live stream and have not been scored '
                    + 'in this page yet. Click to pull their scores from the server.',
                onClick: (chipEl) => fetchClaimScores(chipEl),
            }));
        }
        body.appendChild(_healthSection('Claim credibility', credWrap));
    }

    // --- edge provenance ----------------------------------------------------
    if (h.edges) {
        const wrap = document.createElement('div');
        wrap.className = 'elg-stack';

        const chips = document.createElement('div');
        chips.className = 'elg-chips';
        const dc = _healthChip({
            label: 'declared', count: h.declared, extraClass: 'elg-declared',
            title: 'Edges an agent or the SDK asserted explicitly (policy `manual`). '
                + 'Click to spotlight them.',
            onClick: (chipEl) => toggleEdgePolicyHighlight('declared', chipEl),
        });
        dc.dataset.edgePolicy = 'declared';
        const ic = _healthChip({
            label: 'inferred', count: h.inferred, extraClass: 'elg-inferred',
            title: 'Edges nothing asserted — a heuristic, a retroactive scan, the model or '
                + 'the convergence pass proposed them. Click to spotlight them.',
            onClick: (chipEl) => toggleEdgePolicyHighlight('inferred', chipEl),
        });
        ic.dataset.edgePolicy = 'inferred';
        chips.append(dc, ic);

        const bar = document.createElement('div');
        bar.className = 'elg-bar';
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', `${h.declared} declared, ${h.inferred} inferred`);
        const d = document.createElement('i');
        d.style.width = (h.declared / h.edges * 100) + '%';
        d.style.background = 'var(--accent)';
        const i = document.createElement('i');
        i.style.width = (h.inferred / h.edges * 100) + '%';
        i.style.background = 'var(--yellow)';
        bar.append(d, i);

        wrap.append(chips, bar);

        if (h.inferred) {
            const note = document.createElement('div');
            note.className = 'elg-note';
            const em = document.createElement('em');
            em.textContent = `${h.inferred} of ${h.edges}`;
            note.append(em, document.createTextNode(
                ' edges were inferred rather than declared. Credibility scores rest partly on them.'));
            wrap.appendChild(note);
        }

        // Per-policy breakdown, so "inferred" is not a black box.
        const pol = document.createElement('div');
        pol.className = 'elg-note';
        Array.from(h.policies.entries())
            .sort((a, b) => b[1] - a[1])
            .forEach(([p, n], idx) => {
                if (idx) pol.appendChild(document.createTextNode(' · '));
                const span = document.createElement('span');
                span.textContent = `${EDGE_POLICY_LABELS[p] || prettifyEdgeType(p)} ${n}`;
                pol.appendChild(span);
            });
        wrap.appendChild(pol);

        // Same heading the generated report uses, so the two read as one document.
        body.appendChild(_healthSection('How the edges got there', wrap));
    }

    _restoreHealthActive();
}

// Spotlight claims at one credibility rating. Uses _credRating(), so the bands
// always match whatever /api/config served.
function _spotlightCredibility(rating, chip) {
    if (!cy) return;
    const key = `cred:${rating}`;
    if (legendHighlight === key) { clearHighlight(); return; }
    clearHighlight();
    legendHighlight = key;
    chip.classList.add('active');
    const match = cy.nodes().filter(n =>
        n.data('node_type') === 'claim' && _credRating(n.data('credibility_score')) === rating);
    if (match.empty()) { clearHighlight(); return; }
    cy.batch(() => {
        cy.nodes().forEach(n => {
            if (n.hasClass('cluster-label')) return;
            const m = match.contains(n);
            n.removeClass(m ? 'faded' : 'highlighted').addClass(m ? 'highlighted' : 'faded');
        });
        cy.edges().forEach(e => e.removeClass('highlighted').addClass('faded'));
    });
}

// ============================================================================
// 3. Keyboard shortcuts + help overlay
// ============================================================================

const HELP_SECTIONS = [
    {
        title: 'Keys',
        rows: [
            { keys: ['?'], text: 'Open / close this help' },
            { keys: ['Esc'], text: 'Close a dialog, or clear the current selection' },
            { keys: ['F'], text: 'Fit the whole graph into view' },
            { keys: ['C'], text: 'Toggle the Credibility view' },
            { keys: ['R'], text: 'Open the evidence Report' },
            { keys: ['H'], text: 'Show / hide the graph-health strip' },
            { keys: ['A'], text: 'Show / hide the activity panel' },
            { keys: ['P'], text: 'Replay how the graph was built, one event at a time' },
            { keys: ['Space'], text: 'Replay: play / pause' },
            { keys: ['←', '→'], text: 'Replay: one step back / forward (each step pauses)' },
            { keys: ['Home', 'End'], text: 'Replay: jump to the start / the end' },
            { keys: ['/'], text: 'Jump to Search' },
            { keys: ['O'], text: 'Layout: Organic galaxy (force-directed)' },
            { keys: ['D'], text: 'Layout: Dagre hierarchy (left to right)' },
            { keys: ['T'], text: 'Layout: Timeline (lanes by node type)' },
            { keys: ['V'], text: 'Focus view: the evidence chain drawn for reading (Flow, Rings or Galaxy)' },
            { keys: ['G'], text: 'Window: hand the whole window to the graph' },
            { keys: ['S'], text: 'Window: back to the balanced three-column split' },
            { keys: ['W'], text: 'Window: widen the side panels for reading' },
        ],
    },
    {
        title: 'On the canvas',
        rows: [
            { keys: ['drag'], text: 'Pan' },
            { keys: ['scroll'], text: 'Zoom' },
            { keys: ['click'], text: 'A node: full detail plus its whole lineage highlighted, upstream and downstream' },
            { keys: ['click'], text: 'An edge: the relationship, what it means, and how it was created' },
            { keys: ['click'], text: 'Empty space: clear the selection' },
            { keys: ['Shift', 'click'], text: 'Two nodes in a row: highlight the shortest path between them' },
            { keys: ['double-click'], text: 'A node: collapse everything downstream into one “N nodes” marker' },
            { keys: ['double-click'], text: 'That marker: put the branch back' },
            { keys: ['hover'], text: 'A node or edge: a tooltip with its key fields' },
        ],
    },
    {
        title: 'Panels',
        rows: [
            { keys: ['Health'], text: 'Top left: counts by type, claim ratings, declared vs inferred edges. Every chip is clickable and spotlights what it counts.' },
            { keys: ['Legend'], text: 'Left: click a node type or edge type to spotlight every element of it' },
            { keys: ['Minimap'], text: 'Bottom right: click anywhere in it to jump the viewport there' },
            { keys: ['Activity'], text: 'Right: every node and edge as it arrives. Click a row to centre that node; click its heading (or A) to fold it away.' },
            { keys: ['Focus'], text: 'Header: the same graph laid out for reading. Flow puts one stage per column, Rings one per orbit; Calm keeps colour for the verdicts. Hover traces a lineage, a click pins it.' },
            { keys: ['Replay'], text: 'Header: rebuild the graph from its log, step by step. The dials show each claim’s credibility as it stood at that step.' },
            { keys: ['Conclusion'], text: 'Node ids in the text (CLM-001, CONC-002, …) are clickable and focus that evidence chain' },
        ],
    },
];

let _helpPrevFocus = null;

function _helpOpen() {
    const el = document.getElementById('elg-help-backdrop');
    return !!el && !el.hidden;
}

function _helpButtonEl() {
    let btn = document.getElementById('elg-helpbtn');
    if (btn) return btn;
    const area = document.querySelector('.graph-area');
    if (!area) return null;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'elg-helpbtn';
    btn.className = 'elg-helpbtn';
    btn.textContent = '?';
    btn.title = 'Keyboard shortcuts & what this view can do (?)';
    btn.setAttribute('aria-label', 'Keyboard shortcuts and help');
    btn.addEventListener('click', () => toggleHelpOverlay(true));
    area.appendChild(btn);
    return btn;
}

function _buildHelpOverlay() {
    const back = document.createElement('div');
    back.id = 'elg-help-backdrop';
    back.className = 'elg-help-backdrop';
    back.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'elg-help';
    panel.id = 'elg-help';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Keyboard shortcuts and help');
    panel.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'elg-help-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Shortcuts & what this view can do';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'elg-help-close';
    close.setAttribute('aria-label', 'Close help');
    close.textContent = '×';
    close.addEventListener('click', () => toggleHelpOverlay(false));
    head.append(h2, close);

    const grid = document.createElement('div');
    grid.className = 'elg-help-grid';
    HELP_SECTIONS.forEach(sec => {
        const col = document.createElement('div');
        col.className = 'elg-help-sec';
        const h4 = document.createElement('h4');
        h4.className = 'elg-micro';
        h4.textContent = sec.title;
        col.appendChild(h4);
        sec.rows.forEach(row => {
            const r = document.createElement('div');
            r.className = 'elg-help-row';
            const keys = document.createElement('span');
            keys.className = 'elg-help-keys';
            row.keys.forEach((k, i) => {
                if (i) {
                    const plus = document.createElement('span');
                    plus.className = 'elg-help-plus';
                    plus.textContent = '+';
                    keys.appendChild(plus);
                }
                const kbd = document.createElement('kbd');
                kbd.className = 'elg-kbd';
                kbd.textContent = k;
                keys.appendChild(kbd);
            });
            const txt = document.createElement('span');
            txt.textContent = row.text;
            r.append(keys, txt);
            col.appendChild(r);
        });
        grid.appendChild(col);
    });

    const foot = document.createElement('div');
    foot.className = 'elg-help-foot';
    foot.id = 'elg-help-foot';
    panel.append(head, grid, foot);
    back.appendChild(panel);
    back.addEventListener('click', (e) => { if (e.target === back) toggleHelpOverlay(false); });
    document.body.appendChild(back);
    return back;
}

// The footer restates the two things the graph is actually for, using the live
// thresholds rather than repeating literals that could drift from the scorer.
function _renderHelpFooter() {
    const foot = document.getElementById('elg-help-foot');
    if (!foot) return;
    foot.textContent = '';
    const gt = Number(CRED_THRESHOLDS.green).toFixed(2), yt = Number(CRED_THRESHOLDS.yellow).toFixed(2);
    const p1 = document.createElement('p');
    const b1 = document.createElement('b');
    b1.textContent = 'Credibility ';
    p1.append(b1, document.createTextNode(
        `colours claims and conclusion findings by the strength of the evidence beneath them: `
        + `green ≥ ${gt}, yellow ≥ ${yt}, red below ${yt}. `
        + 'The Report explains every number.'));
    const p2 = document.createElement('p');
    const b2 = document.createElement('b');
    b2.textContent = 'Declared vs inferred ';
    p2.append(b2, document.createTextNode(
        'an edge whose policy is `manual` was asserted by an agent or the SDK. Every other '
        + 'policy — temporal proximity, retroactive scan, cross-type, LLM-proposed, convergence, '
        + 'evolve — was inferred, and the credibility scores rest partly on those. The health '
        + 'strip counts both; click either chip to see which is which.'));
    foot.append(p1, p2);
}

function toggleHelpOverlay(force) {
    _injectExtrasCss();
    let back = document.getElementById('elg-help-backdrop');
    if (!back) back = _buildHelpOverlay();
    const open = force != null ? force : back.hidden;
    if (open) {
        _renderHelpFooter();
        _helpPrevFocus = document.activeElement;
        back.hidden = false;
        const panel = document.getElementById('elg-help');
        if (panel) panel.focus();
    } else {
        back.hidden = true;
        if (_helpPrevFocus && typeof _helpPrevFocus.focus === 'function') _helpPrevFocus.focus();
        _helpPrevFocus = null;
    }
}

function _isTypingTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Drive the existing layout radios rather than duplicating the mode-switch logic,
// so the settings dropdown and the keyboard can never disagree.
function _setLayoutMode(mode) {
    const radio = document.querySelector(`input[name="layout-mode"][value="${mode}"]`);
    if (!radio || radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
}

function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.key === 'Escape') {
            if (_helpOpen()) { toggleHelpOverlay(false); return; }
            const open = Array.from(document.querySelectorAll('.modal-overlay.visible'));
            if (open.length) { open.forEach(m => m.classList.remove('visible')); return; }
            const dd = document.getElementById('settings-dropdown');
            if (dd && dd.classList.contains('open')) { dd.classList.remove('open'); return; }
            if (_replay.active) { stopReplay(); return; }
            if (_isTypingTarget(e.target)) { e.target.blur(); return; }
            clearHighlight();
            clearDetail();
            clearLegendHighlight();
            _fvUnpin();
            return;
        }

        if (_isTypingTarget(e.target)) return;
        if (e.key === '?') { e.preventDefault(); toggleHelpOverlay(); return; }
        if (_helpOpen()) return;      // don't drive the app from behind the dialog
        if (_replayKey(e)) return;
        // Shift is held while shift-clicking a path; don't also fire letter shortcuts.
        if (e.shiftKey) return;

        const click = (id) => { const b = document.getElementById(id); if (b) b.click(); };
        switch (e.key.toLowerCase()) {
            case 'f': e.preventDefault(); click('btn-fit'); break;
            case 'c': e.preventDefault(); click('btn-credibility'); break;
            case 'r': e.preventDefault(); click('btn-audit'); break;
            case 'h': e.preventDefault(); toggleHealthStrip(); break;
            case 'a': e.preventDefault(); toggleActivityPanel(); break;
            case 'p': e.preventDefault(); toggleReplay(); break;
            case 'o': e.preventDefault(); _setLayoutMode('organic'); break;
            case 'd': e.preventDefault(); _setLayoutMode('dagre'); break;
            case 't': e.preventDefault(); _setLayoutMode('timeline'); break;
            case 'g': e.preventDefault(); setFocusMode('graph'); break;
            case 's': e.preventDefault(); setFocusMode('split'); break;
            case 'w': e.preventDefault(); setFocusMode('panels'); break;
            case 'v': e.preventDefault(); setFocusView(!_fv.on); break;
            case '/': {
                e.preventDefault();
                const s = document.getElementById('search-input');
                if (s) { s.focus(); s.select(); }
                break;
            }
            default: break;
        }
    });
}


// ============================================================================
// ACTIVITY PANEL — fold the right column into a rail at the window edge.
//
// Same idea as the graph-health card's caret, applied to the whole column, because
// the reason to hide it is to give the canvas the width. Rows that arrive while it
// is folded are counted on the rail, so hiding it never means missing something.
// A workspace preference, so it is remembered per browser.
// ============================================================================
let _activityCollapsed = false;
let _activityUnseen = 0;

function _paintActivityUnseen() {
    const c = document.getElementById('activity-rail-count');
    if (!c) return;
    c.textContent = _activityUnseen > 99 ? '99+' : String(_activityUnseen);
    c.hidden = _activityUnseen === 0;
}

function setActivityCollapsed(collapsed, { persist = true } = {}) {
    const panel = document.getElementById('right-panel');
    if (!panel) return;
    _activityCollapsed = collapsed;
    panel.dataset.collapsed = collapsed ? 'true' : 'false';
    const toggle = document.getElementById('activity-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
    const rail = document.getElementById('activity-rail');
    if (rail) rail.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) { _activityUnseen = 0; _paintActivityUnseen(); }
    if (persist) {
        try { localStorage.setItem('elg.activity.collapsed', collapsed ? '1' : '0'); } catch (e) { /* no storage */ }
    }
    refitGraph({ delay: 380 });   // the canvas changes width with the column
}

function toggleActivityPanel() {
    setActivityCollapsed(!_activityCollapsed);
}

// Called by logActivity. Seeding the log from the loaded graph is not news.
function _noteActivityWhileFolded(kind) {
    if (!_activityCollapsed || !_activitySeeded || kind === 'system') return;
    _activityUnseen += 1;
    _paintActivityUnseen();
}

function initActivityPanel() {
    const toggle = document.getElementById('activity-toggle');
    if (toggle) toggle.addEventListener('click', () => setActivityCollapsed(true));
    const rail = document.getElementById('activity-rail');
    if (rail) rail.addEventListener('click', () => setActivityCollapsed(false));
    let saved = false;
    try { saved = localStorage.getItem('elg.activity.collapsed') === '1'; } catch (e) { /* no storage */ }
    if (saved) setActivityCollapsed(true, { persist: false });
}

// ============================================================================
// REPLAY — watch the graph form, one event at a time, and stop at any step.
//
// The log is append-only, so the graph at any moment is the log up to that moment.
// GET /replay names every step by the element ids already on the canvas, so the
// player reveals the final layout element by element instead of re-laying the graph
// out at every step: nothing moves except what arrives. Credibility is the one thing
// that changes in place, so scores are fetched for the graph as it stood
// (GET /replay/scores) and the dials show what a reader would have seen at that step
// — a claim that starts red and turns green as its evidence lands is the story.
//
// While replaying, the live stream is held back (the canvas is showing the past);
// leaving replay reloads the graph if anything arrived in the meantime.
// ============================================================================
const REPLAY_STEP_MS = 650;                 // one step at 1x
const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];

const _replay = {
    active: false, steps: [], at: -1, playing: false, timer: null, speed: 1,
    birth: new Map(),        // element id -> first step it exists at
    byStep: new Map(),       // step -> element ids revealed at it
    counts: [],              // step -> [nodes, edges] on the canvas after it
    saved: null,             // claim/conclusion id -> score before replay began
    scores: new Map(),       // event index -> scores as they stood then
    inflight: false,
    missedLive: false,
};

// Appended to both stylesheets (see applyStylesheet), coloured from the theme.
function replayStyle() {
    return [
        { selector: '.replay-hidden', style: { 'display': 'none' } },
        {
            selector: 'node.replay-current',
            style: { 'border-width': 3, 'border-color': PAL.pick, 'border-opacity': 1, 'z-index': 25 },
        },
        {
            selector: 'edge.replay-current',
            style: {
                'line-fill': 'solid', 'line-style': 'solid', 'line-color': PAL.pick,
                'width': 2.6, 'opacity': 1, 'z-index': 24,
            },
        },
    ];
}

function _replayIndex(steps) {
    const birth = new Map(), byStep = new Map();
    steps.forEach(s => {
        const ids = [];
        const born = (id) => { if (!birth.has(id)) { birth.set(id, s.step); ids.push(id); } };
        (s.implied_nodes || []).forEach(born);
        if (s.kind === 'node' || s.kind === 'edge') born(s.id);
        byStep.set(s.step, ids);
    });
    return { birth, byStep };
}

// Running totals of what is on the canvas after each step, counted off the canvas
// itself, so the bar can never claim a node the graph is not showing.
function _replayCounts(n) {
    const nodes = new Array(n).fill(0), edges = new Array(n).fill(0);
    cy.elements().forEach(el => {
        if (el.hasClass('cluster-label') || el.hasClass('summary-node')) return;
        const b = _replayBirthOf(el);
        if (b >= 0 && b < n) (el.isNode() ? nodes : edges)[b] += 1;
    });
    const out = [];
    let a = 0, c = 0;
    for (let i = 0; i < n; i++) { a += nodes[i]; c += edges[i]; out.push([a, c]); }
    return out;
}

// Viewer scaffolding the log cannot name (cluster captions, a collapsed-branch
// marker) is shown throughout; an unnamed edge appears with the later of its ends.
function _replayBirthOf(el) {
    const b = _replay.birth.get(el.id());
    if (b != null) return b;
    if (el.isEdge()) return Math.max(_replayBirthOf(el.source()), _replayBirthOf(el.target()));
    return -1;
}

function _replayShow(at, { animate = false } = {}) {
    const prev = _replay.at;
    _replay.at = at;
    cy.batch(() => {
        if (at === prev + 1 && at >= 0) {
            // One step forward: touch only what this step reveals.
            (_replay.byStep.get(at) || []).forEach(id => cy.getElementById(id).removeClass('replay-hidden'));
        } else {
            cy.elements().forEach(el => el.toggleClass('replay-hidden', _replayBirthOf(el) > at));
        }
        cy.elements('.replay-current').removeClass('replay-current');
        const s = _replay.steps[at];
        if (s) cy.getElementById(s.id).addClass('replay-current');
    });
    const s = _replay.steps[at];
    if (animate && s && s.kind === 'node' && organicMode && _motionOK) {
        supernova.set(s.id, { t0: performance.now(), dur: 900, birth: true });
    }
    _replayPaint();
    _replayScores();
    scheduleGlow();
    drawMinimap();
}

function _replayApplyScores(scores) {
    cy.batch(() => {
        cy.nodes().forEach(n => {
            const nt = n.data('node_type');
            if (nt !== 'claim' && nt !== 'conclusion') return;
            const s = scores[n.id()];
            if (s) n.data('credibility_score', s.score);
            else n.removeData('credibility_score');
            if (credibilityMode) {
                n.data('color', s ? _credColor(s.score)
                    : (nt === 'conclusion' ? NODE_TYPE_COLORS.conclusion : NODE_TYPE_COLORS.claim));
            }
        });
    });
    if (organicMode) applyDegreeScaling();
    scheduleGlow();
}

// One request in flight at most, and the answer only lands if it is still the step
// on screen: at 8x a request per step would queue far behind the player.
async function _replayScores() {
    const s = _replay.steps[_replay.at];
    if (!s) { _replayApplyScores({}); return; }
    const upto = s.event;
    if (_replay.scores.has(upto)) { _replayApplyScores(_replay.scores.get(upto)); return; }
    if (_replay.inflight) return;
    _replay.inflight = true;
    try {
        const r = await fetch(`${API_BASE}/replay/scores?upto=${upto}`);
        if (r.ok) _replay.scores.set(upto, (await r.json()).scores || {});
    } catch (e) { /* the dials keep their last values */ }
    _replay.inflight = false;
    if (!_replay.active) return;
    const now = _replay.steps[_replay.at];
    if (now && now.event === upto) _replayApplyScores(_replay.scores.get(upto) || {});
    else if (now) _replayScores();     // the player moved on while we waited
}

function _replayCaption(s) {
    if (!s) return { html: 'The beginning — nothing has been recorded yet. Press <b>play</b> or step forward.', color: null };
    const typeLabel = (t) => NODE_TYPE_LABELS[t] || t || 'node';
    let html, color;
    if (s.kind === 'node') {
        html = `<b>${_esc(typeLabel(s.node_type))}</b> ${_esc(s.id)} · “${_esc(s.label)}”`;
        color = NODE_TYPE_COLORS[s.node_type];
    } else if (s.kind === 'edge') {
        const how = s.policy === 'manual' ? 'declared'
            : `inferred · ${EDGE_POLICY_LABELS[s.policy] || s.policy}`;
        html = `<b>${_esc(EDGE_TYPE_LABELS[s.edge_type] || prettifyEdgeType(s.edge_type) || 'Edge')}</b> `
            + `${_esc(s.source)} → ${_esc(s.target)} <span class="rp-dim">(${_esc(how)})</span>`;
        color = (EDGE_TYPE_STYLES[s.edge_type] || {}).color;
    } else if (s.kind === 'update') {
        html = `<b>Updated</b> ${_esc(s.id)}` + (s.fields && s.fields.length
            ? ` · ${_esc(s.fields.join(', '))}` : '');
        color = PULSE_COLOR_UPDATE;
    } else if (s.kind === 'delete') {
        const n = (s.edges || []).length;
        html = `<b>Removed</b> ${_esc(s.id)}` + (n ? ` and its ${n} edge${n === 1 ? '' : 's'}` : '');
        color = CRED_COLORS.red;
    } else {
        html = `<b>Score set</b> on ${_esc(s.id)}` + (typeof s.score === 'number' ? `: ${s.score.toFixed(2)}` : '');
        color = PULSE_COLOR_UPDATE;
    }
    if (s.gone) html += ' <span class="rp-dim">— removed later, so it is not on the canvas</span>';
    return { html, color };
}
const PULSE_COLOR_UPDATE = '#D79921';

function _replayPaint() {
    const bar = document.getElementById('elg-replay');
    if (!bar) return;
    const n = _replay.steps.length, at = _replay.at;
    bar.querySelector('.rp-scrub').value = String(at + 1);
    bar.querySelector('.rp-count').textContent = `${at + 1} / ${n}`;
    const play = bar.querySelector('[data-act="play"]');
    play.innerHTML = _replay.playing ? _RP_ICONS.pause : _RP_ICONS.play;
    play.setAttribute('aria-label', _replay.playing ? 'Pause (Space)' : 'Play (Space)');
    play.title = play.getAttribute('aria-label');

    const s = _replay.steps[at];
    const cap = _replayCaption(s);
    bar.querySelector('.rp-text').innerHTML = at === n - 1
        ? cap.html + ' <span class="rp-dim">— end of the log: this is the graph as it stands now.</span>'
        : cap.html;
    const dot = bar.querySelector('.rp-dot');
    dot.hidden = !cap.color;
    if (cap.color) dot.style.background = cap.color;
    const [nodes, edges] = at >= 0 ? _replay.counts[at] : [0, 0];
    let meta = `${nodes} node${nodes === 1 ? '' : 's'} · ${edges} edge${edges === 1 ? '' : 's'}`;
    if (s) {
        const t = new Date(s.t);
        if (!isNaN(t)) meta += ' · ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (s.actor) meta += ' · ' + s.actor;
    }
    bar.querySelector('.rp-meta').textContent = meta;
}

function _replayPlay(on) {
    _replay.playing = on;
    clearTimeout(_replay.timer);
    if (on && _replay.at >= _replay.steps.length - 1) _replayShow(-1);   // play again from the top
    if (on) _replayTick();
    _replayPaint();
}

function _replayTick() {
    _replay.timer = setTimeout(() => {
        if (!_replay.active || !_replay.playing) return;
        if (_replay.at >= _replay.steps.length - 1) { _replayPlay(false); return; }
        _replayShow(_replay.at + 1, { animate: true });
        _replayTick();
    }, REPLAY_STEP_MS / _replay.speed);
}

// Every manual move pauses: stepping is how you stop at a step and look at it.
function _replayGo(at) {
    if (_replay.playing) _replayPlay(false);
    const clamped = Math.max(-1, Math.min(_replay.steps.length - 1, at));
    if (clamped !== _replay.at) _replayShow(clamped, { animate: clamped === _replay.at + 1 });
}

const _RP_ICONS = {
    start: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h2v10H2zM9 3v10L4 8zM15 3v10l-5-5z"/></svg>',
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h2v10H3zM13 3v10L6 8z"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11L13 8z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>',
    fwd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3v10l7-5zM11 3h2v10h-2z"/></svg>',
    end: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3v10l5-5zM7 3v10l5-5zM12 3h2v10h-2z"/></svg>',
};

function _replayBar() {
    let bar = document.getElementById('elg-replay');
    if (bar) return bar;
    const area = document.querySelector('.graph-area');
    if (!area) return null;
    bar = document.createElement('section');
    bar.id = 'elg-replay';
    bar.className = 'elg-replay';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Replay');
    bar.hidden = true;

    const controls = document.createElement('div');
    controls.className = 'rp-controls';
    const btn = (act, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.act = act;
        b.className = 'rp-btn' + (act === 'play' ? ' rp-play' : '');
        b.innerHTML = _RP_ICONS[act] || '';
        b.setAttribute('aria-label', label);
        b.title = label;
        return b;
    };
    controls.append(
        btn('start', 'Back to the start (Home)'),
        btn('back', 'One step back (←)'),
        btn('play', 'Play (Space)'),
        btn('fwd', 'One step forward (→)'),
        btn('end', 'Jump to the end (End)'),
    );
    const scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'rp-scrub';
    scrub.min = '0';
    scrub.step = '1';
    scrub.setAttribute('aria-label', 'Replay position');
    const count = document.createElement('span');
    count.className = 'rp-count';
    const speed = document.createElement('select');
    speed.className = 'rp-speed';
    speed.setAttribute('aria-label', 'Replay speed');
    REPLAY_SPEEDS.forEach(v => {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = `${v}×`;
        if (v === 1) o.selected = true;
        speed.appendChild(o);
    });
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.dataset.act = 'exit';
    exit.className = 'rp-exit';
    exit.textContent = 'Exit replay';
    exit.title = 'Back to the live graph (Esc)';
    controls.append(scrub, count, speed, exit);

    const caption = document.createElement('div');
    caption.className = 'rp-caption';
    const dot = document.createElement('span');
    dot.className = 'rp-dot';
    const text = document.createElement('span');
    text.className = 'rp-text';
    const meta = document.createElement('span');
    meta.className = 'rp-meta';
    caption.append(dot, text, meta);

    bar.append(controls, caption);
    area.appendChild(bar);

    controls.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'play') _replayPlay(!_replay.playing);
        else if (act === 'back') _replayGo(_replay.at - 1);
        else if (act === 'fwd') _replayGo(_replay.at + 1);
        else if (act === 'start') _replayGo(-1);
        else if (act === 'end') _replayGo(_replay.steps.length - 1);
        else if (act === 'exit') stopReplay();
    });
    scrub.addEventListener('input', () => _replayGo(Number(scrub.value) - 1));
    speed.addEventListener('change', () => {
        _replay.speed = Number(speed.value) || 1;
        if (_replay.playing) _replayPlay(true);
    });
    return bar;
}

async function startReplay() {
    if (_replay.active || !cy) return;
    if (_fv.on) setFocusView(false, { persist: false });
    let data;
    try {
        const r = await fetch(`${API_BASE}/replay`);
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        data = await r.json();
    } catch (e) {
        logActivity('system', `replay unavailable — ${_esc(e.message || e)}`, CRED_COLORS.red);
        return;
    }
    const steps = data.steps || [];
    if (!steps.length) {
        logActivity('system', 'nothing to replay yet — the log is empty', '#A89984');
        return;
    }
    const bar = _replayBar();
    if (!bar) return;
    clearHighlight();
    Object.assign(_replay, _replayIndex(steps));
    _replay.steps = steps;
    _replay.counts = _replayCounts(steps.length);
    _replay.active = true;
    _replay.at = -2;           // forces a full pass on the first show
    _replay.missedLive = false;
    _replay.scores = new Map();
    _replay.saved = new Map(cy.nodes().map(n => [n.id(), n.data('credibility_score')]));
    bar.querySelector('.rp-scrub').max = String(steps.length);
    bar.hidden = false;
    document.body.classList.add('replaying');
    const b = document.getElementById('btn-replay');
    if (b) b.classList.add('active');
    _replayShow(-1);
    _replayPlay(true);
}

function stopReplay() {
    if (!_replay.active) return;
    _replay.active = false;
    _replayPlay(false);
    const bar = document.getElementById('elg-replay');
    if (bar) bar.hidden = true;
    document.body.classList.remove('replaying');
    const b = document.getElementById('btn-replay');
    if (b) b.classList.remove('active');
    cy.elements().removeClass('replay-hidden replay-current');
    if (_replay.missedLive) { loadGraph(); return; }   // events arrived meanwhile
    cy.batch(() => {
        cy.nodes().forEach(n => {
            if (!_replay.saved.has(n.id())) return;
            const s = _replay.saved.get(n.id());
            if (s == null) n.removeData('credibility_score');
            else n.data('credibility_score', s);
            const nt = n.data('node_type');
            if (nt === 'claim' || nt === 'conclusion') {
                n.data('color', credibilityMode && s != null ? _credColor(s)
                    : (nt === 'conclusion' ? NODE_TYPE_COLORS.conclusion : NODE_TYPE_COLORS.claim));
            }
        });
    });
    applyDegreeScaling();
    scheduleGlow();
    drawMinimap();
}

function toggleReplay() {
    if (_replay.active) stopReplay();
    else startReplay();
}

// Keys while the player is up. Returns true when it handled the key.
function _replayKey(e) {
    if (!_replay.active) return false;
    if (e.key === ' ') { _replayPlay(!_replay.playing); }
    else if (e.key === 'ArrowRight') { _replayGo(_replay.at + 1); }
    else if (e.key === 'ArrowLeft') { _replayGo(_replay.at - 1); }
    else if (e.key === 'Home') { _replayGo(-1); }
    else if (e.key === 'End') { _replayGo(_replay.steps.length - 1); }
    else return false;
    e.preventDefault();
    return true;
}

function initReplay() {
    const b = document.getElementById('btn-replay');
    if (b) b.addEventListener('click', toggleReplay);
}


// ============================================================================
// FOCUS VIEW — the same graph, drawn for reading rather than exploring.
//
// The galaxy is good at showing how much is going on and poor at showing what it
// adds up to: edges tangle, and nothing says which way the evidence flows. This is a
// second, read-only drawing of the graph over the canvas that answers that question.
// It is opt-in from the header (or V) and remembered per browser, like the window
// switch beside it.
//
// It has its own Cytoscape instance and reads the main graph's data, so turning it
// on and off never disturbs the view underneath: positions, folded branches, filters
// and effects are all where they were left.
//
// Three independent choices, each a switch on its toolbar:
//   layout   flow     one column per stage, left to right, ending in the verdicts
//            rings    the motivation at the centre, one orbit per stage
//            galaxy   the main view's force layout, in the cleaner styling
//   colour   types    the node-type colours
//            calm     one blue ramp for the chain; colour kept for the verdicts
//   labels   verdicts | all
// ============================================================================

// Column in the flow, orbit in the rings: the order evidence is produced in.
const FV_STAGE = { motivation: 0, rq: 1, hypothesis: 2, experiment_design: 3, artifact: 4,
                      run: 5, result: 6, claim: 7, conclusion: 7 };
const FV_STAGE_NAMES = ['Motivation', 'Question', 'Hypothesis', 'Experiment', 'Artifact',
                           'Run', 'Result', 'Verdict'];
// Calm colours the chain by tier on ONE hue (an ordinal ramp), which leaves colour free
// for the two things that matter: the verdicts and their scores.
const FV_TIER = { motivation: 0, rq: 0, hypothesis: 0, experiment_design: 1, artifact: 1,
                     run: 2, result: 3 };
const FV_TIER_NAMES = [['Framing', 'motivation, question, hypothesis'],
                          ['Plan', 'experiment, artifact'], ['Execution', 'run'],
                          ['Evidence', 'result']];
const FV_CHOICES = { layout: ['flow', 'rings', 'galaxy'], palette: ['types', 'calm'],
                        labels: ['verdicts', 'all'] };
// Text: the labels' size as a percentage of the default. The slider in the bar uses
// the same bounds.
const FV_TEXT = { min: 80, max: 180, step: 10, base: 100 };
// The ramps passed the dataviz palette validator in both themes (lightness band,
// chroma, colour-blind and normal-vision separation). Red, amber and green cannot be
// made colour-blind-safe by any choice of shade, which is why the ring's length and
// the printed score carry a claim's rating as well.
const FV_THEMES = {
    dark: {
        ground: '#0a0a0c', ink: '#ece7db', muted: '#9b958a', edge: '#cfc8e0', accent: '#a78bfa',
        ramp: ['#256abf', '#3987e5', '#6da7ec', '#b7d3f6'],
        cred: { green: '#3fb950', yellow: '#e3a008', red: '#e5534b' },
        track: 'rgba(236,231,219,0.14)', orbit: 'rgba(236,231,219,0.06)', edgeOpacity: 0.22,
    },
    light: {
        ground: '#f6f5f2', ink: '#1f1d24', muted: '#67626f', edge: '#4a4458', accent: '#6d4fd1',
        ramp: ['#6da7ec', '#3987e5', '#1c5cab', '#0d366b'],
        cred: { green: '#1f9d3a', yellow: '#d98e04', red: '#d03b3b' },
        track: 'rgba(31,29,36,0.12)', orbit: 'rgba(31,29,36,0.07)', edgeOpacity: 0.26,
    },
};
// Cytoscape's font-family parser accepts double quotes only; a single-quoted name
// fails validation and the label silently falls back to its default font.
const FV_FONT = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
const FV_COL = 168;          // flow: distance between stage columns
const FV_PAD = 48;           // frame padding

const _fv = {
    on: false,
    layout: 'flow', palette: 'types', labels: 'verdicts',
    text: FV_TEXT.base,
    // What this browser chose, and the only thing _fvSave() writes. A ?view= link
    // changes what is drawn (on, layout) for one page load and never lands here, so
    // picking a colour on a shared link doesn't also save the link's view as yours.
    prefs: {},
    cy: null,
    rings: null,        // orbit radii, for the guides the rings layout draws
    pinned: null,       // the clicked node whose lineage stays lit
    moved: false,       // the reader has panned or zoomed since the last fit
    timer: null,
};

function _fvTheme() {
    return FV_THEMES[_themeName()] || FV_THEMES.light;
}

function _fvRgba(hex, a) {
    const c = _hexToRgb(hex);
    return `rgba(${c.r},${c.g},${c.b},${a})`;
}

function _fvTypeColor(d) {
    return NODE_TYPE_COLORS[d.node_type] || d.color || '#A89984';
}

// ---- Data ------------------------------------------------------------------------
// The main graph's data, plus any branch folded away there: a fold is a way of
// looking, not a change to the evidence.
function _fvSource() {
    const nodes = new Map(), edges = new Map();
    cy.nodes().forEach(n => {
        if (n.hasClass('cluster-label') || n.hasClass('summary-node')) return;
        nodes.set(n.id(), { ...n.data() });
    });
    cy.edges().forEach(e => edges.set(e.id(), { ...e.data() }));
    collapsedNodes.forEach(info => info.removedJson.forEach(j => {
        (j.group === 'nodes' ? nodes : edges).set(j.data.id, { ...j.data });
    }));
    return {
        nodes: [...nodes.values()],
        edges: [...edges.values()].filter(e => nodes.has(e.source) && nodes.has(e.target)),
    };
}

function _fvElements() {
    const src = _fvSource();
    const stage = new Map();
    src.nodes.forEach(n => { if (n.node_type in FV_STAGE) stage.set(n.id, FV_STAGE[n.node_type]); });
    // Anything off the known chain (facts, a custom type) sits one column before the
    // earliest node it feeds.
    src.nodes.forEach(n => {
        if (stage.has(n.id)) return;
        const outs = src.edges.filter(e => e.source === n.id).map(e => stage.get(e.target))
            .filter(s => s != null);
        stage.set(n.id, outs.length ? Math.max(0, Math.min(...outs) - 1) : 0);
    });
    const nodes = src.nodes.map(n => ({
        group: 'nodes',
        classes: 'fv-node'
            + (n.node_type === 'claim' || n.node_type === 'conclusion' ? ' fv-verdict' : '')
            + (n.node_type === 'facts' ? ' fv-facts' : ''),
        data: { ...n, fvStage: stage.get(n.id) },
    }));
    return nodes.concat(src.edges.map(e => ({ group: 'edges', data: e })));
}

// Sizes, fills and edge colours for the chosen palette, written into data so the
// stylesheet stays a plain mapping.
function _fvPaint(cv, T) {
    const calm = _fv.palette === 'calm';
    cv.nodes('.fv-node').forEach(n => {
        const d = n.data(), t = d.node_type;
        const rating = t === 'claim' ? _credRating(d.credibility_score) : null;
        let size = 10 + Math.min(6, n.degree() * 0.7);
        if (t === 'result') size = 14;
        else if (t === 'claim') size = 19;
        else if (t === 'conclusion') size = 27;
        else if (t === 'facts') size = 10;
        let fill;
        if (t === 'facts') fill = T.ground;                 // hollow: outside knowledge
        else if (!calm) fill = _fvTypeColor(d);
        else if (t === 'conclusion') fill = T.accent;
        else if (t === 'claim') fill = rating ? T.cred[rating] : T.muted;
        else fill = T.ramp[FV_TIER[t] ?? 0];
        const label = String(d.label || d.id);
        // A short name fits one flow column at the default text size. Bigger text gets
        // fewer characters, so neighbouring columns never run together; hover shows it whole.
        const room = Math.round(26 * 100 / Math.max(100, _fv.text));
        n.data({
            fvSize: size, fvFill: fill, fvRating: rating,
            fvLabel: rating ? `${Number(d.credibility_score).toFixed(2)}  ${label}` : label,
            fvShort: label.length > room ? label.slice(0, room - 1) + '…' : label,
        });
    });
    cv.edges().forEach(e => {
        const src = e.source(), tgt = e.target();
        const tt = tgt.data('node_type');
        let col = calm ? T.edge : _fvTypeColor(src.data());
        let w = 1.15, op = calm ? T.edgeOpacity : 0.45;
        // Calm: what feeds a verdict takes the verdict's colour, so support reads at
        // a glance.
        if (calm && tt === 'claim') {
            const r = tgt.data('fvRating');
            col = r ? T.cred[r] : T.edge; w = 1.7; op = 0.55;
        }
        if (calm && tt === 'conclusion') { col = T.accent; w = 1.9; op = 0.6; }
        // Outside knowledge is context, not lineage: a faint dotted thread.
        if (src.hasClass('fv-facts')) { col = T.muted; op = 0.35; w = 1.2; e.addClass('fv-context'); }
        else if (!_edgeDeclared(e)) e.addClass('fv-inferred');
        e.data({ fvColor: col, fvWidth: w, fvOpacity: op });
    });
}

function _fvStyle(T) {
    const f = _fv.text / 100;
    return [
        { selector: 'node.fv-node', style: {
            'width': 'data(fvSize)', 'height': 'data(fvSize)',
            'background-color': 'data(fvFill)',
            // A ring in the ground colour punches overlapping dots apart.
            'border-width': 2, 'border-color': T.ground,
            'label': '', 'font-family': FV_FONT, 'font-size': 10 * f, 'color': T.ink,
            'min-zoomed-font-size': 5,
            'transition-property': 'opacity', 'transition-duration': '160ms',
        } },
        { selector: 'node.fv-facts', style: {
            'border-width': 1.6, 'border-color': T.muted, 'border-style': 'dashed',
        } },
        { selector: 'node.fv-minor', style: {
            'label': 'data(fvShort)', 'font-size': 9 * f, 'color': T.muted,
            'text-valign': 'bottom', 'text-margin-y': 5,
        } },
        { selector: 'node.fv-verdict', style: {
            // The wrap width grows with the type, so a label keeps its line breaks.
            'label': 'data(fvLabel)', 'font-size': 11 * f, 'font-weight': 600,
            'text-wrap': 'wrap', 'text-max-width': 230 * f, 'text-valign': 'center',
            'text-background-color': T.ground, 'text-background-opacity': 0.8,
            'text-background-padding': 2, 'text-background-shape': 'roundrectangle',
            'z-index': 10,
        } },
        { selector: 'node.fv-verdict[node_type = "conclusion"]', style: { 'font-size': 12 * f, 'font-weight': 700 } },
        { selector: 'node.fv-right', style: { 'text-halign': 'right', 'text-margin-x': 14, 'text-justification': 'left' } },
        { selector: 'node.fv-left', style: { 'text-halign': 'left', 'text-margin-x': -14, 'text-justification': 'right' } },
        { selector: 'node.fv-header', style: {
            'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0,
            'label': 'data(label)', 'font-family': FV_FONT, 'font-size': 10 * f, 'font-weight': 600,
            'text-transform': 'uppercase', 'color': T.muted, 'text-valign': 'center',
            'events': 'no',
        } },
        { selector: 'edge', style: {
            'width': 'data(fvWidth)', 'line-color': 'data(fvColor)', 'opacity': 'data(fvOpacity)',
            'curve-style': 'straight', 'line-cap': 'round', 'target-arrow-shape': 'none',
            'transition-property': 'opacity, width', 'transition-duration': '160ms',
        } },
        // Inferred edges stay visibly broken, exactly as they are in the main view.
        { selector: 'edge.fv-inferred', style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] } },
        { selector: 'edge.fv-context', style: { 'line-style': 'dashed', 'line-dash-pattern': [1, 4] } },
        { selector: 'node.fv-dim', style: { 'opacity': 0.13 } },
        { selector: 'edge.fv-dim', style: { 'opacity': 0.04 } },
        { selector: 'edge.fv-lit', style: { 'opacity': 0.95, 'width': 2.2, 'z-index': 9 } },
        { selector: 'node.fv-focus', style: { 'border-color': T.accent, 'border-width': 3 } },
    ];
}

// ---- Layouts ---------------------------------------------------------------------
// Place items along a line at their wanted coordinates, at least gapOf() apart, then
// shift the run back over its wanted centre.
function _fvSpreadLine(items, gapOf) {
    let prev = null;
    for (const it of items) {
        it.at = prev == null ? it.want : Math.max(it.want, prev.at + (gapOf(prev) + gapOf(it)) / 2);
        prev = it;
    }
    const off = items.reduce((a, it) => a + it.at - it.want, 0) / (items.length || 1);
    for (const it of items) it.at -= off;
}

// The same on a circle: cut it at the widest empty arc so the run never wraps onto
// itself, then spread it as a line.
function _fvSpreadCircle(items, gap) {
    const TAU = Math.PI * 2;
    if (!items.length) return;
    const g = Math.min(gap, TAU / items.length);
    items.sort((p, q) => p.want - q.want);
    let cut = 0, best = -1;
    items.forEach((it, i) => {
        const nx = items[(i + 1) % items.length];
        const d = items.length === 1 ? TAU : ((nx.want - it.want) % TAU + TAU) % TAU;
        if (d > best) { best = d; cut = (i + 1) % items.length; }
    });
    const run = items.slice(cut).concat(items.slice(0, cut));
    const base = run[0].want;
    run.forEach(it => { it.want = base + (((it.want - base) % TAU) + TAU) % TAU; });
    _fvSpreadLine(run, () => g);
}

// Bend an edge through the given model-space points, written as unbundled-bezier
// weights and distances relative to its own source->target line.
function _fvCurve(e, pts) {
    const a = e.source().position(), b = e.target().position();
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy, L = Math.sqrt(L2);
    if (L < 1) return;
    const w = [], d = [];
    for (const p of pts) {
        const px = p.x - a.x, py = p.y - a.y;
        w.push((px * vx + py * vy) / L2);
        d.push((vx * py - vy * px) / L);
    }
    e.style({ 'curve-style': 'unbundled-bezier', 'edge-distances': 'node-position',
              'control-point-weights': w, 'control-point-distances': d });
}

// Flow: one column per stage, left to right. The order inside a column minimises
// crossings (alternating barycentre sweeps), and edges are S-curves with level
// tangents at both ends.
function _fvFlow(cv) {
    const cols = new Map();
    cv.nodes('.fv-node').forEach(n => {
        const s = n.data('fvStage');
        if (!cols.has(s)) cols.set(s, []);
        cols.get(s).push(n);
    });
    if (!cols.size) return;
    const stages = [...cols.keys()].sort((a, b) => a - b);
    // Bigger text stacks taller, so the rows open up with it. The columns stay put:
    // widening them would only make the fit zoom out and undo the bigger text.
    const g = Math.max(1, _fv.text / 100);
    const X = new Map(stages.map((s, i) => [s, i * FV_COL]));
    const Y = new Map();
    const gapOf = it => it.n.hasClass('fv-verdict') ? 70 * g : (_fv.labels === 'all' ? 46 * g : 38);
    for (const s of stages) {
        const items = cols.get(s).map((n, i) => ({ n, want: i * 40 }));
        _fvSpreadLine(items, gapOf);
        items.forEach(it => Y.set(it.n.id(), it.at));
    }
    for (let pass = 0; pass < 12; pass++) {
        const fwd = pass % 2 === 0;
        for (const s of (fwd ? stages : [...stages].reverse())) {
            const items = cols.get(s).map(n => {
                const ref = n.neighborhood('node.fv-node').filter(m =>
                    fwd ? m.data('fvStage') < s : m.data('fvStage') > s);
                const want = ref.length
                    ? ref.reduce((a, m) => a + Y.get(m.id()), 0) / ref.length
                    : Y.get(n.id());
                return { n, want };
            }).sort((a, b) => a.want - b.want);
            _fvSpreadLine(items, gapOf);
            items.forEach(it => Y.set(it.n.id(), it.at));
        }
    }
    // Eight columns make a wide, short band. Stretch it towards the canvas's own
    // proportions (up to 2.4x) so it fills the frame rather than a strip across it.
    const ys = [...Y.values()];
    const y0 = Math.min(...ys), span = (Math.max(...ys) - y0) || 1;
    const width = (stages.length - 1) * FV_COL + 260 * g;
    const aspect = cv.width() > 0 ? cv.height() / cv.width() : 0.56;
    const k = Math.min(2.4, Math.max(1, (width * aspect * 0.8) / span));
    cv.nodes('.fv-node').forEach(n => n.position({ x: X.get(n.data('fvStage')), y: Y.get(n.id()) * k }));
    cv.nodes('.fv-verdict').addClass('fv-right');
    cv.add(stages.map(s => ({
        group: 'nodes', classes: 'fv-header',
        data: { id: `_fv_header_${s}`, label: FV_STAGE_NAMES[s] || '' },
        position: { x: X.get(s), y: y0 * k - 56 },
    })));
    cv.edges().forEach(e => {
        const a = e.source().position(), b = e.target().position();
        const dx = b.x - a.x;
        if (Math.abs(dx) < 1) {
            // Same column (a claim bearing on another claim): bow out to the left,
            // away from the labels, rather than a stiff vertical rule.
            if (Math.abs(b.y - a.y) > 1) _fvCurve(e, [{ x: a.x - 46, y: (a.y + b.y) / 2 }]);
            return;
        }
        if (dx < 0 || Math.abs(b.y - a.y) < 1) return;
        _fvCurve(e, [{ x: a.x + dx * 0.5, y: a.y }, { x: b.x - dx * 0.5, y: b.y }]);
    });
}

// Rings: the motivation at the centre, each stage one orbit further out, the verdicts
// on the rim where their labels have room. The research radiates out to what it found.
function _fvRings(cv) {
    const TAU = Math.PI * 2;
    const chain = cv.nodes('.fv-node').not('.fv-facts');
    if (chain.empty()) return;
    const stages = [...new Set(chain.map(n => n.data('fvStage')))].sort((a, b) => a - b);
    const ringOf = new Map(stages.map((s, k) => [s, k]));
    const roots = chain.filter(n => n.data('fvStage') === stages[0]);
    // Inner orbits are sparse, so they sit close; the verdict rim gets extra room.
    const R = s => {
        const k = ringOf.get(s);
        if (k === 0 && roots.length === 1) return 0;
        return 46 + k * 58 + (s === 7 ? 40 : 0);
    };

    // A spanning tree: each node hangs off one parent in the nearest earlier stage it
    // touches. Cross links stay edges; they just don't steer the placement.
    const kids = new Map(), parent = new Map();
    chain.forEach(n => kids.set(n.id(), []));
    chain.sort((a, b) => a.data('fvStage') - b.data('fvStage')).forEach(n => {
        const s = n.data('fvStage');
        const cands = n.neighborhood('node.fv-node').not('.fv-facts').filter(m => m.data('fvStage') < s);
        if (!cands.length) return;
        const best = cands.max(m => m.data('fvStage') * 1000 - kids.get(m.id()).length).ele;
        parent.set(n.id(), best.id());
        kids.get(best.id()).push(n);
    });
    // Leaf weight: how much of the circle a branch needs.
    const weight = new Map();
    const w = n => {
        if (!weight.has(n.id())) {
            weight.set(n.id(), Math.max(1, kids.get(n.id()).reduce((a, k) => a + w(k), 0)));
        }
        return weight.get(n.id());
    };
    const A = new Map();
    const assign = (list, a0, a1) => {
        const tot = list.reduce((a, n) => a + w(n), 0);
        let a = a0;
        for (const n of list) {
            const span = (a1 - a0) * w(n) / tot;
            A.set(n.id(), a + span / 2);
            assign(kids.get(n.id()), a, a + span);
            a += span;
        }
    };
    // The roots, plus any node with no earlier-stage neighbour, share the circle.
    assign(chain.filter(n => !parent.has(n.id())).toArray(), -Math.PI / 2, -Math.PI / 2 + TAU);

    // A verdict draws on several results, not just its tree parent: sit it at the mean
    // angle of all of them, then keep the verdicts apart on the rim.
    const vItems = chain.filter('.fv-verdict').map(v => {
        let sx = 0, sy = 0;
        v.neighborhood('node.fv-node').not('.fv-facts').forEach(m => {
            if (m.data('fvStage') >= v.data('fvStage')) return;
            sx += Math.cos(A.get(m.id())); sy += Math.sin(A.get(m.id()));
        });
        return { n: v, want: sx || sy ? Math.atan2(sy, sx) : A.get(v.id()) };
    });
    if (vItems.length) {
        // Two-line labels need ~130px of rim each at the default text size.
        _fvSpreadCircle(vItems, 130 * Math.max(1, _fv.text / 100) / R(7));
        vItems.forEach(it => A.set(it.n.id(), it.at));
    }

    const rings = [...new Set(stages.map(R).filter(r => r > 0))];
    const rim = rings.length ? Math.max(...rings) : 60;
    chain.forEach(n => {
        const r = R(n.data('fvStage')), a = A.get(n.id());
        n.position({ x: r * Math.cos(a), y: r * Math.sin(a) });
        if (n.hasClass('fv-verdict')) n.addClass(Math.cos(a) >= -0.05 ? 'fv-right' : 'fv-left');
    });
    // Outside knowledge floats on its own orbit beyond the rim, next to what it informs.
    const factR = rim + 60;
    const facts = cv.nodes('.fv-facts');
    facts.forEach(f => {
        const tg = f.outgoers('node.fv-node').not('.fv-facts');
        let sx = 0, sy = 0;
        tg.forEach(t => { const p = t.position(); sx += p.x; sy += p.y; });
        const a = tg.length ? Math.atan2(sy, sx) : 0;
        f.position({ x: factR * Math.cos(a), y: factR * Math.sin(a) });
    });
    if (facts.nonempty()) rings.push(factR);
    _fv.rings = rings;

    // Each edge bends through the orbit halfway between its ends, so links follow the
    // rings instead of cutting straight across them.
    cv.edges().forEach(e => {
        const ps = e.source().position(), pt = e.target().position();
        const rs = Math.hypot(ps.x, ps.y), rt = Math.hypot(pt.x, pt.y);
        if (rs < 1 || rt < 1) return;
        const as = Math.atan2(ps.y, ps.x);
        let d = Math.atan2(pt.y, pt.x) - as;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) < 0.03) return;
        const am = as + d / 2, rm = (rs + rt) / 2 * (Math.abs(rs - rt) < 1 ? 0.85 : 1);
        _fvCurve(e, [{ x: rm * Math.cos(am), y: rm * Math.sin(am) }]);
    });
}

// Galaxy: the main view's own force layout and settings, so only the styling differs.
function _fvGalaxy(cv) {
    const nodes = cv.nodes('.fv-node');
    if (nodes.empty()) return;
    const n = Math.max(nodes.length, 8);
    const ry = Math.sqrt(n * 14000 / (16 / 9)) / 2, rx = ry * 16 / 9;
    nodes.forEach(nd => {
        const h = _hashStr(nd.id());
        const a = (h % 3600) / 3600 * Math.PI * 2, r = 0.35 + ((h >>> 12) % 1000) / 1000 * 0.65;
        nd.position({ x: rx * r * Math.cos(a), y: ry * r * Math.sin(a) });
    });
    cv.layout({ ...ORGANIC_LAYOUT_OPTS, name: _fcoseAvailable() ? 'fcose' : 'cose',
                animate: false, fit: false }).run();
    nodes.filter('.fv-verdict').addClass('fv-right');
}

// ---- The overlay: credibility rings, the conclusion's halo, orbit guides ------------
function _fvDrawOverlay() {
    const fx = document.getElementById('fv-fx');
    const cv = _fv.cy;
    if (!fx || !cv) return;
    const T = _fvTheme();
    const dpr = window.devicePixelRatio || 1;
    const w = fx.clientWidth, h = fx.clientHeight;
    if (fx.width !== Math.round(w * dpr) || fx.height !== Math.round(h * dpr)) {
        fx.width = Math.round(w * dpr);
        fx.height = Math.round(h * dpr);
    }
    const ctx = fx.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const z = cv.zoom(), pan = cv.pan();
    if (_fv.layout === 'rings' && _fv.rings) {
        ctx.strokeStyle = T.orbit;
        ctx.lineWidth = 1;
        for (const r of _fv.rings) {
            ctx.beginPath();
            ctx.arc(pan.x, pan.y, r * z, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
    const s = Math.max(0.6, Math.min(1.6, z));
    cv.nodes('.fv-verdict').forEach(n => {
        const p = n.renderedPosition(), r = n.renderedWidth() / 2;
        ctx.globalAlpha = n.hasClass('fv-dim') ? 0.12 : 1;
        if (n.data('node_type') === 'conclusion') {
            const g = ctx.createRadialGradient(p.x, p.y, r * 0.6, p.x, p.y, r * 2.8);
            g.addColorStop(0, _fvRgba(T.accent, 0.32));
            g.addColorStop(1, _fvRgba(T.accent, 0));
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.8, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = _fvRgba(T.accent, 0.55);
            ctx.lineWidth = 1.5 * s;
            ctx.beginPath(); ctx.arc(p.x, p.y, r + 5 * s, 0, Math.PI * 2); ctx.stroke();
            return;
        }
        const rating = n.data('fvRating');
        if (!rating) return;     // no score, no arc: the ring never invents a number
        // The ring: its length is the score, so it reads without colour too.
        const score = Math.max(0, Math.min(1, Number(n.data('credibility_score'))));
        const rr = r + 5 * s;
        ctx.lineWidth = 3 * s;
        ctx.lineCap = 'round';
        ctx.strokeStyle = T.track;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = T.cred[rating];
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score); ctx.stroke();
    });
    ctx.globalAlpha = 1;
}

// ---- Legend strip ------------------------------------------------------------------
function _fvLegend(T) {
    const box = document.getElementById('fv-legend');
    const cv = _fv.cy;
    if (!box || !cv) return;
    const calm = _fv.palette === 'calm';
    const row = (swatch, text) => `<span class="fv-lg-row">${swatch}${text}</span>`;
    const dot = style => `<span class="fv-lg-dot" style="${style}"></span>`;
    const hint = text => `<span class="fv-lg-hint">${text}</span>`;
    const gt = Number(CRED_THRESHOLDS.green).toFixed(2), yt = Number(CRED_THRESHOLDS.yellow).toFixed(2);
    const groups = [];
    if (calm) {
        groups.push(['The chain', FV_TIER_NAMES.map(([name, what], i) =>
            row(dot(`background:${T.ramp[i]}`), `${name} ${hint('· ' + what)}`)).join('')]);
        groups.push(['Verdicts',
            row(dot(`background:${T.accent};box-shadow:0 0 0 3px ${_fvRgba(T.accent, 0.2)}`), 'Conclusion')
            + row(dot(`background:${T.cred.green}`), `Claim ≥ ${gt}`)
            + row(dot(`background:${T.cred.yellow}`), `≥ ${yt}`)
            + row(dot(`background:${T.cred.red}`), `&lt; ${yt} ${hint("· the ring's length is the score")}`)]);
    } else {
        const seen = new Map();
        cv.nodes('.fv-node').not('.fv-facts').forEach(n => {
            const t = n.data('node_type');
            if (!seen.has(t)) seen.set(t, n.data('fvFill'));
        });
        const order = Object.keys(NODE_TYPE_LABELS);
        const types = [...seen].sort((a, b) =>
            (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
        groups.push(['Node types', types.map(([t, c]) =>
            row(dot(`background:${c}`), _esc(NODE_TYPE_LABELS[t] || t))).join('')]);
        groups.push(['Credibility ring',
            row(dot(`background:${T.cred.green}`), `≥ ${gt}`)
            + row(dot(`background:${T.cred.yellow}`), `≥ ${yt}`)
            + row(dot(`background:${T.cred.red}`), `&lt; ${yt} ${hint('· its length is the score')}`)]);
    }
    groups.push(['Edges',
        row('<span class="fv-lg-line"></span>', 'declared')
        + row('<span class="fv-lg-line dashed"></span>', 'inferred by the tool')
        + (cv.nodes('.fv-facts').nonempty() ? row(dot(`border:1.5px dashed ${T.muted}`), 'outside knowledge') : '')]);
    box.innerHTML = groups.map(([title, body]) =>
        `<div class="fv-lg-group"><h4>${title}</h4>${body}</div>`).join('');
}

// ---- Hover and click: trace the lineage --------------------------------------------
function _fvLight(n) {
    const cv = _fv.cy;
    if (!cv) return;
    cv.elements().removeClass('fv-dim fv-lit fv-focus');
    if (!n || n.empty()) return;
    const lineage = n.predecessors().union(n.successors()).union(n);
    cv.elements().not(lineage).not('.fv-header').addClass('fv-dim');
    lineage.edges().addClass('fv-lit');
    n.addClass('fv-focus');
}

function _fvPinned() {
    return _fv.pinned && _fv.cy ? _fv.cy.getElementById(_fv.pinned) : null;
}

function _fvUnpin() {
    _fv.pinned = null;
    _fvLight(null);
    _fvDrawOverlay();
}

// Search results, activity rows and node links in the report all mean "show me this
// node". With the focus view up, that means here rather than on the hidden canvas.
function _fvPin(id) {
    if (!_fv.on || !_fv.cy) return false;
    const n = _fv.cy.getElementById(id);
    if (n.empty()) return false;
    _fv.pinned = id;
    _fv.moved = true;      // the reader asked to look here; keep looking here
    _fvLight(n);
    _fv.cy.animate({ center: { eles: n } }, { duration: 300 });
    _fvDrawOverlay();
    return true;
}

function _fvBind(cv) {
    const tip = document.getElementById('fv-tip');
    const stage = document.querySelector('#focus-view .fv-stage');
    cv.on('mouseover', 'node.fv-node', ev => {
        const d = ev.target.data();
        _fvLight(ev.target);
        if (tip) {
            const score = d.credibility_score != null && d.node_type === 'claim'
                ? ` · credibility ${Number(d.credibility_score).toFixed(2)}` : '';
            const desc = d.description ? String(d.description) : '';
            tip.innerHTML = `<span class="fv-tip-meta">${_esc(NODE_TYPE_LABELS[d.node_type] || d.node_type)}${score}</span>`
                + `<b>${_esc(d.label || d.id)}</b>`
                + (desc ? `<p>${_esc(desc.length > 180 ? desc.slice(0, 179) + '…' : desc)}</p>` : '');
            tip.hidden = false;
        }
        _fvDrawOverlay();
    });
    cv.on('mousemove', 'node.fv-node', ev => {
        if (!tip || !stage) return;
        const p = ev.renderedPosition, box = stage.getBoundingClientRect();
        tip.style.left = Math.max(8, Math.min(p.x + 16, box.width - tip.offsetWidth - 8)) + 'px';
        tip.style.top = Math.max(8, Math.min(p.y + 16, box.height - tip.offsetHeight - 8)) + 'px';
    });
    cv.on('mouseout', 'node.fv-node', () => {
        _fvLight(_fvPinned());
        if (tip) tip.hidden = true;
        _fvDrawOverlay();
    });
    // A click pins the lineage and fills the side panels, as on the main canvas.
    cv.on('tap', 'node.fv-node', ev => {
        _fv.pinned = ev.target.id();
        _fvLight(ev.target);
        const main = cy.getElementById(ev.target.id());
        showDetail(main.nonempty() ? main.data() : ev.target.data());
        _fvDrawOverlay();
    });
    cv.on('tap', 'edge', ev => {
        const main = cy.getElementById(ev.target.id());
        if (main.nonempty()) showEdgeDetail(main);
    });
    cv.on('tap', ev => {
        if (ev.target !== cv) return;
        _fvUnpin();
        clearDetail();
    });
    // Only the reader's own pan or zoom stops the view re-framing as the graph grows.
    cv.on('dragpan scrollzoom pinchzoom', () => { _fv.moved = true; });
    cv.on('render viewport', _fvDrawOverlay);
}

// ---- Render ------------------------------------------------------------------------
function _fvRender() {
    if (!_fv.on || !cy) return;
    clearTimeout(_fv.timer);
    const host = document.getElementById('fv-cy');
    if (!host) return;
    const T = _fvTheme();
    let keep = null;
    if (_fv.cy) {
        if (_fv.moved) keep = { zoom: _fv.cy.zoom(), pan: { ..._fv.cy.pan() } };
        _fv.cy.destroy();
    }
    // The node under the pointer is about to be replaced, so its mouseout never comes.
    const tip = document.getElementById('fv-tip');
    if (tip) tip.hidden = true;
    _fv.rings = null;
    const cv = cytoscape({
        container: host,
        elements: _fvElements(),
        style: [],
        layout: { name: 'preset' },
        minZoom: 0.15,
        maxZoom: 3,
    });
    _fv.cy = cv;
    _fvPaint(cv, T);
    if (_fv.labels === 'all') cv.nodes('.fv-node').not('.fv-verdict').addClass('fv-minor');
    cv.style(_fvStyle(T));
    if (_fv.layout === 'flow') _fvFlow(cv);
    else if (_fv.layout === 'rings') _fvRings(cv);
    else _fvGalaxy(cv);
    if (keep) { cv.zoom(keep.zoom); cv.pan(keep.pan); }
    else cv.fit(undefined, FV_PAD);
    _fvLegend(T);
    _fvBind(cv);
    const pinned = _fvPinned();
    if (pinned && pinned.nonempty()) _fvLight(pinned);
    else _fv.pinned = null;
    _fvDrawOverlay();
}

// New evidence, a removal or fresh scores: redraw once things go quiet.
function _fvRefresh() {
    if (!_fv.on) return;
    clearTimeout(_fv.timer);
    _fv.timer = setTimeout(_fvRender, 500);
}

function _fvFit() {
    if (!_fv.cy) return;
    _fv.cy.resize();
    _fv.cy.fit(undefined, FV_PAD);
    _fv.moved = false;
}

function _fvSyncButtons() {
    document.querySelectorAll('#focus-view .fv-seg').forEach(seg => {
        seg.querySelectorAll('button').forEach(b =>
            b.setAttribute('aria-pressed', String(_fv[seg.dataset.key] === b.dataset.v)));
    });
    const text = document.getElementById('fv-text');
    if (text) text.value = String(_fv.text);
    const val = document.getElementById('fv-text-val');
    if (val) val.textContent = `${_fv.text}%`;
}

function _fvSave() {
    try {
        localStorage.setItem('aivis.focusView', JSON.stringify(_fv.prefs));
    } catch (e) { /* private mode */ }
}

function _fvChoose(key, value) {
    if (!FV_CHOICES[key] || !FV_CHOICES[key].includes(value) || _fv[key] === value) return;
    _fv[key] = value;
    _fv.prefs[key] = value;
    _fvSyncButtons();
    _fvSave();
    _fv.moved = false;     // a new arrangement deserves a fresh frame
    _fvRender();
}

function _fvClampText(v) {
    v = Math.round(Number(v) / FV_TEXT.step) * FV_TEXT.step;
    return Number.isFinite(v) ? Math.max(FV_TEXT.min, Math.min(FV_TEXT.max, v)) : FV_TEXT.base;
}

// While the slider moves only the labels are restyled, which is cheap; letting go
// lays the graph out again, because the spacing between labels follows their size.
function _fvSetText(v, { settle = true } = {}) {
    _fv.text = _fvClampText(v);
    _fvSyncButtons();
    if (settle) {
        _fv.prefs.text = _fv.text;
        _fvSave();
        _fvRender();
    } else if (_fv.cy) {
        _fv.cy.style(_fvStyle(_fvTheme()));
    }
}

function setFocusView(on, { persist = true } = {}) {
    on = !!on;
    if (on && _replay.active) stopReplay();   // the player draws on the main canvas
    _fv.on = on;
    const box = document.getElementById('focus-view');
    if (box) box.hidden = !on;
    document.body.classList.toggle('focus-view-on', on);
    const b = document.getElementById('btn-focus-view');
    if (b) {
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
    }
    const tip = document.getElementById('graph-tooltip');
    if (tip) tip.style.display = 'none';
    if (persist) {
        _fv.prefs.on = on;
        _fvSave();
    }
    if (on) {
        _fv.moved = false;
        _fvRender();
        return;
    }
    clearTimeout(_fv.timer);
    if (_fv.cy) { _fv.cy.destroy(); _fv.cy = null; }
    _fv.pinned = null;
}

function initFocusView() {
    const btn = document.getElementById('btn-focus-view');
    if (btn) btn.addEventListener('click', () => setFocusView(!_fv.on));
    document.querySelectorAll('#focus-view .fv-seg').forEach(seg => seg.addEventListener('click', ev => {
        const b = ev.target.closest('button');
        if (b) _fvChoose(seg.dataset.key, b.dataset.v);
    }));
    const text = document.getElementById('fv-text');
    if (text) {
        text.addEventListener('input', () => _fvSetText(text.value, { settle: false }));
        text.addEventListener('change', () => _fvSetText(text.value));
        text.addEventListener('dblclick', () => _fvSetText(FV_TEXT.base));
    }
    // Flow stretches itself to the canvas's proportions, so a new shape (window
    // switch, resize) wants a new layout, not just a new frame.
    const stage = document.querySelector('#focus-view .fv-stage');
    if (stage && typeof ResizeObserver === 'function') {
        let timer = null;
        new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (_fv.cy) _fvRender(); }, 150);
        }).observe(stage);
    }

    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('aivis.focusView') || '{}') || {}; } catch (e) { /* ignore */ }
    Object.keys(FV_CHOICES).forEach(k => {
        if (FV_CHOICES[k].includes(saved[k])) _fv[k] = saved[k];
    });
    if (saved.text != null) _fv.text = _fvClampText(saved.text);
    _fv.prefs = { on: !!saved.on, layout: _fv.layout, palette: _fv.palette,
                  labels: _fv.labels, text: _fv.text };
    // ?view=flow (or rings, galaxy, on, off) pins the view for a shared link or a
    // screenshot without changing what this browser normally prefers: it sets what
    // is drawn, after the preferences above have been taken.
    let pin = null;
    try { pin = new URLSearchParams(location.search).get('view'); } catch (e) { /* ignore */ }
    if (FV_CHOICES.layout.includes(pin)) _fv.layout = pin;
    _fvSyncButtons();
    const on = pin != null ? pin !== 'off' : !!saved.on;
    if (on) setFocusView(true, { persist: pin == null });
}
