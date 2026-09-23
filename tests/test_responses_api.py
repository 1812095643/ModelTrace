import json
import unittest
from unittest.mock import patch

from test_model_testing import WireResponse, event_wire, http_error, settings
from app import app
from api_protocols import response_content
from enrollment import request_completion
from model_testing import probe_settings, stream_probe


TEXT = ",".join(str(index % 355 + 1) for index in range(100))


def final_response(text=TEXT, status="completed", **changes):
    return {"id": "resp_test", "object": "response", "status": status, "model": "gpt-5.4",
            "output": [{"type": "message", "role": "assistant", "status": status,
                        "content": [{"type": "output_text", "text": text}]}], **changes}


def response_events(text=TEXT):
    return [
        {"type": "response.created", "response": {"model": "gpt-5.4", "status": "in_progress"}},
        {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": text[:70]},
        {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": text[70:]},
        {"type": "response.output_text.done", "output_index": 0, "content_index": 0, "text": text},
        {"type": "response.completed", "response": final_response(text)},
    ]


class ResponsesApiTests(unittest.TestCase):
    def test_request_uses_input_and_stateless_http_without_sdk_fields(self):
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(response_events(), False))) as request:
            result = list(stream_probe(**settings(api_format="responses")))
        url, headers, body = request.call_args.args
        self.assertEqual(url, "https://provider.example/v1/responses")
        self.assertEqual(headers["Authorization"], "Bearer test-key")
        self.assertNotIn("x-api-key", headers)
        self.assertEqual(body["input"], [{"role": "user", "content": [{"type": "input_text", "text": "Generate integers"}]}])
        self.assertTrue(body["stream"])
        self.assertFalse(body["store"])
        self.assertNotIn("messages", body)
        self.assertNotIn("previous_response_id", body)
        self.assertTrue(result[-1]["accepted"])

    def test_stream_does_not_duplicate_done_or_completed_snapshots(self):
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(response_events(), False))):
            result = list(stream_probe(**settings(api_format="responses")))
        self.assertEqual("".join(item["text"] for item in result if item["type"] == "delta"), TEXT)
        self.assertEqual(result[-1]["text"], TEXT)
        self.assertEqual(result[-1]["parsed_numbers"], 100)
        self.assertEqual(result[-1]["response_model"], "gpt-5.4")

    def test_completed_snapshot_recovers_content_without_delta_events(self):
        events = [{"type": "response.completed", "response": final_response()}]
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events, False))):
            result = list(stream_probe(**settings(api_format="responses")))
        self.assertEqual(next(item["text"] for item in result if item["type"] == "snapshot"), TEXT)
        self.assertTrue(result[-1]["accepted"])

    def test_done_text_without_response_completed_is_not_accepted(self):
        events = [{"type": "response.output_text.done", "text": TEXT}]
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events))):
            result = list(stream_probe(**settings(api_format="responses")))
        self.assertEqual(result[-1]["type"], "error")
        self.assertTrue(any(item["type"] == "snapshot" for item in result))
        self.assertFalse(any(item["type"] == "complete" for item in result))

    def test_failed_and_incomplete_preserve_output_without_attribution(self):
        for status, details in (("incomplete", {"incomplete_details": {"reason": "max_output_tokens"}}),
                                ("failed", {"error": {"message": "upstream problem test-key"}})):
            with self.subTest(status=status):
                events = response_events()[:2] + [{"type": "response." + status, "response": final_response(status=status, **details)}]
                with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(events, False))):
                    result = list(stream_probe(**settings(api_format="responses")))
                self.assertEqual(result[-1]["type"], "error")
                self.assertEqual(next(item["text"] for item in result if item["type"] == "snapshot"), TEXT)
                self.assertNotIn("test-key", result[-1]["message"])
                self.assertFalse(any(item["type"] == "complete" for item in result))

    def test_reasoning_and_tool_arguments_are_excluded_from_final_text(self):
        payload = final_response()
        payload["output"].insert(0, {"type": "reasoning", "summary": [{"type": "summary_text", "text": "999,888"}]})
        payload["output"].insert(1, {"type": "function_call", "arguments": "777,666"})
        payload["output"].append({"type": "message", "role": "user", "content": [{"type": "output_text", "text": "555,444"}]})
        self.assertEqual(response_content(payload), TEXT)
        with patch("model_testing.open_upstream", return_value=WireResponse(json.dumps(payload).encode(), "application/json")):
            result = list(stream_probe(**settings(api_format="responses")))
        self.assertEqual(result[-1]["text"], TEXT)
        self.assertEqual(result[-1]["parsed_numbers"], 100)

    def test_json_status_must_be_completed(self):
        for status in ("in_progress", "queued", "incomplete", "failed", "cancelled"):
            with self.subTest(status=status):
                payload = final_response(status=status)
                with patch("model_testing.open_upstream", return_value=WireResponse(json.dumps(payload).encode(), "application/json")):
                    result = list(stream_probe(**settings(api_format="responses")))
                self.assertEqual(result[-1]["type"], "error")
                self.assertEqual(next(item["text"] for item in result if item["type"] == "delta"), TEXT)

    def test_refusal_with_numbers_is_not_an_accepted_answer(self):
        payload = final_response(output=[{"type": "message", "content": [{"type": "refusal", "refusal": TEXT}]}])
        with patch("model_testing.open_upstream", return_value=WireResponse(json.dumps(payload).encode(), "application/json")):
            result = list(stream_probe(**settings(api_format="responses")))
        self.assertEqual(result[-1]["type"], "error")
        self.assertFalse(any(item["type"] == "complete" for item in result))

    def test_auto_mode_tries_responses_after_chat_is_rejected(self):
        with patch("model_testing.open_upstream", side_effect=[http_error(404), WireResponse(event_wire(response_events(), False))]) as request:
            result = list(stream_probe(**settings()))
        self.assertEqual(request.call_count, 2)
        self.assertEqual(result[-1]["api_format"], "responses")
        self.assertTrue(result[-1]["accepted"])

    def test_explicit_responses_never_switches_to_another_format(self):
        with patch("model_testing.open_upstream", side_effect=http_error(400)) as request:
            result = list(stream_probe(**settings(api_format="responses")))
        self.assertEqual(request.call_count, 1)
        self.assertEqual(result[-1]["type"], "error")

    def test_complete_root_endpoint_is_not_changed_to_v1(self):
        config = probe_settings(settings(base_url="http://localhost:8080/responses", api_format="auto"))
        self.assertEqual(config["api_format"], "responses")
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(response_events(), False))) as request:
            result = list(stream_probe(**config))
        self.assertEqual(request.call_args.args[0], "http://localhost:8080/responses")
        self.assertTrue(result[-1]["accepted"])

    def test_enrollment_request_uses_responses_and_preserves_system_prompt(self):
        with patch("enrollment.urllib.request.urlopen", return_value=WireResponse(json.dumps(final_response()).encode(), "application/json")) as request:
            text = request_completion("https://provider.example/proxy/v1/responses", "test-key", "gpt-5.4", "Generate integers", 0.5, "responses", "System context")
        sent = request.call_args.args[0]
        body = json.loads(sent.data)
        self.assertEqual(sent.full_url, "https://provider.example/proxy/v1/responses")
        self.assertEqual(body["instructions"], "System context")
        self.assertEqual(body["temperature"], 0.5)
        self.assertFalse(body["store"])
        self.assertEqual(text, TEXT)

    def test_enrollment_auto_honors_endpoint_and_does_not_switch_on_auth_error(self):
        with patch("enrollment.urllib.request.urlopen", return_value=WireResponse(json.dumps(final_response()).encode(), "application/json")) as request:
            text = request_completion("https://provider.example/v1/responses", "test-key", "gpt-5.4", "Generate integers", None)
        self.assertTrue(request.call_args.args[0].full_url.endswith("/responses"))
        self.assertEqual(text, TEXT)
        with patch("enrollment.urllib.request.urlopen", side_effect=http_error(401)) as request:
            with self.assertRaises(RuntimeError):
                request_completion("https://provider.example/v1", "test-key", "gpt-5.4", "Generate integers", None)
        self.assertEqual(request.call_count, 1)

    def test_routes_accept_responses_and_page_exposes_both_selectors(self):
        client = app.test_client()
        page = client.get("/").get_data(as_text=True)
        self.assertEqual(page.count('value="responses"'), 2)
        with patch("model_testing.open_upstream", return_value=WireResponse(event_wire(response_events(), False))):
            response = client.post("/api/test/stream", json=settings(api_format="responses"))
            events = [json.loads(line) for line in response.data.splitlines()]
        self.assertEqual(response.status_code, 200)
        self.assertTrue(events[-1]["accepted"])
        with patch("enrollment.urllib.request.urlopen", return_value=WireResponse(json.dumps(final_response()).encode(), "application/json")):
            response = client.post("/api/test/probe", json=settings(api_format="responses"))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["accepted"])


if __name__ == "__main__":
    unittest.main()
