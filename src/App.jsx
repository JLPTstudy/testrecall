import { useState, useEffect, useRef } from 'react'
import Tesseract from 'tesseract.js'

// Groq API (free tier)
const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY || ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

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

// AI Prompt for text analysis
const AI_PROMPT = `你是一个JLPT日语考点提取专家。请从以下日语文本中，提取值得记忆的考点。

考点类型包括：
1. vocabulary - 单词（名词、动词、形容词等）
2. grammar - 语法（语法点、句型）
3. collocation - 搭配（固定搭配）
4. expression - 表达（常用表达）

对于每个考点，请提供：
- term: 考点原文
- type: 类型（vocabulary/grammar/collocation/expression）
- reading: 读音（平假名，如果是单词的话）
- meaning_cn: 中文意思
- part_of_speech: 词性（如果是单词）
- example: 例句（从原文中提取或生成）
- related: 相关词汇数组
- source_exam: 来源（如果文本中包含考试信息）

请以JSON数组格式返回，格式如下：
[
  {
    "type": "vocabulary",
    "term": "態度",
    "reading": "たいど",
    "meaning_cn": "态度",
    "part_of_speech": "名词",
    "example": "彼の態度は失礼だった。",
    "related": ["振る舞い", "対応"],
    "source_exam": "2024.12 JLPT N1"
  }
]

只返回JSON数组，不要其他解释文字。

待分析文本：
`


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

      if (imageExts.includes(ext)) {
        // Image: use Tesseract.js OCR (free, no API needed)
        setPreviewUrl(URL.createObjectURL(file))
        setUploading(true) // restore uploading state

        try {
          const result = await Tesseract.recognize(file, 'jpn', {
            logger: () => {}
          })
          const text = result.data.text
          if (!text.trim()) throw new Error('未能从图片中提取到文字，请确保图片清晰且包含日语文本')
          onTextExtracted(text.trim())
        } catch (err) {
          onError(err.message || 'OCR识别失败')
        } finally {
          setUploading(false)
        }
      } else if (textExts.includes(ext)) {
        // Text file: read directly
        const text = await file.text()
        if (!text.trim()) throw new Error('文件内容为空')
        onTextExtracted(text)
      } else {
        throw new Error(`暂不支持 ${ext} 格式，支持的图片格式：JPG、PNG、GIF、WebP，支持的文本格式：TXT、MD`)
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
        accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,.heic,.heif,.txt,.md,.text"
        onChange={handleInputChange}
        className="hidden"
      />

      {uploading ? (
        <div className="flex flex-col items-center gap-2">
          <svg className="animate-spin h-8 w-8 text-blue-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-gray-600">正在识别文字...</span>
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
            支持图片（JPG/PNG/GIF/WebP）AI识别文字，或文本文件（TXT/MD）
          </div>
        </div>
      )}
    </div>
  )
}

// Scan View Component
function ScanView({ onAddPoints }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState({})
  const [hasExtractedText, setHasExtractedText] = useState(false)

  const handleAnalyze = async () => {
    if (!text.trim()) return
    
    setLoading(true)
    setError('')
    setCandidates([])
    setSelected({})

    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: '你是JLPT日语考点提取专家，擅长从日语文本中识别值得记忆的单词、语法、搭配和表达。只返回JSON数组，不要其他文字。' },
            { role: 'user', content: AI_PROMPT + text }
          ],
          temperature: 0.3,
          max_tokens: 4096,
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error?.message || 'Groq API请求失败')
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content

      if (!content) throw new Error('未获取到有效响应')

      // Extract JSON from response
      let jsonStr = content
      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (jsonMatch) jsonStr = jsonMatch[0]

      const parsed = JSON.parse(jsonStr)
      
      const newCandidates = parsed.map((item, idx) => ({
        id: Date.now() + idx,
        type: item.type || 'vocabulary',
        term: item.term || '',
        reading: item.reading || null,
        meaningCN: item.meaning_cn || null,
        partOfSpeech: item.part_of_speech || null,
        example: item.example || null,
        related: item.related || null,
        sourceExam: item.source_exam || null,
        isSelected: true,
      }))

      setCandidates(newCandidates)
      const initialSelected = {}
      newCandidates.forEach(c => { initialSelected[c.id] = true })
      setSelected(initialSelected)
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
    
    const newPoints = toAdd.map(c => ({
      id: c.id,
      type: c.type,
      term: c.term,
      reading: c.reading,
      meaningCN: c.meaningCN,
      partOfSpeech: c.partOfSpeech,
      example: c.example,
      related: c.related,
      sourceExam: c.sourceExam,
      occurrenceCount: 1,
      createdAt: new Date().toISOString(),
      lastReviewedAt: null,
    }))
    
    onAddPoints(newPoints)
    setText('')
    setCandidates([])
    setSelected({})
    setHasExtractedText(false)
  }

  const handleTextExtracted = (extractedText) => {
    setText(extractedText)
    setHasExtractedText(true)
    setError('')
    setCandidates([])
    setSelected({})
  }

  const handleFileError = (errMsg) => {
    setError(errMsg)
  }

  const handleTextChange = (newText) => {
    setText(newText)
    setHasExtractedText(false)
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">📷 扫描考点</h2>
      
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          输入日语文本
        </label>
        <textarea
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder="粘贴或输入日语文本..."
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
            <span>文字已提取，可直接点击分析</span>
          </div>
        )}
        
        <button
          onClick={handleAnalyze}
          disabled={loading || !text.trim()}
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

