import pytest

from app.services.cleanup import clean_transcript


class TestEmptyInput:
    def test_empty_string(self):
        assert clean_transcript("") == ""

    def test_whitespace_only(self):
        assert clean_transcript("   \n\t  ") == ""

    def test_none_like_empty(self):
        assert clean_transcript("  ") == ""


class TestWhitespaceNormalization:
    def test_collapses_internal_whitespace(self):
        assert clean_transcript("hello   world") == "Hello world"

    def test_strips_leading_trailing(self):
        assert clean_transcript("  hello world  ") == "Hello world"

    def test_normalizes_tabs_and_newlines(self):
        assert clean_transcript("hello\t\nworld") == "Hello world"


class TestCapitalization:
    def test_capitalizes_first_character(self):
        assert clean_transcript("hello") == "Hello"

    def test_already_capitalized_unchanged(self):
        assert clean_transcript("Hello world") == "Hello world"

    def test_single_word(self):
        assert clean_transcript("hello") == "Hello"


class TestPassthrough:
    """Whisper output that is already clean should pass through unchanged."""

    def test_clean_sentence(self):
        assert clean_transcript("Hello world.") == "Hello world."

    def test_preserves_punctuation(self):
        assert clean_transcript("What? Really! Yes.") == "What? Really! Yes."

    def test_preserves_filename(self):
        assert clean_transcript("Check the image.png file") == "Check the image.png file"

    def test_preserves_url(self):
        assert clean_transcript("Visit example.com today") == "Visit example.com today"


class TestIdempotency:
    @pytest.mark.parametrize(
        "text",
        [
            "hello world",
            "  hello   world  ",
            "What? Really! Yes.",
            "Already clean sentence.",
            "Check image.png now",
            "",
            "   ",
        ],
    )
    def test_idempotent(self, text):
        once = clean_transcript(text)
        twice = clean_transcript(once)
        assert once == twice, f"Not idempotent: {text!r} -> {once!r} -> {twice!r}"


class TestNoLogging:
    def test_module_does_not_import_structlog(self):
        import app.services.cleanup as mod

        source = open(mod.__file__).read()
        assert "structlog" not in source, "cleanup module must not import structlog"
