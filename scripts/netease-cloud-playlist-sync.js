const fs = require('fs');
const path = require('path');
var ncmApi = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function chunk(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
  return result;
}

function normalizeSongName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()【】\[\]《》<>「」『』·\-_,.，。!！?？:：'"`~]/g, '');
}

function safeCode(resp) {
  return Number(resp?.body?.code ?? resp?.code ?? 0);
}

function safeMessage(resp) {
  return resp?.body?.message || resp?.message || '';
}

function extractProfileFromLoginStatus(resp) {
  return resp?.body?.profile
    || resp?.body?.data?.profile
    || {};
}

function resolvePath(rootDir, maybeRelativePath) {
  if (!maybeRelativePath) return '';
  return path.isAbsolute(maybeRelativePath) ? maybeRelativePath : path.join(rootDir, maybeRelativePath);
}

function loadApiModule(rootDir, config) {
  const modulePath = config.apiModulePath
    ? resolvePath(rootDir, config.apiModulePath)
    : 'neteasecloudmusicapi';
  return require(modulePath);
}

function parseSourceListFile(filePath) {
  const text = readText(filePath);
  const songs = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\.\s+(.*?)\s+—\s+(.*?)\s+\|\s+(.*?)\s+\[(\d+)\]$/);
    if (!match) continue;
    songs.push({
      order: Number(match[1]),
      id: Number(match[5]),
      name: match[2],
      artistsText: match[3],
      albumText: match[4],
    });
  }
  return songs.sort((a, b) => a.order - b.order);
}

function parseLegacyReportFile(filePath) {
  const text = readText(filePath);
  const existing = [];
  const unmatched = [];
  const failed = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '[已存在而跳过]') {
      section = 'existing';
      continue;
    }
    if (line.trim() === '[云盘未匹配]') {
      section = 'unmatched';
      continue;
    }
    if (line.trim() === '[调用失败]') {
      section = 'failed';
      continue;
    }
    if (!line.trim()) continue;

    if (section === 'existing') {
      const m = line.match(/^\d+\.\s+(\d+)\.\s+(.*?)\s+\[songId=(\d+)\]/);
      if (m) existing.push({ order: Number(m[1]), songName: m[2], songId: Number(m[3]) });
    } else if (section === 'unmatched') {
      const m = line.match(/^\d+\.\s+(\d+)\.\s+(.*?)\s+—\s+(.*?)\s+\[songId=(\d+)\]/);
      if (m) unmatched.push({ order: Number(m[1]), songName: m[2], artistsText: m[3], songId: Number(m[4]) });
    } else if (section === 'failed') {
      const m = line.match(/^\d+\.\s+(\d+)\.\s+(.*?)\s+\[songId=(\d+)\]/);
      if (m) failed.push({ order: Number(m[1]), songName: m[2], songId: Number(m[3]) });
    }
  }
  return { existing, unmatched, failed };
}

async function resolvePlaylistByIdOrName(config, cookie, keyPrefix) {
  const idKey = `${keyPrefix}PlaylistId`;
  const nameKey = `${keyPrefix}PlaylistName`;
  if (config[idKey]) {
    const detail = await ncmApi.playlist_detail({ id: config[idKey], cookie, timestamp: Date.now() });
    const playlist = detail?.body?.playlist;
    if (!playlist?.id) throw new Error(`无法读取歌单: ${config[idKey]}`);
    return playlist;
  }

  const accountResp = await ncmApi.user_account({ cookie, timestamp: Date.now() });
  const userId = accountResp?.body?.account?.id;
  if (!userId) throw new Error('无法从当前 cookie 解析网易云账号');
  const listResp = await ncmApi.user_playlist({ uid: userId, cookie, limit: 1000, timestamp: Date.now() });
  const playlists = listResp?.body?.playlist || [];
  const targetName = config[nameKey];
  const matched = playlists.find((item) => item.name === targetName)
    || playlists.find((item) => String(item.name || '').includes(String(targetName || '')));
  if (!matched?.id) throw new Error(`无法按名称找到歌单: ${targetName}`);
  return matched;
}

async function getOrderedSourceSongs(sourcePlaylistId, cookie, batchSize) {
  const detailResp = await ncmApi.playlist_detail({ id: sourcePlaylistId, cookie, timestamp: Date.now() });
  const playlist = detailResp?.body?.playlist;
  const trackIds = (playlist?.trackIds || []).map((item) => Number(item.id)).filter(Boolean);
  const songs = [];
  for (const ids of chunk(trackIds, batchSize)) {
    const resp = await ncmApi.song_detail({ ids: ids.join(','), cookie, timestamp: Date.now() });
    const batchSongs = resp?.body?.songs || [];
    const songMap = new Map(batchSongs.map((song) => [Number(song.id), song]));
    for (const id of ids) {
      const song = songMap.get(Number(id));
      if (song) songs.push(song);
    }
    await sleep(300);
  }
  return { playlist, songs };
}

