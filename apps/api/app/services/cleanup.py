import re


def clean_transcript(raw: str) -> str:
    """Minimal transcript cleanup.

    Whisper large-v3 handles punctuation, capitalization, and filler
    suppression well on short clean audio. This function applies only
    the two rules that address real segment-joining artifacts.
    """
    if not raw or not raw.strip():
        return ""

    text = raw

    # 1. Collapse whitespace runs from segment joining
    text = re.sub(r"\s+", " ", text).strip()

    # 2. Capitalize first character (segment joining can lowercase it)
    if text:
        text = text[0].upper() + text[1:]

    return text
