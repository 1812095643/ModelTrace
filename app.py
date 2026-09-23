from __future__ import annotations

import json
import math
import re
import secrets

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

from enrollment import bank_summary, enroll_automatic, request_completion, test_automatic
from fingerprint import analyze_global_outputs, generate_challenges, load_bank, parse_numbers
from bank_builder import build_bank, read_rows
from model_testing import UpstreamError, connection_settings, list_models, probe_settings, stream_probe
from runtime_paths import DATA_DIR
from api_protocols import API_PATHS


app = Flask(__name__)
CUSTOM_BANKS_FILE = DATA_DIR / "custom_banks.json"
UNIFIED_BANK_FILE = DATA_DIR / "unified_bank.json"
DEFAULT_BANK_ID = "claude"


def builtin_configs() -> dict[str, dict]:
    return {
        "gpt": {
            "label": "GPT",
            "bank_file": DATA_DIR / "gpt_bank.json",
            "data_file": DATA_DIR / "gpt_reference.jsonl",
        },
        "claude": {
            "label": "Claude",
            "bank_file": DATA_DIR / "claude_bank.json",
            "data_file": DATA_DIR / "claude_reference.jsonl",
        },
    }


def load_configs() -> dict[str, dict]:
    configs = builtin_configs()
    if CUSTOM_BANKS_FILE.exists():
        for item in json.loads(CUSTOM_BANKS_FILE.read_text(encoding="utf-8")):
            bank_id = item["id"]
            configs[bank_id] = {
                "label": item["label"],
                "bank_file": DATA_DIR / f"{bank_id}_bank.json",
                "data_file": DATA_DIR / f"{bank_id}_reference.jsonl",
                "custom": True,
            }
    return configs


def save_custom_configs() -> None:
    items = [
        {"id": bank_id, "label": config["label"]}
        for bank_id, config in BANK_CONFIGS.items()
        if config.get("custom")
    ]
    CUSTOM_BANKS_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_configured_bank(bank_id: str) -> dict | None:
    config = BANK_CONFIGS[bank_id]
    if not config["bank_file"].exists():
        return None
    bank = load_bank(config["bank_file"])
    bank["family_name"] = config["label"]
    return bank


BANK_CONFIGS = load_configs()
banks = {bank_id: load_configured_bank(bank_id) for bank_id in BANK_CONFIGS}


def active_banks() -> dict[str, dict]:
    return {
        bank_id: bank
        for bank_id, bank in banks.items()
        if bank is not None and bank.get("models")
    }


def global_reference_rows() -> list[dict]:
    rows = []
    for bank_id in active_banks():
        config = BANK_CONFIGS[bank_id]
        rows.extend(
            {
                **row,
                "family_id": bank_id,
                "family_name": config["label"],
            }
            for row in read_rows(config["data_file"])
        )
    return rows