async function loadSourceSongs(rootDir, config, cookie) {
  const sourceListPath = resolvePath(rootDir, config.sourceListFile);
  if (sourceListPath && fs.existsSync(sourceListPath)) {
    const sourceSongs = parseSourceListFile(sourceListPath);
    const playlist = await resolvePlaylistByIdOrName(config, cookie, 'source');
    return {
      playlist,
      songs: sourceSongs.map((item) => ({
        id: item.id,
        name: item.name,
        order: item.order,
        artistsText: item.artistsText,
        albumText: item.albumText,
      })),
      sourceMode: 'source-list-file',
    };
  }

  const sourceData = await getOrderedSourceSongs(sourcePlaylistId, cookie, Number(config.songDetailBatchSize) || 200);
  return { ...sourceData, sourceMode: 'playlist-api' };
}

async function getAllCloudItems(cookie, pageSize) {
  const items = [];
  let offset = 0;
  while (true) {
    const resp = await ncmApi.user_cloud({ cookie, limit: pageSize, offset, timestamp: Date.now() });
    const page = resp?.body?.data || [];
    items.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    await sleep(400);
  }
  return items;
}

function buildCloudIndexes(cloudItems) {
  const bySongId = new Map();
  const byName = new Map();
  for (const item of cloudItems) {
    const songId = Number(item.songId || item.simpleSong?.id || 0);
    const songName = item.songName || item.simpleSong?.name || '';
    const key = `${item.pcId || 'pc'}:${songId}:${songName}`;
    const normalizedName = normalizeSongName(songName);
    const cloudRef = { key, songId, songName, raw: item };
    if (songId && !bySongId.has(songId)) bySongId.set(songId, cloudRef);
    if (!byName.has(normalizedName)) byName.set(normalizedName, []);
    byName.get(normalizedName).push(cloudRef);
  }
  return { bySongId, byName };
}

function matchSongs(sourceSongs, cloudIndexes, existingTargetIds) {
  const usedCloudKeys = new Set();
  const matched = [];
  const unmatched = [];
  const skippedExisting = [];

  for (let index = 0; index < sourceSongs.length; index += 1) {
    const sourceSong = sourceSongs[index];
    const sourceSongId = Number(sourceSong.id);
    const sourceSongName = sourceSong.name || '';
    const sourceOrder = Number(sourceSong.order || (index + 1));
    let cloudRef = cloudIndexes.bySongId.get(sourceSongId) || null;
    if (!cloudRef) {
      const candidates = cloudIndexes.byName.get(normalizeSongName(sourceSongName)) || [];
      cloudRef = candidates.find((item) => !usedCloudKeys.has(item.key)) || null;
    }
    if (!cloudRef?.songId) {
      unmatched.push({ order: sourceOrder, sourceSongId, sourceSongName });
      continue;
    }
    usedCloudKeys.add(cloudRef.key);
    if (existingTargetIds.has(cloudRef.songId)) {
      skippedExisting.push({ order: sourceOrder, sourceSongId, sourceSongName, targetSongId: cloudRef.songId });
      continue;
    }
    matched.push({
      order: sourceOrder,
      sourceSongId,
      sourceSongName,
      targetSongId: cloudRef.songId,
      targetSongName: cloudRef.songName,
    });
  }

  return { matched, unmatched, skippedExisting };
}

