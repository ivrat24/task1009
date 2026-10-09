(() => {
  const TAXONOMY = window.IR02_TAXONOMY || [];
  const STORE_PREFIX = "ir02.annot.v1:";
  const LABEL_FORMAT = "ir02.labels.v3";
  const LABEL_FORMATS = new Set([
    LABEL_FORMAT,
    "ir02.labels.v2",
    "ir02.labels.v1",
  ]);

  /** Stable A/B split by session_id — same on both machines. */
  function sessionOwner(sessionId) {
    const s = String(sessionId || "");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 2 === 0 ? "A" : "B";
  }

  function normalizeWorkScope(v) {
    // Legacy "other" removed — handoff is personal export only.
    return v === "all" ? "all" : "mine";
  }

  const state = {
    sessions: [],
    sessionIndex: 0,
    promptIndex: 0,
    annotator: localStorage.getItem("ir02.annotator") || "A",
    workScope: normalizeWorkScope(localStorage.getItem("ir02.workScope") || "mine"),
    labels: {},
    filter: "all", // all | unlabeled | labeled
    hideNonUser: false,
    // Default OFF so the full user↔agent thread is visible; opt-in via「只看当前轮」.
    focusCurrent: localStorage.getItem("ir02.focusCurrent") === "1",
    search: "",
    renderMath: localStorage.getItem("ir02.renderMath") !== "0",
    lastImportReport: null,
  };

  const $ = (id) => document.getElementById(id);

  function storeKey() {
    return STORE_PREFIX + (state.annotator || "A");
  }
  function loadLabels() {
    try {
      state.labels = JSON.parse(localStorage.getItem(storeKey()) || "{}");
    } catch {
      state.labels = {};
    }
  }
  function saveLabels() {
    localStorage.setItem(storeKey(), JSON.stringify(state.labels));
  }

  function inWorkScope(session) {
    if (!session) return false;
    if (state.annotator === "gold" || state.workScope === "all") return true;
    return sessionOwner(session.session_id) === state.annotator;
  }

  function scopeReadOnly() {
    return false;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function plainPreview(s, max = 160) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function getMarkedParse() {
    const m = window.marked;
    if (!m) return null;
    // Escape raw HTML in markdown source so one turn cannot break the whole thread DOM.
    try {
      if (typeof m.use === "function" && !m.__ir02_safe) {
        const renderer = {
          html(token) {
            const text = typeof token === "string" ? token : token?.text || "";
            return esc(text);
          },
        };
        m.use({ renderer });
        m.__ir02_safe = true;
      }
      if (typeof m.setOptions === "function") {
        m.setOptions({ breaks: true, gfm: true, async: false });
      }
    } catch (err) {
      console.warn("[ir02] marked safe renderer failed", err);
    }
    if (typeof m.parse === "function") return (src, opt) => m.parse(src, opt);
    if (typeof m.marked === "function") return (src, opt) => m.marked(src, opt);
    if (typeof m === "function") return m;
    return null;
  }

  /** Minimal sync markdown when marked is missing/broken. */
  function fallbackMarkdown(src) {
    const parts = String(src).replace(/\r\n/g, "\n").split(/(```[\s\S]*?```)/g);
    return parts
      .map((chunk) => {
        if (chunk.startsWith("```")) {
          const m = chunk.match(/^```[^\n]*\n?([\s\S]*?)```$/);
          return `<pre><code>${esc(m ? m[1].replace(/\n$/, "") : chunk.slice(3))}</code></pre>`;
        }
        return chunk
          .split("\n")
          .map((line) => {
            // ATX headings may be indented (common in agent transcripts)
            const t = line.replace(/^\s{0,3}/, "");
            if (/^###\s+/.test(t)) return `<h3>${inlineMd(t.replace(/^###\s+/, ""))}</h3>`;
            if (/^##\s+/.test(t)) return `<h2>${inlineMd(t.replace(/^##\s+/, ""))}</h2>`;
            if (/^#\s+/.test(t)) return `<h1>${inlineMd(t.replace(/^#\s+/, ""))}</h1>`;
            if (/^---+$/.test(t.trim())) return "<hr>";
            if (/^[-*]\s+/.test(t)) return `<li>${inlineMd(t.replace(/^[-*]\s+/, ""))}</li>`;
            if (/^\d+\.\s+/.test(t)) return `<li>${inlineMd(t.replace(/^\d+\.\s+/, ""))}</li>`;
            if (!line.trim()) return "";
            return `<p>${inlineMd(line)}</p>`;
          })
          .join("\n")
          .replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
      })
      .join("\n");
  }

  function inlineMd(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    return t;
  }

  /** Markdown + LaTeX (KaTeX) for conversation bubbles. */
  function renderRichHtml(text) {
    const raw = String(text ?? "");
    if (!state.renderMath) {
      return `<div class="plain">${esc(raw)}</div>`;
    }
    let html = "";
    try {
      const parse = getMarkedParse();
      if (parse) {
        const out = parse(raw, { breaks: true, gfm: true, async: false });
        if (typeof out === "string" && out.trim()) html = out;
      }
    } catch (err) {
      console.warn("[ir02] marked parse failed", err);
    }
    if (!html) html = fallbackMarkdown(raw);
    return `<div class="md" data-rich="1">${html}</div>`;
  }

  function typesetMath(root) {
    if (!state.renderMath) return;
    // Prefer auto-render; fall back to manual $...$ / $$...$$ walk.
    if (typeof renderMathInElement === "function" && typeof katex !== "undefined") {
      try {
        renderMathInElement(root, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "\\(", right: "\\)", display: false },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
          strict: "ignore",
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
        });
        return;
      } catch (err) {
        console.warn("[ir02] katex auto-render failed", err);
      }
    }
  }

  function isLabelable(turn) {
    if (!turn || turn.role !== "user") return false;
    const t = String(turn.turn_type || "").toLowerCase();
    if (t.includes("tool") || t === "progress" || t === "system_event") return false;
    return true;
  }

  function labelableTurns(session) {
    return (session?.turns || []).filter(isLabelable);
  }

  function currentSession() {
    return state.sessions[state.sessionIndex] || null;
  }

  function currentPrompts() {
    return labelableTurns(currentSession());
  }

  function currentPrompt() {
    return currentPrompts()[state.promptIndex] || null;
  }

  function labelOf(turnId) {
    return state.labels[turnId] || null;
  }

  function extractContent(row) {
    if (row == null) return "";
    if (typeof row === "string") return row;
    for (const key of ["content", "text", "message", "prompt", "output", "result"]) {
      const v = row[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v)) {
        return v
          .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
              return String(item.text || item.content || item.value || "");
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (v && typeof v === "object") {
        if (typeof v.text === "string") return v.text;
        if (typeof v.content === "string") return v.content;
      }
    }
    return "";
  }

  function parseLoadedText(text, filename = "upload") {
    const report = {
      filename,
      bytes: text.length,
      sessions: 0,
      turns: 0,
      user_prompts: 0,
      skipped_lines: 0,
      empty_sessions: 0,
      mode: "",
    };
    const trimmed = text.replace(/^\uFEFF/, "").trim();
    if (!trimmed) {
      report.mode = "empty";
      return { sessions: [], report };
    }

    let rawSessions = [];
    // JS bundle: window.CLEANED_SESSIONS = ...
    if (trimmed.includes("CLEANED_SESSIONS")) {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`${trimmed}; return window.CLEANED_SESSIONS || CLEANED_SESSIONS;`);
      const arr = fn();
      if (!Array.isArray(arr)) throw new Error(`${filename}: CLEANED_SESSIONS 不是数组`);
      rawSessions = arr;
      report.mode = "js-bundle";
    } else if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) throw new Error(`${filename}: JSON 根节点不是数组`);
      if (arr[0] && (arr[0].turns || arr[0].messages)) {
        rawSessions = arr;
        report.mode = "json-array";
      } else {
        rawSessions = groupFlatRows(arr, filename);
        report.mode = "json-array-flat";
      }
    } else {
      const rows = [];
      const lines = trimmed.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (!t.startsWith("{")) {
          report.skipped_lines += 1;
          continue;
        }
        try {
          rows.push(JSON.parse(t));
        } catch {
          report.skipped_lines += 1;
        }
      }
      if (!rows.length) throw new Error(`${filename}: 未解析到任何 JSON/JSONL 对象`);
      if (rows[0].turns || rows[0].messages) {
        rawSessions = rows;
        report.mode = "jsonl-sessions";
      } else {
        rawSessions = groupFlatRows(rows, filename);
        report.mode = "jsonl-flat";
      }
    }

    const sessions = [];
    for (const obj of rawSessions) {
      const s = normalizeSession(obj, obj.source_file || filename);
      report.turns += s.turns.length;
      report.user_prompts += s.user_prompt_count;
      if (s.user_prompt_count > 0) {
        sessions.push(s);
        report.sessions += 1;
      } else {
        report.empty_sessions += 1;
      }
    }
    return { sessions, report };
  }

  function normalizeSession(obj, source = "") {
    const sid = String(obj.session_id || obj.id || source || "session");
    const raw = Array.isArray(obj.turns)
      ? obj.turns
      : Array.isArray(obj.messages)
        ? obj.messages
        : [];
    const turns = raw.map((row, idx) => {
      const content = extractContent(row);
      return {
        turn_id: String(row.turn_id || `${sid}#${idx}`),
        turn_number: typeof row.turn_number === "number" ? row.turn_number : idx,
        role: String(row.role || "system").toLowerCase(),
        turn_type: String(row.turn_type || row.type || ""),
        is_conversational: row.is_conversational,
        content,
      };
    });
    return {
      session_id: sid,
      source_file: obj.source_file || source,
      meta: obj.meta || {},
      turns,
      user_prompt_count: turns.filter(isLabelable).length,
    };
  }

  function groupFlatRows(rows, filename) {
    const buckets = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sid = String(row.session_id || filename);
      if (!buckets.has(sid)) buckets.set(sid, []);
      buckets.get(sid).push(row);
    }
    const out = [];
    for (const [sid, items] of buckets) {
      out.push({
        session_id: sid,
        source_file: filename,
        turns: items.map((row, idx) => ({
          turn_id: row.turn_id || `${sid}#${idx}`,
          turn_number: typeof row.turn_number === "number" ? row.turn_number : idx,
          role: row.role || (String(row.turn_type || "").includes("user") ? "user" : "assistant"),
          turn_type: row.turn_type || row.type || "",
          is_conversational: row.is_conversational,
          content: extractContent(row),
        })),
      });
    }
    return out;
  }

  function setSessions(sessions, report = null) {
    // Deduplicate by session_id (later file wins) while preserving order of first seen then replace.
    const map = new Map();
    for (const raw of sessions || []) {
      const s = normalizeSession(raw, raw.source_file || "");
      if (labelableTurns(s).length > 0) map.set(s.session_id, s);
    }
    state.sessions = [...map.values()];
    state.sessionIndex = 0;
    state.promptIndex = 0;
    state.lastImportReport = report;
    render();
  }

  function filteredSessions() {
    const q = state.search.trim().toLowerCase();
    return state.sessions
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => {
        if (!inWorkScope(s)) return false;
        if (q && !`${s.session_id} ${s.source_file || ""}`.toLowerCase().includes(q)) return false;
        const prompts = labelableTurns(s);
        const labeled = prompts.filter((t) => labelOf(t.turn_id)?.intention).length;
        if (state.filter === "unlabeled") return labeled < prompts.length;
        if (state.filter === "labeled") return labeled === prompts.length && prompts.length > 0;
        return true;
      });
  }

  function stats() {
    let prompts = 0;
    let labeled = 0;
    let scopeSessions = 0;
    let scopePrompts = 0;
    let scopeLabeled = 0;
    for (const s of state.sessions) {
      const promptsIn = labelableTurns(s);
      for (const t of promptsIn) {
        prompts += 1;
        if (labelOf(t.turn_id)?.intention) labeled += 1;
      }
      if (!inWorkScope(s)) continue;
      scopeSessions += 1;
      for (const t of promptsIn) {
        scopePrompts += 1;
        if (labelOf(t.turn_id)?.intention) scopeLabeled += 1;
      }
    }
    return {
      sessions: state.sessions.length,
      prompts,
      labeled,
      scopeSessions,
      scopePrompts,
      scopeLabeled,
    };
  }

  function goSession(delta) {
    const items = filteredSessions();
    if (!items.length) return;
    let pos = items.findIndex(({ idx }) => idx === state.sessionIndex);
    if (pos < 0) pos = 0;
    else pos = Math.max(0, Math.min(items.length - 1, pos + delta));
    state.sessionIndex = items[pos].idx;
    state.promptIndex = 0;
    render();
  }

  function goPrompt(delta) {
    const prompts = currentPrompts();
    if (!prompts.length) return;
    state.promptIndex = Math.max(0, Math.min(prompts.length - 1, state.promptIndex + delta));
    render({ scrollCurrent: true });
  }

  function nextUnlabeled() {
    const items = filteredSessions();
    if (!items.length) return;
    let startPos = items.findIndex(({ idx }) => idx === state.sessionIndex);
    if (startPos < 0) startPos = 0;
    for (let off = 0; off < items.length; off++) {
      const pos = (startPos + off) % items.length;
      const { s, idx: si } = items[pos];
      const prompts = labelableTurns(s);
      const start = off === 0 && si === state.sessionIndex ? state.promptIndex + 1 : 0;
      for (let pi = start; pi < prompts.length; pi++) {
        if (!labelOf(prompts[pi].turn_id)?.intention) {
          state.sessionIndex = si;
          state.promptIndex = pi;
          render({ scrollCurrent: true });
          return;
        }
      }
    }
    alert("当前任务范围内没有未标注的 User prompt 了");
  }

  function commitLabel(intention, advance = true) {
    const prompt = currentPrompt();
    const session = currentSession();
    if (!prompt) return;
    if (scopeReadOnly()) {
      alert("当前为「对方分片」只读浏览，请改回「仅我的分片」再标注。");
      return;
    }
    if (state.annotator !== "gold" && session && !inWorkScope(session)) {
      alert(`该会话分给标注员 ${sessionOwner(session.session_id)}，与当前 ${state.annotator} 不符。`);
      return;
    }
    if (!intention) {
      alert("请先选择一个意图类别");
      return;
    }
    state.labels[prompt.turn_id] = {
      intention,
      note: $("note")?.value.trim() || "",
      uncertain: !!$("uncertain")?.checked,
      annotator: state.annotator,
      session_id: session?.session_id,
      source_file: session?.source_file || "",
      turn_number: prompt.turn_number,
      user_prompt: String(prompt.content || ""),
      labeled_at: new Date().toISOString(),
    };
    saveLabels();
    const labeledNow = stats().labeled;
    maybeCelebrateMilestone(labeledNow);
    if (advance) {
      const items = filteredSessions();
      const prompts = currentPrompts();
      if (state.promptIndex < prompts.length - 1) {
        state.promptIndex += 1;
      } else {
        const pos = items.findIndex(({ idx }) => idx === state.sessionIndex);
        if (pos >= 0 && pos < items.length - 1) {
          state.sessionIndex = items[pos + 1].idx;
          state.promptIndex = 0;
        }
      }
    }
    render({ scrollCurrent: true });
  }

  const MILESTONE_N = 200;

  function milestoneKey() {
    return `ir02.milestone${MILESTONE_N}:${state.annotator || "A"}`;
  }

  function maybeCelebrateMilestone(labeledCount) {
    if (labeledCount < MILESTONE_N) return;
    if (localStorage.getItem(milestoneKey()) === "1") return;
    localStorage.setItem(milestoneKey(), "1");
    showMilestoneSplash(MILESTONE_N);
  }

  function showMilestoneSplash(n) {
    const old = document.getElementById("milestone-splash");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "milestone-splash";
    overlay.className = "milestone-splash";
    overlay.innerHTML = `
      <div class="milestone-card">
        <div class="milestone-kicker">IR-02</div>
        <div class="milestone-title">标到 ${n} 个了</div>
        <div class="milestone-sub">已完成 ${n} 条 User prompt 意图标注</div>
      </div>
    `;
    document.body.appendChild(overlay);
    // Force layout so enter transition runs.
    overlay.offsetHeight;
    overlay.classList.add("is-in");

    const dismiss = () => {
      overlay.classList.remove("is-in");
      overlay.classList.add("is-push-up");
      window.setTimeout(() => overlay.remove(), 520);
    };
    overlay.addEventListener("click", dismiss, { once: true });
    window.setTimeout(dismiss, 1600);
  }

  function clearLabel() {
    if (scopeReadOnly()) {
      alert("对方分片为只读，不能清除标注。");
      return;
    }
    const prompt = currentPrompt();
    if (!prompt) return;
    delete state.labels[prompt.turn_id];
    saveLabels();
    render();
  }

  function renderSessionList() {
    const box = $("session-list");
    const items = filteredSessions();
    if (!items.length) {
      box.innerHTML = '<div class="empty">无匹配会话。请导入 cleaned sessions，或放宽筛选。</div>';
      return;
    }
    box.innerHTML = items
      .map(({ s, idx }) => {
        const prompts = labelableTurns(s);
        const labeled = prompts.filter((t) => labelOf(t.turn_id)?.intention).length;
        const done = labeled === prompts.length && prompts.length > 0;
        const owner = sessionOwner(s.session_id);
        return `<div class="item ${idx === state.sessionIndex ? "active" : ""}" data-si="${idx}">
          <div class="title">
            <span class="title-text">${esc(s.session_id)}</span>
            <span class="badge">${esc(owner)}</span>
            <span class="badge ${done ? "ok" : "miss"}">${labeled}/${prompts.length}</span>
          </div>
        </div>`;
      })
      .join("");
    box.querySelectorAll(".item").forEach((el) => {
      el.onclick = () => {
        state.sessionIndex = Number(el.dataset.si);
        state.promptIndex = 0;
        render({ scrollCurrent: true });
      };
    });
  }

  function renderPromptList() {
    const box = $("prompt-list");
    const prompts = currentPrompts();
    if (!prompts.length) {
      box.innerHTML = '<div class="empty">当前会话没有可标注的 User prompt。</div>';
      return;
    }
    box.innerHTML = prompts
      .map((t, i) => {
        const lab = labelOf(t.turn_id);
        return `<div class="item ${i === state.promptIndex ? "active" : ""}" data-pi="${i}">
          <div class="title">
            <span class="title-text">#${i + 1}</span>
            <span class="badge ${lab?.intention ? "ok" : "miss"}">${lab?.intention || "未标"}</span>
          </div>
          <div class="preview">${esc(plainPreview(t.content))}</div>
        </div>`;
      })
      .join("");
    box.querySelectorAll(".item").forEach((el) => {
      el.onclick = () => {
        state.promptIndex = Number(el.dataset.pi);
        render({ scrollCurrent: true });
      };
    });
  }

  function renderLabelPanel() {
    const prompt = currentPrompt();
    const saved = prompt ? labelOf(prompt.turn_id) : null;
    const intention = saved?.intention || "";
    const statesHtml = TAXONOMY.map(
      (t) => {
        const tip = [t.core, t.definition, t.note]
          .filter(Boolean)
          .join(" — ")
          .replace(/"/g, "&quot;");
        return `<label class="state ${intention === t.id ? "on" : ""}" title="${esc(tip)}">
        <input type="radio" name="intention" value="${t.id}" ${intention === t.id ? "checked" : ""} />
        <b>${t.key} ${t.name}</b>
      </label>`;
      }
    ).join("");

    const ro = scopeReadOnly();
    $("label-panel").innerHTML = `
      ${ro ? '<div class="empty compact">对方分片只读</div>' : ""}
      <div class="states">${statesHtml}</div>
      <div class="label-actions">
        <input id="note" type="text" placeholder="备注（可选）" value="${esc(saved?.note || "")}" ${ro ? "disabled" : ""} />
        <label class="uncertain"><input id="uncertain" type="checkbox" ${saved?.uncertain ? "checked" : ""} ${ro ? "disabled" : ""} /> 不确定</label>
        <button id="save" class="primary" type="button" ${ro ? "disabled" : ""}>保存并下一条</button>
        <button id="save-stay" type="button" ${ro ? "disabled" : ""}>仅保存</button>
        <button id="clear" type="button" ${ro ? "disabled" : ""}>清除</button>
      </div>
    `;

    $("label-panel").querySelectorAll('input[name="intention"]').forEach((el) => {
      el.onchange = () => {
        $("label-panel").querySelectorAll(".state").forEach((n) => {
          n.classList.toggle("on", n.querySelector("input")?.checked);
        });
      };
    });
    $("save").onclick = () => {
      const picked = $("label-panel").querySelector('input[name="intention"]:checked');
      commitLabel(picked?.value, true);
    };
    $("save-stay").onclick = () => {
      const picked = $("label-panel").querySelector('input[name="intention"]:checked');
      commitLabel(picked?.value, false);
    };
    $("clear").onclick = clearLabel;
  }

  /** Turns belonging to the current prompt's local exchange (prev agent…user…next agent). */
  function focusWindowIds(turns, current) {
    if (!current) return null;
    const curIdx = turns.findIndex((t) => t.turn_id === current.turn_id);
    if (curIdx < 0) return new Set([current.turn_id]);
    const ids = new Set([turns[curIdx].turn_id]);
    for (let i = curIdx + 1; i < turns.length; i++) {
      if (isLabelable(turns[i])) break;
      ids.add(turns[i].turn_id);
    }
    for (let i = curIdx - 1; i >= 0; i--) {
      if (isLabelable(turns[i])) break;
      ids.add(turns[i].turn_id);
    }
    return ids;
  }

  function renderThread(opts = {}) {
    const session = currentSession();
    const current = currentPrompt();
    const box = $("thread");
    if (!session) {
      box.innerHTML = '<div class="empty">尚未载入数据。可用演示数据，或导入 data/cleaned/sessions_sample100.jsonl。</div>';
      return;
    }
    box.replaceChildren();
    box.classList.toggle("focus-current", !!state.focusCurrent);
    const turns = session.turns || [];
    const winIds = state.focusCurrent ? focusWindowIds(turns, current) : null;
    let rendered = 0;
    for (const turn of turns) {
      if (state.hideNonUser && turn.role !== "user") continue;
      const role = turn.role || "system";
      const isCurrent = current && turn.turn_id === current.turn_id;
      const inFocusWin = !winIds || winIds.has(turn.turn_id);
      // Focus mode: keep the current user prompt together with adjacent agent turns.
      if (state.focusCurrent && !inFocusWin) continue;
      const lab = role === "user" ? labelOf(turn.turn_id) : null;

      const bubble = document.createElement("div");
      bubble.className = `bubble ${role}${isCurrent ? " current" : ""}${inFocusWin ? " focus-win" : ""}`;
      bubble.dataset.tid = String(turn.turn_id || "");

      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = `
        <span>${role === "user" ? "User prompt" : role === "assistant" ? "Assistant" : esc(role)}</span>
        <span class="badge">${esc(turn.turn_type || "")}</span>
        ${lab?.intention ? `<span class="badge ok">${esc(lab.intention)}</span>` : ""}
        ${isCurrent ? '<span class="badge ok">当前标注</span>' : ""}
        ${state.renderMath ? '<span class="badge ok">MD/TeX</span>' : '<span class="badge">plain</span>'}
      `;

      const body = document.createElement("div");
      body.className = "bubble-body";
      // Isolate HTML parsing per bubble so one bad fragment cannot break siblings.
      body.innerHTML = renderRichHtml(turn.content);
      typesetMath(body);

      bubble.appendChild(who);
      bubble.appendChild(body);
      box.appendChild(bubble);
      rendered += 1;
    }
    if (!rendered) {
      box.innerHTML = '<div class="empty">该会话没有可显示的回合。</div>';
      return;
    }
    // Always start from the top so long prompts show from the beginning.
    box.scrollTop = 0;
    if (opts.scrollCurrent && !state.focusCurrent) {
      const el = box.querySelector(".bubble.current");
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  function renderStatus() {
    if ($("annotator")) $("annotator").value = state.annotator;
    if ($("work-scope")) $("work-scope").value = state.workScope;
    if ($("filter")) $("filter").value = state.filter;
    if ($("hide-nonuser")) $("hide-nonuser").checked = state.hideNonUser;
  }

  function ensureSessionInScope() {
    if (!state.sessions.length) return;
    if (inWorkScope(currentSession())) return;
    const items = filteredSessions();
    if (items.length) {
      state.sessionIndex = items[0].idx;
      state.promptIndex = 0;
    }
  }

  function render(opts = {}) {
    ensureSessionInScope();
    renderStatus();
    renderSessionList();
    renderPromptList();
    renderLabelPanel();
    renderThread(opts);
  }

  /** Collect complete personal labeled records (handoff artifact). */
  function collectPersonalResults() {
    const byTurn = new Map();
    // Prefer live session content so export always carries full prompt text.
    for (const session of state.sessions) {
      if (state.workScope === "mine" && state.annotator !== "gold" && !inWorkScope(session)) continue;
      const prompts = labelableTurns(session);
      prompts.forEach((t, i) => {
        const lab = labelOf(t.turn_id);
        if (!lab?.intention) return;
        byTurn.set(t.turn_id, {
          turn_id: t.turn_id,
          session_id: session.session_id,
          session_owner: sessionOwner(session.session_id),
          source_file: session.source_file || "",
          prompt_index: i + 1,
          turn_number: t.turn_number,
          annotator: state.annotator,
          intention: lab.intention,
          uncertain: !!lab.uncertain,
          note: lab.note || "",
          labeled_at: lab.labeled_at || "",
          user_prompt: t.content || lab.user_prompt || "",
        });
      });
    }
    // Labels whose sessions are not currently loaded — keep stored full text if any.
    for (const [id, lab] of Object.entries(state.labels)) {
      if (!lab?.intention || byTurn.has(id)) continue;
      if (
        state.workScope === "mine" &&
        state.annotator !== "gold" &&
        lab.session_id &&
        sessionOwner(lab.session_id) !== state.annotator
      ) {
        continue;
      }
      byTurn.set(id, {
        turn_id: id,
        session_id: lab.session_id || "",
        session_owner: lab.session_id ? sessionOwner(lab.session_id) : "",
        source_file: lab.source_file || "",
        prompt_index: null,
        turn_number: lab.turn_number ?? null,
        annotator: state.annotator,
        intention: lab.intention,
        uncertain: !!lab.uncertain,
        note: lab.note || "",
        labeled_at: lab.labeled_at || "",
        user_prompt: lab.user_prompt || lab.prompt_preview || "",
      });
    }
    return [...byTurn.values()].sort((a, b) =>
      String(a.session_id).localeCompare(String(b.session_id)) ||
      (a.prompt_index || 0) - (b.prompt_index || 0) ||
      String(a.turn_id).localeCompare(String(b.turn_id))
    );
  }

  function exportExcel() {
    const rows = collectPersonalResults();
    if (!rows.length) {
      alert("当前没有已标注结果可导出");
      return;
    }
    if (typeof XLSX === "undefined") {
      exportCsv(rows);
      return;
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "labels");
    XLSX.writeFile(wb, `${exportFileStem()}_results.xlsx`);
  }

  function exportCsv(rows) {
    const data = rows || collectPersonalResults();
    if (!data.length) {
      alert("当前没有已标注结果可导出");
      return;
    }
    const headers = [
      "annotator",
      "session_id",
      "session_owner",
      "source_file",
      "prompt_index",
      "turn_id",
      "turn_number",
      "intention",
      "uncertain",
      "note",
      "labeled_at",
      "user_prompt",
    ];
    const lines = [headers.join(",")];
    for (const r of data) {
      lines.push(headers.map((h) => csvEscape(r[h])).join(","));
    }
    downloadText(lines.join("\n"), `${exportFileStem()}_results.csv`, "text/csv");
  }

  function exportJsonl() {
    const rows = collectPersonalResults();
    if (!rows.length) {
      alert("当前没有已标注结果可导出");
      return;
    }
    const lines = rows.map((r) => JSON.stringify(r));
    downloadText(
      lines.join("\n") + "\n",
      `${exportFileStem()}_results.jsonl`,
      "application/jsonl"
    );
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }
  function downloadText(text, filename, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportFileStem() {
    return `ir02_${state.annotator}_${stamp()}`;
  }

  function exportLabelsState() {
    const results = collectPersonalResults();
    if (!results.length) {
      alert("当前没有已标注结果可导出");
      return;
    }
    const st = stats();
    const labels = {};
    for (const r of results) {
      labels[r.turn_id] = {
        intention: r.intention,
        note: r.note,
        uncertain: r.uncertain,
        annotator: r.annotator,
        session_id: r.session_id,
        source_file: r.source_file,
        turn_number: r.turn_number,
        labeled_at: r.labeled_at,
        user_prompt: r.user_prompt,
      };
    }
    const missingPrompt = results.filter((r) => !String(r.user_prompt || "").trim()).length;
    const payload = {
      format: LABEL_FORMAT,
      format_legacy: "ir02.labels.v1",
      kind: "personal_complete_results",
      annotator: state.annotator,
      work_scope: state.workScope,
      exported_at: new Date().toISOString(),
      label_count: results.length,
      scope_prompts: st.scopePrompts,
      scope_labeled: st.scopeLabeled,
      complete: st.scopeLabeled >= st.scopePrompts && st.scopePrompts > 0,
      missing_user_prompt: missingPrompt,
      results,
      labels,
    };
    downloadText(
      JSON.stringify(payload, null, 2),
      `${exportFileStem()}_results.json`,
      "application/json"
    );
    localStorage.setItem("ir02.lastExportAt", payload.exported_at);
    alert(
      `已导出标注员 ${state.annotator} 完整结果 ${results.length} 条` +
        (payload.complete ? "（任务范围内已全部标注）" : `（任务范围内进度 ${st.scopeLabeled}/${st.scopePrompts}）`) +
        (missingPrompt ? `\n注意：其中 ${missingPrompt} 条缺少 user_prompt 正文` : "")
    );
  }

  function unwrapLabelPayload(obj) {
    if (!obj || typeof obj !== "object") return null;

    // JSONL-style array of result rows
    if (Array.isArray(obj)) {
      const labels = {};
      for (const row of obj) {
        if (!row || typeof row !== "object" || !row.turn_id || !row.intention) continue;
        labels[String(row.turn_id)] = row;
      }
      return Object.keys(labels).length
        ? { labels, meta: { format: "array-results" }, resultCount: Object.keys(labels).length }
        : null;
    }

    if (
      (LABEL_FORMATS.has(obj.format) || obj.format_legacy === "ir02.labels.v1" || obj.kind === "personal_complete_results") &&
      (obj.labels || Array.isArray(obj.results))
    ) {
      let labels = obj.labels && typeof obj.labels === "object" ? { ...obj.labels } : {};
      if (Array.isArray(obj.results)) {
        for (const row of obj.results) {
          if (!row || !row.turn_id) continue;
          const id = String(row.turn_id);
          labels[id] = {
            ...(labels[id] || {}),
            intention: row.intention || labels[id]?.intention,
            note: row.note ?? labels[id]?.note ?? "",
            uncertain: row.uncertain ?? labels[id]?.uncertain ?? false,
            session_id: row.session_id || labels[id]?.session_id,
            source_file: row.source_file || labels[id]?.source_file,
            turn_number: row.turn_number ?? labels[id]?.turn_number,
            labeled_at: row.labeled_at || labels[id]?.labeled_at,
            user_prompt: row.user_prompt || labels[id]?.user_prompt || "",
            annotator: row.annotator || labels[id]?.annotator,
          };
        }
      }
      return {
        labels,
        meta: {
          annotator: obj.annotator,
          exported_at: obj.exported_at,
          format: obj.format,
          label_count: obj.label_count,
        },
        resultCount: Object.keys(labels).length,
      };
    }

    // Bare turn_id → label map
    const keys = Object.keys(obj);
    if (
      keys.length &&
      keys.every((k) => obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])) &&
      keys.some((k) => obj[k].intention)
    ) {
      return { labels: obj, meta: {}, resultCount: keys.length };
    }
    return null;
  }

  function importLabelsState(obj) {
    const parsed = unwrapLabelPayload(obj);
    if (!parsed) {
      alert("不是有效的个人标注结果（需要 ir02.labels.v1/v2/v3、results[]，或 turn_id→label）");
      return;
    }
    const { labels: incoming, meta } = parsed;
    if (meta.annotator && meta.annotator !== state.annotator) {
      const ok = confirm(
        `文件标注员为「${meta.annotator}」，当前为「${state.annotator}」。\n` +
          `将合并进当前槽位（同 turn_id 以文件为准覆盖）。继续？`
      );
      if (!ok) return;
    }
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let withPrompt = 0;
    for (const [id, lab] of Object.entries(incoming)) {
      if (!lab || typeof lab !== "object" || !lab.intention) {
        skipped += 1;
        continue;
      }
      const prev = state.labels[id];
      if (prev?.intention) updated += 1;
      else added += 1;
      const userPrompt = lab.user_prompt || lab.prompt_preview || prev?.user_prompt || "";
      if (String(userPrompt).trim()) withPrompt += 1;
      state.labels[id] = {
        ...prev,
        ...lab,
        intention: lab.intention,
        note: lab.note || "",
        uncertain: !!lab.uncertain,
        user_prompt: userPrompt,
        annotator: state.annotator,
      };
    }
    saveLabels();
    render({ scrollCurrent: true });
    const matched = Object.keys(incoming).filter((id) =>
      state.sessions.some((s) => labelableTurns(s).some((t) => t.turn_id === id))
    ).length;
    alert(
      `已导入到标注员 ${state.annotator}：新增 ${added} · 更新 ${updated}` +
        (skipped ? ` · 跳过无效 ${skipped}` : "") +
        `\n含完整 prompt ${withPrompt} 条 · 与当前会话数据匹配 ${matched} 条`
    );
  }

  function setLoadBanner(msg) {
    const box = $("thread");
    if (box && msg) {
      box.innerHTML = `<div class="empty">${esc(msg)}</div>`;
    }
  }

  async function loadSessionsJsonlStream(url, { label = "全库" } = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    const report = {
      filename: url.split("/").pop(),
      sessions: 0,
      turns: 0,
      user_prompts: 0,
      skipped_lines: 0,
      empty_sessions: 0,
      mode: "jsonl-stream",
    };
    const sessions = [];
    const pushLine = (line) => {
      const t = line.trim();
      if (!t) return;
      if (!t.startsWith("{")) {
        report.skipped_lines += 1;
        return;
      }
      try {
        const obj = JSON.parse(t);
        const s = normalizeSession(obj, obj.source_file || report.filename);
        report.turns += s.turns.length;
        report.user_prompts += s.user_prompt_count;
        if (s.user_prompt_count > 0) {
          sessions.push(s);
          report.sessions += 1;
        } else {
          report.empty_sessions += 1;
        }
      } catch {
        report.skipped_lines += 1;
      }
    };

    // Prefer streaming when available; otherwise one-shot text (still OK for local server).
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastUi = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          pushLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
        const now = Date.now();
        if (now - lastUi > 250) {
          lastUi = now;
          setLoadBanner(`正在导入${label}… 已解析 ${sessions.length} 会话`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (buf.trim()) pushLine(buf);
    } else {
      setLoadBanner(`正在导入${label}（整文件读取）…`);
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) pushLine(line);
    }

    if (!sessions.length) throw new Error(`${report.filename}: 未解析到可标注会话`);
    setSessions(sessions, report);
    return report;
  }

  async function loadDefaultBundle() {
    setLoadBanner("正在载入全部会话数据…");
    const fullCandidates = [
      "../data/cleaned/sessions.jsonl",
      "../data/cleaned/sessions.js",
    ];
    for (const url of fullCandidates) {
      try {
        if (url.endsWith(".js")) {
          // Avoid embedding 140MB JS in the page; only accept if already present.
          if (Array.isArray(window.CLEANED_SESSIONS) && window.CLEANED_SESSIONS.length > 200) {
            setSessions(window.CLEANED_SESSIONS, {
              filename: "sessions.js",
              sessions: window.CLEANED_SESSIONS.length,
              mode: "js-global-full",
            });
            return;
          }
          continue;
        }
        await loadSessionsJsonlStream(url, { label: "全库" });
        return;
      } catch (err) {
        console.warn("[ir02] full load failed", url, err);
      }
    }

    // Fallback: sample pack
    const sampleCandidates = [
      "../data/cleaned/sessions_sample100.jsonl",
      "../data/cleaned/sessions_sample100.js",
    ];
    for (const url of sampleCandidates) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const text = await res.text();
        const { sessions, report } = parseLoadedText(text, url.split("/").pop());
        if (sessions.length) {
          setSessions(sessions, report);
          alert("全库未能加载，已回退到 sample100。请用本地 HTTP 服务打开页面后再刷新。");
          return;
        }
      } catch {
        /* continue */
      }
    }
    if (Array.isArray(window.CLEANED_SESSIONS) && window.CLEANED_SESSIONS.length) {
      setSessions(window.CLEANED_SESSIONS, {
        filename: "sessions_sample100.js",
        sessions: window.CLEANED_SESSIONS.length,
        mode: "js-global",
      });
      return;
    }
    setLoadBanner("尚未载入数据。请确认 data/cleaned/sessions.jsonl 可通过 HTTP 访问，或用文件选择器导入。");
    render();
  }

  function bind() {
    $("annotator").onchange = (ev) => {
      state.annotator = ev.target.value || "A";
      localStorage.setItem("ir02.annotator", state.annotator);
      loadLabels();
      render();
    };
    if ($("work-scope")) {
      $("work-scope").value = state.workScope;
      $("work-scope").onchange = (ev) => {
        state.workScope = normalizeWorkScope(ev.target.value || "mine");
        localStorage.setItem("ir02.workScope", state.workScope);
        render({ scrollCurrent: true });
      };
    }
    $("filter").onchange = (ev) => {
      state.filter = ev.target.value;
      render();
    };
    $("search").oninput = (ev) => {
      state.search = ev.target.value || "";
      renderSessionList();
    };
    $("hide-nonuser").onchange = (ev) => {
      state.hideNonUser = !!ev.target.checked;
      renderThread({ scrollCurrent: true });
    };
    if ($("focus-current")) {
      $("focus-current").checked = state.focusCurrent;
      $("focus-current").onchange = (ev) => {
        state.focusCurrent = !!ev.target.checked;
        localStorage.setItem("ir02.focusCurrent", state.focusCurrent ? "1" : "0");
        renderThread({ scrollCurrent: true });
      };
    }
    $("render-math").checked = state.renderMath;
    $("render-math").onchange = (ev) => {
      state.renderMath = !!ev.target.checked;
      localStorage.setItem("ir02.renderMath", state.renderMath ? "1" : "0");
      renderThread({ scrollCurrent: true });
    };
    $("prev-session").onclick = () => goSession(-1);
    $("next-session").onclick = () => goSession(1);
    $("prev-prompt").onclick = () => goPrompt(-1);
    $("next-prompt").onclick = () => goPrompt(1);
    $("next-unlabeled").onclick = nextUnlabeled;
    $("export-xlsx").onclick = exportExcel;
    $("export-jsonl").onclick = exportJsonl;
    $("export-labels").onclick = exportLabelsState;
    if ($("reload-all")) {
      $("reload-all").onclick = async () => {
        try {
          await loadDefaultBundle();
          const n = state.sessions.length;
          const p = state.sessions.reduce((a, s) => a + labelableTurns(s).length, 0);
          alert(`全库已加载：${n} 会话 · ${p} 条 User prompt`);
        } catch (e) {
          alert("加载全库失败：" + e.message);
        }
      };
    }
    $("import-labels").onclick = () => $("labels-file").click();
    $("labels-file").onchange = async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const text = (await file.text()).replace(/^\uFEFF/, "").trim();
        if (!text) throw new Error("文件为空");
        let obj;
        if (text.startsWith("[")) {
          obj = JSON.parse(text);
        } else if (text.startsWith("{")) {
          // single JSON object, or JSONL of result rows
          const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          if (lines.length > 1 && lines.every((l) => l.startsWith("{"))) {
            try {
              const rows = lines.map((l) => JSON.parse(l));
              if (rows.every((r) => r && r.turn_id && r.intention)) obj = rows;
              else obj = JSON.parse(text);
            } catch {
              obj = JSON.parse(text);
            }
          } else {
            obj = JSON.parse(text);
          }
        } else {
          throw new Error("无法识别的标注文件格式");
        }
        importLabelsState(obj);
      } catch (e) {
        alert("无法解析标注文件：" + e.message);
      }
      ev.target.value = "";
    };
    $("file").onchange = async (ev) => {
      const files = [...(ev.target.files || [])];
      if (!files.length) return;
      const all = [];
      const reports = [];
      let errors = 0;
      for (const file of files) {
        try {
          const text = await file.text();
          const { sessions, report } = parseLoadedText(text, file.name);
          all.push(...sessions);
          reports.push(report);
        } catch (e) {
          errors += 1;
          reports.push({ filename: file.name, error: e.message });
        }
      }
      setSessions(all, { files: reports });
      const sessionsN = state.sessions.length;
      const promptsN = state.sessions.reduce((n, s) => n + labelableTurns(s).length, 0);
      const turnsN = state.sessions.reduce((n, s) => n + (s.turns?.length || 0), 0);
      const skipped = reports.reduce((n, r) => n + (r.skipped_lines || 0), 0);
      const empty = reports.reduce((n, r) => n + (r.empty_sessions || 0), 0);
      alert(
        `会话导入完成：${sessionsN} 会话 · ${promptsN} 条 User prompt · ${turnsN} 回合` +
          (skipped ? ` · 跳过坏行 ${skipped}` : "") +
          (empty ? ` · 无标注目标会话 ${empty}` : "") +
          (errors ? ` · 失败文件 ${errors}` : "")
      );
    };
    document.addEventListener("keydown", (ev) => {
      if (ev.target.matches("textarea, input, select")) return;
      if (ev.key >= "1" && ev.key <= "4") {
        const id = TAXONOMY[Number(ev.key) - 1]?.id;
        const radio = $("label-panel")?.querySelector(`input[name="intention"][value="${id}"]`);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change"));
        }
      }
      if (ev.key === "s" || ev.key === "S") {
        const picked = $("label-panel")?.querySelector('input[name="intention"]:checked');
        commitLabel(picked?.value, true);
      }
      if (ev.key === "ArrowLeft") goPrompt(-1);
      if (ev.key === "ArrowRight") goPrompt(1);
      if (ev.key === "u" || ev.key === "U") nextUnlabeled();
      if (ev.key === "[") goSession(-1);
      if (ev.key === "]") goSession(1);
    });
  }

  loadLabels();
  bind();
  loadDefaultBundle();
})();
