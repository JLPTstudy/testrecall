#!/usr/bin/env python3
"""
Render each PDF page → Gemini vision → extract JLPT exam points → save JSON
"""
import fitz  # PyMuPDF
import base64, json, time, sys, re, os
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

PDF_PATH = "/Users/kongtiaoxulun/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/sunshuaiduo_bdc2/msg/file/2026-05/2021年12月N1真题 AI用.pdf"
GEMINI_KEY = "AIzaSyCoEdmYivnxDkGdMnlGCduOBqd5tOsA_l8"
GEMINI_MODEL = "gemini-2.5-flash"
OUT_FILE = "/Users/kongtiaoxulun/testrecall/scripts/extracted_points.json"
DPI = 150  # render resolution

SOURCE = {
    "id": "2021.12-n1-pdf",
    "title": "2021.12",
    "kind": "image",
    "size": 0,
    "addedAt": "2026-05-13T00:00:00.000Z"
}

VISION_PROMPT = """这是JLPT日语考试题目图片，仔细识别所有文字，提取所有考点，不得遗漏。
类型：
- grammar = N1/N2级别语法句型，通常是复合助词或接续形式，例：〜にもかかわらず・〜を皮切りに・〜に際して・〜ずにはおかない・〜かねない・〜をもって・〜に至る。注意：〜ておく・〜てみる・〜ばかり・〜はず・〜わけ・〜なくても 等N4-N5基础语法【不要提取】。grammar类型必须额外返回grammar_style字段：'daily'（日常口语/会话中常用）或'formal'（书面语/正式文章中使用）
- collocation = 两词以上的惯用表达，整体含义无法从各词字面推导（例：気が置けない・手が込む・目を見張る）。普通的「名词+助词」短语不是collocation
- vocabulary = N1/N2范围词汇（名词/动词/形容词/副词），动词写辞书形

提取要求：
1. 提取N1/N2范围内的词汇，不因"太普通"跳过（只排除する/ある/いる/行く/来る/見る等极基础动词、助词、数字）
2. 题干中被考察的词必须提取
3. 4个选项全部检查；选项是完整句子时，拆出各关键词单独提取，不要整句归为collocation
4. 不提取「文法」「語彙」「読解」「聴解」等章节标题

只返回JSON数组，不要任何其他文字：
[{"term":"もくろむ","type":"vocabulary","reading":"もくろむ","meaning_cn":"图谋、策划"},
 {"term":"〜にもかかわらず","type":"grammar","meaning_cn":"尽管...","connection":"普通形+にもかかわらず","grammar_style":"formal"},
 {"term":"気が置けない","type":"collocation","meaning_cn":"不必拘束、可以推心置腹"}]"""


def page_to_base64(page, dpi=150):
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
    return base64.b64encode(pix.tobytes("jpeg", jpg_quality=85)).decode()


def call_gemini(b64_image, retries=4):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
    body = json.dumps({
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": b64_image}},
            {"text": VISION_PROMPT}
        ]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 65536}
    }).encode()

    for attempt in range(retries):
        try:
            req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            text = next((p["text"] for p in parts if not p.get("thought")), None)
            if text:
                return text
            raise ValueError("empty response")
        except HTTPError as e:
            body_err = e.read().decode()
            print(f"    HTTP {e.code}: {body_err[:200]}")
            if e.code in (429, 503) and attempt < retries - 1:
                wait = 10 * (attempt + 1)
                print(f"    overloaded, wait {wait}s…")
                time.sleep(wait)
            else:
                raise
        except Exception as e:
            if attempt < retries - 1:
                print(f"    error: {e}, retry {attempt+1}")
                time.sleep(5)
            else:
                raise
    raise RuntimeError("all retries exhausted")


def parse_points(text, page_idx):
    m = re.search(r'\[[\s\S]*\]', text)
    if not m:
        return []
    try:
        items = json.loads(m.group())
    except json.JSONDecodeError:
        return []

    results = []
    now_ms = int(time.time() * 1000) + page_idx * 1000
    for i, item in enumerate(items):
        term = (item.get("term") or "").strip()
        if not term:
            continue
        typ = item.get("type", "vocabulary")
        if typ not in ("vocabulary", "grammar", "collocation", "expression"):
            typ = "vocabulary"
        results.append({
            "id": f"{now_ms}-{i}",
            "type": typ,
            "term": term,
            "reading": item.get("reading") or None,
            "meaningCN": item.get("meaning_cn") or item.get("meaningCN") or None,
            "meaningEN": item.get("meaning_en") or None,
            "partOfSpeech": item.get("part_of_speech") or None,
            "connection": item.get("connection") or None,
            "nuance": item.get("nuance") or None,
            "level": item.get("level") or None,
            "usage": item.get("usage") or None,
            "example": None,
            "exampleCN": None,
            "grammarStyle": item.get("grammar_style") or None,
            "related": [],
            "sourceExam": None,
            "source": SOURCE,
            "occurrenceCount": 1,
            "createdAt": "2026-05-13T00:00:00.000Z",
            "lastReviewedAt": None,
            "nextReviewAt": None,
            "reviewCount": 0,
            "memoryScore": 0,
        })
    return results


def get_key(p):
    return f"{p['type']}::{p['term'].lower().strip()}"


def main():
    doc = fitz.open(PDF_PATH)
    total = doc.page_count
    print(f"PDF: {total} 页")

    all_points = []
    seen = {}  # key -> index in all_points

    for page_idx in range(total):
        page = doc[page_idx]
        print(f"[{page_idx+1}/{total}] 渲染并分析…", end=" ", flush=True)

        b64 = page_to_base64(page, DPI)
        try:
            text = call_gemini(b64)
        except Exception as e:
            print(f"SKIP (error: {e})")
            continue

        points = parse_points(text, page_idx)
        new_count = 0
        for pt in points:
            k = get_key(pt)
            if k in seen:
                all_points[seen[k]]["occurrenceCount"] += 1
            else:
                seen[k] = len(all_points)
                all_points.append(pt)
                new_count += 1

        print(f"+{new_count} 新考点 (总计 {len(all_points)})")

        # Brief pause to avoid rate limiting
        if (page_idx + 1) % 5 == 0:
            time.sleep(3)

    doc.close()

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_points, f, ensure_ascii=False, indent=2)

    print(f"\n✓ 完成！共 {len(all_points)} 个考点，已保存到 {OUT_FILE}")
    print(f"\n请在浏览器控制台执行以下代码导入考点：")
    print(f"""
const newPoints = {json.dumps(all_points, ensure_ascii=False)};
const existing = JSON.parse(localStorage.getItem('testrecall_points') || '[]');
const seen = new Map(existing.map(p => [p.type+'::'+p.term.toLowerCase(), p]));
newPoints.forEach(p => {{
  const k = p.type+'::'+p.term.toLowerCase();
  if (!seen.has(k)) seen.set(k, p);
  else seen.get(k).occurrenceCount = (seen.get(k).occurrenceCount||1)+1;
}});
localStorage.setItem('testrecall_points', JSON.stringify([...seen.values()]));
const names = JSON.parse(localStorage.getItem('testrecall_source_names')||'{{}}');
names['2021.12-n1-pdf'] = '2021.12';
localStorage.setItem('testrecall_source_names', JSON.stringify(names));
location.reload();
""")


if __name__ == "__main__":
    main()
