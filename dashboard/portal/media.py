"""Files a transcript points at: MEDIA: tags in replies and image refs in user turns.

web/src/lib/media.ts parses the same shapes for the browser; keep the two in step.
"""

import re

# Hermes's own MEDIA_DELIVERY_EXTS (gateway/platforms/base.py), longest first.
EXTS = sorted(
    (
        "png jpg jpeg gif webp bmp tiff svg mp4 mov avi mkv webm 3gp mp3 m2a wav ogg opus m4a flac "
        "pdf docx doc odt rtf txt md epub xlsx xls ods csv tsv json xml yaml yml kmz kml geojson gpx "
        "pptx ppt odp key zip tar gz tgz bz2 xz 7z rar apk ipa html htm"
    ).split(),
    key=len,
    reverse=True,
)
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"}

_QUOTED = r"`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'"
# A tag anywhere in a line, ending at a known extension; or a whole line holding just the tag.
MEDIA = re.compile(
    rf"MEDIA:[^\S\n]*(?P<path>{_QUOTED}|(?:~/|/)[^\n]*?\.(?:{'|'.join(EXTS)}))"
    rf"(?=[\s`\"'*_,;:)\]}}\[]|MEDIA:|\.(?:\s|$)|$)"
    rf"|^MEDIA:(?P<line>/[^\n]+?)[^\S\n]*$",
    re.IGNORECASE | re.MULTILINE,
)
# What Hermes writes into a user turn for an attached image.
USER_IMAGE = re.compile(
    rf"\[Image attached at: (?P<hint>[^\n\]]+)\]|^@image:(?P<ref>{_QUOTED}|\S+)[^\S\n]*$",
    re.MULTILINE,
)
# Fenced blocks and inline code hold examples, never deliveries.
_CODE = re.compile(r"```[\s\S]*?(?:```|$)|(?<!MEDIA:)(?<!@image:)`[^`\n]*`")


def _unquote(value):
    return value[1:-1] if len(value) > 1 and value[0] == value[-1] and value[0] in "`\"'" else value


def _masked(text):
    return _CODE.sub(lambda m: " " * len(m.group(0)), text)


def media_paths(text):
    masked = _masked(text or "")
    return [_unquote(m.group("path") or m.group("line")) for m in MEDIA.finditer(masked)]


def user_image_paths(text):
    masked = _masked(text or "")
    return [_unquote(m.group("hint") or m.group("ref")) for m in USER_IMAGE.finditer(masked)]


def is_image(path):
    return path.rsplit(".", 1)[-1].lower() in IMAGE_EXTS if "." in path else False


def shown_files(messages):
    """Every path a transcript shows: anything a reply delivered, and images a user attached."""
    paths = set()
    for message in messages:
        text = message.get("text") or ""
        if message.get("role") == "assistant":
            paths.update(media_paths(text))
        elif message.get("role") == "user":
            paths.update(p for p in user_image_paths(text) if is_image(p))
    return paths
