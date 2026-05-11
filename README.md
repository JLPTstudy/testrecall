# TestRecall

JLPT 日语考点记忆助手。支持粘贴/上传日语文本，调用 AI 提取单词、固定搭配、语法、阅读和听力考点，并按资料来源整理成清单。

## 功能

- 扫描：输入文本或上传 PDF、图片、文本文件，提取 JLPT 考点
- 考点：按上传文件/图片归档，整理为单词、语法、阅读、听力四类清单
- 统计：查看类型分布、待复习数量和高频考点
- 本地保存：学习数据存储在浏览器 localStorage

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

在 `.env` 中配置：

```bash
VITE_GROQ_API_KEY=your_groq_api_key_here
```

## 构建

```bash
npm run build
```

当前 Vite base 已配置为 `/testrecall/`，适合部署到 GitHub Pages 的 `https://<user>.github.io/testrecall/`。
