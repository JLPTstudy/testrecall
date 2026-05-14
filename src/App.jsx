import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase, syncPointsToCloud, loadPointsFromCloud, syncSettingsToCloud, loadSettingsFromCloud, trackEvent, loadAnalyticsData } from './lib/supabase'
import Tesseract from 'tesseract.js'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Groq API — text extraction & normalization
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_TEXT_MODEL = 'llama-3.3-70b-versatile'
const GROQ_FALLBACK_MODEL = 'llama-3.1-8b-instant'
const GEMINI_VISION_MODEL = 'gemini-2.5-flash'

// API keys: user-supplied (localStorage) take priority over env vars
const getGroqKey = () => localStorage.getItem('user_groq_key') || import.meta.env.VITE_GROQ_API_KEY || ''
const getGeminiKey = () => localStorage.getItem('user_gemini_key') || import.meta.env.VITE_GEMINI_API_KEY || ''

const ADMIN_EMAIL = 'rdjdaozai@gmail.com'

const CHANGELOG = [
  {
    version: 'v1.1',
    date: '2026-05-14',
    items: [
      '支持 Google 账号一键登录，数据自动云端同步',
      '多设备共享学习进度',
      '新增公告 & 联系开发者入口',
    ],
  },
  {
    version: 'v1.0',
    date: '2026-05-13',
    items: [
      '上传 PDF / 图片，AI 自动提取 JLPT N1/N2 考点',
      '手动添加词汇 / 语法 / 搭配',
      '闪卡复习 + 记忆评分系统',
      '多维度统计图表',
    ],
  },
]
const LATEST_VERSION = CHANGELOG[0].version

const OCR_LANGS = 'jpn+chi_sim+eng'
const PDF_OCR_SCALE = 2

// Types
const TYPE_COLORS = {
  vocabulary: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-300' },
  grammar: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-300' },
  collocation: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-300' },
  expression: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-300' },
}

const TYPE_LABELS = {
  vocabulary: '单词',
  grammar: '语法',
  collocation: '搭配',
  expression: '表达',
}

const STUDY_SECTIONS = [
  {
    id: 'vocabulary',
    title: '单词',
    description: 'JLPT N1 高频词、固定搭配',
    types: ['vocabulary', 'collocation'],
  },
  {
    id: 'grammar',
    title: '语法',
    description: '句型、接续、语气',
    types: ['grammar'],
  },
]

// Custom tag palette
const TAG_PALETTE = [
  { bg: 'bg-rose-100', text: 'text-rose-700' },
  { bg: 'bg-amber-100', text: 'text-amber-700' },
  { bg: 'bg-lime-100', text: 'text-lime-700' },
  { bg: 'bg-teal-100', text: 'text-teal-700' },
  { bg: 'bg-sky-100', text: 'text-sky-700' },
  { bg: 'bg-violet-100', text: 'text-violet-700' },
  { bg: 'bg-fuchsia-100', text: 'text-fuchsia-700' },
  { bg: 'bg-orange-100', text: 'text-orange-700' },
]
const getTagStyle = (tag, userTags) => TAG_PALETTE[Math.max(0, userTags.indexOf(tag)) % TAG_PALETTE.length]

const normalizeTerm = (term) => term.trim().replace(/\s+/g, ' ')

const getPointKey = (point) => `${point.type || 'vocabulary'}::${normalizeTerm(point.term || '').toLowerCase()}`

const normalizeRelated = (related) => {
  if (Array.isArray(related)) return related.filter(Boolean)
  if (typeof related === 'string' && related.trim()) return [related.trim()]
  return []
}

const defaultSource = {
  id: 'manual',
  title: '手动输入',
  kind: 'text',
  size: 0,
}

const getSourceLabel = (source) => {
  if (!source) return defaultSource.title
  if (source.title) return source.title
  return source.kind === 'image' ? '图片上传' : '文本输入'
}

const getSourceKindLabel = (kind) => {
  if (kind === 'image') return '图片'
  if (kind === 'pdf') return 'PDF'
  if (kind === 'file') return '文件'
  return '文本'
}

const formatFileSize = (size = 0) => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const toPoint = (item, idx, source = defaultSource) => {
  const now = Date.now()
  const term = normalizeTerm(item.term || '')
  const type = TYPE_LABELS[item.type] ? item.type : 'vocabulary'

  return {
    id: `${now}-${idx}`,
    type,
    term,
    reading: item.reading || null,
    meaningCN: item.meaning_cn || item.meaningCN || null,
    meaningEN: item.meaning_en || item.meaningEN || null,
    partOfSpeech: item.part_of_speech || item.partOfSpeech || null,
    connection: item.connection || null,
    nuance: item.nuance || null,
    level: item.level || null,
    usage: item.usage || null,
    example: item.example || null,
    grammarStyle: item.grammar_style || item.grammarStyle || null, // 'daily' | 'formal' | null
    related: normalizeRelated(item.related),
    sourceExam: item.source_exam || item.sourceExam || null,
    source,
    occurrenceCount: 1,
    createdAt: new Date().toISOString(),
    lastReviewedAt: null,
    nextReviewAt: null,
    reviewCount: 0,
    memoryScore: 0,
  }
}

const mergePoint = (existing, incoming) => ({
  ...existing,
  reading: existing.reading || incoming.reading,
  meaningCN: existing.meaningCN || incoming.meaningCN,
  meaningEN: existing.meaningEN || incoming.meaningEN,
  partOfSpeech: existing.partOfSpeech || incoming.partOfSpeech,
  connection: existing.connection || incoming.connection,
  nuance: existing.nuance || incoming.nuance,
  level: existing.level || incoming.level,
  usage: existing.usage || incoming.usage,
  example: existing.example || incoming.example,
  related: Array.from(new Set([...(existing.related || []), ...(incoming.related || [])])),
  sourceExam: existing.sourceExam || incoming.sourceExam,
  source: existing.source || incoming.source,
  occurrenceCount: (existing.occurrenceCount || 1) + 1,
})

const formatDate = (iso) => {
  if (!iso) return '未复习'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(iso))
}

const groupBySource = (points) => points.reduce((acc, point) => {
  const source = point.source || defaultSource
  const sourceId = source.id || getSourceLabel(source)
  if (!acc[sourceId]) acc[sourceId] = { source, points: [] }
  acc[sourceId].points.push(point)
  return acc
}, {})

// AI prompts
const TEXT_SYSTEM_PROMPT = `你是JLPT日语考点提取专家，只返回JSON数组，不要任何其他文字。`

const ALL_LEVELS = ['N1', 'N2', 'N3', 'N4', 'N5']

const JSON_EXAMPLE = `[{"term":"もくろむ","type":"vocabulary","reading":"もくろむ","meaning_cn":"图谋、策划"},
 {"term":"〜にもかかわらず","type":"grammar","meaning_cn":"尽管...","connection":"普通形+にもかかわらず","grammar_style":"formal"},
 {"term":"気が置けない","type":"collocation","meaning_cn":"不必拘束、可以推心置腹"}]`

const buildExtractionRules = (levels) => {
  const levelStr = levels.join('/')
  const highOnly = !levels.includes('N4') && !levels.includes('N5')
  const excludeGrammarNote = highOnly
    ? '。【絶対禁止】〜ておく・〜てみる・〜ばかり・〜はず・〜わけ・〜なくても・〜てしまう・〜ながら・〜たり 等N4-N5基础语法一律不提取'
    : ''
  const excludeVocabNote = highOnly
    ? `。【絶対禁止】不提取N3/N4/N5程度的常用词，例：学校・会社・友達・仕事・時間・先生・電車・食べる・読む・書く・話す・聞く・使う・思う・知る・始まる・終わる・できる・なる・ほしい・好き・大切・必要・十分・簡単・難しい・多い・少ない・新しい・古い・高い・安い・速い 等，即使出现在题目中也不提取`
    : ''
  return `
類型：
- grammar = ${levelStr}級別語法句型，通常是複合助詞或接続形式，例：〜にもかかわらず・〜を皮切りに・〜に際して・〜ずにはおかない・〜かねない・〜をもって・〜に至る${excludeGrammarNote}。grammar類型必須額外返回grammar_style字段：'daily'（日常口語/会話中常用）或'formal'（書面語/正式文章中使用）
- collocation = 两词以上的惯用表达，整体含义无法从各词字面推导（例：気が置けない・手が込む・目を見張る）。普通的「名词+助词」短語不是collocation
- vocabulary = 仅限${levelStr}程度词汇（名詞/動詞/形容詞/副詞），動詞寫辭書形${excludeVocabNote}

提取要求：
1. 严格只提取${levelStr}程度词汇，级别不够的词哪怕出现在题目中也不提取
2. 题干中被直接考查（下划线/括号标注）的目标词必须提取
3. 4个选项全部检查；选项是完整句子时，拆出${levelStr}级别关键词单独提取
4. 不提取「文法」「語彙」「読解」「聴解」等章节标题
5. 宁可少抓，不可抓低级别词凑数`
}

const buildTextPrompt = (levels) =>
  `从以下文本提取所有考点，不得遗漏。${buildExtractionRules(levels)}\n\n只返回JSON数组：${JSON_EXAMPLE}\n\n文本：\n`

const buildVisionPrompt = (levels) =>
  `这是JLPT日语考试题目图片，仔细识别所有文字，提取所有考点，不得遗漏。${buildExtractionRules(levels)}\n\n只返回JSON数组：${JSON_EXAMPLE}`

// Load/Save data from localStorage
const loadData = () => {
  try {
    const saved = localStorage.getItem('testrecall_points')
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

const saveData = (points) => {
  localStorage.setItem('testrecall_points', JSON.stringify(points))
}

const loadUserTags = () => {
  try {
    const saved = localStorage.getItem('testrecall_tags')
    return saved ? JSON.parse(saved) : []
  } catch { return [] }
}

const saveUserTags = (tags) => {
  localStorage.setItem('testrecall_tags', JSON.stringify(tags))
}

const loadSourceNames = () => {
  try {
    const saved = localStorage.getItem('testrecall_source_names')
    return saved ? JSON.parse(saved) : {}
  } catch { return {} }
}

const saveSourceNames = (names) => {
  localStorage.setItem('testrecall_source_names', JSON.stringify(names))
}

const loadSourceCategories = () => {
  try {
    const saved = localStorage.getItem('testrecall_source_categories')
    return saved ? JSON.parse(saved) : {}
  } catch { return {} }
}

const saveSourceCategories = (cats) => {
  localStorage.setItem('testrecall_source_categories', JSON.stringify(cats))
}

const loadFavorites = () => {
  try {
    const saved = localStorage.getItem('testrecall_favorites')
    return saved ? new Set(JSON.parse(saved)) : new Set()
  } catch { return new Set() }
}

const saveFavorites = (favs) => {
  localStorage.setItem('testrecall_favorites', JSON.stringify([...favs]))
}

const buildSourceMeta = (file, kind) => ({
  id: `${kind}-${file.name}-${file.size}-${file.lastModified}`,
  title: file.name,
  kind,
  size: file.size,
  addedAt: new Date().toISOString(),
})

const imageToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = reject
  reader.readAsDataURL(file)
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const isGeminiOverloaded = (status, msg) =>
  status === 503 || status === 429 ||
  /high demand|overloaded|try again/i.test(msg || '')

// Shared Gemini caller — 3 retries per model, then falls back to GEMINI_FALLBACK_MODEL
async function callGeminiAPI(geminiParts, temperature = 0.2, retries = 3) {
  for (let retryIdx = 0; retryIdx <= retries; retryIdx++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${getGeminiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: geminiParts }],
          generationConfig: { temperature, maxOutputTokens: 65536 },
        }),
      }
    )
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      const msg = err.error?.message || `Gemini API错误 (${response.status})`
      if (isGeminiOverloaded(response.status, msg) && retryIdx < retries) {
        await sleep(3000 * (retryIdx + 1)) // 3s → 6s → 9s
        continue
      }
      throw new Error(msg)
    }
    const respData = await response.json()
    const resParts = respData.candidates?.[0]?.content?.parts || []
    const text = (resParts.find(p => !p.thought) || resParts[0])?.text
    if (!text) throw new Error('Gemini未返回有效内容')
    return text
  }
}

