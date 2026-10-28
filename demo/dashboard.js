// Extracted from dashboard.html so the app can ship a Content-Security-Policy
// without 'unsafe-inline'. An inline <script> forces either unsafe-inline — which
// re-permits the injected event handlers CSP is there to stop — or a hash that
// breaks on every edit. Same code, same position in the document, loaded as a file.
(function () {
        'use strict';

        // ---------------------------------------------------------------
        // Config
        // ---------------------------------------------------------------
        const LIST_REFRESH_MS = 5000;    // /api/tasks is cheap — poll it
        const DETAIL_TTL_MS = 25000;     // /graph + /scores are not — throttle hard
        const DETAIL_CONCURRENCY = 2;

        // ---------------------------------------------------------------
        // DOM helpers. Nothing on this page passes data through innerHTML;
        // every server/agent-supplied string lands via textContent.
        // ---------------------------------------------------------------
        const $ = function (id) { return document.getElementById(id); };

        function el(tag, cls, text) {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined && text !== null) n.textContent = String(text);
            return n;
        }

        function setText(node, value) {
            const s = String(value);
            if (node.textContent !== s) node.textContent = s;
        }

        function show(node, visible) { node.hidden = !visible; }

        // ---------------------------------------------------------------
        // Formatting
        // ---------------------------------------------------------------
        function relTime(iso) {
            if (!iso) return '—';
            const t = Date.parse(iso);
            if (Number.isNaN(t)) return '—';
            const secs = Math.round((Date.now() - t) / 1000);
            if (secs < 90) return 'just now';
            const mins = Math.round(secs / 60);
            if (mins < 60) return mins + ' min ago';
            const hrs = Math.round(mins / 60);
            if (hrs < 24) return hrs === 1 ? '1 hour ago' : hrs + ' hours ago';
            const days = Math.round(hrs / 24);
            if (days < 30) return days === 1 ? 'yesterday' : days + ' days ago';
            return new Date(t).toLocaleDateString();
        }

        function absTime(iso) {
            if (!iso) return 'unknown creation time';
            const t = Date.parse(iso);
            return Number.isNaN(t) ? 'unknown creation time' : new Date(t).toLocaleString();
        }

        /** Write a task name, dimming the "/lineage" suffix the watcher appends. */
        function writeTaskName(node, name) {
            const raw = (name === null || name === undefined) ? '' : String(name);
            const SUFFIX = '/lineage';
            node.textContent = '';
            if (raw.length > SUFFIX.length && raw.endsWith(SUFFIX)) {
                node.appendChild(document.createTextNode(raw.slice(0, -SUFFIX.length)));
                node.appendChild(el('span', 'lineage-suffix', SUFFIX));
            } else {
                node.textContent = raw;
            }
            node.title = raw;
        }

        // ---------------------------------------------------------------
        // Credibility legend. Thresholds come from GET /api/config so the
        // wording can never drift from the scorer — never hardcoded here,
        // and ratings themselves are the server's own green/yellow/red.
        // ---------------------------------------------------------------
        let credLegend = 'Claims by credibility rating: green, yellow, red.';

        async function loadCredLegend() {
            try {
                const r = await fetch('/api/config');
                if (!r.ok) return;
                const d = await r.json();
                const th = d && d.credibility_thresholds;
                if (!th || typeof th.green !== 'number' || typeof th.yellow !== 'number') return;
                const pct = function (v) { return Math.round(v * 100) + '%'; };
                credLegend = 'Claims by credibility: green ≥ ' + pct(th.green)
                    + ', yellow ≥ ' + pct(th.yellow)
                    + ', red < ' + pct(th.yellow) + '.';
                applyLegend();
            } catch (err) {
                /* legend stays generic */
            }
        }

        function applyLegend() {
            const ov = $('ov-cred-wrap');
            if (ov) ov.title = credLegend;
            rows.forEach(function (entry) { entry.refs.cred.title = credLegend; });
        }

        // ---------------------------------------------------------------
        // Per-task detail: node/edge counts + credibility tally, from
        // /graph and /scores. Fetched lazily, throttled behind a TTL, and
        // patched into the row in place so a background refresh never
        // re-renders the list (and so never flickers).
        // ---------------------------------------------------------------
        const details = new Map();   // task_id -> {state, nodes, edges, g, y, r, ...}
        const rows = new Map();      // task_id -> {row, refs}
        const queue = [];
        let running = 0;

        function needsDetail(id) {
            const d = details.get(id);
            if (!d) return true;
            if (d.inflight) return false;
            return (Date.now() - d.at) > DETAIL_TTL_MS;
        }

        function enqueueDetail(id) {
            if (!needsDetail(id)) return;
            if (queue.indexOf(id) !== -1) return;
            queue.push(id);
            pumpQueue();
        }

        function pumpQueue() {
            while (running < DETAIL_CONCURRENCY && queue.length) {
                const id = queue.shift();
                // The task may have been archived while it sat in the queue.
                if (!rows.has(id) || !needsDetail(id)) continue;
                running += 1;
                fetchDetail(id)
                    .catch(function (err) { console.error(err); })
                    .then(function () { running -= 1; pumpQueue(); });
            }
        }

        async function getJson(url) {
            const r = await fetch(url);
            if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
            return r.json();
        }

        function nullOnError(p) { return p.catch(function () { return null; }); }

        async function fetchDetail(id) {
            const prev = details.get(id) || {};
            prev.inflight = true;
            details.set(id, prev);

            const enc = encodeURIComponent(id);
            let pair;
            try {
                pair = await Promise.all([
                    nullOnError(getJson('/api/tasks/' + enc + '/graph')),
                    nullOnError(getJson('/api/tasks/' + enc + '/scores')),
                ]);
            } catch (err) {
                // Never leave `inflight` stuck true — needsDetail() would then refuse
                // to ever retry and the row would sit at "—" forever.
                const cur = details.get(id);
                if (cur && cur.inflight) details.set(id, { state: 'error', at: Date.now() });
                paintDetail(id);
                throw err;
            }
            const graph = pair[0];
            const scores = pair[1];

            // The task can be archived while its detail is in flight; don't
            // resurrect a Map entry for a row that no longer exists.
            if (!rows.has(id)) { details.delete(id); return; }

            if (graph === null && scores === null) {
                details.set(id, { state: 'error', at: Date.now() });
                paintDetail(id);
                return;
            }

            const stats = (graph && graph.stats) || {};
            const counts = stats.node_counts || {};
            const tally = { green: 0, yellow: 0, red: 0 };
            if (Array.isArray(scores)) {
                for (const s of scores) {
                    const rating = s && s.rating;
                    if (rating === 'green' || rating === 'yellow' || rating === 'red') {
                        tally[rating] += 1;
                    }
                }
            }

            details.set(id, {
                state: 'ready',
                nodes: Number(stats.total_nodes) || 0,
                edges: Number(stats.total_edges) || 0,
                hasClaims: (Number(counts.claim) || 0) > 0
                    || (Array.isArray(scores) && scores.length > 0),
                hasConclusion: (Number(counts.conclusion) || 0) > 0,
                g: tally.green,
                y: tally.yellow,
                r: tally.red,
                at: Date.now(),
            });
            paintDetail(id);
            paintOverview();
        }

        // ---------------------------------------------------------------
        // Row construction
        // ---------------------------------------------------------------
        function glyph(char, label) {
            const g = el('span', 'glyph', char);
            g.title = label;
            g.setAttribute('aria-hidden', 'true');
            return g;
        }

        function statBlock(labelText) {
            const wrap = el('div', 'stat');
            const num = el('span', 'stat-num muted', '—');
            wrap.appendChild(num);
            wrap.appendChild(el('span', 'micro', labelText));
            return { wrap: wrap, num: num };
        }

        function countChip(cls, label) {
            const chip = el('span', 'cc ' + cls + ' zero');
            chip.appendChild(el('span', 'dot'));
            const num = el('span', null, '0');
            chip.appendChild(num);
            chip.title = label;
            return { chip: chip, num: num };
        }

        function createRow(task) {
            const row = el('div', 'task-row enter');
            row.addEventListener('animationend', function () {
                row.classList.remove('enter');
            }, { once: true });

            const card = document.createElement('a');
            card.className = 'task-card';

            const main = el('div', 'tc-main');
            const top = el('div', 'tc-top');
            const name = el('span', 'task-name');
            const glyphs = el('span', 'glyphs');
            const gGraph = glyph('◇', 'Graph — nodes recorded for this task');
            const gClaims = glyph('◈', 'Claims — scored conclusions exist');
            const gConcl = glyph('◆', 'Conclusion — converged findings exist');
            glyphs.appendChild(gGraph);
            glyphs.appendChild(gClaims);
            glyphs.appendChild(gConcl);
            const badge = el('span', 'ex-badge', 'Example');
            badge.hidden = true;
            badge.title = 'Bundled with the install so the dashboard is not empty. '
                + 'Archive it whenever you like.';
            top.appendChild(name);
            top.appendChild(badge);
            top.appendChild(glyphs);

            const meta = el('div', 'task-meta');
            const mActor = el('span');
            const mTime = el('span');
            const mId = el('span', 'mono');
            meta.appendChild(mActor);
            meta.appendChild(mTime);
            meta.appendChild(mId);

            main.appendChild(top);
            main.appendChild(meta);

            const stats = el('div', 'tc-stats');
            stats.dataset.state = 'pending';
            stats.title = 'Reading this task’s graph…';
            const nodesStat = statBlock('nodes');
            const edgesStat = statBlock('edges');

            const cred = el('div', 'cred');
            cred.title = credLegend;
            const bar = el('div', 'cred-bar');
            bar.dataset.empty = '1';
            const segG = el('i', 'cred-seg g');
            const segY = el('i', 'cred-seg y');
            const segR = el('i', 'cred-seg r');
            segG.hidden = true;
            segY.hidden = true;
            segR.hidden = true;
            bar.appendChild(segG);
            bar.appendChild(segY);
            bar.appendChild(segR);

            const countsRow = el('div', 'cred-counts');
            const cg = countChip('g', 'green claims');
            const cy = countChip('y', 'yellow claims');
            const cr = countChip('r', 'red claims');
            countsRow.appendChild(cg.chip);
            countsRow.appendChild(cy.chip);
            countsRow.appendChild(cr.chip);
            countsRow.hidden = true;

            // Starts as an em-dash, not "no claims": until /scores answers we do
            // not know, and the dashed box already says "unknown".
            const credNone = el('div', 'cred-none', '—');

            cred.appendChild(bar);
            cred.appendChild(countsRow);
            cred.appendChild(credNone);

            stats.appendChild(nodesStat.wrap);
            stats.appendChild(edgesStat.wrap);
            stats.appendChild(cred);

            const arrow = el('span', 'task-arrow', '→');
            arrow.setAttribute('aria-hidden', 'true');

            card.appendChild(main);
            card.appendChild(stats);
            card.appendChild(arrow);

            const kill = el('button', 'btn-kill', 'Archive');
            kill.type = 'button';
            kill.title = 'Stop watching and hide this task. Nothing is deleted — bring it '
                + 'back any time with "+ Add task".';
            kill.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                archiveTask(task.task_id, kill);
            });

            row.appendChild(card);
            row.appendChild(kill);

            return {
                row: row,
                refs: {
                    card: card, name: name, badge: badge, mActor: mActor, mTime: mTime, mId: mId,
                    gGraph: gGraph, gClaims: gClaims, gConcl: gConcl,
                    stats: stats, nodes: nodesStat.num, edges: edgesStat.num,
                    cred: cred, bar: bar, segG: segG, segY: segY, segR: segR,
                    countsRow: countsRow, cg: cg, cy: cy, cr: cr,
                    credNone: credNone, kill: kill,
                },
            };
        }

        function updateRowStatic(refs, task) {
            const id = String(task.task_id);
            refs.card.href = task.viewer_url || ('/t/' + encodeURIComponent(id));
            writeTaskName(refs.name, task.name || id);
            refs.badge.hidden = !task.example;
            setText(refs.mActor, task.actor || '—');
            setText(refs.mTime, relTime(task.created_at));
            refs.mTime.title = absTime(task.created_at);
            setText(refs.mId, id.slice(0, 8));
            refs.mId.title = 'task id ' + id;
            refs.kill.setAttribute('aria-label', 'Archive task ' + (task.name || id));
        }

        function paintDetail(id) {
            const entry = rows.get(id);
            const d = details.get(id);
            if (!entry || !d) return;
            const refs = entry.refs;

            if (d.state === 'error') {
                refs.stats.dataset.state = 'error';
                refs.stats.title = 'Could not read this task’s graph.';
                refs.countsRow.hidden = true;
                refs.credNone.hidden = false;
                setText(refs.credNone, 'unavailable');
                return;
            }
            if (d.state !== 'ready') return;

            refs.stats.dataset.state = 'ready';
            refs.stats.removeAttribute('title');

            setText(refs.nodes, d.nodes);
            refs.nodes.classList.toggle('muted', d.nodes === 0);
            setText(refs.edges, d.edges);
            refs.edges.classList.toggle('muted', d.edges === 0);

            refs.gGraph.classList.toggle('on', d.nodes > 0);
            refs.gClaims.classList.toggle('on', !!d.hasClaims);
            refs.gConcl.classList.toggle('on', !!d.hasConclusion);

            const total = d.g + d.y + d.r;
            refs.cred.title = credLegend;
            refs.bar.dataset.empty = total ? '0' : '1';
            refs.countsRow.hidden = total === 0;
            refs.credNone.hidden = total !== 0;
            setText(refs.credNone, 'no scored claims yet');

            function seg(node, n) {
                node.hidden = n === 0;
                node.style.width = total ? ((n / total) * 100) + '%' : '0%';
            }
            seg(refs.segG, d.g);
            seg(refs.segY, d.y);
            seg(refs.segR, d.r);

            function chip(c, n) {
                setText(c.num, n);
                c.chip.classList.toggle('zero', n === 0);
            }
            chip(refs.cg, d.g);
            chip(refs.cy, d.y);
            chip(refs.cr, d.r);
        }

        // ---------------------------------------------------------------
        // Overview strip (aggregate of everything currently active)
        // ---------------------------------------------------------------
        let activeIds = [];

        function paintOverview() {
            const ov = $('overview');
            if (!activeIds.length) { ov.hidden = true; return; }
            ov.hidden = false;

            let nodes = 0, edges = 0, g = 0, y = 0, r = 0, ready = 0;
            for (const id of activeIds) {
                const d = details.get(id);
                if (!d || d.state !== 'ready') continue;
                ready += 1;
                nodes += d.nodes;
                edges += d.edges;
                g += d.g;
                y += d.y;
                r += d.r;
            }

            ov.dataset.state = (ready === activeIds.length) ? 'ready' : 'pending';
            setText($('ov-tasks'), activeIds.length);

            function put(node, value) {
                setText(node, ready ? String(value) : '—');
                node.classList.toggle('muted', !ready || value === 0);
            }
            put($('ov-nodes'), nodes);
            put($('ov-edges'), edges);

            setText($('ov-green'), ready ? String(g) : '—');
            setText($('ov-yellow'), ready ? String(y) : '—');
            setText($('ov-red'), ready ? String(r) : '—');
            $('ov-cred-wrap').title = credLegend;
        }

        // ---------------------------------------------------------------
        // List render — diffed in place, never rebuilt
        // ---------------------------------------------------------------
        function listEl() { return $('task-list'); }

        function setStates(which) {
            show($('state-loading'), which === 'loading');
            show($('state-error'), which === 'error');
            show($('state-empty'), which === 'empty');
            listEl().hidden = (which !== 'list');
        }

        function renderTasks(tasks) {
            const list = listEl();
            activeIds = tasks.map(function (t) { return String(t.task_id); });

            // Drop rows whose task is no longer active.
            Array.from(rows.keys()).forEach(function (id) {
                if (activeIds.indexOf(id) === -1) {
                    const entry = rows.get(id);
                    if (entry.row.parentNode) entry.row.parentNode.removeChild(entry.row);
                    rows.delete(id);
                    details.delete(id);
                }
            });

            for (const t of tasks) {
                const id = String(t.task_id);
                let entry = rows.get(id);
                if (!entry) {
                    entry = createRow(t);
                    rows.set(id, entry);
                }
                updateRowStatic(entry.refs, t);
                list.appendChild(entry.row);   // appendChild also reorders in place
                paintDetail(id);
                enqueueDetail(id);
            }

            const pill = $('task-count');
            setText(pill, tasks.length);
            pill.hidden = (tasks.length === 0);

            setStates(tasks.length ? 'list' : 'empty');
            showNextSteps(tasks);
            list.setAttribute('aria-busy', 'false');
            paintOverview();
            if (!tasks.length) refreshHiddenHint();
        }

        // A fresh install opens on the bundled examples, which hid the getting-started
        // steps exactly when they matter most. While examples are all there is, the
        // steps stay on the page, under the examples rather than in front of them.
        function showNextSteps(tasks) {
            const onlyExamples = tasks.length > 0
                && tasks.every(function (t) { return t.example === true; });
            const ob = $('state-empty');
            const list = listEl();
            if (onlyExamples) list.parentNode.insertBefore(ob, list.nextSibling);
            else list.parentNode.insertBefore(ob, list);
            if (onlyExamples) show(ob, true);
            show($('ob-title-empty'), !onlyExamples);
            show($('ob-lede-empty'), !onlyExamples);
            show($('ob-title-examples'), onlyExamples);
            show($('ob-lede-examples'), onlyExamples);
        }

        let sawFirstResponse = false;

        async function loadTasks() {
            try {
                const tasks = await getJson('/api/tasks');
                sawFirstResponse = true;
                renderTasks(Array.isArray(tasks) ? tasks : []);
            } catch (err) {
                console.error('Failed to load tasks:', err);
                // Anti-flicker: a failed background refresh must not wipe a good list.
                if (!sawFirstResponse || rows.size === 0) {
                    rows.clear();
                    listEl().textContent = '';
                    listEl().setAttribute('aria-busy', 'false');
                    $('overview').hidden = true;
                    setStates('error');
                }
            }
        }

        async function archiveTask(taskId, btn) {
            btn.disabled = true;
            try {
                const resp = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/archive',
                    { method: 'POST' });
                if (resp.ok) {
                    await loadTasks();
                    if ($('add-panel').classList.contains('open')) await loadArchived();
                    return;
                }
                const err = await resp.json().catch(function () { return {}; });
                window.alert(err.detail || 'Could not archive that task.');
            } catch (err) {
                console.error('Failed to archive task:', err);
                window.alert('Request failed.');
            } finally {
                btn.disabled = false;
            }
        }

        // ---------------------------------------------------------------
        // Hidden-folder hint on the empty state
        // ---------------------------------------------------------------
        async function refreshHiddenHint() {
            const hint = $('ob-hidden-hint');
            try {
                const all = await getJson('/api/tasks/all');
                const n = Array.isArray(all)
                    ? all.filter(function (t) { return t.status !== 'active'; }).length
                    : 0;
                if (!n) { hint.hidden = true; return; }
                setText($('ob-hidden-count'), n);
                setText($('ob-hidden-verb'), n === 1 ? 'is' : 'are');
                setText($('ob-hidden-noun'), n === 1 ? 'folder' : 'folders');
                hint.hidden = false;
            } catch (err) {
                hint.hidden = true;
            }
        }

        // ---------------------------------------------------------------
        // Add an existing (archived / unregistered) task folder
        // ---------------------------------------------------------------
        function setPanelOpen(open) {
            const p = $('add-panel');
            p.classList.toggle('open', open);
            $('btn-add-task').setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) loadArchived();
        }

        function noteInto(container, text) {
            container.textContent = '';
            container.appendChild(el('p', 'fs-note', text));
        }

        async function loadArchived() {
            const list = $('archived-list');
            noteInto(list, 'Loading…');
            try {
                const all = await getJson('/api/tasks/all');
                const hidden = (Array.isArray(all) ? all : [])
                    .filter(function (t) { return t.status !== 'active'; });
                if (!hidden.length) {
                    noteInto(list, 'No hidden task folders — everything on disk is already on the dashboard.');
                    return;
                }
                hidden.sort(function (a, b) {
                    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
                });

                list.textContent = '';
                for (const t of hidden) {
                    const btn = el('button', 'archived-row');
                    btn.type = 'button';
                    btn.title = 'Add this task folder back to the dashboard';

                    // A <span>, not a <div>: this is the child of a <button>, whose
                    // permitted content is phrasing only. Flex blockifies it anyway.
                    const left = el('span');
                    const nm = el('span');
                    writeTaskName(nm, t.name || t.task_id);
                    left.appendChild(nm);
                    left.appendChild(el('span', 'ar-meta',
                        ' · ' + (t.actor || '—')
                        + ' · ' + String(t.task_id).slice(0, 8)
                        + (t.created_at ? ' · ' + relTime(t.created_at) : '')));
                    if (t.status === 'unregistered') {
                        left.appendChild(el('span', 'ar-badge', 'no meta'));
                    }

                    btn.appendChild(left);
                    btn.appendChild(el('span', 'ar-add', '+ Add'));
                    btn.addEventListener('click', function () { addById(t.task_id, btn); });
                    list.appendChild(btn);
                }
            } catch (err) {
                console.error(err);
                noteInto(list, 'Failed to load task folders.');
            }
        }

        async function addById(taskId, btn) {
            if (!taskId) return;
            if (btn) btn.disabled = true;
            try {
                const resp = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/restore',
                    { method: 'POST' });
                if (resp.ok) {
                    await loadTasks();
                    await loadArchived();
                    return;
                }
                const err = await resp.json().catch(function () { return {}; });
                window.alert(err.detail || 'Could not add that task folder.');
            } catch (err) {
                console.error(err);
                window.alert('Request failed.');
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        // ---------------------------------------------------------------
        // Import external project (server-side folder browser -> live watch)
        // ---------------------------------------------------------------
        let fsCurrent = '';        // current browse path ('' = drives / root)
        let lastFocused = null;

        function openImport() {
            lastFocused = document.activeElement;
            $('import-modal').classList.add('open');
            $('watch-name').value = '';
            browseFs('');
            $('btn-import-close').focus();
        }

        function closeImport() {
            $('import-modal').classList.remove('open');
            if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
            lastFocused = null;
        }

        function fsRow(icon, label, onClick) {
            const b = el('button', 'fs-row');
            b.type = 'button';
            const ic = el('span', 'ic', icon);
            ic.setAttribute('aria-hidden', 'true');
            b.appendChild(ic);
            b.appendChild(el('span', 'nm', label));
            b.addEventListener('click', onClick);
            return b;
        }

        async function browseFs(path) {
            const list = $('fs-list');
            noteInto(list, 'Loading…');
            try {
                const r = await fetch('/api/fs/list?path=' + encodeURIComponent(path || ''));
                if (!r.ok) { noteInto(list, 'Cannot open that folder.'); return; }
                const d = await r.json();
                fsCurrent = d.path || '';
                setText($('fs-path'), d.path || '(drives)');
                $('btn-watch').disabled = !!d.is_root || !fsCurrent;

                list.textContent = '';
                if (d.parent !== null && d.parent !== undefined) {
                    list.appendChild(fsRow('↑', '.. (up)', function () { browseFs(d.parent); }));
                }
                const dirs = Array.isArray(d.dirs) ? d.dirs : [];
                for (const c of dirs) {
                    list.appendChild(fsRow('📁', String(c.name), function () { browseFs(c.path); }));
                }
                if (!list.childNodes.length) noteInto(list, '(no sub-folders here)');
            } catch (err) {
                console.error(err);
                noteInto(list, 'Failed to load.');
            }
        }

        async function watchCurrent() {
            if (!fsCurrent) return;
            const btn = $('btn-watch');
            const name = $('watch-name').value.trim();
            btn.disabled = true;
            try {
                const r = await fetch('/api/tasks/watch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: fsCurrent, name: name || null }),
                });
                const d = await r.json().catch(function () { return {}; });
                if (r.ok) {
                    closeImport();
                    await loadTasks();
                    return;
                }
                window.alert(d.detail || 'Could not watch that folder.');
            } catch (err) {
                console.error(err);
                window.alert('Request failed.');
            } finally {
                btn.disabled = false;
            }
        }

        // ---------------------------------------------------------------
        // Copy-to-clipboard for the onboarding commands.
        // Degrades to selecting the text when the clipboard API is absent
        // (it is, on http:// origins in some browsers).
        // ---------------------------------------------------------------
        async function copyText(text, btn) {
            function done(label) {
                btn.textContent = label;
                window.setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
            }
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                    done('Copied');
                    return;
                }
            } catch (err) {
                /* fall through to selection */
            }
            const code = btn.parentNode && btn.parentNode.querySelector('code');
            if (code && window.getSelection && document.createRange) {
                const range = document.createRange();
                range.selectNodeContents(code);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                done('Selected');
                return;
            }
            done('Copy');
        }

        // ---------------------------------------------------------------
        // Wiring
        // ---------------------------------------------------------------
        $('btn-add-task').addEventListener('click', function () {
            setPanelOpen(!$('add-panel').classList.contains('open'));
        });
        $('btn-import').addEventListener('click', openImport);
        $('btn-import-close').addEventListener('click', closeImport);
        $('btn-watch').addEventListener('click', watchCurrent);
        $('ob-import').addEventListener('click', openImport);
        $('ob-restore').addEventListener('click', function () {
            setPanelOpen(true);
            $('add-panel').scrollIntoView({ block: 'nearest' });
        });

        $('import-modal').addEventListener('click', function (e) {
            if (e.target.id === 'import-modal') closeImport();
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && $('import-modal').classList.contains('open')) {
                closeImport();
            }
        });

        Array.prototype.forEach.call(document.querySelectorAll('.cmd-copy'), function (btn) {
            // The command text is the code element next to the button, so the
            // button and the thing on screen can never disagree.
            btn.addEventListener('click', function () {
                const code = btn.parentNode && btn.parentNode.querySelector('code');
                copyText(btn.dataset.copy || (code ? code.textContent : ''), btn);
            });
        });

        // ---------------------------------------------------------------
        // Boot. One timer for the cheap task list; per-task detail is
        // throttled behind its own TTL. Polling pauses while the tab is
        // hidden and resumes with an immediate refresh.
        // ---------------------------------------------------------------
        setStates('loading');
        loadCredLegend();
        loadTasks();

        let timer = window.setInterval(loadTasks, LIST_REFRESH_MS);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                window.clearInterval(timer);
                timer = 0;
            } else if (!timer) {
                loadTasks();
                timer = window.setInterval(loadTasks, LIST_REFRESH_MS);
            }
        });
    })();
