import { useState, useEffect, useRef } from 'react'
import Tesseract from 'tesseract.js'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Groq API — text extraction & normalization
const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY || ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_TEXT_MODEL = 'llama-3.3-70b-versatile'

// Gemini API — image vision (much better Japanese OCR, free tier)
const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY || ''
const GEMINI_VISION_MODEL = 'gemini-2.0-flash'

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
    description: '句型、接续、语气和易混语法',
    types: ['grammar'],
  },
]

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

const EXTRACTION_RULES = `
类型：
- grammar = N1级别语法句型，通常是复合助词或接续形式，例：〜にもかかわらず・〜を皮切りに・〜に際して・〜ずにはおかない・〜かねない・〜をもって・〜に至る。注意：〜ておく・〜てみる・〜ばかり・〜はず・〜わけ・〜なくても 等N4-N5基础语法【不要提取】
- collocation = 两词以上的惯用表达，整体含义无法从各词字面推导（例：気が置けない・手が込む・目を見張る）。普通的「名词+助词」短语不是collocation
- vocabulary = 单个词汇（名词/动词/形容词/副词），动词写辞书形

提取要求：
1. 所有词汇都要提取，不因"太普通"跳过（只排除する/ある/いる/行く/来る/見る等极基础动词、助词、数字）
2. 题干中被考察的词必须提取
3. 4个选项全部检查；选项是完整句子时，拆出各关键词单独提取，不要整句归为collocation
4. 不提取「文法」「語彙」「読解」「聴解」等章节标题`

const JSON_EXAMPLE = `[{"term":"もくろむ","type":"vocabulary","reading":"もくろむ","meaning_cn":"图谋、策划"},
 {"term":"〜にもかかわらず","type":"grammar","meaning_cn":"尽管...","connection":"普通形+にもかかわらず"},
 {"term":"気が置けない","type":"collocation","meaning_cn":"不必拘束、可以推心置腹"}]`

const TEXT_USER_PROMPT = `从以下文本提取所有考点，不得遗漏。${EXTRACTION_RULES}

只返回JSON数组：${JSON_EXAMPLE}

文本：
`

const VISION_PROMPT = `这是JLPT日语考试题目图片，仔细识别所有文字，提取所有考点，不得遗漏。${EXTRACTION_RULES}

只返回JSON数组：${JSON_EXAMPLE}`

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

const callGeminiVision = async (imageDataUrl, prompt) => {
  const [header, base64Data] = imageDataUrl.split(',')
  const mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg'

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: prompt },
        ]}],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error?.message || `Gemini API错误 (${response.status})`)
  }
  const data = await response.json()
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error('Gemini未返回有效内容')
  return content
}

const callGroq = async (messages, model, temperature = 0.2) => {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 8192 }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error?.message || 'Groq API请求失败')
  }
  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('未获取到有效响应')
  return content
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
  const input = toFix.map(c => ({ id: c.id, term: c.term }))
  try {
    const content = await callGroq(
      [
        { role: 'system', content: '你是日语语法专家。只返回JSON数组，不要其他文字。' },
        {
          role: 'user',
          content: `将以下日语词汇的term字段全部转为辞书形（原形），id字段原样保留：
・动词活用形→辞书形：した/される/された/している/していた→する；んでいる→む；いでいる→ぐ；てきた→てくる；など
・形容词变形→辞书形：くて/くない/かった→い形原形
・名词、副词、惯用句：不变，原样保留
输入：${JSON.stringify(input)}
输出：同格式JSON数组，只修改需要还原的term，不需要还原的也原样返回。`,
        },
      ],
      GROQ_TEXT_MODEL,
      0,
    )
    const normalized = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || '[]')
    const normMap = Object.fromEntries(normalized.map(n => [n.id, n.term]).filter(([, t]) => t))
    return candidates.map(c => (normMap[c.id] ? { ...c, term: normMap[c.id] } : c))
  } catch {
    return candidates
  }
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
            支持 PDF、图片（JPG/PNG/GIF/WebP）识别正文和手写批注，或文本文件（TXT/MD）
          </div>
        </div>
      )}
    </div>
  )
}

