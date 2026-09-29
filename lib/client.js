/**
 * dsh-novel 客户端半 —— 右侧栏「小说」面板（v0.5：改设定 / 加角色拉关系 / 新建小说 / 一键续写）
 *
 * 交付格式：DSH 客户端模块格式（window.__ModuleLoader__）
 *   - 宿主侧 client-modules 服务把本文件挂在 /plugins/dsh-novel/client.js
 *   - 浏览器内核加载它，factory(require) 里的 require 由宿主提供（react 等）
 *   - 所以**不需要 import 任何东西**，也没有打包/JSX 步骤，统一 react.createElement
 *
 * 注册方式：借 dsh-better-sidebar 的 ctx.betterSidebar.registerTab(descriptor)
 *
 * 数据来源（宿主侧 lib/index.js，同源 fetch，不受 0.1.5 的 web 认证 401 影响）：
 *   GET  /novel/api/list       小说 + 章节 + 角色统计
 *   GET  /novel/api/read       读一章正文 / 一个设定文件
 *   GET  /novel/api/cast       读角色表
 *   POST /novel/api/cast       存角色表（整表替换）
 *   POST /novel/api/save       存设定文件 / 章节
 *   POST /novel/api/novel      新建小说
 *
 * 「✍️ 写下一章」额外"蹭"了对话插件的输入框（setDraft + submit），
 * 拿不到就降级提示，绝不炸面板。
 *
 * 组件结构（每个视图自己管自己，切视图就重挂，状态自然重置）：
 *   NovelPanel ─┬─ ChapterView   章节列表 + 正文预览
 *               ├─ SettingsView  大纲 / 世界观 可编辑（Ctrl+S 保存）
 *               ├─ CastView      角色卡 + 人物关系（保存后自动同步「人物卡.txt」）
 *               └─ NewNovelForm  新建小说（书名 + 一句话简介）
 */
