"""The small CBOR subset WebAuthn uses: ints, byte/text strings, arrays, maps, simple values."""

from __future__ import annotations

import struct

MAX_DEPTH = 32


class CborError(ValueError):
    pass


def decode(data: bytes, offset: int = 0, _depth: int = 0):
    """Decode one item at ``offset``. Returns (value, offset just past it)."""
    if _depth > MAX_DEPTH:
        raise CborError("CBOR nesting too deep")
    if offset >= len(data):
        raise CborError("truncated CBOR")
    initial = data[offset]
    major, info = initial >> 5, initial & 0x1F
    offset += 1
    if major == 7:
        return _simple(data, offset, info)
    length, offset = _argument(data, offset, info)
    if major == 0:
        return length, offset
    if major == 1:
        return -1 - length, offset
    if major in (2, 3):
        end = offset + length
        if end > len(data):
            raise CborError("truncated CBOR string")
        raw = data[offset:end]
        if major == 2:
            return raw, end
        try:
            return raw.decode("utf-8"), end
        except UnicodeDecodeError as error:
            raise CborError("invalid UTF-8 in CBOR text string") from error
    if major == 4:
        items = []
        for _ in range(length):
            item, offset = decode(data, offset, _depth + 1)
            items.append(item)
        return items, offset
    if major == 5:
        mapping = {}
        for _ in range(length):
            key, offset = decode(data, offset, _depth + 1)
            value, offset = decode(data, offset, _depth + 1)
            try:
                mapping[key] = value
            except TypeError as error:
                raise CborError("unhashable CBOR map key") from error
        return mapping, offset
    raise CborError(f"unsupported CBOR major type {major}")


def _argument(data, offset, info):
    if info < 24:
        return info, offset
    sizes = {24: 1, 25: 2, 26: 4, 27: 8}
    if info not in sizes:
        raise CborError("indefinite or reserved CBOR length")
    size = sizes[info]
    if offset + size > len(data):
        raise CborError("truncated CBOR length")
    return int.from_bytes(data[offset : offset + size], "big"), offset + size


def _simple(data, offset, info):
    if info == 20:
        return False, offset
    if info == 21:
        return True, offset
    if info in (22, 23):
        return None, offset
    floats = {25: (">e", 2), 26: (">f", 4), 27: (">d", 8)}
    if info in floats:
        fmt, size = floats[info]
        if offset + size > len(data):
            raise CborError("truncated CBOR float")
        return struct.unpack(fmt, data[offset : offset + size])[0], offset + size
    raise CborError("unsupported CBOR simple value")


def loads(data: bytes):
    value, end = decode(data)
    if end != len(data):
        raise CborError("trailing bytes after CBOR item")
    return value
