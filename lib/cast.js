/**
 * 角色卡 & 人物关系 —— 纯函数层（零 import，容易单测）
 *
 * 数据源：<小说目录>\characters.json
 *   {
 *     "version": 1,
 *     "characters": [
 *       { "id":"c1", "name":"苏晚", "role":"主角", "age":"17",
 *         "tags":["文学社","毒舌"], "desc":"……" }
 *     ],
 *     "relations": [
 *       { "from":"c1", "to":"c2", "type":"暗恋（单向）", "note":"不敢说出口" }
 *     ]
 *   }
 *
 * characters.md 是**生成物**（由 renderCastMd 渲染），给 agent 读用；
 * 手改会在下次同步时被覆盖 —— 所以面板里人物卡只让看、不让改。
 *
 * 关系里的 from/to 既接受 id 也接受**名字**（人和模型都更爱写名字）。
 */

/** 角色定位候选（只是建议值，不强制） */
export const ROLES = ['主角', '配角', '反派', '路人'];

/** 空角色表 */
export function emptyCast() {
  return { version: 1, characters: [], relations: [] };
}

const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

/** 生成一个没被占用的短 id：c1、c2 …… */
export function autoId(cast) {
  const used = new Set((cast.characters || []).map((c) => c.id));
  for (let i = 1; i < 10000; i += 1) {
    const id = `c${i}`;
    if (!used.has(id)) return id;
  }
  return `c${Date.now()}`;
}

/** 按 id 或名字找人（名字精确匹配，忽略首尾空白） */
export function resolveRef(cast, ref) {
  const key = str(ref);
  if (!key) return undefined;
  const chars = cast.characters || [];
  return chars.find((c) => c.id === key) || chars.find((c) => c.name === key);
}

/**
 * 把任意输入洗成合法角色表。**不抛错**（用户数据脏了也要能打开面板），
 * 有问题的地方记在 warnings 里。
 * @returns {{cast: object, warnings: string[]}}
 */
export function normalizeCast(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('characters.json 顶层不是对象，已按空表处理');
  }

  const cast = emptyCast();
  const seenIds = new Set();

  const rawChars = Array.isArray(src.characters) ? src.characters : [];
  if (src.characters !== undefined && !Array.isArray(src.characters)) warnings.push('characters 不是数组，已忽略');

  rawChars.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`第 ${i + 1} 个角色不是对象，已跳过`);
      return;
    }
    const name = str(item.name);
    if (!name) {
      warnings.push(`第 ${i + 1} 个角色没有名字，已跳过`);
      return;
    }
    let id = str(item.id);
    if (!id || seenIds.has(id)) {
      id = autoId(cast);
      if (str(item.id)) warnings.push(`角色「${name}」的 id 重复或非法，已改成 ${id}`);
    }
    seenIds.add(id);

    const tags = Array.isArray(item.tags)
      ? item.tags.map(str).filter(Boolean)
      : str(item.tags)
      ? str(item.tags).split(/[、,，/|]/).map((s) => s.trim()).filter(Boolean)
      : [];

    cast.characters.push({
      id,
      name,
      role: str(item.role) || '配角',
      age: str(item.age),
      tags,
      desc: str(item.desc),
      // 头像就是 1~4 个字符（emoji 或姓氏），纯文本项目不需要图片文件
      avatar: str(item.avatar).slice(0, 4)
    });
  });

  const rawRels = Array.isArray(src.relations) ? src.relations : [];
  if (src.relations !== undefined && !Array.isArray(src.relations)) warnings.push('relations 不是数组，已忽略');

  rawRels.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`第 ${i + 1} 条关系不是对象，已跳过`);
      return;
    }
    const a = resolveRef(cast, item.from);
    const b = resolveRef(cast, item.to);
    if (!a || !b) {
      warnings.push(`第 ${i + 1} 条关系指向了不存在的角色（${str(item.from)} → ${str(item.to)}），已跳过`);
      return;
    }
    const type = str(item.type) || '关系';
    if (cast.relations.some((r) => r.from === a.id && r.to === b.id && r.type === type)) return;
    cast.relations.push({ from: a.id, to: b.id, type, note: str(item.note) });
  });

  if (src.version !== undefined && typeof src.version !== 'number') warnings.push('version 不是数字，已重置为 1');
  return { cast, warnings };
}

