#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const readline = require('readline')

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.mymemguard')
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return null }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch(url, method, body, token) {
  const { default: fetch } = await import('node-fetch')
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const IGNORE = ['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.turbo']

function buildTree(dir, depth, maxDepth) {
  if (depth > maxDepth) return []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(e => !IGNORE.includes(e.name) && !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return { name: e.name, type: 'dir', children: buildTree(full, depth + 1, maxDepth) }
      return { name: e.name, type: 'file', size: fs.statSync(full).size }
    })
}

function treeToText(nodes, prefix = '') {
  return nodes.map((n, i) => {
    const isLast = i === nodes.length - 1
    const branch = isLast ? '└── ' : '├── '
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    const line = prefix + branch + n.name + (n.type === 'dir' ? '/' : ` (${n.size}B)`)
    return n.type === 'dir' && n.children?.length
      ? line + '\n' + treeToText(n.children, childPrefix)
      : line
  }).join('\n')
}

function collectFiles(dir, maxBytes = 200_000, exts = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.go', '.rs']) {
  const result = []
  let total = 0
  function walk(d) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE.includes(e.name) || e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!exts.some(x => e.name.endsWith(x))) continue
      const stat = fs.statSync(full)
      if (stat.size > 50_000 || total + stat.size > maxBytes) continue
      try {
        const content = fs.readFileSync(full, 'utf8')
        result.push({ path: path.relative(dir, full), content })
        total += stat.size
      } catch { /* skip binary */ }
    }
  }
  walk(dir)
  return result
}

