(() => {
  const TAXONOMY = window.IR02_TAXONOMY || [];
  const STORE_PREFIX = "ir02.annot.v1:";
  const LABEL_FORMAT = "ir02.labels.v2";

  function defaultMachineId() {
    const saved = localStorage.getItem("ir02.machineId");
    if (saved) return saved;
    const seed = Math.random().toString(36).slice(2, 6);
    const id = `pc-${seed}`;
    localStorage.setItem("ir02.machineId", id);
    return id;
  }

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

  const state = {
    sessions: [],
    sessionIndex: 0,
    promptIndex: 0,
    annotator: localStorage.getItem("ir02.annotator") || "A",
    machineId: defaultMachineId(),
    workScope: localStorage.getItem("ir02.workScope") || "mine", // mine | all | other
    labels: {},
    peerLabels: {},
    peerMeta: null,
    lastDisagree: [],
    filter: "all", // all | unlabeled | labeled
    hideNonUser: false,
    focusCurrent: localStorage.getItem("ir02.focusCurrent") !== "0",
    search: "",
    renderMath: localStorage.getItem("ir02.renderMath") !== "0",
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

  function peerOf(annotator) {
    if (annotator === "A") return "B";
    if (annotator === "B") return "A";
    return "A";
  }

  function inWorkScope(session) {
    if (!session) return false;
    if (state.annotator === "gold" || state.workScope === "all") return true;
    const owner = sessionOwner(session.session_id);
    if (state.workScope === "mine") return owner === state.annotator;
    if (state.workScope === "other") return owner === peerOf(state.annotator);
    return true;
  }

  function scopeReadOnly() {
    return state.workScope === "other" && state.annotator !== "gold";
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
            if (/^###\s+/.test(line)) return `<h3>${inlineMd(line.replace(/^###\s+/, ""))}</h3>`;
            if (/^##\s+/.test(line)) return `<h2>${inlineMd(line.replace(/^##\s+/, ""))}</h2>`;
            if (/^#\s+/.test(line)) return `<h1>${inlineMd(line.replace(/^#\s+/, ""))}</h1>`;
            if (/^---+$/.test(line.trim())) return "<hr>";
            if (/^[-*]\s+/.test(line)) return `<li>${inlineMd(line.replace(/^[-*]\s+/, ""))}</li>`;
            if (/^\d+\.\s+/.test(line)) return `<li>${inlineMd(line.replace(/^\d+\.\s+/, ""))}</li>`;
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
    // Use local escaping renderer (not marked HTML passthrough).
    // Agent transcripts often contain <u64>, </div>, raw tags that break thread DOM.
    const html = fallbackMarkdown(raw);
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

  function parseLoadedText(text, filename = "upload") {
    const trimmed = text.trim();
    if (!trimmed) return [];
    // JS bundle: window.CLEANED_SESSIONS = ...
    if (trimmed.includes("CLEANED_SESSIONS")) {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`${trimmed}; return window.CLEANED_SESSIONS || CLEANED_SESSIONS;`);
      const arr = fn();
      return Array.isArray(arr) ? arr : [];
    }
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [];
    }
    // JSONL: either session objects or flat conversation rows
    const rows = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* skip */
      }
    }
    if (!rows.length) throw new Error("未解析到 JSON/JSONL 对象");
    if (rows[0].turns || rows[0].messages) return rows.map(normalizeSession);
    return groupFlatRows(rows, filename);
  }

  function normalizeSession(obj, source = "") {
    const sid = String(obj.session_id || obj.id || source || "session");
    const raw = obj.turns || obj.messages || [];
    const turns = raw.map((row, idx) => ({
      turn_id: String(row.turn_id || `${sid}#${idx}`),
      turn_number: typeof row.turn_number === "number" ? row.turn_number : idx,
      role: String(row.role || "system").toLowerCase(),
      turn_type: String(row.turn_type || row.type || ""),
      is_conversational: row.is_conversational,
      content: String(row.content || row.text || ""),
    }));
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
      out.push(
        normalizeSession(
          {
            session_id: sid,
            source_file: filename,
            turns: items.map((row, idx) => ({
              turn_id: row.turn_id || `${sid}#${idx}`,
              turn_number: typeof row.turn_number === "number" ? row.turn_number : idx,
              role: row.role || (String(row.turn_type || "").includes("user") ? "user" : "assistant"),
              turn_type: row.turn_type || row.type || "",
              is_conversational: row.is_conversational,
              content: row.content || row.text || "",
            })),
          },
          filename
        )
      );
    }
    return out;
  }

  function setSessions(sessions) {
    state.sessions = (sessions || [])
      .map((s) => normalizeSession(s, s.source_file || ""))
      .filter((s) => labelableTurns(s).length > 0);
    state.sessionIndex = 0;
    state.promptIndex = 0;
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
      machine_id: state.machineId,
      session_id: session?.session_id,
      prompt_preview: String(prompt.content || "").slice(0, 200),
      labeled_at: new Date().toISOString(),
    };
    saveLabels();
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
          <div class="title">${esc(s.session_id)}</div>
          <div class="meta">
            <span class="badge">${esc(owner)}</span>
            <span class="badge ${done ? "ok" : "miss"}">${labeled}/${prompts.length}</span>
            · ${esc((s.source_file || "").split(/[/\\\\]/).pop() || "local")}
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
          <div class="title">#${i + 1} <span class="badge ${lab?.intention ? "ok" : "miss"}">${lab?.intention || "未标"}</span></div>
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
        <span class="state-main">
          <b>${t.key} ${t.name}</b>
          <small>${esc(t.core)}</small>
        </span>
      </label>`;
      }
    ).join("");

    const ro = scopeReadOnly();
    $("label-panel").innerHTML = `
      ${ro ? '<div class="empty" style="margin-bottom:8px">对方分片只读：可浏览，不可写入。</div>' : ""}
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
    let rendered = 0;
    for (const turn of turns) {
      if (state.hideNonUser && turn.role !== "user") continue;
      const role = turn.role || "system";
      const isCurrent = current && turn.turn_id === current.turn_id;
      // Focus mode: mount only the current user prompt so the pane shows its full text.
      if (state.focusCurrent && !isCurrent) continue;
      const lab = role === "user" ? labelOf(turn.turn_id) : null;

      const bubble = document.createElement("div");
      bubble.className = `bubble ${role}${isCurrent ? " current" : ""}`;
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
    const st = stats();
    const session = currentSession();
    const prompts = currentPrompts();
    const scopeHint =
      state.workScope === "mine"
        ? "我的分片"
        : state.workScope === "other"
          ? "对方分片(只读)"
          : "全部分片";
    $("status").textContent =
      `标注员 ${state.annotator} · 机器 ${state.machineId} · ${scopeHint}` +
      ` · 任务内 ${st.scopeLabeled}/${st.scopePrompts}（会话 ${st.scopeSessions}）` +
      ` · 全库 ${st.labeled}/${st.prompts}` +
      ` · ${state.renderMath ? "渲染开" : "渲染关"}`;
    const owner = session ? sessionOwner(session.session_id) : "";
    $("progress").textContent = session
      ? `分片${owner} · 会话 ${state.sessionIndex + 1}/${state.sessions.length} · prompt ${prompts.length ? state.promptIndex + 1 : 0}/${prompts.length} · ${session.session_id}`
      : "未载入";
    if ($("annotator")) $("annotator").value = state.annotator;
    if ($("machine-id")) $("machine-id").value = state.machineId;
    if ($("work-scope")) $("work-scope").value = state.workScope;
    if ($("filter")) $("filter").value = state.filter;
    if ($("hide-nonuser")) $("hide-nonuser").checked = state.hideNonUser;
    renderCollabBar(st);
  }

  function renderCollabBar(st) {
    const el = $("collab-summary");
    if (!el) return;
    const peerN = Object.keys(state.peerLabels || {}).length;
    const peerInfo = state.peerMeta
      ? `对方包：${state.peerMeta.annotator || "?"}@${state.peerMeta.machine_id || "?"} · ${peerN} 条`
      : "尚未导入对方标注";
    el.textContent =
      `双人双机 · A/B 按 session 稳定分片 · 当前任务 ${st.scopeLabeled}/${st.scopePrompts} · ${peerInfo}` +
      (scopeReadOnly() ? " · 只读浏览中" : "");
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

  function exportExcel() {
    if (typeof XLSX === "undefined") {
      alert("SheetJS 未加载，改用 CSV 导出");
      exportCsv();
      return;
    }
    const rows = [];
    for (const session of state.sessions) {
      const prompts = labelableTurns(session);
      prompts.forEach((t, i) => {
        const lab = labelOf(t.turn_id) || {};
        rows.push({
          annotator: state.annotator,
          machine_id: state.machineId,
          session_owner: sessionOwner(session.session_id),
          session_id: session.session_id,
          source_file: session.source_file || "",
          prompt_index: i + 1,
          turn_id: t.turn_id,
          turn_number: t.turn_number,
          intention: lab.intention || "",
          uncertain: lab.uncertain ? 1 : 0,
          note: lab.note || "",
          labeled_at: lab.labeled_at || "",
          user_prompt: t.content || "",
        });
      });
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "labels");
    XLSX.writeFile(wb, `${exportFileStem()}.xlsx`);
  }

  function exportCsv() {
    const headers = [
      "annotator",
      "session_id",
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
    for (const session of state.sessions) {
      const prompts = labelableTurns(session);
      prompts.forEach((t, i) => {
        const lab = labelOf(t.turn_id) || {};
        const vals = [
          state.annotator,
          session.session_id,
          session.source_file || "",
          i + 1,
          t.turn_id,
          t.turn_number,
          lab.intention || "",
          lab.uncertain ? 1 : 0,
          lab.note || "",
          lab.labeled_at || "",
          t.content || "",
        ].map(csvEscape);
        lines.push(vals.join(","));
      });
    }
    downloadText(lines.join("\n"), `${exportFileStem()}.csv`, "text/csv");
  }

  function exportJsonl() {
    const lines = [];
    for (const session of state.sessions) {
      for (const t of labelableTurns(session)) {
        const lab = labelOf(t.turn_id);
        if (!lab?.intention) continue;
        lines.push(
          JSON.stringify({
            turn_id: t.turn_id,
            session_id: session.session_id,
            session_owner: sessionOwner(session.session_id),
            annotator: state.annotator,
            machine_id: state.machineId,
            intention: lab.intention,
            uncertain: !!lab.uncertain,
            note: lab.note || "",
            labeled_at: lab.labeled_at,
            user_prompt: t.content,
          })
        );
      }
    }
    downloadText(lines.join("\n") + (lines.length ? "\n" : ""), `${exportFileStem()}.jsonl`, "application/jsonl");
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
    const mid = String(state.machineId || "pc").replace(/[^\w.-]+/g, "_");
    return `ir02_${state.annotator}_${mid}_${stamp()}`;
  }

  function exportLabelsState() {
    const labeledIds = Object.keys(state.labels).filter((id) => state.labels[id]?.intention);
    const payload = {
      format: LABEL_FORMAT,
      // keep v1 readable
      format_legacy: "ir02.labels.v1",
      annotator: state.annotator,
      machine_id: state.machineId,
      work_scope: state.workScope,
      exported_at: new Date().toISOString(),
      label_count: labeledIds.length,
      session_owners: { note: "A/B split = FNV-1a(session_id) % 2" },
      labels: state.labels,
    };
    downloadText(
      JSON.stringify(payload, null, 2),
      `${exportFileStem()}_state.json`,
      "application/json"
    );
    localStorage.setItem("ir02.lastExportAt", payload.exported_at);
  }

  function unwrapLabelPayload(obj) {
    if (
      obj &&
      (obj.format === LABEL_FORMAT || obj.format === "ir02.labels.v1" || obj.format_legacy === "ir02.labels.v1") &&
      obj.labels
    ) {
      return {
        labels: obj.labels,
        meta: {
          annotator: obj.annotator,
          machine_id: obj.machine_id,
          exported_at: obj.exported_at,
          format: obj.format,
        },
      };
    }
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return { labels: obj, meta: {} };
    }
    return null;
  }

  function importLabelsState(obj) {
    const parsed = unwrapLabelPayload(obj);
    if (!parsed) {
      alert("不是有效的标注状态 JSON（需要 ir02.labels.v1/v2 或 turn_id→label 对象）");
      return;
    }
    const { labels: incoming, meta } = parsed;
    if (meta.annotator && meta.annotator !== state.annotator) {
      const ok = confirm(
        `文件标注员为「${meta.annotator}」@${meta.machine_id || "?"}，当前为「${state.annotator}」@${state.machineId}。\n` +
          `将合并进当前槽位（同 turn_id 以文件为准覆盖）。继续？`
      );
      if (!ok) return;
    }
    let added = 0;
    let updated = 0;
    let conflicts = 0;
    for (const [id, lab] of Object.entries(incoming)) {
      if (!lab || typeof lab !== "object") continue;
      const prev = state.labels[id];
      if (
        prev?.intention &&
        lab.intention &&
        prev.intention !== lab.intention
      ) {
        conflicts += 1;
      }
      if (prev?.intention) updated += 1;
      else added += 1;
      state.labels[id] = {
        ...prev,
        ...lab,
        annotator: state.annotator,
        machine_id: lab.machine_id || meta.machine_id || state.machineId,
      };
    }
    saveLabels();
    render({ scrollCurrent: true });
    alert(
      `已合并到标注员 ${state.annotator}：新增 ${added} · 更新 ${updated}` +
        (conflicts ? ` · 意图冲突覆盖 ${conflicts}` : "")
    );
  }

  function importPeerState(obj) {
    const parsed = unwrapLabelPayload(obj);
    if (!parsed) {
      alert("不是有效的对方标注 JSON");
      return;
    }
    state.peerLabels = parsed.labels || {};
    state.peerMeta = parsed.meta || {};
    renderCollabBar(stats());
    const n = Object.values(state.peerLabels).filter((x) => x?.intention).length;
    alert(
      `已载入对方标注 ${n} 条（${state.peerMeta.annotator || "?"}@${state.peerMeta.machine_id || "?"}），` +
        `未改动本机槽位。可点「一致性」对比。`
    );
  }

  function buildAgreementReport() {
    const peer = state.peerLabels || {};
    const both = [];
    const disagree = [];
    let onlyMine = 0;
    let onlyPeer = 0;
    const mineIds = new Set(
      Object.keys(state.labels).filter((id) => state.labels[id]?.intention)
    );
    const peerIds = new Set(Object.keys(peer).filter((id) => peer[id]?.intention));
    for (const id of mineIds) {
      if (!peerIds.has(id)) onlyMine += 1;
      else {
        both.push(id);
        if (state.labels[id].intention !== peer[id].intention) {
          disagree.push({
            turn_id: id,
            mine: state.labels[id].intention,
            peer: peer[id].intention,
            session_id: state.labels[id].session_id || peer[id].session_id || "",
            mine_note: state.labels[id].note || "",
            peer_note: peer[id].note || "",
          });
        }
      }
    }
    for (const id of peerIds) {
      if (!mineIds.has(id)) onlyPeer += 1;
    }
    const agree = both.length - disagree.length;
    const rate = both.length ? agree / both.length : null;
    state.lastDisagree = disagree;
    return {
      both: both.length,
      agree,
      disagree: disagree.length,
      rate,
      onlyMine,
      onlyPeer,
      rows: disagree,
      peerMeta: state.peerMeta,
    };
  }

  function showAgreement() {
    if (!Object.keys(state.peerLabels || {}).length) {
      alert("请先「导入对方(对比)」载入另一台机器导出的标注 JSON。");
      return;
    }
    const r = buildAgreementReport();
    const pct = r.rate == null ? "—" : `${(r.rate * 100).toFixed(1)}%`;
    const lines = [
      `本机：${state.annotator}@${state.machineId}`,
      `对方：${r.peerMeta?.annotator || "?"}@${r.peerMeta?.machine_id || "?"}`,
      `双方都标：${r.both}`,
      `一致：${r.agree}`,
      `分歧：${r.disagree}`,
      `一致率：${pct}`,
      `仅本机：${r.onlyMine} · 仅对方：${r.onlyPeer}`,
      "",
      "分歧样例（最多 30 条）：",
      ...r.rows.slice(0, 30).map(
        (x, i) =>
          `${i + 1}. ${x.turn_id}\n   我=${x.mine}  对方=${x.peer}` +
          (x.session_id ? `\n   session=${x.session_id}` : "")
      ),
    ];
    const body = $("compare-body");
    const dlg = $("compare-dialog");
    if (body) body.textContent = lines.join("\n");
    if (dlg?.showModal) dlg.showModal();
    else alert(lines.join("\n"));
  }

  function exportDisagree() {
    if (!state.lastDisagree?.length) {
      buildAgreementReport();
    }
    if (!state.lastDisagree?.length) {
      alert("没有分歧可导出");
      return;
    }
    const lines = state.lastDisagree.map((x) =>
      JSON.stringify({
        ...x,
        annotator_mine: state.annotator,
        machine_mine: state.machineId,
        annotator_peer: state.peerMeta?.annotator,
        machine_peer: state.peerMeta?.machine_id,
      })
    );
    downloadText(
      lines.join("\n") + "\n",
      `${exportFileStem()}_disagree.jsonl`,
      "application/jsonl"
    );
  }

  function copyHandoff() {
    const text = [
      "IR-02 双人双机交接",
      `1) 我是标注员 ${state.annotator}，机器 ${state.machineId}`,
      "2) 任务范围选「仅我的分片」（A/B 按 session_id 稳定哈希分配，两机一致）",
      "3) 每阶段结束点「导出标注」，把 JSON 放到 labels/ 或发给同伴",
      "4) 同伴用「导入对方(对比)」加载我的文件 → 点「一致性」看一致率",
      "5) 不要用「导入/合并标注」覆盖对方槽位，除非明确要合并到自己",
      "6) gold 槽位留给两人商讨后的共识金标",
    ].join("\n");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => alert("交接说明已复制"),
        () => prompt("请手动复制：", text)
      );
    } else {
      prompt("请手动复制：", text);
    }
  }

  async function loadDefaultBundle() {
    // Prefer small sample first — full sessions.jsonl (~140MB) will freeze the tab.
    const candidates = [
      "../data/cleaned/sessions_sample100.jsonl",
      "../data/cleaned/sessions_sample100.js",
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const text = await res.text();
        const rows = parseLoadedText(text, url.split("/").pop());
        if (rows.length) {
          setSessions(rows);
          return;
        }
      } catch {
        /* file:// or missing */
      }
    }
    if (Array.isArray(window.CLEANED_SESSIONS) && window.CLEANED_SESSIONS.length) {
      setSessions(window.CLEANED_SESSIONS);
      return;
    }
    render();
  }

  function bind() {
    $("annotator").onchange = (ev) => {
      state.annotator = ev.target.value || "A";
      localStorage.setItem("ir02.annotator", state.annotator);
      loadLabels();
      render();
    };
    if ($("machine-id")) {
      $("machine-id").value = state.machineId;
      $("machine-id").onchange = (ev) => {
        const v = String(ev.target.value || "").trim() || defaultMachineId();
        state.machineId = v;
        localStorage.setItem("ir02.machineId", v);
        renderStatus();
      };
    }
    if ($("work-scope")) {
      $("work-scope").value = state.workScope;
      $("work-scope").onchange = (ev) => {
        state.workScope = ev.target.value || "mine";
        localStorage.setItem("ir02.workScope", state.workScope);
        render({ scrollCurrent: true });
      };
    }
    if ($("import-peer")) {
      $("import-peer").onclick = () => $("peer-file")?.click();
    }
    if ($("peer-file")) {
      $("peer-file").onchange = async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          importPeerState(JSON.parse(await file.text()));
        } catch (e) {
          alert("无法解析对方标注 JSON：" + e.message);
        }
        ev.target.value = "";
      };
    }
    if ($("compare-ab")) $("compare-ab").onclick = showAgreement;
    if ($("export-disagree")) $("export-disagree").onclick = exportDisagree;
    if ($("copy-handoff")) $("copy-handoff").onclick = copyHandoff;
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
    $("import-labels").onclick = () => $("labels-file").click();
    $("labels-file").onchange = async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        importLabelsState(JSON.parse(await file.text()));
      } catch (e) {
        alert("无法解析标注 JSON：" + e.message);
      }
      ev.target.value = "";
    };
    $("file").onchange = async (ev) => {
      const files = [...(ev.target.files || [])];
      if (!files.length) return;
      const all = [];
      for (const file of files) {
        const text = await file.text();
        all.push(...parseLoadedText(text, file.name));
      }
      setSessions(all);
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
