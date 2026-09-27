/**
 * 流式输出缓冲 —— 把 DSH 的 `agent/assistant-stream` 帧折成"正在写的字"
 *
 * 背景（0.1.5 的行为，抄自 dsh-better-sidebar 的 assistant-live.ts）：
 *   - 0.1.2 每个模型 delta 都会落一条 durable 的 `assistant/chunk` 事件
 *   - 0.1.5 把它删了：正在进行的尝试只发内存帧 `agent/assistant-stream`
 *     （start / chunk / end），**不进会话日志**；内容等结束后才落进
 *     `assistant/message`
 *   - 帧的形状：{ agent: { session: { id } },
 *                frame: { type, attemptId, turn, step, index, time,
 *                         chunk: { type:'text-delta'|'reasoning-delta', text } } }
 *
 * 所以想"边写边看"，就得自己把这些帧攒起来 —— 就是这个文件干的事。
 *
 * 纯逻辑、零 import，方便本地喂假帧单测。
 */

/** 单次尝试最多留多少字符（防止一本超长小说把内存吃了） */
export const STREAM_TEXT_CAP = 200000;

/** 工具参数（原始 JSON 片段）最多留多少字符 */
export const TOOL_ARGS_CAP = 400000;

/**
 * 从**还没写完的 JSON** 里抠出一个字符串字段的值。
 *
 * 为什么需要：章节正文经常是当工具参数流出来的
 * （`novel_save_chapter({"title":"…","content":"# 第2章…`），
 * 而流式片段随时可能断在转义符中间 —— 所以要能容忍"半截"。
 *
 * @param {string} raw 半截 JSON 文本
 * @param {string} field 字段名
 * @returns {{value: string, complete: boolean, found: boolean}}
 */
export function extractJsonStringField(raw, field) {
  if (typeof raw !== "string" || !raw || !field) return { value: "", complete: false, found: false };
  const key = '"' + field + '"';
  const at = raw.indexOf(key);
  if (at < 0) return { value: "", complete: false, found: false };
  let i = raw.indexOf(":", at + key.length);
  if (i < 0) return { value: "", complete: false, found: false };
  i += 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (raw[i] !== '"') return { value: "", complete: false, found: false };
  i += 1;

  let out = "";
  let complete = false;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === undefined) break; // 半个转义符：等下一块
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += n;
        i += 2;
        continue;
      } else out += n; // \" \\ \/ 等
      i += 2;
      continue;
    }
    if (c === '"') {
      complete = true;
      i += 1;
      break;
    }
    out += c;
    i += 1;
  }
  return { value: out, complete, found: true };
}

/** 一个会话的实时状态 */
function blank() {
  return {
    attemptId: "",
    turn: 0,
    step: 0,
    text: "",
    reasoning: "",
    /** 最近一次工具调用（章节正文常常藏在这儿的参数里） */
    tool: { id: "", name: "", args: "" },
    frames: 0,
    /** 有过跳帧（文字里可能缺了一块）—— 只做提示，不丢弃已收到的内容 */
    gapped: false,
    writing: false,
    startedAt: 0,
    updatedAt: 0,
    doneAt: 0,
    /** 被触碰的次序（同一毫秒内也能分出谁更新） */
    seq: 0
  };
}

/** 保存章节的工具名（正文在它的 content 参数里） */
const SAVE_CHAPTER_TOOL = "novel_save_chapter";

/**
 * 决定"面板上该显示哪段字"：
 *   1) 正在调 novel_save_chapter 且参数里已经有 content → 显示**正文**（这是最想看的）
 *   2) 否则有正文散文 → 显示散文
 *   3) 否则只有思考 → 显示思考
 * @returns {{preview: string, previewKind: 'chapter'|'text'|'reasoning'|''}}
 */
export function pickPreview(state) {
  if (!state) return { preview: "", previewKind: "" };
  const tool = state.tool || {};
  if (typeof tool.name === "string" && tool.name.indexOf(SAVE_CHAPTER_TOOL) >= 0 && tool.args) {
    const got = extractJsonStringField(tool.args, "content");
    if (got.found && got.value) return { preview: got.value, previewKind: "chapter" };
  }
  if (state.text) return { preview: state.text, previewKind: "text" };
  if (state.reasoning) return { preview: state.reasoning, previewKind: "reasoning" };
  return { preview: "", previewKind: "" };
}

/**
 * @param {{cap?: number, now?: () => number}} [opts]
 */
