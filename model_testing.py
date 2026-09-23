from __future__ import annotations

import json
import math
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator

from enrollment import _compact_upstream_error, upstream_user_agent
from fingerprint import parse_numbers
from api_protocols import (
    API_PATHS, PROTOCOL_REJECTION_STATUS, endpoint_format, normalize_base_url,
    protocol_order, response_content, response_problem, responses_body,
)


MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_CHARS = 64_000


class UpstreamError(ValueError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Key 只发送给表单指定的地址，重定向不能把凭据带到另一个服务。
        return None


def connection_settings(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("请提交 URL 和 API Key。")
    base_url = normalize_base_url(payload.get("base_url"))
    api_key = payload.get("api_key")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("请填写 API Key。")
    api_key = api_key.strip()
    if len(api_key) > 4096 or any(ord(character) < 33 or ord(character) > 126 for character in api_key):
        raise ValueError("请检查 API Key，去掉空格、换行或非英文字符。")
    return {"base_url": base_url, "api_key": api_key}


def request_headers(api_key: str, api_format: str = "auto") -> dict:
    headers = {"Accept": "application/json", "User-Agent": upstream_user_agent()}
    if api_format in {"auto", *API_PATHS}:
        # Claude 兼容网关可能仍校验 Bearer，两种鉴权头始终只发往用户填写的同一地址。
        headers["Authorization"] = f"Bearer {api_key}"
    if api_format in {"auto", "anthropic"}:
        headers.update({"x-api-key": api_key, "anthropic-version": "2023-06-01"})
    return headers


def safe_error(error: Exception, api_key: str = "") -> str:
    if isinstance(error, urllib.error.HTTPError):
        details = error.read(8192).decode("utf-8", errors="replace")
        if error.code in {301, 302, 303, 307, 308}:
            message = "接口要求跳转。请将 Base URL 改为服务商提供的最终 API 地址。"
        else:
            detail = _compact_upstream_error(details, str(error.reason))
            guidance = {
                401: "请检查 API Key 是否正确、是否过期。",
                403: "请检查 Key 权限、模型访问权限或服务商的网络限制。",
                404: "请检查 Base URL 是否包含正确的接口前缀，或切换请求格式。",
                429: "接口请求过多或额度不足，请稍后重试或检查余额。",
            }.get(error.code, "请检查接口状态后重试。")
            message = f"HTTP {error.code} · {detail} {guidance}"
    elif isinstance(error, (TimeoutError, socket.timeout)):
        message = "等待接口回复超时，请检查服务是否可用后重试。"
    elif isinstance(error, urllib.error.URLError):
        message = f"暂时无法连接接口，请检查 URL 和网络。{error.reason}"
    elif isinstance(error, (json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, AttributeError)):
        message = "接口回复格式与预期不同，请检查 Base URL，或在请求设置中指定正确的请求格式。"
    else:
        message = str(error) or "暂时无法完成请求，请重试。"
    if api_key:
        message = message.replace(api_key, "[已隐藏 Key]")
    return message[:1200]


def open_upstream(url: str, headers: dict, body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data is not None:
        headers = {**headers, "Content-Type": "application/json"}
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=120 if data else 30)


def read_json(response, allow_response_error: bool = False) -> dict:
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("接口返回内容过长，本次请求已停止。")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("接口没有返回 JSON，请确认填写的是 API 地址而不是网页地址。") from error
    if not isinstance(payload, dict):
        raise ValueError("接口返回结构不符合预期，请检查 Base URL。")
    if payload.get("error") and not allow_response_error:
        raise ValueError(_compact_upstream_error(json.dumps(payload), "上游接口暂时不可用"))
    return payload


def model_family(model_id: str) -> str | None:
    lowered = model_id.lower()
    if "claude" in lowered:
        return "claude"
    if "gpt" in lowered and not re.search(r"image|audio|realtime|transcrib|embedding|moderation|tts", lowered):
        return "gpt"
    return None


def list_models(base_url: str, api_key: str) -> dict:
    endpoint = f"{base_url}/models"
    models = {}
    all_ids = set()
    cursors = set()
    url = endpoint
    try:
        while True:
            with open_upstream(url, request_headers(api_key)) as response:
                payload = read_json(response)
            entries = payload.get("data")
            if not isinstance(entries, list):
                raise ValueError("模型列表中缺少 data 数组；仍可手动添加模型名进行测试。")
            for entry in entries:
                model_id = entry.get("id") if isinstance(entry, dict) else entry
                if not isinstance(model_id, str) or not model_id.strip():
                    continue
                all_ids.add(model_id)
                family = model_family(model_id)
                if family:
                    models[model_id] = {"id": model_id, "family": family}
            if not payload.get("has_more"):
                break
            cursor = payload.get("last_id")
            if not isinstance(cursor, str) or not cursor or cursor in cursors or len(cursors) >= 100:
                raise ValueError("模型列表分页未能正常结束，请稍后重试，或手动添加模型名。")
            cursors.add(cursor)
            url = endpoint + "?" + urllib.parse.urlencode({"after_id": cursor})
    except Exception as error:
        raise UpstreamError(safe_error(error, api_key), getattr(error, "code", 0)) from error
    return {
        "models": sorted(models.values(), key=lambda item: (item["family"], item["id"])),
        "total_count": len(all_ids),
        "filtered_count": len(all_ids) - len(models),
        "base_url": base_url,
        "endpoint": endpoint,
    }


def probe_settings(payload: dict) -> dict:
    settings = connection_settings(payload)
    model = payload.get("api_model")
    prompt = payload.get("prompt")
    if not isinstance(model, str) or not model.strip() or len(model) > 256:
        raise ValueError("请填写长度不超过 256 个字符的模型名。")
    if any(ord(character) < 32 for character in model):
        raise ValueError("模型名中不能包含换行或控制字符。")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise ValueError("请重新生成测试提示词后重试。")
    api_format = payload.get("api_format", "auto")
    if api_format not in {"auto", *API_PATHS}:
        raise ValueError("请选择自动、Chat Completions、Responses 或 Claude 原生请求格式。")
    if api_format == "auto":
        api_format = endpoint_format(payload["base_url"]) or api_format
    expected = payload.get("expected_count")
    if isinstance(expected, bool) or not isinstance(expected, int) or not 80 <= expected <= 1000:
        raise ValueError("请重新生成挑战，数字数量需要在 80 到 1000 之间。")
    value = payload.get("temperature")
    try:
        temperature = None if value in (None, "") else float(value)
    except (ValueError, TypeError) as error:
        raise ValueError("温度需要是 0 到 2 之间的数字，留空使用接口默认值。") from error
    if temperature is not None and (not math.isfinite(temperature) or not 0 <= temperature <= 2):
        raise ValueError("温度需要在 0 到 2 之间。")
    return {**settings, "api_model": model.strip(), "prompt": prompt, "api_format": api_format,
            "expected_count": expected, "temperature": temperature}


def sse_payloads(response) -> Iterator[str]:
    data = []
    received = 0
    while raw_line := response.readline(MAX_RESPONSE_BYTES + 1):
        received += len(raw_line)
        if received > MAX_RESPONSE_BYTES:
            raise ValueError("接口持续输出过多内容，本次请求已停止。")
        line = raw_line.decode("utf-8").rstrip("\r\n").lstrip("\ufeff")
        if not line:
            if data:
                yield "\n".join(data)
                data = []
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data:
        yield "\n".join(data)


def stream_probe(base_url: str, api_key: str, api_model: str, prompt: str,
                 api_format: str, expected_count: int, temperature: float | None) -> Iterator[dict]:
    formats = protocol_order(api_format, api_model, base_url)
    base_url = normalize_base_url(base_url) if endpoint_format(base_url) else base_url.rstrip("/")
    started = time.monotonic()
    for format_index, selected_format in enumerate(formats):
        endpoint = base_url + API_PATHS[selected_format]
        body = {"model": api_model, "messages": [{"role": "user", "content": prompt}], "stream": True}
        if selected_format == "anthropic":
            body["max_tokens"] = 4096
        elif selected_format == "responses":
            body = responses_body(api_model, prompt, temperature, stream=True)
        if temperature is not None:
            body["temperature"] = temperature
        yield {"type": "request", "api_format": selected_format, "endpoint": endpoint,
               "message": "正在发送挑战，等待模型回复…"}
        chunks = []
        output_size = 0
        finish_reason = None
        response_model = None
        terminal = False
        responses_parts = {}
        response_issue = None
        try:
            with open_upstream(endpoint, request_headers(api_key, selected_format), body) as response:
                yield {"type": "status", "message": "接口已连接，等待回复内容…"}
                if "application/json" in response.headers.get("Content-Type", "").lower():
                    payload = read_json(response, allow_response_error=selected_format == "responses")
                    response_model = payload.get("model")
                    if selected_format == "responses":
                        text = response_content(payload)
                        finish_reason = payload.get("status")
                        response_issue = response_problem(payload)
                    elif selected_format == "anthropic":
                        content = payload.get("content", [])
                        text = "".join(block.get("text", "") for block in content if block.get("type") == "text")
                        finish_reason = payload.get("stop_reason")
                    else:
                        choice = payload["choices"][0]
                        text = choice.get("message", {}).get("content") or ""
                        if isinstance(text, list):
                            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
                        finish_reason = choice.get("finish_reason")
                    if len(text) > MAX_OUTPUT_CHARS:
                        raise ValueError("回复过长，本次回答不计入。")
                    chunks.append(text)
                    yield {"type": "status", "message": "接口返回整段回复，正在检查内容…"}
                    yield {"type": "delta", "text": text}
                    terminal = True
                else:
                    for raw in sse_payloads(response):
                        if raw.strip() == "[DONE]":
                            terminal = selected_format != "responses"
                            break
                        payload = json.loads(raw)
                        if payload.get("error") or payload.get("type") == "error":
                            raise ValueError(_compact_upstream_error(raw, "回复过程中接口中断。"))
                        delta_text = ""
                        if selected_format == "responses":
                            event_type = payload.get("type")
                            part_key = (payload.get("output_index", 0), payload.get("content_index", 0))
                            if event_type in {"response.created", "response.in_progress"}:
                                response_model = payload.get("response", {}).get("model") or response_model
                            elif event_type in {"response.output_text.delta", "response.refusal.delta"}:
                                delta_text = payload.get("delta") or ""
                                responses_parts[part_key] = responses_parts.get(part_key, "") + delta_text
                                if event_type == "response.refusal.delta":
                                    response_issue = "模型拒绝完成本次挑战，回复已保留，但不计入归因。"
                            elif event_type in {"response.output_text.done", "response.refusal.done"}:
                                part_text = payload.get("text") or payload.get("refusal") or ""
                                if responses_parts.get(part_key) != part_text:
                                    responses_parts[part_key] = part_text
                                    final_text = "".join(text for _, text in sorted(responses_parts.items()))
                                    if len(final_text) > MAX_OUTPUT_CHARS:
                                        raise ValueError("模型持续输出过多内容，本次请求已停止。")
                                    chunks = [final_text]
                                    output_size = len(final_text)
                                    yield {"type": "snapshot", "text": final_text}
                                if event_type == "response.refusal.done":
                                    response_issue = "模型拒绝完成本次挑战，回复已保留，但不计入归因。"
                            elif event_type in {"response.completed", "response.failed", "response.incomplete"}:
                                final_response = payload.get("response") or {}
                                response_model = final_response.get("model") or response_model
                                finish_reason = final_response.get("status") or event_type.removeprefix("response.")
                                final_text = response_content(final_response)
                                if final_text:
                                    if len(final_text) > MAX_OUTPUT_CHARS:
                                        raise ValueError("模型持续输出过多内容，本次请求已停止。")
                                    # 完成事件常常再次携带全文，替换快照，避免重复追加已经收到的数字。
                                    chunks = [final_text]
                                    yield {"type": "snapshot", "text": final_text}
                                response_issue = response_issue or response_problem({**final_response, "status": finish_reason})
                                if event_type != "response.completed" and not response_issue:
                                    response_issue = "Responses 回复未完整完成，本次回答不计入归因。"
                                terminal = True
                                break
                        elif selected_format == "anthropic":
                            event_type = payload.get("type")
                            if event_type == "message_start":
                                response_model = payload.get("message", {}).get("model")
                            elif event_type == "content_block_start":
                                block = payload.get("content_block", {})
                                if block.get("type") == "text":
                                    delta_text = block.get("text", "")
                            elif event_type == "content_block_delta":
                                delta = payload.get("delta", {})
                                if delta.get("type") == "text_delta":
                                    delta_text = delta.get("text", "")
                            elif event_type == "message_delta":
                                finish_reason = payload.get("delta", {}).get("stop_reason") or finish_reason
                            elif event_type == "message_stop":
                                terminal = True
                                break
                        else:
                            response_model = payload.get("model") or response_model
                            for choice in payload.get("choices", []):
                                if choice.get("index", 0) != 0:
                                    continue
                                delta = choice.get("delta", {})
                                delta_text = delta.get("content") or delta.get("refusal") or ""
                                finish_reason = choice.get("finish_reason") or finish_reason
                        if delta_text:
                            output_size += len(delta_text)
                            if output_size > MAX_OUTPUT_CHARS:
                                raise ValueError("模型持续输出过多内容，本次请求已停止。")
                            chunks.append(delta_text)
                            yield {"type": "delta", "text": delta_text}
                if not terminal:
                    raise ValueError("连接提前结束，未收到完整回复标记；本次回答不计入，请重试。")
                if response_issue:
                    raise ValueError(response_issue)
                if finish_reason in {"length", "max_tokens", "content_filter", "refusal", "tool_calls", "tool_use", "function_call", "pause_turn"}:
                    raise ValueError(f"本次回复未完整完成（{finish_reason}），已保留收到的内容，但不计入归因。")
                text = "".join(chunks)
                count = len(parse_numbers(text))
                minimum = max(80, math.ceil(expected_count * 0.55))
                yield {"type": "complete", "text": text, "parsed_numbers": count,
                       "minimum_numbers": minimum, "accepted": count >= minimum,
                       "finish_reason": finish_reason, "response_model": response_model,
                       "api_format": selected_format, "elapsed_seconds": round(time.monotonic() - started, 2)}
                return
        except urllib.error.HTTPError as error:
            message = safe_error(error, api_key)
            # 只对明确不支持当前协议的响应尝试另一种格式，鉴权和限流问题不重复发送收费请求。
            if api_format == "auto" and format_index + 1 < len(formats) and error.code in PROTOCOL_REJECTION_STATUS:
                yield {"type": "status", "message": f"当前格式未被接受（HTTP {error.code}），尝试另一种请求格式…"}
                continue
            yield {"type": "error", "message": message, "status": error.code}
            return
        except Exception as error:
            yield {"type": "error", "message": safe_error(error, api_key), "status": 0}
            return
