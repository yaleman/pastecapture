import argparse
import json
from pathlib import Path

from .app import app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write FastAPI OpenAPI schema to disk.")
    parser.add_argument("--output", default="frontend/openapi.json")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(app.openapi(), indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