// Cards View Component
function CardsView({ points }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isFlipped, setIsFlipped] = useState(false)
  const [filter, setFilter] = useState('all')

  const filteredPoints = points.filter(p => {
    if (filter !== 'all' && p.type !== filter) return false
    return true
  })

  const handleNext = () => {
    if (currentIndex < filteredPoints.length - 1) {
      setCurrentIndex(currentIndex + 1)
      setIsFlipped(false)
    }
  }

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
      setIsFlipped(false)
    }
  }

  const handleFlip = () => {
    setIsFlipped(!isFlipped)
  }

  if (points.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <div className="text-6xl mb-4">📚</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">还没有考点</h2>
        <p className="text-gray-500">去「扫描」页面添加一些考点吧</p>
      </div>
    )
  }

  if (filteredPoints.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <div className="text-6xl mb-4">🔍</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">没有匹配的考点</h2>
        <p className="text-gray-500">试试切换筛选条件</p>
      </div>
    )
  }

  const current = filteredPoints[currentIndex]
  const colors = TYPE_COLORS[current.type] || TYPE_COLORS.vocabulary

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">📚 考点卡片</h2>

      {/* Filter */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {['all', 'vocabulary', 'grammar', 'collocation', 'expression'].map((type) => (
          <button
            key={type}
            onClick={() => { setFilter(type); setCurrentIndex(0); setIsFlipped(false) }}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              filter === type
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {type === 'all' ? '全部' : TYPE_LABELS[type]}
          </button>
        ))}
      </div>

      {/* Progress */}
      <div className="mb-4 text-center text-sm text-gray-500">
        {currentIndex + 1} / {filteredPoints.length}
      </div>

      {/* Card */}
      <div className="relative" style={{ height: '400px' }}>
        <div
          onClick={handleFlip}
          className={`flip-card w-full h-full cursor-pointer ${isFlipped ? 'flipped' : ''}`}
        >
          <div className="flip-card-inner">
            {/* Front */}
            <div className="flip-card-front bg-white rounded-2xl shadow-lg border border-gray-200 p-8 flex flex-col items-center justify-center">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${colors.bg} ${colors.text} mb-4`}>
                {TYPE_LABELS[current.type]}
              </span>
              <div className="text-4xl font-bold text-gray-900 text-center mb-2">
                {current.term}
              </div>
              {current.reading && (
                <div className="text-xl text-gray-500 mb-4">{current.reading}</div>
              )}
              <div className="text-sm text-gray-400 mt-4">点击卡片查看答案</div>
            </div>

            {/* Back */}
            <div className="flip-card-back bg-white rounded-2xl shadow-lg border border-gray-200 p-8 flex flex-col items-center justify-center">
              <div className="text-3xl font-bold text-gray-900 text-center mb-4">
                {current.term}
              </div>
              {current.meaningCN && (
                <div className="text-xl text-blue-600 text-center mb-4">
                  {current.meaningCN}
                </div>
              )}
              {current.partOfSpeech && (
                <div className="text-sm text-gray-500 mb-2">{current.partOfSpeech}</div>
              )}
              {current.example && (
                <div className="mt-4 p-4 bg-gray-50 rounded-lg text-center">
                  <div className="text-sm text-gray-500 mb-1">例句</div>
                  <div className="text-gray-700 japanese-text">{current.example}</div>
                </div>
              )}
              {current.related && current.related.length > 0 && (
                <div className="mt-4">
                  <div className="text-sm text-gray-500 mb-2">相关词汇</div>
                  <div className="flex gap-2 flex-wrap justify-center">
                    {current.related.map((r, i) => (
                      <span key={i} className="px-2 py-1 bg-gray-100 rounded text-sm text-gray-700">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-center gap-4 mt-8">
        <button
          onClick={handlePrev}
          disabled={currentIndex === 0}
          className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          ← 上一张
        </button>
        <button
          onClick={handleFlip}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          {isFlipped ? '🔄 翻回正面' : '🔍 查看答案'}
        </button>
        <button
          onClick={handleNext}
          disabled={currentIndex === filteredPoints.length - 1}
          className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          下一张 →
        </button>
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

  const highFrequency = points.filter(p => {
    const existing = points.filter(x => x.term === p.term)
    return existing.length >= 2
  })

  const uniquePoints = Array.from(new Set(points.map(p => p.term))).map(term => {
    const same = points.filter(p => p.term === term)
    return {
      term,
      count: same.length,
      type: same[0].type,
      reading: same[0].reading,
      meaningCN: same[0].meaningCN,
    }
  }).sort((a, b) => b.count - a.count)

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
          <div className="text-3xl font-bold text-orange-600">{highFrequency.length}</div>
          <div className="text-sm text-gray-500">高频考点</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-3xl font-bold text-green-600">{uniquePoints.length}</div>
          <div className="text-sm text-gray-500">不重复考点</div>
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
      {uniquePoints.filter(p => p.count >= 2).length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">🔥 高频考点</h3>
          <div className="space-y-2">
            {uniquePoints.filter(p => p.count >= 2).slice(0, 10).map((p, idx) => {
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
                    ×{p.count}
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
        const existingIdx = updated.findIndex(p => p.term === newP.term)
        if (existingIdx >= 0) {
          updated[existingIdx] = {
            ...updated[existingIdx],
            occurrenceCount: updated[existingIdx].occurrenceCount + 1,
          }
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
              { id: 'cards', icon: '📚', label: '卡片' },
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
        {view === 'cards' && <CardsView points={points} />}
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