def rebuild_global_bank() -> dict:
    global unified_bank
    unified_bank = build_bank(global_reference_rows())
    UNIFIED_BANK_FILE.write_text(
        json.dumps(unified_bank, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return unified_bank


unified_bank = load_bank(UNIFIED_BANK_FILE) if UNIFIED_BANK_FILE.exists() else None
if unified_bank is None:
    rebuild_global_bank()


def requested_bank_id(payload: dict | None = None) -> str:
    bank_id = (payload or {}).get("bank_id") or request.args.get("bank_id") or DEFAULT_BANK_ID
    if bank_id not in BANK_CONFIGS:
        raise ValueError(f"未知指纹库：{bank_id}")
    return bank_id


def requested_temperature(payload: dict) -> float | None:
    value = payload.get("temperature")
    return None if value in (None, "") else float(value)


def requested_api_format(payload: dict) -> str:
    value = payload.get("api_format") or "auto"
    if value not in {"auto", *API_PATHS}:
        raise ValueError("请选择有效的请求格式。")
    return value


def summarized_bank(bank_id: str) -> dict:
    config = BANK_CONFIGS[bank_id]
    bank = banks.get(bank_id)
    summary = bank_summary(bank) if bank is not None else {
        "model_count": 0,
        "response_count": 0,
        "number_count": 0,
        "models": [],
        "calibration": {},
    }
    summary.update({"id": bank_id, "label": config["label"]})
    return summary


def summarized_unified_bank() -> dict:
    summaries = {bank_id: summarized_bank(bank_id) for bank_id in active_banks()}
    return {
        "id": "unified",
        "label": "全部指纹",
        "model_count": sum(item["model_count"] for item in summaries.values()),
        "response_count": sum(item["response_count"] for item in summaries.values()),
        "family_count": len(summaries),
        "families": [
            {"id": bank_id, "label": item["label"], "model_count": item["model_count"]}
            for bank_id, item in summaries.items()
        ],
    }


def replace_bank(bank_id: str) -> None:
    banks[bank_id] = load_configured_bank(bank_id)
    rebuild_global_bank()


@app.get("/")
def index():
    summaries = {bank_id: summarized_bank(bank_id) for bank_id in BANK_CONFIGS}
    return render_template(
        "index.html",
        banks=summaries,
        bank=summaries[DEFAULT_BANK_ID],
        unified=summarized_unified_bank(),
        default_bank_id=DEFAULT_BANK_ID,
    )


@app.get("/api/challenges")
def challenges():
    return jsonify({"challenges": generate_challenges(3)})


@app.get("/api/reference-models")
def reference_models():
    return jsonify({"models": [
        {"id": model["id"], "family": model.get("family"),
         "family_name": model.get("family_name"), "response_count": model["response_count"]}
        for model in unified_bank["models"]
    ]})


@app.post("/api/models")
def available_models():
    try:
        settings = connection_settings(request.get_json(silent=True))
        return jsonify(list_models(**settings))
    except UpstreamError as error:
        return jsonify({"error": str(error), "upstream_status": error.status}), 502
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.post("/api/test/stream")
def stream_test():
    try:
        settings = probe_settings(request.get_json(silent=True))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    @stream_with_context
    def events():
        for event in stream_probe(**settings):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return Response(events(), mimetype="application/x-ndjson", headers={
        "Cache-Control": "no-store", "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
    })


@app.post("/api/analyze")
def analyze():
    try:
        payload = request.get_json()
        result = analyze_global_outputs(payload["outputs"], unified_bank)
        result["bank"] = summarized_unified_bank()
        return jsonify(result)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.post("/api/test/auto")
def automatic_test():
    payload = request.get_json()
    try:
        result = test_automatic(
            base_url=payload["base_url"].strip(),
            api_key=payload["api_key"],
            api_model=payload["api_model"].strip(),
            temperature=requested_temperature(payload),
            bank=unified_bank,
            api_format=requested_api_format(payload),
        )
        result["bank"] = summarized_unified_bank()
        return jsonify(result)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.post("/api/test/probe")
def automatic_test_probe():
    payload = request.get_json()
    try:
        text = request_completion(
            base_url=payload["base_url"].strip(),
            api_key=payload["api_key"],
            api_model=payload["api_model"].strip(),
            prompt=payload["prompt"],
            temperature=requested_temperature(payload),
            api_format=requested_api_format(payload),
        )
        expected_count = int(payload["expected_count"])
        parsed_numbers = len(parse_numbers(text))
        minimum_numbers = max(80, math.ceil(expected_count * 0.55))
        return jsonify(
            {
                "text": text,
                "parsed_numbers": parsed_numbers,
                "minimum_numbers": minimum_numbers,
                "accepted": parsed_numbers >= minimum_numbers,
            }
        )
    except Exception as error:
        return jsonify({"error": str(error)}), 502


@app.get("/api/bank")
def get_bank():
    try:
        return jsonify(summarized_bank(requested_bank_id()))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.get("/api/banks")
def get_banks():
    return jsonify({bank_id: summarized_bank(bank_id) for bank_id in BANK_CONFIGS})


@app.post("/api/banks")
def create_bank():
    payload = request.get_json()
    label = payload["label"].strip()
    if not label:
        return jsonify({"error": "请输入指纹库名称"}), 400
    bank_id = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or f"bank-{secrets.token_hex(3)}"
    if bank_id in BANK_CONFIGS:
        return jsonify({"error": "同名指纹库已存在"}), 400
    config = {
        "label": label,
        "bank_file": DATA_DIR / f"{bank_id}_bank.json",
        "data_file": DATA_DIR / f"{bank_id}_reference.jsonl",
        "custom": True,
    }
    config["data_file"].parent.mkdir(parents=True, exist_ok=True)
    config["data_file"].touch()
    BANK_CONFIGS[bank_id] = config
    banks[bank_id] = None
    save_custom_configs()
    return jsonify(
        {
            "bank": summarized_bank(bank_id),
            "banks": {item: summarized_bank(item) for item in BANK_CONFIGS},
            "unified": summarized_unified_bank(),
        }
    )


@app.post("/api/enroll/auto")
def automatic_enrollment():
    payload = request.get_json()
    try:
        bank_id = requested_bank_id(payload)
        config = BANK_CONFIGS[bank_id]
        result = enroll_automatic(
            base_url=payload["base_url"].strip(),
            api_key=payload["api_key"],
            api_model=payload["api_model"].strip(),
            model_label=payload["model_label"].strip(),
            sample_count=int(payload.get("sample_count", 36)),
            temperature=requested_temperature(payload),
            api_format=requested_api_format(payload),
            data_file=config["data_file"],
            bank_file=config["bank_file"],
            bank_id=bank_id,
            provider="api",
        )
        replace_bank(bank_id)
        result["bank"] = summarized_bank(bank_id)
        result["unified"] = summarized_unified_bank()
        return jsonify(result)
    except (RuntimeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7860, debug=False)