function pickRelevantFiles(allFiles, message) {
  const words = message.toLowerCase().split(/\s+/)
  return allFiles
    .map(f => {
      const score = words.reduce((s, w) => s + (f.path.toLowerCase().includes(w) ? 3 : 0) + (f.content.toLowerCase().includes(w) ? 1 : 0), 0)
      return { ...f, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
}

// ─── Gemini direct call ───────────────────────────────────────────────────────

const GEMINI_URL = (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`

// ─── Claude API (tool use) ────────────────────────────────────────────────────

const CLAUDE_MODELS = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

const CLAUDE_TOOLS = [
  {
    name: 'exec_command',
    description: 'Windowsのcmd.exeでシェルコマンドを実行する。ファイル削除・作成・ビルドなどに使う。括弧やスペースを含むパスはダブルクォートで囲む。',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  },
  {
    name: 'read_file',
    description: 'ファイルの内容を読む',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'write_file',
    description: 'ファイルを書き込む（作成・上書き）',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'list_dir',
    description: 'ディレクトリの中身一覧を取得',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
]

async function callClaudeWithTools(anthropicKey, systemPrompt, history, message, model, cwd) {
  const { default: fetch } = await import('node-fetch')
  const messages = [
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    { role: 'user', content: message },
  ]

  for (let round = 0; round < 8; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODELS[model] || CLAUDE_MODELS.haiku, max_tokens: 8192, system: systemPrompt, tools: CLAUDE_TOOLS, messages }),
    })
    const data = await res.json()
    if (data.error) throw new Error(`Claude error: ${data.error.message}`)

    const toolUses = data.content?.filter(b => b.type === 'tool_use') || []
    const textBlocks = data.content?.filter(b => b.type === 'text') || []

    if (data.stop_reason === 'end_turn' || toolUses.length === 0) {
      return textBlocks.map(b => b.text).join('') || '（応答なし）'
    }

    // ツール実行
    messages.push({ role: 'assistant', content: data.content })
    const toolResults = []

    for (const block of toolUses) {
      const { name, input, id } = block
      console.log(`   🔧 ${name}(${JSON.stringify(input).slice(0, 80)})`)
      let result
      try {
        if (name === 'exec_command') {
          const r = handleExec({ command: input.command, cwd })
          result = `exit:${r.exitCode}\nstdout: ${r.stdout}\n${r.stderr ? 'stderr: ' + r.stderr : ''}`.trim()
        } else if (name === 'read_file') {
          const r = handleReadFile({ path: path.resolve(cwd, input.path) })
          result = r.content || r.error
        } else if (name === 'write_file') {
          const r = handleWriteFile({ path: path.resolve(cwd, input.path), content: input.content })
          result = r.ok ? '✓ 書き込み完了' : r.error
        } else if (name === 'list_dir') {
          const r = handleListDir({ path: path.resolve(cwd, input.path) })
          result = r.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n')
        }
        console.log(`   ✓ 完了`)
      } catch (e) {
        result = `エラー: ${e.message}`
        console.log(`   ❌ ${e.message}`)
      }
      toolResults.push({ type: 'tool_result', tool_use_id: id, content: String(result) })
    }
    messages.push({ role: 'user', content: toolResults })
  }
  return '（最大ラウンド数に達しました）'
}

async function callGemini(geminiKey, systemPrompt, history, message) {
  const contents = [
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ]
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  }
  const data = await apiFetch(GEMINI_URL(geminiKey), 'POST', body, null)
  if (data.error) throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`)
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '（Geminiから応答がありませんでした）'
}

// Gemini Function Calling でツールを使いながら会話するエージェントループ
async function callGeminiWithTools(geminiKey, systemPrompt, history, message, cwd) {
  const tools = [{
    functionDeclarations: [
      {
        name: 'exec_command',
        description: 'Windowsのcmd.exeでシェルコマンドを実行する。ファイル削除・作成・ビルドなどに使う。',
        parameters: { type: 'OBJECT', properties: { command: { type: 'STRING', description: 'cmd.exeで実行するコマンド。括弧やスペースを含むパスはダブルクォートで囲む。' } }, required: ['command'] }
      },
      {
        name: 'read_file',
        description: 'ファイルの内容を読む',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: '作業ディレクトリからの相対パスまたは絶対パス' } }, required: ['path'] }
      },
      {
        name: 'write_file',
        description: 'ファイルを書き込む（作成・上書き）',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['path', 'content'] }
      },
      {
        name: 'list_dir',
        description: 'ディレクトリの中身一覧を取得',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] }
      }
    ]
  }]

  const contents = [
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ]

  // 最大5ラウンドのツール呼び出しループ
  for (let round = 0; round < 5; round++) {
    const isLastTurn = contents[contents.length - 1]?.parts?.some(p => p.functionResponse)
    const toolConfig = isLastTurn
      ? { function_calling_config: { mode: 'AUTO' } }
      : { function_calling_config: { mode: 'ANY' } }
    const body = { system_instruction: { parts: [{ text: systemPrompt }] }, contents, tools, tool_config: toolConfig, generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } }
    const data = await apiFetch(GEMINI_URL(geminiKey), 'POST', body, null)
    if (data.error) throw new Error(`Gemini error: ${data.error.message}`)

    const candidate = data.candidates?.[0]
    if (!candidate) throw new Error('No candidate returned')

    const parts = candidate.content?.parts || []
    const toolCalls = parts.filter(p => p.functionCall)
    const textParts = parts.filter(p => p.text)

    // ツール呼び出しがなければ最終回答
    if (toolCalls.length === 0) {
      return textParts.map(p => p.text).join('') || '（応答なし）'
    }

    // ツール実行
    contents.push({ role: 'model', parts })
    const toolResults = []

    for (const part of toolCalls) {
      const { name, args } = part.functionCall
      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 80)})`)
      let result
      try {
        if (name === 'exec_command') {
          const r = handleExec({ command: args.command, cwd })
          result = `exit:${r.exitCode}\nstdout: ${r.stdout}\n${r.stderr ? 'stderr: ' + r.stderr : ''}`.trim()
        } else if (name === 'read_file') {
          const r = handleReadFile({ path: path.resolve(cwd, args.path) })
          result = r.content || r.error
        } else if (name === 'write_file') {
          const r = handleWriteFile({ path: path.resolve(cwd, args.path), content: args.content })
          result = r.ok ? '✓ 書き込み完了' : r.error
        } else if (name === 'list_dir') {
          const r = handleListDir({ path: path.resolve(cwd, args.path) })
          result = r.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n')
        }
        console.log(`   ✓ 完了`)
      } catch (e) {
        result = `エラー: ${e.message}`
        console.log(`   ❌ ${e.message}`)
      }
      toolResults.push({ functionResponse: { name, response: { result } } })
    }

    contents.push({ role: 'user', parts: toolResults })
  }
  return '（最大ラウンド数に達しました）'
}

// ─── Command handlers ─────────────────────────────────────────────────────────

function handleReadFile(payload) {
  const filePath = path.resolve(payload.path)
  if (!fs.existsSync(filePath)) return { error: `File not found: ${payload.path}` }
  return { content: fs.readFileSync(filePath, 'utf8'), path: filePath }
}

function handleWriteFile(payload) {
  const filePath = path.resolve(payload.path)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (payload.mode === 'patch' && fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8')
    if (!content.includes(payload.search)) return { error: 'Search string not found' }
    fs.writeFileSync(filePath, content.replace(payload.search, payload.replace), 'utf8')
  } else {
    fs.writeFileSync(filePath, payload.content || '', 'utf8')
  }
  return { ok: true, path: filePath }
}

function handleExec(payload) {
  try {
    const stdout = execSync(payload.command, { cwd: payload.cwd || process.cwd(), timeout: 60000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || e.message, exitCode: e.status || 1 }
  }
}

function handleFileTree(payload) {
  const root = path.resolve(payload.root || process.cwd())
  const tree = buildTree(root, 0, payload.depth || 5)
  return { root, tree, text: treeToText(tree) }
}

function handleListDir(payload) {
  const dir = path.resolve(payload.path || process.cwd())
  return { path: dir, entries: fs.readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) }
}

async function handleChat(payload, cfg) {
  if (!cfg.geminiKey) return { error: 'Gemini APIキーが設定されていません。設定ファイルを削除して再セットアップしてください。' }

  const cwd = payload.cwd || process.cwd()
  const { message, history = [] } = payload

  console.log(`   📂 プロジェクトスキャン中: ${cwd}`)

  // ファイルツリー取得
  const tree = buildTree(cwd, 0, 5)
  const treeText = treeToText(tree)

  // 関連ファイル収集（操作系コマンドはファイル内容不要）
  const isOpCmd = /削除|delete|remove|rmdir|mkdir|作成|移動|move|rename/.test(message)
  const allFiles = isOpCmd ? [] : collectFiles(cwd, 100_000)
  const relevant = isOpCmd ? [] : pickRelevantFiles(allFiles, message)
  const fileContext = relevant.length > 0
    ? relevant.map(f => `\`\`\`\n// ${f.path}\n${f.content}\n\`\`\``).join('\n\n')
    : ''

  const systemPrompt = `あなたはローカルPCに直接接続されたAIエンジニアアシスタントです。
作業ディレクトリ: ${cwd}
OS: Windows (cmd.exe)

【プロジェクト構成】
${treeText}
${fileContext ? '\n【関連ファイル】\n' + fileContext : ''}

【絶対ルール】
- ファイル操作・確認・コマンド実行は必ずツールを呼び出して実際に実行する。
- 過去の会話履歴に同様の操作があっても、毎回ツールを呼び出して実行・確認する。
- 「削除しました」「確認しました」などの報告は、ツールで実際に実行した後にのみ言う。
- 実行せずにテキストだけで報告することは絶対禁止。
- Windowsパスに括弧()やスペースがある場合はダブルクォートで囲む。
- 操作後は必ずlist_dirまたはfile_treeで結果を確認する。`

  const model = payload.model || 'haiku'
  let response
  if (cfg.anthropicKey) {
    console.log(`   🤖 Claude ${model} 開始...`)
    response = await callClaudeWithTools(cfg.anthropicKey, systemPrompt, history, message, model, cwd)
  } else if (cfg.geminiKey) {
    console.log(`   🤖 Gemini Function Calling 開始...`)
    response = await callGeminiWithTools(cfg.geminiKey, systemPrompt, history, message, cwd)
  } else {
    return { error: 'APIキーが設定されていません' }
  }
  console.log(`   ✓ 回答生成完了 (${response.length}文字)`)
  return { response }
}

