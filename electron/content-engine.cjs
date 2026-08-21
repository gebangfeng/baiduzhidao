const crypto = require("node:crypto");

const toChars = (value) => [...String(value ?? "")];
const charLength = (value) => toChars(value).length;
const compactSpaces = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function stripExtension(value) {
  return compactSpaces(value)
    .replace(/\.(?:pdf|docx?|pptx?|xlsx?|epub|mobi|azw3|txt|mp3|wav|flac|mp4|mkv|avi|mov|zip|rar|7z|psd|ai|jpg|jpeg|png)$/i, "")
    .replace(/\.\d+$/i, "")
    .trim();
}

function shortName(value, maxLength) {
  let name = stripExtension(value)
    .replace(/[❤★☆◆●■]/g, "")
    .replace(/（(?:word|pdf|打印|电子|可编辑)版[^）]*）/gi, "")
    .replace(/\((?:word|pdf|打印|电子|可编辑)版[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (charLength(name) <= maxLength) return name;
  name = name
    .replace(/（含答案(?:解析)?）/g, "含答案")
    .replace(/\(含答案(?:解析)?\)/g, "含答案")
    .replace(/[【】]/g, "")
    .trim();
  if (charLength(name) <= maxLength) return name;
  return `${toChars(name).slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

function materialTitleName(name) {
  let materialName = stripExtension(name)
    .replace(/^[\s【\[(（]*(?:第)?\d{1,4}(?:[-_.、]\d+)?[\s】\])）:：._、-]*/u, "")
    .replace(/^(?:求|请问|想要|寻找)\s*/u, "")
    .replace(/\s*(?:百度)?网盘(?:链接)?(?:获取|下载|资源)?\s*$/u, "")
    .trim();
  if (!materialName) materialName = "相关素材";
  return materialName;
}

function materialCoreName(name) {
  const original = materialTitleName(name);
  const core = original
    .replace(/^(?:手机|安卓|苹果|电脑|PC|单机|网络)?游戏\s*/iu, "")
    .replace(/^(?:学习|考试|设计|影视|电子书)资料\s*/u, "")
    .replace(/\s*(?:安装包|客户端|软件|资料|资源|素材|合集|完整版|高清版|电子版|网盘版)$/iu, "")
    .replace(/[【】\[\]()（）《》〈〉:：,，。.!！?？、_\-]/g, "")
    .trim();
  return core || original;
}

function compactTitleMatch(value) {
  return String(value || "").toLowerCase().replace(/[\s【】\[\]()（）《》〈〉:：,，。.!！?？、_\-]/g, "");
}

function includesMaterialCore(title, name) {
  const source = toChars(compactTitleMatch(materialCoreName(name)));
  const output = compactTitleMatch(title);
  if (!source.length) return false;
  const required = Math.min(4, source.length);
  for (let index = 0; index <= source.length - required; index += 1) {
    if (output.includes(source.slice(index, index + required).join(""))) return true;
  }
  return false;
}

function isGeneratedTitleValid(title, name) {
  const candidate = compactSpaces(title);
  if (charLength(candidate) < 5 || charLength(candidate) > 49) return false;
  if (/https?:\/\/|www\./i.test(candidate) || !/网盘/.test(candidate) || !/(?:链接|下载|获取)/.test(candidate)) return false;
  return includesMaterialCore(candidate, name);
}

function repairGeneratedTitle(title, name) {
  let candidate = compactSpaces(title).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!candidate || /https?:\/\/|www\./i.test(candidate) || !includesMaterialCore(candidate, name)) return candidate;
  const punctuation = candidate.match(/[？?！!]$/)?.[0] || "";
  if (punctuation) candidate = candidate.slice(0, -1).trim();
  if (!/网盘/.test(candidate)) {
    const repaired = candidate
      .replace(/哪里可以(?:进行)?(下载|获取)/, "哪里可以通过网盘$1")
      .replace(/在哪里(?:进行)?(下载|获取)/, "在哪里通过网盘$1");
    candidate = repaired === candidate ? `${candidate}（网盘）` : repaired;
  }
  if (!/(?:链接|下载|获取)/.test(candidate)) candidate += "链接获取";
  return `${candidate}${punctuation}`;
}

function normalizeTitle(_title, name) {
  const patterns = [
    ["哪里可以获取", "网盘链接"],
    ["", "网盘资源怎么下载"],
    ["求", "完整网盘链接"],
    ["", "网盘链接在哪里获取"],
  ];
  const seed = toChars(String(name || "")).reduce((sum, char) => sum + (char.codePointAt(0) || 0), 0);
  const [prefix, suffix] = patterns[seed % patterns.length];
  const materialName = materialTitleName(name);
  const maxNameLength = 49 - charLength(prefix) - charLength(suffix);
  return `${prefix}${shortName(materialName, maxNameLength)}${suffix}`;
}

function normalizeGeneratedTitle(title, name, mode = "ai") {
  const fallback = normalizeTitle("", name);
  const candidate = compactSpaces(title)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (mode === "local") {
    if (charLength(candidate) < 5 || charLength(candidate) > 49) return fallback;
    if (/https?:\/\/|www\./i.test(candidate) || !/网盘/.test(candidate) || !/(?:链接|下载|获取)/.test(candidate)) return fallback;
    return candidate;
  }
  if (mode !== "ai") return fallback;
  const repaired = repairGeneratedTitle(candidate, name);
  return isGeneratedTitleValid(repaired, name) ? repaired : fallback;
}

const LOCAL_RESOURCE_TYPES = new Set(["auto", "study", "book", "film", "template", "general"]);

function normalizedCustomRules(input) {
  return Array.isArray(input) ? input.filter((rule) => rule && rule.enabled !== false && rule.id) : [];
}

function detectResourceType(name, customRules = []) {
  const value = String(name || "");
  const lowerValue = value.toLocaleLowerCase();
  const custom = normalizedCustomRules(customRules).find((rule) => (
    (Array.isArray(rule.keywords) ? rule.keywords : [])
      .some((keyword) => lowerValue.includes(String(keyword || "").toLocaleLowerCase()))
  ));
  if (custom) return `custom:${custom.id}`;
  if (/年级|学期|教材|课程|考试|考研|高考|中考|题库|试卷|教案|课件|讲义|练习|知识点|学习|英语|语文|数学|物理|化学|生物|历史|地理/i.test(value)) return "study";
  if (/小说|书籍|文学|全集|作者|有声书|电子书|epub|mobi|azw3/i.test(value)) return "book";
  if (/电影|电视剧|短剧|综艺|动漫|动画|纪录片|影视|剧集|网剧|蓝光|1080p|4k/i.test(value)) return "film";
  if (/PPT模板|模板|素材包|设计素材|海报|字体|图纸|插画|贴纸|简历|样机|PSD|AI格式/i.test(value)) return "template";
  return "general";
}

function normalizeResourceType(value, name, customRules = []) {
  const customId = String(value || "").match(/^custom:([a-zA-Z0-9_-]{1,80})$/)?.[1];
  if (customId && normalizedCustomRules(customRules).some((rule) => rule.id === customId)) return `custom:${customId}`;
  const selected = LOCAL_RESOURCE_TYPES.has(String(value || "")) ? String(value) : "auto";
  return selected === "auto" ? detectResourceType(name, customRules) : selected;
}

function localTitle(name, resourceType) {
  const type = normalizeResourceType(resourceType, name);
  const patterns = {
    study: ["哪里可以获取", "学习资料网盘链接"],
    book: ["求", "完整版网盘链接下载"],
    film: ["求", "高清版网盘链接获取"],
    template: ["求", "素材网盘链接获取"],
    general: ["求", "完整网盘链接获取"],
  };
  const [prefix, suffix] = patterns[type] || patterns.general;
  const materialName = materialTitleName(name);
  const maxNameLength = Math.max(1, 49 - charLength(prefix) - charLength(suffix));
  return `${prefix}${shortName(materialName, maxNameLength)}${suffix}`;
}

function detectMeta(name) {
  const subject = /数学|口算|计算|分数|比例|几何/.test(name) ? "数学"
    : /语文|字词|生字|句子|阅读|作文|写作|晨读|散文|童话/.test(name) ? "语文"
      : /英语|English|Module|Unit|词汇|语法|听力/i.test(name) ? "英语"
        : /物理/.test(name) ? "物理"
          : /化学/.test(name) ? "化学"
            : /生物/.test(name) ? "生物"
              : /历史/.test(name) ? "历史"
                : /地理/.test(name) ? "地理" : "学科";
  const gradeMatch = name.match(/([一二三四五六七八九])年级/)
    ?? name.match(/(?:^|[【（( ])([一二三四五六])(?:[（(][上下][）)]|[上下]册)/);
  const grade = gradeMatch ? `${gradeMatch[1]}年级` : "对应学段";
  const term = /上册|上学期|[（(]上[）)]/.test(name) ? "上学期"
    : /下册|下学期|[（(]下[）)]/.test(name) ? "下学期"
      : /暑假|暑期/.test(name) ? "暑期衔接" : "";
  const editions = [
    ["北师大", "北师大版"], ["人教", "人教版"], ["苏教", "苏教版"], ["译林", "译林版"],
    ["冀教", "冀教版"], ["沪教", "沪教版"], ["外研", "外研版"], ["牛津上海", "牛津上海版"],
  ];
  const edition = editions.find(([key]) => name.includes(key))?.[1] ?? "对应教材版本";
  const kind = /听力|\.mp3$/i.test(name) ? "听力音频"
    : /课件|\.pptx?$/i.test(name) ? "教学课件"
      : /教案|教学设计/.test(name) ? "教案"
        : /检测卷|测试卷|试卷|真题|模拟卷|复习卷|题卡/.test(name) ? "练习测评"
          : /知识点|知识清单|梳理|教材巧解|讲义/.test(name) ? "知识梳理"
            : /习题|练习|专项训练|专练/.test(name) ? "同步练习" : "学习资料";
  return { subject, grade, term, edition, kind };
}

function chooseNear200(sentences) {
  const mandatory = sentences.slice(0, 2).join("");
  const optional = sentences.slice(2);
  let best = mandatory;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < (1 << optional.length); mask += 1) {
    let text = mandatory;
    for (let index = 0; index < optional.length; index += 1) {
      if (mask & (1 << index)) text += optional[index];
    }
    const length = charLength(text);
    const outside = length < 185 ? (185 - length) * 8 : length > 215 ? (length - 215) * 8 : 0;
    const score = Math.abs(length - 200) + outside;
    if (score < bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best;
}

function studyRulesContent(name) {
  const meta = detectMeta(name);
  const displayName = shortName(name, 52);
  const modules = {
    数学: "概念理解、运算方法、题型辨析与实际问题应用",
    语文: "基础字词句、文本理解、语言积累与表达运用",
    英语: "核心词汇、重点句型、语法语用及听说读写训练",
  }[meta.subject] ?? "关键概念、基础方法、典型任务与综合运用";
  const format = /\.mp3$/i.test(name)
    ? "音频文件形式，便于反复播放、跟读和完成听力训练"
    : /\.docx?$/i.test(name)
      ? "可编辑文档形式，便于调整题目、打印练习和整理错题"
      : /\.pptx?$/i.test(name)
        ? "演示课件形式，适合课堂讲解、知识呈现和互动复盘"
        : "版式固定的PDF或电子文件形式，便于跨设备阅读、打印和保持原有排版";
  const answerHint = /含答案|答案解析|附答案/.test(name)
    ? "标题标明含答案或解析，可在独立完成后核对步骤、订正错误并归纳易错点。"
    : "可结合教材或课堂进度使用，完成后由教师、家长或配套资料进行核对。";
  const intro = chooseNear200([
    `《${displayName}》属于${meta.grade}${meta.term ? `、${meta.term}` : ""}的${meta.edition}${meta.subject}${meta.kind}，主要对应标题所示的知识范围。`,
    `素材围绕${modules}组织，可用于识别知识盲点、理解解题或表达思路，并衔接同阶段教材进度。`,
    `文件采用${format}。`,
    answerHint,
    "建议先明确学习目标，再分模块完成任务，最后依据结果整理错题、重点词句或方法步骤。",
    `适合${meta.grade}学生课前预习、课堂巩固、课后练习和阶段复习，也可供教师布置分层任务、家长了解学习情况时参考。`,
  ]);
  return {
    title: localTitle(name, "study"),
    intro,
  };
}

function bookRulesContent(name) {
  const displayName = shortName(name, 52);
  return {
    title: localTitle(name, "book"),
    intro: chooseNear200([
      `《${displayName}》是一份以标题所示作品为核心的阅读素材，可结合书名、作者、系列或版本信息判断其题材方向和文本定位。`,
      "作品内容通常围绕主要人物的处境、关系变化与关键选择展开，阅读时可重点关注人物动机、矛盾推进、情节转折和主题表达之间的联系。",
      "不同格式可用于连续阅读、章节检索或跨设备查看。",
      "建议先梳理人物关系和故事主线，再记录重要场景、叙事线索及人物成长变化。",
      "对于系列作品，可按照卷册或章节顺序阅读，避免因跳读影响情节理解。",
      "适合希望了解作品脉络、回顾章节内容、分析人物塑造与叙事风格的读者使用。",
    ]),
  };
}

function filmRulesContent(name) {
  const displayName = shortName(name, 52);
  return {
    title: localTitle(name, "film"),
    intro: chooseNear200([
      `《${displayName}》是与标题所示影视作品相关的观看素材，可从片名、季数、集数、清晰度或版本标识判断具体内容范围。`,
      "作品通常通过人物关系、情节冲突和视听表达呈现核心主题，观看时可关注主线推进、角色变化、场景调度以及音乐和画面共同形成的风格。",
      "如标题包含合集或分季信息，可按集数顺序核对内容完整性。",
      "不同清晰度与文件格式适配电脑、电视或移动设备等观看场景。",
      "建议结合题材、时长、语言版本和年龄分级选择合适内容。",
      "适合希望完整观看作品、回顾主要情节或研究角色塑造与影像表达的观众使用。",
    ]),
  };
}

function templateRulesContent(name) {
  const displayName = shortName(name, 52);
  return {
    title: localTitle(name, "template"),
    intro: chooseNear200([
      `《${displayName}》属于标题所示主题的设计模板或创作素材，名称通常能够反映应用场景、视觉风格、文件格式及适配软件。`,
      "素材可用于版式搭建、视觉参考和内容替换，使用前应先检查画布尺寸、字体、图片链接、图层结构与可编辑范围，再根据实际项目调整文字和配色。",
      "包含多套文件时，可按用途、比例或风格分类整理。",
      "演示模板适合汇报展示，平面素材可用于海报、社交配图或印刷设计。",
      "建议保留原始文件副本，并在修改后核对字体授权、图片清晰度和导出格式。",
      "适合设计人员、办公用户、教师和内容创作者快速完成对应主题的视觉制作。",
    ]),
  };
}

function generalRulesContent(name) {
  const displayName = shortName(name, 52);
  return {
    title: localTitle(name, "general"),
    intro: chooseNear200([
      `《${displayName}》是围绕标题所示主题整理的电子素材，可依据名称中的版本、格式、数量和用途信息判断资源范围。`,
      "使用前建议先查看目录结构和文件说明，确认主要内容、适用软件、打开方式及是否包含多个版本，再按实际需求选择对应文件。",
      "对于压缩包或合集，可解压后按文件夹层级分类查看。",
      "涉及图片、音频、视频或文档时，应使用相应软件打开并保留原始文件。",
      "整理过程中可统一命名、去除重复内容并记录关键文件位置，方便后续检索和使用。",
      "适合需要了解该主题资料构成、核对文件范围并在个人学习、工作或创作场景中使用的用户。",
    ]),
  };
}

function customRulesContent(name, rule) {
  const displayName = shortName(name, 52);
  let prefix = compactSpaces(rule?.titlePrefix || "求");
  let suffix = compactSpaces(rule?.titleSuffix || "网盘链接获取");
  if (!/网盘/.test(`${prefix}${suffix}`)) suffix += "网盘";
  if (!/(?:链接|下载|获取)/.test(`${prefix}${suffix}`)) suffix += "链接获取";
  if (charLength(prefix) + charLength(suffix) > 40) suffix = "网盘链接获取";
  const maxNameLength = Math.max(1, 49 - charLength(prefix) - charLength(suffix));
  const title = `${prefix}${shortName(materialTitleName(name), maxNameLength)}${suffix}`;
  const rawCore = String(rule?.introTemplate || "")
    .replace(/\{(?:资源名称|name)\}/gi, displayName)
    .trim();
  const core = toChars(rawCore).slice(0, 90).join("");
  const coreSentence = core ? `${core}${/[。！？.!?]$/.test(core) ? "" : "。"}` : "素材的具体范围可结合文件名、目录结构、版本标识和文件格式进行判断。";
  return {
    title,
    intro: chooseNear200([
      `《${displayName}》属于“${shortName(rule?.name || "自定义素材", 24)}”类型的电子资源，主要围绕标题所示主题进行整理。`,
      coreSentence,
      "使用前建议先核对文件目录、版本信息、适用环境和主要内容，确认与自己的实际需求一致。",
      "如包含多个文件或压缩包，可按照目录层级分类查看，并保留原始文件以便后续整理。",
      "使用过程中可记录关键文件位置、统一命名并去除重复内容，提高查找和管理效率。",
      "适合需要了解该类资源构成，并用于个人学习、工作、创作或资料整理场景的用户。",
    ]),
  };
}

function rulesContent(name, resourceType = "auto", customRules = []) {
  const rules = normalizedCustomRules(customRules);
  const type = normalizeResourceType(resourceType, name, rules);
  if (type.startsWith("custom:")) {
    const rule = rules.find((item) => item.id === type.slice(7));
    if (rule) return customRulesContent(name, rule);
  }
  if (type === "study") return studyRulesContent(name);
  if (type === "book") return bookRulesContent(name);
  if (type === "film") return filmRulesContent(name);
  if (type === "template") return templateRulesContent(name);
  return generalRulesContent(name);
}

function extractJson(text) {
  const cleaned = String(text ?? "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI返回内容不是有效JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function fallbackIntro(name) {
  if (/小说|书籍|文学|全集|作者|epub|mobi|txt/i.test(name)) {
    const displayName = shortName(name, 52);
    return chooseNear200([
      `《${displayName}》是一份以标题所示作品为核心的阅读素材，可结合书名、作者或版本信息判断题材范围与文本定位。`,
      "内容通常围绕主要人物的处境、关系变化和关键事件展开，阅读时可关注人物选择如何推动矛盾发展、情节转折与主线收束。",
      "素材适合用于了解故事脉络、梳理人物关系和观察叙事视角。",
      "阅读过程中可以记录关键线索、重要场景与人物动机，避免只停留在情节概述。",
      "其核心价值在于帮助读者从人物成长、冲突设置和主题表达三个层面理解作品。",
      "适合希望系统阅读原作、回顾章节内容或分析作品风格的读者使用。",
    ]);
  }
  if (/电影|电视剧|纪录片|动漫|动画|综艺|影视/i.test(name)) {
    const displayName = shortName(name, 52);
    return chooseNear200([
      `《${displayName}》是与标题所示影视作品相关的观看素材，可依据片名、版本或集数信息确认作品范围。`,
      "内容重点可从题材定位、核心冲突、人物关系与主题表达展开，观看时应关注情节推进、视听呈现和关键场景之间的联系。",
      "主要看点包括角色塑造、叙事节奏和情绪氛围的变化。",
      "观看前可先核对清晰度、字幕与集数，观看后再结合人物选择和故事结局梳理主题。",
      "该素材适合希望完整观看作品、回顾重点情节或分析影像风格的人群。",
      "不同年龄观众可根据作品题材和分级信息选择使用。",
    ]);
  }
  return rulesContent(name).intro;
}

function normalizeIntro(intro, name) {
  const value = compactSpaces(intro);
  if (charLength(value) < 180 || charLength(value) > 220) return fallbackIntro(name);
  return value;
}

async function aiContent(name, settings, apiKey, signal) {
  if (!apiKey) throw new Error("尚未配置API密钥");
  const baseUrl = String(settings.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?/i.test(baseUrl)) {
    throw new Error("API地址必须使用HTTPS，或指向本机127.0.0.1");
  }
  let parsed;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = attempt
      ? "上一次输出未完全通过校验。请确保title保留素材的核心专有名称，使用自然多样的问句并包含网盘以及链接、下载、获取之一；intro必须为180至220个中文字符。不要统一使用“求……完整网盘链接获取”。"
      : "";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.65,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `你是中文素材问答编辑。只返回JSON，字段仅为title和intro。title根据文件名反推用户获取素材时会提出的自然问题，必须保留素材核心名称，包含“网盘”以及“链接、下载、获取”之一，长度5至49字，不含网址，不写盗版或引流话术。intro必须180至220字，目标约200字；根据名称识别书籍小说、影视或学习资料，并按对应类型客观说明核心内容、看点、功能价值和适用人群。不写“内容丰富、干货满满、值得收藏”，不讨论盗版或引流。${settings.titlePrompt ? `\n用户对标题风格的补充要求：${String(settings.titlePrompt).slice(0, 1000)}` : ""}${settings.introPrompt ? `\n用户对素材简介的补充要求：${String(settings.introPrompt).slice(0, 1000)}` : ""}`,
          },
          {
            role: "user",
            content: `素材名称：${stripExtension(name)}${correction ? `\n${correction}` : ""}`,
          },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AI接口返回${response.status}：${body.slice(0, 240)}`);
    }
    const payload = await response.json();
    parsed = extractJson(payload.choices?.[0]?.message?.content);
    const introLength = charLength(compactSpaces(parsed.intro));
    const repairedTitle = repairGeneratedTitle(parsed.title, name);
    if (introLength >= 180 && introLength <= 220 && isGeneratedTitleValid(repairedTitle, name)) {
      parsed.title = repairedTitle;
      break;
    }
  }
  return {
    title: normalizeGeneratedTitle(parsed.title, name, settings.titleMode),
    intro: normalizeIntro(parsed.intro, name),
  };
}

function answerHtml(link, intro) {
  const escape = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<p><strong>点击链接获取完整素材：</strong><br/></p>\n<p>${escape(link)}<br/></p>\n<p>${escape(intro)}</p>`;
}

function cacheKey(name, settings) {
  return crypto.createHash("sha256")
    .update(`title-v2|${settings.mode}|${settings.model || "rules"}|${settings.resourceType || "auto"}|${JSON.stringify(settings.customRules || [])}|${settings.titleMode || "fixed"}|${compactSpaces(settings.titlePrompt || "")}|${compactSpaces(settings.introPrompt || "")}|${compactSpaces(name)}`)
    .digest("hex");
}

async function generateContent(row, settings, apiKey, signal) {
  const content = settings.mode === "ai"
    ? await aiContent(row.name, settings, apiKey, signal)
    : rulesContent(row.name, settings.resourceType, settings.customRules);
  return {
    ...content,
    answer: answerHtml(row.link, content.intro),
  };
}

module.exports = {
  generateContent,
  rulesContent,
  detectResourceType,
  normalizeIntro,
  normalizeTitle,
  normalizeGeneratedTitle,
  isGeneratedTitleValid,
  repairGeneratedTitle,
  answerHtml,
  cacheKey,
  charLength,
};
