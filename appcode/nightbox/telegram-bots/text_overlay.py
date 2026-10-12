"""Per-chat video text settings and safe FFmpeg overlay processing."""
import asyncio
import os
import shutil
import subprocess
from pathlib import Path

from creator_keys import get_text_preferences

MAX_OVERLAY_TEXT_LENGTH = 240


def _clean_text(value):
    return "".join(str(value or "").replace("\x00", "").splitlines()).strip()[:MAX_OVERLAY_TEXT_LENGTH]


def _font_file():
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ):
        if os.path.exists(candidate):
            return candidate
    return ""


def _filter_path(path):
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _run_overlay(input_path, output_path, header_path, footer_path, header, footer):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("Text overlay is unavailable because FFmpeg is not installed on the server")

    filters = []
    font = _font_file()
    common = ":fontcolor=white:fontsize=h*0.045:x=(w-text_w)/2:box=1:boxcolor=black@0.62:boxborderw=12"
    if font:
        common = f":fontfile='{_filter_path(font)}'" + common
    if header:
        filters.append(
            f"drawtext=textfile='{_filter_path(header_path)}'{common}:y=24"
        )
    if footer:
        filters.append(
            f"drawtext=textfile='{_filter_path(footer_path)}'{common}:y=h-text_h-24"
        )

    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(input_path),
        "-vf", ",".join(filters), "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=3600)
    if result.returncode != 0:
        detail = (result.stderr or "FFmpeg overlay failed").strip()[-700:]
        raise RuntimeError(detail)


async def apply_text_overlay(input_path, output_dir, chat_id):
    """Return (path, applied). The original path is returned when disabled."""
    preferences = get_text_preferences(chat_id)
    header = _clean_text(preferences.get("header")) if preferences.get("enabled") else ""
    footer = _clean_text(preferences.get("footer")) if preferences.get("enabled") else ""
    if not header and not footer:
        return input_path, False

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(input_path).stem
    output_path = output_dir / f"{stem}.text-overlay.mp4"
    header_path = output_dir / f"{stem}.header.txt"
    footer_path = output_dir / f"{stem}.footer.txt"
    try:
        header_path.write_text(header, encoding="utf-8")
        footer_path.write_text(footer, encoding="utf-8")
        await asyncio.to_thread(
            _run_overlay,
            input_path,
            output_path,
            header_path,
            footer_path,
            header,
            footer,
        )
        return str(output_path), True
    finally:
        for path in (header_path, footer_path):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
