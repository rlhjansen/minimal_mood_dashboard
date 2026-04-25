/**
 * Sleep Module
 *
 * – Combined sleep + bedtime chart:
 *     · x = calendar day
 *     · y = time-of-day (18:00 → next-day 12:00)
 *     · dot at bedtime, filled area from bedtime for `hours_slept` duration
 *     · "?" marker when both bedtime and hours are missing for a day
 * – "Lying comfortably in bed" button → logs timestamp to bedtime_log
 *
 * Depends on window.panasDB  (sql.js Database)
 *         and window.panasPersist (function to flush DB to localStorage)
 */
(function () {
    'use strict';

    var db, persist;
    var RANGE_DAYS = 30;

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
            '  <button id="bedtime-btn" style="padding:.45rem .9rem;border:1px solid #7a5ea8;border-radius:8px;background:#f4f0fa;color:#7a5ea8;cursor:pointer;font-size:14px;font-family:inherit">Lying comfortably in bed</button>',
            '  <span id="bedtime-status" style="font-size:12px;color:#666"></span>',
            '</div>',
            '<div class="sleep-chart-wrap">',
            '  <svg id="sleep-chart" viewBox="0 0 640 200" style="width:100%;height:200px;background:#fafafa;border:1px solid #eee;border-radius:6px"></svg>',
            '  <div style="font-size:11px;color:#777;margin-top:.3rem;display:flex;gap:14px;flex-wrap:wrap">',
            '    <span><span style="display:inline-block;width:10px;height:10px;background:#7a5ea8;border-radius:50%;vertical-align:middle"></span> bedtime</span>',
            '    <span><span style="display:inline-block;width:16px;height:10px;background:rgba(122,94,168,.35);border:1px solid #7a5ea8;vertical-align:middle"></span> sleep interval (from hours_slept)</span>',
            '    <span><span style="color:#bbb;font-weight:700">?</span> no data</span>',
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
       Data helpers
       =================================================================== */

    /** Convert a timestamp into a "sleep day" (YYYY-MM-DD).
     *  Times before noon belong to the previous calendar day's night. */
    function sleepDayKey(d) {
        var x = new Date(d.getTime());
        if (x.getHours() < 12) x.setDate(x.getDate() - 1);
        return x.getFullYear() + '-' +
            String(x.getMonth() + 1).padStart(2, '0') + '-' +
            String(x.getDate()).padStart(2, '0') + 'T00:00:00';
    }

    /** Hours-after-18:00 representation. 18:00 -> 0, 00:00 -> 6, 12:00 -> 18. */
    function toBedHour(d) {
        var h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
        return h >= 12 ? h - 18 : h + 6; // 12:00=18, 18:00=0, 00:00=6, 06:00=12
    }

    /** Inverse of toBedHour - returns "HH:MM" clock label. */
    function bedHourToLabel(bh) {
        var actual = ((bh + 18) % 24 + 24) % 24;
        var hh = Math.floor(actual);
        var mm = Math.round((actual - hh) * 60);
        if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
        return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    }

    /** Gather sleep+bedtime info grouped by sleep-day. */
    function collectSleepData() {
        var byDay = {}; // key -> { day:Date, bedtimes:[Date], hours:[{ts,val}] }
        function get(k, dayDate) {
            if (!byDay[k]) byDay[k] = { day: dayDate, bedtimes: [], hours: [] };
            return byDay[k];
        }

        try {
            var r = db.exec("SELECT ts FROM bedtime_log ORDER BY ts ASC");
            if (r.length) r[0].values.forEach(function (v) {
                var ts = new Date(v[0]);
                var k = sleepDayKey(ts);
                get(k, new Date(k)).bedtimes.push(ts);
            });
        } catch (_) { }

        try {
            var r1 = db.exec("SELECT ts, hours_slept FROM entries WHERE hours_slept IS NOT NULL ORDER BY ts ASC");
            if (r1.length) r1[0].values.forEach(function (row) {
                var ts = new Date(row[0]);
                var k = sleepDayKey(ts);
                get(k, new Date(k)).hours.push({ ts: ts, val: row[1] });
            });
        } catch (_) { }
        try {
            var r2 = db.exec("SELECT ts, hours_slept FROM sleep_log WHERE hours_slept IS NOT NULL ORDER BY ts ASC");
            if (r2.length) r2[0].values.forEach(function (row) {
                var ts = new Date(row[0]);
                var k = sleepDayKey(ts);
                get(k, new Date(k)).hours.push({ ts: ts, val: row[1] });
            });
        } catch (_) { }

        return byDay;
    }

    /* ===================================================================
       Combined sleep + bedtime chart
       =================================================================== */
    function drawSleepChart() {
        var svg = d3.select('#sleep-chart');
        if (svg.empty()) return;
        svg.selectAll('*').remove();

        var byDay = collectSleepData();
        var keys = Object.keys(byDay);

        /* Domain: window of RANGE_DAYS ending at the later of (today, latest-data-day).
           This keeps the chart useful when the imported DB's most recent sleep
           entry is older than today (otherwise everything would show "?"). */
        var today = new Date();
        today.setHours(0, 0, 0, 0);

        var latestDataMs = today.getTime();
        keys.forEach(function (k) {
            var t = new Date(k).getTime();
            if (t > latestDataMs) latestDataMs = t;
        });
        var endKey = sleepDayKey(new Date(latestDataMs + 18 * 3600 * 1000));
        var endDay = new Date(endKey);
        var startDay = new Date(endDay.getTime() - (RANGE_DAYS - 1) * 24 * 3600 * 1000);

        /* If no data at all, show placeholder but still draw empty axes. */
        var hasAny = keys.length > 0;

        var m = { l: 38, r: 10, t: 10, b: 26 };
        var W = 640, H = 200, iw = W - m.l - m.r, ih = H - m.t - m.b;
        var g = svg.append('g').attr('transform', 'translate(' + m.l + ',' + m.t + ')');

        var x = d3.scaleTime().domain([
            new Date(startDay.getTime() - 12 * 3600 * 1000),
            new Date(endDay.getTime() + 12 * 3600 * 1000)
        ]).range([0, iw]);

        // y: 0 = 18:00, 6 = 00:00, 18 = 12:00 next day
        var y = d3.scaleLinear().domain([0, 18]).range([0, ih]);

        /* Night-time reference band (22:00 - 07:00 → bedHour 4 - 13) */
        g.append('rect').attr('x', 0).attr('width', iw)
            .attr('y', y(4)).attr('height', y(13) - y(4))
            .attr('fill', '#e8f0fa').attr('opacity', 0.45);

        /* Axes */
        g.append('g').attr('transform', 'translate(0,' + ih + ')')
            .call(d3.axisBottom(x).ticks(Math.min(8, RANGE_DAYS)).tickFormat(d3.timeFormat('%b %d')))
            .selectAll('text').style('font-size', '10px');
        g.append('g').call(d3.axisLeft(y).tickValues([0, 4, 6, 9, 12, 15, 18])
            .tickFormat(function (v) { return bedHourToLabel(v); }))
            .selectAll('text').style('font-size', '10px');

        if (!hasAny) {
            svg.append('text').style('font-size', '12px').style('fill', '#bbb').attr('text-anchor', 'middle')
                .attr('x', W / 2).attr('y', H / 2).text('No sleep data yet');
            return;
        }

        var dayWidthMs = 24 * 3600 * 1000;
        var dayPx = Math.max(6, (x(new Date(startDay.getTime() + dayWidthMs)) - x(startDay)) * 0.7);

        /* Iterate every day in domain; render either data or "?" marker.
           Use setDate-based stepping so DST transitions don't drift. */
        var cursor = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate());
        for (var i = 0; i < RANGE_DAYS; i++) {
            var dayMid = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 18, 0, 0, 0);
            var k = sleepDayKey(dayMid);
            var rec = byDay[k];
            var cxDate = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 12, 0, 0, 0);
            var cx = x(cxDate);
            cursor.setDate(cursor.getDate() + 1);

            if (!rec || (!rec.bedtimes.length && !rec.hours.length)) {
                // No data → "?" marker near bottom
                g.append('text')
                    .attr('x', cx).attr('y', y(9))
                    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                    .style('font-size', '14px').style('font-weight', '700').style('fill', '#c9c9d4')
                    .text('?');
                continue;
            }

            var bedtime = rec.bedtimes.length ? rec.bedtimes[rec.bedtimes.length - 1] : null;
            var hoursVal = rec.hours.length
                ? rec.hours[rec.hours.length - 1].val
                : null;

            /* Filled sleep interval when hours known. */
            if (hoursVal != null) {
                var startBH, endBH;
                if (bedtime) {
                    startBH = toBedHour(bedtime);
                } else {
                    // Assume a default bedtime of 23:00 (bedHour 5) if unknown
                    startBH = 5;
                }
                endBH = Math.min(18, startBH + hoursVal);
                g.append('rect')
                    .attr('x', cx - dayPx / 2).attr('width', dayPx)
                    .attr('y', y(startBH)).attr('height', Math.max(1, y(endBH) - y(startBH)))
                    .attr('fill', '#7a5ea8').attr('fill-opacity', 0.28)
                    .attr('stroke', '#7a5ea8').attr('stroke-opacity', 0.55).attr('stroke-width', 1)
                    .append('title').text(
                        'Sleep: ' + hoursVal + 'h' +
                        (bedtime ? ' (bedtime ' + bedHourToLabel(startBH) + ')' : ' (bedtime unknown)')
                    );
            }

            /* Bedtime dot. */
            if (bedtime) {
                var bh = toBedHour(bedtime);
                g.append('circle')
                    .attr('cx', cx).attr('cy', y(bh))
                    .attr('r', 4).attr('fill', '#7a5ea8').attr('stroke', '#fff').attr('stroke-width', 1)
                    .append('title').text('Bedtime ' + bedHourToLabel(bh) +
                        (hoursVal != null ? ' — slept ' + hoursVal + 'h' : ''));
            }
        }
    }

    function drawCharts() { drawSleepChart(); }

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

    /* Allow the host page to swap the underlying SQL.Database (e.g. after
       importing a .sqlite file) without reloading the page. */
    window.panasSleepRebind = function (newDb) {
        if (!newDb) return;
        db = newDb;
        try { initSchema(); } catch (_) { }
    };

    /* Expose sleep-day grouping for the JSON export so the dashboard can
       attach a summary {bedtime, hours_slept, inferred_wake_time} per day. */
    window.panasSleepSummary = function () {
        if (!db) return {};
        var byDay = collectSleepData();
        var out = {};
        Object.keys(byDay).forEach(function (k) {
            var rec = byDay[k];
            var bedtime = rec.bedtimes.length ? rec.bedtimes[rec.bedtimes.length - 1] : null;
            var hoursVal = rec.hours.length ? rec.hours[rec.hours.length - 1].val : null;
            var wake = null;
            if (bedtime && hoursVal != null) {
                wake = new Date(bedtime.getTime() + hoursVal * 3600 * 1000).toISOString();
            }
            out[k.slice(0, 10)] = {
                sleep_day: k.slice(0, 10),
                bedtime: bedtime ? bedtime.toISOString() : null,
                hours_slept: hoursVal,
                inferred_wake_time: wake,
                all_bedtimes: rec.bedtimes.map(function (d) { return d.toISOString(); }),
                all_hours_entries: rec.hours.map(function (h) {
                    return { ts: h.ts.toISOString(), hours_slept: h.val };
                })
            };
        });
        return out;
    };

    if (window.panasDB) {
        boot();
    } else {
        window.addEventListener('panas-db-ready', boot);
    }
})();
