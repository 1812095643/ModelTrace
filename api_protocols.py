from __future__ import annotations

import urllib.parse


API_PATHS = {
    "openai": "/chat/completions",
    "responses": "/responses",
    "anthropic": "/messages",
}
PROTOCOL_REJECTION_STATUS = {400, 404, 405, 415, 422}


def normalize_base_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请填写服务商提供的 Base URL。")
    value = value.strip()
    if any(ord(character) < 32 for character in value):
        raise ValueError("URL 中不能包含换行或控制字符。")
    try:
        parts = urllib.parse.urlsplit(value)
        parts.port
    except ValueError as error:
        raise ValueError("请检查 URL 的域名和端口。") from error
    if parts.scheme not in {"https", "http"} or not parts.hostname:
        raise ValueError("URL 需要以 https:// 或 http:// 开头。")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("请只填写接口地址，将 Key 单独填写在 API Key 输入框。")
    path = parts.path.rstrip("/")
    endpoint_removed = False
    for suffix in (*API_PATHS.values(), "/models"):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            endpoint_removed = True
            break
    if not path and not endpoint_removed:
        path = "/v1"
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def endpoint_format(base_url: str) -> str | None:
    path = urllib.parse.urlsplit(base_url.strip()).path.rstrip("/")
    return next((name for name, suffix in API_PATHS.items() if path.endswith(suffix)), None)


def protocol_order(api_format: str, model: str, base_url: str = "") -> list[str]:
    if api_format not in {"auto", *API_PATHS}:
        raise ValueError("请选择自动、Chat Completions、Responses 或 Claude 原生请求格式。")
    if api_format != "auto":
        return [api_format]
    formats = ["anthropic", "openai", "responses"] if "claude" in model.lower() else ["openai", "responses", "anthropic"]
    preferred = endpoint_format(base_url) if base_url else None
    return [preferred, *(name for name in formats if name != preferred)] if preferred else formats


def responses_body(model: str, prompt: str, temperature: float | None,
                   system_prompt: str = "", stream: bool = False) -> dict:
    body = {
        "model": model,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
        "stream": stream,
        "store": False,
    }
    if system_prompt:
        body["instructions"] = system_prompt
    if temperature is not None:
        body["temperature"] = temperature
    return body


def response_content(payload: dict) -> str:
    messages = []
    # 原始 HTTP 响应的正文在 output 中，推理摘要和工具参数不能混入数字指纹。
    for item in payload.get("output") or []:
        if item.get("type") != "message" or item.get("role", "assistant") != "assistant":
            continue
        parts = []
        for content in item.get("content") or []:
            if content.get("type") == "output_text":
                parts.append(content.get("text") or "")
            elif content.get("type") == "refusal":
                parts.append(content.get("refusal") or "")
        messages.append("".join(parts))
    return "\n".join(messages)


def response_problem(payload: dict) -> str | None:
    error = payload.get("error")
    if error:
        detail = error.get("message") or error.get("code") if isinstance(error, dict) else str(error)
        return f"Responses 请求未完成：{detail}"
    status = payload.get("status")
    if status == "incomplete":
        reason = (payload.get("incomplete_details") or {}).get("reason") or "未说明原因"
        return f"Responses 回复未完整完成（{reason}），本次回答不计入归因。"
    if status != "completed":
        return f"Responses 回复尚未正常完成（{status or '缺少完成状态'}），本次回答不计入归因。"
    for item in payload.get("output") or []:
        if item.get("type") == "message" and any(content.get("type") == "refusal" for content in item.get("content") or []):
            return "模型拒绝完成本次挑战，回复已保留，但不计入归因。"
    return None
