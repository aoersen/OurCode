/**
 * Claw 网关的本地回调服务器（企业微信 / QQ / 飞书共用）。
 *
 * 三个平台的入站消息都是「平台 POST 到你的回调地址」：网关在本机起一个 HTTP
 * 服务器，路径格式统一为
 *
 *     /claw/<channel>/<token>
 *
 * token 是主进程生成并持久化的随机串（写在渠道配置里），同时承担两件事：
 *  - 让三个渠道共用一个端口而不互相串台；
 *  - 作为地址级的最小防护——路径不对直接 404，不进入任何解析逻辑。
 *
 * 平台侧的签名/加密校验由各适配器在 handler 里完成（企业微信 sha1+AES、飞书
 * AES、QQ Ed25519）。这里只做 HTTP 层：读原始 body（验签必须拿到**原始字节**）、
 * 路由、限长、把 handler 的返回写回去。
 */
import { createServer } from 'node:http'

/** 回调请求体上限：平台消息都是小包，超过这个量直接拒绝（防止被当上传口）。 */
const MAX_BODY_BYTES = 1024 * 1024

export function createWebhookServer({ channel, token, handler, log }) {
  let server = null
  let boundUrl = null

  const route = `/claw/${channel}/${token}`

  function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('payload too large')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (err) => {
      log(`回调请求读取失败：${err instanceof Error ? err.message : String(err)}`)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      const rawBody = Buffer.concat(chunks)
      const reply = (status, body, contentType = 'text/plain; charset=utf-8') => {
        if (res.writableEnded) return
        res.writeHead(status, { 'content-type': contentType })
        res.end(body)
      }
      // async 包装：handler 同步抛错也要走 catch（否则异常逃出 'end' 回调，
      // 请求挂着不响应，平台只会一直重投）。
      const invoke = async () =>
        handler({
          method: req.method ?? 'GET',
          query: url.searchParams,
          headers: req.headers,
          rawBody,
        })
      void invoke()
        .then((result) => {
          if (result == null) {
            reply(200, '')
            return
          }
          reply(result.status ?? 200, result.body ?? '', result.contentType)
        })
        .catch((err) => {
          log(`回调处理失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`)
          // 500 让平台看到失败并重投；不要吞掉错误伪装成功。
          reply(500, 'error')
        })
    })
  }

  return {
    /** 启动监听；端口 0 交给系统分配。返回真实绑定地址。 */
    start(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server = createServer(handleRequest)
        server.on('error', reject)
        server.listen(port, host, () => {
          const addr = server.address()
          const actualPort = typeof addr === 'object' && addr ? addr.port : port
          boundUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}${route}`
          resolve({ port: actualPort, path: route, localUrl: boundUrl })
        })
      })
    },
    /** 供面板展示的完整回调路径（不含主机名，主机名由主进程按公网前缀拼）。 */
    get path() {
      return route
    },
    async stop() {
      if (!server) return
      const s = server
      server = null
      await new Promise((resolve) => s.close(() => resolve()))
    },
  }
}
