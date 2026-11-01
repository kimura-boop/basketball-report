// Wリーグ FUTURE の終了試合データを wleague/data/ に保存する（GitHub Actions から週1回実行）
// サイトはふだん WJBL 公式データを直接読み込み、つながらないときにこの保存データを使う。
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.wjbl.01core.app/api';
const LEAGUE_ID = 47;
const SEASON_ID = 180;
const MONTHS = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'];
const OUT = path.join(process.cwd(), 'wleague', 'data');

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'wleague-cache (internal analytics)' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error('fetch failed: ' + url);
}
const exists = p => access(p).then(() => true, () => false);

const games = [];
for (const m of MONTHS) {
  const j = await get(`${API}/play-schedules?league_id=${LEAGUE_ID}&game_month=${m}`);
  const s = j && j.seasons && j.seasons[String(SEASON_ID)];
  if (!s) continue;
  for (const g of s.play_schedules) {
    const [mm, dd] = String(g.game_date).split('.');
    games.push({
      id: g.play_schedule_id,
      date: `${g.game_year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`,
      wd: g.game_date_week_day_name, time: g.game_start_time || '', venue: g.venue || '',
      status: g.game_status, final: g.game_status === 'fixed' && g.box_flg === 1, ot: !!g.ot_flg,
      home: { id: g.home_team_id, short: g.home_season_team_short_name, score: g.home_team_score },
      away: { id: g.away_team_id, short: g.away_season_team_short_name, score: g.away_team_score }
    });
  }
}
if (!games.length) { console.log('no schedule data; leaving existing files untouched'); process.exit(0); }

await mkdir(path.join(OUT, 'games'), { recursive: true });
await writeFile(path.join(OUT, 'schedule.json'), JSON.stringify({ updated: new Date().toISOString(), games }) + '\n');

let added = 0;
for (const g of games.filter(g => g.final)) {
  const file = path.join(OUT, 'games', `${g.id}.json`);
  if (await exists(file)) continue;
  const [info, detail, box, pbp] = await Promise.all([
    get(`${API}/play-schedule?play_schedule_id=${g.id}`),
    get(`${API}/play-schedule/detail?play_schedule_id=${g.id}`),
    get(`${API}/boxscore?play_schedule_id=${g.id}`),
    get(`${API}/pbp/play-by-play?play_schedule_id=${g.id}`)
  ]);
  if (!info || !detail || !box || !pbp || !(pbp.play_by_plays || []).length) { console.log('skip (incomplete)', g.id); continue; }
  await writeFile(file, JSON.stringify({ id: g.id, info, detail, box, pbp }) + '\n');
  added++;
  await new Promise(r => setTimeout(r, 500));
}
console.log(`schedule: ${games.length} games, saved ${added} new game files`);