async function dispatch(cmd, cfg) {
  switch (cmd.type) {
    case 'read_file':  return handleReadFile(cmd.payload)
    case 'write_file': return handleWriteFile(cmd.payload)
    case 'exec':       return handleExec(cmd.payload)
    case 'file_tree':  return handleFileTree(cmd.payload)
    case 'list_dir':   return handleListDir(cmd.payload)
    case 'chat':       return await handleChat(cmd.payload, cfg)
    default:           return { error: `Unknown command: ${cmd.type}` }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 2000
const PING_INTERVAL = 30000

async function mainLoop(cfg) {
  let lastPing = 0
  console.log(`\n✅ MyMemGuard Agent 起動中`)
  console.log(`   接続先: ${cfg.url}`)
  console.log(`   作業ディレクトリ: ${process.cwd()}`)
  console.log(`   AIエンジン: ${cfg.anthropicKey ? '✓ Claude (Haiku/Sonnet)' : cfg.geminiKey ? '✓ Gemini' : '✗ 未設定'}`)
  console.log(`   Ctrl+C で停止\n`)

  while (true) {
    try {
      if (Date.now() - lastPing > PING_INTERVAL) {
        await apiFetch(`${cfg.url}/api/agent/ping`, 'POST', { cwd: process.cwd() }, cfg.token)
        lastPing = Date.now()
      }

      const { commands } = await apiFetch(`${cfg.url}/api/agent/poll`, 'GET', null, cfg.token)

      for (const cmd of commands || []) {
        console.log(`⚡ [${cmd.type}] ${JSON.stringify(cmd.payload).slice(0, 100)}`)
        let result, error
        try {
          result = await dispatch(cmd, cfg)
          if (result?.error) { error = result.error; result = null }
        } catch (e) {
          error = e.message
        }
        await apiFetch(`${cfg.url}/api/agent/result`, 'POST', {
          command_id: cmd.id,
          status: error ? 'error' : 'done',
          result,
          error,
        }, cfg.token)
        console.log(`   ${error ? '❌ ' + error : '✓ 完了'}`)
      }
    } catch (e) {
      console.error(`接続エラー: ${e.message} — 再試行中...`)
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

// ─── Setup & Start ────────────────────────────────────────────────────────────

async function main() {
  let cfg = loadConfig()

  if (!cfg) {
    console.log('🧠 MyMemGuard Agent セットアップ\n')
    const url = await ask('MyMemGuardのURL (例: https://mymemguard.vercel.app): ')
    const token = await ask('APIトークン (MyMemGuardの設定画面でコピー): ')
    const anthropicKey = await ask('Anthropic APIキー (sk-ant-... / なければEnterでスキップ): ')
    const geminiKey = await ask('Gemini APIキー (なければEnterでスキップ): ')
    cfg = { url: url.replace(/\/$/, ''), token, anthropicKey: anthropicKey || null, geminiKey: geminiKey || null }

    try {
      const res = await apiFetch(`${cfg.url}/api/agent/ping`, 'POST', { cwd: process.cwd() }, cfg.token)
      if (res.ok) {
        saveConfig(cfg)
        console.log('\n✅ 接続成功！設定を保存しました\n')
      } else {
        console.error('❌ 接続失敗。URLとトークンを確認してください')
        process.exit(1)
      }
    } catch (e) {
      console.error(`❌ 接続エラー: ${e.message}`)
      process.exit(1)
    }
  }

  mainLoop(cfg)
}

main()