export function createStreamBuffer(opts = {}) {
  const cap = opts.cap || STREAM_TEXT_CAP;
  const now = opts.now || (() => Date.now());
  /** sessionId -> 状态 */
  const sessions = new Map();
  let totalFrames = 0;
  let lastFrameAt = 0;
  let rev = 0; // 每次内容有变就 +1，客户端用它判断"要不要重画"
  let touch = 0; // 单调递增的触碰序号（同一毫秒也能分出先后）

  const pub = {
    /** 收到过多少帧（0 = 这个事件根本没来，排查用） */
    totalFrames: () => totalFrames,
    lastFrameAt: () => lastFrameAt,
    size: () => sessions.size,
    /** 内容版本号 */
    revision: () => rev,
    /** 最近有过活动的会话（面板没给 sessionId 时兜底） */
    latestSessionId() {
      let best = "";
      let at = -1;
      for (const [id, s] of sessions) {
        if (s.seq > at) {
          at = s.seq;
          best = id;
        }
      }
      return best;
    },

    /** 吃一帧（帧已经是拆好的） */
    frame(sessionId, frame) {
      if (typeof sessionId !== "string" || !sessionId) return false;
      if (!frame || typeof frame !== "object") return false;
      const type = frame.type;
      totalFrames += 1;
      lastFrameAt = now();

      if (type === "end") {
        const s = sessions.get(sessionId);
        if (s) {
          s.writing = false;
          s.doneAt = lastFrameAt;
          s.updatedAt = lastFrameAt;
          s.seq = ++touch;
          rev += 1;
        }
        return true;
      }

      const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : "";
      if (!attemptId) return false;

      if (type === "start") {
        const s = blank();
        s.attemptId = attemptId;
        s.turn = Number.isInteger(frame.turn) ? frame.turn : 0;
        s.step = Number.isInteger(frame.step) ? frame.step : 0;
        s.writing = true;
        s.startedAt = lastFrameAt;
        s.updatedAt = lastFrameAt;
        s.seq = ++touch;
        sessions.set(sessionId, s);
        rev += 1;
        return true;
      }

      if (type !== "chunk") return false;
      const s = sessions.get(sessionId);
      // 没 start / 换了尝试 —— 宁可不要这段，也不要拼出错位的文字
      if (!s || s.attemptId !== attemptId) return false;

      const chunk = frame.chunk && typeof frame.chunk === "object" ? frame.chunk : null;
      if (!chunk) return false;

      // 序号跳了：这一段不要，但**保留已收到的**（预览突然变空更像 bug），
      // 只立个 gapped 标记让界面能提示"可能缺了一块"
      if (Number.isInteger(frame.index) && frame.index !== s.frames) {
        s.gapped = true;
        s.updatedAt = lastFrameAt;
        s.seq = ++touch;
        rev += 1;
        return false;
      }

      const text = typeof chunk.text === "string" ? chunk.text : "";
      if (chunk.type === "text-delta") s.text = (s.text + text).slice(-cap);
      else if (chunk.type === "reasoning-delta") s.reasoning = (s.reasoning + text).slice(-cap);
      else if (chunk.type === "tool-call-delta") {
        // 章节正文常在这里：argumentsDelta 是**原始 JSON 片段**，一块块拼
        const id = typeof chunk.id === "string" ? chunk.id : "";
        const piece = typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
        if (id && id !== s.tool.id) s.tool = { id, name: typeof chunk.name === "string" ? chunk.name : "", args: "" };
        if (typeof chunk.name === "string" && chunk.name) s.tool.name = chunk.name;
        s.tool.args = (s.tool.args + piece).slice(-TOOL_ARGS_CAP);
      } else return false;

      s.frames += 1;
      s.writing = true;
      s.updatedAt = lastFrameAt;
      s.seq = ++touch;
      rev += 1;
      return true;
    },

    /** 吃原始 payload（{agent:{session:{id}}, frame}） */
    onFrame(payload) {
      const rec = payload && typeof payload === "object" ? payload : null;
      if (!rec) return false;
      const sid = rec.agent && rec.agent.session && rec.agent.session.id;
      if (typeof sid !== "string") return false;
      return pub.frame(sid, rec.frame);
    },

    /** 客户端要的读数 */
    forSession(sessionId) {
      const id = sessionId || pub.latestSessionId();
      const s = id ? sessions.get(id) : undefined;
      const picked = pickPreview(s);
      const base = {
        session: id || "",
        preview: picked.preview,
        previewKind: picked.previewKind,
        totalFrames,
        rev
      };
      if (!s) {
        return Object.assign(base, {
          has: false,
          writing: false,
          text: "",
          reasoning: "",
          chars: 0,
          frames: 0,
          gapped: false,
          tool: { name: "", argsChars: 0, hasContent: false },
          turn: 0,
          step: 0,
          updatedAt: 0,
          doneAt: 0,
          ago: 0
        });
      }
      const toolContent = extractJsonStringField(s.tool.args, "content");
      return Object.assign(base, {
        has: true,
        writing: s.writing,
        text: s.text,
        reasoning: s.reasoning,
        chars: s.text.length,
        frames: s.frames,
        gapped: s.gapped,
        tool: {
          name: s.tool.name,
          argsChars: s.tool.args.length,
          hasContent: !!(toolContent.found && toolContent.value)
        },
        turn: s.turn,
        step: s.step,
        updatedAt: s.updatedAt,
        doneAt: s.doneAt,
        ago: Math.max(0, now() - s.updatedAt)
      });
    },

    /** 清掉某个会话的缓冲（测试用） */
    clear(sessionId) {
      if (sessionId === undefined) sessions.clear();
      else sessions.delete(sessionId);
      rev += 1;
    }
  };

  return pub;
}
