const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const clone = (value) => value == null ? value : structuredClone(value);
const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = {}) => {
  try { return value == null ? clone(fallback) : JSON.parse(value); } catch { return clone(fallback); }
};

class TaskDatabase {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.legacyJsonPath = options.legacyJsonPath || (filePath.endsWith(".json") ? filePath : path.join(path.dirname(filePath), "tasks.json"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.createSchema();
    this.migrateLegacyJson();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, file_name TEXT, source_path TEXT, sheet_name TEXT, status TEXT NOT NULL,
        mode TEXT, total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, output_path TEXT, resume_on_launch INTEGER NOT NULL DEFAULT 0,
        options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source_row INTEGER, name TEXT, link TEXT, title TEXT, intro TEXT, answer TEXT,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rows_task_id_id ON rows(task_id, id);
      CREATE INDEX IF NOT EXISTS rows_task_status_attempts ON rows(task_id, status, attempts, id);
      CREATE INDEX IF NOT EXISTS rows_task_updated ON rows(task_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS cache (cache_key TEXT PRIMARY KEY, title TEXT, intro TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  migrateLegacyJson() {
    if (this.db.prepare("SELECT 1 FROM metadata WHERE key='legacy_json_migrated'").get()) return;
    if (!fs.existsSync(this.legacyJsonPath)) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.legacyJsonPath, "utf8")); }
    catch {
      const backup = `${this.legacyJsonPath}.backup`;
      if (!fs.existsSync(backup)) return;
      data = JSON.parse(fs.readFileSync(backup, "utf8"));
    }
    this.transaction(() => {
      const setting = this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)");
      for (const [key, value] of Object.entries(data.settings || {})) setting.run(key, json(value));
      const task = this.db.prepare(`INSERT OR REPLACE INTO tasks
        (id,file_name,source_path,sheet_name,status,mode,total,completed,failed,output_path,resume_on_launch,options,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const t of data.tasks || []) task.run(t.id,t.fileName,t.sourcePath,t.sheetName,t.status,t.mode,t.total||0,t.completed||0,t.failed||0,t.outputPath||null,t.resumeOnLaunch?1:0,json(t.options),t.createdAt,t.updatedAt||t.createdAt);
      const row = this.db.prepare(`INSERT OR REPLACE INTO rows
        (id,task_id,source_row,name,link,title,intro,answer,status,attempts,error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of data.rows || []) row.run(r.id,r.taskId,r.sourceRow,r.name,r.link,r.title||null,r.intro||null,r.answer||null,r.status||"pending",r.attempts||0,r.error||null,r.updatedAt);
      const cache = this.db.prepare("INSERT OR REPLACE INTO cache(cache_key,title,intro,created_at) VALUES (?,?,?,?)");
      for (const [key, value] of Object.entries(data.cache || {})) cache.run(key,value.title||null,value.intro||null,value.createdAt||new Date().toISOString());
      this.db.prepare("INSERT INTO metadata(key,value) VALUES ('legacy_json_migrated',?)").run(new Date().toISOString());
    });
    fs.renameSync(this.legacyJsonPath, `${this.legacyJsonPath}.migrated`);
  }

  close() { this.db.close(); }
  getSetting(key, fallback = null) { const r=this.db.prepare("SELECT value FROM settings WHERE key=?").get(key); return r ? parse(r.value, fallback) : fallback; }
  setSetting(key, value) { this.db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,json(value)); }

  mapTask(t) { return t ? { id:t.id,fileName:t.file_name,sourcePath:t.source_path,sheetName:t.sheet_name,status:t.status,mode:t.mode,total:t.total,completed:t.completed,failed:t.failed,outputPath:t.output_path,resumeOnLaunch:Boolean(t.resume_on_launch),options:parse(t.options),createdAt:t.created_at,updatedAt:t.updated_at } : null; }
  mapRow(r) { return r ? { id:r.id,taskId:r.task_id,sourceRow:r.source_row,name:r.name,link:r.link,title:r.title,intro:r.intro,answer:r.answer,status:r.status,attempts:r.attempts,error:r.error,updatedAt:r.updated_at } : null; }

