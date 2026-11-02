# -*- coding: utf-8 -*-
"""轻阅 AI 划线辅助的本地 mock 服务：实现 OpenAI 兼容的 /v1/chat/completions。
仅用于测试，不联网。运行：python tests/mock_ai_server.py [port]（默认 8899）"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


def make_reply(messages):
    """根据请求内容生成可识别的应答，便于断言。"""
    user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    # 追问（对话多于一条 user 消息）
    if sum(1 for m in messages if m["role"] == "user") > 1:
        return "[MOCK-追问] 已结合上文回答你的问题：" + user[:30]
    if "介绍这个人" in user:
        return "[MOCK-介绍] 这是书中人物，身份与背景已基于上下文给出。"
    if "概述这段内容" in user:
        return "[MOCK-概述] 这段情节的要点有：起因、经过、结果。"
    if "我的问题" in user:
        return "[MOCK-提问] 针对你的提问的回答。"
    return "[MOCK] 未识别的请求类型"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) or b"{}"
        try:
            req = json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError:
            req = json.loads(raw.decode("gbk", "replace"))
        if not self.headers.get("Authorization", "").startswith("Bearer "):
            self._send(401, {"error": {"message": "missing api key"}})
            return
        reply = make_reply(req.get("messages", []))
        self._send(200, {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "model": req.get("model", "mock"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}}],
        })

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f"mock ai server on http://127.0.0.1:{port}/v1")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