async function addTracks(pid, matchedTracks, cookie, config) {
  const queue = config.reverseBeforeAdd ? matchedTracks.slice().reverse() : matchedTracks.slice();
  const batches = chunk(queue, Number(config.addBatchSize) || 20);
  const added = [];
  const failed = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const ids = batch.map((item) => item.targetSongId);
    const resp = await ncmApi.playlist_tracks({
      op: 'add',
      pid,
      tracks: ids.join(','),
      cookie,
      timestamp: Date.now(),
    });
    const code = safeCode(resp);
    if (code === 200) {
      added.push(...batch);
    } else {
      for (const item of batch) {
        await sleep(Number(config.singleRetryDelayMs) || 4500);
        const retryResp = await ncmApi.playlist_tracks({
          op: 'add',
          pid,
          tracks: String(item.targetSongId),
          cookie,
          timestamp: Date.now(),
        });
        const retryCode = safeCode(retryResp);
        if (retryCode === 200) {
          added.push(item);
        } else {
          failed.push({
            ...item,
            code: retryCode,
            message: safeMessage(retryResp) || safeMessage(resp) || 'unknown error',
          });
        }
      }
    }
    if (index < batches.length - 1) {
      await sleep(Number(config.batchDelayMs) || 3000);
    }
  }

  return { added, failed };
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const configPath = path.join(rootDir, 'netease-sync.config.json');
  const config = readJson(configPath);
  ncmApi = loadApiModule(rootDir, config);
  const cookie = fs.readFileSync(config.cookieFile, 'utf8').trim();
  if (!cookie) throw new Error(`cookie 文件为空: ${config.cookieFile}`);

  const loginResp = await ncmApi.login_status({ cookie, timestamp: Date.now() });
  const accountResp = await ncmApi.user_account({ cookie, timestamp: Date.now() });
  const loginProfile = extractProfileFromLoginStatus(loginResp);
  const accountProfile = accountResp?.body?.profile || {};
  const profile = { ...loginProfile, ...accountProfile };
  if (!profile.userId) throw new Error('当前 cookie 未登录或已失效');

  const sourcePlaylist = await resolvePlaylistByIdOrName(config, cookie, 'source');
  const targetPlaylist = await resolvePlaylistByIdOrName(config, cookie, 'target');
  const sourceData = await loadSourceSongs(rootDir, config, cookie);
  const targetDetailResp = await ncmApi.playlist_detail({ id: targetPlaylist.id, cookie, timestamp: Date.now() });
  const existingTargetIds = new Set((targetDetailResp?.body?.playlist?.trackIds || []).map((item) => Number(item.id)).filter(Boolean));
  const cloudItems = await getAllCloudItems(cookie, Number(config.cloudPageSize) || 200);
  const cloudIndexes = buildCloudIndexes(cloudItems);
  const matchedInfo = matchSongs(sourceData.songs, cloudIndexes, existingTargetIds);
  const addResult = await addTracks(targetPlaylist.id, matchedInfo.matched, cookie, config);
  const legacyReportPath = resolvePath(rootDir, config.legacyImportReportFile);
  const legacyReport = legacyReportPath && fs.existsSync(legacyReportPath) ? parseLegacyReportFile(legacyReportPath) : null;

  const now = nowStamp();
  const reportDir = path.join(rootDir, config.reportDir || 'reports');
  ensureDir(reportDir);

  const summary = {
    time: new Date().toISOString(),
    user: profile.nickname || '',
    userId: profile.userId,
    sourcePlaylist: { id: sourcePlaylist.id, name: sourcePlaylist.name },
    targetPlaylist: { id: targetPlaylist.id, name: targetPlaylist.name },
    sourceTracks: sourceData.songs.length,
    cloudItems: cloudItems.length,
    matchedCandidates: matchedInfo.matched.length,
    added: addResult.added.length,
    skippedExisting: matchedInfo.skippedExisting.length,
    unmatched: matchedInfo.unmatched.length,
    failed: addResult.failed.length,
    reverseBeforeAdd: Boolean(config.reverseBeforeAdd),
    sourceMode: sourceData.sourceMode,
    legacyReportLoaded: Boolean(legacyReport),
    legacyExistingCount: legacyReport?.existing?.length || 0,
    legacyUnmatchedCount: legacyReport?.unmatched?.length || 0,
    legacyFailedCount: legacyReport?.failed?.length || 0,
  };

  writeText(path.join(reportDir, `playlist-sync-${now}.json`), JSON.stringify({
    summary,
    added: addResult.added,
    skippedExisting: matchedInfo.skippedExisting,
    unmatched: matchedInfo.unmatched,
    failed: addResult.failed,
  }, null, 2));

  const textLines = [
    `用户: ${summary.user} [${summary.userId}]`,
    `来源歌单: ${summary.sourcePlaylist.name} [${summary.sourcePlaylist.id}]`,
    `目标歌单: ${summary.targetPlaylist.name} [${summary.targetPlaylist.id}]`,
    `执行时间: ${summary.time}`,
    `来源曲目: ${summary.sourceTracks}`,
    `云盘曲目: ${summary.cloudItems}`,
    `匹配待导入: ${summary.matchedCandidates}`,
    `成功加入: ${summary.added}`,
    `目标歌单原本已有而跳过: ${summary.skippedExisting}`,
    `云盘未匹配: ${summary.unmatched}`,
    `调用失败: ${summary.failed}`,
    `反向导入补偿: ${summary.reverseBeforeAdd ? '开启' : '关闭'}`,
    '',
    '[失败清单]',
    ...addResult.failed.map((item, idx) => `${idx + 1}. ${item.order}. ${item.sourceSongName} [sourceSongId=${item.sourceSongId}, targetSongId=${item.targetSongId}, code=${item.code}, message=${item.message}]`),
  ];
  writeText(path.join(reportDir, `playlist-sync-${now}.txt`), textLines.join('\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
