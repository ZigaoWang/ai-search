# 知道 - 人工智能研究助手

<p align="center">
  <img src="/public/image.png" alt="知道 AI 研究助手" width="600">
</p>

*[英文文档 (English Documentation)](README.md)*

## 🏆 登月48黑客马拉松亚军

本项目在"登月48"黑客马拉松中开发，并荣获**第二名**！"知道"是一款人工智能驱动的研究助手，通过自然语言交互帮助用户查找、分析和理解学术研究。

## 🌟 主要功能

- **研究问答:** 用自然语言提问研究问题，获取带有引用的全面答案
- **个性化订阅:** 订阅根据您的兴趣和主题定制的每日研究摘要
- **双语界面:** 完全支持英文和中文两种语言
- **引用管理:** 自动跟踪并显示所有信息的来源

## API文档

此API提供了使用Semantic Scholar和UniAPI（OpenAI）处理研究问题的端点，生成带有引用的全面答案。

### 端点

#### GET /question

通过研究流程处理问题。

**查询参数:**
- `query` (字符串): 要处理的用户问题
- `sse` (布尔值, 可选): 如果设置为`true`，则启用服务器发送事件(SSE)以获取实时更新

**响应:**
- `200 OK`: 返回包含答案和元数据的结果对象
- `400 Bad Request`: 缺少查询参数
- `500 Internal Server Error`: 处理请求时出错

#### GET /api/daily-digest

获取基于订阅主题的个性化每日研究摘要。

**查询参数:**
- `topics` (字符串): 接收研究更新的主题
- `userId` (字符串, 可选): 用于个性化的用户标识符

**响应:**
- `200 OK`: 返回个性化研究摘要
- `400 Bad Request`: 缺少主题参数
- `500 Internal Server Error`: 生成摘要时出错

#### POST /question

使用POST请求通过研究流程处理问题。

**请求体:**
- `query` (字符串): 要处理的用户问题

**响应:**
- `200 OK`: 返回包含答案和元数据的结果对象
- `400 Bad Request`: 请求体中缺少查询
- `500 Internal Server Error`: 处理请求时出错

#### GET /stream-question

处理问题并获取实时更新。

**查询参数:**
- `query` (字符串): 要处理的用户问题

**响应:**
- `200 OK`: 返回实时更新和包含答案和元数据的最终结果对象
- `400 Bad Request`: 缺少查询参数
- `500 Internal Server Error`: 处理请求时出错

#### GET /health

用于验证服务器状态的健康检查端点。

**响应:**
- `200 OK`: 返回服务器状态、版本、环境和时间戳

## 环境变量

- `PORT`: 服务器将侦听的端口（默认：3000）
- `OPENAI_API_KEY`: 用于访问UniAPI（OpenAI）端点的API密钥
- `LOG_LEVEL`: 日志级别（例如，`ERROR`，`WARN`，`INFO`，`DEBUG`）

## 日志

服务器使用自定义日志函数，具有以下日志级别：
- `ERROR`
- `WARN`
- `INFO`
- `DEBUG`

当前日志级别由`LOG_LEVEL`环境变量确定。

## 使用方法

1. 确保您有一个包含必要环境变量的`.env`文件
2. 启动服务器：
   ```bash
   node server.js
   ```
3. 按照上述说明访问端点
