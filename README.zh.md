# 知道 - 人工智能研究助手 🔍

<div align="center">
  
  [![登月48黑客马拉松亚军](https://img.shields.io/badge/登月48-亚军-silver?style=for-the-badge)](https://github.com/ZigaoWang/ai-search)
  [![双语支持](https://img.shields.io/badge/双语支持-中文%20%7C%20English-blue?style=for-the-badge)](https://github.com/ZigaoWang/ai-search)
  [![项目状态](https://img.shields.io/badge/状态-活跃-brightgreen?style=for-the-badge)](https://github.com/ZigaoWang/ai-search)

  *[英文文档 (English Documentation)](README.md)*
</div>

## 📱 应用截图

<div align="center">
  <table>
    <tr>
      <td><img src="https://github.com/user-attachments/assets/e7b2880b-b80d-42ea-9ebf-ca81380c636b" alt="知道截图1" width="400"/></td>
      <td><img src="https://github.com/user-attachments/assets/92417291-442f-4e97-bf75-591d1eebc573" alt="知道截图2" width="400"/></td>
    </tr>
    <tr>
      <td><img src="https://github.com/user-attachments/assets/768f58e6-0e5a-4ecc-a837-721dc2ba4461" alt="知道截图3" width="400"/></td>
      <td><img src="https://github.com/user-attachments/assets/7fa3a92d-b010-4870-9208-6294411140e3" alt="知道截图4" width="400"/></td>
    </tr>
  </table>
</div>

## 🏆 登月48黑客马拉松亚军

本项目在"登月48"黑客马拉松中开发，并荣获**第二名**！"知道"是一款人工智能驱动的研究助手，通过自然语言交互帮助用户查找、分析和理解学术研究。

## 🌟 主要功能

- **🔎 研究问答:** 用自然语言提问研究问题，获取带有引用的全面答案
- **📰 个性化订阅:** 订阅根据您的兴趣和主题定制的每日研究摘要
- **🌏 双语界面:** 完全支持英文和中文两种语言
- **📚 引用管理:** 自动跟踪并显示所有信息的来源

## 🚀 API文档

此API提供了使用Semantic Scholar和UniAPI（OpenAI）处理研究问题的端点，生成带有引用的全面答案。

### 端点

<details>
<summary><strong>GET /question</strong> - 处理研究问题</summary>

通过研究流程处理问题。

**查询参数:**
- `query` (字符串): 要处理的用户问题
- `sse` (布尔值, 可选): 如果设置为`true`，则启用服务器发送事件(SSE)以获取实时更新

**响应:**
- `200 OK`: 返回包含答案和元数据的结果对象
- `400 Bad Request`: 缺少查询参数
- `500 Internal Server Error`: 处理请求时出错
</details>

<details>
<summary><strong>GET /api/daily-digest</strong> - 获取个性化研究更新</summary>

获取基于订阅主题的个性化每日研究摘要。

**查询参数:**
- `topics` (字符串): 接收研究更新的主题
- `userId` (字符串, 可选): 用于个性化的用户标识符

**响应:**
- `200 OK`: 返回个性化研究摘要
- `400 Bad Request`: 缺少主题参数
- `500 Internal Server Error`: 生成摘要时出错
</details>

<details>
<summary><strong>POST /question</strong> - 处理问题(POST方法)</summary>

使用POST请求通过研究流程处理问题。

**请求体:**
- `query` (字符串): 要处理的用户问题

**响应:**
- `200 OK`: 返回包含答案和元数据的结果对象
- `400 Bad Request`: 请求体中缺少查询
- `500 Internal Server Error`: 处理请求时出错
</details>

<details>
<summary><strong>GET /stream-question</strong> - 处理问题并获取实时更新</summary>

处理问题并获取实时更新。

**查询参数:**
- `query` (字符串): 要处理的用户问题

**响应:**
- `200 OK`: 返回实时更新和包含答案和元数据的最终结果对象
- `400 Bad Request`: 缺少查询参数
- `500 Internal Server Error`: 处理请求时出错
</details>

<details>
<summary><strong>GET /health</strong> - 健康检查端点</summary>

用于验证服务器状态的健康检查端点。

**响应:**
- `200 OK`: 返回服务器状态、版本、环境和时间戳
</details>

## ⚙️ 环境变量

| 变量 | 说明 | 默认值 |
|----------|-------------|---------|
| `PORT` | 服务器将侦听的端口 | 3000 |
| `OPENAI_API_KEY` | 用于访问UniAPI（OpenAI）端点的API密钥 | - |
| `LOG_LEVEL` | 日志级别 | `INFO` |

## 📝 日志

服务器使用自定义日志函数，具有以下日志级别：
- `ERROR`
- `WARN`
- `INFO`
- `DEBUG`

当前日志级别由`LOG_LEVEL`环境变量确定。

## 🧰 使用方法

1. 确保您有一个包含必要环境变量的`.env`文件
2. 安装依赖:
   ```bash
   npm install
   ```
3. 启动服务器：
   ```bash
   node server.js
   ```
4. 按照上述说明访问端点

## 📄 许可证

[MIT](LICENSE)