const callGeminiVision = (imageDataUrl, prompt, temperature = 0.2) => {
  const [header, base64Data] = imageDataUrl.split(',')
  const mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg'
  return callGeminiAPI(
    [{ inline_data: { mime_type: mimeType, data: base64Data } }, { text: prompt }],
    temperature,
  )
}

// Gemini text-only fallback (same model as vision, no image parts)
const callGeminiText = (messages, temperature = 0.2) => {
  const prompt = messages.map(m =>
    typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.text || '').join('\n')
  ).join('\n\n')
  return callGeminiAPI([{ text: prompt }], temperature)
}

async function callGroq(messages, model, temperature = 0.2) {
  async function attempt(m) {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getGroqKey()}`,
      },
      body: JSON.stringify({ model: m, messages, temperature, max_tokens: 8192 }),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      const errMsg = err.error?.message || ''
      if (response.status === 429 || errMsg.toLowerCase().includes('too large') || response.status === 413) {
        if (response.status === 429 && m !== GROQ_FALLBACK_MODEL) return attempt(GROQ_FALLBACK_MODEL)
        // Request too large or both models exhausted — fall back to Gemini
        if (getGeminiKey()) return callGeminiText(messages, temperature)
        if (response.status === 429) throw new Error('Groq 每日 token 已用尽，请明天再试或配置 Gemini API Key')
        throw new Error('请求内容过长，请配置 Gemini API Key 以支持更长内容')
      }
      throw new Error(errMsg || 'Groq API请求失败')
    }
    const respData = await response.json()
    const text = respData.choices?.[0]?.message?.content
    if (!text) throw new Error('未获取到有效响应')
    return text
  }
  return attempt(model)
}

const parseGroqResponse = (content) => {
  const jsonMatch = content.match(/\[[\s\S]*\]/)
  if (jsonMatch) return JSON.parse(jsonMatch[0])
  // Fallback: extract complete objects
  const results = []
  const objRegex = /\{"term":"[^"]+","[^}]+"type":"(?:vocabulary|grammar|collocation|expression)"[^}]*\}/g
  let match
  while ((match = objRegex.exec(content)) !== null) {
    try { results.push(JSON.parse(match[0])) } catch {}
  }
  if (results.length > 0) return results
  throw new Error('JSON解析失败，请重试')
}

const normalizeDictForms = async (candidates) => {
  const toFix = candidates.filter(c => c.type === 'vocabulary' || c.type === 'collocation')
  if (toFix.length === 0) return candidates
  const BATCH = 40
  const normMap = {}
  const SYSTEM = '你是日语语法专家。只返回JSON数组，不要其他文字。'
  const buildPrompt = (input) =>
    `将以下日语词汇的term字段全部转为辞书形（原形），id字段原样保留：
・动词活用形→辞书形：した/される/された/している/していた→する；んでいる→む；いでいる→ぐ；てきた→てくる；など
・形容词变形→辞书形：くて/くない/かった→い形原形
・名词、副词、惯用句：不变，原样保留
输入：${JSON.stringify(input)}
输出：同格式JSON数组，只修改需要还原的term，不需要还原的也原样返回。`
  for (let i = 0; i < toFix.length; i += BATCH) {
    const batch = toFix.slice(i, i + BATCH).map(c => ({ id: c.id, term: c.term }))
    try {
      const content = await callGroq(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildPrompt(batch) }],
        GROQ_TEXT_MODEL, 0,
      )
      const normalized = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || '[]')
      normalized.forEach(n => { if (n.id && n.term) normMap[n.id] = n.term })
    } catch { /* keep originals for this batch */ }
  }
  return candidates.map(c => (normMap[c.id] ? { ...c, term: normMap[c.id] } : c))
}

const sortBySourceOrder = (candidates, sourceText) => {
  if (!sourceText) return candidates
  const text = sourceText.toLowerCase()
  const pos = (term) => {
    const t = term.toLowerCase()
    const idx = text.indexOf(t)
    return idx === -1 ? Infinity : idx
  }
  return [...candidates].sort((a, b) => pos(a.term) - pos(b.term))
}

const rubyToHtml = (text) =>
  text ? text.replace(/\[([^\]|]+)\|([^\]]+)\]/g, '<ruby>$1<rt>$2</rt></ruby>') : ''

const generatePrintHTML = (folderName, sourceGroups, sourceNames) => {
  const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date())
  const total = sourceGroups.reduce((s, g) => s + g.points.length, 0)

  const sourcesHTML = sourceGroups.map(({ source, points: srcPoints }) => {
    const name = sourceNames[source.id] || getSourceLabel(source)
    const sectionsHTML = STUDY_SECTIONS.map((section, idx) => {
      const pts = srcPoints.filter(p => section.types.includes(p.type))
      if (!pts.length) return ''
      const rows = pts.map(p => `
        <tr>
          <td class="term-cell">
            <span class="term">${p.term}</span>
            <span class="badge">${TYPE_LABELS[p.type] || p.type}</span>
            ${(p.occurrenceCount || 1) > 1 ? `<span class="occ">×${p.occurrenceCount}</span>` : ''}
          </td>
          <td>${p.reading || p.partOfSpeech || ''}</td>
          <td>${p.meaningCN || ''}${p.connection ? `<div class="sub">接续：${p.connection}</div>` : ''}</td>
          <td>${p.example ? `<span class="ex">${rubyToHtml(p.example)}</span>` : ''}${p.exampleCN ? `<div class="sub">${p.exampleCN}</div>` : ''}</td>
          <td class="style-cell">${p.grammarStyle === 'daily' ? '<span class="daily">日常可用</span>' : p.grammarStyle === 'formal' ? '<span class="formal">书面用语</span>' : ''}</td>
        </tr>`).join('')
      return `<div class="section">
        <h3>${idx + 1}、${section.title} <span class="cnt">${pts.length} 条</span></h3>
        <table><thead><tr><th>考点</th><th>读音/词性</th><th>中文说明</th><th>例句</th><th>标签</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    }).join('')
    return `<div class="src">
      <h2>${name}</h2>
      <p class="src-meta">${getSourceKindLabel(source.kind)}${source.size ? ' · ' + formatFileSize(source.size) : ''} · ${srcPoints.length} 个考点</p>
      ${sectionsHTML}</div>`
  }).join('')

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>${folderName} — 考点汇总</title>
<style>
*{box-sizing:border-box}
body{font-family:"Hiragino Sans GB","Yu Gothic","Noto Sans CJK SC",sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:24px;line-height:1.6}
h1{font-size:20px;margin:0 0 4px}
.meta{color:#888;font-size:11px;margin-bottom:28px}
.src{margin-bottom:36px}
h2{font-size:14px;font-weight:700;border-bottom:2px solid #3b82f6;padding-bottom:4px;margin:0 0 2px}
.src-meta{color:#9ca3af;font-size:10px;margin:0 0 12px}
h3{font-size:11px;font-weight:600;color:#374151;margin:16px 0 6px}
.cnt{font-weight:normal;color:#9ca3af}
table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px}
th{background:#f3f4f6;text-align:left;padding:4px 6px;border:1px solid #e5e7eb;font-weight:600;color:#374151}
td{padding:5px 6px;border:1px solid #e5e7eb;vertical-align:top}
.term-cell{min-width:80px}
.term{font-weight:700;font-size:13px;display:block}
.badge{display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;background:#dbeafe;color:#1d4ed8;margin-top:2px}
.occ{font-size:9px;color:#9ca3af;margin-left:3px}
.sub{font-size:10px;color:#6b7280;margin-top:2px}
.ex{color:#111}
ruby rt{font-size:0.6em;color:#6b7280}
.style-cell{white-space:nowrap;font-size:10px}
.daily{color:#15803d;background:#dcfce7;padding:1px 5px;border-radius:3px}
.formal{color:#4338ca;background:#e0e7ff;padding:1px 5px;border-radius:3px}
@page{margin:1.5cm 2cm}
@media print{body{padding:0}.src{page-break-inside:avoid}}
</style></head><body>
<h1>${folderName} — 考点汇总</h1>
<p class="meta">${date} · 共 ${total} 个考点</p>
${sourcesHTML}
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400))</script>
</body></html>`
}

const fillMissingExamples = async (points, onUpdate, onProgress) => {
  // Re-fill if missing example, missing CN translation, or missing furigana notation
  const toFill = points.filter(p => !p.example || !p.exampleCN || !p.example.includes('['))
  if (toFill.length === 0) return 0

  const BATCH = 8
  let filled = 0
  let lastError = null
  for (let i = 0; i < toFill.length; i += BATCH) {
    const batch = toFill.slice(i, i + BATCH)
    const input = batch.map(p => ({ id: String(p.id), term: p.term, type: p.type, connection: p.connection || undefined }))
    try {
      const content = await callGroq(
        [
          { role: 'system', content: '你是日语教学专家。只返回JSON数组，不要其他文字。' },
          {
            role: 'user',
            content: `为以下JLPT N1考点各生成一个自然的日语例句（10-20字）及中文翻译。
要求：
1. 例句中所有汉字必须用[漢字|ふりがな]格式标注平假名，如：[計画|けいかく]を[立|た]てる。
2. 平假名、片假名、标点不用标注
3. grammar类型按connection字段的接续形式造句

只返回JSON数组：[{"id":"xxx","example":"[漢字|ふりがな]の例文。","example_cn":"中文翻译"}]

考点：${JSON.stringify(input)}`,
          },
        ],
        GROQ_TEXT_MODEL,
        0,
      )
      const results = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || '[]')
      results.forEach(r => { if (r.id && r.example) { onUpdate(String(r.id), r.example, r.example_cn || null); filled++ } })
      lastError = null
    } catch (e) {
      lastError = e.message || '未知错误'
    }
    if (onProgress) onProgress(Math.min(i + BATCH, toFill.length), toFill.length, lastError)
  }
  return filled
}

const extractImageText = async (imageLike) => {
  const result = await Tesseract.recognize(imageLike, OCR_LANGS, {
    logger: () => {}
  })
  return result.data.text.trim()
}

const renderPdfPageToCanvas = async (page) => {
  const viewport = page.getViewport({ scale: PDF_OCR_SCALE })
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('浏览器无法创建 PDF OCR 画布')
  }

  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvasContext: context, viewport }).promise
  return canvas
}

const extractPdfText = async (file) => {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const pages = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (pageText) {
      pages.push(`【PDF第${pageNumber}页-正文】\n${pageText}`)
    }

    const canvas = await renderPdfPageToCanvas(page)
    const ocrText = await extractImageText(canvas)
    if (ocrText) {
      pages.push(`【PDF第${pageNumber}页-OCR含手写批注】\n${ocrText}`)
    }
  }

  const text = pages.join('\n\n').trim()
  if (!text) {
    throw new Error('未能从 PDF 中提取到文字或批注。请确认 PDF 页面清晰，或把重点页面截成图片后上传。')
  }
  return text
}

// File Upload Component
// Renders [漢字|ふりがな] notation as HTML ruby elements
function RubyText({ text }) {
  if (!text) return null
  const parts = []
  const regex = /\[([^\]|]+)\|([^\]]+)\]/g
  let last = 0, match
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(<ruby key={match.index}>{match[1]}<rt className="text-[0.6em] text-gray-500">{match[2]}</rt></ruby>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <span>{parts}</span>
}

function FileUpload({ onTextExtracted, onError, disabled }) {
  const [isDragging, setIsDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(null)
  const fileInputRef = useRef(null)

  const handleFile = async (file) => {
    if (!file) return
    setUploading(true)
    setPreviewUrl(null)

    try {
      const ext = file.name.split('.').pop().toLowerCase()
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif']
      const textExts = ['txt', 'md', 'text']
      const pdfExts = ['pdf']

      if (imageExts.includes(ext)) {
        setPreviewUrl(URL.createObjectURL(file))
        setUploading(true)
        try {
          const dataUrl = await imageToBase64(file)
          onTextExtracted(null, buildSourceMeta(file, 'image'), dataUrl)
        } catch (err) {
          onError(err.message || '图片读取失败')
        } finally {
          setUploading(false)
        }
      } else if (textExts.includes(ext)) {
        // Text file: read directly
        const text = await file.text()
        if (!text.trim()) throw new Error('文件内容为空')
        onTextExtracted(text, buildSourceMeta(file, 'file'))
      } else if (pdfExts.includes(ext)) {
        const text = await extractPdfText(file)
        onTextExtracted(text, buildSourceMeta(file, 'pdf'))
      } else {
        throw new Error(`暂不支持 ${ext} 格式，支持 PDF、图片（JPG/PNG/GIF/WebP）和文本文件（TXT/MD）`)
      }
    } catch (err) {
      onError(err.message || '文件处理失败')
    } finally {
      setUploading(false)
    }
  }


  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    if (disabled || uploading) return
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    if (!disabled && !uploading) setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleClick = () => {
    if (!disabled && !uploading) fileInputRef.current?.click()
  }

  const handleInputChange = (e) => {
    const file = e.target.files[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
      className={`mt-4 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
        isDragging
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50'
      } ${disabled || uploading ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.bmp,.heic,.heif,.txt,.md,.text"
        onChange={handleInputChange}
        className="hidden"
      />

      {uploading ? (
        <div className="flex flex-col items-center gap-2">
          <svg className="animate-spin h-8 w-8 text-blue-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-gray-600">正在识别正文和手写批注...</span>
        </div>
      ) : previewUrl ? (
        <div className="flex flex-col items-center gap-2">
          <img src={previewUrl} alt="Preview" className="max-h-40 rounded-lg mx-auto" />
          <span className="text-sm text-gray-500">图片已识别，点击可重新上传</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className="text-4xl">📁</div>
          <div>
            <span className="text-blue-600 font-medium">点击上传</span>
            <span className="text-gray-500"> 或拖拽文件到此处</span>
          </div>
          <div className="text-xs text-gray-400">
            支持 PDF · 图片（JPG/PNG/GIF/WebP）· 文本（TXT/MD）
          </div>
          <div className="text-xs text-orange-400 mt-0.5">
            PDF 建议 20MB / 30页以内，过大请拆分后分批上传
          </div>
        </div>
      )}
    </div>
  )
}

// Scan View Component
function ScanView({ onAddPoints, isAdmin, onOpenSettings }) {
  const [text, setText] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const loadingTimerRef = useRef(null)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState({})
  const [hasExtractedText, setHasExtractedText] = useState(false)
  const [source, setSource] = useState(defaultSource)
  const [extractionSuccess, setExtractionSuccess] = useState(false)
  const [selectedLevels, setSelectedLevels] = useState(['N1'])

  const toggleLevel = (level) =>
    setSelectedLevels(prev =>
      prev.includes(level) ? prev.filter(l => l !== level) : [...prev, level]
    )

  const handleAnalyze = async () => {
    if (!text.trim() && !imageDataUrl) return
    if (selectedLevels.length === 0) return

    // Non-admin users must set their own API keys
    if (!isAdmin) {
      const hasGroq = !!localStorage.getItem('user_groq_key')
      const hasGemini = !!localStorage.getItem('user_gemini_key')
      if (!hasGroq || (!hasGemini && !!imageDataUrl)) {
        onOpenSettings?.()
        return
      }
    }

    setLoading(true)
    setLoadingSeconds(0)
    loadingTimerRef.current = setInterval(() => setLoadingSeconds(s => s + 1), 1000)
    setError('')
    setCandidates([])
    setSelected({})
    setExtractionSuccess(false)

    try {
      const visionPrompt = buildVisionPrompt(selectedLevels)
      const textPrompt = buildTextPrompt(selectedLevels)
      let content
      if (imageDataUrl) {
        content = getGeminiKey()
          ? await callGeminiVision(imageDataUrl, visionPrompt)
          : await callGroq(
              [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: imageDataUrl } },
                { type: 'text', text: visionPrompt },
              ]}],
              'meta-llama/llama-4-scout-17b-16e-instruct',
            )
      } else {
        const MAX_CHARS = 12000
        const truncated = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
        content = await callGroq(
          [
            { role: 'system', content: TEXT_SYSTEM_PROMPT },
            { role: 'user', content: textPrompt + truncated },
          ],
          GROQ_TEXT_MODEL,
        )
      }

      const parsed = parseGroqResponse(content)
      const extracted = parsed.map((item, idx) => toPoint(item, idx, source)).filter(item => item.term)
      const sorted = sortBySourceOrder(extracted, imageDataUrl ? null : text)

      setCandidates(sorted)
      const initialSelected = {}
      sorted.forEach(c => { initialSelected[c.id] = true })
      setSelected(initialSelected)

      // normalize dict forms in background, deduplicate, then update
      normalizeDictForms(sorted).then(normalized => {
        const seen = new Set()
        const deduped = normalized.filter(c => {
          const key = getPointKey(c)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        setCandidates(deduped)
        setSelected(prev => {
          const validIds = new Set(deduped.map(c => c.id))
          const next = {}
          Object.entries(prev).forEach(([id, val]) => { if (validIds.has(id)) next[id] = val })
          return next
        })
      }).catch(() => {})
    } catch (err) {
      setError(err.message || '分析失败，请重试')
    } finally {
      clearInterval(loadingTimerRef.current)
      setLoading(false)
    }
  }

  const toggleSelect = (id) => {
    setSelected(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleAddSelected = () => {
    const toAdd = candidates.filter(c => selected[c.id])
    if (toAdd.length === 0) return

    onAddPoints(toAdd)
    setText('')
    setImageDataUrl(null)
    setCandidates([])
    setSelected({})
    setHasExtractedText(false)
    setSource(defaultSource)
    setExtractionSuccess(false)
  }

  const handleTextExtracted = (extractedText, sourceMeta, imgDataUrl) => {
    if (imgDataUrl) {
      setImageDataUrl(imgDataUrl)
      setText('')
    } else {
      setImageDataUrl(null)
      setText(extractedText)
    }
    setSource(sourceMeta || defaultSource)
    setHasExtractedText(true)
    setExtractionSuccess(true)
    setError('')
    setCandidates([])
    setSelected({})
  }

  const handleFileError = (errMsg) => {
    setError(errMsg)
  }

  const handleTextChange = (newText) => {
    setText(newText)
    setImageDataUrl(null)
    setSource(defaultSource)
    setExtractionSuccess(false)
    setHasExtractedText(false)
  }

  const displayText = extractionSuccess ? '' : text
  const textareaPlaceholder = imageDataUrl ? '图片已就绪，点击「AI 分析提取考点」' : extractionSuccess ? '读取成功，点击「AI 分析提取考点」' : '粘贴或输入日语文本...'

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">📷 扫描考点</h2>
      
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          输入日语文本
        </label>
        <textarea
          value={displayText}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder={textareaPlaceholder}
          className="w-full h-40 p-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none japanese-text"
        />
        
        <FileUpload
          onTextExtracted={handleTextExtracted}
          onError={handleFileError}
          disabled={loading}
        />
        
        {hasExtractedText && (
          <div className="mt-2 flex items-center gap-2 text-sm text-green-600">
            <span>✓</span>
            <span>已提取：{getSourceLabel(source)}，可直接点击分析</span>
          </div>
        )}

        {/* Level selector */}
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-gray-600 shrink-0">提取范围</span>
          {ALL_LEVELS.map(level => {
            const active = selectedLevels.includes(level)
            return (
              <label key={level} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleLevel(level)}
                  className="w-4 h-4 accent-blue-600 rounded"
                />
                <span className={`text-sm font-semibold ${active ? 'text-blue-700' : 'text-gray-400'}`}>
                  {level}
                </span>
              </label>
            )
          })}
          {selectedLevels.length === 0 && (
            <span className="text-xs text-red-500">请至少选择一个级别</span>
          )}
        </div>

        <button
          onClick={handleAnalyze}
          disabled={loading || (!text.trim() && !imageDataUrl) || selectedLevels.length === 0}
          className="mt-4 w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <span className="flex flex-col items-center justify-center gap-1">
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                AI 分析中… {loadingSeconds}s
              </span>
              <span className="text-xs opacity-75">
                {imageDataUrl ? '图片/PDF 约需 15–40 秒，请耐心等待' : '文字内容约需 5–15 秒'}
              </span>
            </span>
          ) : '🔍 AI 分析提取考点'}
        </button>

        {!isAdmin && (!localStorage.getItem('user_groq_key') || !localStorage.getItem('user_gemini_key')) && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-start justify-between gap-3">
            <div>
              <p className="font-medium mb-0.5">⚠️ 需要先配置 API Key</p>
              {!localStorage.getItem('user_groq_key') && <p className="text-xs">· Groq Key（文字提取）未配置</p>}
              {!localStorage.getItem('user_gemini_key') && <p className="text-xs">· Gemini Key（图片识别）未配置</p>}
            </div>
            <button onClick={onOpenSettings} className="flex-shrink-0 text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg font-medium">去设置</button>
          </div>
        )}

        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
          </div>
        )}
      </div>

      {candidates.length > 0 && (
        <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-gray-800">
              发现 {candidates.length} 个考点
            </h3>
            <span className="text-sm text-gray-500">
              已选 {Object.values(selected).filter(Boolean).length} 个
            </span>
          </div>
          
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {candidates.map((candidate) => {
              const colors = TYPE_COLORS[candidate.type] || TYPE_COLORS.vocabulary
              return (
                <div
                  key={candidate.id}
                  onClick={() => toggleSelect(candidate.id)}
                  className={`p-4 rounded-lg border cursor-pointer transition-all ${
                    selected[candidate.id]
                      ? `${colors.bg} ${colors.border} border-2`
                      : 'bg-gray-50 border-gray-200 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors.bg} ${colors.text}`}>
                          {TYPE_LABELS[candidate.type]}
                        </span>
                        {candidate.reading && (
                          <span className="text-sm text-gray-500">{candidate.reading}</span>
                        )}
                      </div>
                      <div className="text-xl font-bold text-gray-900 mb-1">
                        {candidate.term}
                      </div>
                      {candidate.meaningCN && (
                        <div className="text-gray-700">{candidate.meaningCN}</div>
                      )}
                      {candidate.example && (
                        <div className="mt-2 text-sm text-gray-600 italic">
                          例: {candidate.example}
                        </div>
                      )}
                    </div>
                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${
                      selected[candidate.id] ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                    }`}>
                      {selected[candidate.id] && (
                        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <button
            onClick={handleAddSelected}
            className="mt-4 w-full bg-green-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-green-700 transition-colors"
          >
            ✓ 添加选中的考点 ({Object.values(selected).filter(Boolean).length}个)
          </button>
        </div>
      )}
    </div>
  )
}

// Manual Point Entry Form
function ManualPointForm({ onSubmit, onCancel, activeTag }) {
  const [term, setTerm] = useState('')
  const [type, setType] = useState('vocabulary')
  const [reading, setReading] = useState('')
  const [meaningCN, setMeaningCN] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!term.trim()) return
    onSubmit({ term: term.trim(), type, reading: reading.trim() || null, meaningCN: meaningCN.trim() || null })
    setTerm('')
    setReading('')
    setMeaningCN('')
    // keep type so bulk entry of same type is faster
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-blue-200 rounded-xl p-5 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800">
          手动添加考点{activeTag ? <span className="ml-1.5 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{activeTag}</span> : ''}
        </h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="col-span-2 md:col-span-1">
          <label className="block text-xs text-gray-500 mb-1">考点 *</label>
          <input
            type="text"
            value={term}
            onChange={e => setTerm(e.target.value)}
            placeholder="日语词汇或语法..."
            required
            autoFocus
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none japanese-text"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">类型</label>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            <option value="vocabulary">单词</option>
            <option value="grammar">语法</option>
            <option value="collocation">搭配</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">读音（可选）</label>
          <input
            type="text"
            value={reading}
            onChange={e => setReading(e.target.value)}
            placeholder="平假名读音"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">中文说明（可选）</label>
          <input
            type="text"
            value={meaningCN}
            onChange={e => setMeaningCN(e.target.value)}
            placeholder="释义、用法说明..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 rounded-lg"
        >
          关闭
        </button>
        <button
          type="submit"
          disabled={!term.trim()}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          添加考点
        </button>
      </div>
    </form>
  )
}

// Tag Editor Component
function TagEditor({ point, userTags, onToggleTag, onCreateTag, onClose, editorRef }) {
  const [input, setInput] = useState('')

  const handleCreate = () => {
    const name = input.trim()
    if (!name) return
    onCreateTag(name)
    onToggleTag(point.id, name, true)
    setInput('')
  }

  return (
    <div ref={editorRef} className="absolute z-30 bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-56 top-full left-0 mt-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">选择分类</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
      </div>
      {userTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {userTags.map(tag => {
            const style = getTagStyle(tag, userTags)
            const active = (point.customTags || []).includes(tag)
            return (
              <button
                key={tag}
                onClick={() => onToggleTag(point.id, tag, !active)}
                className={`px-2 py-0.5 rounded text-xs font-medium border transition-all ${
                  active
                    ? `${style.bg} ${style.text} border-current`
                    : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'
                }`}
              >
                {active && '✓ '}{tag}
              </button>
            )
          })}
        </div>
      )}
      {userTags.length === 0 && (
        <p className="text-xs text-gray-400 mb-2">还没有分类，在下方新建</p>
      )}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
          placeholder="新建分类..."
          autoFocus
          className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={handleCreate}
          disabled={!input.trim()}
          className="px-2 py-1 bg-blue-600 text-white text-xs rounded disabled:opacity-40 hover:bg-blue-700"
        >
          创建
        </button>
      </div>
    </div>
  )
}

// Source Category Editor
function SourceCategoryEditor({ sourceId, currentCategory, allCategories, onAssign, onClose, editorRef }) {
  const [input, setInput] = useState('')

  const pick = (cat) => { onAssign(sourceId, cat); onClose() }

  return (
    <div ref={editorRef} className="absolute z-30 bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-52 top-full left-0 mt-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">归入分类</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
      </div>
      <div className="flex flex-col gap-0.5 mb-2">
        {allCategories.map(cat => (
          <button
            key={cat}
            onClick={() => pick(cat)}
            className={`text-left px-2 py-1.5 rounded text-xs transition-colors ${
              currentCategory === cat
                ? 'bg-blue-100 text-blue-700 font-medium'
                : 'hover:bg-gray-100 text-gray-700'
            }`}
          >
            {currentCategory === cat && '✓ '}{cat}
          </button>
        ))}
        {allCategories.length === 0 && (
          <p className="text-xs text-gray-400 px-2">还没有分类，在下方新建</p>
        )}
        {currentCategory && (
          <button onClick={() => pick(null)} className="text-left px-2 py-1.5 rounded text-xs text-red-500 hover:bg-red-50 mt-1">
            移出分类
          </button>
        )}
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && input.trim() && pick(input.trim())}
          placeholder="新建分类..."
          autoFocus
          className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={() => input.trim() && pick(input.trim())}
          disabled={!input.trim()}
          className="px-2 py-1 bg-blue-600 text-white text-xs rounded disabled:opacity-40 hover:bg-blue-700"
        >
          创建
        </button>
      </div>
    </div>
  )
}

// Points List View Component
function PointsListView({ points, userTags, onUpdatePointTags, onCreateTag, onAddPoint, sourceNames, onRenameSource, sourceCategories, onAssignSourceCategory, onDeletePoint, onUpdatePointExample, onUpdateGrammarStyle, onMergeSources, onDeleteCategory, favorites = new Set(), onToggleFavorite, selectedFolder, setSelectedFolder }) {
  const [openEditorId, setOpenEditorId] = useState(null)     // point tag editor
  const [openCatEditorId, setOpenCatEditorId] = useState(null) // source category editor
  const [showAddForm, setShowAddForm] = useState(false)
  const [filling, setFilling] = useState(false)
  const [fillProgress, setFillProgress] = useState(null) // { done, total, error? }
  const [collapsedSections, setCollapsedSections] = useState({}) // key: `${sourceId}-${sectionId}`
  const [editingSourceId, setEditingSourceId] = useState(null)
  const [editingSourceName, setEditingSourceName] = useState('')
  const [selectedSources, setSelectedSources] = useState(new Set()) // for merge
  const tagEditorRef = useRef(null)
  const catEditorRef = useRef(null)

  useEffect(() => {
    if (!openEditorId && !openCatEditorId) return
    const handler = (e) => {
      if (openEditorId && tagEditorRef.current && !tagEditorRef.current.contains(e.target)) setOpenEditorId(null)
      if (openCatEditorId && catEditorRef.current && !catEditorRef.current.contains(e.target)) setOpenCatEditorId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openEditorId, openCatEditorId])

  const handleToggleTag = (pointId, tag, active) => onUpdatePointTags(pointId, tag, active)

  const handleManualAdd = ({ term, type, reading, meaningCN }) => {
    const point = toPoint({ term, type, reading, meaning_cn: meaningCN }, Date.now(), {
      id: 'manual',
      title: '手动输入',
      kind: 'text',
      size: 0,
    })
    onAddPoint(point)
  }

  const startRename = (sourceId, currentName) => {
    setEditingSourceId(sourceId)
    setEditingSourceName(currentName)
  }

  const commitRename = () => {
    if (editingSourceId) onRenameSource(editingSourceId, editingSourceName.trim())
    setEditingSourceId(null)
  }

  const getDisplayName = (source) => sourceNames[source.id] || getSourceLabel(source)

  // ── Build folder data from source categories ─────────────────────────────────
  const allSourceGroups = Object.values(groupBySource(points))
  const byCategory = {}
  allSourceGroups.forEach(({ source, points: srcPoints }) => {
    const cat = sourceCategories[source.id] || '__uncat__'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push({ source, points: srcPoints })
  })
  const distinctCategories = [...new Set(Object.values(sourceCategories).filter(Boolean))]
  const folders = [
    {
      id: '__uncat__',
      name: '未分类',
      groups: byCategory['__uncat__'] || [],
      pointCount: (byCategory['__uncat__'] || []).reduce((s, g) => s + g.points.length, 0),
    },
    ...distinctCategories.map(cat => ({
      id: cat,
      name: cat,
      groups: byCategory[cat] || [],
      pointCount: (byCategory[cat] || []).reduce((s, g) => s + g.points.length, 0),
    })),
  ]

  const activeFolder = folders.find(f => f.id === selectedFolder)
  const sourceGroups = activeFolder?.groups || []

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (points.length === 0 && selectedFolder === null) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <div className="text-6xl mb-4">📚</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">还没有考点</h2>
        <p className="text-gray-500">去「扫描」页面添加一些文件、图片或文本吧</p>
      </div>
    )
  }

  // ── Folder grid ──────────────────────────────────────────────────────────────
  if (selectedFolder === null) {
    return (
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">📚 考点列表</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {folders.map(folder => (
            <div key={folder.id} className="relative group">
              <button
                onClick={() => setSelectedFolder(folder.id)}
                className="w-full bg-white border border-gray-200 rounded-xl p-5 text-left hover:border-blue-300 hover:shadow-md transition-all"
              >
                <div className="text-3xl mb-3">{folder.id === '__uncat__' ? '📂' : '📁'}</div>
                <div className="font-semibold text-gray-800 mb-1 truncate">{folder.name}</div>
                <div className="text-xs text-gray-400">{folder.groups.length} 个来源 · {folder.pointCount} 个考点</div>
              </button>
              {folder.id !== '__uncat__' && (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    if (confirm(`删除分类「${folder.name}」？\n该分类下的来源将移回「未分类」，考点不会删除。`)) {
                      onDeleteCategory(folder.id)
                    }
                  }}
                  className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-gray-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all text-sm"
                  title="删除分类"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6">
        <button
          onClick={() => { setSelectedFolder(null); setShowAddForm(false) }}
          className="text-sm text-gray-500 hover:text-blue-600 transition-colors"
        >
          ← 考点列表
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-gray-800">{activeFolder?.name}</span>
        <span className="text-xs text-gray-400 ml-1">{activeFolder?.pointCount ?? 0} 个考点</span>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button
          onClick={() => setShowAddForm(v => !v)}
          className="px-3 py-1 rounded-full text-xs font-medium border border-dashed border-blue-400 text-blue-600 hover:bg-blue-50 transition-colors"
        >
          ＋ 手动添加考点
        </button>
        {selectedSources.size >= 2 && (
          <button
            onClick={() => {
              const name = prompt(`合并 ${selectedSources.size} 个来源，请输入合并后的名称：`, '合并考点')
              if (!name?.trim()) return
              onMergeSources([...selectedSources], name.trim())
              setSelectedSources(new Set())
            }}
            className="px-3 py-1 rounded-full text-xs font-medium border border-dashed border-orange-400 text-orange-600 hover:bg-orange-50 transition-colors"
          >
            ⊕ 合并选中来源（{selectedSources.size}）
          </button>
        )}
        <button
          onClick={() => {
            const html = generatePrintHTML(activeFolder?.name || selectedFolder, sourceGroups, sourceNames)
            const win = window.open('', '_blank')
            win.document.write(html)
            win.document.close()
          }}
          disabled={sourceGroups.length === 0}
          className="px-3 py-1 rounded-full text-xs font-medium border border-dashed border-gray-400 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
        >
          ↓ 导出 PDF
        </button>
        {(() => {
          const missing = sourceGroups.flatMap(g => g.points).filter(p => !p.example || !p.exampleCN || !p.example.includes('[')).length
          return (
            <button
              disabled={filling || missing === 0}
              onClick={async () => {
                setFilling(true)
                setFillProgress({ done: 0, total: sourceGroups.flatMap(g => g.points).filter(p => !p.example).length })
                await fillMissingExamples(
                  sourceGroups.flatMap(g => g.points),
                  onUpdatePointExample,
                  (done, total, error) => setFillProgress({ done, total, error }),
                )
                setFilling(false)
                setFillProgress(null)
              }}
              className="px-3 py-1 rounded-full text-xs font-medium border border-dashed border-purple-400 text-purple-600 hover:bg-purple-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {filling
                ? (fillProgress?.error
                    ? `⚠️ 错误: ${fillProgress.error.slice(0, 40)}… (${fillProgress.done}/${fillProgress.total})`
                    : `✨ 补全中… ${fillProgress ? `${fillProgress.done}/${fillProgress.total}` : ''}`)
                : missing > 0 ? `✨ 补全例句（${missing} 个缺失）` : '✨ 例句已全'}
            </button>
          )
        })()}
      </div>

      {showAddForm && (
        <ManualPointForm
          activeTag={null}
          onSubmit={handleManualAdd}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className="space-y-8">
        {sourceGroups.length === 0 && (
          <div className="text-center py-12 text-gray-400">该分类下暂无考点</div>
        )}
        {sourceGroups.map(({ source, points: sourcePoints }) => (
          <section key={source.id || getSourceLabel(source)} className={`bg-white border rounded-xl overflow-hidden transition-colors ${selectedSources.has(source.id) ? 'border-orange-400 ring-1 ring-orange-300' : 'border-gray-200'}`}>
            <div className="px-5 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-1">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedSources.has(source.id)}
                    onChange={e => setSelectedSources(prev => {
                      const next = new Set(prev)
                      e.target.checked ? next.add(source.id) : next.delete(source.id)
                      return next
                    })}
                    className="mt-1 h-4 w-4 rounded border-gray-300 accent-orange-500 cursor-pointer shrink-0"
                    title="选择此来源以合并"
                  />
                <div>
                  {editingSourceId === source.id ? (
                    <input
                      type="text"
                      value={editingSourceName}
                      onChange={e => setEditingSourceName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingSourceId(null) }}
                      autoFocus
                      className="text-lg font-semibold text-gray-900 bg-white border border-blue-400 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-72"
                    />
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold text-gray-900">{getDisplayName(source)}</h3>
                      <button
                        onClick={() => startRename(source.id, getDisplayName(source))}
                        className="text-gray-400 hover:text-blue-500 transition-colors text-sm"
                        title="重命名"
                      >
                        ✏️
                      </button>
                      <div className="relative">
                        <button
                          onClick={() => setOpenCatEditorId(openCatEditorId === source.id ? null : source.id)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded border border-dashed border-gray-300 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
                          title="归入分类"
                        >
                          🏷 {sourceCategories[source.id] ? sourceCategories[source.id] : '归入分类'}
                        </button>
                        {openCatEditorId === source.id && (
                          <SourceCategoryEditor
                            sourceId={source.id}
                            currentCategory={sourceCategories[source.id] || null}
                            allCategories={distinctCategories}
                            onAssign={(sid, cat) => { onAssignSourceCategory(sid, cat); setOpenCatEditorId(null) }}
                            onClose={() => setOpenCatEditorId(null)}
                            editorRef={catEditorRef}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  <div className="text-sm text-gray-500">
                    {getSourceKindLabel(source.kind)}{source.size ? ` · ${formatFileSize(source.size)}` : ''} · {sourcePoints.length} 个考点
                  </div>
                </div>
                </div>
                {source.addedAt && (
                  <div className="text-sm text-gray-400">{formatDate(source.addedAt)}</div>
                )}
              </div>
            </div>

            <div className="divide-y divide-gray-100">
              {STUDY_SECTIONS.map((section, sectionIndex) => {
                const sectionPoints = sourcePoints.filter(point => section.types.includes(point.type))
                const collapseKey = `${source.id}-${section.id}`
                const collapsed = collapsedSections[collapseKey] !== false
                const toggleCollapse = () => setCollapsedSections(prev => ({ ...prev, [collapseKey]: prev[collapseKey] === false }))
                return (
                  <div key={section.id} className="px-5 py-4">
                    <button
                      onClick={toggleCollapse}
                      className="w-full flex items-center justify-between gap-4 text-left mb-0"
                    >
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">
                          {sectionIndex + 1}、{section.title}
                          <span className="ml-2 text-sm font-normal text-gray-400">{sectionPoints.length} 条</span>
                        </h4>
                        {!collapsed && <p className="text-sm text-gray-500">{section.description}</p>}
                      </div>
                      <span className="text-gray-400 text-lg shrink-0">{collapsed ? '▶' : '▼'}</span>
                    </button>

                    {!collapsed && sectionPoints.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="text-xs text-gray-500 border-b border-gray-100">
                            <tr>
                              <th className="py-2 pr-3 font-medium">考点</th>
                              <th className="py-2 px-3 font-medium hidden md:table-cell">读音</th>
                              <th className="py-2 px-3 font-medium">中文说明</th>
                              <th className="py-2 pl-3 font-medium hidden lg:table-cell">例句</th>
                              <th className="py-2 pl-3 font-medium">考察方式</th>
                              <th className="py-2 pl-2 font-medium w-6"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {sectionPoints.map((point) => {
                              const colors = TYPE_COLORS[point.type] || TYPE_COLORS.vocabulary
                              // Related collocations: find grammar/collocation entries whose term
                              // contains this exact word (e.g. 依存する → 〜に依存する, 必ず → 必ずしも〜ない)
                              // Also try stripping する/な to catch stem matches
                              const stem = point.term.replace(/する$|な$/, '')
                              const relatedCollocations = point.term.length >= 2
                                ? points.filter(p =>
                                    p.id !== point.id &&
                                    (p.type === 'collocation' || p.type === 'grammar') &&
                                    (
                                      (p.term || '').includes(point.term) ||
                                      (stem !== point.term && stem.length >= 2 && (p.term || '').includes(stem))
                                    )
                                  ).slice(0, 4)
                                : []
                              // Word-specific study tags
                              const examTags = []
                              if (point.type === 'grammar') {
                                if (point.grammarStyle === 'formal') examTags.push({ label: '书面语', color: 'bg-blue-50 text-blue-600' })
                                else if (point.grammarStyle === 'daily') examTags.push({ label: '口语', color: 'bg-green-50 text-green-600' })
                              } else if (point.type === 'collocation') {
                                if (/[一-鿿]/.test(point.term)) examTags.push({ label: '⚠️ 不可按字面理解', color: 'bg-amber-50 text-amber-600' })
                              } else {
                                if (point.partOfSpeech) examTags.push({ label: point.partOfSpeech, color: 'bg-gray-100 text-gray-500' })
                              }
                              if ((point.occurrenceCount || 1) > 1 && point.source?.title) {
                                examTags.push({ label: `${point.source.title} 出现${point.occurrenceCount}次`, color: 'bg-orange-50 text-orange-500' })
                              }
                              return (
                                <tr key={point.id} className="align-top">
                                  <td className="py-3 pr-3">
                                    <div className="font-semibold text-gray-900">{point.term}</div>
                                    <div className="mt-1 flex gap-1.5 flex-wrap">
                                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors.bg} ${colors.text}`}>
                                        {TYPE_LABELS[point.type]}
                                      </span>
                                      {(point.occurrenceCount || 1) > 1 && (
                                        <span className="px-2 py-0.5 rounded bg-orange-50 text-xs text-orange-500 font-medium">
                                          🔥×{point.occurrenceCount}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-3 px-3 text-gray-600 hidden md:table-cell">
                                    {point.reading || (/^[ぁ-んァ-ヶーa-zA-Z\s・]+$/.test(point.term) ? point.term : '') || ''}
                                  </td>
                                  <td className="py-3 px-3 text-gray-700">
                                    {point.meaningCN || point.usage || point.nuance || '-'}
                                  </td>
                                  <td className="py-3 pl-3 text-gray-600 hidden lg:table-cell">
                                    {point.example
                                      ? <><RubyText text={point.example} />{point.exampleCN && <div className="mt-1 text-xs text-gray-400">{point.exampleCN}</div>}</>
                                      : (point.usage || '-')}
                                    {point.related?.length > 0 && (
                                      <div className="mt-1 text-xs text-gray-400">相关：{point.related.join('、')}</div>
                                    )}
                                  </td>
                                  <td className="py-3 pl-3 min-w-[160px]">
                                    {point.type === 'grammar' && point.connection && (
                                      <div className="text-xs text-gray-600 mb-1.5 font-mono leading-5">
                                        {point.connection}
                                      </div>
                                    )}
                                    {examTags.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {examTags.map((tag, i) => (
                                          <span key={i} className={`px-1.5 py-0.5 rounded text-xs font-medium ${tag.color}`}>{tag.label}</span>
                                        ))}
                                      </div>
                                    )}
                                    {relatedCollocations.length > 0 && (
                                      <div className={`${examTags.length > 0 || (point.type === 'grammar' && point.connection) ? 'mt-2 pt-2 border-t border-gray-100' : ''}`}>
                                        <div className="text-xs text-gray-400 mb-1">相关搭配：</div>
                                        {relatedCollocations.map(r => (
                                          <div key={r.id} className="text-xs text-indigo-600 leading-5">
                                            · {r.term}{r.meaningCN ? `（${r.meaningCN}）` : ''}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {examTags.length === 0 && relatedCollocations.length === 0 && !(point.type === 'grammar' && point.connection) && (
                                      <span className="text-xs text-gray-300">—</span>
                                    )}
                                  </td>
                                  <td className="py-3 pl-2">
                                    <div className="flex flex-col gap-1.5 items-center">
                                      <button
                                        onClick={() => onToggleFavorite && onToggleFavorite(point.id)}
                                        className={`transition-colors ${favorites.has(point.id) ? 'text-yellow-400 hover:text-yellow-500' : 'text-gray-200 hover:text-yellow-400'}`}
                                        title={favorites.has(point.id) ? '取消收藏' : '收藏'}
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                        </svg>
                                      </button>
                                      <button
                                        onClick={() => onDeletePoint(point.id)}
                                        className="text-gray-200 hover:text-red-500 transition-colors"
                                        title="删除考点"
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                                        </svg>
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (!collapsed && (
                      <div className="text-sm text-gray-400 py-2">暂无该类考点</div>
                    ))}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// Statistics View Component
function FlashcardView({ points, sourceNames, sourceCategories, onReview }) {
  const [deckSource, setDeckSource] = useState('__all__')
  const [queue, setQueue] = useState(null)   // null = not started
  const [idx, setIdx] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [sessionStats, setSessionStats] = useState({ known: 0, again: 0 })

  // build source options
  const allSources = [...new Map(points.map(p => [(p.source || {}).id, p.source])).values()].filter(Boolean)

  const buildQueue = (src) => {
    const pool = src === '__all__' ? points : points.filter(p => (p.source || {}).id === src)
    // prioritise unseen / low-score, shuffle within tiers
    const sorted = [...pool].sort((a, b) => {
      const scoreA = a.memoryScore || 0, scoreB = b.memoryScore || 0
      return scoreA - scoreB
    })
    return sorted
  }

  const startDeck = () => {
    const q = buildQueue(deckSource)
    if (q.length === 0) return
    setQueue(q)
    setIdx(0)
    setFlipped(false)
    setSessionStats({ known: 0, again: 0 })
  }

  const current = queue?.[idx]

  const handleKnown = () => {
    onReview(current.id, true)
    setSessionStats(s => ({ ...s, known: s.known + 1 }))
    advance()
  }

  const handleAgain = () => {
    onReview(current.id, false)
    setSessionStats(s => ({ ...s, again: s.again + 1 }))
    advance()
  }

  const advance = () => {
    setFlipped(false)
    if (idx + 1 >= queue.length) {
      setQueue(null) // session done
    } else {
      setIdx(i => i + 1)
    }
  }

  const getSourceLabel = (src) => sourceNames[src?.id] || src?.title || '未知来源'

  // ── Done screen ───────────────────────────────────────────────────────────
  if (queue === null && sessionStats.known + sessionStats.again > 0) {
    const total = sessionStats.known + sessionStats.again
    const pct = Math.round((sessionStats.known / total) * 100)
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <div className="text-6xl mb-4">🎉</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">本轮完成！</h2>
        <p className="text-gray-500 mb-6">共 {total} 张，记住 {sessionStats.known} 张（{pct}%）</p>
        <div className="flex gap-3 justify-center">
          <button onClick={startDeck} className="px-6 py-2 bg-blue-600 text-white rounded-full text-sm font-medium hover:bg-blue-700">再来一轮</button>
          <button onClick={() => { setQueue(null); setSessionStats({ known: 0, again: 0 }) }} className="px-6 py-2 border border-gray-300 text-gray-600 rounded-full text-sm hover:bg-gray-50">返回选择</button>
        </div>
      </div>
    )
  }

  // ── Setup screen ──────────────────────────────────────────────────────────
  if (queue === null) {
    const pool = deckSource === '__all__' ? points : points.filter(p => (p.source || {}).id === deckSource)
    return (
      <div className="max-w-md mx-auto py-12">
        <h2 className="text-2xl font-bold text-gray-800 mb-8 text-center">🃏 记忆卡片</h2>
        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
          <label className="block text-sm font-medium text-gray-700 mb-2">选择来源</label>
          <select
            value={deckSource}
            onChange={e => setDeckSource(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-6 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="__all__">全部考点（{points.length} 个）</option>
            {allSources.map(src => (
              <option key={src.id} value={src.id}>
                {getSourceLabel(src)}（{points.filter(p => (p.source || {}).id === src.id).length} 个）
              </option>
            ))}
          </select>
          <div className="flex justify-between text-xs text-gray-500 mb-6">
            <span>本组：{pool.length} 张</span>
            <span>已复习：{pool.filter(p => p.lastReviewedAt).length} 张</span>
            <span>记住：{pool.filter(p => (p.memoryScore || 0) >= 3).length} 张</span>
          </div>
          <button
            onClick={startDeck}
            disabled={pool.length === 0}
            className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            开始复习
          </button>
        </div>
      </div>
    )
  }

  // ── Card screen ───────────────────────────────────────────────────────────
  const progress = (idx / queue.length) * 100
  const colors = TYPE_COLORS[current.type] || TYPE_COLORS.vocabulary

  return (
    <div className="max-w-lg mx-auto py-8">
      {/* Progress */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>
        <span className="text-xs text-gray-400 shrink-0">{idx + 1} / {queue.length}</span>
        <span className="text-xs text-green-600 shrink-0">✓ {sessionStats.known}</span>
        <span className="text-xs text-red-400 shrink-0">↺ {sessionStats.again}</span>
      </div>

      {/* Card */}
      <div
        onClick={() => setFlipped(f => !f)}
        className="bg-white border border-gray-200 rounded-2xl shadow-sm cursor-pointer select-none min-h-64 flex flex-col"
      >
        {/* Front */}
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 text-center">
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium mb-4 ${colors.bg} ${colors.text}`}>
            {TYPE_LABELS[current.type] || current.type}
          </span>
          <div className="text-4xl font-bold text-gray-900 mb-2">{current.term}</div>
          {current.reading && current.reading !== current.term && (
            <div className="text-lg text-gray-400">{current.reading}</div>
          )}
          {current.connection && (
            <div className="text-sm text-gray-500 mt-2 bg-gray-50 px-3 py-1 rounded-lg">接续：{current.connection}</div>
          )}
        </div>

        {/* Divider + Back */}
        {flipped ? (
          <div className="border-t border-gray-100 px-8 py-6">
            {current.meaningCN && (
              <div className="text-base font-medium text-gray-800 mb-3">{current.meaningCN}</div>
            )}
            {current.example && (
              <div className="text-sm text-gray-600 leading-relaxed mb-1">
                <RubyText text={current.example} />
              </div>
            )}
            {current.exampleCN && (
              <div className="text-xs text-gray-400">{current.exampleCN}</div>
            )}
            {current.grammarStyle && (
              <span className={`inline-block mt-2 px-2 py-0.5 rounded text-xs ${current.grammarStyle === 'daily' ? 'bg-green-100 text-green-700' : 'bg-indigo-100 text-indigo-700'}`}>
                {current.grammarStyle === 'daily' ? '日常可用' : '书面用语'}
              </span>
            )}
          </div>
        ) : (
          <div className="border-t border-gray-100 px-8 py-4 text-center text-sm text-gray-400">
            点击翻转查看释义
          </div>
        )}
      </div>

      {/* Action buttons — only shown after flip */}
      {flipped && (
        <div className="flex gap-3 mt-5">
          <button
            onClick={handleAgain}
            className="flex-1 py-3 border-2 border-red-200 text-red-500 rounded-xl font-medium hover:bg-red-50 transition-colors"
          >
            ↺ 再复习
          </button>
          <button
            onClick={handleKnown}
            className="flex-1 py-3 bg-green-500 text-white rounded-xl font-medium hover:bg-green-600 transition-colors"
          >
            ✓ 记住了
          </button>
        </div>
      )}
    </div>
  )
}

function StatisticsView({ points }) {
  const uniquePoints = [...points].sort((a, b) => (b.occurrenceCount || 1) - (a.occurrenceCount || 1))

  if (points.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <div className="text-6xl mb-4">📊</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">暂无数据</h2>
        <p className="text-gray-500">添加考点后查看统计</p>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">📊 统计分析</h2>

      {/* High Frequency Points */}
      {uniquePoints.filter(p => (p.occurrenceCount || 1) >= 2).length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-1">🔥 高频考点</h3>
          <p className="text-xs text-gray-400 mb-4">在真题中出现多次，JLPT 直接考察概率更高</p>
          {[
            { type: 'grammar', label: '语法' },
            { type: 'collocation', label: '搭配' },
            { type: 'vocabulary', label: '单词' },
          ].map(({ type, label }) => {
            const group = uniquePoints.filter(p => p.type === type && (p.occurrenceCount || 1) >= 2)
            if (group.length === 0) return null
            const colors = TYPE_COLORS[type] || TYPE_COLORS.vocabulary
            return (
              <div key={type} className="mb-5 last:mb-0">
                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold mb-3 ${colors.bg} ${colors.text}`}>
                  {label} · {group.length} 个
                </div>
                <div className="space-y-2">
                  {group.map((p, idx) => {
                    const sourceTitle = p.source?.title || p.source?.id || null
                    const sectionLabel = p.type === 'grammar' ? '文法' : '語彙'
                    const examRef = sourceTitle
                      ? `${sourceTitle} N1 真题${sectionLabel}部分 ×${p.occurrenceCount || 1}`
                      : `历年 N1 真题 ×${p.occurrenceCount || 1}`
                    return (
                      <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-start gap-3">
                          <span className="text-lg font-bold text-gray-300 w-6 flex-shrink-0 mt-0.5">{idx + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-gray-900">{p.term}</span>
                              {p.reading && <span className="text-sm text-gray-500">({p.reading})</span>}
                            </div>
                            {p.meaningCN && <div className="text-sm text-gray-600 mt-0.5">{p.meaningCN}</div>}
                            {p.type === 'grammar' && p.connection && (
                              <div className="text-xs text-gray-400 mt-0.5 font-mono">{p.connection}</div>
                            )}
                            <div className="text-xs text-orange-500 mt-1">📚 {examRef}</div>
                          </div>
                          <span className={`px-2 py-1 rounded text-sm font-bold flex-shrink-0 ${colors.bg} ${colors.text}`}>
                            ×{p.occurrenceCount || 1}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FavoritesView({ points, favorites, onToggleFavorite, onDeletePoint }) {
  const favPoints = points.filter(p => favorites.has(p.id))
  if (favPoints.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <div className="text-6xl mb-4">⭐</div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">暂无收藏</h2>
        <p className="text-gray-400 text-sm">在考点列表中点击 ★ 收藏重要考点</p>
      </div>
    )
  }

  const byType = ['grammar', 'collocation', 'vocabulary'].reduce((acc, t) => {
    const pts = favPoints.filter(p => p.type === t)
    if (pts.length) acc[t] = pts
    return acc
  }, {})

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-2">⭐ 收藏考点</h2>
      <p className="text-sm text-gray-400 mb-6">共 {favPoints.length} 个考点</p>
      {Object.entries(byType).map(([type, pts]) => {
        const colors = TYPE_COLORS[type] || TYPE_COLORS.vocabulary
        return (
          <div key={type} className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${colors.bg} ${colors.text}`}>{TYPE_LABELS[type]}</span>
              <span className="text-sm text-gray-400">{pts.length} 个</span>
            </div>
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-gray-100">
                {pts.map(point => {
                  const displayReading = point.reading || (/^[ぁ-んァ-ヶーa-zA-Z\s・]+$/.test(point.term) ? point.term : '')
                  return (
                    <tr key={point.id} className="align-top">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-gray-900">{point.term}</div>
                        {displayReading && displayReading !== point.term && (
                          <div className="text-xs text-gray-400 mt-0.5">{displayReading}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-700 w-1/3">
                        <div>{point.meaningCN || '-'}</div>
                        {point.type === 'grammar' && point.connection && (
                          <div className="text-xs text-gray-400 mt-0.5 font-mono">{point.connection}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-500 text-xs w-1/4 hidden md:table-cell">
                        {point.type === 'grammar' && point.grammarStyle === 'formal' && <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">书面语</span>}
                        {point.type === 'grammar' && point.grammarStyle === 'daily' && <span className="px-1.5 py-0.5 rounded bg-green-50 text-green-600">口语</span>}
                        {point.type === 'collocation' && /[一-鿿]/.test(point.term) && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-600">⚠️ 不可按字面理解</span>}
                        {(point.occurrenceCount || 1) > 1 && (
                          <span className="ml-1 px-1.5 py-0.5 rounded bg-orange-50 text-orange-500">🔥×{point.occurrenceCount}</span>
                        )}
                      </td>
                      <td className="py-3 px-4 w-10">
                        <div className="flex flex-col gap-1.5 items-center">
                          <button
                            onClick={() => onToggleFavorite(point.id)}
                            className="text-yellow-400 hover:text-yellow-500 transition-colors"
                            title="取消收藏"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => onDeletePoint(point.id)}
                            className="text-gray-200 hover:text-red-500 transition-colors"
                            title="删除"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// Main App Component
function App() {
  const [view, setView] = useState('scan')
  const [points, setPoints] = useState(loadData)
  const [userTags, setUserTags] = useState(loadUserTags)
  const [favorites, setFavorites] = useState(loadFavorites)
  const [pointsFolder, setPointsFolder] = useState(null)
  const [sourceNames, setSourceNames] = useState(loadSourceNames)
  const [sourceCategories, setSourceCategories] = useState(loadSourceCategories)
  const [user, setUser] = useState(null)
  const [syncStatus, setSyncStatus] = useState('idle') // 'idle'|'syncing'|'synced'|'error'
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('tr_welcomed'))
  const [showAnnouncement, setShowAnnouncement] = useState(false)
  const [showContact, setShowContact] = useState(false)
  const [showAdminDash, setShowAdminDash] = useState(false)
  const [adminData, setAdminData] = useState(null)
  const [hasNewAnnouncement] = useState(() => localStorage.getItem('tr_seen_version') !== LATEST_VERSION)
  const [toast, setToast] = useState(null) // { msg, type }
  const syncTimerRef = useRef(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }, [])

  const loadFromCloud = useCallback(async (userId) => {
    setSyncStatus('syncing')
    try {
      const [cloudPoints, cloudSettings] = await Promise.all([
        loadPointsFromCloud(userId),
        loadSettingsFromCloud(userId),
      ])
      if (cloudPoints !== null && cloudPoints.length > 0) {
        setPoints(cloudPoints)
        saveData(cloudPoints)
      }
      if (cloudSettings) {
        if (cloudSettings.source_names) { setSourceNames(cloudSettings.source_names); saveSourceNames(cloudSettings.source_names) }
        if (cloudSettings.source_categories) { setSourceCategories(cloudSettings.source_categories); saveSourceCategories(cloudSettings.source_categories) }
        if (cloudSettings.user_tags) { setUserTags(cloudSettings.user_tags); saveUserTags(cloudSettings.user_tags) }
      }
      setSyncStatus('synced')
    } catch {
      setSyncStatus('error')
    }
  }, [])

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) loadFromCloud(session.user.id)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
      if (event === 'SIGNED_IN' && session?.user) {
        showToast(`✅ 登录成功：${session.user.email}`)
        setShowLoginModal(false)
        loadFromCloud(session.user.id)
        trackEvent(session.user.id, 'login', { email: session.user.email })
      }
      if (event === 'SIGNED_OUT') showToast('已退出登录', 'info')
    })
    return () => subscription.unsubscribe()
  }, [loadFromCloud, showToast])

  useEffect(() => { saveData(points) }, [points])
  useEffect(() => { saveUserTags(userTags) }, [userTags])
  useEffect(() => { saveFavorites(favorites) }, [favorites])
  useEffect(() => { trackEvent(null, 'page_view') }, [])
  useEffect(() => { saveSourceNames(sourceNames) }, [sourceNames])
  useEffect(() => { saveSourceCategories(sourceCategories) }, [sourceCategories])

  // Debounced cloud sync for points
  useEffect(() => {
    if (!user?.id || !supabase) return
    clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      setSyncStatus('syncing')
      syncPointsToCloud(user.id, points)
        .then(() => setSyncStatus('synced'))
        .catch(() => setSyncStatus('error'))
    }, 3000)
  }, [points, user?.id])

  // Cloud sync for settings
  useEffect(() => {
    if (!user?.id || !supabase) return
    syncSettingsToCloud(user.id, {
      source_names: sourceNames,
      source_categories: sourceCategories,
      user_tags: userTags,
    }).catch(console.error)
  }, [userTags, sourceNames, sourceCategories, user?.id])

  const handleGoogleLogin = async () => {
    if (!supabase) {
      showToast('登录服务未初始化，请刷新页面', 'error')
      return
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    })
    if (error) showToast('登录失败：' + error.message, 'error')
  }

  const handleLogout = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    setUser(null)
    setSyncStatus('idle')
  }

  const openAnnouncement = () => {
    localStorage.setItem('tr_seen_version', LATEST_VERSION)
    setShowAnnouncement(true)
  }

  const openAdminDash = async () => {
    setShowAdminDash(true)
    if (!adminData) {
      const data = await loadAnalyticsData()
      setAdminData(data)
    }
  }

  // Settings modal
  const [showSettings, setShowSettings] = useState(false)
  const [settingsGroqKey, setSettingsGroqKey] = useState(() => localStorage.getItem('user_groq_key') || '')
  const [settingsGeminiKey, setSettingsGeminiKey] = useState(() => localStorage.getItem('user_gemini_key') || '')

  const saveSettings = () => {
    if (settingsGroqKey.trim()) localStorage.setItem('user_groq_key', settingsGroqKey.trim())
    else localStorage.removeItem('user_groq_key')
    if (settingsGeminiKey.trim()) localStorage.setItem('user_gemini_key', settingsGeminiKey.trim())
    else localStorage.removeItem('user_gemini_key')
    setShowSettings(false)
    showToast('✅ 设置已保存')
  }

  const addPoints = (newPoints) => {
    setPoints(prev => {
      const updated = [...prev]
      newPoints.forEach(newP => {
        const existingIdx = updated.findIndex(p => getPointKey(p) === getPointKey(newP))
        if (existingIdx >= 0) {
          updated[existingIdx] = mergePoint(updated[existingIdx], newP)
        } else {
          updated.push(newP)
        }
      })
      return updated
    })
  }

  const renameSource = (sourceId, name) => {
    if (!name) return
    setSourceNames(prev => ({ ...prev, [sourceId]: name }))
  }

  const deletePoint = (pointId) => {
    setPoints(prev => prev.filter(p => p.id !== pointId))
  }

  const toggleFavorite = (pointId) => {
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(pointId)) next.delete(pointId)
      else next.add(pointId)
      return next
    })
  }

  const updateGrammarStyle = (pointId, style) => {
    setPoints(prev => prev.map(p => p.id === pointId ? { ...p, grammarStyle: style } : p))
  }

  const updatePointExample = (pointId, example, exampleCN) => {
    setPoints(prev => prev.map(p =>
      String(p.id) === String(pointId) ? { ...p, example, ...(exampleCN ? { exampleCN } : {}) } : p
    ))
  }

  const assignSourceCategory = (sourceId, category) => {
    setSourceCategories(prev => {
      const next = { ...prev }
      if (category) next[sourceId] = category
      else delete next[sourceId]
      return next
    })
  }

  const reviewPoint = (pointId, known) => {
    setPoints(prev => prev.map(p => {
      if (String(p.id) !== String(pointId)) return p
      const score = Math.max(0, (p.memoryScore || 0) + (known ? 1 : -1))
      const now = new Date()
      const days = known ? Math.max(1, score) : 0.25 // forgot → review in 6h
      const next = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
      return { ...p, memoryScore: score, reviewCount: (p.reviewCount || 0) + 1, lastReviewedAt: now.toISOString(), nextReviewAt: next.toISOString() }
    }))
  }

  const deleteCategory = (categoryName) => {
    setSourceCategories(prev => {
      const next = { ...prev }
      Object.keys(next).forEach(sid => { if (next[sid] === categoryName) delete next[sid] })
      return next
    })
  }

  const mergeSources = (sourceIds, mergedName) => {
    if (sourceIds.length < 2) return
    const mergedSourceId = `merged-${Date.now()}`
    const mergedSource = { id: mergedSourceId, title: mergedName, kind: 'merged', size: 0, addedAt: new Date().toISOString() }
    const idSet = new Set(sourceIds)
    setPoints(prev => {
      const toMerge = prev.filter(p => idSet.has((p.source || defaultSource).id))
      const rest = prev.filter(p => !idSet.has((p.source || defaultSource).id))
      // build key set from rest to dedup against existing points
      const restKeys = new Map(rest.map(p => [getPointKey(p), p]))
      // dedup within toMerge, then dedup against rest
      const merged = new Map()
      toMerge.forEach(p => {
        const key = getPointKey(p)
        if (merged.has(key)) {
          merged.get(key).occurrenceCount = (merged.get(key).occurrenceCount || 1) + 1
        } else {
          merged.set(key, { ...p, source: mergedSource })
        }
      })
      // for keys already in rest, bump occurrenceCount there instead of adding duplicate
      merged.forEach((p, key) => {
        if (restKeys.has(key)) {
          restKeys.get(key).occurrenceCount = (restKeys.get(key).occurrenceCount || 1) + (p.occurrenceCount || 1)
          merged.delete(key)
        }
      })
      return [...rest, ...merged.values()]
    })
    // carry over the category from the first selected source
    setSourceCategories(prev => {
      const next = { ...prev }
      const cat = sourceIds.map(id => prev[id]).find(Boolean)
      sourceIds.forEach(id => delete next[id])
      if (cat) next[mergedSourceId] = cat
      return next
    })
    setSourceNames(prev => {
      const next = { ...prev }
      sourceIds.forEach(id => delete next[id])
      next[mergedSourceId] = mergedName
      return next
    })
  }

  const createTag = (name) => {
    setUserTags(prev => prev.includes(name) ? prev : [...prev, name])
  }

  const updatePointCustomTags = (pointId, tag, active) => {
    setPoints(prev => prev.map(p => {
      if (p.id !== pointId) return p
      const tags = p.customTags || []
      return {
        ...p,
        customTags: active ? (tags.includes(tag) ? tags : [...tags, tag]) : tags.filter(t => t !== tag),
      }
    }))
  }

  const clearAll = () => {
    if (confirm('确定要清空所有考点吗？')) {
      setPoints([])
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <h1 className="text-xl font-bold text-gray-900">
              📝 TestRecall
            </h1>
            <div className="flex items-center gap-3">
              {/* Announcement */}
              <button onClick={openAnnouncement} className="relative flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg px-2.5 py-1.5 transition-colors">
                🔔 公告
                {hasNewAnnouncement && <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />}
              </button>
              {/* Contact */}
              <button onClick={() => setShowContact(true)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg px-2.5 py-1.5 transition-colors">
                💬 联系
              </button>
              {/* Admin dashboard */}
              {user?.email === ADMIN_EMAIL && (
                <button onClick={openAdminDash} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg px-2.5 py-1.5 transition-colors">
                  📊 后台
                </button>
              )}
              {supabase && (
                user ? (
                  <div className="flex items-center gap-2">
                    {user.email === ADMIN_EMAIL && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">👑 管理员</span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${syncStatus === 'synced' ? 'bg-green-100 text-green-700' : syncStatus === 'syncing' ? 'bg-yellow-100 text-yellow-700' : syncStatus === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                      {syncStatus === 'synced' ? '☁️ 已同步' : syncStatus === 'syncing' ? '⏳ 同步中' : syncStatus === 'error' ? '❌ 同步失败' : '☁️ 云同步'}
                    </span>
                    <span className="text-xs text-gray-400 hidden sm:block">{user.email}</span>
                    <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-gray-600">退出</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowLoginModal(true)}
                    className="text-xs bg-blue-50 border border-blue-200 text-blue-600 rounded-lg px-3 py-1.5 hover:bg-blue-100"
                  >
                    登录同步
                  </button>
                )
              )}
              <button
                onClick={() => { setSettingsGroqKey(localStorage.getItem('user_groq_key') || ''); setSettingsGeminiKey(localStorage.getItem('user_gemini_key') || ''); setShowSettings(true) }}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg px-2.5 py-1.5 transition-colors"
              >
                ⚙️ API设置
              </button>
              <button
                onClick={clearAll}
                className="text-sm text-gray-500 hover:text-red-600 transition-colors"
              >
                清空数据
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4">
          <div className="flex gap-1">
            {[
              { id: 'scan', icon: '📷', label: '扫描' },
              { id: 'points', icon: '📚', label: '考点' },
              { id: 'favorites', icon: '⭐', label: `收藏${favorites.size > 0 ? `(${favorites.size})` : ''}` },
              { id: 'cards', icon: '🃏', label: '卡片' },
              { id: 'stats', icon: '📊', label: '统计' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`px-6 py-4 text-sm font-medium transition-colors border-b-2 ${
                  view === item.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <span className="mr-2">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="py-8 px-4">
        {view === 'scan' && <ScanView onAddPoints={addPoints} isAdmin={user?.email === ADMIN_EMAIL} onOpenSettings={() => { setSettingsGroqKey(localStorage.getItem('user_groq_key') || ''); setSettingsGeminiKey(localStorage.getItem('user_gemini_key') || ''); setShowSettings(true) }} />}
        {view === 'points' && <PointsListView points={points} userTags={userTags} onUpdatePointTags={updatePointCustomTags} onCreateTag={createTag} onAddPoint={p => addPoints([p])} sourceNames={sourceNames} onRenameSource={renameSource} sourceCategories={sourceCategories} onAssignSourceCategory={assignSourceCategory} onDeletePoint={deletePoint} onUpdatePointExample={updatePointExample} onUpdateGrammarStyle={updateGrammarStyle} onMergeSources={mergeSources} onDeleteCategory={deleteCategory} favorites={favorites} onToggleFavorite={toggleFavorite} selectedFolder={pointsFolder} setSelectedFolder={setPointsFolder} />}
        {view === 'favorites' && <FavoritesView points={points} favorites={favorites} onToggleFavorite={toggleFavorite} onDeletePoint={deletePoint} />}
        {view === 'cards' && <FlashcardView points={points} sourceNames={sourceNames} sourceCategories={sourceCategories} onReview={reviewPoint} />}
        {view === 'stats' && <StatisticsView points={points} />}
      </main>

      {/* Footer */}
      <footer className="text-center py-6 text-sm text-gray-400">
        TestRecall - JLPT 日语考点记忆助手
      </footer>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all ${toast.type === 'success' ? 'bg-green-600' : toast.type === 'error' ? 'bg-red-600' : 'bg-gray-700'}`}>
          {toast.msg}
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowSettings(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">⚙️ API Key 设置</h2>
            <p className="text-sm text-gray-500 mb-5">填入你自己的免费 API Key，数据保存在本设备</p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Groq API Key <span className="text-xs text-gray-400">（用于文字提取分析）</span></label>
              <input
                type="password"
                placeholder="gsk_..."
                value={settingsGroqKey}
                onChange={e => setSettingsGroqKey(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline mt-1 inline-block">
                → 免费获取 Groq Key（console.groq.com）
              </a>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">Gemini API Key <span className="text-xs text-gray-400">（用于图片/PDF识别）</span></label>
              <input
                type="password"
                placeholder="AIza..."
                value={settingsGeminiKey}
                onChange={e => setSettingsGeminiKey(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline mt-1 inline-block">
                → 免费获取 Gemini Key（aistudio.google.com）
              </a>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-5 text-xs text-blue-700">
              Key 仅存储在你的本地浏览器，不会上传至服务器，网站作者无法获取。
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowSettings(false)} className="flex-1 border border-gray-300 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">取消</button>
              <button onClick={saveSettings} className="flex-1 bg-blue-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-blue-700">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Welcome / Onboarding Modal */}
      {showWelcome && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            {/* Header */}
            <div className="bg-gradient-to-br from-blue-500 to-indigo-600 px-6 pt-8 pb-6 text-white text-center">
              <div className="text-5xl mb-3">📝</div>
              <h2 className="text-xl font-bold mb-1">欢迎使用 TestRecall</h2>
              <p className="text-blue-100 text-sm">JLPT 日语考点记忆助手</p>
            </div>
            {/* Body */}
            <div className="px-6 py-5">
              <p className="text-sm text-gray-600 mb-4">使用 AI 扫描功能前，需要先配置免费的 API Key（30 秒搞定）：</p>
              <div className="space-y-3 mb-5">
                <div className="flex gap-3 items-start bg-orange-50 rounded-xl p-3">
                  <span className="text-xl flex-shrink-0">🤖</span>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Groq API Key</p>
                    <p className="text-xs text-gray-500 mt-0.5">用于文字识别和考点提取，免费无限量</p>
                    <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">→ console.groq.com 免费注册获取</a>
                  </div>
                </div>
                <div className="flex gap-3 items-start bg-purple-50 rounded-xl p-3">
                  <span className="text-xl flex-shrink-0">👁️</span>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Gemini API Key</p>
                    <p className="text-xs text-gray-500 mt-0.5">用于识别图片和 PDF 内容，免费额度充足</p>
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">→ aistudio.google.com 免费获取</a>
                  </div>
                </div>
              </div>
              <button
                onClick={() => {
                  localStorage.setItem('tr_welcomed', '1')
                  setShowWelcome(false)
                  setSettingsGroqKey(localStorage.getItem('user_groq_key') || '')
                  setSettingsGeminiKey(localStorage.getItem('user_gemini_key') || '')
                  setShowSettings(true)
                }}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-3 text-sm font-semibold transition-colors mb-2"
              >
                ⚙️ 立即去设置 API Key
              </button>
              <button
                onClick={() => { localStorage.setItem('tr_welcomed', '1'); setShowWelcome(false) }}
                className="w-full text-xs text-gray-400 hover:text-gray-600 py-2"
              >
                稍后再说，先看看功能
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Announcement Modal */}
      {showAnnouncement && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowAnnouncement(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">📢 更新公告</h2>
            {CHANGELOG.map(log => (
              <div key={log.version} className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-lg">{log.version}</span>
                  <span className="text-xs text-gray-400">{log.date}</span>
                </div>
                <ul className="space-y-1">
                  {log.items.map((item, i) => (
                    <li key={i} className="text-sm text-gray-700 flex gap-2"><span className="text-green-500 flex-shrink-0">✓</span>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
            <button onClick={() => setShowAnnouncement(false)} className="w-full mt-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl py-2.5 text-sm font-medium">关闭</button>
          </div>
        </div>
      )}

      {/* Contact Modal */}
      {showContact && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowContact(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm text-center" onClick={e => e.stopPropagation()}>
            <div className="text-4xl mb-3">👨‍💻</div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">联系开发者</h2>
            <p className="text-sm text-gray-500 mb-4">有问题、建议或合作，欢迎联系</p>
            <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3 mb-4">
              <p className="text-xs text-gray-500 mb-1">小红书 ID</p>
              <p className="text-lg font-bold text-red-500 tracking-widest">5021354276</p>
            </div>
            <p className="text-xs text-gray-400 mb-4">在小红书搜索此 ID 即可找到我</p>
            <button onClick={() => setShowContact(false)} className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl py-2.5 text-sm font-medium">关闭</button>
          </div>
        </div>
      )}

      {/* Admin Dashboard Modal */}
      {showAdminDash && user?.email === ADMIN_EMAIL && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowAdminDash(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">📊 管理员后台</h2>
            {!adminData ? (
              <p className="text-sm text-gray-400 text-center py-8">加载中…</p>
            ) : (() => {
              const events = adminData.events || []
              const users = adminData.users || []
              const now = Date.now()
              const day = 86400000
              const uniqueUsers = new Set(events.filter(e => e.user_id).map(e => e.user_id))
              const activeToday = new Set(events.filter(e => e.user_id && now - new Date(e.created_at).getTime() < day).map(e => e.user_id))
              const activeWeek = new Set(events.filter(e => e.user_id && now - new Date(e.created_at).getTime() < 7 * day).map(e => e.user_id))
              const eventCounts = events.reduce((acc, e) => { acc[e.event_name] = (acc[e.event_name] || 0) + 1; return acc }, {})
              const topEvents = Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: '注册用户', value: users.length || uniqueUsers.size },
                      { label: '今日活跃', value: activeToday.size },
                      { label: '本周活跃', value: activeWeek.size },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-blue-50 rounded-xl p-3 text-center">
                        <p className="text-2xl font-bold text-blue-700">{value}</p>
                        <p className="text-xs text-blue-500 mt-1">{label}</p>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">操作统计（总计 {events.length} 次）</p>
                    <div className="space-y-1.5">
                      {topEvents.map(([name, count]) => (
                        <div key={name} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 w-32 truncate">{name}</span>
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${Math.round(count / events.length * 100)}%` }} />
                          </div>
                          <span className="text-xs text-gray-500 w-8 text-right">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">最近动态</p>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {events.slice(0, 20).map((e, i) => (
                        <div key={i} className="text-xs text-gray-500 flex gap-2">
                          <span className="text-gray-300">{new Date(e.created_at).toLocaleString('zh')}</span>
                          <span className="font-medium text-gray-700">{e.event_name}</span>
                          <span className="text-gray-400 truncate">{e.user_id?.slice(0, 8) || '匿名'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <button onClick={async () => { setAdminData(null); const d = await loadAnalyticsData(); setAdminData(d) }} className="w-full text-xs text-blue-500 hover:text-blue-700 py-1">刷新数据</button>
                </div>
              )
            })()}
            <button onClick={() => setShowAdminDash(false)} className="w-full mt-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl py-2.5 text-sm font-medium">关闭</button>
          </div>
        </div>
      )}

      {/* Login Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowLoginModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">登录账号</h2>
            <p className="text-sm text-gray-500 mb-6">登录后数据自动云端同步，多设备共享</p>
            <button
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-3 border border-gray-300 rounded-xl py-3 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              使用 Google 账号登录
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
