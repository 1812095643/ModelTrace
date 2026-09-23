const byId = (id) => document.getElementById(id);
const emptyModels = byId("auto-model-list").innerHTML;
const emptyProcess = byId("auto-run-detail").innerHTML;
const protocolNames = { openai: "OpenAI · Chat Completions", responses: "OpenAI · Responses", anthropic: "Claude 原生 · Messages" };
const state = {
  models: [], references: [], loading: false, running: false,
  selectedId: null, currentId: null, follow: true,
  queue: [], finished: 0, controller: null, connectionUsed: false,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function message(id, text, tone = "") {
  const element = byId(id);
  element.textContent = text;
  element.dataset.tone = tone;
  element.hidden = !text;
}

function modelById(id) {
  return state.models.find((model) => model.id === id);
}

function knownModel(id) {
  return state.references.some((model) => model.id === id);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime(seconds) {
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : seconds < 60 ? `${Math.floor(seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}

function stateLabel(status) {
  return ({ queued: "排队中", running: "测试中", done: "已完成", partial: "部分完成", error: "未完成", stopped: "已停止" })[status] || "待测试";
}

function updateControls() {
  const selected = state.models.filter((model) => model.selected).length;
  const busy = state.running || state.loading;
  byId("auto-connection-fields").disabled = busy;
  byId("auto-manual-model").disabled = busy;
  byId("auto-add-model").disabled = busy;
  byId("auto-select-all").disabled = busy || !state.models.length;
  byId("auto-select-all").checked = !!state.models.length && selected === state.models.length;
  byId("auto-select-all").indeterminate = selected > 0 && selected < state.models.length;
  byId("auto-clear-selection").disabled = busy || !selected;
  byId("auto-selection-count").textContent = `已选 ${selected} / ${state.models.length}`;
  byId("auto-run-selected").textContent = `批量测试（${selected}）`;
  byId("auto-run-selected").disabled = busy || !selected;
  byId("auto-stop").hidden = !state.running;
  byId("auto-stop").disabled = !state.running || !!state.controller?.signal.aborted;
  byId("auto-load-models").textContent = state.loading ? "正在读取…" : "读取模型列表 ↗";
}

function renderModels() {
  const busy = state.running || state.loading;
  byId("auto-model-list").innerHTML = state.models.length ? state.models.map((model) => {
    const run = model.run;
    const description = run?.result
      ? `最接近 <strong>${escapeHtml(run.result.prediction_name)}</strong> · ${formatPercent(run.result.probability)} · 有效 ${run.result.used_outputs}/3`
      : run?.error ? escapeHtml(run.error) : run ? `${stateLabel(run.status)}${run.status === "running" ? ` · 有效 ${run.probes.filter((probe) => probe.accepted).length}/3` : ""}` : "";
    return `<article class="model-row ${state.selectedId === model.id ? "is-viewed" : ""} ${run?.status === "running" ? "is-running" : ""}" data-model-id="${escapeHtml(model.id)}">
      <label class="model-label"><input type="checkbox" data-model-check="${escapeHtml(model.id)}" aria-label="勾选 ${escapeHtml(model.id)}" ${model.selected ? "checked" : ""} ${busy ? "disabled" : ""}>
        <span class="model-identity"><strong class="model-name">${escapeHtml(model.id)}</strong><span class="model-meta"><span>${model.family === "claude" ? "Claude" : model.family === "gpt" ? "GPT" : "自定义别名"}</span><span class="${knownModel(model.id) ? "known" : ""}">${knownModel(model.id) ? "指纹已收录" : "指纹未收录"}</span>${model.manual ? "<span>手动添加</span>" : ""}</span></span>
      </label>
      <div class="model-controls"><button type="button" class="text-button" data-action="test" ${busy ? "disabled" : ""} aria-label="测试 ${escapeHtml(model.id)}">${run ? "重测" : "测试"}</button>${run ? '<button type="button" class="text-button" data-action="inspect">过程</button>' : ""}${model.manual && !busy ? '<button type="button" class="text-button" data-action="remove" aria-label="移除手动添加的模型">×</button>' : ""}</div>
      ${description ? `<div class="model-result" data-tone="${run?.error && !run.result ? "error" : ""}">${description}</div>` : ""}
    </article>`;
  }).join("") : emptyModels;
  updateControls();
}

function renderProgress() {
  byId("auto-batch-progress").hidden = !state.queue.length;
  const stopped = state.queue.some((id) => modelById(id)?.run?.status === "stopped");
  byId("auto-batch-label").textContent = `${state.running ? "正在测试" : stopped ? "已停止" : "测试结束"} · 已处理 ${state.finished} / ${state.queue.length} 个模型`;
  byId("auto-batch-meter").max = state.queue.length || 1;
  byId("auto-batch-meter").value = state.finished;
  byId("auto-follow").hidden = !state.running || state.selectedId === state.currentId;
}

function probeLabel(probe) {
  return ({ waiting: "等待发送", running: "并发接收中", done: `有效 · ${probe.parsed_numbers || 0} 个数字`, invalid: `数字不足 · ${probe.parsed_numbers || 0} 个`, error: "未完成", stopped: "已停止", skipped: "未发送" })[probe.status];
}

function probeMarkup(probe, index) {
  return `<details class="probe" data-probe-index="${index}" data-state="${probe.status}" ${!["waiting", "skipped"].includes(probe.status) ? "open" : ""}>
    <summary><strong>${index < 3 ? `挑战 ${index + 1}` : `补充挑战 ${index - 2}`}</strong><span class="probe-status">${probeLabel(probe)}</span></summary>
    <div class="probe-body"><details class="probe-prompt"><summary>查看本次提示词 · 目标 ${probe.expected_count} 个数字</summary><pre>${escapeHtml(probe.prompt)}</pre></details>
      <label for="live-output-${index}">AI 完整回复</label><textarea id="live-output-${index}" readonly spellcheck="false" placeholder="模型回复会自动填入这里，无需复制粘贴。">${escapeHtml(probe.text)}</textarea>
      <div class="probe-caption"><p>${probeCaption(probe)}</p><button type="button" class="text-button" data-copy-probe="${index}" ${probe.text ? "" : "disabled"}>复制回复</button></div>
      <ol class="probe-log">${logMarkup(probe)}</ol>
    </div></details>`;
}

function probeCaption(probe) {
  return `${probe.text.length} 字符${probe.elapsed_seconds !== undefined ? ` · ${formatTime(probe.elapsed_seconds)}` : ""}${probe.response_model ? ` · 上游返回名称：${escapeHtml(probe.response_model)}` : ""}`;
}

function logMarkup(probe) {
  return probe.logs.map((entry) => `<li><time>${entry.time}</time>${escapeHtml(entry.message)}</li>`).join("");
}

function verdictMarkup(model) {
  const result = model.run?.result;
  if (!result) return "";
  return `<section class="run-verdict"><p class="verdict-title">最接近的已收录模型 · 候选库内概率</p><div class="verdict-main"><strong>${escapeHtml(result.prediction_name)}</strong><span>${formatPercent(result.probability)}</span></div>
    <p class="verdict-note">有效回复 ${result.used_outputs}/3 · ${formatTime(model.run.elapsed)} · ${escapeHtml(result.family_prediction_name)} 家族 ${formatPercent(result.family_probability)}${result.used_outputs < 3 ? "<br>有效回复不足三份，建议重新测试后再比较。" : ""}${!knownModel(model.id) ? "<br>请求模型名未被指纹库收录，以上结果仅用于比较相似程度。" : ""}</p>
    <details><summary>查看全部 ${result.results.length} 个候选的排名</summary><div class="table-wrap"><table><thead><tr><th>候选模型</th><th>库内概率</th><th>分布相似度</th></tr></thead><tbody>${result.results.map((item) => `<tr><td>${escapeHtml(item.display_name)}</td><td>${formatPercent(item.probability)}</td><td>${formatPercent(item.profile_similarity)}</td></tr>`).join("")}</tbody></table></div></details>
    <p class="verdict-note">概率只在当前候选库内比较，不是模型身份的确定证明。</p></section>`;
}

function renderDetail() {
  const model = modelById(state.selectedId);
  byId("auto-detail-title").textContent = model ? model.id : "测试全过程";
  byId("auto-detail-title").style.overflowWrap = "anywhere";
  byId("auto-detail-subtitle").textContent = model?.run ? `独立发起每次挑战 · ${stateLabel(model.run.status)}` : "提示词、AI 回复和归因结果都在这里。";
  const activeProbes = model?.run?.probes.filter((probe) => probe.status === "running").length || 0;
  const validProbes = model?.run?.probes.filter((probe) => probe.accepted).length || 0;
  byId("auto-run-state").textContent = activeProbes
    ? `${activeProbes} 个挑战并发中 · 有效 ${validProbes}/3`
    : stateLabel(model?.run?.status);
  byId("auto-run-state").dataset.state = model?.run?.status || "idle";
  if (!model?.run) {
    byId("auto-run-detail").innerHTML = emptyProcess;
  } else {
    byId("auto-run-detail").innerHTML = `${model.run.error ? `<p class="inline-message" data-tone="error">${escapeHtml(model.run.error)}</p>` : ""}
      <div class="probe-list">${model.run.probes.map(probeMarkup).join("")}</div>${verdictMarkup(model)}`;
    if (!model.run.probes.length) {
      byId("auto-run-detail").innerHTML = `<div class="empty-process"><h3>${model.run.status === "queued" ? "已加入测试队列" : "尚未发送挑战"}</h3><p>${escapeHtml(model.run.error || "前面的模型完成后会自动开始。")}</p></div>`;
    }
  }
  renderProgress();
}

function updateProbeState(model, probe) {
  if (model.id === state.selectedId) {
    const index = model.run.probes.indexOf(probe);
    const element = byId("auto-run-detail").querySelector(`[data-probe-index="${index}"]`);
    if (element) {
      element.dataset.state = probe.status;
      element.querySelector(".probe-status").textContent = probeLabel(probe);
      if (probe.status === "running") element.open = true;
    }
    const active = model.run.probes.filter((item) => item.status === "running").length;
    const accepted = model.run.probes.filter((item) => item.accepted).length;
    byId("auto-run-state").textContent = active
      ? `${active} 个挑战并发中 · 有效 ${accepted}/3`
      : stateLabel(model.run.status);
  }
  renderModels();
}

function logProbe(model, probe, text) {
  probe.logs.push({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), message: text });
  if (model.id !== state.selectedId) return;
  const index = model.run.probes.indexOf(probe);
  const element = byId("auto-run-detail").querySelector(`[data-probe-index="${index}"]`);
  if (element) element.querySelector(".probe-log").innerHTML = logMarkup(probe);
}

function updateProbeText(model, probe) {
  if (model.id !== state.selectedId) return;
  const index = model.run.probes.indexOf(probe);
  const element = byId("auto-run-detail").querySelector(`[data-probe-index="${index}"]`);
  if (!element) return;
  const textarea = element.querySelector("textarea");
  const atEnd = textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight < 48;
  textarea.value = probe.text;
  if (atEnd) textarea.scrollTop = textarea.scrollHeight;
  element.querySelector(".probe-caption p").innerHTML = probeCaption(probe);
  element.querySelector("[data-copy-probe]").disabled = !probe.text;
}

async function readJson(url, payload, signal) {
  const response = await fetch(url, payload === undefined ? { signal } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal,
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`本地服务没有返回可用数据（HTTP ${response.status}），请检查服务是否仍在运行。`); }
  if (!response.ok) {
    const error = new Error(data.error || `请求未完成（HTTP ${response.status}）。`);
    error.status = data.upstream_status || response.status;
    throw error;
  }
  return data;
}

function connectionValues() {
  const baseUrl = byId("auto-base-url").value.trim();
  let apiFormat = byId("auto-protocol").value;
  if (apiFormat === "auto") {
    try {
      const path = new URL(baseUrl).pathname.replace(/\/+$/, "");
      const endpoint = Object.entries({ responses: "/responses", openai: "/chat/completions", anthropic: "/messages" }).find(([, suffix]) => path.endsWith(suffix));
      if (endpoint) apiFormat = endpoint[0];
    } catch {}
  }
  return {
    base_url: baseUrl, api_key: byId("auto-api-key").value.trim(),
    api_format: apiFormat,
    temperature: byId("auto-temperature").value === "" ? null : Number(byId("auto-temperature").value),
  };
}

async function loadModels(event) {
  event.preventDefault();
  if (state.loading || state.running) return;
  const settings = connectionValues();
  state.loading = true;
  state.connectionUsed = true;
  message("auto-connection-message", "正在请求 /models，读取模型列表…", "working");
  renderModels();
  try {
    const payload = await readJson("/api/models", settings);
    const previous = new Map(state.models.map((model) => [model.id, model]));
    const incoming = payload.models.map((model) => previous.get(model.id) || { ...model, selected: true, manual: false, run: null });
    const incomingIds = new Set(incoming.map((model) => model.id));
    state.models = [...incoming, ...state.models.filter((model) => model.manual && !incomingIds.has(model.id))];
    if (!modelById(state.selectedId)) state.selectedId = null;
    byId("auto-base-url").value = payload.base_url;
    if (byId("auto-protocol").value === "auto" && settings.api_format !== "auto") byId("auto-protocol").value = settings.api_format;
    message("auto-connection-message", `已读取 ${payload.total_count} 个模型，显示 ${payload.models.length} 个 GPT / Claude 文字模型${payload.filtered_count ? `，已过滤 ${payload.filtered_count} 个其他类型` : ""}。${payload.models.length ? "已默认勾选新增模型，可按需调整。" : "可以手动添加服务商提供的模型名或别名。"}`, "success");
  } catch (error) {
    message("auto-connection-message", `${error.message} 也可以手动添加模型名。`, "error");
  } finally {
    state.loading = false;
    renderModels();
    renderDetail();
  }
}

function addModel(event) {
  event.preventDefault();
  if (state.loading || state.running) return;
  const id = byId("auto-manual-model").value.trim();
  if (!id || id.length > 256 || /[\x00-\x1f]/.test(id)) {
    message("auto-add-message", "请填写有效模型名，不要包含换行。", "error");
    return;
  }
  const existing = modelById(id);
  if (existing) existing.selected = true;
  else state.models.push({ id, family: /claude/i.test(id) ? "claude" : /gpt/i.test(id) ? "gpt" : null, manual: true, selected: true, run: null });
  byId("auto-manual-model").value = "";
  message("auto-add-message", existing ? `已勾选 ${id}，没有重复添加。` : `已添加并勾选 ${id}。`, "success");
  renderModels();
}

async function receiveProbe(model, probe, settings, signal) {
  const response = await fetch("/api/test/stream", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ ...settings, api_model: model.id, prompt: probe.prompt, expected_count: probe.expected_count }),
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error || `请求未完成（HTTP ${response.status}）。`);
  }
  if (!response.body) throw new Error("浏览器无法读取流式回复，请更新浏览器后重试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  function consume(line) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "delta") {
      probe.text += event.text;
      updateProbeText(model, probe);
    } else if (event.type === "snapshot") {
      probe.text = event.text;
      updateProbeText(model, probe);
    } else if (event.type === "request") {
      probe.api_format = event.api_format;
      logProbe(model, probe, `${protocolNames[event.api_format] || event.api_format} · POST ${event.endpoint}`);
      logProbe(model, probe, event.message);
    } else if (event.type === "status") {
      logProbe(model, probe, event.message);
    } else if (event.type === "complete") {
      Object.assign(probe, event);
      completed = true;
      updateProbeText(model, probe);
    } else if (event.type === "error") {
      const error = new Error(event.message);
      error.status = event.status;
      throw error;
    }
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) consume(line);
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!completed) throw new Error("连接提前结束，已保留收到的内容；请重新测试。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function runModel(model, settings, signal) {
  const run = model.run;
  const started = performance.now();
  run.status = "running";
  state.currentId = model.id;
  if (state.follow) state.selectedId = model.id;
  renderModels();
  renderDetail();
  let stopBatch = false;
  try {
    const sets = await Promise.all([readJson("/api/challenges", undefined, signal), readJson("/api/challenges", undefined, signal)]);
    const challenges = sets.flatMap((set) => set.challenges);
    run.probes = challenges.slice(0, 3).map((challenge) => ({ ...challenge, text: "", logs: [], status: "running", accepted: false }));
    renderModels();
    renderDetail();

    async function executeProbe(index) {
      const probe = run.probes[index];
      if (signal.aborted) {
        probe.status = "stopped";
        updateProbeState(model, probe);
        return;
      }
      try {
        await receiveProbe(model, probe, settings, signal);
        probe.status = probe.accepted ? "done" : "invalid";
        logProbe(model, probe, probe.accepted ? `回复完成，${probe.parsed_numbers} 个有效数字，计入归因。` : `仅收到 ${probe.parsed_numbers} 个有效数字，至少需要 ${probe.minimum_numbers} 个；将尝试补充挑战。`);
      } catch (error) {
        probe.status = signal.aborted ? "stopped" : "error";
        probe.accepted = false;
        if (!signal.aborted) {
          logProbe(model, probe, error.message);
          run.error = run.error || error.message;
          stopBatch ||= [401, 429].includes(error.status);
        }
      }
      updateProbeState(model, probe);
    }

    // 首轮三题并发发送；后续只并发补足还缺少的有效回答。
    await Promise.all([0, 1, 2].map(executeProbe));
    let nextChallenge = 3;
    while (!signal.aborted && !stopBatch && run.probes.filter((probe) => probe.accepted).length < 3 && nextChallenge < challenges.length) {
      const deficit = 3 - run.probes.filter((probe) => probe.accepted).length;
      const indexes = Array.from({ length: Math.min(deficit, challenges.length - nextChallenge) }, (_, offset) => nextChallenge + offset);
      nextChallenge += indexes.length;
      run.probes.push(...indexes.map((index) => ({ ...challenges[index], text: "", logs: [], status: "running", accepted: false })));
      renderModels();
      renderDetail();
      await Promise.all(indexes.map((index) => executeProbe(index)));
    }

    const outputs = run.probes.filter((probe) => probe.accepted).map((probe) => ({ text: probe.text, expected_count: probe.expected_count }));
    if (outputs.length) {
      run.result = await readJson("/api/analyze", { outputs });
      run.status = signal.aborted ? "stopped" : outputs.length === 3 ? "done" : "partial";
      if (signal.aborted) run.error = "已停止后续测试，已完成的有效回复和归因结果已保留。";
      if (outputs.length < 3 && !run.error) run.error = "未能收集到三份有效回复，当前结果仅使用已完成的有效回答。";
    } else {
      run.status = signal.aborted ? "stopped" : "error";
      run.error ||= signal.aborted ? "已停止后续测试，保留本次已收到的内容。" : "没有收集到可用回复，请检查模型输出后重试。";
    }
  } catch (error) {
    run.status = signal.aborted ? "stopped" : "error";
    run.error = signal.aborted ? "已停止后续测试，保留本次已收到的内容。" : error.message;
  } finally {
    run.elapsed = (performance.now() - started) / 1000;
    run.probes.forEach((probe) => { if (["waiting", "running"].includes(probe.status)) probe.status = "skipped"; });
    renderModels();
    if (model.id === state.selectedId) renderDetail();
  }
  return stopBatch;
}

async function startTests(ids) {
  if (state.running || state.loading || !ids.length) return;
  if (!byId("auto-connect-form").reportValidity()) return;
  const settings = connectionValues();
  state.running = true;
  state.connectionUsed = true;
  state.queue = ids.slice();
  state.finished = 0;
  state.follow = true;
  state.controller = new AbortController();
  const { signal } = state.controller;
  ids.forEach((id) => { modelById(id).run = { status: "queued", probes: [], result: null, error: "", elapsed: 0 }; });
  message("auto-run-message", "");
  renderModels();
  renderProgress();
  try {
    for (const id of ids) {
      if (signal.aborted) break;
      const stopBatch = await runModel(modelById(id), settings, signal);
      state.finished++;
      renderProgress();
      if (stopBatch) {
        message("auto-run-message", "接口需要检查 Key 或额度，已停止后续排队。修正后可重新勾选并测试。", "error");
        break;
      }
    }
  } finally {
    ids.forEach((id) => { const run = modelById(id).run; if (run.status === "queued") run.status = "stopped"; });
    state.running = false;
    state.currentId = null;
    state.controller = null;
    renderModels();
    renderProgress();
    renderDetail();
  }
}

async function loadReferences() {
  try {
    const payload = await readJson("/api/reference-models");
    state.references = payload.models;
    byId("reference-count").textContent = `${payload.models.length} 个候选模型 · ${payload.models.reduce((sum, model) => sum + model.response_count, 0)} 条指纹`;
    const families = [...new Set(payload.models.map((model) => model.family))];
    byId("reference-model-list").innerHTML = families.map((family) => {
      const models = payload.models.filter((model) => model.family === family);
      return `<div class="reference-family"><h3>${escapeHtml(models[0].family_name || family)}</h3><div>${models.map((model) => `<code>${escapeHtml(model.id)}</code>`).join("")}</div></div>`;
    }).join("");
    renderModels();
  } catch (error) {
    byId("reference-model-list").textContent = `暂时无法读取指纹库：${error.message}`;
  }
}

byId("auto-connect-form").addEventListener("submit", loadModels);
byId("auto-add-form").addEventListener("submit", addModel);
byId("auto-select-all").addEventListener("change", (event) => {
  state.models.forEach((model) => { model.selected = event.target.checked; });
  renderModels();
});
byId("auto-clear-selection").addEventListener("click", () => {
  state.models.forEach((model) => { model.selected = false; });
  renderModels();
});
byId("auto-model-list").addEventListener("change", (event) => {
  if (!event.target.matches("[data-model-check]") || state.running) return;
  modelById(event.target.dataset.modelCheck).selected = event.target.checked;
  updateControls();
});
byId("auto-model-list").addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action || action.disabled) return;
  const id = action.closest("[data-model-id]").dataset.modelId;
  if (action.dataset.action === "test") startTests([id]);
  if (action.dataset.action === "inspect") {
    state.selectedId = id;
    state.follow = id === state.currentId;
    renderModels();
    renderDetail();
  }
  if (action.dataset.action === "remove" && !state.running) {
    state.models = state.models.filter((model) => model.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    renderModels();
    renderDetail();
  }
});
byId("auto-run-selected").addEventListener("click", () => startTests(state.models.filter((model) => model.selected).map((model) => model.id)));
byId("auto-stop").addEventListener("click", () => {
  state.controller?.abort();
  byId("auto-stop").disabled = true;
  message("auto-run-message", "已停止后续测试。已发送的请求可能仍由服务商继续处理，已收到的内容会保留。", "working");
});
byId("auto-follow").addEventListener("click", () => {
  state.follow = true;
  state.selectedId = state.currentId;
  renderModels();
  renderDetail();
});
byId("auto-run-detail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-probe]");
  if (!button) return;
  const probe = modelById(state.selectedId)?.run?.probes[Number(button.dataset.copyProbe)];
  if (!probe?.text) return;
  try {
    await navigator.clipboard.writeText(probe.text);
    button.textContent = "已复制";
    window.setTimeout(() => { button.textContent = "复制回复"; }, 1200);
  } catch {
    message("auto-run-message", "暂时无法访问剪贴板，可以选中回复框内的文字手动复制。", "error");
  }
});
["auto-base-url", "auto-api-key"].forEach((id) => byId(id).addEventListener("input", () => {
  if (!state.connectionUsed) return;
  state.models = state.models.filter((model) => model.manual).map((model) => ({ ...model, run: null }));
  state.selectedId = null;
  state.queue = [];
  state.connectionUsed = false;
  message("auto-connection-message", "连接信息已修改，请重新读取模型列表；手动添加的模型仍可测试。");
  message("auto-run-message", "");
  renderModels();
  renderDetail();
}));
window.addEventListener("reference-bank-updated", loadReferences);
updateControls();
loadReferences();
