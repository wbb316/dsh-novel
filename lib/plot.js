/**
 * 剧情（情节点）—— 纯函数层
 *
 * 数据源：`<小说>\剧情.json`
 * {
 *   "version": 1,
 *   "arcs":  { "第一卷 恋爱练习": "本卷纲领：练习开始越界……" },   // 卷名 → 一段纲领
 *   "beats": [
 *     { "id": "b1", "title": "第3章 契约：两人约定……",
 *       "volume": "第一卷 恋爱练习",
 *       "chapters": ["第003章-契约.txt"],      // 挂哪几章（多对多：一个情节点可挂多章）
 *       "cast": ["c1", "c2"],                  // 这一段出场的人（都要在角色表里有记录）
 *       "done": false,                         // **手动**勾选
 *       "note": "" }
 *   ]
 * }
 *
 * 几条设计上的取舍：
 *
 * 1. **手勾 vs 自动**：`done` 只记"手动勾的"。另外宿主会按
 *    「挂的章节都**有正文**」算出"自动已写"（`beatAutoDone`）—— 不落盘、每次现算，
 *    所以你把正文删了它会自己取消。手勾优先，自动不会覆盖手动。
 *
 * 2. **多对多**：一个情节点可以挂 0~N 章（一个剧情写好几章），
 *    一章也可以被多个情节点挂着（一章里发生好几件事）。
 *
 * 3. **卷纲领**放在 `arcs` 里，键是卷名（跟 `chapters\` 下的子目录同名）。
 *    没分卷的项目就只有一条 `""` 键（当作"全书纲领"）。
 *
 * 4. 这个文件**是数据**，`大纲.txt` 还是你随手写散文的地方 —— 两个互不覆盖。
 */
const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

export function emptyPlot() {
  return { version: 1, arcs: {}, beats: [] };
}

/** 把 id 里的反斜杠归一成 `/`（跟章节 id 一个规矩） */
const normId = (v) => str(v).replace(/\\/g, '/');

/** 洗一遍数据：脏了也不抛错，记在 warnings 里 */
export function normalizePlot(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const plot = emptyPlot();

  const arcs = src.arcs && typeof src.arcs === 'object' && !Array.isArray(src.arcs) ? src.arcs : {};
  for (const key of Object.keys(arcs)) {
    // ⚠️ **空键要留着** —— 它代表"未分卷"那一组，也就是整本书的纲领。
    //（第一版把空键当无效键丢掉了，结果是"全书纲领"永远存不进去）
    plot.arcs[String(key).trim()] = str(arcs[key]);
  }

  const rawBeats = Array.isArray(src.beats) ? src.beats : [];
  if (src.beats !== undefined && !Array.isArray(src.beats)) warnings.push('beats 不是数组，已忽略');

  const seen = new Set();
  rawBeats.forEach((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      warnings.push(`第 ${i + 1} 个情节点不是对象，已跳过`);
      return;
    }
    const title = str(b.title);
    if (!title) {
      warnings.push(`第 ${i + 1} 个情节点没有标题，已跳过`);
      return;
    }
    let id = str(b.id);
    if (!id || seen.has(id)) {
      const base = id || `b${i + 1}`;
      id = base;
      let n = 1;
      while (seen.has(id)) {
        n += 1;
        id = `${base}-${n}`;
      }
      if (str(b.id)) warnings.push(`情节点「${title}」的 id 重复，已改成 ${id}`);
    }
    seen.add(id);
    plot.beats.push({
      id,
      title,
      volume: str(b.volume),
      chapters: Array.isArray(b.chapters) ? b.chapters.map(normId).filter(Boolean) : [],
      cast: Array.isArray(b.cast) ? b.cast.map(str).filter(Boolean) : [],
      done: b.done === true || b.done === 'true' || b.done === 1,
      note: str(b.note)
    });
  });

  return { plot, warnings };
}

/** 新 id：b1、b2 …… */
export function autoBeatId(plot) {
  const used = new Set((plot.beats || []).map((b) => b.id));
  for (let i = 1; i < 10000; i += 1) {
    if (!used.has(`b${i}`)) return `b${i}`;
  }
  return `b${Date.now()}`;
}

/** 按 id 或标题找一个情节点 */
export function findBeat(plot, ref) {
  const key = str(ref);
  if (!key) return undefined;
  return (plot.beats || []).find((b) => b.id === key) || (plot.beats || []).find((b) => b.title === key);
}

