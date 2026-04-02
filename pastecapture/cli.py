from pathlib import Path

import click
import uvicorn

from .app import create_app


@click.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=8000, show_default=True, type=int)
@click.option(
    "--capture-dir",
    envvar="PASTECAPTURE_CAPTURE_DIR",
    type=click.Path(file_okay=False, dir_okay=True, path_type=Path),
    default=None,
)
@click.option(
    "--frontend-dist",
    envvar="PASTECAPTURE_FRONTEND_DIST",
    type=click.Path(file_okay=False, dir_okay=True, path_type=Path),
    default=None,
)
def main(
    host: str,
    port: int,
    capture_dir: Path | None,
    frontend_dist: Path | None,
) -> None:
    app = create_app(capture_dir=capture_dir, frontend_dist=frontend_dist)
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
