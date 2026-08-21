const { generateContent, normalizeGeneratedTitle, answerHtml, cacheKey } = require("./content-engine.cjs");

class TaskRunner {
  constructor(database, getApiKey, notify) {
    this.database = database;
    this.getApiKey = getApiKey;
    this.notify = notify;
    this.states = new Map();
    this.emitTimers = new Map();
  }

  async start(taskId, overrides = {}) {
    const existing = this.states.get(taskId);
    if (existing?.running) return this.database.getTask(taskId);

    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const settings = this.taskSettings(task, overrides);
    const state = {
      running: true,
      paused: false,
      stopped: false,
      controllers: new Set(),
      settings,
    };
    this.states.set(taskId, state);
    this.database.setTaskStatus(taskId, "running", { resumeOnLaunch: true });
    this.emit(taskId, true);

    try {
      const apiKey = settings.mode === "ai" ? await this.getApiKey() : "";
      const batchSize = settings.mode === "rules" ? Math.max(250, settings.concurrency) : settings.concurrency;
      while (!state.paused && !state.stopped) {
        const rows = this.database.getRunnableRows(
          taskId,
          batchSize,
          settings.maxAttempts,
        );
        if (!rows.length) break;
        await Promise.all(rows.map((row) => this.processRow(row, settings, apiKey, state)));
        this.emit(taskId);
      }

      const latest = this.database.getTask(taskId);
      if (state.paused) {
        this.database.setTaskStatus(taskId, "paused", { resumeOnLaunch: false });
      } else if (state.stopped) {
        this.database.setTaskStatus(taskId, "paused", { resumeOnLaunch: true });
      } else if (latest.completed === latest.total) {
        this.database.setTaskStatus(taskId, "completed");
      } else if (latest.completed + latest.failed >= latest.total) {
        this.database.setTaskStatus(taskId, "completed_with_errors");
      } else {
        this.database.setTaskStatus(taskId, "paused");
      }
    } finally {
      state.running = false;
      this.emit(taskId, true);
    }
    return this.database.getTask(taskId);
  }

  taskSettings(task, overrides = {}) {
    return {
      mode: task.mode,
      baseUrl: task.options.baseUrl,
      model: task.options.model,
      concurrency: Math.max(1, Math.min(100, Number(task.options.concurrency || 15))),
      maxAttempts: Math.max(1, Math.min(5, Number(task.options.maxAttempts || 3))),
      titleMode: task.mode === "rules" ? "local" : task.options.titleMode === "ai" ? "ai" : "fixed",
      resourceType: String(task.options.resourceType || "auto"),
      customRules: Array.isArray(task.options.customRules) ? structuredClone(task.options.customRules) : [],
      titlePrompt: String(task.options.titlePrompt || "").slice(0, 1000),
      introPrompt: String(task.options.introPrompt || "").slice(0, 1000),
      ...overrides,
    };
  }

  async processRow(row, settings, apiKey, state, bypassCache = false) {
    if (state.paused || state.stopped) return;
    this.database.markRowRunning(row.id);
    this.emit(row.taskId);
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      const key = cacheKey(row.name, settings);
      const cached = bypassCache ? null : this.database.getCache(key);
      let result;
      if (cached) {
        result = { ...cached, answer: answerHtml(row.link, cached.intro) };
      } else {
        result = await generateContent(row, settings, apiKey, controller.signal);
        this.database.setCache(key, result);
      }
      result.title = normalizeGeneratedTitle(result.title, row.name, settings.titleMode);
      this.database.markRowSuccess(row.id, row.taskId, result);
    } catch (error) {
      const message = error?.name === "AbortError" ? "任务已暂停" : error?.message || String(error);
      this.database.markRowFailed(row.id, row.taskId, message);
    } finally {
      state.controllers.delete(controller);
      this.emit(row.taskId);
    }
  }

  pause(taskId) {
    const state = this.states.get(taskId);
    if (state) {
      state.paused = true;
      for (const controller of state.controllers) controller.abort();
    }
    this.database.setTaskStatus(taskId, "paused", { resumeOnLaunch: false });
    this.emit(taskId, true);
    return this.database.getTask(taskId);
  }

  retry(taskId) {
    this.database.resetFailed(taskId);
    return this.start(taskId);
  }

  async regenerateRow(taskId, rowId, overrides = {}) {
    await this.regenerateRows(taskId, [rowId], overrides);
    return this.database.getRow(taskId, rowId);
  }

  async regenerateRows(taskId, rowIds, overrides = {}) {
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status === "running" || this.states.get(taskId)?.running) {
      throw new Error("任务运行中，请暂停后再批量重新生成");
    }
    const ids = [...new Set(
      (Array.isArray(rowIds) ? rowIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    )];
    if (!ids.length) throw new Error("请先选择要重新生成的数据");
    const existingRows = ids.map((id) => this.database.getRow(taskId, id));
    if (existingRows.some((row) => !row)) throw new Error("部分记录不存在或已被删除");
    const settings = this.taskSettings(task, overrides);
    const rows = ids.map((id) => this.database.prepareRowRegeneration(taskId, id));
    const state = {
      running: true,
      paused: false,
      stopped: false,
      controllers: new Set(),
      settings,
    };
    const apiKey = settings.mode === "ai" ? await this.getApiKey() : "";
    const batchSize = settings.mode === "rules" ? Math.max(250, settings.concurrency) : settings.concurrency;
    for (let index = 0; index < rows.length; index += batchSize) {
      const group = rows.slice(index, index + batchSize);
      await Promise.all(group.map((row) => this.processRow(row, settings, apiKey, state, true)));
    }
    const latest = this.database.getTask(taskId);
    if (latest.completed === latest.total) {
      this.database.setTaskStatus(taskId, "completed", { resumeOnLaunch: false });
    } else if (latest.completed + latest.failed >= latest.total) {
      this.database.setTaskStatus(taskId, "completed_with_errors", { resumeOnLaunch: false });
    } else {
      this.database.setTaskStatus(taskId, "paused", { resumeOnLaunch: false });
    }
    this.emit(taskId, true);
    return { processed: rows.length, task: this.database.getTask(taskId) };
  }

  stopAll() {
    for (const [taskId, state] of this.states) {
      state.stopped = true;
      for (const controller of state.controllers) controller.abort();
      this.database.setTaskStatus(taskId, "paused", { resumeOnLaunch: true });
    }
    for (const timer of this.emitTimers.values()) clearTimeout(timer);
    this.emitTimers.clear();
  }

  emit(taskId, immediate = false) {
    const existing = this.emitTimers.get(taskId);
    if (immediate) {
      if (existing) clearTimeout(existing);
      this.emitTimers.delete(taskId);
      this.notify(this.database.getTask(taskId));
      return;
    }
    if (existing) return;
    const timer = setTimeout(() => {
      this.emitTimers.delete(taskId);
      this.notify(this.database.getTask(taskId));
    }, 80);
    this.emitTimers.set(taskId, timer);
  }
}

module.exports = { TaskRunner };