window.__ModuleLoader__.load({
	id: "dsh-novel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		/** 声明依赖的客户端服务（dsh-better-sidebar 发布的） */
		const inject = ["betterSidebar"];

		const ROLES = ["主角", "配角", "反派", "路人"];
		const enc = encodeURIComponent;
		/** 默认轮询间隔（"实时"档） */
		const POLL_MS = 3000;
		/** 流式输出轮询间隔：要"跟得上打字"，所以快得多 */
		const POLL_LIVE_MS = 400;
		/** 直播框里最多显示多少个字（只看尾巴，最新的一定在屏幕上） */
		const LIVE_TAIL = 2000;
		/** 偏好存在浏览器本地（纯客户端，改完不用重启 DSH） */
		const POLL_KEY = "dsh-novel:poll";
		const POLL_CUSTOM_KEY = "dsh-novel:pollCustom";

		/** 4 个预设档：说清楚"你会得到什么 / 付出多少请求" */
		const POLL_PRESETS = [
			{ id: "live", label: "实时", listMs: POLL_MS, liveMs: POLL_LIVE_MS, hint: "列表 3 秒 · 直播 0.4 秒" },
			{ id: "normal", label: "普通", listMs: 10000, liveMs: 2000, hint: "列表 10 秒 · 直播 2 秒" },
			{ id: "eco", label: "省电", listMs: 30000, liveMs: 0, hint: "列表 30 秒 · 不直播" },
			{ id: "off", label: "关闭", listMs: 0, liveMs: 0, hint: "完全不轮询，手动点「刷新」" }
		];
		/** 下拉里的选项 = 4 个预设 + 自定义 */
		const POLL_CHOICES = POLL_PRESETS.concat([{ id: "custom", label: "自定义", hint: "自己填秒数" }]);
		/** 自定义的取值范围（秒） */
		const CUSTOM_LIST_RANGE = [1, 3600];
		const CUSTOM_LIVE_RANGE = [0.2, 3600];

		function readPollPref() {
			try {
				const v = localStorage.getItem(POLL_KEY);
				return POLL_CHOICES.some((p) => p.id === v) ? v : "live";
			} catch (e) {
				return "live"; // 没有 localStorage（或隐私模式）就用默认
			}
		}

		function writePollPref(id) {
			try {
				localStorage.setItem(POLL_KEY, id);
			} catch (e) {
				/* 存不了就算了，本次会话内仍然生效 */
			}
		}

		/** 自定义档的两个输入框（存的是**用户敲的原文**，读回来再校验，坏值不炸） */
		function readCustomDraft() {
			try {
				const raw = localStorage.getItem(POLL_CUSTOM_KEY);
				const o = raw ? JSON.parse(raw) : null;
				return {
					list: o && o.list !== undefined && o.list !== null ? String(o.list) : "5",
					live: o && o.live !== undefined && o.live !== null ? String(o.live) : "1"
				};
			} catch (e) {
				return { list: "5", live: "1" };
			}
		}

		function writeCustomDraft(d) {
			try {
				localStorage.setItem(POLL_CUSTOM_KEY, JSON.stringify({ list: String(d.list), live: String(d.live) }));
			} catch (e) {
				/* 同上 */
			}
		}

		/** 把用户敲的字夹到合法区间；非法（空/NaN）返回 null 让调用方兜底 */
		function clampSec(v, min, max) {
			const n = parseFloat(v);
			if (!isFinite(n)) return null;
			return Math.min(max, Math.max(min, n));
		}

		/** 自定义档的生效毫秒数 */
		function customMsOf(draft) {
			const list = clampSec(draft.list, CUSTOM_LIST_RANGE[0], CUSTOM_LIST_RANGE[1]);
			const liveRaw = parseFloat(draft.live);
			// 直播填 0（或负数）就是"不直播"
			const live = !isFinite(liveRaw) || liveRaw <= 0 ? 0 : clampSec(draft.live, CUSTOM_LIVE_RANGE[0], CUSTOM_LIVE_RANGE[1]);
			return {
				listMs: list === null ? POLL_MS : list * 1000,
				liveMs: live === 0 ? 0 : live * 1000
			};
		}

		/** 小说列表的指纹：变了才重新渲染（避免轮询把界面一直刷） */
		function listSig(novels) {
			return JSON.stringify(
				(novels || []).map((n) => [
					n.name,
					n.chapterCount,
					(n.settings || []).join(","),
					n.cast ? n.cast.characters + "/" + n.cast.relations : "0/0",
					(n.chapters || []).map((c) => c.file + ":" + c.size).join("|")
				])
			);
		}

		const CSS = [
			".dn_root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px}",
			".dn_head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;font-weight:600;border-bottom:1px solid rgba(128,128,128,.25)}",
			".dn_hbtns{display:flex;gap:6px}",
			".dn_btn{cursor:pointer;font:inherit;font-size:12px;padding:2px 9px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}",
			".dn_btn:hover:not(:disabled){background:rgba(128,128,128,.15)}",
			".dn_btn:disabled{opacity:.45;cursor:default}",
			".dn_btn.primary{background:#1976d2;border-color:transparent;color:#fff}",
			".dn_btn.danger{color:#c0392b;border-color:rgba(192,57,43,.5)}",
			".dn_book{padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}",
			".dn_sel{margin:7px 12px 0;font:inherit;font-size:12px;padding:4px 6px;border-radius:7px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;max-width:100%}",
			".dn_tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.18);flex-wrap:wrap}",
			".dn_tab{cursor:pointer;font:inherit;font-size:12px;padding:3px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}",
			".dn_tab.on{background:#1976d2;border-color:transparent;color:#fff}",
			".dn_v{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}",
			".dn_rows{flex:0 1 auto;max-height:34%;overflow:auto;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_item{display:flex;align-items:baseline;justify-content:space-between;gap:8px;width:100%;text-align:left;cursor:pointer;font:inherit;font-size:12px;padding:4px 7px;border-radius:7px;border:0;background:transparent;color:inherit}",
			".dn_item:hover{background:rgba(128,128,128,.14)}",
			".dn_item.on{background:rgba(25,118,210,.16)}",
			".dn_it{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dn_meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#999)}",
			".dn_read{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px}",
			".dn_pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.75 ui-monospace,'Cascadia Mono',Consolas,'Microsoft YaHei',monospace}",
			".dn_ph{padding:10px 12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.7;font-size:12px}",
			".dn_err{padding:8px 12px;color:#c0392b;font-size:12px;line-height:1.6;word-break:break-word}",
			".dn_ok2{padding:8px 12px;color:#2e7d32;font-size:12px;line-height:1.6}",
			".dn_warn{padding:8px 12px;margin:6px 10px;border-radius:7px;background:rgba(255,152,0,.14);color:#b26a00;font-size:11.5px;line-height:1.65}",
			".dn_foot{padding:7px 12px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#999);border-top:1px solid rgba(128,128,128,.18)}",
			".dn_footrow{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}",
			".dn_mini{font:inherit;font-size:11px;padding:1px 4px;border-radius:5px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}",
			".dn_num{width:46px;font:inherit;font-size:11px;padding:1px 3px;border-radius:5px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}",
			".dn_customrow{display:flex;align-items:center;gap:4px;flex-wrap:wrap}",
			".dn_ta{flex:1 1 auto;min-height:120px;margin:8px 12px;padding:8px 10px;resize:vertical;font:12px/1.75 ui-monospace,'Cascadia Mono',Consolas,'Microsoft YaHei',monospace;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.06);color:inherit}",
			".dn_acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px 10px}",
			".dn_hint{font-size:11px;color:var(--dsw-alias-label-secondary,#999)}",
			".dn_form{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_f{display:flex;flex-direction:column;gap:3px}",
			".dn_fl{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}",
			".dn_in{font:inherit;font-size:12px;padding:4px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;width:100%;box-sizing:border-box}",
			".dn_grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
			".dn_sec{padding:4px 12px 0;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#888)}",
			".dn_rel{display:flex;align-items:center;gap:6px;padding:2px 12px;font-size:12px}",
			".dn_reltext{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dn_addrel{display:flex;flex-direction:column;gap:6px;padding:6px 12px 10px}",
			".dn_scroll{flex:1 1 auto;min-height:0;overflow:auto}",
			".dn_edit{padding:8px 12px;border-top:1px solid rgba(128,128,128,.18);display:flex;flex-direction:column;gap:8px}",
			".dn_toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_live{flex:0 1 auto;max-height:38%;overflow:auto;margin:6px 10px;padding:8px 10px;border-radius:8px;background:rgba(25,118,210,.09);border:1px solid rgba(25,118,210,.28)}",
			".dn_livehead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;color:#1976d2;margin-bottom:5px}",
			".dn_livepre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.7 ui-monospace,'Cascadia Mono',Consolas,'Microsoft YaHei',monospace}",
			".dn_livepre.reason{color:var(--dsw-alias-label-secondary,#888);font-style:italic}",
			".dn_chbar{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_chbar .dn_it{flex:1 1 auto;font-size:12px}",
			".dn_chrename{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_graphwrap{margin:8px 12px;padding:6px;border:1px solid rgba(128,128,128,.22);border-radius:8px}",
			".dn_graph{display:block;width:100%;height:auto;color:inherit}",
			".dn_graphtip{padding:2px 4px 0;font-size:10.5px;color:var(--dsw-alias-label-secondary,#999);text-align:center}",
			".dn_graphacts{display:flex;align-items:center;justify-content:center;gap:6px;padding-top:4px}",
			".dn_node{cursor:grab}",
			".dn_node.dragging{cursor:grabbing}",
			".dn_avatar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 6px}",
			".dn_avimg{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid rgba(25,118,210,.45);flex:none}",
			".dn_avph{width:44px;height:44px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:18px;background:rgba(128,128,128,.18)}",
			".dn_avmini{width:16px;height:16px;border-radius:50%;object-fit:cover;vertical-align:-3px;margin-right:4px}",
			".dn_relneed{margin:2px 12px 8px;padding:6px 8px;border-radius:7px;background:rgba(128,128,128,.12);line-height:1.5}",
			".dn_bookrow{display:flex;align-items:baseline;gap:6px;width:100%;text-align:left;padding:7px 12px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px}",
			".dn_bookrow.pick{cursor:pointer}",
			".dn_bookrow.pick:hover{background:rgba(128,128,128,.12)}",
			".dn_bookn{flex:none;max-width:62%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dn_bookmeta{flex:1 1 auto;font-size:11px;color:var(--dsw-alias-label-secondary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dn_caret{flex:none;color:var(--dsw-alias-label-secondary,#999)}",
			".dn_sw{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}",
			".dn_swhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;font-weight:600;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_swtools{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.18)}",
			".dn_swlist{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}",
			".dn_swrow{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;cursor:pointer;font:inherit;padding:6px 8px;border-radius:8px;border:0;background:transparent;color:inherit;margin-bottom:4px}",
			".dn_swrow:hover{background:rgba(128,128,128,.14)}",
			".dn_swrow.on{background:rgba(25,118,210,.16)}",
			".dn_swtitle{font-size:12px;font-weight:600}",
			".dn_swmeta,.dn_swseen{font-size:11px;color:var(--dsw-alias-label-secondary,#999)}",
			".dn_swacts{display:flex;gap:4px;margin-top:3px}",
			".dn_swrename{display:flex;align-items:center;gap:6px}",
			".dn_item{cursor:pointer}",
			".dn_item.dragging{opacity:.45}",
			".dn_item.over{background:rgba(25,118,210,.22);box-shadow:inset 0 2px 0 #1976d2}",
			".dn_vol{display:flex;align-items:center;gap:6px;padding:6px 10px 3px;font-size:11px;color:var(--dsw-alias-label-secondary,#999);border-top:1px solid rgba(128,128,128,.14)}",
			".dn_vol:first-child{border-top:0}",
			".dn_vol.over{background:rgba(25,118,210,.14);border-radius:6px}",
			".dn_volname{flex:1 1 auto;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dn_volmeta{flex:none}",
			".dn_editbody{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}"
		].join("\n");

		let cssDone = false;
		function ensureCss() {
			if (cssDone || typeof document === "undefined") return;
			cssDone = true;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-novel", "1");
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function fmtSize(n) {
			if (!n) return "";
			return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
		}

		/** 调宿主 API（同源，不用管认证） */
		async function api(path, opts) {
			const init =
				opts && opts.body
					? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) }
					: undefined;
			let res;
			try {
				res = await fetch("/novel/api" + path, init);
			} catch (e) {
				throw new Error("连不上 DSH：" + String((e && e.message) || e));
			}
			if (res.status === 404) {
				// 常见情况：客户端半热更新了、宿主半还没重启
				throw new Error("宿主 API 未加载（404）—— 重启一次 dsh web 即可生效");
			}
			let data = null;
			try {
				data = await res.json();
			} catch (e) {
				throw new Error("响应不是 JSON（HTTP " + res.status + "）");
			}
			if (!data || data.ok !== true) {
				throw new Error((data && data.message) || "HTTP " + res.status);
			}
			return data;
		}

		// ─────────────────── 把请求写进对话输入框（「写下一章」按钮用） ───────────────────
		/**
		 * 拿到当前会话的输入框 facade。
		 *
		 * 路子抄 dsh-better-sidebar 的 conversation-draft.ts：
		 *   ctx.get('conversation').input.for(会话作用域 ctx)
		 * facade 上有 setDraft(text) 和 submit(mode) —— 也就是**能替用户发消息**。
		 *
		 * 全程 try/catch：这属于"蹭"别的插件的服务，拿不到就安静降级。
		 */
		function composerInput(ctx, scope) {
			try {
				if (!ctx || typeof ctx.get !== 'function') return null;
				const conversation = ctx.get('conversation');
				if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') return null;
				let actx = ctx;
				const sid = scope && scope.sessionId;
				if (sid) {
					const sessions = ctx.sessions || ctx.get('sessions');
					if (sessions && typeof sessions.scope === 'function') actx = sessions.scope(sid) || ctx;
				}
				return conversation.input.for(actx) || null;
			} catch (e) {
				return null;
			}
		}

		function currentDraft(input) {
			try {
				const snap = input.state && input.state.getSnapshot ? input.state.getSnapshot() : input.snapshot;
				return String((snap && snap.draft) || '');
			} catch (e) {
				return '';
			}
		}

		/**
		 * 把一段话送进输入框：
		 * - 空的 → 填进去并**直接发送**（这就是"点一下让它写"）
		 * - 非空 → 只追加，绝不覆盖，让用户自己按 Enter
		 */
		function writeToComposer(ctx, scope, text) {
			const input = composerInput(ctx, scope);
			if (!input) {
				return { kind: 'err', text: '没接上输入框（拿不到 conversation 服务）—— 直接在聊天里说「写下一章」也一样' };
			}
			const draft = currentDraft(input);
			if (draft.trim()) {
				if (typeof input.setDraft === 'function') input.setDraft(draft.replace(/\s+$/, '') + '\n\n' + text);
				return { kind: 'ok', text: '输入框里已有内容，我把续写请求追加在后面了 —— 你按 Enter 发送' };
			}
			if (typeof input.setDraft === 'function') input.setDraft(text);
			if (typeof input.submit === 'function') {
				input.submit('queue'); // agent 正忙就排队，不打断它
				return { kind: 'ok', text: '✅ 已替你发进会话，小d 开始写了（写完会自动存盘）' };
			}
			return { kind: 'ok', text: '已填进输入框，你按 Enter 发送' };
		}

		// ─────────────────── 小说库：记住"打开哪本 / 每本读到哪" ───────────────────
		/**
		 * 存在浏览器本地（跟「自动刷新档位」一个路子），**按小说库根目录分组**：
		 *
		 *   { "D:\\dsh-novel": { open: "书名", recent: ["书名", …], seen: { "书名": { view, file } } } }
		 *
		 * 为什么按根目录分组：以后你把小说库切到别的盘，两边的「上次打开」互不干扰。
		 *
		 * ⚠️ 客户端半不能 import 自己的文件（宿主只给 react），所以这套逻辑只能写在这里；
		 *    为了能单元测试，最后会挂到 exports.__test 上（宿主只读 apply/inject，多挂一个键无害）。
		 */
		const LIBRARY_KEY = "dsh-novel:library";
		const RECENT_CAP = 20;

		function readLibrary() {
			try {
				const raw = localStorage.getItem(LIBRARY_KEY);
				const o = raw ? JSON.parse(raw) : null;
				return o && typeof o === "object" && !Array.isArray(o) ? o : {};
			} catch (e) {
				return {}; // 没 localStorage / 坏数据 → 当空的重来，绝不炸面板
			}
		}

		function writeLibrary(lib) {
			try {
				localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib || {}));
			} catch (e) {
				/* 存不了就本次会话内生效 */
			}
		}

		/** 取某个小说库的记录：字段一律补齐，坏数据也不炸 */
		function libRecord(lib, root) {
			const rec = lib && root ? lib[root] : null;
			const ok = rec && typeof rec === "object" && !Array.isArray(rec) ? rec : {};
			return {
				open: typeof ok.open === "string" ? ok.open : "",
				recent: Array.isArray(ok.recent) ? ok.recent.filter((n) => typeof n === "string" && n) : [],
				seen: ok.seen && typeof ok.seen === "object" && !Array.isArray(ok.seen) ? ok.seen : {},
				// 每本小说关系图里人手拖出来的节点位置
				pos: ok.pos && typeof ok.pos === "object" && !Array.isArray(ok.pos) ? ok.pos : {}
			};
		}

		/**
		 * 该打开哪本？
		 *   记住的还在      → remembered（正常）
		 *   记住的没了      → 从 recent 里找还在的 → vanished（要明确提示用户）
		 *   一本都没有      → 第一本 → fresh
		 */
		function chooseOpen(record, names) {
			const has = (n) => typeof n === "string" && n !== "" && names.indexOf(n) >= 0;
			if (!names.length) return { name: null, source: "empty" };
			if (has(record.open)) return { name: record.open, source: "remembered" };
			for (const n of record.recent) {
				if (has(n)) return { name: n, source: record.open ? "vanished" : "recent" };
			}
			return { name: names[0], source: record.open ? "vanished" : "fresh" };
		}

		/** 某本书上次看到哪 */
		function seenOf(record, name) {
			const s = name && record && record.seen ? record.seen[name] : null;
			return s && typeof s === "object"
				? {
						view: typeof s.view === "string" ? s.view : "",
						file: typeof s.file === "string" ? s.file : ""
				  }
				: null;
		}

		function cloneLib(lib) {
			try {
				return JSON.parse(JSON.stringify(lib || {}));
			} catch (e) {
				return {};
			}
		}

		/** 记下"现在打开的是这本"（顺手推进 recent）；没变化就原样返回（省一次重渲染） */
		function rememberOpen(lib, root, name) {
			if (!root) return lib;
			const rec = libRecord(lib, root);
			if (rec.open === name && rec.recent[0] === name) return lib;
			const next = cloneLib(lib);
			next[root] = Object.assign({}, rec, {
				open: name || "",
				recent: name ? [name].concat(rec.recent.filter((n) => n !== name)).slice(0, RECENT_CAP) : rec.recent
			});
			return next;
		}

		/** 记下"这本上次看到哪"；没变化就原样返回 */
		function rememberSeen(lib, root, name, view, file) {
			if (!root || !name) return lib;
			const rec = libRecord(lib, root);
			const cur = rec.seen[name];
			if (cur && cur.view === view && cur.file === file) return lib;
			const next = cloneLib(lib);
			const seen = Object.assign({}, rec.seen);
			seen[name] = { view: view, file: file };
			next[root] = Object.assign({}, rec, { seen: seen });
			return next;
		}

		/** 小说被删了 / 改名了：把记忆也一起收拾干净，免得下次提示"上次打开的不在了" */
		function forgetNovel(lib, root, name) {
			if (!root || !name) return lib;
			const rec = libRecord(lib, root);
			if (rec.open !== name && rec.recent.indexOf(name) < 0 && !rec.seen[name]) return lib;
			const next = cloneLib(lib);
			const seen = Object.assign({}, rec.seen);
			delete seen[name];
			const pos = Object.assign({}, rec.pos);
			delete pos[name];
			next[root] = Object.assign({}, rec, {
				open: rec.open === name ? "" : rec.open,
				recent: rec.recent.filter((n) => n !== name),
				seen: seen,
				pos: pos
			});
			return next;
		}

		/** 小说改名了：记忆跟着搬过去（open / recent / seen / pos 都要） */
		function renameInLib(lib, root, from, to) {
			if (!root || !from || !to || from === to) return lib;
			const rec = libRecord(lib, root);
			const next = cloneLib(lib);
			const seen = Object.assign({}, rec.seen);
			const pos = Object.assign({}, rec.pos);
			if (seen[from]) {
				seen[to] = seen[from];
				delete seen[from];
			}
			if (pos[from]) {
				pos[to] = pos[from];
				delete pos[from];
			}
			next[root] = Object.assign({}, rec, {
				open: rec.open === from ? to : rec.open,
				recent: rec.recent.map((n) => (n === from ? to : n)),
				seen: seen,
				pos: pos
			});
			return next;
		}

		/** 某本小说关系图的节点位置（人手拖出来的） */
		function graphPosOf(record, name) {
			const p = name && record && record.pos ? record.pos[name] : null;
			return p && typeof p === "object" && !Array.isArray(p) ? p : {};
		}

		/** 记下一个节点的位置 */
		function setGraphPos(lib, root, name, id, x, y) {
			if (!root || !name || !id) return lib;
			const rec = libRecord(lib, root);
			const all = Object.assign({}, rec.pos);
			const one = Object.assign({}, all[name]);
			const px = Math.round(Number(x) || 0);
			const py = Math.round(Number(y) || 0);
			if (one[id] && one[id].x === px && one[id].y === py) return lib;
			one[id] = { x: px, y: py };
			all[name] = one;
			const next = cloneLib(lib);
			next[root] = Object.assign({}, rec, { pos: all });
			return next;
		}

		/** 清掉某本小说的手拖布局（回到自动摆圈） */
		function clearGraphPos(lib, root, name) {
			if (!root || !name) return lib;
			const rec = libRecord(lib, root);
			if (!rec.pos[name]) return lib;
			const all = Object.assign({}, rec.pos);
			delete all[name];
			const next = cloneLib(lib);
			next[root] = Object.assign({}, rec, { pos: all });
			return next;
		}

		/** 这本小说"上次写作时间"：取所有章节里最新的 mtime */
		function lastWriteOf(n) {
			let t = 0;
			for (const c of (n && n.chapters) || []) if (c.mtime > t) t = c.mtime;
			return t;
		}

		function agoText(ms) {
			if (!ms) return "还没写过";
			const d = Date.now() - ms;
			if (d < 60000) return "刚刚写过";
			if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + " 分钟前写过";
			if (d < 86400000) return Math.round(d / 3600000) + " 小时前写过";
			return Math.round(d / 86400000) + " 天前写过";
		}

		/** 排序：recent-write（默认）/ recent-open / name */
		function sortNovels(novels, sort, record) {
			const list = (novels || []).slice();
			const byName = (a, b) => String(a.name).localeCompare(String(b.name), "zh");
			if (sort === "name") return list.sort(byName);
			if (sort === "recent-open") {
				const rank = (n) => {
					const i = record.recent.indexOf(n.name);
					return i < 0 ? 9999 : i;
				};
				return list.sort((a, b) => rank(a) - rank(b) || byName(a, b));
			}
			return list.sort((a, b) => lastWriteOf(b) - lastWriteOf(a) || byName(a, b));
		}

		/** 章节文件名 → 人看的「第2章 标题」 */
		function chapterLabel(file) {
			const stem = String(file || "").replace(/\.[^.]+$/, "");
			const m = /^第(\d+)章[-_—\s]*(.*)$/.exec(stem);
			return m ? "第" + Number(m[1]) + "章 " + (m[2] || "") : stem;
		}

		// ───────────────────────── 小控件 ─────────────────────────
		function Btn(label, onClick, opts) {
			const o = opts || {};
			return h(
				"button",
				{
					key: o.key,
					className: "dn_btn" + (o.kind ? " " + o.kind : ""),
					disabled: !!o.disabled,
					title: o.title,
					onClick: o.disabled ? undefined : onClick
				},
				label
			);
		}

		function Field(label, value, onChange, opts) {
			const o = opts || {};
			return h(
				"label",
				{ className: "dn_f", key: o.key },
				label ? h("span", { className: "dn_fl" }, label) : null,
				h("input", {
					className: "dn_in",
					value: value === undefined || value === null ? "" : String(value),
					placeholder: o.placeholder || "",
					onChange: (e) => onChange(e.target.value)
				})
			);
		}

		function Notice(kind, text) {
			return h("div", { className: kind === "err" ? "dn_err" : "dn_ok2", key: "notice" }, text);
		}

		/** 只看尾巴：最新写出来的字永远在可视区里（省掉 DOM 里那套滚动跟随） */
		function tailOf(text, n) {
			const s = String(text || "");
			return s.length > n ? "…" + s.slice(-n) : s;
		}

		/** 直播框的标题 */
		function liveHead(live) {
			if (live.writing) {
				if (live.kind === "chapter") return "✍️ 正在写正文…";
				if (live.kind === "reasoning") return "🤔 正在想…";
				return "✍️ 正在写…";
			}
			if (live.kind === "chapter") return "✅ 正文写完了（正在存盘 / 已存盘）";
			return "✅ 刚输出完";
		}

		/**
		 * 一列可点的条目（章节用）。
		 * 传了 drag 就能拖着排序：
		 *   drag = { from, over, onDown(i), onEnter(i), onUp(i) }
		 * 用 pointerdown / pointerenter / pointerup 而不是 HTML5 拖放 ——
		 * 侧栏里 HTML5 drag 很挑元素，pointer 事件更稳。
		 */
		/**
		 * 通用列表。`rows` 里可以混两种行：
		 *   · 普通行：{ file, label, meta } —— 可点、可拖
		 *   · 卷标题行：{ head: true, volume, label, meta, actions } —— 章节的"分组标题"，
		 *     本身也是个**落点**（把章节拖到卷标题上 = 拖进这一卷）
		 */
		function Sheet(rows, active, onPick, drag) {
			if (!rows.length) return null;
			const d = drag || {};
			const dragging = d.from >= 0 && d.from !== undefined;
			return h(
				"div",
				{ className: "dn_rows" },
				rows.map((r, i) => {
					if (r.head) {
						return h(
							"div",
							{
								key: "v-" + (r.volume || "__none__"),
								className: "dn_vol" + (dragging && d.over === i ? " over" : ""),
								onPointerEnter: d.onEnter ? () => d.onEnter(i) : undefined,
								onPointerUp: d.onUp ? () => d.onUp(i) : undefined
							},
							h("span", { className: "dn_volname" }, r.label),
							h("span", { className: "dn_volmeta" }, r.meta),
							...(r.actions || [])
						);
					}
					const isOver = dragging && d.over === i && d.over !== d.from;
					return h(
						"div",
						{
							key: r.file,
							role: "button",
							tabIndex: 0,
							className:
								"dn_item" +
								(active === r.file ? " on" : "") +
								(dragging && d.from === i ? " dragging" : "") +
								(isOver ? " over" : ""),
							title: dragging ? "松手放到这里" : "按住可以拖动排序（拖到别的卷标题上 = 挪进那一卷）",
							onPointerDown: d.onDown ? () => d.onDown(i) : undefined,
							onPointerEnter: d.onEnter ? () => d.onEnter(i) : undefined,
							onPointerUp: d.onUp ? () => d.onUp(i) : undefined,
							onClick: () => onPick(r.file)
						},
						h("span", { className: "dn_it" }, r.label),
						h("span", { className: "dn_meta" }, r.meta)
					);
				})
			);
		}

		// ───────────────────────── 章节（只看） ─────────────────────────
		function ChapterView(props) {
			const novel = props.novel;
			const name = novel.name;
			// 用"章节文件签名"当依赖：列表因为别的操作刷新时不至于重新挑一章
			const sig = (novel.chapters || []).map((c) => c.file).join("|");
			const [openFile, setOpenFile] = react.useState(null);
			/** 是否"跟着最新一章走"：有记忆（上次看到某章）就先不跟 */
			const [following, setFollowing] = react.useState(!props.initialFile);
			const [renaming, setRenaming] = react.useState(false);
			const [draftTitle, setDraftTitle] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			/** 拖拽排序：从哪一行拖起 / 悬在哪一行 */
			const [dragFrom, setDragFrom] = react.useState(-1);
			const [dragOver, setDragOver] = react.useState(-1);
			/** 新建空章节 */
			const [adding, setAdding] = react.useState(false);
			const [newTitle, setNewTitle] = react.useState("");
			/** 新章节加到哪一卷（'' = 未分卷；由点哪一组的「＋」决定） */
			const [addTo, setAddTo] = react.useState("");
			/** 新建卷 */
			const [addingVol, setAddingVol] = react.useState(false);
			const [newVol, setNewVol] = react.useState("");
			/** 直接改正文 */
			const [editing, setEditing] = react.useState(false);
			const [draft, setDraft] = react.useState("");
			const [saving, setSaving] = react.useState(false);
			const [doc, setDoc] = react.useState({ loading: false, error: null, body: "", file: "" });
			const chapters = props.novel.chapters || [];
			const cur = chapters.find((c) => c.file === openFile) || null;
			/** 记住"当前这一章属于哪本"，换书时要重新挑 */
			const novelRef = react.useRef(name);

			react.useEffect(() => {
				const files = (props.novel.chapters || []).map((c) => c.file);
				const last = files.length ? files[files.length - 1] : null;
				const switched = novelRef.current !== name;
				novelRef.current = name;
				if (switched) setFollowing(!props.initialFile); // 换书了：有记忆就跟记忆，没有就看最新章
				setOpenFile((prev) => {
					if (!files.length) return null;
					// 现在这章还有效（而且是同一本书）→ 保留
					if (prev && !switched && files.indexOf(prev) >= 0) {
						return following && prev !== last ? last : prev;
					}
					// 回到上次看到的那一章（只在"刚开面板 / 刚换书"时用一次）
					const want = props.initialFile;
					if (want && files.indexOf(want) >= 0) return want;
					return following ? last : files[0];
				});
			}, [sig, following, props.initialFile, name]);

			// 把"正在看哪一章"上报给小说库
			react.useEffect(() => {
				if (openFile && props.onSeen) props.onSeen("chapters", openFile);
			}, [openFile, props.onSeen]);

			function pick(file) {
				const files = (props.novel.chapters || []).map((c) => c.file);
				setFollowing(file === files[files.length - 1]);
				setOpenFile(file);
				setRenaming(false);
				setMsg(null);
			}

			/** 新建一章空章节：建完自动打开它，并进编辑态 */
			function addChapter() {
				const title = newTitle.trim();
				if (!title || busy) return;
				setBusy(true);
				setMsg(null);
				api("/chapter", { body: { novel: name, action: "create", title: title, volume: addTo } })
					.then((d) => {
						setBusy(false);
						setAdding(false);
						setNewTitle("");
						setMsg({
							kind: "ok",
							text: "✅ 已新建 " + (d.created || "") + (addTo ? "（在「" + addTo + "」卷里）" : "") + " —— 可以直接在这儿写正文"
						});
						// 用宿主给的真实文件名推出骨架，直接进编辑态（不然编辑框是空的）
						// ⚠️ 卷里的 id 形如「第一卷/第002章-x.txt」，所以要先取文件名再抠编号
						const m = /^第(\d+)章-(.*)\.(txt|md)$/i.exec(String(d.created || "").split("/").pop());
						setDraft(m ? "第" + Number(m[1]) + "章 " + m[2] + "\n\n" : "");
						setOpenFile(d.created || null);
						setEditing(true);
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			/** 保存正文（.txt 由宿主抹掉 markdown；.md 保持原样） */
			function saveBody() {
				if (!cur || saving) return;
				setSaving(true);
				setMsg(null);
				api("/save", { body: { novel: name, file: cur.file, text: draft } })
					.then((d) => {
						setSaving(false);
						setEditing(false);
						setDoc({ loading: false, error: null, body: draft, file: cur.file });
						setMsg({
							kind: "ok",
							text: "✅ 已保存 " + cur.file + (d && d.plain ? "（已按纯文本存）" : "")
						});
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setSaving(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			/** 拖拽排序 / 挪卷：松手时把新顺序发给宿主重新编号（id 带哪一卷的前缀 = 挪进哪一卷） */
			function dropAt(overIdx) {
				const from = dragFrom;
				setDragFrom(-1);
				setDragOver(-1);
				if (from < 0 || overIdx === undefined || overIdx < 0 || from === overIdx) return;
				const fromRow = rows[from];
				const overRow = rows[overIdx];
				if (!fromRow || fromRow.head || !overRow) return; // 卷标题不能拖

				const files = chapters.map((c) => c.file);
				const moved = fromRow.file;
				const rest = files.filter((f) => f !== moved);
				const targetVolume = overRow.volume || "";
				const movedName = moved.split("/").pop();
				const newId = targetVolume ? targetVolume + "/" + movedName : movedName;

				let at = rest.length;
				if (overRow.head) {
					// 落在卷标题上 → 放进那一卷（排在那一组末尾；空卷就排到它该在的位置）
					const volOrder = [""].concat(props.novel.volumes || []);
					const wantIdx = volOrder.indexOf(targetVolume);
					for (let i = 0; i < rest.length; i += 1) {
						const c = chapters.find((x) => x.file === rest[i]);
						if (c && volOrder.indexOf(c.volume) > wantIdx) {
							at = i;
							break;
						}
					}
				} else {
					// 落在某一章上 → 挪到它**原来的位置**上（往下拖就落在它后面，跟拖之前比一定有变化）
					const idx = files.indexOf(overRow.file);
					at = idx < 0 ? rest.length : Math.min(idx, rest.length);
				}

				const next = rest.slice();
				next.splice(at, 0, newId);
				if (next.join("|") === files.join("|")) return;
				setMsg(null);
				api("/chapter", { body: { novel: name, action: "reorder", order: next } })
					.then(() => {
						setMsg({
							kind: "ok",
							text: targetVolume ? "↕️ 已挪进「" + targetVolume + "」并重新编号" : "↕️ 顺序已保存（文件已重新编号）"
						});
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => setMsg({ kind: "err", text: String((e && e.message) || e) }));
			}

			/** 卷：新建 / 改名 / 删除（删卷 = 整卷进回收站，章节跟着走，能捞回来） */
			function doCreateVolume() {
				const v = newVol.trim();
				if (!v || busy) return;
				setBusy(true);
				setMsg(null);
				api("/volume", { body: { novel: name, action: "create", name: v } })
					.then(() => {
						setBusy(false);
						setAddingVol(false);
						setNewVol("");
						setMsg({ kind: "ok", text: "✅ 建好「" + v + "」了，可以往里加章节" });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			function doRenameVolume(v) {
				const to = typeof prompt === "function" ? prompt("这一卷改叫什么？", v) : null;
				if (!to || to === v) return;
				setMsg(null);
				api("/volume", { body: { novel: name, action: "rename", from: v, name: to } })
					.then(() => {
						setMsg({ kind: "ok", text: "✅ 第「" + to + "」卷已改名" });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => setMsg({ kind: "err", text: String((e && e.message) || e) }));
			}

			function doDeleteVolume(v) {
				const n = chapters.filter((c) => c.volume === v).length;
				if (typeof confirm === "function" && !confirm("删掉「" + v + "」这一卷？里面的 " + n + " 章会一起挪进回收站（能捞回来）。")) return;
				setMsg(null);
				api("/volume", { body: { novel: name, action: "delete", name: v } })
					.then(() => {
						setMsg({ kind: "ok", text: "🗑️ 已删卷：" + v + "（整卷进了回收站）" });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => setMsg({ kind: "err", text: String((e && e.message) || e) }));
			}

			/** 改名：保留「第NNN章」编号，只换标题 */
			function doRename() {
				if (!cur || busy) return;
				setBusy(true);
				setMsg(null);
				api("/chapter", { body: { novel: name, file: cur.file, action: "rename", title: draftTitle } })
					.then((d) => {
						setBusy(false);
						setRenaming(false);
						setMsg({ kind: "ok", text: "✅ 已改名为 " + (d.renamed || "") });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			function doDelete() {
				if (!cur || busy) return;
				if (typeof confirm === "function" && !confirm("删除「" + cur.title + "」？删了就找不回来了。")) return;
				setBusy(true);
				setMsg(null);
				api("/chapter", { body: { novel: name, file: cur.file, action: "delete" } })
					.then(() => {
						setBusy(false);
						setOpenFile(null); // 让列表自己挑一个还在的
						setMsg({ kind: "ok", text: "🗑️ 已删除：" + cur.title });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			react.useEffect(() => {
				if (!openFile) {
					setDoc({ loading: false, error: null, body: "", file: "" });
					return;
				}
				let alive = true;
				setDoc({ loading: true, error: null, body: "", file: openFile });
				api("/read?novel=" + enc(name) + "&file=" + enc(openFile))
					.then((d) => {
						if (alive) setDoc({ loading: false, error: null, body: d.text || "", file: d.file || openFile });
					})
					.catch((e) => {
						if (alive) setDoc({ loading: false, error: String((e && e.message) || e), body: "", file: openFile });
					});
				return () => {
					alive = false;
				};
			}, [name, openFile]);

			/**
			 * 列表行 = 卷标题 + 它下面的章节。
			 * 顺序：**未分卷**在最前（老项目就只有这一组），然后各卷按名字排（第一卷 < 第二卷 < 第十卷）。
			 * 卷标题行自带三个小按钮：＋（往这卷加章）/ 🖊（改名）/ 🗑️（删卷）。
			 */
			const vols = novel.volumes || [];
			const rows = [];
			{
				const pushGroup = (volume) => {
					const mine = chapters.filter((c) => (c.volume || "") === volume);
					const actions = [
						Btn(
							"＋",
							() => {
								setAddingVol(false);
								setAdding(true);
								setEditing(false);
								setNewTitle("");
								setAddTo(volume);
								setMsg(null);
							},
							{ title: volume ? "往「" + volume + "」里加一章" : "加一章（未分卷）" }
						)
					];
					if (volume) {
						actions.push(Btn("🖊", () => doRenameVolume(volume), { title: "这一卷改名" }));
						actions.push(
							Btn("🗑️", () => doDeleteVolume(volume), { kind: "danger", title: "删掉这一卷（里面的章节一起进回收站）" })
						);
					}
					rows.push({ head: true, volume, label: volume || "未分卷", meta: mine.length + " 章", actions });
					for (const c of mine) {
						rows.push({
							file: c.file,
							volume: c.volume || "",
							label: "第" + c.no + "章 " + c.title,
							meta: fmtSize(c.size)
						});
					}
				};
				// 有平铺的章节、或者一卷都没建 → 显示「未分卷」这一组（否则它就是个空标题，白占地方）
				if (chapters.some((c) => !c.volume) || !vols.length) pushGroup("");
				for (const v of vols) pushGroup(v);
			}

			return h(
				"div",
				{ className: "dn_v" },
				h(
					"div",
					{ className: "dn_toolbar" },
					Btn("＋ 新章节", () => {
						setAdding(true);
						setAddingVol(false);
						setEditing(false);
						setNewTitle("");
						setAddTo("");
						setMsg(null);
					}, { title: "建一个空章节，正文自己在面板里写（想放进某一卷就用那一卷标题上的 ＋）" }),
					Btn("＋ 新建卷", () => {
						setAddingVol(true);
						setAdding(false);
						setNewVol("");
						setMsg(null);
					}, { title: "给这部小说分卷（chapters 下会多一个子目录）" }),
					h("span", { className: "dn_hint" }, "按住章节行拖动排序；拖到别的卷标题上 = 挪进那一卷")
				),
				// 新建卷
				addingVol
					? h(
							"div",
							{ className: "dn_chrename" },
							h("span", { className: "dn_hint" }, "新卷名"),
							Field("", newVol, setNewVol, { placeholder: "例如：第一卷 恋爱练习" }),
							Btn(busy ? "…" : "创建卷", doCreateVolume, { kind: "primary", disabled: busy }),
							Btn("取消", () => setAddingVol(false))
					  )
					: null,
				rows.length && (chapters.length || vols.length)
					? Sheet(rows, openFile, pick, {
							from: dragFrom,
							over: dragOver,
							onDown: (i) => setDragFrom(i),
							onEnter: (i) => {
								if (dragFrom >= 0) setDragOver(i);
							},
							onUp: (i) => dropAt(dragOver >= 0 ? dragOver : i)
					  })
					: h("div", { className: "dn_ph" }, "还没有章节 —— 点上面「✍️ 写下一章」，或在聊天里说「写下一章」"),
				cur && !renaming
					? h(
							"div",
							{ className: "dn_chbar" },
							h("span", { className: "dn_it" }, "第" + cur.no + "章 " + cur.title),
							Btn(editing ? "👁 只看" : "✏️ 正文", () => {
								if (!editing) setDraft(doc.body || "");
								setEditing(!editing);
								setMsg(null);
							}, { title: "直接改这一章正文" }),
							Btn("🖊 改名", () => {
								setDraftTitle(cur.title);
								setRenaming(true);
								setEditing(false);
								setMsg(null);
							}),
							Btn("🗑️ 删除", doDelete, { kind: "danger", disabled: busy })
					  )
					: null,
				// 新建空章节
				adding
					? h(
							"div",
							{ className: "dn_chrename" },
							h("span", { className: "dn_hint" }, addTo ? "新章节标题（放进「" + addTo + "」）" : "新章节标题（未分卷）"),
							Field("", newTitle, setNewTitle, { placeholder: "例如：契约" }),
							Btn(busy ? "…" : "创建", addChapter, { kind: "primary", disabled: busy }),
							Btn("取消", () => setAdding(false))
					  )
					: null,
				cur && renaming
					? h(
							"div",
							{ className: "dn_chrename" },
							h("span", { className: "dn_hint" }, "第" + String(cur.no).padStart(3, "0") + "章 -"),
							Field("", draftTitle, setDraftTitle),
							Btn(busy ? "…" : "保存", doRename, { kind: "primary", disabled: busy }),
							Btn("取消", () => setRenaming(false))
					  )
					: null,
				msg ? Notice(msg.kind, msg.text) : null,
				editing && cur
					? h(
							"div",
							{ className: "dn_editbody" },
							h("textarea", {
								className: "dn_ta",
								value: draft,
								spellCheck: false,
								onChange: (e) => setDraft(e.target.value),
								onKeyDown: (e) => {
									if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
										e.preventDefault();
										saveBody();
									}
								}
							}),
							h(
								"div",
								{ className: "dn_acts" },
								Btn(saving ? "保存中…" : "保存正文 (Ctrl+S)", saveBody, { kind: "primary", disabled: saving }),
								h("span", { className: "dn_hint" }, (draft.length || 0) + " 字")
							)
					  )
					: h(
							"div",
							{ className: "dn_read" },
							doc.loading
								? h("div", { className: "dn_ph" }, "读取中…")
								: doc.error
								? h("div", { className: "dn_err" }, "⚠️ " + doc.error)
								: doc.body
								? h("pre", { className: "dn_pre" }, doc.body)
								: h("div", { className: "dn_ph" }, "选一章看正文")
					  )
			);
		}

		// ───────────────────────── 设定（可编辑） ─────────────────────────
		function SettingsView(props) {
			const novel = props.novel;
			const name = novel.name;
			// 宿主告诉我们这部小说里实际有哪些设定文件、各自叫什么中文名
			// （新项目是「大纲.txt / 世界观.txt / 人物卡.txt」，老项目还是 outline.md 那套）
			const items = (novel.settings || []).slice();
			const tabs = items.length ? items : [{ file: "大纲.txt", label: "大纲", kind: "outline" }];

			const [openFile, setOpenFile] = react.useState(
				props.initialFile && tabs.some((t) => t.file === props.initialFile) ? props.initialFile : tabs[0].file
			);
			const [text, setText] = react.useState("");
			const [loaded, setLoaded] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			/** 迁移 / 导出这类的工具动作 */
			const [toolBusy, setToolBusy] = react.useState(false);
			const [toolMsg, setToolMsg] = react.useState(null);
			const [exportOpen, setExportOpen] = react.useState(false); // 导出格式的小抽屉
			const cur = tabs.find((t) => t.file === openFile) || tabs[0];
			const readOnly = !!cur.generated;
			const dirty = loaded !== null && text !== loaded;

			// 换小说了：原来那个文件可能不存在 → 挑回一个存在的
			react.useEffect(() => {
				setOpenFile((prev) => (tabs.some((t) => t.file === prev) ? prev : tabs[0].file));
				// eslint-disable-next-line
			}, [name]);

			// 把"正在看哪个设定文件"上报给小说库
			react.useEffect(() => {
				if (openFile && props.onSeen) props.onSeen("settings", openFile);
			}, [openFile, props.onSeen]);

			/** 一键转新格式：原件会搬进 _旧格式备份\ */
			function doMigrate() {
				if (toolBusy) return;
				if (typeof confirm === "function") {
					const yes = confirm(
						"把这部小说转成新格式？\n\noutline.md → 大纲.txt、world.md → 世界观.txt、chapters\\*.md → *.txt，" +
							"原件会搬进「_旧格式备份」文件夹（不删）。"
					);
					if (!yes) return;
				}
				setToolBusy(true);
				setToolMsg(null);
				api("/migrate", { body: { novel: name } })
					.then((d) => {
						setToolBusy(false);
						setToolMsg({
							kind: "ok",
							text: "✅ 已转换 " + (d.changed || []).length + " 个文件，原件在「" + (d.backupDir || "_旧格式备份") + "」里"
						});
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setToolBusy(false);
						setToolMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			/** 导出：设定集.txt / EPUB / Word（都写进小说目录，面板只报文件名和大小） */
			function doExport(format) {
				if (toolBusy) return;
				setToolBusy(true);
				setToolMsg(null);
				api("/export", { body: { novel: name, format: format } })
					.then((d) => {
						setToolBusy(false);
						const kb = d.bytes ? "，" + Math.max(1, Math.round(d.bytes / 1024)) + " KB" : "";
						setToolMsg({
							kind: "ok",
							text: "✅ 已导出 " + d.file + "（" + d.chapters + " 章" + kb + "，就在小说目录里）"
						});
					})
					.catch((e) => {
						setToolBusy(false);
						setToolMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			// 依赖用 novel.name（字符串）而不是 novel 对象：
			// 存完触发 reload 时不会重新拉一次、也就不会把"✅ 已保存"的提示冲掉
			react.useEffect(() => {
				let alive = true;
				setLoaded(null);
				setMsg(null);
				api("/read?novel=" + enc(name) + "&file=" + enc(openFile))
					.then((d) => {
						if (!alive) return;
						const body = d.text || "";
						setText(body);
						setLoaded(body);
					})
					.catch((e) => {
						if (!alive) return;
						setText("");
						setLoaded("");
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
				return () => {
					alive = false;
				};
			}, [name, openFile]);

			function save() {
				if (readOnly || busy || !dirty) return;
				setBusy(true);
				setMsg(null);
				api("/save", { body: { novel: name, file: openFile, text } })
					.then(() => {
						setLoaded(text);
						setBusy(false);
						setMsg({ kind: "ok", text: "✅ 已保存 " + openFile });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			function pick(f) {
				if (f === openFile) return;
				if (dirty && typeof confirm === "function" && !confirm("有没保存的改动，确定切换吗？")) return;
				setOpenFile(f);
			}

			return h(
				"div",
				{ className: "dn_v" },
				h(
					"div",
					{ className: "dn_toolbar" },
					novel.legacy
						? Btn(toolBusy ? "…" : "⇪ 转成新格式", doMigrate, {
								kind: "primary",
								disabled: toolBusy,
								title: "outline.md 那套 → 大纲.txt；原件会搬进 _旧格式备份\\"
						  })
						: null,
					Btn(toolBusy ? "…" : "⬇ 导出", () => setExportOpen((v) => !v), {
						disabled: toolBusy,
						title: "导出成：纯文本设定集 / EPUB 电子书 / Word 文档"
					}),
					exportOpen
						? h(
								"div",
								{ className: "dn_toolbar" },
								Btn("📄 设定集.txt", () => { setExportOpen(false); doExport("txt"); }, {
									disabled: toolBusy,
									title: "大纲 + 世界观 + 人物卡 + 章节清单，合成一个纯文本文件"
								}),
								Btn("📕 EPUB", () => { setExportOpen(false); doExport("epub"); }, {
									disabled: toolBusy,
									title: "电子书：设定做卷首，卷 = 分组，一章一节（可以直接丢进阅读器）"
								}),
								Btn("📘 Word", () => { setExportOpen(false); doExport("docx"); }, {
									disabled: toolBusy,
									title: "Word 文档：卷 = 标题 1，章 = 标题 2"
								})
						  )
						: null,
					novel.legacy ? h("span", { className: "dn_hint" }, "这个项目还是老格式") : null
				),
				toolMsg ? Notice(toolMsg.kind, toolMsg.text) : null,
				h(
					"div",
					{ className: "dn_tabs" },
					tabs.map((t) =>
						h(
							"button",
							{
								key: t.file,
								className: "dn_tab" + (openFile === t.file ? " on" : ""),
								onClick: () => pick(t.file)
							},
							t.label || t.file
						)
					)
				),
				readOnly ? h("div", { className: "dn_ph" }, "人物卡由「角色」页生成（改那里 ↑）。这里只给 agent 看。") : null,
				h("textarea", {
					className: "dn_ta",
					value: text,
					readOnly: readOnly,
					spellCheck: false,
					onChange: (e) => setText(e.target.value),
					onKeyDown: (e) => {
						if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
							e.preventDefault();
							save();
						}
					}
				}),
				h(
					"div",
					{ className: "dn_acts" },
					Btn(busy ? "保存中…" : dirty ? "保存 (Ctrl+S)" : "已保存", save, {
						kind: dirty ? "primary" : "",
						disabled: readOnly || busy || !dirty
					}),
					msg ? Notice(msg.kind, msg.text) : null,
					h("span", { className: "dn_hint" }, text ? text.length + " 字" : "")
				)
			);
		}

		// ───────────────────────── 角色 & 关系 ─────────────────────────
		function nextCharId(cast) {
			const used = {};
			(cast.characters || []).forEach((c) => (used[c.id] = 1));
			for (let i = 1; i < 9999; i += 1) if (!used["c" + i]) return "c" + i;
			return "c" + Date.now();
		}

		function CastView(props) {
			const novel = props.novel;
			const name = novel.name;

			const [state, setState] = react.useState({ loading: true, error: null, warnings: [], legacyMd: false });
			const [cast, setCast] = react.useState({ version: 1, characters: [], relations: [] });
			/** 角色 id → 图片头像的地址（宿主给的，带 mtime 版本号；没有就退回 avatar 字符） */
			const [avatars, setAvatars] = react.useState({});
			const [sel, setSel] = react.useState(null);
			const [rel, setRel] = react.useState({ from: "", to: "", type: "", note: "" });
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const [dirty, setDirty] = react.useState(false);
			const [showGraph, setShowGraph] = react.useState(true);

			const load = react.useCallback(() => {
				setState((s) => ({ loading: true, error: null, warnings: s.warnings, legacyMd: s.legacyMd }));
				api("/cast?novel=" + enc(name))
					.then((d) => {
						const c = d.cast || { version: 1, characters: [], relations: [] };
						setCast(c);
						setAvatars(d.avatars || {});
						setState({ loading: false, error: null, warnings: d.warnings || [], legacyMd: !!d.legacyMd });
						setDirty(false);
						// 保住当前选中的角色（换头像 / 保存后重新拉一次，不该把光标甩回第一个人）
						setSel((prev) => (prev && c.characters.some((x) => x.id === prev) ? prev : (c.characters[0] && c.characters[0].id) || null));
					})
					.catch((e) =>
						setState({ loading: false, error: String((e && e.message) || e), warnings: [], legacyMd: false })
					);
			}, [name]);

			react.useEffect(() => {
				load();
			}, [load]);

			/** 改本地副本（保存时整表提交） */
			function mutate(fn) {
				setCast((c) => {
					const nxt = JSON.parse(JSON.stringify(c));
					fn(nxt);
					return nxt;
				});
				setDirty(true);
				setMsg(null);
			}

			function addChar() {
				const id = nextCharId(cast);
				mutate((c) => {
					c.characters.push({ id, name: "新角色", role: "配角", age: "", tags: [], desc: "", avatar: "" });
				});
				setSel(id);
			}

			function delChar(id) {
				const who = (cast.characters || []).find((c) => c.id === id);
				if (typeof confirm === "function" && !confirm("删除角色「" + (who ? who.name : id) + "」？跟他有关的关系也会一起删掉。")) return;
				mutate((c) => {
					c.characters = c.characters.filter((x) => x.id !== id);
					c.relations = c.relations.filter((r) => r.from !== id && r.to !== id);
				});
				if (sel === id) setSel(null);
			}

			function updateChar(id, patch) {
				mutate((c) => {
					const ch = c.characters.find((x) => x.id === id);
					if (ch) Object.assign(ch, patch);
				});
			}

			/**
			 * 上传图片头像：读成 dataURL → 交给宿主存成 `头像\<id>.png`。
			 * **不塞进 角色.json**（那文件留着给人用记事本改，塞 base64 就毁了）。
			 */
			function uploadAvatar(id, dataUrl) {
				setBusy(true);
				setMsg(null);
				api("/avatar", { body: { novel: name, id: id, dataUrl: dataUrl } })
					.then(() => {
						setBusy(false);
						setMsg({ kind: "ok", text: "✅ 换好图片头像了（存进 头像\\ 目录）" });
						load();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			/** 点「换图片头像」→ 弹系统选图框 → 读成 dataURL */
			function pickAvatar(id) {
				if (typeof document === "undefined" || typeof FileReader === "undefined") {
					setMsg({ kind: "err", text: "这个环境没法选图片" });
					return;
				}
				const input = document.createElement("input");
				input.type = "file";
				input.accept = "image/png,image/jpeg,image/webp,image/gif";
				input.onchange = () => {
					const file = input.files && input.files[0];
					if (!file) return;
					const reader = new FileReader();
					reader.onload = () => uploadAvatar(id, String(reader.result || ""));
					reader.readAsDataURL(file);
				};
				input.click();
			}

			/** 去掉图片头像（图片文件删掉，回到 emoji / 字符那个兜底） */
			function clearAvatar(id) {
				setBusy(true);
				setMsg(null);
				api("/avatar", { body: { novel: name, id: id, action: "remove" } })
					.then(() => {
						setBusy(false);
						setMsg({ kind: "ok", text: "已去掉图片，回到 emoji 头像" });
						load();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			function addRel() {
				if (!rel.from || !rel.to) {
					setMsg({ kind: "err", text: "关系两端都要选角色" });
					return;
				}
				if (rel.from === rel.to) {
					setMsg({ kind: "err", text: "不能跟自己拉关系" });
					return;
				}
				mutate((c) => {
					c.relations.push({ from: rel.from, to: rel.to, type: rel.type || "关系", note: rel.note || "" });
				});
				setRel({ from: "", to: "", type: "", note: "" });
			}

			function delRel(i) {
				mutate((c) => {
					c.relations.splice(i, 1);
				});
			}

			function save() {
				setBusy(true);
				setMsg(null);
				api("/cast", { body: { novel: name, cast } })
					.then((d) => {
						setCast(d.cast || cast);
						setState((s) => ({ ...s, warnings: d.warnings || [], legacyMd: false }));
						setDirty(false);
						setBusy(false);
						setMsg({
							kind: "ok",
							text: "✅ 已保存（人物卡已同步）" + ((d.log || []).length ? " " + d.log.join("；") : "")
						});
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			const chars = cast.characters || [];
			const rels = cast.relations || [];
			const byId = {};
			chars.forEach((c) => (byId[c.id] = c));
			const me = chars.find((c) => c.id === sel) || null;

			const kids = [];

			if (state.legacyMd) {
				kids.push(
					h(
						"div",
						{ className: "dn_warn", key: "legacy" },
						"⚠️ 这个项目现在只有手写的人物卡。第一次保存会自动备份成 .bak，然后由这里的角色数据接管。"
					)
				);
			}
			if (state.error) kids.push(h("div", { className: "dn_err", key: "err" }, "⚠️ " + state.error));
			if (state.loading) kids.push(h("div", { className: "dn_ph", key: "loading" }, "读取角色表…"));
			if (state.warnings && state.warnings.length) {
				kids.push(h("div", { className: "dn_warn", key: "warn" }, "数据提醒：" + state.warnings.join("；")));
			}

			kids.push(
				h(
					"div",
					{ className: "dn_toolbar", key: "bar" },
					Btn("＋ 新角色", addChar),
					Btn(busy ? "保存中…" : dirty ? "保存角色表" : "已同步", save, {
						kind: dirty ? "primary" : "",
						disabled: busy || !dirty
					}),
					Btn(showGraph ? "🕸️ 收起关系图" : "🕸️ 关系图", () => setShowGraph(!showGraph)),
					h("span", { className: "dn_hint" }, chars.length + " 人 · " + rels.length + " 条关系")
				)
			);
			if (msg) kids.push(Notice(msg.kind, msg.text));

			const scroll = [];
			scroll.push(
				h(
					"div",
					{ className: "dn_rows", key: "chars" },
					chars.length
						? chars.map((c) =>
								h(
									"button",
									{
										key: c.id,
										className: "dn_item" + (sel === c.id ? " on" : ""),
										onClick: () => setSel(c.id)
									},
									h(
										"span",
										{ className: "dn_it" },
										avatars[c.id]
											? h("img", { className: "dn_avmini", src: avatars[c.id], alt: "" })
											: c.avatar
											? c.avatar + " "
											: "",
										c.name || "(无名)"
									),
									h("span", { className: "dn_meta" }, c.role || "")
								)
						  )
						: h("div", { className: "dn_ph" }, "还没有角色 —— 点上面「＋ 新角色」")
				)
			);

			if (me) {
				const tagText = (me.tags || []).join("、");
				scroll.push(
					h(
						"div",
						{ className: "dn_edit", key: "edit" },
						h("div", { className: "dn_sec" }, "编辑：" + (me.name || "(无名)") + "（" + me.id + "）"),
						Field("名字", me.name, (v) => updateChar(me.id, { name: v })),
						Field("头像（没有图片时用：1~4 个字符 / emoji）", me.avatar, (v) => updateChar(me.id, { avatar: v.slice(0, 4) })),
						h(
							"div",
							{ className: "dn_avatar" },
							avatars[me.id]
								? h("img", { className: "dn_avimg", src: avatars[me.id], alt: me.name || "" })
								: h("span", { className: "dn_avph" }, me.avatar || (me.name || "?").slice(0, 2)),
							Btn("🖼 换图片头像", () => pickAvatar(me.id), {
								disabled: busy,
								title: "png / jpg / webp / gif，≤ 2MB；图片存进小说的 头像\\ 目录"
							}),
							avatars[me.id]
								? Btn("✖ 去掉图片", () => clearAvatar(me.id), { disabled: busy, title: "回到 emoji / 字符头像" })
								: null,
							h("span", { className: "dn_hint" }, avatars[me.id] ? "用的是图片" : "用的是字符")
						),
						h(
							"div",
							{ className: "dn_grid2" },
							h(
								"label",
								{ className: "dn_f" },
								h("span", { className: "dn_fl" }, "定位"),
								h(
									"select",
									{
										className: "dn_in",
										value: me.role || "配角",
										onChange: (e) => updateChar(me.id, { role: e.target.value })
									},
									ROLES.map((r) => h("option", { key: r, value: r }, r))
								)
							),
							Field("年龄", me.age, (v) => updateChar(me.id, { age: v }))
						),
						Field("标签（顿号或逗号分隔）", tagText, (v) =>
							updateChar(me.id, {
								tags: v
									.split(/[、,，/|]/)
									.map((s) => s.trim())
									.filter(Boolean)
							})
						),
						h(
							"label",
							{ className: "dn_f" },
							h("span", { className: "dn_fl" }, "简介"),
							h("textarea", {
								className: "dn_ta",
								style: { minHeight: "60px", margin: "0" },
								value: me.desc || "",
								onChange: (e) => updateChar(me.id, { desc: e.target.value })
							})
						),
						h("div", null, Btn("删除这个角色", () => delChar(me.id), { kind: "danger" }))
					)
				);
			}

			if (showGraph) {
				scroll.push(
					h("div", { key: "graph" }, h(CastGraph, {
						cast,
						selected: sel,
						onPick: setSel,
						avatars,
						pos: props.pos,
						onMovePos: props.onMovePos,
						onResetPos: props.onResetPos
					}))
				);
			}

			/** 拉关系至少要**两个**角色（只有一个人时不再摆没用的下拉框，而是明说差什么） */
			const canRelate = chars.length >= 2;
			const relKids = [h("div", { className: "dn_sec", key: "sec" }, "人物关系（" + rels.length + "）")];
			if (rels.length) {
				rels.forEach((r, i) => {
					const a = byId[r.from];
					const b = byId[r.to];
					relKids.push(
						h(
							"div",
							{ className: "dn_rel", key: "r" + i },
							h(
								"span",
								{ className: "dn_reltext" },
								(a ? a.name : r.from) +
									" —" +
									(r.type || "关系") +
									"→ " +
									(b ? b.name : r.to) +
									(r.note ? "（" + r.note + "）" : "")
							),
							Btn("✕", () => delRel(i), { title: "删掉这条关系" })
						)
					);
				});
			} else {
				relKids.push(
					h(
						"div",
						{ className: "dn_ph", key: "none" },
						canRelate ? "还没有关系。下面选两个人拉一条。" : "还没有关系。"
					)
				);
			}
			/**
			 * 拉关系至少要**两个**角色 —— 只有一个人时不再给个没用的下拉框
			 * （用户会以为"我的人怎么没了"，其实只是人还没加）。
			 * 另外「到」里不列刚才选的「从」：不能跟自己拉关系。
			 */
			if (!canRelate) {
				relKids.push(
					h(
						"div",
						{ className: "dn_hint dn_relneed", key: "need" },
						"要拉关系至少得有 2 个角色，现在只有 " + chars.length + " 个 —— 先在上面点「＋ 新角色」把人加进来。"
					)
				);
			} else {
				relKids.push(
					h(
						"div",
						{ className: "dn_addrel", key: "add" },
						h(
							"div",
							{ className: "dn_grid2" },
							h(
								"label",
								{ className: "dn_f" },
								h("span", { className: "dn_fl" }, "从"),
								h(
									"select",
									{
										className: "dn_in",
										value: rel.from,
										onChange: (e) =>
											setRel((r) => {
												const from = e.target.value;
												// 换成同一个人时，把「到」让开（不能自己对自己）
												return { ...r, from, to: r.to === from ? "" : r.to };
											})
									},
									[h("option", { key: "", value: "" }, "选角色…")].concat(
										chars
											.filter((c) => c.id !== rel.to)
											.map((c) => h("option", { key: c.id, value: c.id }, c.name))
									)
								)
							),
							h(
								"label",
								{ className: "dn_f" },
								h("span", { className: "dn_fl" }, "到"),
								h(
									"select",
									{
										className: "dn_in",
										value: rel.to,
										onChange: (e) =>
											setRel((r) => {
												const to = e.target.value;
												return { ...r, to, from: r.from === to ? "" : r.from };
											})
									},
									[h("option", { key: "", value: "" }, "选角色…")].concat(
										chars
											.filter((c) => c.id !== rel.from)
											.map((c) => h("option", { key: c.id, value: c.id }, c.name))
									)
								)
							)
						),
						Field("关系（如：暗恋（单向）/ 闺蜜 / 兄妹）", rel.type, (v) => setRel({ ...rel, type: v })),
						Field("备注", rel.note, (v) => setRel({ ...rel, note: v })),
						h(
							"div",
							null,
							Btn("＋ 添加关系", addRel, {
								disabled: !rel.from || !rel.to,
								title: !rel.from || !rel.to ? "先把「从」和「到」两个角色都选上" : "添加这条关系"
							})
						)
					)
				);
			}
			scroll.push(h("div", { key: "rels" }, relKids));

			kids.push(h("div", { className: "dn_scroll", key: "scroll" }, scroll));

			return h("div", { className: "dn_v" }, kids);
		}

		// ───────────────────────── 角色关系图（手写 SVG） ─────────────────────────
		const ROLE_COLOR = { 主角: "#1976d2", 配角: "#7e57c2", 反派: "#c0392b", 路人: "#78909c" };
		const NODE_R = 11;

		/** 从 a 到 b 的线，两端各缩进 r，免得箭头插进圆圈里 */
		function trimLine(a, b, r) {
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.sqrt(dx * dx + dy * dy) || 1;
			return {
				x1: a.x + (dx / len) * r,
				y1: a.y + (dy / len) * r,
				x2: b.x - (dx / len) * r,
				y2: b.y - (dy / len) * r
			};
		}

		/**
		 * 自动布局：**力导向**（Fruchterman-Reingold 的简化版），纯手写、无依赖。
		 *
		 * 为什么不用「摆个圈」：关系多的角色该待在中间、关系近的该挨着 —— 摆圈完全看不出亲疏。
		 * 这里三种力：
		 *   · 斥力：所有点两两互推（k²/d），免得挤成一团
		 *   · 引力：有关系的两点互相拉（d²/k），关系越近拉得越紧
		 *   · 向心：所有点被轻轻拉向画面中心，免得散到天边
		 *
		 * 用**固定种子的伪随机**（LCG）打破对称 —— 同样的角色/关系每次摆出来一模一样，
		 * 不会每刷一次界面就跳一下，也让测试有东西可断言。
		 *
		 * 没有任何关系时退回「摆一圈」（力导向这时没有信息可用，会全挤到边上）。
		 *
		 * @returns {{[id:string]: {x:number, y:number}}}
		 */
		function layoutGraph(chars, rels, W, H) {
			const list = chars || [];
			const n = list.length;
			const out = {};
			if (!n) return out;
			const pad = NODE_R + 6;
			if (n === 1) {
				out[list[0].id] = { x: W / 2, y: H / 2 };
				return out;
			}
			const ring = () => {
				const R0 = Math.min(W, H) / 2 - pad - 8;
				list.forEach((c, i) => {
					const a = (Math.PI * 2 * i) / n - Math.PI / 2;
					out[c.id] = { x: W / 2 + R0 * Math.cos(a), y: H / 2 + R0 * Math.sin(a) };
				});
				return out;
			};
			if (!(rels || []).length) return ring();

			// Park-Miller 线性同余：乘数只有 16807，seed*16807 不会越过 2^53，所以不掉精度。
			// （第一版用了 1103515245，2e9 × 1.1e9 ≈ 2.2e18 > 2^53 —— 随机数直接退化成常数）
			let seed = 20260928 % 2147483647;
			const rnd = () => {
				seed = (seed * 16807) % 2147483647;
				return seed / 2147483647;
			};
			const idx = new Map();
			list.forEach((c, i) => idx.set(c.id, i));
			const px = new Float64Array(n);
			const py = new Float64Array(n);
			const R0 = Math.min(W, H) / 2 - pad - 8;
			list.forEach((c, i) => {
				const a = (Math.PI * 2 * i) / n - Math.PI / 2;
				px[i] = W / 2 + R0 * Math.cos(a) + (rnd() - 0.5) * 4;
				py[i] = H / 2 + R0 * Math.sin(a) + (rnd() - 0.5) * 4;
			});
			const edges = [];
			for (const r of rels) {
				const a = idx.get(r.from);
				const b = idx.get(r.to);
				if (a === undefined || b === undefined || a === b) continue;
				edges.push([a, b]);
			}

			const k = Math.sqrt(((W - pad * 2) * (H - pad * 2)) / n); // 理想边长
			const ITER = 320;
			let t = Math.min(W, H) / 6; // 每轮最多挪多远，逐轮降温
			const cooling = t / (ITER + 1);
			const dx = new Float64Array(n);
			const dy = new Float64Array(n);
			for (let step = 0; step < ITER; step += 1) {
				dx.fill(0);
				dy.fill(0);
				for (let i = 0; i < n; i += 1) {
					for (let j = i + 1; j < n; j += 1) {
						let vx = px[i] - px[j];
						let vy = py[i] - py[j];
						let d = Math.sqrt(vx * vx + vy * vy);
						if (d < 0.01) {
							vx = (rnd() - 0.5) * 0.2;
							vy = (rnd() - 0.5) * 0.2;
							d = 0.2;
						}
						const f = (k * k) / d;
						dx[i] += (vx / d) * f;
						dy[i] += (vy / d) * f;
						dx[j] -= (vx / d) * f;
						dy[j] -= (vy / d) * f;
					}
				}
				for (const [i, j] of edges) {
					const vx = px[i] - px[j];
					const vy = py[i] - py[j];
					const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
					const f = (d * d) / k;
					dx[i] -= (vx / d) * f;
					dy[i] -= (vy / d) * f;
					dx[j] += (vx / d) * f;
					dy[j] += (vy / d) * f;
				}
				for (let i = 0; i < n; i += 1) {
					dx[i] += (W / 2 - px[i]) * 0.06; // 向心
					dy[i] += (H / 2 - py[i]) * 0.06;
					const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
					const move = Math.min(len, t);
					px[i] += (dx[i] / len) * move;
					py[i] += (dy[i] / len) * move;
				}
				t = Math.max(t - cooling, 0.5);
			}

			// 收尾：夹回画布，再按「最小间距」推几轮（免得圆点和名字叠在一起）
			const clamp = () => {
				for (let i = 0; i < n; i += 1) {
					px[i] = Math.min(W - pad, Math.max(pad, px[i]));
					py[i] = Math.min(H - pad, Math.max(pad, py[i]));
				}
			};
			clamp();
			const need = NODE_R * 2 + 4;
			for (let pass = 0; pass < 24; pass += 1) {
				for (let i = 0; i < n; i += 1) {
					for (let j = i + 1; j < n; j += 1) {
						let vx = px[j] - px[i];
						let vy = py[j] - py[i];
						let d = Math.sqrt(vx * vx + vy * vy);
						if (d < 0.01) {
							// 两个点完全重合时"往哪推"是没定义的：(vx/d)×push 恒等于 0，会一直叠着。
							// 给一个按 (i,j) 定死的方向把它们掰开（定死 = 结果仍然可复现）。
							const a = ((i * 7 + j * 13) % 360) * (Math.PI / 180);
							vx = Math.cos(a);
							vy = Math.sin(a);
							d = 1;
						}
						if (d < need) {
							const push = (need - d) / 2;
							px[i] -= (vx / d) * push;
							py[i] -= (vy / d) * push;
							px[j] += (vx / d) * push;
							py[j] += (vy / d) * push;
						}
					}
				}
				clamp();
			}
			list.forEach((c, i) => {
				out[c.id] = { x: Math.round(px[i] * 10) / 10, y: Math.round(py[i] * 10) / 10 };
			});
			return out;
		}

		/**
		 * 关系图：角色按**力导向**自动摆位（拖动可覆盖），关系连线 + 箭头 + 关系名。
		 * 纯 SVG、无依赖（客户端半不能装库）；点圈上的点会选中那个角色。
		 */
		function CastGraph(props) {
			const chars = props.cast.characters || [];
			const rels = props.cast.relations || [];
			/** 正在拖哪个角色的圆点 */
			const [dragId, setDragId] = react.useState("");
			if (chars.length === 0) return h("div", { className: "dn_ph" }, "还没有角色，画不出关系图");
			if (chars.length === 1) {
				return h(
					"div",
					{ className: "dn_ph" },
					"只有 1 个角色（" + chars[0].name + "），再加一个才能连线"
				);
			}

			const W = 320;
			const H = chars.length > 4 ? 260 : 220;
			/**
			 * 自动位置 = **力导向布局**（关系近的挨着、关系多的居中），
			 * 一个关系都没有时它自己会退回「摆一圈」。
			 */
			const auto = layoutGraph(chars, rels, W, H);
			/** 人手拖过的位置优先（记在本地，按小说分） */
			const stored = props.pos || {};
			const at = (id) => (stored[id] && typeof stored[id].x === "number" ? stored[id] : auto[id]);
			const has = {};
			rels.forEach((r) => (has[r.from + ">" + r.to] = true));

			const kids = [];
			// 箭头
			kids.push(
				h(
					"defs",
					{ key: "defs" },
					h(
						"clipPath",
						// objectBoundingBox：这个圆是**相对图片自己的外框**算的，
						// 所以一个 clipPath 就能裁所有节点上的头像（不用每个点来一个）
						{ id: "dn-avclip", clipPathUnits: "objectBoundingBox" },
						h("circle", { cx: "0.5", cy: "0.5", r: "0.5" })
					),
					h(
						"marker",
						{
							id: "dn-arrow",
							viewBox: "0 0 10 10",
							refX: "9",
							refY: "5",
							markerWidth: "6",
							markerHeight: "6",
							orient: "auto"
						},
						h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#1976d2" })
					)
				)
			);

			// 线 + 关系名
			rels.forEach((r, i) => {
				const a = at(r.from);
				const b = at(r.to);
				if (!a || !b || r.from === r.to) return;
				let line = trimLine(a, b, NODE_R);
				// 互指的两个人：两条线错开一点，不然完全重合
				if (has[r.to + ">" + r.from]) {
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const len = Math.sqrt(dx * dx + dy * dy) || 1;
					const ox = (-dy / len) * 5;
					const oy = (dx / len) * 5;
					line = { x1: line.x1 + ox, y1: line.y1 + oy, x2: line.x2 + ox, y2: line.y2 + oy };
				}
				const mx = (line.x1 + line.x2) / 2;
				const my = (line.y1 + line.y2) / 2;
				kids.push(
					h("line", {
						key: "e" + i,
						x1: line.x1,
						y1: line.y1,
						x2: line.x2,
						y2: line.y2,
						stroke: "#1976d2",
						strokeWidth: 1.2,
						markerEnd: "url(#dn-arrow)",
						opacity: 0.7
					})
				);
				kids.push(
					h(
						"text",
						{
							key: "el" + i,
							x: mx,
							y: my - 3,
							textAnchor: "middle",
							fontSize: "8",
							fill: "#1976d2"
						},
						r.type || "关系"
					)
				);
			});

			// 圆点 + 名字
			chars.forEach((c) => {
				const p = at(c.id);
				const on = props.selected === c.id;
				kids.push(
					h(
						"g",
						{
							key: "n" + c.id,
							className: "dn_node" + (dragId === c.id ? " dragging" : ""),
							onClick: () => props.onPick && props.onPick(c.id),
							onPointerDown: (e) => {
								if (e && typeof e.stopPropagation === "function") e.stopPropagation();
								setDragId(c.id);
							},
							style: { cursor: dragId === c.id ? "grabbing" : "grab" }
						},
						h("circle", {
							cx: p.x,
							cy: p.y,
							r: NODE_R,
							fill: ROLE_COLOR[c.role] || ROLE_COLOR["路人"],
							opacity: on ? 1 : 0.78,
							stroke: on ? "#1976d2" : "transparent",
							strokeWidth: 2
						}),
						(props.avatars || {})[c.id]
							? h("image", {
									href: (props.avatars || {})[c.id],
									x: p.x - NODE_R,
									y: p.y - NODE_R,
									width: NODE_R * 2,
									height: NODE_R * 2,
									clipPath: "url(#dn-avclip)",
									preserveAspectRatio: "xMidYMid slice",
									style: { pointerEvents: "none" }
							  })
							: h(
									"text",
									{ x: p.x, y: p.y + 3.5, textAnchor: "middle", fontSize: "9", fill: "#fff" },
									c.avatar || c.name.slice(0, 2)
							  ),
						h(
							"text",
							{ x: p.x, y: p.y + NODE_R + 11, textAnchor: "middle", fontSize: "9", fill: "currentColor" },
							c.name
						)
					)
				);
			});

			/** 拖动中：把屏幕坐标换算成 viewBox 坐标（所以要先拿 svg 的实际尺寸） */
			function onDragMove(e) {
				if (!dragId || !props.onMovePos) return;
				const el = e && e.currentTarget;
				const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
				if (!r || !r.width || !r.height) return;
				const x = ((e.clientX - r.left) * W) / r.width;
				const y = ((e.clientY - r.top) * H) / r.height;
				props.onMovePos(
					dragId,
					Math.max(NODE_R + 2, Math.min(W - NODE_R - 2, x)),
					Math.max(NODE_R + 2, Math.min(H - NODE_R - 2, y))
				);
			}

			const moved = Object.keys(stored || {}).length;

			return h(
				"div",
				{ className: "dn_graphwrap" },
				h(
					"svg",
					{
						className: "dn_graph",
						viewBox: "0 0 " + W + " " + H,
						preserveAspectRatio: "xMidYMid meet",
						onPointerMove: onDragMove,
						onPointerUp: () => setDragId(""),
						onPointerLeave: () => setDragId("")
					},
					kids
				),
				h(
					"div",
					{ className: "dn_graphtip" },
					"共 " +
						chars.length +
						" 人 · " +
						rels.length +
						" 条关系 —— 拖动圆点摆位置，点一下切换选中的人"
				),
				h(
					"div",
					{ className: "dn_graphacts" },
					moved ? Btn("🕸 自动布局", () => props.onResetPos && props.onResetPos(), { title: "按关系亲疏重新摆一遍（拖过的手动位置会清掉）" }) : null,
					moved ? h("span", { className: "dn_hint" }, "摆好的位置记在这台浏览器上") : null
				)
			);
		}

		// ───────────────────────── 保存位置（可配置） ─────────────────────────
		/**
		 * 读/改小说存到哪个目录。
		 * 目录不存在时宿主会**自动创建**；如果路径来自环境变量，这里改不动（会明确告诉你原因）。
		 */
		function RootForm(props) {
			const [info, setInfo] = react.useState({ loading: true, error: null });
			const [text, setText] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);

			react.useEffect(() => {
				let alive = true;
				api("/config")
					.then((d) => {
						if (!alive) return;
						setInfo({ loading: false, error: null, ...d });
						setText(d.root || "");
					})
					.catch((e) => {
						if (alive) setInfo({ loading: false, error: String((e && e.message) || e) });
					});
				return () => {
					alive = false;
				};
			}, []);

			function save() {
				if (busy) return;
				setBusy(true);
				setMsg(null);
				api("/config", { body: { root: text } })
					.then((d) => {
						setBusy(false);
						setInfo({ loading: false, error: null, ...d });
						setText(d.root || "");
						setMsg({ kind: "ok", text: "✅ 已切到 " + d.root + (d.created ? "（目录已自动创建）" : "") });
						if (props.onChanged) props.onChanged();
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			const now = info.loading
				? "读取中…"
				: info.error
				? ""
				: "当前：" +
				  info.root +
				  "（" +
				  info.sourceLabel +
				  (info.canEdit === false ? "" : info.exists ? "，已存在" : "，还不存在") +
				  "）";

			return h(
				"div",
				{ className: "dn_form" },
				Field("📁 小说保存位置", text, setText, { placeholder: "例如 D:\\dsh-novel 或 E:\\我的小说" }),
				h(
					"div",
					{ className: "dn_acts" },
					Btn(busy ? "保存中…" : "保存并切换", save, { kind: "primary", disabled: busy }),
					Btn("取消", props.onCancel)
				),
				msg ? Notice(msg.kind, msg.text) : null,
				info.error ? h("div", { className: "dn_err" }, "⚠️ 读不到当前设置：" + info.error) : null,
				now ? h("div", { className: "dn_hint" }, now) : null,
				info.canEdit === false
					? h("div", { className: "dn_hint" }, "⚠️ 路径由环境变量 DSH_NOVEL_ROOT 指定，在面板里改不生效")
					: null,
				h("div", { className: "dn_hint" }, "目录不存在会自动创建；所有小说都放在这个目录下面")
			);
		}

		// ───────────────────────── 打开哪本小说（切换器） ─────────────────────────
		/**
		 * 展示为一层"面板内接管"的列表（侧栏窄，做 position:absolute 浮层反而难用）：
		 * 搜索 + 排序 + 每本的进度和"上次看到第几章"。
		 */
		function NovelSwitcher(props) {
			const [q, setQ] = react.useState("");
			const [sort, setSort] = react.useState("recent-write");
			const [renaming, setRenaming] = react.useState("");
			const [draft, setDraft] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const all = props.novels || [];
			const kw = q.trim().toLowerCase();
			const shown = sortNovels(
				all.filter((n) => !kw || String(n.name).toLowerCase().indexOf(kw) >= 0),
				sort,
				props.record
			);

			/** 行内的 ✏️ / 🗑️ 不能触发"打开这本"，所以要把事件拦下来 */
			function stop(e) {
				if (e && typeof e.stopPropagation === "function") e.stopPropagation();
			}

			function doRename() {
				const next = draft.trim();
				if (!next || !renaming || busy) return;
				setBusy(true);
				setMsg(null);
				api("/novel", { body: { action: "rename", name: renaming, newName: next } })
					.then((d) => {
						setBusy(false);
						setRenaming("");
						setMsg({ kind: "ok", text: "✅ 已改名为《" + (d.renamed || next) + "》" });
						if (props.onRenamed) props.onRenamed(renaming, d.renamed || next);
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			function doDelete(name) {
				if (busy) return;
				if (typeof confirm === "function") {
					const yes = confirm(
						"删除《" +
							name +
							"》？\n\n不会真删 —— 整个文件夹会挪到小说库下的 .dsh-novel-trash\\ 里，手工还能捞回来。"
					);
					if (!yes) return;
				}
				setBusy(true);
				setMsg(null);
				api("/novel", { body: { action: "delete", name: name } })
					.then((d) => {
						setBusy(false);
						setMsg({ kind: "ok", text: "🗑️ 已移到回收站：" + (d.movedTo || "") });
						if (props.onDeleted) props.onDeleted(name);
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			return h(
				"div",
				{ className: "dn_sw" },
				h(
					"div",
					{ className: "dn_swhead" },
					h("span", null, "打开哪本小说"),
					Btn("✕", props.onClose, { title: "关掉" })
				),
				h(
					"div",
					{ className: "dn_swtools" },
					h("input", {
						className: "dn_in",
						placeholder: "搜索书名…",
						value: q,
						onChange: (e) => setQ(e.target.value)
					}),
					h(
						"select",
						{ className: "dn_mini", value: sort, onChange: (e) => setSort(e.target.value) },
						h("option", { value: "recent-write" }, "最近在写"),
						h("option", { value: "recent-open" }, "最近打开"),
						h("option", { value: "name" }, "名称")
					)
				),
				msg ? Notice(msg.kind, msg.text) : null,
				h(
					"div",
					{ className: "dn_swlist" },
					shown.length
						? shown.map((n) => {
								if (renaming === n.name) {
									return h(
										"div",
										{ key: n.name, className: "dn_swrow on" },
										h(
											"div",
											{ className: "dn_swrename" },
											h("input", {
												className: "dn_in",
												value: draft,
												placeholder: "新书名",
												onChange: (e) => setDraft(e.target.value)
											}),
											Btn(busy ? "…" : "保存", doRename, { kind: "primary", disabled: busy }),
											Btn("取消", () => setRenaming(""))
										)
									);
								}
								const on = n.name === props.current;
								const seen = seenOf(props.record, n.name);
								const seenText =
									seen && seen.file ? "上次看到：" + chapterLabel(seen.file) : "还没打开过";
								return h(
									"div",
									{
										key: n.name,
										className: "dn_swrow" + (on ? " on" : ""),
										onClick: () => props.onPick(n.name)
									},
									h("div", { className: "dn_swtitle" }, (on ? "● " : "○ ") + n.name),
									h(
										"div",
										{ className: "dn_swmeta" },
										n.chapterCount +
											" 章 · 角色 " +
											((n.cast && n.cast.characters) || 0) +
											" 人 · " +
											agoText(lastWriteOf(n))
									),
									h("div", { className: "dn_swseen" }, seenText),
									h(
										"div",
										{ className: "dn_swacts" },
										Btn(
											"✏️",
											(e) => {
												stop(e);
												setDraft(n.name);
												setRenaming(n.name);
												setMsg(null);
											},
											{ title: "改书名" }
										),
										Btn(
											"🗑️",
											(e) => {
												stop(e);
												doDelete(n.name);
											},
											{ title: "删除（移到回收站，可捞回）" }
										)
									)
								);
						  })
						: h("div", { className: "dn_ph" }, kw ? "没有匹配「" + q + "」的小说" : "这个小说库里还没有小说")
				),
				props.root ? h("div", { className: "dn_graphtip" }, "小说库：" + props.root) : null
			);
		}

		// ───────────────────────── 新建小说 ─────────────────────────
		function NewNovelForm(props) {
			const [name, setName] = react.useState("");
			const [intro, setIntro] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);

			function create() {
				if (!name.trim()) {
					setMsg({ kind: "err", text: "书名不能为空" });
					return;
				}
				setBusy(true);
				setMsg(null);
				api("/novel", { body: { name: name.trim(), intro: intro.trim() } })
					.then((d) => {
						setBusy(false);
						if (props.onCreated) props.onCreated(d.created || (d.novel && d.novel.name));
					})
					.catch((e) => {
						setBusy(false);
						setMsg({ kind: "err", text: String((e && e.message) || e) });
					});
			}

			return h(
				"div",
				{ className: "dn_form" },
				Field("书名", name, setName, { placeholder: "例如：学妹这只是练习而已" }),
				Field("一句话简介（可以先空着）", intro, setIntro, { placeholder: "谁，在什么处境下，想要什么" }),
				h(
					"div",
					{ className: "dn_acts" },
					Btn(busy ? "创建中…" : "创建", create, { kind: "primary", disabled: busy }),
					Btn("取消", props.onCancel),
					msg ? Notice(msg.kind, msg.text) : null
				)
			);
		}

		// ───────────────────────── 主面板 ─────────────────────────
		function NovelPanel(props) {
			ensureCss();
			const visible = !props || props.visible !== false;

			const [list, setList] = react.useState({ loading: true, error: null, novels: [], root: "" });
			/** 小说库记忆：{ [根目录]: { open, recent, seen } } */
			const [lib, setLib] = react.useState(readLibrary);
			/** 切换器是否展开 */
			const [switching, setSwitching] = react.useState(false);
			/** "上次打开的那本没了"之类的提示 */
			const [fellNotice, setFellNotice] = react.useState("");
			const [view, setView] = react.useState("chapters");
			const [creating, setCreating] = react.useState(false);
			/** 保存位置表单是否展开 */
			const [showRoot, setShowRoot] = react.useState(false);
			const [ask, setAsk] = react.useState(null);
			/** 自动刷新档位（存 localStorage，改完立刻生效） */
			const [pollPref, setPollPref] = react.useState(readPollPref);
			const [customDraft, setCustomDraft] = react.useState(readCustomDraft);
			const customMs = customMsOf(customDraft);
			const customPreset = {
				id: "custom",
				label: "自定义",
				listMs: customMs.listMs,
				liveMs: customMs.liveMs,
				hint:
					"列表 " +
					customMs.listMs / 1000 +
					" 秒 · " +
					(customMs.liveMs ? "直播 " + customMs.liveMs / 1000 + " 秒" : "不直播")
			};
			const preset = pollPref === "custom" ? customPreset : POLL_PRESETS.find((p) => p.id === pollPref) || POLL_PRESETS[0];

			// 输入框一改就落盘（存在 effect 里，不在 setState 里做副作用）
			react.useEffect(() => {
				writeCustomDraft(customDraft);
			}, [customDraft]);

			function setCustom(patch) {
				setCustomDraft(Object.assign({}, customDraft, patch));
			}
			/** 直播：{writing, kind, preview, chars, gapped} */
			const [live, setLive] = react.useState(null);
			const liveRef = react.useRef({ writing: false, rev: -1 });
			const sid = (props && props.scope && props.scope.sessionId) || "";

			const reload = react.useCallback(() => {
				setList((s) => ({ loading: true, error: null, novels: s.novels || [], root: s.root || "" }));
				api("/list")
					.then((d) => setList({ loading: false, error: null, novels: d.novels || [], root: d.root || "" }))
					.catch((e) => setList({ loading: false, error: String((e && e.message) || e), novels: [], root: "" }));
			}, []);

			/**
			 * 静默刷新：不问空转、失败也不弹错，只在**指纹变了**时才更新界面。
			 * 这样小d 在后台写完一章，面板自己就冒出来了。
			 */
			const silentReload = react.useCallback(() => {
				api("/list")
					.then((d) => {
						const novels = d.novels || [];
						setList((s) =>
							listSig(s.novels) === listSig(novels) ? s : { loading: false, error: null, novels, root: d.root || s.root }
						);
					})
					.catch(() => {
						/* 静默失败：不打扰用户 */
					});
			}, []);

			react.useEffect(() => {
				if (visible) reload();
			}, [reload, visible]);

			// ── 小说库：打开哪本 / 每本读到哪 ──
			const root = list.root || "";
			const novels = list.novels || [];
			const record = libRecord(lib, root);
			const chosen = chooseOpen(record, novels.map((n) => n.name));
			const novel = chosen.name ? novels.find((n) => n.name === chosen.name) || null : null;
			const novelName = novel ? novel.name : "";

			// 库一改就落盘（放在 effect 里，保持 setState 是纯的）
			react.useEffect(() => {
				writeLibrary(lib);
			}, [lib]);

			/** 打开某一本（并推进"最近打开"） */
			function openNovel(name) {
				setFellNotice("");
				setSwitching(false);
				setLib((prev) => rememberOpen(prev, root, name));
			}

			// 记忆的回落：记住的那本不在了 → 明确告诉用户；第一次进这个库 → 记住第一本
			react.useEffect(() => {
				if (!novels.length || !chosen.name) return;
				if (chosen.source === "remembered") return;
				if (chosen.source === "vanished" && record.open) {
					setFellNotice("上次打开的《" + record.open + "》不在这个小说库里了 —— 已切到《" + chosen.name + "》");
				}
				setLib((prev) => rememberOpen(prev, root, chosen.name));
			}, [chosen.source, chosen.name, root, novels.length, record.open]);

			/** 子视图把"正在看哪一章/哪个设定文件"上报回来（回调保持稳定，免得来回抖动） */
			const onSeen = react.useCallback(
				(where, file) => {
					setLib((prev) => rememberSeen(prev, root, novelName, where, file));
				},
				[root, novelName]
			);
			const seen = seenOf(record, novelName);

			// 面板可见时定时自查（隐藏就停，不白烧）；"关闭"档就不挂
			react.useEffect(() => {
				if (!visible || !preset.listMs) return undefined;
				const timer = setInterval(silentReload, preset.listMs);
				return () => clearInterval(timer);
			}, [visible, silentReload, preset.listMs]);

			/**
			 * 流式输出：每 400ms 问一次"正在写什么"。
			 * 顺便盯着 writing 的 真→假 那一刻 —— 那就是"刚写完"，
			 * 立刻刷新章节列表，于是新章节**不用手点就冒出来**。
			 */
			const pollLive = react.useCallback(() => {
				api("/stream" + (sid ? "?session=" + enc(sid) : ""))
					.then((d) => {
						const prev = liveRef.current;
						const writing = !!d.writing;
						const changed = prev.rev !== d.rev || prev.writing !== writing;
						liveRef.current = { writing, rev: d.rev };
						if (changed) {
							setLive(
								d.preview
									? {
											writing,
											kind: d.previewKind || "",
											preview: d.preview,
											chars: d.preview.length,
											gapped: !!d.gapped,
											step: d.step || 0
									  }
									: null
							);
						}
						if (prev.writing && !writing) silentReload();
					})
					.catch(() => {
						/* 静默：流式拿不到不该打扰用户 */
					});
			}, [sid, silentReload]);

			react.useEffect(() => {
				if (!visible || !preset.liveMs) return undefined;
				const timer = setInterval(pollLive, preset.liveMs);
				return () => clearInterval(timer);
			}, [visible, pollLive, preset.liveMs]);

			/** 「✍️ 写下一章」：把请求塞进对话输入框 */
			function askNextChapter() {
				if (!novel) return;
				const nextNo = String((novel.chapterCount || 0) + 1).padStart(3, "0");
				const text =
					"请续写《" +
					novel.name +
					"》的第" +
					nextNo +
					"章：先用 novel_context 取上下文（大纲、世界观、角色关系和最近章节），写完调用 novel_save_chapter 存盘，章节标题你自己定。";
				setAsk(writeToComposer(props && props.ctx, props && props.scope, text));
			}

			const kids = [];

			kids.push(
				h(
					"div",
					{ className: "dn_head", key: "head" },
					h("span", null, "🖋️ 小说创作台"),
					h(
						"div",
						{ className: "dn_hbtns" },
						Btn("📁", () => setShowRoot(!showRoot), { title: "小说保存到哪个目录" }),
						Btn("＋ 新建", () => setCreating(!creating), { title: "新建一部小说" }),
						Btn("刷新", reload, { title: "重新扫描磁盘" })
					)
				)
			);
			if (ask) kids.push(Notice(ask.kind, ask.text));
			if (fellNotice) kids.push(Notice("err", "⚠️ " + fellNotice));

			// 保存位置表单
			if (showRoot) {
				kids.push(
					h(RootForm, {
						key: "root",
						onCancel: () => setShowRoot(false),
						onChanged: reload
					})
				);
			}

			// 直播框：小d 正在写的字，400ms 追一次
			if (live) {
				kids.push(
					h(
						"div",
						{ className: "dn_live", key: "live" },
						h(
							"div",
							{ className: "dn_livehead" },
							h("span", null, liveHead(live)),
							h(
								"span",
								{ className: "dn_hint" },
								live.chars + " 字" + (live.gapped ? " · 可能有跳帧" : "")
							)
						),
						h(
							"pre",
							{ className: "dn_livepre" + (live.kind === "reasoning" ? " reason" : "") },
							tailOf(live.preview, LIVE_TAIL)
						)
					)
				);
			}

			if (creating) {
				kids.push(
					h(NewNovelForm, {
						key: "new",
						onCancel: () => setCreating(false),
						onCreated: (name) => {
							setCreating(false);
							// 新建的那本直接打开（记住它），并进设定页开始设计
							setLib((prev) => rememberOpen(prev, root, name));
							setView("settings");
							reload();
						}
					})
				);
			}

			if (list.error) {
				kids.push(h("div", { className: "dn_err", key: "err" }, "⚠️ 加载失败：" + list.error));
			} else if (list.loading && novels.length === 0) {
				kids.push(h("div", { className: "dn_ph", key: "loading" }, "正在扫描小说目录…"));
			} else if (novels.length === 0 && !creating) {
				kids.push(
					h(
						"div",
						{ className: "dn_ph", key: "empty" },
						"还没有小说项目（目录 " +
							(list.root || "D:\\dsh-novel") +
							"）。点右上「＋ 新建」，或在聊天里说「新建一部小说」。"
					)
				);
			}

			if (novel) {
				const meta =
					novel.chapterCount +
					" 章 · 角色 " +
					((novel.cast && novel.cast.characters) || 0) +
					" 人 · " +
					agoText(lastWriteOf(novel));
				// 书名这一行**永远可以点** —— 小说库不只是"换书"，改名/删除也在里面。
				// （以前只有一本时它是个死行，用户以为"书名改不了"，其实入口被藏了）
				kids.push(
					h(
						"button",
						{
							className: "dn_bookrow pick",
							key: "book",
							title: novels.length > 1 ? "点一下换一本小说" : "点开小说库（改名 / 删除 / 新建）",
							onClick: () => setSwitching(!switching)
						},
						h("span", { className: "dn_bookn" }, "📖《" + novel.name + "》"),
						h("span", { className: "dn_bookmeta" }, meta),
						h("span", { className: "dn_caret" }, switching ? "▴" : "▾")
					)
				);

				kids.push(
					h(
						"div",
						{ className: "dn_acts", key: "ask" },
						Btn("✍️ 写下一章（第" + String((novel.chapterCount || 0) + 1).padStart(3, "0") + "章）", askNextChapter, {
							kind: "primary",
							title: "让小d 带着大纲 + 角色关系续写，并自动存盘"
						}),
						h("span", { className: "dn_hint" }, "点一下直接发进会话")
					)
				);

				// 切换器展开时"接管"面板下半部分（侧栏窄，浮层不如接管好用）
				if (switching) {
					kids.push(
						h(NovelSwitcher, {
							key: "sw",
							novels: novels,
							record: record,
							current: novelName,
							root: root,
							onClose: () => setSwitching(false),
							onPick: openNovel,
							onRenamed: (from, to) => {
								// 记忆跟着改名搬过去，免得下次提示"上次打开的不在了"
								setLib((prev) => renameInLib(prev, root, from, to));
								reload();
							},
							onDeleted: (name) => {
								setLib((prev) => forgetNovel(prev, root, name));
								reload();
							}
						})
					);
					kids.push(
						h(
							"div",
							{ className: "dn_foot", key: "foot" },
							h("span", { className: "dn_hint" }, "小说库：" + (root || "?"))
						)
					);
					return h("div", { className: "dn_root" }, kids);
				}

				kids.push(
					h(
						"div",
						{ className: "dn_tabs", key: "tabs" },
						[
							["chapters", "章节 " + novel.chapterCount],
							["settings", "设定"],
							["cast", "角色 " + ((novel.cast && novel.cast.characters) || 0)]
						].map((pair) =>
							h(
								"button",
								{
									key: pair[0],
									className: "dn_tab" + (view === pair[0] ? " on" : ""),
									onClick: () => setView(pair[0])
								},
								pair[1]
							)
						)
					)
				);

				if (view === "chapters")
					kids.push(
						h(ChapterView, {
							key: "v-ch",
							novel,
							onChanged: reload,
							onSeen: onSeen,
							initialFile: seen && seen.view === "chapters" ? seen.file : ""
						})
					);
				else if (view === "settings")
					kids.push(
						h(SettingsView, {
							key: "v-se",
							novel,
							onChanged: reload,
							onSeen: onSeen,
							initialFile: seen && seen.view === "settings" ? seen.file : ""
						})
					);
				else
					kids.push(
						h(CastView, {
							key: "v-ca",
							novel,
							onChanged: reload,
							// 关系图里人手拖的节点位置（按小说记在本地）
							pos: graphPosOf(record, novelName),
							onMovePos: (id, x, y) => setLib((prev) => setGraphPos(prev, root, novelName, id, x, y)),
							onResetPos: () => setLib((prev) => clearGraphPos(prev, root, novelName))
						})
					);
			}

			kids.push(
				h(
					"div",
					{ className: "dn_foot", key: "foot" },
					h(
						"div",
						{ className: "dn_footrow" },
						h("span", null, "🔄 自动刷新"),
						h(
							"select",
							{
								className: "dn_mini",
								value: pollPref,
								title: preset.hint,
								onChange: (e) => {
									setPollPref(e.target.value);
									writePollPref(e.target.value);
								}
							},
							POLL_CHOICES.map((p) => h("option", { key: p.id, value: p.id }, p.label))
						),
						pollPref === "custom"
							? h(
									"span",
									{ className: "dn_customrow" },
									h("span", { className: "dn_hint" }, "列表"),
									h("input", {
										className: "dn_num",
										type: "number",
										min: String(CUSTOM_LIST_RANGE[0]),
										max: String(CUSTOM_LIST_RANGE[1]),
										step: "1",
										value: customDraft.list,
										onChange: (e) => setCustom({ list: e.target.value })
									}),
									h("span", { className: "dn_hint" }, "秒·直播"),
									h("input", {
										className: "dn_num",
										type: "number",
										min: "0",
										max: String(CUSTOM_LIVE_RANGE[1]),
										step: "0.5",
										value: customDraft.live,
										onChange: (e) => setCustom({ live: e.target.value })
									}),
									h("span", { className: "dn_hint" }, "秒（0=不直播）"),
									// 夹取之后真正生效的值，顺便告诉你"你填的 0 被当成了 1" 这种事
									h("span", { className: "dn_hint" }, "· 生效：" + preset.hint)
							  )
							: h("span", { className: "dn_hint" }, preset.hint)
					),
					h("div", null, "💬 设定自己改；写正文在聊天里点「✍️ 写下一章」")
				)
			);

			return h("div", { className: "dn_root" }, kids);
		}

		function apply(ctx) {
			const svc = ctx.betterSidebar || (typeof ctx.get === "function" ? ctx.get("betterSidebar") : undefined);
			if (!svc || typeof svc.registerTab !== "function") {
				console.warn("[dsh-novel] betterSidebar 服务不可用，侧栏页签未注册");
				return;
			}
			const register = () =>
				svc.registerTab({
					id: "dsh-novel:panel",
					title: "小说",
					description: "小说创作台（章节 / 设定 / 角色）",
					order: 60,
					single: true,
					component: NovelPanel
				});
			if (typeof ctx.effect === "function") ctx.effect(register, "dsh-novel: sidebar tab");
			else register();
			console.log("[dsh-novel] 侧栏页签已注册：小说");
		}

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * 给本地测试用的后门：客户端半不能 import 自己的文件，
		 * 所以纯逻辑挂在这儿，test-library.mjs 直接拿去喂假 localStorage 测。
		 * （宿主只读 apply/inject，多挂一个键无害。）
		 */
		exports.__test = {
			LIBRARY_KEY: LIBRARY_KEY,
			RECENT_CAP: RECENT_CAP,
			readLibrary: readLibrary,
			writeLibrary: writeLibrary,
			libRecord: libRecord,
			chooseOpen: chooseOpen,
			seenOf: seenOf,
			rememberOpen: rememberOpen,
			rememberSeen: rememberSeen,
			forgetNovel: forgetNovel,
			renameInLib: renameInLib,
			graphPosOf: graphPosOf,
			setGraphPos: setGraphPos,
			clearGraphPos: clearGraphPos,
			layoutGraph: layoutGraph,
			NODE_R: NODE_R,
			lastWriteOf: lastWriteOf,
			agoText: agoText,
			sortNovels: sortNovels,
			chapterLabel: chapterLabel
		};
		return module.exports;
	}
});