  createTask(task, rows) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO tasks(id,file_name,source_path,sheet_name,status,mode,total,completed,failed,output_path,resume_on_launch,options,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(task.id,task.fileName,task.sourcePath,task.sheetName,"ready",task.mode,rows.length,0,0,null,0,json(task.options),task.createdAt,task.createdAt);
      const insert=this.db.prepare("INSERT INTO rows(task_id,source_row,name,link,status,attempts,updated_at) VALUES (?,?,?,?, 'pending',0,?)");
      for (const r of rows) insert.run(task.id,r.sourceRow,r.name,r.link,task.createdAt);
    });
    return this.getTask(task.id);
  }

  listTasks() { return this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").all().map((r)=>this.mapTask(r)); }
  getTask(id) {
    const task=this.mapTask(this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id)); if(!task)return null;
    const sampleRows=this.db.prepare("SELECT * FROM rows WHERE task_id=? ORDER BY id LIMIT 8").all(id).map((r)=>this.mapRow(r));
    const current=this.db.prepare("SELECT * FROM rows WHERE task_id=? AND status='running' ORDER BY id LIMIT 10").all(id).map((r)=>this.mapRow(r));
    const recent=this.db.prepare("SELECT * FROM rows WHERE task_id=? AND status IN ('completed','failed') ORDER BY updated_at DESC LIMIT 8").all(id).map((r)=>this.mapRow(r));
    const activity=({sourceRow,name,title,status,attempts,error,updatedAt})=>({sourceRow,name,title,status,attempts,error,updatedAt});
    return {...task,samples:sampleRows.map(({sourceRow,name,link,title,intro,status,error})=>({sourceRow,name,link,title,intro,status,error})),currentItems:current.map(activity),recentItems:recent.map(activity)};
  }

  getTaskRows(taskId, options={}) {
    const requested=Number(options.pageSize)||20, pageSize=[20,50,100,200].includes(requested)?requested:20;
    const statuses=new Set(["all","pending","running","completed","failed"]), status=statuses.has(options.status)?options.status:"all";
    const query=String(options.query||"").trim().toLocaleLowerCase();
    const grouped=this.db.prepare("SELECT status,COUNT(*) count FROM rows WHERE task_id=? GROUP BY status").all(taskId);
    const counts={all:0,pending:0,running:0,completed:0,failed:0}; for(const r of grouped){if(Object.hasOwn(counts,r.status))counts[r.status]=r.count; counts.all+=r.count;}
    const clauses=["task_id=?"], params=[taskId];
    if(status!=="all"){clauses.push("status=?");params.push(status);}
    if(query){clauses.push("(LOWER(COALESCE(name,'')) LIKE ? OR LOWER(COALESCE(link,'')) LIKE ? OR LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(error,'')) LIKE ?)"); const q=`%${query}%`;params.push(q,q,q,q);}
    const where=clauses.join(" AND "), total=this.db.prepare(`SELECT COUNT(*) count FROM rows WHERE ${where}`).get(...params).count;
    const pageCount=Math.max(1,Math.ceil(total/pageSize)), page=Math.min(Math.max(1,Number(options.page)||1),pageCount);
    const rows=this.db.prepare(`SELECT * FROM rows WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);
    const items=rows.map((r)=>{const x=this.mapRow(r);delete x.taskId;return x;}); return {items,total,page,pageSize,pageCount,counts};
  }

  setTaskStatus(id,status,options={}) { let resume=Object.hasOwn(options,"resumeOnLaunch")?Number(Boolean(options.resumeOnLaunch)):null; if(resume===null&&["completed","completed_with_errors"].includes(status))resume=0; this.db.prepare("UPDATE tasks SET status=?, resume_on_launch=COALESCE(?,resume_on_launch), updated_at=? WHERE id=?").run(status,resume,new Date().toISOString(),id); }
  setTaskOutput(id,outputPath){this.db.prepare("UPDATE tasks SET output_path=?,updated_at=? WHERE id=?").run(outputPath,new Date().toISOString(),id);}
  updateTaskOptions(id,options){const task=this.getTask(id);if(!task)throw new Error("任务不存在");const merged={...(task.options||{}),...clone(options||{})};const mode=options?.mode==="ai"||options?.mode==="rules"?options.mode:task.mode;this.db.prepare("UPDATE tasks SET options=?,mode=?,updated_at=? WHERE id=?").run(json(merged),mode,new Date().toISOString(),id);return this.getTask(id);}
  getRunnableRows(taskId,limit=100,maxAttempts=3){return this.db.prepare("SELECT id,task_id,source_row,name,link,attempts FROM rows WHERE task_id=? AND status IN ('pending','failed') AND attempts<? ORDER BY id LIMIT ?").all(taskId,maxAttempts,limit).map((r)=>({id:r.id,taskId:r.task_id,sourceRow:r.source_row,name:r.name,link:r.link,attempts:r.attempts}));}
  markRowRunning(id){const r=this.db.prepare("SELECT task_id,status FROM rows WHERE id=?").get(Number(id));if(!r)return;this.db.prepare("UPDATE rows SET status='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),Number(id));this.adjustTaskCounts(r.task_id,r.status,"running");}
  markRowSuccess(id,taskId,result){const r=this.db.prepare("SELECT status FROM rows WHERE id=?").get(Number(id));if(!r)return;this.db.prepare("UPDATE rows SET title=?,intro=?,answer=?,status='completed',error=NULL,updated_at=? WHERE id=?").run(result.title??null,result.intro??null,result.answer??null,new Date().toISOString(),Number(id));this.adjustTaskCounts(taskId,r.status,"completed");}
  markRowFailed(id,taskId,error){const r=this.db.prepare("SELECT status FROM rows WHERE id=?").get(Number(id));if(!r)return;this.db.prepare("UPDATE rows SET status='failed',error=?,updated_at=? WHERE id=?").run(String(error).slice(0,1000),new Date().toISOString(),Number(id));this.adjustTaskCounts(taskId,r.status,"failed");}
  getRow(taskId,rowId){return this.mapRow(this.db.prepare("SELECT * FROM rows WHERE task_id=? AND id=?").get(taskId,Number(rowId)));}

  updateRowContent(taskId,rowId,input){const row=this.getRow(taskId,rowId);if(!row)throw new Error("记录不存在");if(row.status==="running")throw new Error("该记录正在处理中，请暂停后再编辑");const title=String(input?.title||"").trim(),answer=String(input?.answer||"").trim();if([...title].length<5||[...title].length>49)throw new Error("问题标题需控制在5～49字");if(!answer)throw new Error("回答内容不能为空");this.transaction(()=>{this.db.prepare("UPDATE rows SET title=?,answer=?,status='completed',error=NULL,updated_at=? WHERE id=?").run(title,answer,new Date().toISOString(),row.id);this.adjustTaskCounts(taskId,row.status,"completed");const t=this.db.prepare("SELECT total,completed FROM tasks WHERE id=?").get(taskId);if(t&&t.completed===t.total)this.db.prepare("UPDATE tasks SET status='completed',resume_on_launch=0 WHERE id=?").run(taskId);});return this.getRow(taskId,rowId);}
  prepareRowRegeneration(taskId,rowId){const row=this.getRow(taskId,rowId);if(!row)throw new Error("记录不存在");if(row.status==="running")throw new Error("该记录正在处理中");this.transaction(()=>{this.db.prepare("UPDATE rows SET title=NULL,intro=NULL,answer=NULL,status='pending',attempts=0,error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),row.id);this.adjustTaskCounts(taskId,row.status,"pending");});return this.getRow(taskId,rowId);}

  deleteRows(taskId,rowIds){const task=this.getTask(taskId);if(!task)throw new Error("任务不存在");if(task.status==="running")throw new Error("任务运行中，请暂停后再删除数据");const ids=[...new Set((Array.isArray(rowIds)?rowIds:[]).map(Number).filter((x)=>Number.isInteger(x)&&x>0))];if(!ids.length)throw new Error("请先选择要删除的数据");let deleted=0;this.transaction(()=>{const del=this.db.prepare("DELETE FROM rows WHERE task_id=? AND id=?");for(const id of ids)deleted+=Number(del.run(taskId,id).changes);if(!deleted)throw new Error("选中的数据不存在或已被删除");this.refreshCounts(taskId);const t=this.db.prepare("SELECT total,completed,failed FROM tasks WHERE id=?").get(taskId);const status=!t.total?"ready":t.completed===t.total?"completed":t.completed+t.failed>=t.total?"completed_with_errors":"paused";this.db.prepare("UPDATE tasks SET status=?,output_path=NULL,resume_on_launch=0 WHERE id=?").run(status,taskId);});return{deleted,task:this.getTask(taskId)};}
  deleteTask(taskId){const task=this.getTask(taskId);if(!task)throw new Error("任务不存在或已被删除");if(task.status==="running")throw new Error("任务运行中，请先暂停任务再删除");const count=this.db.prepare("SELECT COUNT(*) count FROM rows WHERE task_id=?").get(taskId).count;this.db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);return{taskId,deletedRows:count};}
  refreshCounts(taskId){const r=this.db.prepare("SELECT COUNT(*) total,SUM(status='completed') completed,SUM(status='failed') failed FROM rows WHERE task_id=?").get(taskId);this.db.prepare("UPDATE tasks SET total=?,completed=?,failed=?,updated_at=? WHERE id=?").run(r.total,Number(r.completed||0),Number(r.failed||0),new Date().toISOString(),taskId);}
  adjustTaskCounts(taskId,previous,next){if(previous===next)return;const dc=(next==="completed")-(previous==="completed"),df=(next==="failed")-(previous==="failed");this.db.prepare("UPDATE tasks SET completed=MAX(0,completed+?),failed=MAX(0,failed+?),updated_at=? WHERE id=?").run(dc,df,new Date().toISOString(),taskId);}
  resetFailed(taskId){this.transaction(()=>{this.db.prepare("UPDATE rows SET status='pending',error=NULL,attempts=0,updated_at=? WHERE task_id=? AND status='failed'").run(new Date().toISOString(),taskId);this.refreshCounts(taskId);});}
  recoverInterruptedTasks(){const now=new Date().toISOString();return this.transaction(()=>{const ids=this.db.prepare("SELECT id FROM tasks WHERE status='running' OR resume_on_launch=1").all().map((r)=>r.id);this.db.prepare("UPDATE rows SET status='pending',updated_at=? WHERE status='running'").run(now);this.db.prepare("UPDATE tasks SET status='paused',resume_on_launch=1,updated_at=? WHERE status='running' OR resume_on_launch=1").run(now);return ids;});}
  getCompletedRows(taskId){return this.db.prepare("SELECT source_row,name,link,title,intro,answer FROM rows WHERE task_id=? AND status='completed' ORDER BY id").all(taskId).map((r)=>({sourceRow:r.source_row,name:r.name,link:r.link,title:r.title,intro:r.intro,answer:r.answer}));}

  getTaskAudit(taskId){if(!this.getTask(taskId))throw new Error("任务不存在");const rows=this.db.prepare("SELECT status,title,answer,link FROM rows WHERE task_id=?").all(taskId);const links=new Map(),result={total:rows.length,completed:0,incomplete:0,emptyTitle:0,invalidTitleLength:0,emptyAnswer:0,invalidHtml:0,introLengthWarning:0,duplicateLinks:0,canExport:false};for(const row of rows){row.status==="completed"?result.completed++:result.incomplete++;const title=String(row.title||"").trim(),len=[...title].length;if(!title)result.emptyTitle++;else if(len<5||len>49)result.invalidTitleLength++;const answer=String(row.answer||"").trim();if(!answer)result.emptyAnswer++;else{if((answer.match(/<p(?:\s[^>]*)?>/gi)||[]).length<3||!/<strong>[\s\S]*?<\/strong>/i.test(answer)||!/<br\s*\/?>/i.test(answer))result.invalidHtml++;const ps=[...answer.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)],intro=ps.at(-1)?.[1]?.replace(/<[^>]+>/g,"").replace(/&nbsp;/gi," ").trim()||"";if(intro&&([...intro].length<180||[...intro].length>220))result.introLengthWarning++;}const link=String(row.link||"").trim().toLocaleLowerCase();if(link)links.set(link,(links.get(link)||0)+1);}result.duplicateLinks=[...links.values()].reduce((n,x)=>n+Math.max(0,x-1),0);result.canExport=result.incomplete===0&&result.emptyTitle===0&&result.invalidTitleLength===0&&result.emptyAnswer===0&&result.invalidHtml===0;return result;}
  getCache(key){const r=this.db.prepare("SELECT title,intro,created_at FROM cache WHERE cache_key=?").get(key);return r?{title:r.title,intro:r.intro,createdAt:r.created_at}:null;}
  setCache(key,result){this.db.prepare("INSERT INTO cache(cache_key,title,intro,created_at) VALUES (?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET title=excluded.title,intro=excluded.intro,created_at=excluded.created_at").run(key,result.title,result.intro,new Date().toISOString());}
}

module.exports = { TaskDatabase };
