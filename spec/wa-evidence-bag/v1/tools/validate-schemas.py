"""Development-only JSON Schema validation for the synthetic WAEB fixture.

This script is not part of Field Collector or the production verify CLI. It exists so
the language-neutral schemas and fixture can be checked in CI with an independent
implementation.
"""

from __future__ import annotations

from copy import deepcopy
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from referencing import Registry, Resource


HERE = Path(__file__).resolve().parent
V1_DIR = HERE.parent
SCHEMA_DIR = V1_DIR / "schemas"
DEFAULT_BAG = (
    V1_DIR
    / "examples"
    / "minimal-valid-signed"
    / "waeb-11111111-1111-4111-8111-111111111111"
)


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def load_ndjson(path: Path) -> list[object]:
    text = path.read_text(encoding="utf-8")
    return [] if text == "" else [json.loads(line) for line in text.splitlines()]


def main() -> int:
    bag = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_BAG
    schemas: dict[str, dict] = {}
    registry = Registry()

    for schema_path in SCHEMA_DIR.rglob("*.schema.json"):
        document = load_json(schema_path)
        Draft202012Validator.check_schema(document)
        relative_name = schema_path.relative_to(SCHEMA_DIR).as_posix()
        schemas[relative_name] = document
        registry = registry.with_resource(document["$id"], Resource.from_contents(document))

    format_checker = FormatChecker()

    def validate(value: object, schema_name: str) -> None:
        Draft202012Validator(
            schemas[schema_name],
            registry=registry,
            format_checker=format_checker,
        ).validate(value)

    negative_case_count = 0

    def expect_invalid(value: object, schema_name: str, case_name: str) -> None:
        nonlocal negative_case_count
        try:
            validate(value, schema_name)
        except ValidationError:
            negative_case_count += 1
            return
        raise AssertionError(f"Negative schema case unexpectedly passed: {case_name}")

    validate(load_json(bag / "data/acquisition.json"), "acquisition-1.0.schema.json")
    validate(load_json(bag / "data/dataset-inventory.json"), "dataset-inventory-1.0.schema.json")
    validate(load_json(bag / "data/completeness.json"), "completeness-1.0.schema.json")
    validate(load_json(bag / "data/diagnostics/capabilities.json"), "capabilities-1.0.schema.json")
    validate(load_json(bag / "signatures/signer.json"), "signer-1.0.schema.json")
    validate(load_json(bag / "signatures/seal.json"), "seal-1.0.schema.json")

    for event in load_ndjson(bag / "data/logs/acquisition.ndjson"):
        validate(event, "acquisition-event-1.0.schema.json")
    for chat in load_ndjson(bag / "data/completeness/chats.ndjson"):
        validate(chat, "chat-completeness-1.0.schema.json")
    for raw_path in (bag / "data/raw").rglob("*.ndjson"):
        for record in load_ndjson(raw_path):
            validate(record, "raw-record-1.0.schema.json")
    for media in load_ndjson(bag / "data/indexes/media.ndjson"):
        validate(media, "media-record-1.0.schema.json")

    schema_index = load_json(SCHEMA_DIR / "index.json")
    normalized_count = 0
    for dataset in schema_index["datasets"]:
        for record in load_ndjson(bag / dataset["path"]):
            validate(record, "evidence-record-1.0.schema.json")
            validate(record["data"], schema_index["recordDataSchemas"][record["recordType"]])
            normalized_count += 1

    seal = load_json(bag / "signatures/seal.json")
    unsigned_seal = deepcopy(seal)
    del unsigned_seal["signature"]
    expect_invalid(unsigned_seal, "seal-1.0.schema.json", "unsigned-v1-seal")

    duplicate_manifest_seal = deepcopy(seal)
    duplicate_manifest_seal["payloadManifests"][1] = deepcopy(duplicate_manifest_seal["payloadManifests"][0])
    expect_invalid(duplicate_manifest_seal, "seal-1.0.schema.json", "duplicate-payload-manifest")

    missing_tag_seal = deepcopy(seal)
    missing_tag_seal["tagFiles"].pop()
    expect_invalid(missing_tag_seal, "seal-1.0.schema.json", "missing-core-tag")

    inventory = load_json(bag / "data/dataset-inventory.json")
    duplicate_inventory = deepcopy(inventory)
    duplicate_inventory["datasets"][1] = deepcopy(duplicate_inventory["datasets"][0])
    expect_invalid(duplicate_inventory, "dataset-inventory-1.0.schema.json", "duplicate-dataset")

    invalid_dataset_state = deepcopy(inventory)
    invalid_dataset_state["datasets"][5]["capability"] = "unsupported"
    expect_invalid(invalid_dataset_state, "dataset-inventory-1.0.schema.json", "unsupported-completed-dataset")

    capabilities = load_json(bag / "data/diagnostics/capabilities.json")
    duplicate_capability = deepcopy(capabilities)
    duplicate_capability["capabilities"][1]["name"] = duplicate_capability["capabilities"][0]["name"]
    expect_invalid(duplicate_capability, "capabilities-1.0.schema.json", "duplicate-capability")

    invalid_capability_state = deepcopy(capabilities)
    invalid_capability_state["capabilities"][0]["result"] = "unsupported"
    invalid_capability_state["capabilities"][0]["reasonCodes"] = ["synthetic_unsupported"]
    expect_invalid(invalid_capability_state, "capabilities-1.0.schema.json", "unsupported-capability-with-adapter")

    print(
        json.dumps(
            {
                "status": "schema_valid",
                "schemas": len(schemas),
                "datasets": len(schema_index["datasets"]),
                "normalizedRecords": normalized_count,
                "negativeCasesRejected": negative_case_count,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