/**
 * 批量改剧情（给工具/面板用；面板整表保存走的是另一条路）。
 *
 * ops = {
 *   addBeats:    [{ title, volume?, chapters?, cast?, note? }]
 *   updateBeats: [{ id?|title?, ...要改的字段 }]        // chapters 给的是**整表替换**
 *   removeBeats: [id | title]
 *   linkChapters:{ beat, chapters: [...] }              // 追加式挂章节
 *   unlinkChapters: { beat, chapters: [...] }
 *   arc:         { 卷名: "纲领" }
 *   toggle:      [id]                                   // 手动勾选/取消
 * }
 */
export function applyPlotOps(input, ops) {
  const { plot } = normalizePlot(input);
  const log = [];
  const o = ops && typeof ops === 'object' ? ops : {};

  for (const raw of Array.isArray(o.addBeats) ? o.addBeats : []) {
    const title = str(raw && raw.title);
    if (!title) throw new Error('addBeats 里有情节点缺少 title');
    const exist = findBeat(plot, title);
    if (exist) {
      log.push(`情节点「${title}」已存在，改为更新`);
      applyOneUpdate(exist, raw);
      continue;
    }
    const id = str(raw.id) && !findBeat(plot, str(raw.id)) ? str(raw.id) : autoBeatId(plot);
    plot.beats.push({
      id,
      title,
      volume: str(raw.volume),
      chapters: Array.isArray(raw.chapters) ? raw.chapters.map(normId).filter(Boolean) : [],
      cast: Array.isArray(raw.cast) ? raw.cast.map(str).filter(Boolean) : [],
      done: raw.done === true,
      note: str(raw.note)
    });
    log.push(`新增情节点「${title}」（${id}）`);
  }

  for (const raw of Array.isArray(o.updateBeats) ? o.updateBeats : []) {
    const who = findBeat(plot, (raw && (raw.id ?? raw.title)) || '');
    if (!who) {
      throw new Error(
        `找不到要改的情节点「${str(raw && (raw.id ?? raw.title))}」。现有：` +
          (plot.beats.map((b) => `${b.title}(${b.id})`).join('、') || '（空）')
      );
    }
    applyOneUpdate(who, raw);
    log.push(`更新情节点「${who.title}」`);
  }

  for (const ref of Array.isArray(o.removeBeats) ? o.removeBeats : []) {
    const who = findBeat(plot, ref);
    if (!who) throw new Error(`找不到要删的情节点「${str(ref)}」`);
    plot.beats = plot.beats.filter((b) => b.id !== who.id);
    log.push(`删掉情节点「${who.title}」`);
  }

  for (const raw of Array.isArray(o.linkChapters) ? o.linkChapters : []) {
    const who = findBeat(plot, raw && (raw.beat ?? raw.id));
    if (!who) throw new Error(`找不到情节点「${str(raw && (raw.beat ?? raw.id))}」`);
    const add = Array.isArray(raw.chapters) ? raw.chapters.map(normId).filter(Boolean) : [normId(raw.chapter)].filter(Boolean);
    for (const c of add) if (who.chapters.indexOf(c) < 0) who.chapters.push(c);
    log.push(`「${who.title}」挂上 ${add.join('、')}`);
  }

  for (const raw of Array.isArray(o.unlinkChapters) ? o.unlinkChapters : []) {
    const who = findBeat(plot, raw && (raw.beat ?? raw.id));
    if (!who) throw new Error(`找不到情节点「${str(raw && (raw.beat ?? raw.id))}」`);
    const drop = (Array.isArray(raw.chapters) ? raw.chapters : [raw.chapter]).map(normId);
    who.chapters = who.chapters.filter((c) => drop.indexOf(c) < 0);
    log.push(`「${who.title}」卸下 ${drop.join('、')}`);
  }

  if (o.arc && typeof o.arc === 'object' && !Array.isArray(o.arc)) {
    for (const key of Object.keys(o.arc)) {
      // 同样：空键 = 未分卷 / 全书纲领，不能丢
      plot.arcs[String(key).trim()] = str(o.arc[key]);
    }
    log.push('更新了卷纲领');
  }

  for (const ref of Array.isArray(o.toggle) ? o.toggle : []) {
    const who = findBeat(plot, ref);
    if (!who) throw new Error(`找不到情节点「${str(ref)}」`);
    who.done = !who.done;
    log.push(`「${who.title}」改成${who.done ? '已写' : '未写'}（手动）`);
  }

  return { plot, log };
}