/** 解析 characters.json 文本（坏了也不扔，返回空表 + 警告） */
export function parseCastJson(text) {
  if (!text || !text.trim()) return { cast: emptyCast(), warnings: [] };
  try {
    const raw = JSON.parse(text);
    const out = normalizeCast(raw);
    return out;
  } catch (err) {
    return { cast: emptyCast(), warnings: [`characters.json 不是合法 JSON（${(err && err.message) || err}），已按空表打开；保存会覆盖它`] };
  }
}

/**
 * 按操作改角色表。**指错人就抛错**（抛给模型/用户看，比默默吞掉好）。
 *
 * ops = {
 *   addCharacters:    [{ id?, name, role?, age?, tags?, desc? }]
 *   updateCharacters: [{ id?|name?, ...要改的字段 }]
 *   removeCharacters: [id | name]
 *   addRelations:     [{ from, to, type?, note? }]
 *   removeRelations:  [{ from, to, type? }]
 * }
 * @returns {{cast: object, log: string[]}}
 */
export function applyCastOps(input, ops) {
  const { cast } = normalizeCast(input);
  const log = [];
  const o = ops && typeof ops === 'object' ? ops : {};

  // 新增（同名视为更新，方便模型重复调用不炸）
  for (const raw of Array.isArray(o.addCharacters) ? o.addCharacters : []) {
    const name = str(raw && raw.name);
    if (!name) throw new Error('addCharacters 里有角色缺少 name');
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map(str).filter(Boolean)
      : str(raw.tags)
      ? str(raw.tags).split(/[、,，/|]/).map((s) => s.trim()).filter(Boolean)
      : [];
    const exist = cast.characters.find((c) => c.name === name);
    if (exist) {
      if (raw.role !== undefined) exist.role = str(raw.role) || exist.role;
      if (raw.age !== undefined) exist.age = str(raw.age);
      if (raw.desc !== undefined) exist.desc = str(raw.desc);
      if (raw.avatar !== undefined) exist.avatar = str(raw.avatar).slice(0, 4);
      if (tags.length) exist.tags = tags;
      log.push(`角色「${name}」已存在，改为更新`);
    } else {
      const id = str(raw.id) && !cast.characters.some((c) => c.id === str(raw.id)) ? str(raw.id) : autoId(cast);
      cast.characters.push({
        id,
        name,
        role: str(raw.role) || '配角',
        age: str(raw.age),
        tags,
        desc: str(raw.desc),
        avatar: str(raw.avatar).slice(0, 4)
      });
      log.push(`新增角色「${name}」（${id} · ${str(raw.role) || '配角'}）`);
    }
  }

  // 修改
  for (const raw of Array.isArray(o.updateCharacters) ? o.updateCharacters : []) {
    const who = resolveRef(cast, (raw && (raw.id ?? raw.name)) || '');
    if (!who) {
      throw new Error(
        `找不到要修改的角色「${str(raw && (raw.id ?? raw.name))}」。现有角色：` +
          (cast.characters.map((c) => `${c.name}(${c.id})`).join('、') || '（空）')
      );
    }
    if (raw.name !== undefined && str(raw.name)) who.name = str(raw.name);
    if (raw.role !== undefined) who.role = str(raw.role) || who.role;
    if (raw.age !== undefined) who.age = str(raw.age);
    if (raw.desc !== undefined) who.desc = str(raw.desc);
    if (raw.avatar !== undefined) who.avatar = str(raw.avatar).slice(0, 4);
    if (raw.tags !== undefined) {
      who.tags = Array.isArray(raw.tags)
        ? raw.tags.map(str).filter(Boolean)
        : str(raw.tags)
        ? str(raw.tags).split(/[、,，/|]/).map((s) => s.trim()).filter(Boolean)
        : [];
    }
    log.push(`更新角色「${who.name}」`);
  }

  // 删除（连带删掉跟他有关的关系）
  for (const ref of Array.isArray(o.removeCharacters) ? o.removeCharacters : []) {
    const who = resolveRef(cast, ref);
    if (!who) {
      throw new Error(
        `找不到要删除的角色「${str(ref)}」。现有角色：` +
          (cast.characters.map((c) => `${c.name}(${c.id})`).join('、') || '（空）')
      );
    }
    cast.characters = cast.characters.filter((c) => c.id !== who.id);
    const before = cast.relations.length;
    cast.relations = cast.relations.filter((r) => r.from !== who.id && r.to !== who.id);
    log.push(`删除角色「${who.name}」${before - cast.relations.length ? `（连带 ${before - cast.relations.length} 条关系）` : ''}`);
  }

  // 加关系
  for (const raw of Array.isArray(o.addRelations) ? o.addRelations : []) {
    const a = resolveRef(cast, raw && raw.from);
    const b = resolveRef(cast, raw && raw.to);
    if (!a || !b) {
      throw new Error(
        `关系两端要对得上角色：「${str(raw && raw.from)}」→「${str(raw && raw.to)}」。现有角色：` +
          (cast.characters.map((c) => c.name).join('、') || '（空）')
      );
    }
    const type = str(raw.type) || '关系';
    if (cast.relations.some((r) => r.from === a.id && r.to === b.id && r.type === type)) {
      log.push(`关系「${a.name} —${type}→ ${b.name}」已存在，跳过`);
      continue;
    }
    cast.relations.push({ from: a.id, to: b.id, type, note: str(raw.note) });
    log.push(`新增关系：${a.name} —${type}→ ${b.name}`);
  }

  // 删关系
  for (const raw of Array.isArray(o.removeRelations) ? o.removeRelations : []) {
    const a = resolveRef(cast, raw && raw.from);
    const b = resolveRef(cast, raw && raw.to);
    if (!a || !b) throw new Error(`要删的关系两端对不上角色：「${str(raw && raw.from)}」→「${str(raw && raw.to)}」`);
    const type = str(raw && raw.type);
    const before = cast.relations.length;
    cast.relations = cast.relations.filter((r) => !(r.from === a.id && r.to === b.id && (!type || r.type === type)));
    if (before === cast.relations.length) log.push(`没找到关系「${a.name} → ${b.name}${type ? ` (${type})` : ''}」，跳过`);
    else log.push(`删除关系 ${before - cast.relations.length} 条：${a.name} → ${b.name}`);
  }

  return { cast, log };
}