// Scan View Component
function ScanView({ onAddPoints }) {
  const [text, setText] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState({})
  const [hasExtractedText, setHasExtractedText] = useState(false)
  const [source, setSource] = useState(defaultSource)
  const [extractionSuccess, setExtractionSuccess] = useState(false)

  const handleAnalyze = async () => {
    if (!text.trim() && !imageDataUrl) return

    setLoading(true)
    setError('')
    setCandidates([])
    setSelected({})
    setExtractionSuccess(false)

    try {
      let content
      if (imageDataUrl) {
        content = await callGeminiVision(imageDataUrl, VISION_PROMPT)
      } else {
        content = await callGroq(
          [
            { role: 'system', content: TEXT_SYSTEM_PROMPT },
            { role: 'user', content: TEXT_USER_PROMPT + text },
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

      // normalize dict forms in background, update terms when done
      normalizeDictForms(sorted).then(normalized => {
        setCandidates(normalized)
      }).catch(() => {})
    } catch (err) {
      setError(err.message || '分析失败，请重试')
    } finally {
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
        
        <button
          onClick={handleAnalyze}
          disabled={loading || (!text.trim() && !imageDataUrl)}
          className="mt-4 w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              AI 分析中...
            </span>
          ) : '🔍 AI 分析提取考点'}
        </button>

        {(!GROQ_KEY || !GEMINI_KEY) && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            {!GROQ_KEY && <div>需要配置 <code>VITE_GROQ_API_KEY</code>（文字提取）</div>}
            {!GEMINI_KEY && <div>需要配置 <code>VITE_GEMINI_API_KEY</code>（图片识别，从 aistudio.google.com 免费获取）</div>}
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

// Points List View Component
function PointsListView({ points }) {
  const sourceGroups = Object.values(groupBySource(points))

  if (points.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <div className="text-6xl mb-4">📚</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">还没有考点</h2>
        <p className="text-gray-500">去「扫描」页面添加一些文件、图片或文本吧</p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-2">📚 考点列表</h2>
      <p className="text-sm text-gray-500 mb-6">
        按上传文件或图片归档，考点按单词、语法、阅读、听力整理。
      </p>

      <div className="space-y-8">
        {sourceGroups.map(({ source, points: sourcePoints }) => (
          <section key={source.id || getSourceLabel(source)} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-1">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{getSourceLabel(source)}</h3>
                  <div className="text-sm text-gray-500">
                    {getSourceKindLabel(source.kind)}{source.size ? ` · ${formatFileSize(source.size)}` : ''} · {sourcePoints.length} 个考点
                  </div>
                </div>
                {source.addedAt && (
                  <div className="text-sm text-gray-400">
                    {formatDate(source.addedAt)}
                  </div>
                )}
              </div>
            </div>

            <div className="divide-y divide-gray-100">
              {STUDY_SECTIONS.map((section, sectionIndex) => {
                const sectionPoints = sourcePoints.filter(point => section.types.includes(point.type))
                return (
                  <div key={section.id} className="px-5 py-5">
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">
                          {sectionIndex + 1}、{section.title}
                        </h4>
                        <p className="text-sm text-gray-500">{section.description}</p>
                      </div>
                      <span className="text-sm text-gray-400 shrink-0">{sectionPoints.length} 条</span>
                    </div>

                    {sectionPoints.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="text-xs text-gray-500 border-b border-gray-100">
                            <tr>
                              <th className="py-2 pr-3 font-medium">考点</th>
                              <th className="py-2 px-3 font-medium hidden md:table-cell">读音/级别</th>
                              <th className="py-2 px-3 font-medium">中文说明</th>
                              <th className="py-2 pl-3 font-medium hidden lg:table-cell">例句/提示</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {sectionPoints.map((point) => {
                              const colors = TYPE_COLORS[point.type] || TYPE_COLORS.vocabulary
                              return (
                                <tr key={point.id} className="align-top">
                                  <td className="py-3 pr-3">
                                    <div className="font-semibold text-gray-900">{point.term}</div>
                                    <div className="mt-1 flex gap-1.5 flex-wrap">
                                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors.bg} ${colors.text}`}>
                                        {TYPE_LABELS[point.type]}
                                      </span>
                                      {(point.occurrenceCount || 1) > 1 && (
                                        <span className="px-2 py-0.5 rounded bg-gray-100 text-xs text-gray-500">
                                          ×{point.occurrenceCount}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-3 px-3 text-gray-600 hidden md:table-cell">
                                    {point.reading || point.level || point.partOfSpeech || '-'}
                                  </td>
                                  <td className="py-3 px-3 text-gray-700">
                                    {point.meaningCN || point.usage || point.nuance || '-'}
                                    {point.connection && (
                                      <div className="mt-1 text-xs text-gray-500">接续：{point.connection}</div>
                                    )}
                                  </td>
                                  <td className="py-3 pl-3 text-gray-600 hidden lg:table-cell">
                                    {point.example || point.usage || '-'}
                                    {point.related?.length > 0 && (
                                      <div className="mt-1 text-xs text-gray-400">
                                        相关：{point.related.join('、')}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="text-sm text-gray-400 py-2">暂无该类考点</div>
                    )}
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
function StatisticsView({ points }) {
  const typeCount = points.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1
    return acc
  }, {})

  const dueCount = points.filter(p => !p.nextReviewAt || new Date(p.nextReviewAt) <= new Date()).length
  const reviewedCount = points.filter(p => p.lastReviewedAt).length
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

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-3xl font-bold text-blue-600">{points.length}</div>
          <div className="text-sm text-gray-500">总考点数</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-3xl font-bold text-orange-600">{dueCount}</div>
          <div className="text-sm text-gray-500">待复习</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-3xl font-bold text-green-600">{reviewedCount}</div>
          <div className="text-sm text-gray-500">已复习</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-3xl font-bold text-purple-600">{Object.keys(typeCount).length}</div>
          <div className="text-sm text-gray-500">类型数</div>
        </div>
      </div>

      {/* Type Distribution */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">类型分布</h3>
        <div className="space-y-3">
          {Object.entries(typeCount).map(([type, count]) => {
            const colors = TYPE_COLORS[type] || TYPE_COLORS.vocabulary
            const percentage = Math.round((count / points.length) * 100)
            return (
              <div key={type} className="flex items-center gap-4">
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${colors.bg} ${colors.text}`}>
                  {TYPE_LABELS[type]}
                </span>
                <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                  <div
                    className={`h-full ${colors.bg.replace('100', '500')}`}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-600 w-16 text-right">
                  {count} ({percentage}%)
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* High Frequency Points */}
      {uniquePoints.filter(p => (p.occurrenceCount || 1) >= 2).length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">🔥 高频考点</h3>
          <div className="space-y-2">
            {uniquePoints.filter(p => (p.occurrenceCount || 1) >= 2).slice(0, 10).map((p, idx) => {
              const colors = TYPE_COLORS[p.type] || TYPE_COLORS.vocabulary
              return (
                <div key={idx} className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg">
                  <span className="text-2xl font-bold text-gray-400 w-8">{idx + 1}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-900">{p.term}</span>
                      {p.reading && <span className="text-sm text-gray-500">({p.reading})</span>}
                    </div>
                    {p.meaningCN && <div className="text-sm text-gray-600">{p.meaningCN}</div>}
                  </div>
                  <span className={`px-2 py-1 rounded text-sm font-bold ${colors.bg} ${colors.text}`}>
                    ×{p.occurrenceCount || 1}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// Main App Component
function App() {
  const [view, setView] = useState('scan')
  const [points, setPoints] = useState(loadData)

  useEffect(() => {
    saveData(points)
  }, [points])

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
            <button
              onClick={clearAll}
              className="text-sm text-gray-500 hover:text-red-600 transition-colors"
            >
              清空数据
            </button>
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
        {view === 'scan' && <ScanView onAddPoints={addPoints} />}
        {view === 'points' && <PointsListView points={points} />}
        {view === 'stats' && <StatisticsView points={points} />}
      </main>

      {/* Footer */}
      <footer className="text-center py-6 text-sm text-gray-400">
        TestRecall - JLPT 日语考点记忆助手
      </footer>
    </div>
  )
}

export default App