function applyOneUpdate(beat, raw) {
  if (raw.title !== undefined && str(raw.title)) beat.title = str(raw.title);
  if (raw.volume !== undefined) beat.volume = str(raw.volume);
  if (raw.note !== undefined) beat.note = str(raw.note);
  if (raw.done !== undefined) beat.done = raw.done === true || raw.done === 'true';
  if (raw.chapters !== undefined) {
    beat.chapters = Array.isArray(raw.chapters) ? raw.chapters.map(normId).filter(Boolean) : [];
  }
  if (raw.cast !== undefined) {
    beat.cast = Array.isArray(raw.cast) ? raw.cast.map(str).filter(Boolean) : [];
  }
  if (raw.addCast !== undefined) {
    const add = Array.isArray(raw.addCast) ? raw.addCast.map(str) : [str(raw.addCast)];
    for (const c of add) if (c && beat.cast.indexOf(c) < 0) beat.cast.push(c);
  }
}

/**
 * 「自动已写」：挂的章节**都存在而且有正文**（去掉首行标题后还有字）。
 * @param {object} beat
 * @param {{[file: string]: number}} bodyChars 每个章节的正文长度（宿主读盘算好传进来）
 */
export function beatAutoDone(beat, bodyChars) {
  const list = (beat && beat.chapters) || [];
  if (!list.length) return false;
  const map = bodyChars || {};
  return list.every((id) => (map[id] || 0) > 0);
}

/** 一个情节点最终算不算完成：手勾优先，其次自动 */
export function beatDone(beat, bodyChars) {
  if (beat && beat.done) return { done: true, by: '手动' };
  if (beatAutoDone(beat, bodyChars)) return { done: true, by: '自动' };
  return { done: false, by: '' };
}

/** 进度：总共多少、完成多少、下一个该写哪个（按顺序取第一个没完成的） */
export function plotProgress(plot, bodyChars) {
  const beats = (plot && plot.beats) || [];
  let done = 0;
  let manual = 0;
  let auto = 0;
  const pending = [];
  for (const b of beats) {
    const st = beatDone(b, bodyChars);
    if (st.done) {
      done += 1;
      if (st.by === '手动') manual += 1;
      else auto += 1;
    } else {
      pending.push(b);
    }
  }
  return { total: beats.length, done, manual, auto, pending, next: pending.length ? pending[0] : null };
}

/**
 * 给人和 AI 看的纯文本版（`剧情.txt`）。
 * 里面不写 markdown 记号 —— 目标还是"记事本打开就能读"。
 */
export function renderPlotText(input, opts = {}) {
  const { plot } = normalizePlot(input);
  const bodyChars = (opts && opts.bodyChars) || {};
  const byId = (opts && opts.castById) || {};
  const lines = [];
  lines.push('剧情表（情节点 & 完成情况）');
  lines.push('');
  lines.push('※ 本文件由插件从「剧情.json」生成，手改会在下次同步时被覆盖。');
  if (opts.stamp) lines.push('※ 最后同步：' + opts.stamp);
  const p = plotProgress(plot, bodyChars);
  lines.push(`※ 进度：已写 ${p.done} / ${p.total}（手勾 ${p.manual} · 自动 ${p.auto}）`);
  lines.push('');

  let lastVolume = '\u0000';
  for (const b of plot.beats) {
    if (b.volume !== lastVolume) {
      lastVolume = b.volume;
      lines.push('');
      lines.push(b.volume ? '════ ' + b.volume + ' ════' : '════ 未分卷 ════');
      const arc = plot.arcs[b.volume];
      if (arc) lines.push('本卷纲领：' + arc);
      lines.push('');
    }
    const st = beatDone(b, bodyChars);
    lines.push((st.done ? '☑' : '☐') + ' ' + b.title + (st.by ? '（' + st.by + '）' : ''));
    if (b.chapters.length) lines.push('    章节：' + b.chapters.join('、'));
    if (b.cast.length) {
      lines.push('    出场：' + b.cast.map((id) => byId[id] || id).join('、'));
    }
    if (b.note) lines.push('    备注：' + b.note);
  }
  if (!plot.beats.length) lines.push('（还没有情节点）');
  lines.push('');
  return lines.join('\n');
}
