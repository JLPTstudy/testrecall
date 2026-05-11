# TestRecall 网页版

## 项目位置
`/Users/kongtiaoxulun/.qclaw/workspace-agent-e8ae97b2/testrecall-web`

## 技术栈
- React 18 + Vite
- Tailwind CSS
- localStorage 数据持久化
- Groq API

## 功能
1. **扫描** - 输入日语文本或上传 PDF、图片、文本文件，AI 提取 JLPT 考点（单词/搭配/语法/阅读/听力）
2. **考点** - 按上传文件或图片归档，展示四类信息列表
3. **统计** - 考点频次分析

## 本地运行
```bash
cd testrecall-web
npm install
npm run dev
```

## 生产构建
```bash
npm run build
# 输出到 dist/ 文件夹
```

## 部署到域名
1. 构建生产版本
2. 部署 dist/ 到托管平台（Vercel/Netlify/Cloudflare Pages）
3. 配置 DNS 指向

## API Key
已在代码中硬编码（从 iOS 版复制），生产环境建议移到环境变量