/**
 * 渲染成给人和 agent 读的**纯文本**人物卡（`人物卡.txt`）。
 *
 * 为什么是纯文本：这些文件你双击就用记事本打开，
 * 所以里面不写 markdown 符号（`#`、`**`、表格竖线），只用「【】」和缩进表达层级。
 *
 * @param {object} input 角色表
 * @param {{stamp?: string}} [opts]
 */
export function renderCastText(input, opts = {}) {
  const { cast } = normalizeCast(input);
  const lines = [];
  lines.push('人物卡（角色 & 人物关系）');
  lines.push('');
  lines.push('※ 本文件是自动生成的，数据源是同目录的「角色.json」。');
  lines.push('※ 要改请在右侧栏「角色」页改，或让 agent 调用 novel_cast —— 手改会在下次同步时被覆盖。');
  if (opts.stamp) lines.push('※ 最后同步：' + opts.stamp);
  lines.push('');

  if (cast.characters.length === 0) {
    lines.push('（还没有角色。在面板「角色」页添加，或让 agent 调用 novel_cast。）');
    lines.push('');
  }

  const byId = new Map(cast.characters.map((c) => [c.id, c]));
  for (const c of cast.characters) {
    lines.push('【' + (c.avatar ? c.avatar + ' ' : '') + c.name + '】' + (c.role ? ' ' + c.role : ''));
    if (c.age) lines.push('  年龄：' + c.age);
    if (c.tags.length) lines.push('  标签：' + c.tags.join(' / '));
    if (c.desc) lines.push('  简介：' + c.desc);
    const mine = cast.relations.filter((r) => r.from === c.id);
    const theirs = cast.relations.filter((r) => r.to === c.id);
    if (mine.length || theirs.length) {
      lines.push('  关系：');
      for (const r of mine) {
        const other = byId.get(r.to);
        lines.push('    ・' + r.type + ' → ' + (other ? other.name : r.to) + (r.note ? '：' + r.note : ''));
      }
      for (const r of theirs) {
        const other = byId.get(r.from);
        lines.push('    ・' + (other ? other.name : r.from) + ' → ' + r.type + '（指向本人）' + (r.note ? '：' + r.note : ''));
      }
    }
    lines.push('');
  }

  lines.push('关系总表');
  if (cast.relations.length === 0) {
    lines.push('  （暂无）');
  } else {
    for (const r of cast.relations) {
      const a = byId.get(r.from);
      const b = byId.get(r.to);
      lines.push('  ' + (a ? a.name : r.from) + ' —' + r.type + '→ ' + (b ? b.name : r.to) + (r.note ? '（' + r.note + '）' : ''));
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 角色表 → 给面板/日志用的一句话摘要 */
export function castSummary(input) {
  const { cast } = normalizeCast(input);
  return `${cast.characters.length} 个角色 · ${cast.relations.length} 条关系`;
}
