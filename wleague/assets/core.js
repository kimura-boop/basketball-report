/* Wリーグ FUTURE 分析サイト 共通ライブラリ
 * データ取得（data/ のキャッシュ → WJBL API の順）と、試合・シーズンの集計。 */
(function (global) {
  'use strict';

  const API = 'https://api.wjbl.01core.app/api';

  const CONFIG = {
    leagueId: 47,
    seasonId: 180,
    seasonLabel: '26-27 Wリーグ レギュラーシーズン フューチャー',
    months: ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
    teams: {
      232: { name: '広島イーグレッツ', short: '広島', color: '#1f6fb2' },
      18: { name: '三菱電機コアラーズ', short: '三菱電機', color: '#c8243a' },
      36: { name: '新潟アルビレックスBBラビッツ', short: '新潟', color: '#e8730c' },
      16: { name: '山梨クィーンビーズ', short: '山梨QB', color: '#b08a00' },
      204: { name: 'プレステージインターナショナル アランマーレ', short: 'アランマーレ', color: '#7c4aa8' },
      14: { name: '東京羽田ヴィッキーズ', short: '東京羽田', color: '#0f9bb8' },
      357: { name: 'SMBC TOKYO SOLUA', short: 'SOLUA', color: '#2c9a5c' }
    }
  };

  /* ---------- fetch ---------- */
  const memo = {};
  async function getJSON(url) {
    if (memo[url]) return memo[url];
    memo[url] = (async () => {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return r.json();
    })();
    try { return await memo[url]; } catch (e) { delete memo[url]; throw e; }
  }

  // シーズンの全日程（未来の試合も含む）
  async function loadSchedule() {
    const out = [];
    let live = true;
    try {
      const months = await Promise.all(CONFIG.months.map(m =>
        getJSON(`${API}/play-schedules?league_id=${CONFIG.leagueId}&game_month=${m}`).catch(() => null)));
      if (months.every(m => m === null)) throw new Error('api unavailable');
      for (const j of months) {
        const s = j && j.seasons && j.seasons[String(CONFIG.seasonId)];
        if (s) out.push(...s.play_schedules.map(normGame));
      }
    } catch (e) {
      live = false;
      const cached = await getJSON('data/schedule.json');
      out.push(...cached.games);
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id - b.id);
    return { games: out, live };
  }

  function normGame(g) {
    if (g.date && g.home) return g; // already normalized (cache)
    const [mm, dd] = String(g.game_date).split('.');
    return {
      id: g.play_schedule_id,
      date: `${g.game_year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`,
      wd: g.game_date_week_day_name,
      time: g.game_start_time || '',
      venue: g.venue || '',
      status: g.game_status,
      // 'ended' = 試合終了・公式記録の確定前（速報）、'fixed' = 確定
      final: (g.game_status === 'fixed' || g.game_status === 'ended') && g.box_flg === 1,
      provisional: g.game_status === 'ended',
      ot: !!g.ot_flg,
      home: { id: g.home_team_id, short: g.home_season_team_short_name, score: g.home_team_score },
      away: { id: g.away_team_id, short: g.away_season_team_short_name, score: g.away_team_score }
    };
  }

  // 1試合分の生データ（キャッシュ優先）
  async function loadGameRaw(id) {
    try { return await getJSON(`data/games/${id}.json`); } catch (e) { /* 確定前の試合や未保存の試合は公式データから */ }
    const [info, box, pbp] = await Promise.all([
      getJSON(`${API}/play-schedule?play_schedule_id=${id}`),
      getJSON(`${API}/boxscore?play_schedule_id=${id}`),
      getJSON(`${API}/pbp/play-by-play?play_schedule_id=${id}`)
    ]);
    const detail = await getJSON(`${API}/play-schedule/detail?play_schedule_id=${id}`);
    return { id, info, detail, box, pbp };
  }

  async function loadGame(id) { return analyzeGame(await loadGameRaw(id)); }

  /* ---------- helpers ---------- */
  const toSec = s => { const m = String(s || '0:00').match(/(\d+):(\d+)/); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
  const periodLen = p => (p <= 4 ? 600 : 300);
  const periodStart = p => (p <= 4 ? (p - 1) * 600 : 2400 + (p - 5) * 300);
  const elapsed = (p, rest) => periodStart(p) + periodLen(p) - toSec(rest);
  const fmtClock = (t, maxP) => {
    let p = 1; while (p < (maxP || 4) && t >= periodStart(p + 1)) p++;
    if (t >= 2400 && p < 5) p = 5;
    const rest = periodStart(p) + periodLen(p) - t;
    const lab = p <= 4 ? `${p}Q` : `OT${p - 4}`;
    return `${lab} ${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, '0')}`;
  };
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const pct = (m, a) => (a ? (m / a) * 100 : 0);

  function factors(t, o) {
    // t, o: team totals {p2m,p2a,p3m,p3a,ftm,fta,off,def,to,ast,pts}
    const fga = t.p2a + t.p3a, fgm = t.p2m + t.p3m;
    const poss = fga + 0.44 * t.fta - t.off + t.to;
    const ofga = o.p2a + o.p3a;
    const oposs = ofga + 0.44 * o.fta - o.off + o.to;
    const avgPoss = (poss + oposs) / 2;
    return {
      poss, avgPoss,
      ortg: avgPoss ? (t.pts / avgPoss) * 100 : 0,
      efg: fga ? ((fgm + 0.5 * t.p3m) / fga) * 100 : 0,
      ts: (fga + 0.44 * t.fta) ? (t.pts / (2 * (fga + 0.44 * t.fta))) * 100 : 0,
      tov: avgPoss ? (t.to / avgPoss) * 100 : 0,
      orb: (t.off + o.def) ? (t.off / (t.off + o.def)) * 100 : 0,
      ftr: fga ? (t.fta / fga) * 100 : 0,
      astr: fgm ? (t.ast / fgm) * 100 : 0,
      fg: pct(fgm, fga), p3: pct(t.p3m, t.p3a), ft: pct(t.ftm, t.fta),
      fgm, fga
    };
  }

  /* ---------- game analysis ---------- */
  function analyzeGame(raw) {
    const { info, detail, box, pbp } = raw;
    const plays = [...pbp.play_by_plays].sort((a, b) => a.no - b.no);
    const maxP = Math.max(4, pbp.max_period || 4, ...plays.map(p => p.period || 0));
    const gameLen = periodStart(maxP) + periodLen(maxP);
    const side = { 1: 'H', 2: 'A' };
    const opp = k => (k === 'H' ? 'A' : 'H');

    const T = {};
    for (const k of ['H', 'A']) {
      const src = k === 'H' ? box.home : box.away;
      const d = k === 'H' ? detail.home : detail.away;
      const cfg = CONFIG.teams[src.team_id] || {};
      const qs = [d.score_p1, d.score_p2, d.score_p3, d.score_p4, d.score_ot1, d.score_ot2, d.score_ot3, d.score_ot4]
        .slice(0, maxP).map(v => v == null ? 0 : v);
      T[k] = {
        id: src.team_id, name: cfg.name || src.season_team_name, short: cfg.short || src.season_team_short_name,
        color: cfg.color || (k === 'H' ? '#1f6fb2' : '#c8243a'),
        score: d.score, qs, win: d.winner_flg === 1,
        players: src.players.map(p => ({
          id: p.player_id, name: p.player_name, no: p.player_number, gs: !!p.gs,
          pts: p.pts, p2m: p.p2m, p2a: p.p2a, p3m: p.p3m, p3a: p.p3a, ftm: p.ftm, fta: p.fta,
          f: p.f, off: p.off, def: p.def, tot: p.tot, ast: p.ast, stl: p.stl, blk: p.blk, to: p.to,
          minSec: toSec(p.min), min: p.min, played: toSec(p.min) > 0
        })),
        teamRow: src.team, total: src.total
      };
    }
    // 同系色の対戦ではアウェイを別色に
    if (similar(T.H.color, T.A.color)) T.A.color = '#5b6675';

    const pById = { H: {}, A: {} };
    for (const k of ['H', 'A']) T[k].players.forEach(p => { pById[k][p.id] = p; });

    // --- PBP walk ---
    const score = { H: 0, A: 0 };
    const on = { H: new Set(), A: new Set() };
    const stintOpen = { H: {}, A: {} };
    const stints = { H: {}, A: {} };
    const lineups = { H: {}, A: {} };
    const luOpen = { H: null, A: null };
    const state = { H: 'n', A: 'n' };
    const ptsOffTO = { H: 0, A: 0 }, second = { H: 0, A: 0 };
    const q = {};
    const timeline = [];
    const blankQ = () => ({ pts: 0, fgm: 0, fga: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0, off: 0, def: 0, to: 0, pf: 0, ast: 0, stl: 0 });

    const openStint = (k, id, t) => { stintOpen[k][id] = { s: t, f: score[k], a: score[opp(k)] }; };
    const closeStint = (k, id, t) => {
      const o = stintOpen[k][id]; if (!o) return;
      (stints[k][id] = stints[k][id] || []).push({ s: o.s, e: t, pf: score[k] - o.f, pa: score[opp(k)] - o.a });
      delete stintOpen[k][id];
    };
    const luKey = k => [...on[k]].sort((a, b) => a - b).join('-');
    const openLU = (k, t) => { luOpen[k] = on[k].size === 5 ? { key: luKey(k), s: t, f: score[k], a: score[opp(k)] } : null; };
    const closeLU = (k, t) => {
      const o = luOpen[k]; if (!o) return;
      const r = lineups[k][o.key] = lineups[k][o.key] || { key: o.key, sec: 0, pf: 0, pa: 0 };
      r.sec += t - o.s; r.pf += score[k] - o.f; r.pa += score[opp(k)] - o.a;
      luOpen[k] = null;
    };

    for (const e of plays) {
      const k = side[e.home_away];
      const a1 = e.action1 || '';
      const t = e.period ? elapsed(e.period, e.rest_time) : 0;
      if (!k) continue;
      const Q = q[e.period] = q[e.period] || { H: blankQ(), A: blankQ() };
      const s = Q[k];

      if (a1 === 'プレイヤーイン') {
        const id = e.player_id1; if (id == null) continue;
        closeLU(k, t); on[k].add(id); openStint(k, id, t); openLU(k, t); continue;
      }
      if (a1 === 'プレイヤーインアウト') {
        const out = e.player_id1, inn = e.player_id2;
        closeLU(k, t);
        if (out != null) { on[k].delete(out); closeStint(k, out, t); }
        if (inn != null) { on[k].add(inn); openStint(k, inn, t); }
        openLU(k, t); continue;
      }
      if (/ターンオーバー/.test(a1)) { s.to++; state[opp(k)] = 'to'; state[k] = 'n'; }
      if (/オフェンスリバウンド/.test(a1)) { s.off++; state[k] = 'oreb'; }
      if (/ディフェンスリバウンド/.test(a1)) { s.def++; state[k] = 'n'; state[opp(k)] = 'n'; }
      if (/ファウル$/.test(a1)) s.pf++;
      if (a1 === 'アシスト') s.ast++;
      if (a1 === 'スティール') s.stl++;

      let pts = 0;
      if (/^2P/.test(a1)) { s.fga++; if (/○$/.test(a1)) { s.fgm++; pts = 2; } }
      else if (/^3P/.test(a1)) { s.fga++; s.p3a++; if (/○$/.test(a1)) { s.fgm++; s.p3m++; pts = 3; } }
      else if (/^フリースロー/.test(a1)) { s.fta++; if (/○$/.test(a1)) { s.ftm++; pts = 1; } }
      if (pts) {
        score[k] += pts; s.pts += pts;
        if (state[k] === 'to') ptsOffTO[k] += pts;
        if (state[k] === 'oreb') second[k] += pts;
        if (!/^フリースロー/.test(a1)) state[k] = 'n';
        const p = pById[k][e.player_id1];
        timeline.push({ t, k, pts, h: score.H, a: score.A, who: p ? shortName(p.name) : (e.player_name1 || ''), pid: e.player_id1, p: e.period });
      }
    }
    for (const k of ['H', 'A']) { closeLU(k, gameLen); for (const id of Object.keys(stintOpen[k])) closeStint(k, +id, gameLen); }

    // --- flow metrics ---
    let lc = 0, ties = 0, prevSign = 0, maxLead = { H: 0, A: 0 }, maxLeadAt = { H: null, A: null };
    const leadTime = { H: 0, A: 0, T: 0 };
    let lastT = 0, curD = 0;
    for (const ev of timeline) {
      const k0 = curD > 0 ? 'H' : curD < 0 ? 'A' : 'T'; leadTime[k0] += ev.t - lastT; lastT = ev.t;
      curD = ev.h - ev.a;
      const sg = Math.sign(curD);
      if (sg === 0) ties++;
      if (sg !== 0 && prevSign !== 0 && sg !== prevSign) lc++;
      if (sg !== 0) prevSign = sg;
      if (curD > maxLead.H) { maxLead.H = curD; maxLeadAt.H = ev; }
      if (-curD > maxLead.A) { maxLead.A = -curD; maxLeadAt.A = ev; }
    }
    leadTime[curD > 0 ? 'H' : curD < 0 ? 'A' : 'T'] += gameLen - lastT;

    const runs = []; let cur = null;
    for (const ev of timeline) {
      if (cur && cur.k === ev.k) { cur.pts += ev.pts; cur.e = ev.t; cur.endH = ev.h; cur.endA = ev.a; }
      else {
        if (cur) runs.push(cur);
        cur = { k: ev.k, pts: ev.pts, s: ev.t, e: ev.t, startH: ev.h - (ev.k === 'H' ? ev.pts : 0), startA: ev.a - (ev.k === 'A' ? ev.pts : 0), endH: ev.h, endA: ev.a };
      }
    }
    if (cur) runs.push(cur);
    // ランの開始時刻は「相手の最後の得点」直後とみなす
    for (let i = 0; i < runs.length; i++) runs[i].from = i ? runs[i - 1].e : 0;
    const bigRuns = runs.filter(r => r.pts >= 6).sort((a, b) => b.pts - a.pts);

    const drought = { H: { len: 0 }, A: { len: 0 } };
    const lastFG = { H: 0, A: 0 };
    for (const ev of timeline) {
      if (ev.pts === 1) continue;
      const g = ev.t - lastFG[ev.k];
      if (g > drought[ev.k].len) drought[ev.k] = { len: g, from: lastFG[ev.k], to: ev.t };
      lastFG[ev.k] = ev.t;
    }
    for (const k of ['H', 'A']) { const g = gameLen - lastFG[k]; if (g > drought[k].len) drought[k] = { len: g, from: lastFG[k], to: gameLen }; }

    // --- totals & factors ---
    const tot = {};
    for (const k of ['H', 'A']) {
      const x = T[k].total;
      tot[k] = { pts: x.pts, p2m: x.p2m, p2a: x.p2a, p3m: x.p3m, p3a: x.p3a, ftm: x.ftm, fta: x.fta, off: x.off, def: x.def, tot: x.tot, ast: x.ast, stl: x.stl, blk: x.blk, to: x.to, f: x.f };
    }
    const F = { H: factors(tot.H, tot.A), A: factors(tot.A, tot.H) };
    const pace = ((F.H.poss + F.A.poss) / 2) * 2400 / gameLen;
    const bench = {}; for (const k of ['H', 'A']) bench[k] = T[k].players.filter(p => !p.gs).reduce((s, p) => s + p.pts, 0);

    // player +/-
    for (const k of ['H', 'A']) for (const p of T[k].players) {
      const st = stints[k][p.id] || [];
      p.pm = st.reduce((s, x) => s + x.pf - x.pa, 0);
      p.stints = st;
    }

    const lu = {};
    for (const k of ['H', 'A']) lu[k] = Object.values(lineups[k]).filter(r => r.sec > 0).sort((a, b) => b.sec - a.sec);

    // 出場時間の検証（ボックススコアとのずれが大きいときは +/- を参考扱いに）
    let minutesOk = true;
    for (const k of ['H', 'A']) for (const p of T[k].players) {
      const s = (p.stints || []).reduce((a, x) => a + x.e - x.s, 0);
      if (Math.abs(s - p.minSec) > 30) minutesOk = false;
    }

    return {
      id: raw.id, info: {
        date: info.game_date, start: info.game_start_time, venue: info.venue, address: info.venue_address,
        season: info.season_full_name, provisional: info.game_status !== 'fixed', refs: [info.referee_name, info.sub_referee_name1, info.sub_referee_name2].filter(Boolean)
      },
      T, tot, F, pace, maxP, gameLen, timeline, q, lc, ties, maxLead, maxLeadAt, leadTime, runs, bigRuns, drought,
      ptsOffTO, second, bench, lu, minutesOk
    };
  }

  function shortName(n) {
    if (!n) return '';
    if (/・/.test(n)) return n.split('・').pop();
    return n.split(/\s+/)[0];
  }
  function similar(c1, c2) {
    const h = c => { const n = parseInt(c.slice(1), 16); const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let hh = 0; if (mx !== mn) { const d = mx - mn; hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; } return (hh * 60 + 360) % 360; };
    const d = Math.abs(h(c1) - h(c2)); return Math.min(d, 360 - d) < 28;
  }

  /* ---------- season aggregation for one team ---------- */
  function aggregateTeam(teamId, games) {
    const log = [];
    const players = {};
    const lineups = {};
    const qDiff = [];
    let w = 0, l = 0;
    const sum = { for: zeroTot(), against: zeroTot(), poss: 0, oposs: 0, sec: 0 };

    for (const g of games) {
      const k = g.T.H.id === teamId ? 'H' : g.T.A.id === teamId ? 'A' : null; if (!k) continue;
      const o = k === 'H' ? 'A' : 'H';
      const win = g.T[k].score > g.T[o].score; win ? w++ : l++;
      addTot(sum.for, g.tot[k]); addTot(sum.against, g.tot[o]);
      sum.poss += g.F[k].poss; sum.oposs += g.F[o].poss; sum.sec += g.gameLen;
      log.push({
        id: g.id, date: g.info.date, provisional: g.info.provisional, ha: k, opp: g.T[o], pf: g.T[k].score, pa: g.T[o].score, win,
        F: g.F[k], oF: g.F[o], pace: g.pace, qs: g.T[k].qs, oqs: g.T[o].qs,
        pot: g.ptsOffTO[k], opot: g.ptsOffTO[o], sc: g.second[k], osc: g.second[o], bench: g.bench[k], obench: g.bench[o]
      });
      g.T[k].qs.slice(0, 4).forEach((v, i) => { qDiff[i] = qDiff[i] || { pf: 0, pa: 0, n: 0 }; qDiff[i].pf += v; qDiff[i].pa += g.T[o].qs[i]; qDiff[i].n++; });

      for (const p of g.T[k].players) {
        if (!p.played) continue;
        const r = players[p.id] = players[p.id] || { id: p.id, name: p.name, no: p.no, gp: 0, gs: 0, sec: 0, pts: 0, tot: 0, off: 0, ast: 0, stl: 0, blk: 0, to: 0, p2m: 0, p2a: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0, f: 0, pm: 0, perGame: {} };
        r.no = p.no; r.gp++; if (p.gs) r.gs++;
        r.sec += p.minSec; r.pts += p.pts; r.tot += p.tot; r.off += p.off; r.ast += p.ast; r.stl += p.stl; r.blk += p.blk; r.to += p.to;
        r.p2m += p.p2m; r.p2a += p.p2a; r.p3m += p.p3m; r.p3a += p.p3a; r.ftm += p.ftm; r.fta += p.fta; r.f += p.f; r.pm += p.pm || 0;
        r.perGame[g.id] = { sec: p.minSec, pts: p.pts, pm: p.pm || 0, gs: p.gs };
      }
      const names = {}; g.T[k].players.forEach(p => { names[p.id] = shortName(p.name); });
      for (const u of g.lu[k]) {
        const r = lineups[u.key] = lineups[u.key] || { key: u.key, names: u.key.split('-').map(id => names[id] || '?'), sec: 0, pf: 0, pa: 0, games: new Set() };
        r.sec += u.sec; r.pf += u.pf; r.pa += u.pa; r.games.add(g.id);
      }
    }
    log.sort((a, b) => a.id - b.id);
    const F = factors(sum.for, sum.against), oF = factors(sum.against, sum.for);
    return {
      teamId, w, l, log, players: Object.values(players).sort((a, b) => b.sec - a.sec),
      lineups: Object.values(lineups).sort((a, b) => b.sec - a.sec), qDiff, sum, F, oF,
      pace: ((sum.poss + sum.oposs) / 2) * 2400 / (sum.sec || 1) * (log.length ? 1 : 0),
      ortg: sum.poss ? sum.for.pts / ((sum.poss + sum.oposs) / 2) * 100 : 0,
      drtg: sum.oposs ? sum.against.pts / ((sum.poss + sum.oposs) / 2) * 100 : 0
    };
  }
  function zeroTot() { return { pts: 0, p2m: 0, p2a: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0, off: 0, def: 0, tot: 0, ast: 0, stl: 0, blk: 0, to: 0, f: 0 }; }
  function addTot(a, b) { for (const k in a) a[k] += b[k] || 0; }

  // 同時実行数を絞って順に読み込む
  async function loadGames(ids, onProgress) {
    const out = []; let i = 0, done = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try { out.push(await loadGame(id)); } catch (e) { console.warn('game', id, e); }
        done++; if (onProgress) onProgress(done, ids.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out.sort((a, b) => a.id - b.id);
  }

  /* ---------- tiny DOM / SVG helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
  const signed = v => (v > 0 ? '+' : '') + v;
  const qs = new URLSearchParams(location.search);

  function svgEl(svg, name, attrs, text) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.appendChild(e); return e;
  }

  function topbar(currentTeam) {
    const el = document.getElementById('topbar'); if (!el) return;
    const links = Object.entries(CONFIG.teams).map(([id, t]) =>
      `<a href="team.html?id=${id}"${+id === +currentTeam ? ' aria-current="page"' : ''}><i class="dot" style="background:${t.color}"></i>${esc(t.short)}</a>`).join('');
    el.innerHTML = `<div class="in"><a class="brand" href="./">Wリーグ FUTURE 分析<span class="tag">26-27</span></a><nav class="teamnav" aria-label="チーム">${links}</nav></div>`;
  }
  function teamLink(id, label) {
    const t = CONFIG.teams[id];
    return t ? `<a href="team.html?id=${id}" style="text-decoration:none"><i class="dot" style="background:${t.color}"></i> ${esc(label || t.short)}</a>` : esc(label);
  }
  function showError(el, e) {
    el.innerHTML = `<div class="err"><b>データを読み込めませんでした。</b><br>WJBL公式サイトの公開データに接続できないか、まだ試合データが公開されていない可能性があります。時間をおいて再読み込みしてください。<br><span class="muted" style="font-size:.78rem">${esc(e && e.message)}</span></div>`;
  }

  global.WL = { CONFIG, API, topbar, teamLink, showError, loadSchedule, loadGame, loadGames, loadGameRaw, analyzeGame, aggregateTeam, factors,
    fmtClock, mmss, periodStart, esc, f1, signed, qs, svgEl, shortName, pct };
})(window);
