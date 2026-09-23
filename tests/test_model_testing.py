import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app
from model_testing import (
    UpstreamError,
    connection_settings,
    list_models,
    normalize_base_url,
    probe_settings,
    stream_probe,
)


class WireResponse(io.BytesIO):
    def __init__(self, body, content_type="text/event-stream"):
        super().__init__(body)
        self.headers = {"Content-Type": content_type}


def event_wire(events, terminal=True):
    chunks = ["data: " + json.dumps(event, ensure_ascii=False) + "\n\n" for event in events]
    if terminal:
        chunks.append("data: [DONE]\n\n")
    return "".join(chunks).encode("utf-8")


def settings(**overrides):
    return {"base_url": "https://provider.example/v1", "api_key": "test-key",
            "api_model": "gpt-5.4", "prompt": "Generate integers", "expected_count": 100,
            "temperature": None, "api_format": "auto", **overrides}


def http_error(status, message="Unavailable"):
    return urllib.error.HTTPError("https://provider.example/v1", status, message, {},
                                  io.BytesIO(json.dumps({"error": {"message": message}}).encode()))


class ModelTestingTests(unittest.TestCase):
    def test_base_url_accepts_roots_prefixes_and_complete_endpoints(self):
        cases = {
            "https://provider.example": "https://provider.example/v1",
            "https://provider.example/v1/": "https://provider.example/v1",
            "https://provider.example/proxy/v1/models": "https://provider.example/proxy/v1",
            "https://provider.example/proxy/messages": "https://provider.example/proxy",
            "http://localhost:8080/chat/completions": "http://localhost:8080",
            "https://provider.example/api/v1/responses/": "https://provider.example/api/v1",
            "http://localhost:8080/responses": "http://localhost:8080",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(normalize_base_url(value), expected)

    def test_rejects_invalid_urls_and_header_injection(self):
        for value in ("file:///etc/passwd", "https://key@provider.example", "https://provider.example?key=secret", "https://provider.example:bad", "https://provider.example\n"):
            with self.subTest(value=value):
                if value.endswith("\n"):
                    value = "https://provider.\nexample"
                with self.assertRaises(ValueError):
                    normalize_base_url(value)
        for key in ("", "key\nHeader", "key with space"):
            with self.assertRaises(ValueError):
                connection_settings({"base_url": "https://provider.example", "api_key": key})

    def test_probe_validation(self):
        for changes in ({"temperature": "nan"}, {"temperature": 3}, {"expected_count": True}, {"api_model": ""}, {"api_format": "other"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                probe_settings(settings(**changes))

    def test_list_pagination_filtering_deduplication_and_both_auth_headers(self):
        pages = [
            {"data": [{"id": "gpt-5.4"}, {"id": "gpt-image-2"}, {"id": "other-model"}], "has_more": True, "last_id": "other-model"},
            {"data": [{"id": "claude-opus-5"}, {"id": "gpt-5.4"}], "has_more": False},
        ]
        with patch("model_testing.open_upstream", side_effect=[WireResponse(json.dumps(page).encode(), "application/json") for page in pages]) as request:
            result = list_models("https://provider.example/v1", "test-key")
        self.assertEqual({model["id"] for model in result["models"]}, {"gpt-5.4", "claude-opus-5"})
        self.assertEqual(result["total_count"], 4)
        self.assertEqual(result["filtered_count"], 2)
        self.assertIn("after_id=other-model", request.call_args_list[1].args[0])
        self.assertEqual(request.call_args_list[0].args[1]["Authorization"], "Bearer test-key")
        self.assertEqual(request.call_args_list[0].args[1]["x-api-key"], "test-key")

    def test_repeated_pagination_cursor_is_rejected(self):
        page = {"data": [{"id": "gpt-5.4"}], "has_more": True, "last_id": "same"}
        with patch("model_testing.open_upstream", side_effect=[WireResponse(json.dumps(page).encode(), "application/json") for _ in range(2)]):
            with self.assertRaises(UpstreamError):
                list_models("https://provider.example/v1", "test-key")

    def test_openai_stream_emits_text_before_completion_and_uses_plain_http_body(self):
        text = ", ".join(str(index % 355 + 1) for index in range(100))
        events = [{"model": "gpt-5.4", "choices": [{"index": 0, "delta": {"content": text[:90]}}]},
                  {"choices": [{"index": 0, "delta": {"content": text[90:]}, "finish_reason": "stop"}]}]
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events))) as request:
            output = list(stream_probe(**settings()))
        self.assertEqual([item["text"] for item in output if item["type"] == "delta"], [text[:90], text[90:]])
        self.assertTrue(output[-1]["accepted"])
        self.assertEqual(output[-1]["parsed_numbers"], 100)
        self.assertEqual(output[-1]["text"], text)
        self.assertTrue(request.call_args.args[2]["stream"])
        self.assertEqual(len(request.call_args.args[2]["messages"]), 1)
        self.assertNotIn("tools", request.call_args.args[2])

    def test_anthropic_stream_handles_start_delta_and_stop(self):
        text = ",".join(["123"] * 100)
        events = [{"type": "message_start", "message": {"model": "claude-opus-5"}},
                  {"type": "content_block_start", "content_block": {"type": "text", "text": ""}},
                  {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}},
                  {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
                  {"type": "message_stop"}]
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events, False))) as request:
            output = list(stream_probe(**settings(api_model="claude-opus-5")))
        self.assertTrue(output[-1]["accepted"])
        self.assertEqual(output[-1]["response_model"], "claude-opus-5")
        self.assertTrue(request.call_args.args[0].endswith("/messages"))
        self.assertEqual(request.call_args.args[1]["x-api-key"], "test-key")
        self.assertEqual(request.call_args.args[1]["Authorization"], "Bearer test-key")

    def test_partial_disconnect_and_truncation_never_become_valid_answers(self):
        for terminal, reason in ((False, None), (True, "length")):
            events = [{"choices": [{"delta": {"content": ",".join(["123"] * 100)}, "finish_reason": reason}]}]
            with self.subTest(terminal=terminal, reason=reason):
                with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events, terminal))):
                    output = list(stream_probe(**settings()))
                self.assertTrue(any(item["type"] == "delta" for item in output))
                self.assertEqual(output[-1]["type"], "error")
                self.assertFalse(any(item["type"] == "complete" for item in output))

    def test_json_response_is_delivered_once_without_fake_streaming(self):
        payload = {"choices": [{"message": {"content": "1, 2, 3"}, "finish_reason": "stop"}]}
        with patch("model_testing.open_upstream", return_value=WireResponse(json.dumps(payload).encode(), "application/json")):
            output = list(stream_probe(**settings()))
        self.assertEqual(len([item for item in output if item["type"] == "delta"]), 1)
        self.assertFalse(output[-1]["accepted"])

    def test_protocol_fallback_only_for_rejected_protocol(self):
        payload = {"content": [{"type": "text", "text": "1,2,3"}], "stop_reason": "end_turn"}
        with patch("model_testing.open_upstream", side_effect=[http_error(404), http_error(404), WireResponse(json.dumps(payload).encode(), "application/json")]) as request:
            output = list(stream_probe(**settings()))
        self.assertEqual(request.call_count, 3)
        self.assertTrue(request.call_args_list[1].args[0].endswith("/responses"))
        self.assertTrue(request.call_args_list[2].args[0].endswith("/messages"))
        self.assertEqual(output[-1]["api_format"], "anthropic")
        for status in (401, 403, 429):
            with self.subTest(status=status), patch("model_testing.open_upstream", side_effect=http_error(status)) as request:
                output = list(stream_probe(**settings()))
                self.assertEqual(request.call_count, 1)
                self.assertEqual(output[-1]["status"], status)

    def test_key_is_redacted_from_upstream_errors(self):
        with patch("model_testing.open_upstream", side_effect=http_error(401, "Bad key test-key")):
            output = list(stream_probe(**settings()))
        self.assertNotIn("test-key", json.dumps(output))

    def test_http_routes_validate_inputs_and_stream_events(self):
        client = app.test_client()
        self.assertEqual(client.post("/api/models", json={}).status_code, 400)
        self.assertEqual(client.post("/api/test/stream", json={}).status_code, 400)
        references = client.get("/api/reference-models").get_json()["models"]
        self.assertEqual(len(references), 13)
        events = [{"choices": [{"delta": {"content": ",".join(["123"] * 100)}, "finish_reason": "stop"}]}]
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events))):
            response = client.post("/api/test/stream", json=settings())
            payloads = [json.loads(line) for line in response.data.splitlines()]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/x-ndjson")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertTrue(payloads[-1]["accepted"])


if __name__ == "__main__":
    unittest.main()
