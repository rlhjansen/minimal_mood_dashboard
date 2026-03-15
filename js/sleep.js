/**
 * Sleep Module
 *
 * – Sleep trend chart (pulls from entries, sleep_log tables)
 * – "Gone to bed" button → logs timestamp to bedtime_log
 * – Bedtime history chart
 *
 * Depends on window.panasDB  (sql.js Database)
 *         and window.panasPersist (function to flush DB to localStorage)
 */
(function () {
    'use strict';

    var db, persist;

    /* ===================================================================
       DB helpers
       =================================================================== */
    function initSchema() {
        db.exec(`CREATE TABLE IF NOT EXISTS bedtime_log (
            id  INTEGER PRIMARY KEY AUTOINCREMENT,
            ts  TEXT NOT NULL
        )`);
        persist();
    }

    /* ===================================================================
       UI helpers
       =================================================================== */
    function esc(s) { return s ? s.replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }

    /* ===================================================================
       Build DOM — injected into #sleep-anchor (inside #right column)
       =================================================================== */
    function buildUI() {
        var anchor = document.getElementById('sleep-anchor');
        if (!anchor) return;

        var section = document.createElement('div');
        section.id = 'sleep-section';
        section.style.cssText = 'border-top:2px solid #eee; padding-top:1rem; margin-top:.8rem;';
        section.innerHTML = [
            '<h2 style="margin:0 0 .8rem">Sleep</h2>',
            '<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem;flex-wrap:wrap">',
            '  <button id="bedtime-btn" style="padding:.45rem .9rem;border:1px solid #7a5ea8;border-radius:8px;background:#f4f0fa;color:#7a5ea8;cursor:pointer;font-size:14px;font-family:inherit">Gone to bed</button>',
            '  <span id="bedtime-status" style="font-size:12px;color:#666"></span>',
            '</div>',
            '<div class="sleep-charts" style="display:grid;grid-template-columns:1fr 1fr;gap:.8rem;max-width:640px">',
            '  <div class="sleep-chart-wrap">',
            '    <h3 style="font-size:13px;margin:0 0 .3rem;color:#555">Sleep Trend</h3>',
            '    <svg id="sleep-chart" viewBox="0 0 320 120" style="width:100%;height:120px;background:#fafafa;border:1px solid #eee;border-radius:6px"></svg>',
            '  </div>',
            '  <div class="sleep-chart-wrap">',
            '    <h3 style="font-size:13px;margin:0 0 .3rem;color:#555">Bedtime Log</h3>',
            '    <svg id="bedtime-chart" viewBox="0 0 320 120" style="width:100%;height:120px;background:#fafafa;border:1px solid #eee;border-radius:6px"></svg>',
            '  </div>',
            '</div>',
            ''
        ].join('\n');

        anchor.appendChild(section);

        document.getElementById('bedtime-btn').addEventListener('click', handleBedtime);

        // Show last bedtime
        renderLastBedtime();
    }

    /* ===================================================================
       Bedtime handler
       =================================================================== */
    function handleBedtime() {
        var ts = new Date().toISOString();
        var stmt = db.prepare('INSERT INTO bedtime_log (ts) VALUES (?)');
        stmt.run([ts]);
        stmt.free();
        persist();
        renderLastBedtime();
        drawCharts();
    }

    function renderLastBedtime() {
        var el = document.getElementById('bedtime-status');
        if (!el) return;
        try {
            var res = db.exec('SELECT ts FROM bedtime_log ORDER BY id DESC LIMIT 1');
            if (res.length && res[0].values.length) {
                var d = new Date(res[0].values[0][0]);
                el.textContent = 'Last: ' + d.toLocaleDateString() + ' ' +
                    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
        } catch (_) { }
    }

    /* ===================================================================
       Sleep trend chart
       =================================================================== */
    function drawSleepChart() {
        var svg = d3.select('#sleep-chart');
        if (svg.empty()) return;
        svg.selectAll('*').remove();

        var rows = [];
        try {
            var r1 = db.exec("SELECT ts, hours_slept FROM entries WHERE hours_slept IS NOT NULL ORDER BY ts ASC");
            if (r1.length) r1[0].values.forEach(function (r) { rows.push({ ts: new Date(r[0]), val: r[1] }); });
        } catch (_) { }
        try {
            var r2 = db.exec("SELECT ts, hours_slept FROM sleep_log WHERE hours_slept IS NOT NULL ORDER BY ts ASC");
            if (r2.length) r2[0].values.forEach(function (r) { rows.push({ ts: new Date(r[0]), val: r[1] }); });
        } catch (_) { }

        rows.sort(function (a, b) { return a.ts - b.ts; });

        if (!rows.length) {
            svg.append('text').style('font-size', '12px').style('fill', '#bbb').attr('text-anchor', 'middle')
                .attr('x', 160).attr('y', 65).text('No sleep data yet');
            return;
        }

        var m = { l: 30, r: 8, t: 8, b: 22 };
        var W = 320, H = 120, iw = W - m.l - m.r, ih = H - m.t - m.b;
        var g = svg.append('g').attr('transform', 'translate(' + m.l + ',' + m.t + ')');

        var x = d3.scaleTime().domain(d3.extent(rows, function (d) { return d.ts; })).range([0, iw]);
        var yMin = Math.max(0, d3.min(rows, function (d) { return d.val; }) - 1);
        var yMax = d3.max(rows, function (d) { return d.val; }) + 1;
        var y = d3.scaleLinear().domain([yMin, yMax]).range([ih, 0]);

        /* 7-9h reference band */
        g.append('rect').attr('x', 0).attr('width', iw)
            .attr('y', y(9)).attr('height', y(7) - y(9))
            .attr('fill', '#e8f5e9').attr('opacity', 0.5);

        g.append('g').attr('transform', 'translate(0,' + ih + ')')
            .call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat('%b %d')))
            .selectAll('text').style('font-size', '9px');
        g.append('g').call(d3.axisLeft(y).ticks(4).tickFormat(function (v) { return v + 'h'; }))
            .selectAll('text').style('font-size', '9px');

        var line = d3.line().x(function (d) { return x(d.ts); }).y(function (d) { return y(d.val); })
            .curve(d3.curveMonotoneX);
        g.append('path').datum(rows).attr('fill', 'none')
            .attr('stroke', '#5b8bd6').attr('stroke-width', 1.5).attr('d', line);

        g.selectAll('.sleep-dot').data(rows).enter().append('circle')
            .attr('cx', function (d) { return x(d.ts); })
            .attr('cy', function (d) { return y(d.val); })
            .attr('r', 3).attr('fill', '#5b8bd6').attr('stroke', '#fff').attr('stroke-width', 1);
    }

    /* ===================================================================
       Bedtime chart — shows time-of-day dots for each bedtime entry
       =================================================================== */
    function drawBedtimeChart() {
        var svg = d3.select('#bedtime-chart');
        if (svg.empty()) return;
        svg.selectAll('*').remove();

        var rows = [];
        try {
            var r = db.exec("SELECT ts FROM bedtime_log ORDER BY ts ASC");
            if (r.length) r[0].values.forEach(function (v) {
                var d = new Date(v[0]);
                /* Convert to "bedtime hour" — hours after 18:00 wrap to 0-12 range
                   so 22:00=4, 00:00=6, 02:00=8, etc. for nice plotting */
                var h = d.getHours() + d.getMinutes() / 60;
                var bedHour = h >= 18 ? h - 18 : h + 6; // 18:00=0, 00:00=6, 06:00=12
                rows.push({ ts: d, bedHour: bedHour });
            });
        } catch (_) { }

        if (!rows.length) {
            svg.append('text').style('font-size', '12px').style('fill', '#bbb').attr('text-anchor', 'middle')
                .attr('x', 160).attr('y', 65).text('No bedtime data yet');
            return;
        }

        var m = { l: 38, r: 8, t: 8, b: 22 };
        var W = 320, H = 120, iw = W - m.l - m.r, ih = H - m.t - m.b;
        var g = svg.append('g').attr('transform', 'translate(' + m.l + ',' + m.t + ')');

        var x = d3.scaleTime().domain(d3.extent(rows, function (d) { return d.ts; })).range([0, iw]);
        /* Y axis: 0=18:00, 6=00:00, 12=06:00 — invert so earlier bedtimes are higher */
        var y = d3.scaleLinear().domain([0, 12]).range([0, ih]);

        /* Format bedtime hour back to clock time */
        function bedHourToLabel(bh) {
            var actual = (bh + 18) % 24;
            var hh = Math.floor(actual);
            var mm = Math.round((actual - hh) * 60);
            return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
        }

        g.append('g').attr('transform', 'translate(0,' + ih + ')')
            .call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat('%b %d')))
            .selectAll('text').style('font-size', '9px');
        g.append('g').call(d3.axisLeft(y).tickValues([0, 3, 6, 9, 12])
            .tickFormat(function (v) { return bedHourToLabel(v); }))
            .selectAll('text').style('font-size', '9px');

        /* Reference band for 22:00-00:00 (bedHour 4-6) */
        g.append('rect').attr('x', 0).attr('width', iw)
            .attr('y', y(4)).attr('height', y(6) - y(4))
            .attr('fill', '#e8f0fa').attr('opacity', 0.5);

        /* Dots */
        g.selectAll('.bed-dot').data(rows).enter().append('circle')
            .attr('cx', function (d) { return x(d.ts); })
            .attr('cy', function (d) { return y(d.bedHour); })
            .attr('r', 3.5).attr('fill', '#7a5ea8').attr('stroke', '#fff').attr('stroke-width', 1);

        /* Line connecting dots */
        if (rows.length > 1) {
            var line = d3.line().x(function (d) { return x(d.ts); }).y(function (d) { return y(d.bedHour); })
                .curve(d3.curveMonotoneX);
            g.append('path').datum(rows).attr('fill', 'none')
                .attr('stroke', '#7a5ea8').attr('stroke-width', 1.2).attr('stroke-opacity', 0.5).attr('d', line);
        }
    }

    function drawCharts() {
        drawSleepChart();
        drawBedtimeChart();
    }

    /* ===================================================================
       Initialization
       =================================================================== */
    function boot() {
        db = window.panasDB;
        persist = window.panasPersist;
        if (!db || !persist) return;
        initSchema();
        buildUI();
        drawCharts();
    }

    /* Expose refresh hook for cloud sync */
    window.panasRefreshSleep = function () {
        if (!db) return;
        renderLastBedtime();
        drawCharts();
    };

    if (window.panasDB) {
        boot();
    } else {
        window.addEventListener('panas-db-ready', boot);
    }
})();
